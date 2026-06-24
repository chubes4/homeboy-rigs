#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFullSurfaceCoverageManifest,
  assertGenericFuzzManifest,
  collectFuzzManifests,
  declaredBenchProfileIds,
  declaredBenchWorkloadIds,
  declaredFuzzIds,
  fullSurfaceRequiredArtifactIds,
  fuzzManifestHasExecutableArtifactContract,
  readJson,
} from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const rig = readJson(packageRoot, 'rigs/woocommerce-performance/rig.json');
const coverageManifest = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const dbApiPerformanceFuzzerGapReport = readJson(packageRoot, 'manifests/db-api-performance-fuzzer-gap-report.json');
const restCrudRouteFamilyCatalog = readJson(packageRoot, 'manifests/rest-crud-route-family-catalog.json');
const dbApiHotspotArtifactIo = readJson(packageRoot, 'manifests/db-api-hotspot-artifact-io.json');
const blockInventoryRenderingFuzz = readJson(packageRoot, 'manifests/block-inventory-rendering-fuzz.json');
const adminActionInventory = readJson(packageRoot, 'manifests/admin-action-inventory.json');
const targetInventory = readJson(packageRoot, 'manifests/target-inventory.json');
const coverageGapReportWorkload = readJson(packageRoot, 'bench/coverage-gap-report.workload.json');
const performanceHotspotsWorkload = readJson(packageRoot, 'bench/performance-hotspots-artifact-summary.workload.json');
const runtimeDependencyHelper = path.join(packageRoot, 'tools/prepare-runtime-dependency.sh');

assertFullSurfaceCoverageManifest(coverageManifest, { file: 'WooCommerce full-surface coverage' });

const expectedFuzzIds = new Set([
  'action-scheduler-lookup-table-coverage',
  'admin-page-coverage',
  'cart-session-overwrite-race',
  'checkout-concurrent-create-order',
  'checkout-gateway-compatibility-matrix',
  'checkout-shipping-cache',
  'codebox-fuzz-suite-smoke',
  'coverage-gap-report',
  'db-inventory',
  'frontend-rendering-request-coverage',
  'generated-rest-request-cases',
  'layered-nav-catalog-crawl',
  'layered-nav-count-cache',
  'options-transients-coverage',
  'performance-hotspots-artifact-summary',
  'rest-product-batch-import',
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

assert.equal(fuzzManifests.length, 23, 'expected 23 WooCommerce fuzz manifests');
assert.ok(existsSync(runtimeDependencyHelper), 'WooCommerce runtime dependency prep helper must exist');

const declaredIds = declaredFuzzIds(rig);
const benchWorkloadIds = declaredBenchWorkloadIds(rig);
const benchProfileIds = declaredBenchProfileIds(rig);
const actualFuzzIds = new Set(fuzzManifests.map(({ manifest }) => manifest.id));
const coverageProfileWorkloadIds = new Set(Object.entries(coverageManifest.coverage_profiles['full-surface'])
  .filter(([surface]) => surface !== 'browser_requests')
  .flatMap(([, workloadIds]) => workloadIds));

assert.deepEqual(actualFuzzIds, expectedFuzzIds, 'WooCommerce fuzz manifest ids drifted');
assert.deepEqual(declaredIds, expectedFuzzIds, 'rig fuzz_workloads.wordpress ids drifted');

const runtimePrepFiles = new Set([
  '${components.woocommerce.path}/vendor/autoload_packages.php',
  '${components.woocommerce.path}/includes/react-admin/feature-config.php',
  '${components.woocommerce.path}/assets/client/admin/wp-admin-scripts/command-palette.asset.php',
]);
const runtimePrepCheckSteps = (rig.pipeline?.check || []).filter((step) => runtimePrepFiles.has(step.file));

assert.equal(runtimePrepCheckSteps.length, runtimePrepFiles.size, 'WooCommerce runtime dependency prep must be declared once in check');

for (const step of runtimePrepCheckSteps) {
  assert.equal(step.kind, 'requirement', `${step.file} prep step must use a requirement declaration`);
  assert.deepEqual(step.prepare_phases, ['up', 'bench_prepare'], `${step.file} prep phases drifted`);
  assert.match(step.prepare_command, /tools\/prepare-runtime-dependency\.sh/, `${step.file} must use the shared WooCommerce runtime dependency helper`);
}

for (const phase of ['up', 'bench_prepare']) {
  const duplicatedPrepSteps = (rig.pipeline?.[phase] || []).filter((step) => runtimePrepFiles.has(step.file) || /prepare-runtime-dependency\.sh/.test(step.prepare_command || ''));
  assert.equal(duplicatedPrepSteps.length, 0, `WooCommerce runtime dependency prep must not be duplicated in pipeline.${phase}`);
}

for (const workloadId of coverageProfileWorkloadIds) {
  assert.ok(declaredIds.has(workloadId), `${workloadId} full-surface profile entry must route through fuzz_workloads.wordpress`);
}

const fullSurfaceFuzzIds = new Set(Object.entries(coverageManifest.coverage_profiles['full-surface'])
  .filter(([surface]) => surface !== 'browser_requests')
  .flatMap(([, workloadIds]) => workloadIds));
const requiredArtifactWorkloadIds = fullSurfaceRequiredArtifactIds(coverageManifest);
const dbApiPerformanceFuzzerWorkloadIds = [
  'woocommerce-rest-route-inventory',
  'generated-rest-request-cases',
  'rest-db-query-profile',
  'db-inventory',
  'rest-schema-query-attribution',
  'coverage-gap-report',
  'performance-hotspots-artifact-summary',
];
const dbApiPerformanceFuzzerGapReportInputIds = dbApiPerformanceFuzzerWorkloadIds.filter((workloadId) => workloadId !== 'coverage-gap-report');
const externalDiscoveryWorkloadIds = new Set([
  'woocommerce-browser-coverage',
]);

function assertDeclaredOrExternalDiscoveryWorkload(workloadId, context) {
  assert.ok(
    declaredIds.has(workloadId) || externalDiscoveryWorkloadIds.has(workloadId),
    `${context} references unknown workload ${workloadId}`
  );
}

function assertArtifactPostprocessWorkload(workload, { id, action, artifactName, schema }) {
  assert.equal(workload.schema, 'wp-codebox/wordpress-workload-run/v1', `${id} must use the upstream workload-run envelope`);
  assert.equal(workload.id, id, `${id} workload id drifted`);
  assert.equal(workload.steps?.length, 1, `${id} must declare one generic artifact-postprocess step`);
  assert.equal(workload.steps[0].command, 'homeboy.artifact-postprocess', `${id} must use the generic artifact-postprocess command`);
  assert.equal(workload.steps[0].type, undefined, `${id} must not invent unsupported step types`);

  const args = workload.steps[0].args;
  assert.equal(args.helper, '${package.root}/tools/db-api-fuzzer-artifacts.mjs', `${id} helper drifted`);
  assert.equal(args.action, action, `${id} action drifted`);
  assert.deepEqual(args.input, {
    type: 'artifact-root',
    path: '${artifacts.root}',
    artifact_globs: ['**/*.json'],
    max_bytes: 1048576,
  }, `${id} input artifact root contract drifted`);
  assert.equal(args.output.artifact, artifactName, `${id} output artifact name drifted`);
  assert.equal(args.output.kind, 'json', `${id} output kind drifted`);
  assert.equal(args.output.contentType, 'application/json', `${id} output contentType drifted`);
  assert.equal(args.output.schema, schema, `${id} output schema drifted`);
  assert.equal(args.output.semantic_key, 'fuzz.report', `${id} output semantic key drifted`);
  assert.equal(workload.artifacts?.[0]?.name, artifactName, `${id} collected artifact name drifted`);
  assert.equal(workload.artifacts?.[0]?.required, true, `${id} collected artifact must be required`);
  assert.equal(workload.metadata?.runner_support_status, 'requires-upstream-binding', `${id} must stay blocked until upstream binds homeboy.artifact-postprocess`);
  assert.match(workload.metadata?.missing_upstream_contract || '', /args\.helper, args\.action, args\.input, args\.output, and args\.parameters/, `${id} must document exact missing upstream fields`);
}

assertArtifactPostprocessWorkload(coverageGapReportWorkload, {
  id: 'coverage-gap-report',
  action: 'coverage-gap-report',
  artifactName: 'coverage_gap_report',
  schema: 'homeboy-rigs/wordpress-coverage-gap-report/v1',
});

assertArtifactPostprocessWorkload(performanceHotspotsWorkload, {
  id: 'performance-hotspots-artifact-summary',
  action: 'performance-hotspots-summary',
  artifactName: 'performance_hotspots_summary',
  schema: 'homeboy/woocommerce-performance-hotspots-summary/v1',
});

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
assert.deepEqual(targetInventory.source_manifests, {
  full_surface: 'manifests/full-surface-coverage.json',
  rig: 'rigs/woocommerce-performance/rig.json',
  rest_crud_route_family_catalog: 'manifests/rest-crud-route-family-catalog.json',
  block_inventory_rendering_fuzz: 'manifests/block-inventory-rendering-fuzz.json',
  admin_action_inventory: 'manifests/admin-action-inventory.json',
  db_api_hotspot_artifact_io: 'manifests/db-api-hotspot-artifact-io.json',
}, 'target inventory source manifests drifted');
assert.deepEqual(rig.fuzz_profile_metadata?.['full-surface']?.discovery_manifests, {
  rest_route_families: 'manifests/rest-crud-route-family-catalog.json',
  blocks: 'manifests/block-inventory-rendering-fuzz.json',
  admin_actions: 'manifests/admin-action-inventory.json',
  db_api_hotspots: 'manifests/db-api-hotspot-artifact-io.json',
}, 'full-surface profile discovery manifests drifted');
assert.equal(rig.fuzz_profile_metadata?.['full-surface']?.readiness?.level, 'declared_inventory', 'full-surface discovery manifests must stay declared inventory');

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
    requireRunnerNeutralIntent: true,
  });

  assert.equal(manifest.metadata?.fixture?.runtime, 'wp-codebox', `${manifest.id} fixture runtime must be wp-codebox`);
  assert.equal(manifest.metadata?.fixture?.scope, 'disposable-wordpress', `${manifest.id} fixture scope must be disposable-wordpress`);
  assert.equal(manifest.metadata?.fixture?.component, 'woocommerce', `${manifest.id} fixture component must be woocommerce`);
  assert.equal(manifest.metadata?.fixture?.activation, 'woocommerce/woocommerce.php', `${manifest.id} fixture activation must be woocommerce/woocommerce.php`);

  if (manifest.metadata?.readiness?.level === 'proven') {
    const proofBundle = manifest.metadata.readiness.proof_bundle;
    assert.ok(proofBundle, `${manifest.id} proven readiness must link a proof bundle`);
    assert.ok(proofBundle.run_ids.length > 0, `${manifest.id} proven readiness must link at least one run id`);
  }

  const requiredContractIds = requiredProofContracts.get(manifest.id) || [];
  if (requiredArtifactWorkloadIds.has(manifest.id) && fuzzManifestHasExecutableArtifactContract(manifest)) {
    for (const artifact of runnerCase.artifacts) {
      assert.equal(artifact.required, true, `${manifest.id} full-surface executable case artifact ${artifact.name} must be required`);
    }
    for (const artifact of manifest.artifacts.expected) {
      assert.equal(artifact.required, true, `${manifest.id} full-surface executable expected artifact ${artifact.name} must be required`);
    }
  }

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

const codeboxSmokeManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'codebox-fuzz-suite-smoke')?.manifest;
assert.ok(codeboxSmokeManifest, 'codebox-fuzz-suite-smoke manifest is missing');
assert.equal(codeboxSmokeManifest.metadata?.readiness?.level, 'declared', 'codebox smoke must not claim proven readiness without proof artifacts');
assert.ok(codeboxSmokeManifest.operations.includes('generated-route-inventory-contract'), 'codebox smoke must depend on generated route inventory contracts');
assert.ok(codeboxSmokeManifest.operations.includes('rest-db-query-attribution-contract'), 'codebox smoke must depend on REST DB query attribution contracts');
assert.deepEqual(codeboxSmokeManifest.metadata?.required_primitive_contracts, [
  'wordpress.inventory-rest-routes',
  'wordpress.generate-rest-request-cases',
  'wordpress.profile-rest-db-queries',
  'wordpress.inventory-database',
  'wordpress.attribute-rest-schema-queries',
  'wordpress.summarize-performance-hotspots',
  'wordpress.coverage-gap-report',
]);
assert.equal(codeboxSmokeManifest.metadata?.readiness?.upstream_blockers?.length, 4, 'codebox smoke declared readiness must name upstream blockers');
assert.equal(codeboxSmokeManifest.metadata?.readiness?.crud?.read?.level, 'executable', 'DB/API profile read CRUD boundary must be executable');
for (const operation of ['create', 'update', 'delete']) {
  assert.equal(codeboxSmokeManifest.metadata?.readiness?.crud?.[operation]?.level, 'declared', `DB/API profile ${operation} CRUD boundary must be declared`);
  assert.equal(typeof codeboxSmokeManifest.metadata?.readiness?.crud?.[operation]?.upstream_blocker, 'string', `DB/API profile ${operation} CRUD boundary must declare its upstream blocker`);
}
assert.match(
  codeboxSmokeManifest.metadata?.readiness?.mutation?.safety_boundary || '',
  /read-only until isolated fixture mutation/,
  'DB/API profile mutation readiness must declare the read-only boundary'
);
assert.deepEqual(codeboxSmokeManifest.metadata?.public_codebox_contracts, [
  'wp-codebox/fuzz-suite/v1',
  'wp-codebox/wordpress-workload-run/v1',
  'wp-codebox/fuzz-suite-result/v1',
]);
assert.equal(codeboxSmokeManifest.artifacts.expected[0]?.required, false, 'codebox smoke proof artifact is a placeholder until captured');
assert.equal(codeboxSmokeManifest.artifacts.expected[0]?.proof_placeholder, true, 'codebox smoke expected artifact must be marked as a placeholder');

const codeboxWorkloadRun = readJson(packageRoot, 'bench/codebox-fuzz-suite-smoke.workload.json');
assert.equal(codeboxWorkloadRun.schema, 'wp-codebox/wordpress-workload-run/v1');
assert.equal(codeboxWorkloadRun.runtime_env?.WP_CODEBOX_PUBLIC_CONTRACT_PROOF, 'generated-contract-only');
assert.ok(codeboxWorkloadRun.before.some((step) => step.command === 'wordpress.ensure-plugin-active'), 'codebox workload must activate WooCommerce');
assert.ok(codeboxWorkloadRun.steps.some((step) => step.command === 'wp-codebox/run-fuzz-suite'), 'codebox workload must route through public run-fuzz-suite ability');
assert.equal(codeboxWorkloadRun.artifacts[0]?.metadata?.schema, 'wp-codebox/fuzz-suite-result/v1');
assert.equal(codeboxWorkloadRun.artifacts[0]?.required, false, 'codebox workload proof artifact must remain optional until captured');

const codeboxSuite = readJson(packageRoot, 'manifests/codebox-fuzz-suite-smoke.json');
assert.equal(codeboxSuite.schema, 'wp-codebox/fuzz-suite/v1');
assert.equal(codeboxSuite.target?.kind, 'rest-generated-contract');
assert.equal(codeboxSuite.target?.entrypoint, undefined, 'codebox suite must not pin a hand-picked static REST route');
assert.deepEqual(codeboxSuite.target?.metadata?.required_primitives, [
  'wordpress.inventory-rest-routes',
  'wordpress.generate-rest-request-cases',
  'wordpress.profile-rest-db-queries',
  'wordpress.inventory-database',
  'wordpress.attribute-rest-schema-queries',
  'wordpress.summarize-performance-hotspots',
  'wordpress.coverage-gap-report',
]);
assert.deepEqual(codeboxSuite.target?.metadata?.source_manifests, [
  'fuzz/woocommerce-rest-route-inventory.json',
  'fuzz/generated-rest-request-cases.json',
  'fuzz/rest-db-query-profile.json',
  'fuzz/db-inventory.json',
  'fuzz/rest-schema-query-attribution.json',
  'fuzz/coverage-gap-report.json',
  'fuzz/performance-hotspots-artifact-summary.json',
  'manifests/db-api-performance-fuzzer-gap-report.json',
]);
assert.deepEqual(rig.fuzz_profiles?.['db-api-performance-fuzzer'], dbApiPerformanceFuzzerWorkloadIds, 'DB/API performance fuzzer profile workload ids drifted');
assert.deepEqual(codeboxSuite.target?.metadata?.profile?.workload_ids, dbApiPerformanceFuzzerWorkloadIds, 'Codebox suite DB/API profile workload ids drifted');
assert.equal(codeboxSuite.target?.metadata?.profile?.gap_report_manifest, 'manifests/db-api-performance-fuzzer-gap-report.json', 'Codebox suite must link the standalone DB/API gap report declaration');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.gap_report_manifest, 'manifests/db-api-performance-fuzzer-gap-report.json', 'DB/API profile must link the standalone gap report declaration');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.source_gap_report, 'manifests/full-surface-coverage.json#gap_report', 'DB/API profile must identify the source full-surface gap report');
assert.equal(dbApiPerformanceFuzzerGapReport.schema, 'homeboy-rigs/wordpress-coverage-gap-report-workload/v1', 'DB/API gap report workload schema drifted');
assert.equal(dbApiPerformanceFuzzerGapReport.id, 'woocommerce-db-api-performance-fuzzer-gap-report', 'DB/API gap report workload id drifted');
assert.equal(dbApiPerformanceFuzzerGapReport.profile_id, 'db-api-performance-fuzzer', 'DB/API gap report workload must target the DB/API fuzzer profile');
assert.equal(dbApiPerformanceFuzzerGapReport.source_gap_report, 'manifests/full-surface-coverage.json#gap_report', 'DB/API gap report workload must point at the full-surface gap report source');
assert.equal(dbApiPerformanceFuzzerGapReport.workload, 'fuzz/coverage-gap-report.json', 'DB/API gap report workload must link the executable fuzz workload');
assert.deepEqual(dbApiPerformanceFuzzerGapReport.inputs, dbApiPerformanceFuzzerGapReportInputIds, 'DB/API gap report workload inputs drifted');
assert.equal(dbApiPerformanceFuzzerGapReport.readiness?.level, 'declared', 'DB/API gap report workload readiness must stay declared until upstream binds artifact-postprocess');
assert.equal(dbApiPerformanceFuzzerGapReport.readiness?.execution, 'artifact_aggregation', 'DB/API gap report workload must use artifact aggregation execution');
assert.ok(dbApiPerformanceFuzzerGapReport.readiness?.upstream_blockers?.length > 0, 'DB/API gap report declaration must name upstream blockers');
assert.ok(dbApiPerformanceFuzzerGapReport.readiness.upstream_blockers.some((blocker) => blocker.includes('args.helper')), 'DB/API gap report declaration must list the missing upstream artifact-postprocess fields');
assert.equal(dbApiHotspotArtifactIo.schema, 'homeboy-rigs/woocommerce-db-api-hotspot-artifact-io/v1', 'DB/API hotspot artifact IO schema drifted');
assert.equal(dbApiHotspotArtifactIo.postprocess_command, 'homeboy.artifact-postprocess', 'DB/API hotspot artifact IO must use upstream artifact-postprocess');
assert.equal(dbApiHotspotArtifactIo.readiness?.level, 'declared', 'DB/API hotspot artifact IO must stay declared until artifact-postprocess binding lands');
assert.deepEqual(new Set(dbApiHotspotArtifactIo.expected_inputs.map((input) => input.workload_id)), new Set(dbApiPerformanceFuzzerGapReportInputIds), 'DB/API hotspot artifact IO inputs drifted');
assert.equal(dbApiHotspotArtifactIo.sample_output?.schema, 'homeboy/woocommerce-performance-hotspots-summary/v1', 'DB/API hotspot sample output schema drifted');
assert.equal(dbApiHotspotArtifactIo.sample_output?.threshold_policy, 'relative_ranking_only', 'DB/API hotspot sample output must use relative ranking');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.readiness?.crud?.read?.level, 'executable', 'DB/API rig profile read CRUD boundary must be executable');
for (const operation of ['create', 'update', 'delete']) {
  assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.readiness?.crud?.[operation]?.level, 'declared', `DB/API rig profile ${operation} CRUD boundary must be declared`);
  assert.equal(typeof rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.readiness?.crud?.[operation]?.upstream_blocker, 'string', `DB/API rig profile ${operation} CRUD boundary must declare its upstream blocker`);
}

const productCrudProfileIds = ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-schema-query-attribution', 'coverage-gap-report'];
assert.deepEqual(rig.fuzz_profiles?.['product-rest-crud-fuzzer'], productCrudProfileIds, 'product REST CRUD fuzzer profile workload ids drifted');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.route_family_catalog_manifest, 'manifests/rest-crud-route-family-catalog.json', 'product REST CRUD profile must link the route-family catalog');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.hotspot_artifact_contract_manifest, 'manifests/db-api-hotspot-artifact-io.json', 'product REST CRUD profile must link the hotspot artifact IO contract');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.create?.level, 'executable', 'product REST CRUD create readiness must be executable');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.update?.level, 'executable', 'product REST CRUD update readiness must be executable');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.delete?.level, 'declared', 'product REST CRUD delete readiness must be declared/blocked by upstream');
assert.equal(typeof rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.delete?.upstream_blocker, 'string', 'product REST CRUD delete readiness must name upstream blocker');

const productBatchManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'rest-product-batch-import')?.manifest;
assert.equal(productBatchManifest.metadata?.readiness?.profile, 'product-rest-crud-fuzzer', 'product batch import readiness profile drifted');
assert.equal(productBatchManifest.metadata?.readiness?.level, 'executable', 'product batch import create/update readiness must be executable');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.create?.level, 'executable', 'product batch import create readiness must be executable');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.update?.level, 'executable', 'product batch import update readiness must be executable');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.delete?.level, 'declared', 'product batch import delete readiness must remain declared/blocked');
assert.ok(productBatchManifest.route_families.includes('wc/v3/products/batch'), 'product batch import must list products batch route family');
assert.ok(productBatchManifest.route_families.includes('wc/v3/products/<product_id>/variations/batch'), 'product batch import must list variations batch route family');

assert.equal(restCrudRouteFamilyCatalog.schema, 'homeboy-rigs/woocommerce-rest-crud-route-family-catalog/v1', 'REST CRUD route-family catalog schema drifted');
assert.equal(restCrudRouteFamilyCatalog.owner_profile, 'product-rest-crud-fuzzer', 'REST CRUD route-family catalog owner profile drifted');
assert.ok(restCrudRouteFamilyCatalog.route_families.length >= 4, 'REST CRUD route-family catalog must cover product collection, batch, variations, and attributes/terms');
assert.deepEqual(targetInventory.discovery_manifests?.rest_route_families?.route_family_ids, restCrudRouteFamilyCatalog.route_families.map((family) => family.id), 'target inventory REST route-family discovery ids drifted');
for (const family of restCrudRouteFamilyCatalog.route_families) {
  assert.ok(Array.isArray(family.fixture_requirements) && family.fixture_requirements.length > 0, `${family.id} must declare fixture requirements`);
  assert.ok(Array.isArray(family.owned_by?.workloads) && family.owned_by.workloads.length > 0, `${family.id} must declare owning workloads`);
  for (const workloadId of family.owned_by.workloads) {
    assert.ok(declaredIds.has(workloadId), `${family.id} owner workload ${workloadId} must be declared`);
  }
  assert.ok(family.readiness?.delete, `${family.id} must declare delete readiness`);
}

assert.equal(blockInventoryRenderingFuzz.schema, 'homeboy-rigs/woocommerce-block-inventory-rendering-fuzz/v1', 'block inventory/rendering fuzz schema drifted');
assert.ok(blockInventoryRenderingFuzz.block_name_prefixes.includes('woocommerce/'), 'block inventory/rendering fuzz must target WooCommerce blocks');
assert.ok(blockInventoryRenderingFuzz.frontend_contexts.includes('checkout'), 'block inventory/rendering fuzz must include checkout context');
assert.equal(blockInventoryRenderingFuzz.readiness?.rendering, 'partial_via_frontend_browser_request_coverage', 'block rendering readiness drifted');
assert.deepEqual(targetInventory.targets.blocks.block_name_prefixes, blockInventoryRenderingFuzz.block_name_prefixes, 'target inventory block prefixes must come from block inventory manifest');
assert.deepEqual(targetInventory.targets.blocks.frontend_contexts, blockInventoryRenderingFuzz.frontend_contexts, 'target inventory block contexts must come from block inventory manifest');
assert.deepEqual(targetInventory.discovery_manifests?.blocks?.readiness, blockInventoryRenderingFuzz.readiness, 'target inventory block discovery readiness drifted');
for (const workloadId of blockInventoryRenderingFuzz.owned_by.workloads) {
  assertDeclaredOrExternalDiscoveryWorkload(workloadId, 'block inventory discovery');
}

assert.equal(adminActionInventory.schema, 'homeboy-rigs/woocommerce-admin-action-inventory/v1', 'admin action inventory schema drifted');
assert.ok(adminActionInventory.action_families.some((family) => family.id === 'admin-menu-get-pages' && family.readiness === 'executable_get_only'), 'admin action inventory must include executable GET-only admin menu coverage');
assert.ok(adminActionInventory.skip_reason_codes.includes('payment_submission'), 'admin action inventory must classify payment submission skips');
assert.deepEqual(targetInventory.discovery_manifests?.admin_actions?.action_family_ids, adminActionInventory.action_families.map((family) => family.id), 'target inventory admin action discovery ids drifted');
for (const family of adminActionInventory.action_families) {
  assertDeclaredOrExternalDiscoveryWorkload(family.workload, `admin action ${family.id}`);
}
assert.deepEqual(targetInventory.discovery_manifests?.db_api_hotspots?.readiness, dbApiHotspotArtifactIo.readiness, 'target inventory DB/API hotspot discovery readiness drifted');
assert.equal(targetInventory.targets.performance_hotspots.artifact_io_manifest, 'manifests/db-api-hotspot-artifact-io.json', 'target inventory must link DB/API hotspot artifact IO manifest');
assert.equal(codeboxSuite.cases?.[0]?.input?.generated_from?.route_inventory_artifact, 'route_inventory');
assert.equal(codeboxSuite.cases?.[0]?.input?.generated_from?.request_cases_artifact, 'rest_request_cases');
assert.equal(codeboxSuite.cases?.[0]?.input?.generated_from?.query_attribution_artifact, 'rest_schema_query_attribution');
assert.equal(codeboxSuite.cases?.[0]?.metadata?.proof_status, 'contract_only_placeholder');
assert.equal(codeboxSuite.metadata?.readiness_level, 'declared');

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
