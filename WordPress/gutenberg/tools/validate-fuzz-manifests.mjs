#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const fuzzDir = path.join(packageRoot, 'fuzz');
const rig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/gutenberg-api-route-inventory/rig.json'), 'utf8'));

const fuzzManifests = readdirSync(fuzzDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    path: path.join(fuzzDir, file),
    manifest: JSON.parse(readFileSync(path.join(fuzzDir, file), 'utf8')),
  }));

assert.equal(fuzzManifests.length, 10, 'expected 10 Gutenberg fuzz manifests');

const fuzzerProfile = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/fuzzer-profile.json'), 'utf8'));

const declaredFuzzIds = new Set(
  (rig.fuzz_workloads?.wordpress || []).map((entry) => path.basename(entry.path, '.json'))
);
const benchWorkloadIds = new Set(
  Object.values(rig.bench_workloads || {})
    .flat()
    .map((entry) => path.basename(entry.path, path.extname(entry.path)))
);
const benchProfileIds = new Set(Object.values(rig.bench_profiles || {}).flat());

const requiredSurfaces = new Set([
  'gutenberg-rest-routes',
  'gutenberg-block-editor',
  'gutenberg-site-editor',
  'gutenberg-block-renderer',
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
  assert.equal(manifest.schema, 'homeboy/fuzz-workload/v1', `${file} schema mismatch`);
  assert.equal(typeof manifest.id, 'string', `${file} requires id`);
  assert.ok(declaredFuzzIds.has(manifest.id), `${manifest.id} is not declared in rig fuzz_workloads.wordpress`);
  assert.ok(!benchWorkloadIds.has(manifest.id), `${manifest.id} must not appear in bench_workloads`);
  assert.ok(!benchProfileIds.has(manifest.id), `${manifest.id} must not appear in bench_profiles`);

  assert.equal(manifest.target?.type, 'wordpress-plugin', `${manifest.id} target.type mismatch`);
  assert.equal(manifest.target?.slug, 'gutenberg', `${manifest.id} target.slug mismatch`);
  assert.equal(manifest.workload?.runner, 'wp-codebox', `${manifest.id} workload.runner mismatch`);
  assert.equal(manifest.workload?.path, manifest.metadata?.workload_path, `${manifest.id} workload path must match metadata`);
  assert.ok(['php', 'json', 'trace'].includes(manifest.workload?.type), `${manifest.id} workload.type must be php, json, or trace`);
  assert.deepEqual(manifest.coverage?.surface_ids, manifest.surface_ids, `${manifest.id} coverage surface ids drifted`);
  assert.deepEqual(manifest.coverage?.operations, manifest.operations, `${manifest.id} coverage operations drifted`);
  assert.equal(manifest.limits?.max_cases, manifest.case_budget, `${manifest.id} max_cases must match case_budget`);
  assert.equal(manifest.limits?.max_duration_seconds, manifest.duration_budget_seconds, `${manifest.id} max_duration_seconds must match duration_budget_seconds`);

  assert.equal(manifest.cases?.length, 1, `${manifest.id} requires one default runner case`);
  const [runnerCase] = manifest.cases;
  assert.equal(runnerCase.case_id, `${manifest.id}:default`, `${manifest.id} default case id mismatch`);
  assert.deepEqual(runnerCase.surface_ids, manifest.surface_ids, `${manifest.id} case surface ids drifted`);
  assert.deepEqual(runnerCase.operations, manifest.operations, `${manifest.id} case operations drifted`);
  assert.ok(Array.isArray(runnerCase.phases?.action), `${manifest.id} requires action phase`);
  assert.ok(runnerCase.phases.action.length > 0, `${manifest.id} requires at least one action step`);
  assert.ok(Array.isArray(runnerCase.artifacts), `${manifest.id} requires case artifacts`);
  assert.ok(Array.isArray(manifest.artifacts?.expected), `${manifest.id} requires expected artifacts`);

  for (const surfaceId of manifest.surface_ids || []) {
    coveredSurfaces.add(surfaceId);
  }
}

for (const surfaceId of requiredSurfaces) {
  assert.ok(coveredSurfaces.has(surfaceId), `missing Gutenberg fuzz surface ${surfaceId}`);
}

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

console.log(`validated ${fuzzManifests.length} Gutenberg fuzz manifests; no fuzz IDs are present in bench_workloads or bench_profiles`);
