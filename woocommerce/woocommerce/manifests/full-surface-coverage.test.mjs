import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertFullSurfaceCoverageManifest } from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

const manifest = JSON.parse(readFileSync(path.join(__dirname, 'full-surface-coverage.json'), 'utf8'));
const performanceRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-performance/rig.json'), 'utf8'));
const browserRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-browser-coverage/rig.json'), 'utf8'));
const generatedRestCases = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/generated-rest-request-cases.json'), 'utf8'));
const performanceHotspots = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/performance-hotspots-artifact-summary.json'), 'utf8'));

const workloadIdFromPath = (workloadPath) => path.basename(workloadPath, path.extname(workloadPath));

const executableCoverageWorkloadIds = () => new Set([
  ...Object.values(performanceRig.bench_workloads?.wordpress || {}).flat().map((entry) => workloadIdFromPath(entry.path)),
  ...(performanceRig.fuzz_workloads?.wordpress || []).map((entry) => workloadIdFromPath(entry.path)),
  ...browserRig.trace_profiles['full-surface'],
]);

const expectedSafetyClassifications = new Set([
  'bounded_admin_fixture_mutation',
  'bounded_authenticated_read',
  'bounded_catalog_fixture_mutation',
  'browser_fixture_trace',
  'isolated_fixture_mutation',
  'network_guardrail_probe',
  'performance_observation',
  'read_only_inventory',
  'synthetic_checkout_mutation',
]);

const requiredFuzzProofContracts = new Map([
  ['cart-session-overwrite-race', ['cart-session-race']],
  ['checkout-gateway-compatibility-matrix', ['gateway-compatibility']],
  ['checkout-shipping-cache', ['shipping-cache-invalidation']],
  ['frontend-rendering-request-coverage', ['shop-product-cart-checkout-rendering-requests']],
  ['layered-nav-catalog-crawl', ['catalog-layered-nav-transient-growth']],
  ['layered-nav-count-cache', ['layered-nav-transient-growth']],
  ['options-transients-coverage', ['cache-invalidation-and-transient-growth']],
  ['performance-hotspots-artifact-summary', ['artifact-summary-expectations']],
  ['woocommerce-external-http-guardrail', ['external-http-guardrails']],
]);

test('full-surface manifest uses shared coverage-map and gap-report schema', () => {
  assertFullSurfaceCoverageManifest(manifest, { file: 'woocommerce full-surface coverage' });
});

test('full-surface executable workloads have coverage contract metadata', () => {
  const workloadIds = executableCoverageWorkloadIds();

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
  const workloadIds = executableCoverageWorkloadIds();

  assert.deepEqual(new Set(Object.keys(manifest.workloads)), workloadIds);
});

test('high-risk Woo fuzz manifests declare required proof contracts', () => {
  for (const [workloadId, contractIds] of requiredFuzzProofContracts) {
    const workloadPath = path.join(packageRoot, 'fuzz', `${workloadId}.json`);
    const workload = JSON.parse(readFileSync(workloadPath, 'utf8'));
    const actualContractIds = new Set((workload.proof_contracts || []).map((contract) => contract.id));

    for (const contractId of contractIds) {
      assert.ok(actualContractIds.has(contractId), `${workloadId} missing ${contractId}`);
    }

    const requiredArtifactNames = new Set(workload.proof_contracts.map((contract) => contract.required_artifact));
    for (const artifactName of requiredArtifactNames) {
      assert.equal(
        workload.cases[0].artifacts.find((artifact) => artifact.name === artifactName)?.required,
        true,
        `${workloadId} case artifact ${artifactName} must be required`
      );
      assert.equal(
        workload.artifacts.expected.find((artifact) => artifact.name === artifactName)?.required,
        true,
        `${workloadId} expected artifact ${artifactName} must be required`
      );
    }
  }
});

test('fuzz workload metadata does not fall back to benchmark transcripts', () => {
  const fuzzWorkloadIds = new Set(
    performanceRig.fuzz_workloads.wordpress.map((entry) => workloadIdFromPath(entry.path))
  );

  for (const workloadId of fuzzWorkloadIds) {
    const optionalArtifacts = manifest.workloads[workloadId]?.artifact_expectations?.optional || [];
    assert.ok(
      !optionalArtifacts.includes('bench transcript'),
      `${workloadId} must not declare benchmark transcript fallback proof`
    );
  }
});

test('generated REST request cases are driven by route inventory coverage semantics', () => {
  const contract = manifest.surfaces.rest_api.generated_request_cases;

  assert.equal(contract.workload, 'bench/generated-rest-request-cases.php');
  assert.deepEqual(contract.safe_methods, ['GET']);
  assert.deepEqual(
    new Set(contract.surfaces),
    new Set(['store_api', 'wc_rest_api', 'wc_admin_api', 'wc_analytics_api'])
  );
  assert.equal(contract.coverage_gap_artifact.schema, 'homeboy-rigs/woocommerce-rest-route-coverage-gap/v1');
  assert.deepEqual(
    new Set(contract.coverage_gap_artifact.required_fields),
    new Set(['surface_type', 'expected', 'covered', 'gaps', 'status', 'evidence_refs'])
  );
  assert.deepEqual(
    new Set(contract.coverage_gap_artifact.skip_reason_codes),
    new Set(['dynamic_path_parameter', 'no_safe_read_method'])
  );

  assert.equal(generatedRestCases.safety_class, 'read_only');
  assert.equal(generatedRestCases.workload.type, 'php');
  assert.equal(generatedRestCases.workload.path, '${package.root}/bench/generated-rest-request-cases.php');
  assert.equal(generatedRestCases.cases[0].intent.execute.type, 'php');
  assert.ok(
    manifest.workloads['generated-rest-request-cases'].artifact_expectations.required.includes('coverage gap artifact'),
    'generated REST workload must require the route coverage gap artifact'
  );
});

test('performance hotspot summary contract uses relative ranking instead of hard thresholds', () => {
  const artifactSchema = performanceHotspots.metadata.artifact_schema;

  assert.equal(artifactSchema.schema, 'homeboy/woocommerce-performance-hotspots-summary/v1');
  assert.equal(artifactSchema.ranking.mode, 'relative');
  assert.deepEqual(
    new Set(artifactSchema.ranking.surfaces),
    new Set(['checkout', 'cart', 'catalog', 'admin', 'api'])
  );
  assert.deepEqual(
    new Set(artifactSchema.ranking.required_fields),
    new Set(['rank', 'surface', 'relative_score', 'request_attribution', 'query_attribution', 'fixture_scale', 'run_refs'])
  );
  assert.equal(artifactSchema.threshold_policy, 'relative_ranking_only');
  assert.equal(performanceHotspots.thresholds, undefined, 'hotspot summary must not declare hardcoded thresholds');
});
