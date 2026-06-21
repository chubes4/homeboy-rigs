import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

const manifest = JSON.parse(readFileSync(path.join(__dirname, 'full-surface-coverage.json'), 'utf8'));
const performanceRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-performance/rig.json'), 'utf8'));
const browserRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-browser-coverage/rig.json'), 'utf8'));

const expectedSafetyClassifications = new Set([
  'bounded_admin_fixture_mutation',
  'bounded_authenticated_read',
  'bounded_catalog_fixture_mutation',
  'browser_fixture_trace',
  'network_guardrail_probe',
  'read_only_inventory',
  'synthetic_checkout_mutation',
]);

test('full-surface executable workloads have coverage contract metadata', () => {
  const workloadIds = new Set([
    ...performanceRig.bench_profiles['full-surface'],
    ...browserRig.trace_profiles['full-surface'],
  ]);

  assert.ok(workloadIds.size > 0, 'expected executable full-surface workload ids');

  for (const workloadId of workloadIds) {
    const metadata = manifest.workloads?.[workloadId];
    assert.ok(metadata, `${workloadId} is missing manifest.workloads metadata`);
    assert.equal(typeof metadata.coverage_shape, 'string', `${workloadId} coverage_shape must be a string`);
    assert.ok(metadata.coverage_shape.length > 24, `${workloadId} coverage_shape should be reviewer-readable`);
    assert.equal(typeof metadata.surface, 'string', `${workloadId} surface must be a string`);
    assert.ok(expectedSafetyClassifications.has(metadata.safety?.classification), `${workloadId} has unknown safety classification`);
    assert.ok(Array.isArray(metadata.safety?.notes), `${workloadId} safety notes must be an array`);
    assert.ok(metadata.safety.notes.length > 0, `${workloadId} needs at least one safety note`);
    assert.ok(Array.isArray(metadata.artifact_expectations?.required), `${workloadId} required artifact expectations must be an array`);
    assert.ok(metadata.artifact_expectations.required.length > 0, `${workloadId} needs at least one required artifact expectation`);
  }
});

test('manifest workload metadata stays scoped to full-surface workload ids', () => {
  const workloadIds = new Set([
    ...performanceRig.bench_profiles['full-surface'],
    ...browserRig.trace_profiles['full-surface'],
  ]);

  assert.deepEqual(new Set(Object.keys(manifest.workloads)), workloadIds);
});
