import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const readText = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(readText(relativePath));

const wooAggressiveDestructive = readJson('woocommerce/woocommerce/manifests/aggressive-destructive-workloads.json');
const wooRestCrudFixturePlan = readJson('woocommerce/woocommerce/manifests/rest-crud-fixture-plan.json');
const wooTargetInventory = readJson('woocommerce/woocommerce/manifests/target-inventory.json');
const wooPerformanceHotspots = readJson('woocommerce/woocommerce/fuzz/performance-hotspots-artifact-summary.json');
const jetpackFullSurface = readJson('Automattic/jetpack/manifests/full-surface-coverage.json');

test('Woo destructive manifests declare executable contract-backed coverage', () => {
  assert.equal(wooAggressiveDestructive.readiness.level, 'executable');
  assert.equal(wooAggressiveDestructive.readiness.execution_enabled, true);
  assert.deepEqual(wooAggressiveDestructive.readiness.missing_upstream_contracts, []);

  assert.ok(wooAggressiveDestructive.generic_contracts.length > 0, 'destructive coverage must name generic contracts');

  for (const operation of wooRestCrudFixturePlan.operations) {
    assert.equal(operation.expected.execute, true, `${operation.id} must be executable in the manifest`);
    assert.equal(operation.expected.readiness_level, 'executable', `${operation.id} readiness drifted`);
    assert.ok(operation.expected.contract_ids.length > 0, `${operation.id} must declare contract ids`);
  }

  const restApi = wooTargetInventory.discovery_manifests.product_surface_taxonomy.surfaces.rest_api;
  assert.equal(restApi.operation_readiness.create, 'destructive_isolated_executable');
  assert.equal(restApi.operation_readiness.update, 'destructive_isolated_executable');
  assert.equal(restApi.operation_readiness.delete, 'destructive_isolated_executable');
  assert.deepEqual(restApi.blocked_by, []);
});

test('Jetpack mutation manifests declare executable workloads without claiming proof', () => {
  const executableJetpackWorkloads = [
    ...jetpackFullSurface.coverage_profiles['full-surface'].options,
    ...jetpackFullSurface.coverage_profiles['full-surface'].modules,
    ...jetpackFullSurface.coverage_profiles['full-surface'].sync,
    ...jetpackFullSurface.coverage_profiles['full-surface'].connection_fixtures,
    ...jetpackFullSurface.coverage_profiles['full-surface'].performance_observation,
  ];

  for (const workloadId of executableJetpackWorkloads) {
    const workload = jetpackFullSurface.workloads[workloadId];
    assert.ok(workload, `${workloadId} must have workload metadata`);
    assert.ok(workload.artifact_expectations?.required?.length > 0, `${workloadId} must declare required artifacts before proof can be claimed`);
  }
});

test('performance proof remains tied to relative hotspot artifact schema', () => {
  const artifactSchema = wooPerformanceHotspots.metadata.artifact_schema;
  assert.equal(artifactSchema.schema, 'homeboy-rigs/woocommerce-performance-hotspots-summary/v1');
  assert.equal(artifactSchema.ranking.mode, 'relative');
  assert.equal(artifactSchema.threshold_policy, 'relative_ranking_only');
});
