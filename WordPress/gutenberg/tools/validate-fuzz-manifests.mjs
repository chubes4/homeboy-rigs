#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertGenericFuzzManifest,
  collectFuzzManifests,
  declaredBenchProfileIds,
  declaredBenchWorkloadIds,
  declaredFuzzIds,
  readJson,
} from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const rig = readJson(packageRoot, 'rigs/gutenberg-api-route-inventory/rig.json');

const declaredIds = declaredFuzzIds(rig);
const benchWorkloadIds = declaredBenchWorkloadIds(rig);
const benchProfileIds = declaredBenchProfileIds(rig);
const fuzzManifests = collectFuzzManifests(packageRoot, { declaredIds });

assert.equal(fuzzManifests.length, declaredIds.size, 'expected one manifest per declared Gutenberg fuzz workload');

const fuzzerProfile = readJson(packageRoot, 'manifests/fuzzer-profile.json');
const apiDbLabCell = readJson(packageRoot, 'manifests/api-db-lab-cell.json');
const restRouteCoverage = readJson(packageRoot, 'manifests/rest-route-coverage.json');
const restCases = readJson(packageRoot, 'bench/generated-rest-request-cases.workload.json');
const dbInventory = readJson(packageRoot, 'bench/db-inventory.workload.json');
const restQueryProfile = readJson(packageRoot, 'bench/rest-db-query-profile.workload.json');

const requiredSurfaces = new Set([
  'gutenberg-rest-routes',
  'gutenberg-block-editor',
  'gutenberg-site-editor',
  'gutenberg-pattern-browser',
  'gutenberg-block-renderer',
  'gutenberg-frontend-rendering',
  'wordpress-admin-pages',
  'wordpress-database',
  'wordpress-database-queries',
  'wordpress-hooks',
  'wordpress-options',
  'performance-guardrails',
  'gutenberg-performance-observation',
]);
const coveredSurfaces = new Set();

for (const { file, manifest } of fuzzManifests) {
  assertGenericFuzzManifest(manifest, {
    file,
    declaredIds,
    benchWorkloadIds,
    benchProfileIds,
    targetSlug: 'gutenberg',
    workloadTypes: ['php', 'json', 'trace'],
  });

  if (manifest.operations?.includes('skipped-destructive-action-classification')) {
    assert.ok(Array.isArray(manifest.metadata?.skipped_reason_codes), `${manifest.id} requires skipped reason codes`);
    assert.ok(manifest.metadata.skipped_reason_codes.length > 0, `${manifest.id} skipped reason codes cannot be empty`);
  }

  for (const surfaceId of manifest.surface_ids || []) {
    coveredSurfaces.add(surfaceId);
  }
}

for (const surfaceId of requiredSurfaces) {
  assert.ok(coveredSurfaces.has(surfaceId), `missing Gutenberg fuzz surface ${surfaceId}`);
}

assert.deepEqual(restRouteCoverage.namespaces, ['wp/v2', '__experimental'], 'REST route coverage must declare Gutenberg REST namespaces');
assert.ok(restRouteCoverage.coverage_groups.some((group) => group.id === 'permissions'), 'REST route coverage must declare permission coverage group');

const restCaseIds = new Set(restCases.rest_request_cases.map((restCase) => restCase.id));
for (const requiredCaseId of [
  'gutenberg-block-renderer-paragraph',
  'gutenberg-global-styles-themes',
  'gutenberg-navigation-list',
  'gutenberg-settings-editor-permission',
  'gutenberg-templates-unauthenticated-boundary',
]) {
  assert.ok(restCaseIds.has(requiredCaseId), `generated REST cases missing ${requiredCaseId}`);
}

const dbInventoryRun = dbInventory.run?.[0] || {};
assert.ok((dbInventoryRun.option_prefixes || []).includes('gutenberg_'), 'DB inventory must include Gutenberg option prefix coverage');
assert.ok((dbInventoryRun.postmeta_keys || []).includes('_wp_pattern_sync_status'), 'DB inventory must include Gutenberg postmeta coverage');
assert.ok((dbInventoryRun.post_types || []).includes('wp_template'), 'DB inventory must include template entity coverage');
assert.ok((dbInventoryRun.post_types || []).includes('wp_template_part'), 'DB inventory must include template-part entity coverage');

const queryProfileRun = restQueryProfile.run?.[0] || {};
assert.deepEqual(queryProfileRun.attribution?.group_by, ['request_case_id', 'route', 'method', 'query_type', 'table'], 'REST query profile attribution group drifted');
assert.ok(queryProfileRun.attribution?.include_stack_summary, 'REST query profile must include stack summary attribution');
assert.ok(queryProfileRun.attribution?.include_caller_summary, 'REST query profile must include caller summary attribution');
assert.ok(queryProfileRun.rest_request_cases?.some((restCase) => restCase.id === 'gutenberg-templates-unauthenticated-boundary'), 'REST query profile must include permission boundary case');

const declaredProfileWorkloads = new Set(fuzzerProfile.execution?.fuzz_workloads || []);
for (const { manifest } of fuzzManifests) {
  assert.ok(declaredProfileWorkloads.has(manifest.id), `${manifest.id} is not declared in fuzzer-profile execution.fuzz_workloads`);
}

for (const workloadId of ['gutenberg-hooks-options-inventory', 'gutenberg-editor-performance-observation']) {
  assert.ok(declaredProfileWorkloads.has(workloadId), `${workloadId} must be part of the fuzzer execution profile`);
}

const runtimeInventory = fuzzerProfile.surfaces?.runtime_hook_option_inventory;
assert.deepEqual(runtimeInventory?.workloads, ['gutenberg-hooks-options-inventory'], 'runtime inventory must point at the hook/option fuzz workload');
assert.ok(runtimeInventory.inventory_targets?.cron_state?.length > 0, 'runtime inventory must declare cron/state targets');
assert.ok(runtimeInventory.inventory_targets?.options?.length > 0, 'runtime inventory must declare option targets');

const performanceObservation = fuzzerProfile.surfaces?.editor_performance_observation;
assert.deepEqual(performanceObservation?.workloads, ['gutenberg-editor-performance-observation'], 'performance observation must point at the editor performance workload');
for (const section of ['post_editor', 'site_editor', 'block_rendering', 'pattern_preview', 'notes_unsaved_attachment']) {
  assert.ok(Array.isArray(performanceObservation.contracts?.[section]), `performance observation missing ${section} contract`);
  assert.ok(performanceObservation.contracts[section].length > 0, `performance observation ${section} contract is empty`);
}

const externalGuardrail = fuzzerProfile.surfaces?.server_request_guardrails;
assert.equal(externalGuardrail?.expectations?.block_network, true, 'external HTTP guardrail must block network');
assert.equal(externalGuardrail?.expectations?.real_external_service_calls_allowed, false, 'external HTTP guardrail must forbid real external service calls');
assert.ok(externalGuardrail.synthetic_probe_hosts?.includes('patterns.wordpress.org'), 'external HTTP guardrail must declare the synthetic blocked probe host');

const hookManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'gutenberg-hooks-options-inventory')?.manifest;
assert.deepEqual(hookManifest?.inventory_contract?.required_sections, fuzzerProfile.artifact_summaries?.runtime_state?.required_sections, 'runtime inventory summary sections drifted');

const performanceManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'gutenberg-editor-performance-observation')?.manifest;
assert.deepEqual(performanceManifest?.observation_contract?.required_sections, fuzzerProfile.artifact_summaries?.performance_observation?.required_sections, 'performance observation sections drifted');

const httpManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'gutenberg-external-http-guardrail-fuzz')?.manifest;
assert.equal(httpManifest?.network_guardrail?.block_network, true, 'HTTP guardrail workload must block network');
assert.equal(httpManifest?.network_guardrail?.real_external_service_calls_allowed, false, 'HTTP guardrail workload must forbid real external service calls');
assert.deepEqual(httpManifest?.network_guardrail?.allowlist_domains, ['api.wordpress.org'], 'HTTP guardrail allowlist drifted');

for (const [name, summary] of Object.entries(fuzzerProfile.artifact_summaries || {})) {
  assert.equal(summary.semantic_key, 'fuzz.report', `${name} artifact summary semantic key mismatch`);
  assert.ok(Array.isArray(summary.required_sections), `${name} artifact summary requires sections`);
  assert.ok(summary.required_sections.length > 0, `${name} artifact summary has no required sections`);
}

assert.equal(apiDbLabCell.schema, 'homeboy-rigs/gutenberg-api-db-lab-cell/v1', 'Gutenberg API/DB Lab cell schema mismatch');
assert.ok(apiDbLabCell.rest_namespaces.some((entry) => entry.namespace === 'wp/v2'), 'API/DB Lab cell must cover wp/v2 routes');
assert.ok(apiDbLabCell.rest_namespaces.some((entry) => entry.namespace === '__experimental'), 'API/DB Lab cell must cover __experimental routes');
for (const role of ['anonymous', 'subscriber', 'editor', 'administrator']) {
  assert.ok(apiDbLabCell.permission_boundaries.some((entry) => entry.role === role), `API/DB Lab cell missing ${role} permission boundary`);
}
for (const field of ['namespace', 'role', 'tables_touched', 'option_keys', 'postmeta_keys']) {
  assert.ok(apiDbLabCell.db_query_attribution.required_fields.includes(field), `API/DB Lab cell missing DB attribution field ${field}`);
}
for (const section of ['options', 'postmeta', 'transients', 'mutation_deltas']) {
  assert.ok(apiDbLabCell.state_attribution.required_artifact_sections.includes(section), `API/DB Lab cell missing state attribution section ${section}`);
}
for (const entity of ['wp_template', 'wp_template_part', 'wp_global_styles', 'wp_navigation', 'attachment']) {
  assert.ok(apiDbLabCell.entity_fixtures.includes(entity), `API/DB Lab cell missing entity fixture ${entity}`);
}
for (const artifact of ['rest_namespace_permission_matrix', 'rest_db_query_profile', 'entity_state_attribution']) {
  const proofArtifact = apiDbLabCell.proof_artifacts.find((entry) => entry.name === artifact);
  assert.ok(proofArtifact, `API/DB Lab cell missing proof artifact ${artifact}`);
  assert.ok(proofArtifact.required_sections.length > 0, `API/DB Lab cell proof artifact ${artifact} requires sections`);
}

console.log(`validated ${fuzzManifests.length} Gutenberg fuzz manifests; no fuzz IDs are present in bench_workloads or bench_profiles`);
