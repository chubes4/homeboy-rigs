#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertGenericFuzzManifest,
  collectFuzzManifests,
  declaredBenchProfileIds,
  declaredBenchWorkloadIds,
  declaredFuzzIds,
  readJson,
} from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const rig = readJson(packageRoot, 'rigs/woocommerce-performance/rig.json');
const coverageManifest = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const targetInventory = readJson(packageRoot, 'manifests/target-inventory.json');

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

const fuzzManifests = collectFuzzManifests(packageRoot);

assert.equal(fuzzManifests.length, 20, 'expected 20 WooCommerce fuzz manifests');

const declaredIds = declaredFuzzIds(rig);
const benchWorkloadIds = declaredBenchWorkloadIds(rig);
const benchProfileIds = declaredBenchProfileIds(rig);
const actualFuzzIds = new Set(fuzzManifests.map(({ manifest }) => manifest.id));
const coverageProfileWorkloadIds = new Set(Object.entries(coverageManifest.coverage_profiles['full-surface'])
  .filter(([surface]) => surface !== 'browser_requests')
  .flatMap(([, workloadIds]) => workloadIds));

assert.deepEqual(actualFuzzIds, expectedFuzzIds, 'WooCommerce fuzz manifest ids drifted');
assert.deepEqual(declaredIds, expectedFuzzIds, 'rig fuzz_workloads.wordpress ids drifted');
for (const workloadId of coverageProfileWorkloadIds) {
  assert.ok(declaredIds.has(workloadId), `${workloadId} full-surface profile entry must route through fuzz_workloads.wordpress`);
}

const fullSurfaceFuzzIds = new Set(Object.entries(coverageManifest.coverage_profiles['full-surface'])
  .filter(([surface]) => surface !== 'browser_requests')
  .flatMap(([, workloadIds]) => workloadIds));

for (const workloadId of fullSurfaceFuzzIds) {
  assert.ok(declaredIds.has(workloadId), `${workloadId} full-surface coverage is not backed by a fuzz workload`);
}

const generatedTargetInventory = JSON.parse(execFileSync(process.execPath, [
  path.join(packageRoot, 'tools/generate-target-inventory.mjs'),
], { encoding: 'utf8' }));

assert.deepEqual(targetInventory, generatedTargetInventory, 'WooCommerce target inventory artifact must match the generator output');
assert.equal(coverageManifest.target_inventory_manifest, 'manifests/target-inventory.json', 'full-surface coverage must point at the target inventory manifest');
assert.equal(targetInventory.schema, 'homeboy-rigs/wordpress-target-inventory/v1', 'target inventory schema drifted');
assert.equal(targetInventory.runtime?.runner, 'wp-codebox', 'target inventory must run through WP Codebox');
assert.equal(targetInventory.runtime?.activation, 'woocommerce/woocommerce.php', 'target inventory must activate WooCommerce');
assert.deepEqual(new Set(targetInventory.declared_fuzz_workloads), expectedFuzzIds, 'target inventory declared fuzz workloads drifted');

const requiredTargetSurfaces = new Set([
  'rest_routes',
  'admin_pages',
  'frontend_pages',
  'database',
  'blocks',
  'options_transients',
  'performance_hotspots',
]);

assert.deepEqual(new Set(Object.keys(targetInventory.targets)), requiredTargetSurfaces, 'target inventory surfaces drifted');
assert.deepEqual(new Set(Object.keys(targetInventory.inventory_primitives)), requiredTargetSurfaces, 'target inventory primitive surfaces drifted');

for (const surface of requiredTargetSurfaces) {
  const primitive = targetInventory.inventory_primitives[surface];
  const target = targetInventory.targets[surface];

  assert.equal(primitive.status, 'preferred', `${surface} must prefer the generic WP Codebox/Homeboy Extensions primitive`);
  assert.equal(typeof primitive.command, 'string', `${surface} requires primitive command`);
  assert.ok(primitive.command.startsWith('wordpress.'), `${surface} primitive command must be WordPress-scoped`);
  assert.equal(typeof primitive.artifact_schema, 'string', `${surface} requires artifact schema`);
  assert.ok(Array.isArray(primitive.workload_ids), `${surface} requires workload_ids`);
  assert.ok(primitive.workload_ids.length > 0, `${surface} must map to at least one workload`);
  assert.ok(Array.isArray(target.required_sections), `${surface} target requires required_sections`);
  assert.ok(target.required_sections.length > 0, `${surface} target required_sections must not be empty`);

  for (const workloadId of primitive.workload_ids) {
    assert.ok(declaredIds.has(workloadId), `${surface} target inventory workload ${workloadId} is not declared in rig fuzz_workloads.wordpress`);
  }
}

for (const namespace of ['wc/v3', 'wc/store/v1', 'wc-admin', 'wc-analytics']) {
  assert.ok(targetInventory.targets.rest_routes.namespaces.includes(namespace), `REST target inventory missing ${namespace}`);
}

for (const scenario of ['shop', 'product', 'cart', 'checkout']) {
  assert.ok(targetInventory.targets.frontend_pages.scenarios.includes(scenario), `frontend target inventory missing ${scenario}`);
  assert.ok(targetInventory.targets.blocks.frontend_contexts.includes(scenario), `block target inventory missing ${scenario}`);
}

assert.ok(targetInventory.targets.blocks.block_name_prefixes.includes('woocommerce/'), 'block target inventory must include WooCommerce block namespace');
assert.ok(targetInventory.targets.database.table_prefixes.includes('woocommerce_'), 'database target inventory must include WooCommerce table prefix');
assert.ok(targetInventory.targets.database.table_prefixes.includes('actionscheduler_'), 'database target inventory must include Action Scheduler table prefix');
assert.ok(targetInventory.targets.options_transients.option_prefixes.includes('woocommerce_'), 'options/transients target inventory must include WooCommerce option prefix');
assert.ok(targetInventory.targets.performance_hotspots.focus_areas.includes('checkout'), 'performance target inventory must include checkout focus area');
assert.ok(targetInventory.targets.performance_hotspots.focus_areas.includes('catalog_layered_navigation'), 'performance target inventory must include catalog layered navigation focus area');

for (const { file, manifest } of fuzzManifests) {
  const runnerCase = assertGenericFuzzManifest(manifest, {
    file,
    declaredIds,
    benchWorkloadIds,
    benchProfileIds,
    targetSlug: 'woocommerce',
    workloadTypes: ['php', 'json'],
    requireCaseSafetyClass: true,
    requireCaseArtifacts: false,
    requireExpectedArtifacts: false,
    requireExpectedArtifactSemanticKeys: true,
  });

  assert.equal(manifest.metadata?.fixture?.runtime, 'wp-codebox', `${manifest.id} fixture runtime must be wp-codebox`);
  assert.equal(manifest.metadata?.fixture?.scope, 'disposable-wordpress', `${manifest.id} fixture scope must be disposable-wordpress`);
  assert.equal(manifest.metadata?.fixture?.component, 'woocommerce', `${manifest.id} fixture component must be woocommerce`);
  assert.equal(manifest.metadata?.fixture?.activation, 'woocommerce/woocommerce.php', `${manifest.id} fixture activation must be woocommerce/woocommerce.php`);

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
