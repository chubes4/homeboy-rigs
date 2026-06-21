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

const declaredFuzzIds = new Set(
  (rig.fuzz_workloads?.wordpress || []).map((entry) => path.basename(entry.path, '.json'))
);
const benchWorkloadIds = new Set(
  Object.values(rig.bench_workloads || {})
    .flat()
    .map((entry) => path.basename(entry.path, path.extname(entry.path)))
);
const benchProfileIds = new Set(Object.values(rig.bench_profiles || {}).flat());
const restRouteCoverage = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/rest-route-coverage.json'), 'utf8'));
const restCases = JSON.parse(readFileSync(path.join(packageRoot, 'bench/generated-rest-request-cases.workload.json'), 'utf8'));
const dbInventory = JSON.parse(readFileSync(path.join(packageRoot, 'bench/db-inventory.workload.json'), 'utf8'));
const restQueryProfile = JSON.parse(readFileSync(path.join(packageRoot, 'bench/rest-db-query-profile.workload.json'), 'utf8'));

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

  for (const artifact of runnerCase.artifacts) {
    assert.equal(artifact.required, true, `${manifest.id} case artifact ${artifact.name} must be required`);
  }
  for (const artifact of manifest.artifacts.expected) {
    assert.equal(artifact.required, true, `${manifest.id} expected artifact ${artifact.name} must be required`);
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

console.log(`validated ${fuzzManifests.length} Gutenberg fuzz manifests; no fuzz IDs are present in bench_workloads or bench_profiles`);
