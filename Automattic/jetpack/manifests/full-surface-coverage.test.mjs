import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const fuzzRoot = path.join(packageRoot, 'fuzz');

const manifest = JSON.parse(readFileSync(path.join(__dirname, 'full-surface-coverage.json'), 'utf8'));
const apiRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/jetpack-api-route-inventory/rig.json'), 'utf8'));
const browserRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/jetpack-browser-coverage/rig.json'), 'utf8'));

const expectedSafetyClassifications = new Set([
  'bounded_authenticated_read',
  'browser_fixture_trace',
  'isolated_fixture_mutation',
  'network_guardrail_probe',
  'read_only_inventory',
]);

function workloadIdFromPath(workloadPath) {
  return path.basename(workloadPath).replace(/\.json$/, '');
}

test('Jetpack fuzz workloads are declared outside bench profiles', () => {
  assert.equal(apiRig.bench_workloads, undefined, 'Jetpack fuzz coverage must not use bench_workloads as a fallback');
  assert.equal(apiRig.bench_profiles, undefined, 'Jetpack fuzz coverage must not use bench_profiles as a fallback');

  const rigWorkloads = new Set(apiRig.fuzz_workloads.wordpress.map((workload) => workloadIdFromPath(workload.path)));
  const fuzzFiles = new Set(readdirSync(fuzzRoot).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, '')));

  assert.deepEqual(rigWorkloads, fuzzFiles);
});

test('Jetpack fuzz workload manifests carry coverage contract metadata', () => {
  const workloadIds = new Set([
    ...apiRig.fuzz_workloads.wordpress.map((workload) => workloadIdFromPath(workload.path)),
    ...browserRig.trace_profiles['full-surface'],
  ]);
  const profile = manifest.coverage_profiles['full-surface'];
  const profileFuzzIds = new Set(Object.entries(profile)
    .filter(([surface]) => surface !== 'browser_requests')
    .flatMap(([, ids]) => ids));

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

  assert.deepEqual(profileFuzzIds, new Set(apiRig.fuzz_workloads.wordpress.map((workload) => workloadIdFromPath(workload.path))));
  assert.deepEqual(new Set(profile.browser_requests), new Set(manifest.surfaces.browser_requests.scenarios));
  assert.deepEqual(new Set(Object.keys(manifest.workloads)), workloadIds);
});

test('Jetpack external HTTP guardrail blocks synthetic probes', () => {
  const guardrail = JSON.parse(readFileSync(path.join(fuzzRoot, 'jetpack-external-http-guardrail.json'), 'utf8'));

  assert.equal(guardrail.network_guardrail.block_network, true);
  assert.deepEqual(guardrail.network_guardrail.allowlist_domains, []);
  assert.equal(guardrail.network_guardrail.real_external_service_calls_allowed, false);
  assert.ok(guardrail.network_guardrail.probe_hosts.every((host) => host.endsWith('.invalid')));
});
