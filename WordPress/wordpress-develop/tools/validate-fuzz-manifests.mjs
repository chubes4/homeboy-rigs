#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFuzzReadinessMetadata, declaredFuzzIds, readJson } from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

const rig = readJson(packageRoot, 'rigs/wordpress-core-fuzz-coverage/rig.json');
const hooksWorkload = readJson(packageRoot, 'fuzz/hooks-cron-options.json');
const hooksManifest = readJson(packageRoot, 'manifests/hooks-cron-options.json');
const performanceWorkload = readJson(packageRoot, 'fuzz/performance-surfaces.json');
const performanceManifest = readJson(packageRoot, 'manifests/performance-surfaces.json');

const declaredIds = declaredFuzzIds(rig);
for (const id of ['hooks-cron-options', 'performance-surfaces']) {
  assert.ok(declaredIds.has(id), `${id} must be declared in rig fuzz_workloads.wordpress`);
  for (const profile of ['fuzzer', 'full-surface']) {
    assert.ok(rig.fuzz_profiles?.[profile]?.includes(id), `${profile} must include ${id}`);
  }
}

assert.equal(hooksWorkload.workload?.path, '${package.root}/manifests/hooks-cron-options.json', 'hooks workload must use the runtime-state coverage manifest');
assertFuzzReadinessMetadata(hooksWorkload, { file: 'hooks-cron-options.json' });
assert.deepEqual(hooksWorkload.coverage?.surface_ids, hooksWorkload.surface_ids, 'hooks coverage surface ids drifted');
assert.deepEqual(hooksWorkload.coverage?.operations, hooksWorkload.operations, 'hooks coverage operations drifted');
assert.equal(hooksWorkload.limits?.max_cases, hooksWorkload.case_budget, 'hooks max_cases must match case_budget');

const requiredHookArtifacts = new Set(hooksManifest.proof_expectations?.required_artifacts || []);
for (const artifact of hooksWorkload.cases?.[0]?.artifacts || []) {
  assert.equal(artifact.required, true, `${artifact.name} must be a required proof artifact`);
  requiredHookArtifacts.delete(path.basename(artifact.path));
}
assert.equal(requiredHookArtifacts.size, 0, `missing hook proof artifacts: ${[...requiredHookArtifacts].join(', ')}`);

const hookKinds = new Set((hooksManifest.surfaces || []).map((surface) => surface.kind));
for (const kind of ['hooks', 'cron', 'options', 'transients', 'rewrite_rules']) {
  assert.ok(hookKinds.has(kind), `runtime-state manifest missing ${kind}`);
}

assert.deepEqual(performanceWorkload.coverage?.surface_ids, performanceWorkload.surface_ids, 'performance coverage surface ids drifted');
assertFuzzReadinessMetadata(performanceWorkload, { file: 'performance-surfaces.json' });
assert.deepEqual(performanceWorkload.coverage?.operations, performanceWorkload.operations, 'performance coverage operations drifted');
assert.equal(performanceWorkload.limits?.max_cases, performanceWorkload.case_budget, 'performance max_cases must match case_budget');
assert.equal(performanceWorkload.artifacts?.expected?.[0]?.required, true, 'performance summary artifact must be required');

const performanceKinds = new Set((performanceManifest.surfaces || []).map((surface) => surface.kind));
for (const kind of ['frontend', 'rest', 'admin', 'editor', 'server', 'database']) {
  assert.ok(performanceKinds.has(kind), `performance manifest missing ${kind} surface`);
}

for (const surface of performanceManifest.surfaces || []) {
  assert.ok(surface.signals.includes('query_count'), `${surface.id} must include query_count`);
  assert.ok(surface.signals.includes('request_timing') || surface.kind === 'database', `${surface.id} must include request_timing unless it is database-only`);
}

const surfacesWithAssets = (performanceManifest.surfaces || []).filter((surface) => surface.signals.some((signal) => ['asset_requests', 'enqueued_assets', 'editor_assets'].includes(signal)));
assert.ok(surfacesWithAssets.length >= 5, 'performance manifest must include representative asset observations');

console.log('validated WordPress Core fuzz coverage manifests');
