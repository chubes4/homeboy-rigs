#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFullSurfaceCoverageManifest,
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
const fullSurfaceCoverage = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const restRouteCoverage = readJson(packageRoot, 'manifests/rest-route-coverage.json');
const restCases = readJson(packageRoot, 'bench/generated-rest-request-cases.workload.json');
const dbInventory = readJson(packageRoot, 'bench/db-inventory.workload.json');
const restQueryProfile = readJson(packageRoot, 'bench/rest-db-query-profile.workload.json');
const destructiveSequencePacks = readJson(packageRoot, 'manifests/destructive-sequence-packs.json');

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

assertFullSurfaceCoverageManifest(fullSurfaceCoverage, { file: 'Gutenberg full-surface coverage' });

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

const requiredDestructiveContracts = new Set([
  'wp-codebox/wordpress-fuzz-runtime-contract/v1',
  'homeboy/isolation-proof/v1',
  'homeboy/fuzz-action-model/v1',
  'homeboy/fuzz-exploration-policy/v1',
  'homeboy/wordpress-surface-family-contracts/v1',
  'homeboy/wordpress-fuzz-runtime-workload-operation/v1',
  'wp-codebox/fuzz-artifact-bundle/v1',
  'wp-codebox/sandbox-isolation-proof/v1',
  'wp-codebox/delete-boundary-artifact/v1',
  'wp-codebox/mutation-isolation-artifact/v1',
  'homeboy-extensions/generate-database-observations/v1',
  'homeboy-extensions/generate-admin-observations/v1',
  'homeboy-extensions/generate-browser-observations/v1',
  'homeboy-extensions/generate-editor-observations/v1',
]);

assert.equal(destructiveSequencePacks.schema, 'homeboy-rigs/gutenberg-destructive-sequence-packs/v1', 'Gutenberg destructive sequence pack schema drifted');
assert.equal(destructiveSequencePacks.id, 'gutenberg-destructive-sequence-packs', 'Gutenberg destructive sequence pack id drifted');
assert.equal(destructiveSequencePacks.status, 'contract_backed_executable', 'Gutenberg destructive sequence pack status drifted');
assert.equal(destructiveSequencePacks.execution_enabled, true, 'Gutenberg destructive sequence packs must be executable');
assert.equal(destructiveSequencePacks.local_execution_enabled, false, 'Gutenberg destructive sequence packs must not enable local execution');
assert.equal(destructiveSequencePacks.readiness?.level, 'executable', 'Gutenberg destructive sequence pack readiness drifted');
assert.equal(destructiveSequencePacks.readiness?.proof_bundle, undefined, 'Gutenberg destructive sequence packs must not claim proof refs before artifacts exist');
assert.deepEqual(new Set(destructiveSequencePacks.required_upstream_contracts || []), requiredDestructiveContracts, 'Gutenberg destructive sequence upstream contracts drifted');
assert.deepEqual(new Set(destructiveSequencePacks.readiness?.contract_ids || []), requiredDestructiveContracts, 'Gutenberg destructive sequence readiness contract ids drifted');

const gutenbergFamilies = new Map((destructiveSequencePacks.surface_families || []).map((family) => [family.id, family]));
assert.deepEqual(new Set(gutenbergFamilies.keys()), new Set(['templates', 'patterns', 'reusable-block-entities', 'navigation', 'editor-state', 'block-insert-edit-save-delete']), 'Gutenberg destructive sequence surface families drifted');
for (const [familyId, family] of gutenbergFamilies) {
  assert.equal(family.readiness, 'destructive_isolated_executable', `${familyId} must be executable`);
  assert.ok(family.operations.includes('delete'), `${familyId} must include delete operations`);
}

const gutenbergSequences = new Map((destructiveSequencePacks.sequence_packs || []).map((pack) => [pack.id, pack]));
assert.deepEqual(new Set(gutenbergSequences.keys()), new Set(['template-lifecycle', 'pattern-lifecycle', 'reusable-block-lifecycle', 'navigation-lifecycle', 'editor-state-lifecycle', 'block-insert-edit-save-delete']), 'Gutenberg destructive sequence pack ids drifted');
assert.deepEqual(new Set(destructiveSequencePacks.relative_hotspot_taxonomy?.labels || []), new Set(['sequence', 'action', 'route', 'table', 'editor_state']), 'Gutenberg destructive hotspot taxonomy labels drifted');
for (const [sequenceId, sequence] of gutenbergSequences) {
  assert.equal(sequence.readiness, 'destructive_isolated_executable', `${sequenceId} must be executable`);
  assert.ok(gutenbergFamilies.has(sequence.surface_family), `${sequenceId} references unknown surface family`);
  assert.ok(sequence.steps.some((step) => step.includes('delete')), `${sequenceId} must include a delete path`);
  assert.ok(sequence.required_contract_ids.includes('homeboy/wordpress-fuzz-runtime-workload-operation/v1'), `${sequenceId} must wire Homeboy workload operation contract`);
  assert.ok(sequence.required_contract_ids.includes('wp-codebox/mutation-isolation-artifact/v1'), `${sequenceId} must wire Codebox mutation-isolation artifacts`);
  assert.ok(sequence.required_contract_ids.includes('wp-codebox/delete-boundary-artifact/v1'), `${sequenceId} must wire Codebox delete-boundary artifacts`);
  assert.ok(sequence.required_contract_ids.includes('homeboy-extensions/generate-editor-observations/v1'), `${sequenceId} must wire HBEX editor observation artifacts`);
}

console.log(`validated ${fuzzManifests.length} Gutenberg fuzz manifests; no fuzz IDs are present in bench_workloads or bench_profiles`);
