import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const readText = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(readText(relativePath));

const matrix = readText('docs/fuzz-coverage-matrix.md');
const wooAggressiveDestructive = readJson('woocommerce/woocommerce/manifests/aggressive-destructive-workloads.json');
const wooRestCrudFixturePlan = readJson('woocommerce/woocommerce/manifests/rest-crud-fixture-plan.json');
const wooTargetInventory = readJson('woocommerce/woocommerce/manifests/target-inventory.json');
const wooPerformanceHotspots = readJson('woocommerce/woocommerce/fuzz/performance-hotspots-artifact-summary.json');
const jetpackFullSurface = readJson('Automattic/jetpack/manifests/full-surface-coverage.json');

const matrixTableRow = (label) => matrix.split('\n').find((line) => line.startsWith(`| ${label} |`));

test('coverage matrix reflects Woo destructive manifests as executable contract-backed coverage', () => {
  assert.equal(wooAggressiveDestructive.readiness.level, 'executable');
  assert.equal(wooAggressiveDestructive.readiness.execution_enabled, true);
  assert.deepEqual(wooAggressiveDestructive.readiness.missing_upstream_contracts, []);

  for (const contractId of wooAggressiveDestructive.generic_contracts) {
    assert.ok(matrix.includes(contractId), `matrix must name destructive contract ${contractId}`);
  }

  for (const operation of wooRestCrudFixturePlan.operations) {
    assert.equal(operation.expected.execute, true, `${operation.id} must be executable in the manifest`);
    assert.equal(operation.expected.readiness_level, 'executable', `${operation.id} readiness drifted`);
    for (const contractId of operation.expected.contract_ids) {
      assert.ok(matrix.includes(contractId), `matrix must name REST CRUD fixture contract ${contractId}`);
    }
  }

  const restApi = wooTargetInventory.discovery_manifests.product_surface_taxonomy.surfaces.rest_api;
  assert.equal(restApi.operation_readiness.create, 'destructive_isolated_executable');
  assert.equal(restApi.operation_readiness.update, 'destructive_isolated_executable');
  assert.equal(restApi.operation_readiness.delete, 'destructive_isolated_executable');
  assert.deepEqual(restApi.blocked_by, []);

  assert.ok(matrix.includes('No missing upstream contracts for executable destructive coverage.'));
  assert.ok(!matrix.includes('execute:false'), 'matrix must not preserve stale non-executable Woo CRUD language');
  assert.ok(!matrix.includes('D mutation'), 'matrix must not preserve stale declared-only mutation status');
});

test('coverage matrix reflects Jetpack mutation manifests as executable rows without inventing proof', () => {
  const jetpackRow = matrixTableRow('Jetpack');
  assert.ok(jetpackRow, 'summary table must include Jetpack');
  assert.ok(jetpackRow.includes('| D/E | D/E | D/E | D/E | D/E | D/E partial | D/E |'));

  const executableJetpackWorkloads = [
    ...jetpackFullSurface.coverage_profiles['full-surface'].options,
    ...jetpackFullSurface.coverage_profiles['full-surface'].modules,
    ...jetpackFullSurface.coverage_profiles['full-surface'].sync,
    ...jetpackFullSurface.coverage_profiles['full-surface'].connection_fixtures,
    ...jetpackFullSurface.coverage_profiles['full-surface'].performance_observation,
  ];

  for (const workloadId of executableJetpackWorkloads) {
    assert.ok(jetpackFullSurface.workloads[workloadId], `${workloadId} must have workload metadata`);
    assert.ok(matrix.includes(workloadId), `matrix must list executable Jetpack workload ${workloadId}`);
  }

  assert.ok(matrix.includes('Proven status needs reviewer-facing run artifacts'));
  assert.ok(matrix.includes('safe WP.com sandbox credentials'));
});

test('coverage matrix keeps performance proof tied to relative hotspot artifacts, not smoke output', () => {
  const artifactSchema = wooPerformanceHotspots.metadata.artifact_schema;
  assert.equal(artifactSchema.schema, 'homeboy-rigs/woocommerce-performance-hotspots-summary/v1');
  assert.equal(artifactSchema.ranking.mode, 'relative');
  assert.equal(artifactSchema.threshold_policy, 'relative_ranking_only');

  assert.ok(matrix.includes('Relative hotspot output (`homeboy-rigs/woocommerce-performance-hotspots-summary/v1`) is the primary performance evidence'));
  assert.ok(matrix.includes('smoke output are not proof'));
  assert.ok(!matrix.toLowerCase().includes('rollback'), 'matrix must avoid stale rollback proof language');
});
