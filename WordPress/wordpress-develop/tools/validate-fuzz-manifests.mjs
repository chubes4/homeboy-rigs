#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFullSurfaceCoverageManifest, assertFuzzReadinessMetadata, declaredFuzzIds, readJson } from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

const rig = readJson(packageRoot, 'rigs/wordpress-core-fuzz-coverage/rig.json');
const hooksWorkload = readJson(packageRoot, 'fuzz/hooks-cron-options.json');
const hooksManifest = readJson(packageRoot, 'manifests/hooks-cron-options.json');
const performanceWorkload = readJson(packageRoot, 'fuzz/performance-surfaces.json');
const performanceManifest = readJson(packageRoot, 'manifests/performance-surfaces.json');
const fullSurfaceCoverage = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const destructiveSequencePacks = readJson(packageRoot, 'manifests/destructive-sequence-packs.json');

const declaredIds = declaredFuzzIds(rig);
assertFullSurfaceCoverageManifest(fullSurfaceCoverage, { file: 'WordPress Core full-surface coverage' });

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

assert.equal(destructiveSequencePacks.schema, 'homeboy-rigs/wordpress-core-destructive-sequence-packs/v1', 'Core destructive sequence pack schema drifted');
assert.equal(destructiveSequencePacks.id, 'wordpress-core-destructive-sequence-packs', 'Core destructive sequence pack id drifted');
assert.equal(destructiveSequencePacks.status, 'declared_blocked', 'Core destructive sequence pack status drifted');
assert.equal(destructiveSequencePacks.execution_enabled, false, 'Core destructive sequence packs must not claim execution before runner wiring exists');
assert.equal(destructiveSequencePacks.local_execution_enabled, false, 'Core destructive sequence packs must not enable local execution');
assert.equal(destructiveSequencePacks.readiness?.level, 'declared', 'Core destructive sequence pack readiness drifted');
assert.equal(destructiveSequencePacks.readiness?.execution_enabled, false, 'Core destructive sequence readiness must not claim execution before runner wiring exists');
assert.equal(destructiveSequencePacks.readiness?.proof_bundle, undefined, 'Core destructive sequence packs must not claim proof refs before artifacts exist');
assert.ok((destructiveSequencePacks.missing_upstream_contracts || []).includes('homeboy-extensions/wordpress-fuzz-manifest-validator.js'), 'Core destructive sequence packs must name the missing HBX validator blocker');
assert.ok((destructiveSequencePacks.readiness?.upstream_blockers || []).includes('homeboy-extensions/wordpress-fuzz-manifest-validator.js'), 'Core destructive sequence readiness must name the missing HBX validator blocker');
assert.deepEqual(new Set(destructiveSequencePacks.required_upstream_contracts || []), requiredDestructiveContracts, 'Core destructive sequence upstream contracts drifted');
assert.deepEqual(new Set(destructiveSequencePacks.readiness?.contract_ids || []), requiredDestructiveContracts, 'Core destructive sequence readiness contract ids drifted');

const coreFamilies = new Map((destructiveSequencePacks.surface_families || []).map((family) => [family.id, family]));
assert.deepEqual(new Set(coreFamilies.keys()), new Set(['posts-pages', 'media', 'users', 'terms', 'options-rewrite', 'meta']), 'Core destructive sequence surface families drifted');
for (const [familyId, family] of coreFamilies) {
  assert.equal(family.readiness, 'declared_only_blocked', `${familyId} must remain declared-only until upstream execution exists`);
  assert.deepEqual(new Set(family.operations), new Set(['create', 'read', 'update', 'delete']), `${familyId} CRUD operations drifted`);
}

const coreSequences = new Map((destructiveSequencePacks.sequence_packs || []).map((pack) => [pack.id, pack]));
assert.deepEqual(new Set(coreSequences.keys()), new Set(['post-page-crud-delete', 'media-crud-delete', 'user-crud-delete', 'term-crud-delete', 'options-rewrite-crud-delete', 'meta-crud-delete']), 'Core destructive sequence pack ids drifted');
assert.deepEqual(new Set(destructiveSequencePacks.relative_hotspot_taxonomy?.labels || []), new Set(['sequence', 'action', 'route', 'table', 'state']), 'Core destructive hotspot taxonomy labels drifted');
for (const [sequenceId, sequence] of coreSequences) {
  assert.equal(sequence.readiness, 'declared_only_blocked', `${sequenceId} must remain declared-only until upstream execution exists`);
  assert.ok(coreFamilies.has(sequence.surface_family), `${sequenceId} references unknown surface family`);
  assert.ok(sequence.steps.some((step) => step.includes('delete')), `${sequenceId} must include a delete path`);
  assert.ok(sequence.required_contract_ids.includes('homeboy/wordpress-fuzz-runtime-workload-operation/v1'), `${sequenceId} must wire Homeboy workload operation contract`);
  assert.ok(sequence.required_contract_ids.includes('wp-codebox/mutation-isolation-artifact/v1'), `${sequenceId} must wire Codebox mutation-isolation artifacts`);
  assert.ok(sequence.required_contract_ids.includes('wp-codebox/delete-boundary-artifact/v1'), `${sequenceId} must wire Codebox delete-boundary artifacts`);
}

console.log('validated WordPress Core fuzz coverage manifests');
