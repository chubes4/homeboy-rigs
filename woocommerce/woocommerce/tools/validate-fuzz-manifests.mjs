#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const fuzzDir = path.join(packageRoot, 'fuzz');
const rig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-performance/rig.json'), 'utf8'));
const coverageManifest = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/full-surface-coverage.json'), 'utf8'));

const expectedFuzzIds = new Set([
  'action-scheduler-lookup-table-coverage',
  'admin-page-coverage',
  'cart-session-overwrite-race',
  'checkout-concurrent-create-order',
  'checkout-gateway-compatibility-matrix',
  'checkout-shipping-cache',
  'db-inventory',
  'frontend-rendering-request-coverage',
  'generated-rest-request-cases',
  'layered-nav-catalog-crawl',
  'layered-nav-count-cache',
  'options-transients-coverage',
  'performance-hotspots-artifact-summary',
  'rest-namespace-generated-cases',
  'rest-permission-boundary-matrix',
  'rest-schema-query-attribution',
  'rollback-safe-options-transients-mutations',
  'rest-db-query-profile',
  'woocommerce-external-http-guardrail',
  'woocommerce-rest-route-inventory',
]);

const requiredProofContracts = new Map([
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

const fuzzManifests = readdirSync(fuzzDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    path: path.join(fuzzDir, file),
    manifest: JSON.parse(readFileSync(path.join(fuzzDir, file), 'utf8')),
  }));

assert.equal(fuzzManifests.length, 20, 'expected 20 WooCommerce fuzz manifests');

const declaredFuzzIds = new Set(
  (rig.fuzz_workloads?.wordpress || []).map((entry) => path.basename(entry.path, '.json'))
);
const benchWorkloadIds = new Set(
  Object.values(rig.bench_workloads || {})
    .flat()
    .map((entry) => path.basename(entry.path, path.extname(entry.path)))
);
const benchProfileIds = new Set(Object.values(rig.bench_profiles || {}).flat());
const actualFuzzIds = new Set(fuzzManifests.map(({ manifest }) => manifest.id));
const coverageProfileWorkloadIds = new Set(Object.entries(coverageManifest.coverage_profiles['full-surface'])
  .filter(([surface]) => surface !== 'browser_requests')
  .flatMap(([, workloadIds]) => workloadIds));

assert.deepEqual(actualFuzzIds, expectedFuzzIds, 'WooCommerce fuzz manifest ids drifted');
assert.deepEqual(declaredFuzzIds, expectedFuzzIds, 'rig fuzz_workloads.wordpress ids drifted');
for (const workloadId of coverageProfileWorkloadIds) {
  assert.ok(declaredFuzzIds.has(workloadId), `${workloadId} full-surface profile entry must route through fuzz_workloads.wordpress`);
}

const fullSurfaceFuzzIds = new Set(Object.entries(coverageManifest.coverage_profiles['full-surface'])
  .filter(([surface]) => surface !== 'browser_requests')
  .flatMap(([, workloadIds]) => workloadIds));

for (const workloadId of fullSurfaceFuzzIds) {
  assert.ok(declaredFuzzIds.has(workloadId), `${workloadId} full-surface coverage is not backed by a fuzz workload`);
}

for (const { file, manifest } of fuzzManifests) {
  assert.equal(manifest.schema, 'homeboy/fuzz-workload/v1', `${file} schema mismatch`);
  assert.equal(typeof manifest.id, 'string', `${file} requires id`);
  assert.ok(declaredFuzzIds.has(manifest.id), `${manifest.id} is not declared in rig fuzz_workloads.wordpress`);
  assert.ok(!benchWorkloadIds.has(manifest.id), `${manifest.id} must not appear in bench_workloads`);
  assert.ok(!benchProfileIds.has(manifest.id), `${manifest.id} must not appear in bench_profiles`);

  assert.equal(manifest.target?.type, 'wordpress-plugin', `${manifest.id} target.type mismatch`);
  assert.equal(manifest.target?.slug, 'woocommerce', `${manifest.id} target.slug mismatch`);
  assert.equal(manifest.workload?.runner, 'wp-codebox', `${manifest.id} workload.runner mismatch`);
  assert.equal(manifest.workload?.path, manifest.metadata?.workload_path, `${manifest.id} workload path must match metadata`);
  assert.ok(['php', 'json'].includes(manifest.workload?.type), `${manifest.id} workload.type must be php or json`);
  assert.equal(manifest.metadata?.fixture?.runtime, 'wp-codebox', `${manifest.id} fixture runtime must be wp-codebox`);
  assert.equal(manifest.metadata?.fixture?.scope, 'disposable-wordpress', `${manifest.id} fixture scope must be disposable-wordpress`);
  assert.equal(manifest.metadata?.fixture?.component, 'woocommerce', `${manifest.id} fixture component must be woocommerce`);
  assert.equal(manifest.metadata?.fixture?.activation, 'woocommerce/woocommerce.php', `${manifest.id} fixture activation must be woocommerce/woocommerce.php`);
  assert.deepEqual(manifest.coverage?.surface_ids, manifest.surface_ids, `${manifest.id} coverage surface ids drifted`);
  assert.deepEqual(manifest.coverage?.operations, manifest.operations, `${manifest.id} coverage operations drifted`);
  assert.equal(manifest.limits?.max_cases, manifest.case_budget, `${manifest.id} max_cases must match case_budget`);
  assert.equal(manifest.limits?.max_duration_seconds, manifest.duration_budget_seconds, `${manifest.id} max_duration_seconds must match duration_budget_seconds`);

  assert.equal(manifest.cases?.length, 1, `${manifest.id} requires one default runner case`);
  const [runnerCase] = manifest.cases;
  assert.equal(runnerCase.case_id, `${manifest.id}:default`, `${manifest.id} default case id mismatch`);
  assert.equal(runnerCase.metadata?.safety_class, manifest.safety_class, `${manifest.id} case safety class must match workload safety class`);
  assert.deepEqual(runnerCase.surface_ids, manifest.surface_ids, `${manifest.id} case surface ids drifted`);
  assert.deepEqual(runnerCase.operations, manifest.operations, `${manifest.id} case operations drifted`);
  assert.ok(Array.isArray(runnerCase.phases?.action), `${manifest.id} requires action phase`);
  assert.ok(runnerCase.phases.action.length > 0, `${manifest.id} requires at least one action step`);
  assert.ok(Array.isArray(runnerCase.artifacts), `${manifest.id} requires case artifacts`);
  assert.ok(Array.isArray(manifest.artifacts?.expected), `${manifest.id} requires expected artifacts`);

  for (const artifact of manifest.artifacts.expected) {
    assert.equal(typeof artifact.semantic_key, 'string', `${manifest.id} expected artifact ${artifact.name} requires semantic_key`);
  }

  const requiredContractIds = requiredProofContracts.get(manifest.id) || [];
  if (requiredContractIds.length > 0) {
    const proofContracts = manifest.proof_contracts || [];
    assert.ok(Array.isArray(proofContracts), `${manifest.id} proof_contracts must be an array`);

    const proofContractIds = new Set(proofContracts.map((contract) => contract.id));
    for (const contractId of requiredContractIds) {
      assert.ok(proofContractIds.has(contractId), `${manifest.id} missing proof contract ${contractId}`);
    }

    for (const contract of proofContracts) {
      assert.equal(typeof contract.description, 'string', `${manifest.id} proof contract ${contract.id} requires description`);
      assert.ok(contract.description.length > 0, `${manifest.id} proof contract ${contract.id} description must not be empty`);
      assert.equal(typeof contract.required_artifact, 'string', `${manifest.id} proof contract ${contract.id} requires required_artifact`);
    }

    const requiredArtifactNames = new Set(proofContracts.map((contract) => contract.required_artifact));
    for (const artifactName of requiredArtifactNames) {
      const caseArtifact = runnerCase.artifacts.find((artifact) => artifact.name === artifactName);
      const expectedArtifact = manifest.artifacts.expected.find((artifact) => artifact.name === artifactName);
      assert.equal(caseArtifact?.required, true, `${manifest.id} proof artifact ${artifactName} must be required on the case`);
      assert.equal(expectedArtifact?.required, true, `${manifest.id} proof artifact ${artifactName} must be required in expected artifacts`);
    }
  }

  if (manifest.id === 'admin-page-coverage') {
    assert.ok(manifest.operations.includes('safe-menu-enumeration-contract'), 'admin-page-coverage requires safe menu enumeration contract operation');
    assert.ok(manifest.operations.includes('skipped-destructive-reason-classification'), 'admin-page-coverage requires skipped/destructive reason classification');
    assert.equal(manifest.metadata?.admin_page_contract_schema, 'homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1');
    assert.equal(manifest.metadata?.artifact_contract_schema, 'homeboy-rigs/woocommerce-admin-page-coverage/v1');
    assert.equal(manifest.artifacts.expected[0]?.schema, 'homeboy-rigs/woocommerce-admin-page-coverage/v1');
    assert.equal(runnerCase.artifacts[0]?.required, true, 'admin_page_coverage case artifact must be required');
    assert.deepEqual(
      coverageManifest.surfaces.authenticated_admin_pages.enumeration_contract.artifact_expectations.required,
      ['contract', 'targets', 'visits', 'skipped', 'request_logs', 'query_attribution', 'metrics'],
      'admin page coverage artifact expectation contract drifted'
    );
  }
}

const proofReadyContracts = {
  'rest-namespace-generated-cases': ['namespace-classification', 'generated-safe-get-cases', 'route-gap-attribution'],
  'rest-permission-boundary-matrix': ['namespace-inventory', 'role-boundary-classification', 'status-contract-attribution'],
  'rest-schema-query-attribution': ['rest-schema-attribution', 'query-shape-attribution', 'route-to-table-attribution'],
  'action-scheduler-lookup-table-coverage': ['action-scheduler-delta', 'lookup-table-inventory', 'lookup-row-attribution'],
  'rollback-safe-options-transients-mutations': ['rollback-safe-option-mutation', 'transient-growth-attribution', 'skipped-sensitive-option-attribution'],
};

for (const [workloadId, operations] of Object.entries(proofReadyContracts)) {
  const manifest = fuzzManifests.find(({ manifest: candidate }) => candidate.id === workloadId)?.manifest;
  assert.ok(manifest, `${workloadId} proof-ready fuzz contract is missing`);
  for (const operation of operations) {
    assert.ok(manifest.operations.includes(operation), `${workloadId} must declare ${operation}`);
  }
  assert.ok(manifest.artifacts.expected.some((artifact) => artifact.semantic_key === 'fuzz.report'), `${workloadId} must declare a fuzz.report artifact contract`);
}

console.log(`validated ${fuzzManifests.length} WooCommerce fuzz manifests; no migrated fuzz IDs are present in bench_workloads or bench_profiles`);
