#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertArtifactPostprocessWorkloadContract,
  assertExecutableCrudMutationSafety,
  assertFullSurfaceCoverageManifest,
  assertFuzzProofBundleRequirements,
  assertFuzzReadinessLevel,
  assertGenericFuzzManifest,
  assertReviewerFacingFuzzRef,
  collectFuzzManifests,
  declaredBenchProfileIds,
  declaredBenchWorkloadIds,
  declaredFuzzIds,
  fullSurfaceRequiredArtifactIds,
  fuzzManifestHasExecutableArtifactContract,
  readJson,
} from '../../../scripts/fuzz-manifest-helpers.mjs';
import { assertWooRequiredFuzzProofContracts } from './fuzz-proof-contracts.mjs';
import {
  wooProductSurfaceIds,
  wooProductSurfaceTaxonomy,
  wooRelativeHotspotLabels,
  wooSequencePackSurfaceIds,
  wooSurfaceReadinessStates,
} from './woo-surface-taxonomy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const rig = readJson(packageRoot, 'rigs/woocommerce-performance/rig.json');
const coverageManifest = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const dbApiFuzzCampaign = readJson(packageRoot, 'manifests/db-api-fuzz-campaign.json');
const dbApiPerformanceFuzzerGapReport = readJson(packageRoot, 'manifests/db-api-performance-fuzzer-gap-report.json');
const restCrudRouteFamilyCatalog = readJson(packageRoot, 'manifests/rest-crud-route-family-catalog.json');
const restCrudPayloadFixtures = readJson(packageRoot, 'manifests/rest-crud-payload-fixtures.json');
const restCrudFixturePlan = readJson(packageRoot, 'manifests/rest-crud-fixture-plan.json');
const restCrudFixtureOptIns = readJson(packageRoot, 'manifests/rest-crud-fixture-opt-ins.json');
const dbApiHotspotArtifactIo = readJson(packageRoot, 'manifests/db-api-hotspot-artifact-io.json');
const aggressiveIsolatedFuzzCampaign = readJson(packageRoot, 'manifests/aggressive-isolated-fuzz-campaign.json');
const blockInventoryRenderingFuzz = readJson(packageRoot, 'manifests/block-inventory-rendering-fuzz.json');
const adminActionInventory = readJson(packageRoot, 'manifests/admin-action-inventory.json');
const productChaosSequencePacks = readJson(packageRoot, 'manifests/product-chaos-sequence-packs.json');
const targetInventory = readJson(packageRoot, 'manifests/target-inventory.json');
const stableWorkloads = readJson(packageRoot, 'manifests/stable-workloads.json');
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
  'codebox-fuzz-suite-contract',
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
  'codebox-fuzz-suite-contract',
  'woocommerce-rest-route-inventory',
  'generated-rest-request-cases',
  'rest-db-query-profile',
  'db-inventory',
  'rest-schema-query-attribution',
  'coverage-gap-report',
  'performance-hotspots-artifact-summary',
];
const dbApiPerformanceFuzzerProfileWorkloadIds = dbApiPerformanceFuzzerWorkloadIds.filter((workloadId) => workloadId !== 'codebox-fuzz-suite-contract');
const dbApiPerformanceFuzzerGapReportInputIds = dbApiPerformanceFuzzerProfileWorkloadIds.filter((workloadId) => workloadId !== 'coverage-gap-report');
const externalDiscoveryWorkloadIds = new Set([
  'woocommerce-browser-coverage',
]);

function assertProfileReadiness(readiness, context) {
  assert.ok(readiness && typeof readiness === 'object' && !Array.isArray(readiness), `${context} requires readiness metadata`);
  assertFuzzReadinessLevel(readiness.level, `${context}.level`);
  assert.equal(typeof readiness.coverage_contract, 'string', `${context}.coverage_contract must describe the contract`);
  assert.notEqual(readiness.coverage_contract.trim(), '', `${context}.coverage_contract must not be empty`);
  if (readiness.proof_bundle_requirements !== undefined) {
    assertFuzzProofBundleRequirements(readiness.proof_bundle_requirements, { file: context });
  }
  if (readiness.crud !== undefined) {
    assertExecutableCrudMutationSafety(readiness, { file: context });
  }
}

function assertDeclaredOrExternalDiscoveryWorkload(workloadId, context) {
  assert.ok(
    declaredIds.has(workloadId) || externalDiscoveryWorkloadIds.has(workloadId),
    `${context} references unknown workload ${workloadId}`
  );
}

function assertStableWorkloadContracts(manifest) {
  assert.equal(manifest.schema, 'homeboy-rigs/woocommerce-stable-workloads/v1', 'stable workloads schema drifted');
  assert.equal(manifest.profile_id, 'woo-profiling-stabilization', 'stable workloads profile id drifted');
  assert.equal(manifest.rig, 'rigs/woocommerce-performance/rig.json', 'stable workloads rig ref drifted');
  assert.equal(manifest.lab_command_generator, 'tools/stable-workload-lab-commands.mjs', 'stable workloads Lab command generator drifted');
  assert.deepEqual(manifest.comparison_commands, ['homeboy runs refs', 'homeboy runs compare', 'homeboy runs hotspots'], 'stable workload comparison command surface drifted');

  const expectedIds = new Set([
    'rest-db-query-profile',
    'store-api-product-browse',
    'cart-and-checkout',
    'admin-orders',
    'product-search-filtering',
  ]);
  const contracts = new Map((manifest.contracts || []).map((contract) => [contract.id, contract]));
  assert.deepEqual(new Set(contracts.keys()), expectedIds, 'stable workload ids drifted');

  for (const [contractId, contract] of contracts) {
    assert.equal(contract.readiness, 'executable', `${contractId} stable workload must be executable`);
    assert.ok(Array.isArray(contract.entry_workloads) && contract.entry_workloads.length > 0, `${contractId} requires entry workloads`);
    for (const workloadId of contract.entry_workloads) {
      assert.ok(declaredIds.has(workloadId), `${contractId} entry workload ${workloadId} must be declared in fuzz_workloads.wordpress`);
    }
    assert.ok(Array.isArray(contract.observed_surfaces) && contract.observed_surfaces.length > 0, `${contractId} requires observed surfaces`);

    const observations = contract.expected_observations;
    assert.ok(observations && typeof observations === 'object' && !Array.isArray(observations), `${contractId} requires expected observations`);
    assert.ok(Array.isArray(observations.required_artifacts) && observations.required_artifacts.length > 0, `${contractId} requires artifact observations`);
    assert.ok(Object.entries(observations).some(([, value]) => typeof value === 'number' && value > 0), `${contractId} requires at least one positive observation floor`);

    const budgets = contract.budgets;
    assert.ok(budgets && typeof budgets === 'object' && !Array.isArray(budgets), `${contractId} requires budgets`);
    assert.ok(Object.entries(budgets).some(([, value]) => typeof value === 'number' && value >= 0), `${contractId} requires numeric budgets`);
    assert.ok(Object.values(budgets).some((value) => value === 0), `${contractId} must include at least one zero-useful-work guardrail budget`);
  }

  assert.deepEqual(contracts.get('rest-db-query-profile').entry_workloads, ['generated-rest-request-cases', 'rest-db-query-profile'], 'REST DB profile stable workload entry drifted');
  assert.deepEqual(contracts.get('cart-and-checkout').browser_scenarios, ['cart', 'checkout'], 'cart-and-checkout scenario contract drifted');
  assert.deepEqual(contracts.get('admin-orders').browser_scenarios, ['orders_admin'], 'admin-orders scenario contract drifted');
}

function assertCampaignPostprocessOutput(workload, output, context) {
  assert.ok(output && typeof output === 'object' && !Array.isArray(output), `${context} requires postprocess output metadata`);
  assert.equal(output.workload, workload.id, `${context} workload id drifted`);

  const args = workload.steps?.[0]?.args;
  assert.equal(output.helper, args?.helper, `${context} helper must match workload args`);
  assert.equal(output.action, args?.action, `${context} action must match workload args`);
  assert.deepEqual(output.input, args?.input, `${context} input must match workload args`);
  assert.deepEqual(output.output, args?.output, `${context} output must match workload args`);
  assert.deepEqual(output.parameters, args?.parameters, `${context} parameters must match workload args`);
  assert.equal(typeof output.artifact_ref_requirement, 'string', `${context} requires artifact_ref_requirement`);
  assert.notEqual(output.artifact_ref_requirement.trim(), '', `${context} artifact_ref_requirement must not be empty`);
}

function assertNoLocalOnlyRefs(value, context = 'value') {
  if (typeof value === 'string') {
    assert.ok(!/^(https?:\/\/)?(localhost|127\.0\.0\.1)([:/]|$)/.test(value), `${context} must not use local URLs`);
    assert.ok(!value.startsWith('/Users/'), `${context} must not use local filesystem paths`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoLocalOnlyRefs(entry, `${context}[${index}]`));
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertNoLocalOnlyRefs(entry, `${context}.${key}`);
    }
  }
}

function assertNoProofPlaceholders(value, context = 'value') {
  if (typeof value === 'string') {
    assert.ok(!value.includes('contract_only_placeholder'), `${context} must not use contract_only_placeholder proof language`);
    assert.ok(!/^<[^>]+>$/.test(value.trim()), `${context} must not use placeholder proof refs`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProofPlaceholders(entry, `${context}[${index}]`));
    return;
  }

  if (value && typeof value === 'object') {
    assert.equal(value.proof_placeholder, undefined, `${context} must use artifact_expected_after_run or declared_contract instead of proof_placeholder`);
    for (const [key, entry] of Object.entries(value)) {
      assertNoProofPlaceholders(entry, `${context}.${key}`);
    }
  }
}

function assertDeclaredExpectedArtifactMarker(artifact, context) {
  assert.equal(artifact?.required, false, `${context} declared artifact must remain optional until captured`);
  assert.equal(artifact?.artifact_expected_after_run, true, `${context} must honestly mark artifact_expected_after_run`);
  assert.equal(artifact?.proof_placeholder, undefined, `${context} must not use proof_placeholder`);
}

function assertNoHardThresholdClaims(value, context = 'value') {
  if (typeof value === 'string') {
    assert.ok(!/\b(p\d+|percentile|threshold|maximum|minimum|max|min|must be (?:under|over|below|above)|no more than|at least)\b/i.test(value), `${context} must not declare hard thresholds`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoHardThresholdClaims(entry, `${context}[${index}]`));
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertNoHardThresholdClaims(entry, `${context}.${key}`);
    }
  }
}

function assertDeclaredOnlyNoProof(container, context) {
  assert.equal(container.status, 'declared_contract', `${context} status must stay declared_contract`);
  assert.equal(container.execution_enabled, false, `${context} must not enable execution`);
  assert.equal(container.runner_behavior, 'none', `${context} must not implement runner behavior`);
  assert.equal(container.readiness?.level, 'declared', `${context} readiness must stay declared`);
  assert.equal(container.readiness?.execution_enabled, false, `${context} readiness must not enable execution`);
  assert.equal(container.readiness?.proof_status, 'declared_contract', `${context} proof status must stay declared`);
  assert.equal(container.readiness?.proof_bundle, undefined, `${context} declared readiness must not carry proof refs`);
  assertFuzzProofBundleRequirements(container.readiness?.proof_bundle_requirements, { file: `${context} readiness` });
  assertNoLocalOnlyRefs(container, context);
  assertNoProofPlaceholders(container, context);
  assertNoHardThresholdClaims(container, context);
}

function assertExecutableReadinessNeedsProofRequirements(readiness, context) {
  assertProfileReadiness(readiness, context);
  if (readiness.level === 'executable') {
    assertFuzzProofBundleRequirements(readiness.proof_bundle_requirements, { file: `${context}.proof_bundle_requirements` });
    assert.equal(readiness.proof_bundle, undefined, `${context} executable readiness must not include proof_bundle before reviewer-facing refs exist`);
  }
}

function assertDbApiCampaignPromotionContract(campaign) {
  const requiredArtifacts = ['codebox_fuzz_suite_result', 'wordpress_hotspots', 'homeboy_fuzz_coverage', 'homeboy_hotspot_summary', 'coverage_gap_report'];
  const requiredSchemas = new Map(campaign.required_upstream_artifact_refs.map((artifact) => [artifact.id, artifact.schema]));
  assert.deepEqual(new Set(requiredSchemas.keys()), new Set(requiredArtifacts), 'DB/API campaign required artifact ids drifted');
  assert.deepEqual(new Set(campaign.readiness?.proof_bundle_requirements?.required_artifacts || []), new Set(requiredArtifacts), 'DB/API campaign proof bundle required artifacts must match required upstream artifact refs');
  assert.equal(campaign.readiness?.proof_bundle_requirements?.local_only_refs_allowed, false, 'DB/API campaign proof refs must reject local-only refs');
  assert.equal(campaign.readiness?.proof_bundle_requirements?.placeholder_refs_allowed, false, 'DB/API campaign proof refs must reject placeholders');

  const promotion = campaign.readiness?.promotion_to_proven;
  assert.ok(promotion && typeof promotion === 'object' && !Array.isArray(promotion), 'DB/API campaign requires promotion_to_proven contract');
  assert.equal(promotion.local_only_refs_allowed, false, 'DB/API promotion must reject local-only refs');
  assert.equal(promotion.placeholder_refs_allowed, false, 'DB/API promotion must reject placeholder refs');
  assert.equal(promotion.ref_field, 'readiness.proof_bundle.required_artifact_refs', 'DB/API promotion ref field drifted');
  assert.ok(Array.isArray(promotion.accepted_ref_schemes) && promotion.accepted_ref_schemes.length > 0, 'DB/API promotion requires accepted ref schemes');
  assert.deepEqual(new Set((promotion.required_artifact_refs || []).map((artifact) => artifact.id)), new Set(requiredArtifacts), 'DB/API promotion required artifact refs drifted');
  for (const artifact of promotion.required_artifact_refs || []) {
    assert.equal(artifact.schema, requiredSchemas.get(artifact.id), `DB/API promotion artifact ${artifact.id} schema drifted`);
    assert.equal(typeof artifact.semantic_key, 'string', `DB/API promotion artifact ${artifact.id} requires semantic_key`);
  }

  if (campaign.readiness?.level === 'proven') {
    const proofRefs = campaign.readiness?.proof_bundle?.required_artifact_refs;
    assert.ok(proofRefs && typeof proofRefs === 'object' && !Array.isArray(proofRefs), 'DB/API proven campaign requires readiness.proof_bundle.required_artifact_refs');
    for (const artifactId of requiredArtifacts) {
      assertReviewerFacingFuzzRef(proofRefs[artifactId], `DB/API campaign proof ref ${artifactId}`);
    }
  } else {
    assert.equal(campaign.readiness?.proof_bundle, undefined, 'DB/API declared campaign must not carry a proof_bundle');
  }
}

function assertRestCrudFixtureContractRefs(container, context, expectedFamilies = ['products', 'orders', 'customers', 'coupons']) {
  const fixtureContracts = container?.fixture_contracts;
  assert.ok(fixtureContracts && typeof fixtureContracts === 'object' && !Array.isArray(fixtureContracts), `${context} requires fixture_contracts metadata`);
  assert.equal(fixtureContracts.readiness_level, 'declared', `${context} fixture contracts must remain declared`);
  assert.equal(fixtureContracts.execution_enabled, false, `${context} fixture contracts must not enable execution`);
  assert.equal(fixtureContracts.proof_status, 'declared_contract', `${context} fixture contracts must not claim proof`);
  assert.equal(fixtureContracts.handoff_path, 'Rigs manifests -> HBEX opt-in ingestion -> Codebox mutation runner -> Homeboy artifacts', `${context} fixture handoff path drifted`);
  assert.deepEqual(new Set(fixtureContracts.operation_ready_ref_families || []), new Set(expectedFamilies), `${context} fixture operation-ready families drifted`);

  const artifacts = new Map((fixtureContracts.artifacts || []).map((artifact) => [artifact.id, artifact]));
  assert.deepEqual(new Set(artifacts.keys()), new Set(['rest_crud_fixture_plan', 'rest_crud_fixture_opt_ins']), `${context} fixture artifacts drifted`);
  assert.deepEqual(artifacts.get('rest_crud_fixture_plan'), {
    id: 'rest_crud_fixture_plan',
    schema: 'wp-codebox/fuzz-fixture-plan/v1',
    path: 'manifests/rest-crud-fixture-plan.json',
    semantic_key: 'fixture.plan',
    readiness: 'declared_contract',
  }, `${context} fixture plan ref drifted`);
  assert.deepEqual(artifacts.get('rest_crud_fixture_opt_ins'), {
    id: 'rest_crud_fixture_opt_ins',
    schema: 'wp-codebox/rest-mutation-fixture-opt-in/v1',
    path: 'manifests/rest-crud-fixture-opt-ins.json',
    semantic_key: 'fixture.opt_ins',
    readiness: 'declared_contract',
  }, `${context} fixture opt-in ref drifted`);

  if (fixtureContracts.readiness_level === 'proven' || fixtureContracts.execution_enabled === true) {
    const proofRefs = fixtureContracts.proof_bundle?.required_artifact_refs;
    assert.ok(proofRefs && typeof proofRefs === 'object' && !Array.isArray(proofRefs), `${context} executable/proven fixture contracts require durable artifact refs`);
    assertReviewerFacingFuzzRef(proofRefs.rest_crud_fixture_plan, `${context} fixture plan proof ref`);
    assertReviewerFacingFuzzRef(proofRefs.rest_crud_fixture_opt_ins, `${context} fixture opt-ins proof ref`);
  } else {
    assert.equal(fixtureContracts.proof_bundle, undefined, `${context} declared fixture contracts must not carry a proof_bundle`);
  }
}

function hasDeleteBoundaryContractRefs(container) {
  const refs = [
    ...(container?.generic_upstream_contracts || []),
    ...(container?.mutation?.rollback_artifact_schemas || []),
    ...(container?.rollback_artifact_schemas || []),
    ...(container?.delete_boundary_rollback_artifacts || []),
    container?.delete_boundary_artifact_schema,
    container?.rollback_contract_schema,
  ].filter(Boolean);
  return refs.includes('homeboy/wordpress-rest-mutation-rollback-contract/v1') && refs.includes('wp-codebox/delete-boundary-artifact/v1');
}

function assertRestCrudFixturePlanContract(fixturePlan, payloadFixtures) {
  assert.equal(fixturePlan.schema, 'wp-codebox/fuzz-fixture-plan/v1', 'REST CRUD fixture plan must use the WP Codebox generic fixture-plan schema');
  assert.equal(fixturePlan.id, 'woocommerce-rest-crud-fixture-plan', 'REST CRUD fixture plan id drifted');
  assert.deepEqual(fixturePlan.operationKinds, ['mutation'], 'REST CRUD fixture plan must only declare mutation operations');
  assert.equal(fixturePlan.metadata?.source_manifest, 'manifests/rest-crud-payload-fixtures.json', 'REST CRUD fixture plan source manifest drifted');
  assert.equal(fixturePlan.metadata?.readiness_level, 'declared', 'REST CRUD fixture plan must stay declared');
  assert.equal(fixturePlan.metadata?.execution_enabled, false, 'REST CRUD fixture plan must not enable execution');
  assert.equal(fixturePlan.metadata?.proof_status, 'declared_contract', 'REST CRUD fixture plan must not claim proof');
  assert.deepEqual(new Set((fixturePlan.metadata?.operation_ready_refs || []).map((family) => family.family_id)), new Set(['products', 'orders', 'customers', 'coupons']), 'REST CRUD fixture plan operation-ready refs must cover product/order/customer/coupon');

  const expectedOperationIds = new Set(payloadFixtures.families.flatMap((family) => ['create', 'update', 'delete'].map((operation) => `${family.id}-${operation}`)));
  assert.deepEqual(new Set(fixturePlan.operations.map((operation) => operation.id)), expectedOperationIds, 'REST CRUD fixture plan operations must mirror payload fixture families');

  for (const familyRefs of fixturePlan.metadata?.operation_ready_refs || []) {
    assert.equal(familyRefs.readiness_level, 'declared', `${familyRefs.family_id} operation-ready refs must stay declared`);
    assert.equal(familyRefs.execution_enabled, false, `${familyRefs.family_id} operation-ready refs must not enable execution`);
    assert.equal(familyRefs.proof_status, 'declared_contract', `${familyRefs.family_id} operation-ready refs must not claim proof`);
    assert.equal(familyRefs.fixture_plan_schema, 'wp-codebox/fuzz-fixture-plan/v1', `${familyRefs.family_id} operation-ready fixture plan schema drifted`);
    assert.equal(familyRefs.opt_in_schema, 'wp-codebox/rest-mutation-fixture-opt-in/v1', `${familyRefs.family_id} operation-ready opt-in schema drifted`);
    assert.deepEqual(new Set((familyRefs.operation_refs || []).map((ref) => ref.operation)), new Set(['create', 'update', 'delete']), `${familyRefs.family_id} operation-ready operation refs drifted`);
    for (const ref of familyRefs.operation_refs || []) {
      assert.equal(ref.fixture_plan_ref, `manifests/rest-crud-fixture-plan.json#operations/${familyRefs.family_id}-${ref.operation}`, `${familyRefs.family_id} ${ref.operation} fixture plan operation ref drifted`);
      assert.equal(ref.opt_in_manifest_ref, 'manifests/rest-crud-fixture-opt-ins.json', `${familyRefs.family_id} ${ref.operation} opt-in manifest ref drifted`);
      assert.equal(ref.execute, false, `${familyRefs.family_id} ${ref.operation} operation-ready ref must not execute`);
    }
  }

  for (const operation of fixturePlan.operations) {
    assert.equal(operation.kind, 'mutation', `${operation.id} must use mutation operation kind`);
    assert.ok(['POST', 'PUT', 'DELETE'].includes(operation.method), `${operation.id} method drifted`);
    assert.equal(operation.expected?.readiness_level, 'declared', `${operation.id} must remain declared`);
    assert.equal(operation.expected?.execute, false, `${operation.id} must not execute`);
    assert.equal(operation.metadata?.proof_status, 'declared_contract', `${operation.id} must not claim proof`);
    assert.equal(operation.metadata?.rollback_required, true, `${operation.id} must require rollback before execution`);
    if (operation.metadata?.operation === 'delete') {
      assert.equal(operation.metadata?.delete_boundary_required, true, `${operation.id} delete must require delete-boundary artifacts`);
      assert.match(operation.expected?.blocked_until || '', /delete-boundary/, `${operation.id} delete blocker must name delete-boundary artifacts`);
    } else {
      assert.equal(operation.metadata?.delete_boundary_required, false, `${operation.id} create/update must not claim delete-boundary readiness`);
      assert.match(operation.expected?.blocked_until || '', /generic REST mutation runner|rollback|isolation/, `${operation.id} create/update blocker must name runner and rollback/isolation readiness`);
    }
  }
}

function assertRestMutationFixtureOptInsContract(optIns, payloadFixtures, routeCatalog) {
  assert.equal(optIns.schema, 'homeboy-rigs/woocommerce-rest-mutation-fixture-opt-ins/v1', 'REST mutation fixture opt-ins wrapper schema drifted');
  assert.equal(optIns.fixturePlanRef, payloadFixtures.fixture_plan_manifest, 'REST mutation opt-ins fixturePlanRef drifted');
  assert.equal(optIns.metadata?.readiness_level, 'declared', 'REST mutation opt-ins must stay declared');
  assert.equal(optIns.metadata?.execution_enabled, false, 'REST mutation opt-ins must not enable execution');
  assert.equal(optIns.metadata?.proof_status, 'declared_contract', 'REST mutation opt-ins must not claim proof');
  assert.equal(optIns.metadata?.fixture_plan_schema, 'wp-codebox/fuzz-fixture-plan/v1', 'REST mutation opt-ins fixture plan schema drifted');
  assert.equal(optIns.metadata?.opt_in_schema, 'wp-codebox/rest-mutation-fixture-opt-in/v1', 'REST mutation opt-ins schema metadata drifted');

  const routeFamilies = new Map(routeCatalog.route_families.map((family) => [family.id, family]));
  const expectedRoutes = new Set(payloadFixtures.families.flatMap((family) => family.route_family_ids.flatMap((routeFamilyId) => routeFamilies.get(routeFamilyId)?.routes || [])));
  assert.deepEqual(new Set(optIns.optIns.map((optIn) => optIn.route)), expectedRoutes, 'REST mutation opt-ins must cover every payload fixture route');

  for (const optIn of optIns.optIns) {
    assert.equal(optIn.schema, 'wp-codebox/rest-mutation-fixture-opt-in/v1', `${optIn.id} must use the WP Codebox REST mutation opt-in schema`);
    assert.deepEqual(optIn.methods, ['POST', 'PUT', 'PATCH', 'DELETE'], `${optIn.id} mutation methods drifted`);
    assert.equal(optIn.fixturePlanRef, payloadFixtures.fixture_plan_manifest, `${optIn.id} fixturePlanRef drifted`);
    assert.equal(optIn.metadata?.readiness_level, 'declared', `${optIn.id} must remain declared`);
    assert.equal(optIn.metadata?.execution_enabled, false, `${optIn.id} must not enable execution`);
    assert.equal(optIn.metadata?.proof_status, 'declared_contract', `${optIn.id} must not claim proof`);
    assert.match(optIn.metadata?.blocker || '', /rollback\/isolation artifacts.*delete-boundary artifacts/, `${optIn.id} blocker must name rollback/isolation and delete-boundary requirements`);
  }
}

assertArtifactPostprocessWorkloadContract(coverageGapReportWorkload, {
  id: 'coverage-gap-report',
  action: 'coverage-gap-report',
  artifact: 'coverage_gap_report',
  outputPath: 'coverage-gap-report/coverage_gap_report.json',
  schema: 'homeboy-rigs/wordpress-coverage-gap-report/v1',
});

assertArtifactPostprocessWorkloadContract(performanceHotspotsWorkload, {
  id: 'performance-hotspots-artifact-summary',
  action: 'performance-hotspots-summary',
  artifact: 'performance_hotspots_summary',
  outputPath: 'performance-hotspots-artifact-summary/performance_hotspots_summary.json',
  schema: 'homeboy/woocommerce-performance-hotspots-summary/v1',
});

for (const workloadId of fullSurfaceFuzzIds) {
  assert.ok(declaredIds.has(workloadId), `${workloadId} full-surface coverage is not backed by a fuzz workload`);
}

const generatedTargetInventory = JSON.parse(execFileSync(process.execPath, [
  path.join(packageRoot, 'tools/generate-target-inventory.mjs'),
], { encoding: 'utf8' }));
const generatedRestCrudFixturePlan = JSON.parse(execFileSync(process.execPath, [
  path.join(packageRoot, 'tools/generate-rest-crud-fixture-contracts.mjs'),
  '--artifact=fixture-plan',
], { encoding: 'utf8' }));
const generatedRestCrudFixtureOptIns = JSON.parse(execFileSync(process.execPath, [
  path.join(packageRoot, 'tools/generate-rest-crud-fixture-contracts.mjs'),
  '--artifact=opt-ins',
], { encoding: 'utf8' }));
const generatedAggressiveFirehoseCommandPlan = JSON.parse(execFileSync(process.execPath, [
  path.join(packageRoot, 'tools/aggressive-firehose-command-plan.mjs'),
  '--json',
  '--run-id-prefix',
  'woo-firehose-validator',
  '--tracker-ref',
  'issue:validator',
], { encoding: 'utf8' }));
const generatedAggressiveFirehoseTextPlan = execFileSync(process.execPath, [
  path.join(packageRoot, 'tools/aggressive-firehose-command-plan.mjs'),
  '--run-id-prefix',
  'woo-firehose-validator',
  '--tracker-ref',
  'issue:validator',
], { encoding: 'utf8' });
const generatedAggressiveFirehosePlanOnly = JSON.parse(execFileSync(process.execPath, [
  path.join(packageRoot, 'tools/aggressive-firehose-command-plan.mjs'),
  '--json',
  '--plan-only',
  '--run-id-prefix',
  'woo-firehose-validator',
  '--tracker-ref',
  'issue:validator',
], { encoding: 'utf8' }));

assert.deepEqual(targetInventory, generatedTargetInventory, 'WooCommerce target inventory artifact must match the generator output');
assert.deepEqual(restCrudFixturePlan, generatedRestCrudFixturePlan, 'WooCommerce REST CRUD fixture-plan artifact must match the generator output');
assert.deepEqual(restCrudFixtureOptIns, generatedRestCrudFixtureOptIns, 'WooCommerce REST mutation opt-in artifact must match the generator output');
assert.equal(coverageManifest.target_inventory_manifest, 'manifests/target-inventory.json', 'full-surface coverage must point at the target inventory manifest');
assert.equal(targetInventory.schema, 'homeboy-rigs/wordpress-target-inventory/v1', 'target inventory schema drifted');
assert.equal(targetInventory.runtime?.runner, 'wp-codebox', 'target inventory must run through WP Codebox');
assert.equal(targetInventory.runtime?.activation, 'woocommerce/woocommerce.php', 'target inventory must activate WooCommerce');
assert.deepEqual(new Set(targetInventory.declared_fuzz_workloads), expectedFuzzIds, 'target inventory declared fuzz workloads drifted');
assert.deepEqual(targetInventory.source_manifests, {
  full_surface: 'manifests/full-surface-coverage.json',
  rig: 'rigs/woocommerce-performance/rig.json',
  rest_crud_route_family_catalog: 'manifests/rest-crud-route-family-catalog.json',
  rest_crud_payload_fixtures: 'manifests/rest-crud-payload-fixtures.json',
  rest_crud_fixture_plan: 'manifests/rest-crud-fixture-plan.json',
  rest_crud_fixture_opt_ins: 'manifests/rest-crud-fixture-opt-ins.json',
  block_inventory_rendering_fuzz: 'manifests/block-inventory-rendering-fuzz.json',
  admin_action_inventory: 'manifests/admin-action-inventory.json',
  db_api_hotspot_artifact_io: 'manifests/db-api-hotspot-artifact-io.json',
  product_chaos_sequence_packs: 'manifests/product-chaos-sequence-packs.json',
  aggressive_isolated_fuzz_campaign: 'manifests/aggressive-isolated-fuzz-campaign.json',
}, 'target inventory source manifests drifted');
assert.deepEqual(targetInventory.discovery_manifests?.product_surface_taxonomy?.readiness_states, wooSurfaceReadinessStates, 'product surface taxonomy readiness states drifted');
assert.match(targetInventory.discovery_manifests?.product_surface_taxonomy?.provenance || '', /product-level seasoning only/, 'product surface taxonomy must document product-level seasoning boundary');

const productSurfaceTaxonomy = targetInventory.discovery_manifests?.product_surface_taxonomy?.surfaces || {};
assert.deepEqual(productSurfaceTaxonomy, wooProductSurfaceTaxonomy, 'target inventory product surface taxonomy must come from the canonical Woo taxonomy module');
assert.deepEqual(new Set(Object.keys(productSurfaceTaxonomy)), new Set(wooProductSurfaceIds), 'product surface taxonomy must cover Woo aggressive campaign surfaces');

for (const [surface, contract] of Object.entries(productSurfaceTaxonomy)) {
  assert.ok(wooSurfaceReadinessStates.includes(contract.readiness), `${surface} readiness must be an operation-scoped readiness state`);
  assert.ok(contract.operation_readiness && typeof contract.operation_readiness === 'object' && !Array.isArray(contract.operation_readiness), `${surface} requires operation_readiness`);
  for (const [operation, readiness] of Object.entries(contract.operation_readiness)) {
    assert.ok(wooSurfaceReadinessStates.includes(readiness), `${surface}.${operation} readiness must be operation-scoped`);
  }
  assert.equal(typeof contract.owner_profile, 'string', `${surface} requires owner_profile`);
  assert.ok(Array.isArray(contract.workloads) && contract.workloads.length > 0, `${surface} requires owning workloads`);
  assert.ok(Array.isArray(contract.notes) && contract.notes.length > 0, `${surface} requires reviewer-readable notes`);
  for (const workloadId of contract.workloads) {
    assert.ok(declaredIds.has(workloadId), `${surface} taxonomy workload ${workloadId} must be declared in fuzz_workloads.wordpress`);
  }
  if (Object.values(contract.operation_readiness).some((readiness) => readiness.startsWith('declared_') || readiness.startsWith('blocked_'))) {
    assert.ok(Array.isArray(contract.blocked_by) && contract.blocked_by.length > 0, `${surface} non-executable taxonomy rows must point at upstream blockers`);
    assert.ok(contract.blocked_by.some((blocker) => /wordpress\.|wp-codebox\//.test(blocker)), `${surface} blockers must point at generic upstream primitives`);
  }
}

assert.equal(productSurfaceTaxonomy.settings.sensitive_policy.includes('credential-bearing'), true, 'settings taxonomy must declare sensitive policy boundaries');
assert.ok(productSurfaceTaxonomy.store_api.namespaces.includes('wc/store/v1'), 'Store API taxonomy must include wc/store/v1');
assert.ok(productSurfaceTaxonomy.rest_api.namespaces.includes('wc/v3'), 'REST API taxonomy must include wc/v3');
assert.ok(productSurfaceTaxonomy.reports_admin_pages.workloads.includes('admin-page-coverage'), 'reports/admin pages taxonomy must link admin page coverage');
assert.deepEqual(rig.fuzz_profile_metadata?.['full-surface']?.discovery_manifests, {
  rest_route_families: 'manifests/rest-crud-route-family-catalog.json',
  rest_payload_fixtures: 'manifests/rest-crud-payload-fixtures.json',
  product_chaos_sequence_packs: 'manifests/product-chaos-sequence-packs.json',
  blocks: 'manifests/block-inventory-rendering-fuzz.json',
  admin_actions: 'manifests/admin-action-inventory.json',
  db_api_hotspots: 'manifests/db-api-hotspot-artifact-io.json',
}, 'full-surface profile discovery manifests drifted');
assertProfileReadiness(rig.fuzz_profile_metadata?.['full-surface']?.readiness, 'fuzz_profile_metadata.full-surface.readiness');
assert.equal(rig.fuzz_profile_metadata?.['full-surface']?.readiness?.level, 'declared', 'full-surface discovery manifests must stay declared');

function assertAggressiveIsolatedCampaignContract(campaign) {
  assert.equal(campaign.schema, 'homeboy-rigs/woocommerce-aggressive-isolated-fuzz-campaign/v1', 'aggressive campaign schema drifted');
  assert.equal(campaign.id, 'woocommerce-aggressive-isolated-fuzz-campaign', 'aggressive campaign id drifted');
  assert.equal(campaign.profile_id, 'aggressive-isolated-firehose', 'aggressive campaign profile id drifted');
  assert.equal(campaign.target_inventory_manifest, 'manifests/target-inventory.json', 'aggressive campaign target inventory ref drifted');
  assert.equal(campaign.product_surface_taxonomy_ref, 'manifests/target-inventory.json#discovery_manifests/product_surface_taxonomy', 'aggressive campaign product taxonomy ref drifted');
  assert.equal(campaign.command_plan_generator, 'tools/aggressive-firehose-command-plan.mjs', 'aggressive campaign command generator drifted');
  assert.ok(Array.isArray(rig.fuzz_profiles?.[campaign.profile_id]) && rig.fuzz_profiles[campaign.profile_id].length > 0, 'aggressive firehose must be wired as a runnable fuzz profile');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.campaign_manifest, 'manifests/aggressive-isolated-fuzz-campaign.json', 'aggressive profile metadata must link the campaign manifest');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.command_plan_generator, 'tools/aggressive-firehose-command-plan.mjs', 'aggressive profile metadata must link the command generator');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.homeboy_fuzz_profile, campaign.profile_id, 'aggressive profile metadata Homeboy profile drifted');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.hbex_fuzz_profile, campaign.profile_id, 'aggressive profile metadata HBEX profile drifted');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.codebox_fuzz_profile, 'woocommerce-aggressive-isolated-firehose', 'aggressive profile metadata Codebox profile drifted');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.readiness?.level, 'executable', 'aggressive profile metadata must be executable');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.readiness?.execution_enabled, true, 'aggressive profile metadata must enable offloaded execution');
  assert.equal(rig.fuzz_profile_metadata?.[campaign.profile_id]?.readiness?.local_execution_enabled, false, 'aggressive profile metadata must not enable local execution');

  const requiredContracts = new Set([
    'homeboy/destructive-isolated-mode/v1',
    'homeboy/fuzz-execution-request-artifact/v1',
    'homeboy/fuzz-coverage-reconciliation/v1',
    'wp-codebox/destructive-fuzz-suite-metadata/v1',
    'wp-codebox/snapshot-restore-artifact/v1',
    'wordpress.rest-payload-families/v1',
    'homeboy/chaos-sequence-generator/v1',
    'homeboy/fuzz-payload-size-depth-families/v1',
    'homeboy/relative-hotspot-taxonomy/v1',
    'homeboy-extensions/aggressive-isolated-mode/v1',
    'homeboy-extensions/generate-admin-observations/v1',
    'homeboy-extensions/generate-database-observations/v1',
    'homeboy-extensions/generate-browser-observations/v1',
    'homeboy-extensions/generate-editor-observations/v1',
  ]);
  assert.deepEqual(new Set((campaign.required_upstream_capabilities || []).map((capability) => capability.contract)), requiredContracts, 'aggressive campaign upstream capability contracts drifted');
  assert.deepEqual(new Set(rig.fuzz_profile_metadata?.[campaign.profile_id]?.required_upstream_contracts || []), requiredContracts, 'aggressive profile metadata upstream contracts drifted');

  const requiredCapabilityIds = new Set([
    'homeboy_destructive_isolated_mode',
    'homeboy_fuzz_execution_request',
    'homeboy_coverage_reconciliation',
    'wp_codebox_destructive_fuzz_suite_metadata',
    'wp_codebox_snapshot_restore',
    'wordpress_rest_payload_families',
    'homeboy_chaos_sequence_generator',
    'homeboy_payload_size_depth_families',
    'homeboy_relative_hotspot_taxonomy',
    'hbex_aggressive_isolated_mode',
    'hbex_admin_generation',
    'hbex_database_generation',
    'hbex_browser_generation',
    'hbex_editor_generation',
  ]);
  assert.deepEqual(new Set((campaign.required_upstream_capabilities || []).map((capability) => capability.id)), requiredCapabilityIds, 'aggressive campaign upstream capability ids drifted');
  for (const capability of campaign.required_upstream_capabilities || []) {
    assert.equal(typeof capability.artifact, 'string', `aggressive capability ${capability.id} requires artifact id`);
    assert.ok(capability.required_before_execution === true || capability.required_before_proven === true, `aggressive capability ${capability.id} must block execution or proof`);
  }

  const expectedPlannedArtifacts = new Set([
    'fuzz_execution_request',
    'coverage_reconciliation',
    'rest_payload_family_coverage',
    'snapshot_restore_artifact',
    'chaos_sequence_pack_resolution',
    'payload_size_depth_family_coverage',
    'relative_hotspot_taxonomy',
    'per_case_timing',
    'database_observations',
    'admin_observations',
    'browser_observations',
		'editor_observations',
		'relative_hotspots',
		'side_effect_policy_evidence',
		'fixture_dynamic_id_manifest',
		'rollback_verification',
		'destructive_case_ledger',
	]);
  assert.deepEqual(new Set((campaign.planned_artifact_expectations || []).map((artifact) => artifact.id)), expectedPlannedArtifacts, 'aggressive planned artifact expectations drifted');
  for (const artifact of campaign.planned_artifact_expectations || []) {
    assert.equal(typeof artifact.schema, 'string', `aggressive planned artifact ${artifact.id} requires schema`);
    assert.equal(typeof artifact.semantic_key, 'string', `aggressive planned artifact ${artifact.id} requires semantic_key`);
    assert.ok(artifact.required_before_execution === true || artifact.required_before_proven === true, `aggressive planned artifact ${artifact.id} must block execution or proof`);
  }

  const taxonomySurfaces = new Set(Object.keys(productSurfaceTaxonomy));
  assert.deepEqual(new Set((campaign.fixture_families || []).map((family) => family.surface)), taxonomySurfaces, 'aggressive fixture families must cover the product surface taxonomy');
  for (const family of campaign.fixture_families || []) {
    assert.equal(family.readiness, 'executable_in_isolated_sandbox', `${family.id} aggressive fixture family must be executable in isolated sandbox`);
    assert.ok(Array.isArray(family.seed_shapes) && family.seed_shapes.length > 0, `${family.id} requires seed shapes`);
    assert.ok(Array.isArray(family.planned_operations) && family.planned_operations.length > 0, `${family.id} requires planned operations`);
  }

  assert.deepEqual(new Set(Object.keys(campaign.planned_case_groups || {})), new Set(['sequence', 'route', 'action', 'query', 'table', 'page', 'block']), 'aggressive planned case groups drifted');
  for (const [group, labels] of Object.entries(campaign.planned_case_groups || {})) {
    assert.ok(Array.isArray(labels) && labels.length > 0, `aggressive case group ${group} requires labels`);
  }
  assert.deepEqual(new Set(campaign.relative_hotspot_labels || []), new Set(Object.keys(campaign.planned_case_groups || {})), 'aggressive relative hotspot labels must mirror planned case groups');

  assert.equal(campaign.readiness?.level, 'executable', 'aggressive campaign must be executable');
  assert.equal(campaign.readiness?.execution_enabled, true, 'aggressive campaign must enable offloaded execution');
  assert.equal(campaign.readiness?.local_execution_enabled, false, 'aggressive campaign must not enable local execution');
  assert.equal(campaign.readiness?.destructive_full_coverage, false, 'aggressive campaign must not claim destructive full coverage');
  assert.equal(campaign.readiness?.proof_bundle, undefined, 'aggressive executable campaign must not carry proof refs before reviewer-facing artifacts exist');
  assertFuzzProofBundleRequirements(campaign.readiness?.proof_bundle_requirements, { file: 'aggressive-isolated-fuzz-campaign readiness' });
  assert.deepEqual(new Set(campaign.readiness?.proof_bundle_requirements?.required_artifacts || []), new Set([
		...(campaign.required_upstream_capabilities || []).map((capability) => capability.artifact),
		'per_case_timing',
		'relative_hotspots',
		'fixture_dynamic_id_manifest',
		'rollback_verification',
		'side_effect_policy_evidence',
		'destructive_case_ledger',
	]), 'aggressive proof artifacts must match upstream and planned capability artifacts');
  assert.equal(campaign.readiness?.upstream_blockers, undefined, 'aggressive campaign must not carry terminal upstream blockers');
  assert.deepEqual(new Set(campaign.readiness?.required_contracts || []), requiredContracts, 'aggressive campaign readiness required contracts drifted');

  assert.equal(generatedAggressiveFirehoseCommandPlan.schema, 'homeboy-rigs/woocommerce-aggressive-firehose-command-plan/v1', 'aggressive firehose command-plan schema drifted');
  assert.equal(generatedAggressiveFirehoseCommandPlan.local_execution, false, 'aggressive firehose command plan must not claim local execution');
  assert.equal(generatedAggressiveFirehoseCommandPlan.execution_enabled, true, 'aggressive firehose command plan must reflect offloaded execution');
  assert.equal(generatedAggressiveFirehoseCommandPlan.runnable_commands_enabled, true, 'aggressive firehose command plan must default to runnable offloaded output');
  assert.equal(generatedAggressiveFirehoseCommandPlan.plan_kind, 'runnable_offloaded_commands', 'aggressive firehose command plan must default to runnable offloaded commands');
  assert.equal(generatedAggressiveFirehoseCommandPlan.profile_id, campaign.profile_id, 'aggressive firehose command plan profile id drifted');
  assert.ok(generatedAggressiveFirehoseCommandPlan.commands.length >= 3, 'aggressive firehose command plan must emit runnable commands by default');
  assert.equal(generatedAggressiveFirehosePlanOnly.runnable_commands_enabled, false, '--plan-only must withhold runnable command arrays');
  assert.deepEqual(generatedAggressiveFirehosePlanOnly.commands, [], '--plan-only aggressive firehose command plan must withhold runnable commands');
  assert.match(generatedAggressiveFirehoseTextPlan, /Offloaded Homeboy\/HBEX command plan/, 'text command plan must advertise offloaded execution');
  assert.match(generatedAggressiveFirehoseTextPlan, /^homeboy /m, 'default text command plan must print runnable homeboy commands');
  const generatedPlanItems = generatedAggressiveFirehoseCommandPlan.plan_items || [];
  assert.ok(generatedPlanItems.length >= 3, 'aggressive firehose command plan must include prepare, request, and ref collection plan items');
  const requestCommand = generatedPlanItems.find((entry) => entry.purpose === 'request_aggressive_isolated_firehose')?.command_argv || [];
  for (const flag of [
    '--lab-only',
    '--allow-destructive',
    '--isolation',
    'isolated',
    '--fuzz-execution-request-artifact',
    '--coverage-reconciliation',
    '--wp-codebox-destructive-fuzz-suite-metadata',
    '--rest-payload-families',
    '--chaos-sequence-packs',
    '--payload-size-depth-families',
    '--relative-hotspot-taxonomy',
    '--snapshot-restore',
    '--hbex-aggressive-isolated-mode',
    '--hbex-admin-generation',
    '--hbex-database-generation',
    '--hbex-browser-generation',
    '--hbex-editor-generation',
  ]) {
    assert.ok(requestCommand.includes(flag), `aggressive command plan request must include ${flag}`);
  }
  assert.equal(requestCommand[0], 'homeboy', 'aggressive command plan must use Homeboy');
  assert.ok(!requestCommand.includes('--execute-local'), 'aggressive command plan must not include local execution');
  assert.ok(!requestCommand.includes('--allow-local-fallback'), 'aggressive command plan must not allow local fallback');
  assertNoLocalOnlyRefs(campaign, 'aggressive-isolated-fuzz-campaign');
  assertNoProofPlaceholders(campaign, 'aggressive-isolated-fuzz-campaign');
}

function assertProductChaosSequencePackContract(manifest) {
  assert.equal(manifest.schema, 'homeboy-rigs/woocommerce-product-chaos-sequence-packs/v1', 'product chaos sequence pack schema drifted');
  assert.equal(manifest.id, 'woocommerce-product-chaos-sequence-packs', 'product chaos sequence pack id drifted');
  assert.equal(manifest.owner_profile, 'aggressive-isolated-firehose', 'product chaos sequence pack owner profile drifted');
  assert.equal(manifest.target_inventory_manifest, 'manifests/target-inventory.json', 'product chaos sequence pack target inventory ref drifted');
  assert.equal(manifest.status, 'executable_contract', 'product chaos sequence packs must be executable contracts');
  assert.equal(manifest.execution_enabled, true, 'product chaos sequence packs must enable offloaded execution');
  assert.equal(manifest.runner_behavior, 'offloaded_codebox_homeboy_hbex_isolated_sandbox', 'product chaos runner behavior drifted');
  assert.equal(manifest.readiness?.level, 'executable', 'product chaos sequence pack readiness must be executable');
  assert.equal(manifest.readiness?.execution_enabled, true, 'product chaos sequence pack readiness must enable offloaded execution');
  assert.equal(manifest.readiness?.local_execution_enabled, false, 'product chaos sequence pack readiness must not enable local execution');
  assert.equal(manifest.readiness?.proof_status, 'requires_reviewer_facing_artifacts', 'product chaos sequence pack proof status drifted');
  assert.equal(manifest.readiness?.proof_bundle, undefined, 'product chaos executable readiness must not carry proof refs before reviewer-facing artifacts exist');
  assertFuzzProofBundleRequirements(manifest.readiness?.proof_bundle_requirements, { file: 'product-chaos-sequence-packs readiness' });
  assert.equal(manifest.readiness?.upstream_blockers, undefined, 'product chaos sequence packs must not carry terminal upstream blockers');
  assertNoLocalOnlyRefs(manifest, 'product-chaos-sequence-packs');
  assertNoProofPlaceholders(manifest, 'product-chaos-sequence-packs');
  assertNoHardThresholdClaims(manifest, 'product-chaos-sequence-packs');

  const sequencePacks = manifest.sequence_packs || [];
  const sequencePackIds = new Set(sequencePacks.map((pack) => pack.id));
  assert.equal(sequencePackIds.size, sequencePacks.length, 'product chaos sequence pack ids must be unique');
  assert.deepEqual(new Set(sequencePacks.map((pack) => pack.surface)), new Set(wooSequencePackSurfaceIds), 'product chaos sequence pack surfaces must come from the canonical Woo taxonomy');
  for (const pack of sequencePacks) {
    assert.ok(wooProductSurfaceIds.includes(pack.surface), `${pack.id} sequence pack surface must exist in the canonical Woo taxonomy`);
  }

  const taxonomyLabels = new Set(manifest.relative_hotspot_taxonomy?.labels || []);
  assert.deepEqual(taxonomyLabels, new Set(wooRelativeHotspotLabels), 'product chaos relative hotspot taxonomy labels drifted');
  for (const label of taxonomyLabels) {
    assert.ok(Array.isArray(manifest.relative_hotspot_taxonomy[label]) && manifest.relative_hotspot_taxonomy[label].length > 0, `relative hotspot taxonomy ${label} requires labels`);
  }

  const payloadFamilies = new Map((manifest.payload_size_depth_families || []).map((family) => [family.id, family]));
  assert.deepEqual(new Set(payloadFamilies.keys()), new Set(['catalog-payload-shapes', 'commerce-session-shapes', 'business-object-shapes', 'admin-settings-shapes']), 'payload size/depth family ids drifted');
  for (const [familyId, family] of payloadFamilies) {
    assert.equal(family.readiness, 'executable_in_isolated_sandbox', `${familyId} payload family must be executable in isolated sandbox`);
    assert.ok(Array.isArray(family.applies_to) && family.applies_to.length > 0, `${familyId} requires applies_to surfaces`);
    assert.ok(Array.isArray(family.size_labels) && family.size_labels.length > 0, `${familyId} requires size labels`);
    assert.ok(Array.isArray(family.depth_labels) && family.depth_labels.length > 0, `${familyId} requires depth labels`);
    assert.ok(Array.isArray(family.seed_shapes) && family.seed_shapes.length > 0, `${familyId} requires Woo fixture seed shapes`);
  }

  const fixtureFamilies = new Map((manifest.fixture_families || []).map((family) => [family.id, family]));
  assert.deepEqual(new Set(fixtureFamilies.keys()), new Set(['catalog-products-and-variations', 'cart-checkout-store-api', 'orders-coupons-customers', 'settings-reports-admin', 'cross-surface-api-state']), 'product chaos fixture family ids drifted');
  for (const [familyId, family] of fixtureFamilies) {
    assert.equal(family.readiness, 'executable_in_isolated_sandbox', `${familyId} fixture family must be executable in isolated sandbox`);
    assert.ok(Array.isArray(family.surfaces) && family.surfaces.length > 0, `${familyId} requires surfaces`);
    assert.ok(Array.isArray(family.seed_refs) && family.seed_refs.length > 0, `${familyId} requires seed refs`);
    for (const seedRef of family.seed_refs) {
      const payloadFamilyId = seedRef.replace('payload_size_depth_families/', '');
      assert.ok(payloadFamilies.has(payloadFamilyId), `${familyId} seed ref ${seedRef} must point at a declared payload size/depth family`);
    }
  }

  for (const pack of manifest.sequence_packs || []) {
    assert.equal(pack.readiness, 'executable_in_isolated_sandbox', `${pack.id} sequence pack must be executable in isolated sandbox`);
    assert.ok(fixtureFamilies.has(pack.fixture_family), `${pack.id} sequence pack fixture family drifted`);
    assert.ok(Array.isArray(pack.steps) && pack.steps.length > 0, `${pack.id} sequence pack requires ordered steps`);
    assert.deepEqual(new Set(Object.keys(pack.hotspot_labels || {})), taxonomyLabels, `${pack.id} hotspot labels must match taxonomy labels`);
  }

  assert.deepEqual(targetInventory.discovery_manifests?.product_chaos_sequence_packs?.sequence_pack_ids, sequencePacks.map((pack) => pack.id), 'target inventory sequence pack ids must mirror the sequence pack manifest');
  assert.deepEqual(new Set(targetInventory.discovery_manifests?.product_chaos_sequence_packs?.relative_hotspot_labels || []), taxonomyLabels, 'target inventory relative hotspot labels drifted');
  assert.equal(rig.fuzz_profile_metadata?.['aggressive-isolated-firehose']?.sequence_pack_manifest, 'manifests/product-chaos-sequence-packs.json', 'aggressive profile metadata sequence pack ref drifted');
}

assertAggressiveIsolatedCampaignContract(aggressiveIsolatedFuzzCampaign);
assertProductChaosSequencePackContract(productChaosSequencePacks);

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
  assertExecutableCrudMutationSafety(manifest.metadata?.readiness, { file: manifest.id });

  if (manifest.metadata?.readiness?.level === 'proven') {
    const proofBundle = manifest.metadata.readiness.proof_bundle;
    assert.ok(proofBundle, `${manifest.id} proven readiness must link a proof bundle`);
    assert.ok(proofBundle.run_ids.length > 0, `${manifest.id} proven readiness must link at least one run id`);
  }

  if (requiredArtifactWorkloadIds.has(manifest.id) && fuzzManifestHasExecutableArtifactContract(manifest)) {
    for (const artifact of runnerCase.artifacts) {
      assert.equal(artifact.required, true, `${manifest.id} full-surface executable case artifact ${artifact.name} must be required`);
    }
    for (const artifact of manifest.artifacts.expected) {
      assert.equal(artifact.required, true, `${manifest.id} full-surface executable expected artifact ${artifact.name} must be required`);
    }
  }

  assertWooRequiredFuzzProofContracts(manifest, { runnerCase });

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

const codeboxContractManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'codebox-fuzz-suite-contract')?.manifest;
assert.ok(codeboxContractManifest, 'codebox-fuzz-suite-contract manifest is missing');
assert.equal(codeboxContractManifest.metadata?.readiness?.level, 'declared', 'codebox contract must not claim proven readiness without proof artifacts');
assertFuzzProofBundleRequirements(codeboxContractManifest.metadata?.readiness?.proof_bundle_requirements, { file: 'codebox-fuzz-suite-contract readiness' });
assert.ok(codeboxContractManifest.operations.includes('generated-route-inventory-contract'), 'codebox contract must depend on generated route inventory contracts');
assert.ok(codeboxContractManifest.operations.includes('rest-db-query-attribution-contract'), 'codebox contract must depend on REST DB query attribution contracts');
assert.deepEqual(codeboxContractManifest.metadata?.required_primitive_contracts, [
  'wordpress.inventory-rest-routes',
  'wordpress.generate-rest-request-cases',
  'wordpress.profile-rest-db-queries',
  'wordpress.inventory-database',
  'wordpress.attribute-rest-schema-queries',
  'wordpress.summarize-performance-hotspots',
  'wordpress.coverage-gap-report',
]);
assert.equal(codeboxContractManifest.metadata?.readiness?.upstream_blockers?.length, 4, 'codebox contract declared readiness must name upstream blockers');
assert.equal(codeboxContractManifest.metadata?.readiness?.crud?.read?.level, 'executable', 'DB/API profile read CRUD boundary must be executable');
for (const operation of ['create', 'update', 'delete']) {
  assert.equal(codeboxContractManifest.metadata?.readiness?.crud?.[operation]?.level, 'declared', `DB/API profile ${operation} CRUD boundary must be declared`);
  assert.equal(typeof codeboxContractManifest.metadata?.readiness?.crud?.[operation]?.upstream_blocker, 'string', `DB/API profile ${operation} CRUD boundary must declare its upstream blocker`);
}
assert.match(
  codeboxContractManifest.metadata?.readiness?.mutation?.safety_boundary || '',
  /read-only until isolated fixture mutation/,
  'DB/API profile mutation readiness must declare the read-only boundary'
);
assert.deepEqual(codeboxContractManifest.metadata?.public_codebox_contracts, [
  'wp-codebox/fuzz-suite/v1',
  'wp-codebox/wordpress-workload-run/v1',
  'wp-codebox/fuzz-suite-result/v1',
]);
assertDeclaredExpectedArtifactMarker(codeboxContractManifest.artifacts.expected[0], 'codebox contract expected artifact');

const codeboxWorkloadRun = readJson(packageRoot, 'bench/codebox-fuzz-suite-contract.workload.json');
assert.equal(codeboxWorkloadRun.schema, 'wp-codebox/wordpress-workload-run/v1');
assert.equal(codeboxWorkloadRun.runtime_env?.WP_CODEBOX_PUBLIC_CONTRACT_PROOF, 'generated-contract-only');
assert.ok(codeboxWorkloadRun.before.some((step) => step.command === 'wordpress.ensure-plugin-active'), 'codebox workload must activate WooCommerce');
assert.ok(codeboxWorkloadRun.steps.some((step) => step.command === 'wp-codebox/run-fuzz-suite'), 'codebox workload must route through public run-fuzz-suite ability');
assert.equal(codeboxWorkloadRun.artifacts[0]?.metadata?.schema, 'wp-codebox/fuzz-suite-result/v1');
assert.equal(codeboxWorkloadRun.artifacts[0]?.required, false, 'codebox workload proof artifact must remain optional until captured');
assert.equal(codeboxWorkloadRun.artifacts[0]?.metadata?.artifact_expected_after_run, true, 'codebox workload artifact metadata must mark artifact_expected_after_run');
assert.equal(codeboxWorkloadRun.metadata?.proof_status, 'declared_contract');
assertNoProofPlaceholders(codeboxWorkloadRun, 'codebox-fuzz-suite-contract workload');

const codeboxSuite = readJson(packageRoot, 'manifests/codebox-fuzz-suite-contract.json');
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
  'manifests/db-api-fuzz-campaign.json',
  'manifests/db-api-performance-fuzzer-gap-report.json',
  'manifests/rest-crud-fixture-plan.json',
  'manifests/rest-crud-fixture-opt-ins.json',
]);
assert.deepEqual(rig.fuzz_profiles?.['db-api-performance-fuzzer'], dbApiPerformanceFuzzerProfileWorkloadIds, 'DB/API performance fuzzer profile workload ids drifted');
assert.deepEqual(codeboxSuite.target?.metadata?.profile?.workload_ids, dbApiPerformanceFuzzerWorkloadIds, 'Codebox suite DB/API profile workload ids drifted');
assert.equal(codeboxSuite.target?.metadata?.profile?.gap_report_manifest, 'manifests/db-api-performance-fuzzer-gap-report.json', 'Codebox suite must link the standalone DB/API gap report declaration');
assert.equal(codeboxSuite.target?.metadata?.profile?.campaign_manifest, 'manifests/db-api-fuzz-campaign.json', 'Codebox suite must link the DB/API fuzz campaign declaration');
assertRestCrudFixtureContractRefs(codeboxSuite.target?.metadata?.profile, 'Codebox suite DB/API profile');
assertFuzzProofBundleRequirements(codeboxSuite.target?.metadata?.proof_bundle_requirements, { file: 'codebox suite metadata proof bundle requirements' });
assert.equal(codeboxSuite.target?.metadata?.proof_bundle, undefined, 'declared Codebox suite must not carry proof refs before reviewer-facing artifacts exist');
assert.equal(codeboxSuite.metadata?.public_result_contract, 'wp-codebox/fuzz-suite-result/v1', 'Codebox suite must declare the public fuzz-suite result contract');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.campaign_manifest, 'manifests/db-api-fuzz-campaign.json', 'DB/API profile must link the campaign declaration');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.gap_report_manifest, 'manifests/db-api-performance-fuzzer-gap-report.json', 'DB/API profile must link the standalone gap report declaration');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.stable_workload_contracts_manifest, 'manifests/stable-workloads.json', 'DB/API profile must link stable workload contracts');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.source_gap_report, 'manifests/full-surface-coverage.json#gap_report', 'DB/API profile must identify the source full-surface gap report');
assertProfileReadiness(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.readiness, 'fuzz_profile_metadata.db-api-performance-fuzzer.readiness');
assertStableWorkloadContracts(stableWorkloads);
assert.equal(dbApiPerformanceFuzzerGapReport.schema, 'homeboy-rigs/wordpress-coverage-gap-report-workload/v1', 'DB/API gap report workload schema drifted');
assert.equal(dbApiPerformanceFuzzerGapReport.id, 'woocommerce-db-api-performance-fuzzer-gap-report', 'DB/API gap report workload id drifted');
assert.equal(dbApiPerformanceFuzzerGapReport.profile_id, 'db-api-performance-fuzzer', 'DB/API gap report workload must target the DB/API fuzzer profile');
assert.equal(dbApiPerformanceFuzzerGapReport.source_gap_report, 'manifests/full-surface-coverage.json#gap_report', 'DB/API gap report workload must point at the full-surface gap report source');
assert.equal(dbApiPerformanceFuzzerGapReport.workload, 'fuzz/coverage-gap-report.json', 'DB/API gap report workload must link the executable fuzz workload');
assert.deepEqual(dbApiPerformanceFuzzerGapReport.inputs, dbApiPerformanceFuzzerGapReportInputIds, 'DB/API gap report workload inputs drifted');
assert.equal(dbApiPerformanceFuzzerGapReport.readiness?.level, 'executable', 'DB/API gap report workload readiness must be executable through artifact-postprocess');
assert.equal(dbApiPerformanceFuzzerGapReport.readiness?.execution, 'artifact_aggregation', 'DB/API gap report workload must use artifact aggregation execution');
assert.deepEqual(dbApiPerformanceFuzzerGapReport.generic_upstream_contracts, [
  'homeboy.artifact-postprocess',
  'wp-codebox/wordpress-workload-run/v1',
  'homeboy-rigs/wordpress-coverage-gap-report/v1',
], 'DB/API gap report must link generic upstream artifact contracts');
assert.match(dbApiPerformanceFuzzerGapReport.boundary_note || '', /temporary local bridge/, 'DB/API gap report must document the temporary local postprocess boundary');
assertFuzzProofBundleRequirements(dbApiPerformanceFuzzerGapReport.readiness?.proof_bundle_requirements, { file: 'db-api-performance-fuzzer-gap-report readiness' });
assert.ok(dbApiPerformanceFuzzerGapReport.readiness?.upstream_blockers?.length > 0, 'DB/API gap report declaration must name upstream blockers');
assert.ok(dbApiPerformanceFuzzerGapReport.readiness.upstream_blockers.some((blocker) => blocker.includes('generic artifact-postprocess primitive')), 'DB/API gap report declaration must list the remaining generic artifact-postprocess blocker');
assert.ok(dbApiPerformanceFuzzerGapReport.readiness.upstream_blockers.some((blocker) => blocker.includes('generic hotspot aggregation')), 'DB/API gap report declaration must list the remaining generic hotspot blocker');
assert.ok(dbApiPerformanceFuzzerGapReport.readiness.upstream_blockers.some((blocker) => blocker.includes('fuzz-suite-result')), 'DB/API gap report declaration must list the remaining fuzz-suite proof blocker');
assert.equal(dbApiFuzzCampaign.schema, 'homeboy-rigs/woocommerce-db-api-fuzz-campaign/v1', 'DB/API fuzz campaign schema drifted');
assert.equal(dbApiFuzzCampaign.id, 'woocommerce-db-api-fuzz-campaign', 'DB/API fuzz campaign id drifted');
assert.equal(dbApiFuzzCampaign.profile_id, 'db-api-performance-fuzzer', 'DB/API fuzz campaign profile id drifted');
assert.equal(dbApiFuzzCampaign.suite_manifest, 'manifests/codebox-fuzz-suite-contract.json', 'DB/API fuzz campaign must link the Codebox fuzz suite');
assert.equal(dbApiFuzzCampaign.gap_report_manifest, 'manifests/db-api-performance-fuzzer-gap-report.json', 'DB/API fuzz campaign must link the gap report manifest');
assert.equal(dbApiFuzzCampaign.hotspot_artifact_io_manifest, 'manifests/db-api-hotspot-artifact-io.json', 'DB/API fuzz campaign must link hotspot artifact IO');
assertRestCrudFixtureContractRefs(dbApiFuzzCampaign, 'DB/API fuzz campaign');
assert.deepEqual(dbApiFuzzCampaign.workloads, dbApiPerformanceFuzzerWorkloadIds, 'DB/API fuzz campaign workloads drifted');
assert.equal(dbApiFuzzCampaign.readiness?.level, 'declared', 'DB/API fuzz campaign must stay declared until reviewer-facing artifacts exist');
assert.equal(dbApiFuzzCampaign.readiness?.execution, 'offloaded_fuzz_campaign', 'DB/API fuzz campaign execution mode drifted');
assertFuzzProofBundleRequirements(dbApiFuzzCampaign.readiness?.proof_bundle_requirements, { file: 'db-api-fuzz-campaign readiness' });
assertNoLocalOnlyRefs(dbApiFuzzCampaign, 'db-api-fuzz-campaign');
assertNoProofPlaceholders(dbApiFuzzCampaign, 'db-api-fuzz-campaign');
assertDbApiCampaignPromotionContract(dbApiFuzzCampaign);
assert.equal(dbApiFuzzCampaign.postprocess?.command, 'homeboy.artifact-postprocess', 'DB/API fuzz campaign must route postprocess through generic artifact-postprocess');
assert.equal(dbApiFuzzCampaign.postprocess?.runner_support_status, 'product_local_temporary_bridge', 'DB/API fuzz campaign postprocess must be marked as product-local temporary bridge');
assert.match(dbApiFuzzCampaign.postprocess?.boundary_note || '', /upstream Homeboy generic artifact-postprocess/, 'DB/API fuzz campaign postprocess must document the upstream artifact-postprocess boundary');
assert.ok(dbApiFuzzCampaign.postprocess?.blocked_until?.every((condition) => !condition.includes('args.helper')), 'DB/API fuzz campaign postprocess blockers must not claim missing helper/action/input/output/parameters binding');
assert.ok(dbApiFuzzCampaign.postprocess?.blocked_until?.some((condition) => condition.includes('generic artifact-postprocess primitive')), 'DB/API fuzz campaign postprocess blockers must include the generic artifact-postprocess primitive');
assert.ok(dbApiFuzzCampaign.postprocess?.blocked_until?.some((condition) => condition.includes('generic hotspot aggregation primitive')), 'DB/API fuzz campaign postprocess blockers must include the generic hotspot aggregation primitive');
assert.ok(dbApiFuzzCampaign.postprocess?.blocked_until?.some((condition) => condition.includes('reviewer-facing evidence')), 'DB/API fuzz campaign postprocess blockers must include reviewer-facing evidence collection before proven readiness');
assert.deepEqual(dbApiFuzzCampaign.postprocess?.artifact_roots, [
  {
    id: 'offloaded_campaign_artifacts',
    type: 'artifact-root',
    path: '${artifacts.root}',
    ref_requirement: 'reviewer-facing Homeboy artifact root from the approved offloaded campaign run set',
    local_only_refs_allowed: false,
    contains_workloads: [
      'codebox-fuzz-suite-contract',
      'woocommerce-rest-route-inventory',
      'generated-rest-request-cases',
      'rest-db-query-profile',
      'db-inventory',
      'rest-schema-query-attribution',
    ],
  },
], 'DB/API fuzz campaign artifact root contract drifted');
assert.equal(dbApiFuzzCampaign.postprocess.outputs?.length, 2, 'DB/API fuzz campaign must declare coverage and hotspot postprocess outputs');
assertCampaignPostprocessOutput(
  coverageGapReportWorkload,
  dbApiFuzzCampaign.postprocess.outputs.find((output) => output.workload === 'coverage-gap-report'),
  'DB/API campaign coverage-gap-report postprocess output'
);
assertCampaignPostprocessOutput(
  performanceHotspotsWorkload,
  dbApiFuzzCampaign.postprocess.outputs.find((output) => output.workload === 'performance-hotspots-artifact-summary'),
  'DB/API campaign performance-hotspots postprocess output'
);
assert.equal(dbApiFuzzCampaign.operator_commands?.offload_required, true, 'DB/API fuzz campaign must require offloaded execution');
assert.equal(dbApiFuzzCampaign.operator_commands?.status, 'executable_pending_offloaded_artifacts', 'DB/API fuzz campaign operator commands must be executable but pending offloaded artifacts for proof');
assert.equal(dbApiFuzzCampaign.operator_commands?.tracker_ref_placeholder, '$WC_TRACKER_REF', 'DB/API fuzz campaign must declare the tracker ref placeholder');
assert.match(dbApiFuzzCampaign.operator_commands?.reviewer_evidence_refs_command || '', /homeboy runs refs/, 'DB/API fuzz campaign must declare the reviewer evidence refs command');
assert.match(dbApiFuzzCampaign.operator_commands?.reviewer_evidence_refs_command || '', /--tracker-ref "\$WC_TRACKER_REF"/, 'DB/API reviewer evidence refs command must be tracker-scoped');
assert.match(dbApiFuzzCampaign.operator_commands?.postprocess_note || '', /homeboy\.artifact-postprocess/, 'DB/API fuzz campaign operator commands must document generic postprocess execution');
assert.match(dbApiFuzzCampaign.operator_commands?.postprocess_note || '', /\$\{artifacts\.root\}/, 'DB/API fuzz campaign operator commands must name the offloaded artifact root placeholder');
assert.ok(dbApiFuzzCampaign.operator_commands?.commands?.every((command) => command.startsWith('homeboy ')), 'DB/API fuzz campaign commands must use Homeboy rig/fuzz commands');
assert.ok(dbApiFuzzCampaign.operator_commands.commands.filter((command) => command.startsWith('homeboy fuzz run ')).every((command) => command.includes('--tracker-ref "$WC_TRACKER_REF"')), 'DB/API fuzz campaign run commands must include the reviewer-facing tracker ref');
assert.ok(dbApiFuzzCampaign.operator_commands.commands.some((command) => command.includes('--workload codebox-fuzz-suite-contract')), 'DB/API fuzz campaign must include Codebox fuzz-suite workload command');
assert.ok(dbApiFuzzCampaign.operator_commands.commands.some((command) => command.includes('--workload coverage-gap-report')), 'DB/API fuzz campaign must include coverage gap postprocess workload command');
assert.ok(dbApiFuzzCampaign.operator_commands.commands.some((command) => command.includes('--workload performance-hotspots-artifact-summary')), 'DB/API fuzz campaign must include hotspot summary postprocess workload command');
const requiredCampaignSchemas = new Set([
  'wp-codebox/fuzz-suite-result/v1',
  'wp-codebox/wordpress-hotspots/v1',
  'homeboy/fuzz-coverage/v1',
  'homeboy/woocommerce-performance-hotspots-summary/v1',
  'homeboy-rigs/wordpress-coverage-gap-report/v1',
]);
assert.deepEqual(new Set(dbApiFuzzCampaign.required_upstream_artifact_refs.map((artifact) => artifact.schema)), requiredCampaignSchemas, 'DB/API fuzz campaign required artifact schemas drifted');
for (const artifact of dbApiFuzzCampaign.required_upstream_artifact_refs) {
  assert.equal(artifact.readiness, 'required_before_proven', `DB/API fuzz campaign artifact ${artifact.id} must be required before proven`);
  assert.equal(typeof artifact.semantic_key, 'string', `DB/API fuzz campaign artifact ${artifact.id} requires semantic_key`);
}
assert.equal(dbApiHotspotArtifactIo.schema, 'homeboy-rigs/woocommerce-db-api-hotspot-artifact-io/v1', 'DB/API hotspot artifact IO schema drifted');
assert.equal(dbApiHotspotArtifactIo.postprocess_command, 'homeboy.artifact-postprocess', 'DB/API hotspot artifact IO must use upstream artifact-postprocess');
assert.equal(dbApiHotspotArtifactIo.readiness?.level, 'executable', 'DB/API hotspot artifact IO must be executable through artifact-postprocess');
assert.deepEqual(dbApiHotspotArtifactIo.generic_upstream_contracts, [
  'homeboy.artifact-postprocess',
  'wp-codebox/wordpress-workload-run/v1',
  'homeboy/woocommerce-performance-hotspots-summary/v1',
], 'DB/API hotspot artifact IO must link generic upstream artifact contracts');
assertFuzzProofBundleRequirements(dbApiHotspotArtifactIo.readiness?.proof_bundle_requirements, { file: 'db-api-hotspot-artifact-io readiness' });
assert.deepEqual(new Set(dbApiHotspotArtifactIo.expected_inputs.map((input) => input.workload_id)), new Set(dbApiPerformanceFuzzerGapReportInputIds), 'DB/API hotspot artifact IO inputs drifted');
assert.equal(dbApiHotspotArtifactIo.sample_output?.schema, 'homeboy/woocommerce-performance-hotspots-summary/v1', 'DB/API hotspot sample output schema drifted');
assert.equal(dbApiHotspotArtifactIo.sample_output?.threshold_policy, 'relative_ranking_only', 'DB/API hotspot sample output must use relative ranking');
assertExecutableReadinessNeedsProofRequirements(coverageGapReportWorkload.metadata?.readiness, 'coverage-gap-report workload readiness');
assertExecutableReadinessNeedsProofRequirements(performanceHotspotsWorkload.metadata?.readiness, 'performance-hotspots-artifact-summary workload readiness');
assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.readiness?.crud?.read?.level, 'executable', 'DB/API rig profile read CRUD boundary must be executable');
for (const operation of ['create', 'update', 'delete']) {
  assert.equal(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.readiness?.crud?.[operation]?.level, 'declared', `DB/API rig profile ${operation} CRUD boundary must be declared`);
  assert.equal(typeof rig.fuzz_profile_metadata?.['db-api-performance-fuzzer']?.readiness?.crud?.[operation]?.upstream_blocker, 'string', `DB/API rig profile ${operation} CRUD boundary must declare its upstream blocker`);
}

const productCrudProfileIds = ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-schema-query-attribution', 'coverage-gap-report'];
assert.deepEqual(rig.fuzz_profiles?.['product-rest-crud-fuzzer'], productCrudProfileIds, 'product REST CRUD fuzzer profile workload ids drifted');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.route_family_catalog_manifest, 'manifests/rest-crud-route-family-catalog.json', 'product REST CRUD profile must link the route-family catalog');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.payload_fixture_manifest, 'manifests/rest-crud-payload-fixtures.json', 'product REST CRUD profile must link the payload fixture manifest');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.fixture_plan_manifest, 'manifests/rest-crud-fixture-plan.json', 'product REST CRUD profile must link the generated fixture plan');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.rest_mutation_fixture_opt_ins_manifest, 'manifests/rest-crud-fixture-opt-ins.json', 'product REST CRUD profile must link the generated REST mutation opt-ins');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.hotspot_artifact_contract_manifest, 'manifests/db-api-hotspot-artifact-io.json', 'product REST CRUD profile must link the hotspot artifact IO contract');
assertRestCrudFixtureContractRefs(rig.fuzz_profile_metadata?.['db-api-performance-fuzzer'], 'DB/API rig profile');
assertRestCrudFixtureContractRefs(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer'], 'product REST CRUD rig profile');
assert.deepEqual(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.generic_upstream_contracts, [
  'wordpress.rollback-safe-rest-mutation',
  'homeboy/wordpress-rest-mutation-rollback-contract/v1',
  'wp-codebox/wordpress-workload-run/v1',
  'wp-codebox/mutation-isolation-artifact/v1',
  'wp-codebox/delete-boundary-artifact/v1',
], 'product REST CRUD profile must consume the generic rollback-safe REST mutation primitive');
assertProfileReadiness(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness, 'fuzz_profile_metadata.product-rest-crud-fuzzer.readiness');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.create?.level, 'executable', 'product REST CRUD create readiness must be executable');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.create?.primitive, 'wordpress.rollback-safe-rest-mutation', 'product REST CRUD create must use the generic rollback-safe REST mutation primitive');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.update?.level, 'executable', 'product REST CRUD update readiness must be executable');
assert.equal(rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer']?.readiness?.crud?.update?.primitive, 'wordpress.rollback-safe-rest-mutation', 'product REST CRUD update must use the generic rollback-safe REST mutation primitive');
const productRestCrudProfile = rig.fuzz_profile_metadata?.['product-rest-crud-fuzzer'];
assert.equal(productRestCrudProfile?.readiness?.crud?.delete?.level, 'declared', 'product REST CRUD delete readiness must remain declared until delete-boundary artifacts exist');
assert.match(productRestCrudProfile?.readiness?.crud?.delete?.upstream_blocker || '', /delete-boundary rollback artifact contract/, 'product REST CRUD delete blocker must name missing delete-boundary rollback artifact contract');
assert.equal(productRestCrudProfile?.readiness?.mutation?.rollback_artifacts?.includes('delete_boundary'), false, 'product REST CRUD mutation readiness must not require delete_boundary until delete is executable');

const productBatchManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'rest-product-batch-import')?.manifest;
assert.equal(productBatchManifest.metadata?.readiness?.profile, 'product-rest-crud-fuzzer', 'product batch import readiness profile drifted');
assert.equal(productBatchManifest.metadata?.readiness?.level, 'executable', 'product batch import create/update readiness must be executable');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.create?.level, 'executable', 'product batch import create readiness must be executable');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.create?.primitive, 'wordpress.rollback-safe-rest-mutation', 'product batch import create must consume rollback-safe REST mutation');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.update?.level, 'executable', 'product batch import update readiness must be executable');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.update?.primitive, 'wordpress.rollback-safe-rest-mutation', 'product batch import update must consume rollback-safe REST mutation');
assert.equal(productBatchManifest.metadata?.readiness?.crud?.delete?.level, 'declared', 'product batch import delete readiness must remain declared/blocked');
assert.match(productBatchManifest.metadata?.readiness?.crud?.delete?.upstream_blocker, /delete-boundary rollback artifact contract/, 'product batch import delete blocker must name missing delete-boundary rollback artifact contract');
assert.equal(productBatchManifest.metadata?.readiness?.mutation?.primitive, 'wordpress.rollback-safe-rest-mutation', 'product batch import mutation readiness must name the generic mutation primitive');
assert.deepEqual(productBatchManifest.metadata?.payload_fixtures?.roles, ['administrator', 'shop_manager'], 'product batch import payload fixtures must declare Woo REST roles');
assert.equal(productBatchManifest.metadata?.payload_fixtures?.namespace, 'wc/v3', 'product batch import payload fixtures must declare Woo REST namespace');
assert.equal(productBatchManifest.metadata?.payload_fixtures?.manifest, 'manifests/rest-crud-payload-fixtures.json', 'product batch import must point static payload fixture declarations at the manifest');
assert.equal(productBatchManifest.metadata?.payload_fixtures?.fixture_plan_manifest, 'manifests/rest-crud-fixture-plan.json', 'product batch import payload fixtures must link the generated fixture plan');
assert.equal(productBatchManifest.metadata?.payload_fixtures?.rest_mutation_fixture_opt_ins_manifest, 'manifests/rest-crud-fixture-opt-ins.json', 'product batch import payload fixtures must link the generated REST mutation opt-ins');
assertRestCrudFixtureContractRefs(productBatchManifest.metadata?.payload_fixtures, 'product batch import payload fixtures', ['products']);
assert.deepEqual(productBatchManifest.metadata?.payload_fixtures?.family_ids, ['products'], 'product batch import must consume only the product payload fixture family');
assert.equal(productBatchManifest.metadata?.payload_fixtures?.delete?.level, 'declared', 'product batch import delete payload fixture must remain declared');
assert.ok(productBatchManifest.route_families.includes('wc/v3/products/batch'), 'product batch import must list products batch route family');
assert.ok(productBatchManifest.route_families.includes('wc/v3/products/<product_id>/variations/batch'), 'product batch import must list variations batch route family');

const restDbQueryProfileManifest = fuzzManifests.find(({ manifest }) => manifest.id === 'rest-db-query-profile')?.manifest;
assert.equal(restDbQueryProfileManifest.metadata?.product_budgets?.max_profiled_rest_cases, restDbQueryProfileManifest.case_budget, 'REST DB query profile case budget drifted');
assert.equal(restDbQueryProfileManifest.metadata?.product_budgets?.max_slow_queries_per_case, 0, 'REST DB query profile must budget zero slow queries per case');
assert.ok(restDbQueryProfileManifest.metadata?.observed_surfaces?.includes('wc/store/v1'), 'REST DB query profile must observe Store API routes');
assert.ok(restDbQueryProfileManifest.metadata?.observed_surfaces?.includes('wc-admin'), 'REST DB query profile must observe Woo admin REST routes');
assert.ok(restDbQueryProfileManifest.metadata?.query_attribution_expectations?.required_fields?.includes('callers'), 'REST DB query profile must require caller attribution');
assert.equal(restDbQueryProfileManifest.cases?.[0]?.inputs?.query_attribution_required, true, 'REST DB query profile must require query attribution');
assert.equal(restDbQueryProfileManifest.cases?.[0]?.inputs?.external_service_calls_allowed, false, 'REST DB query profile must not allow external service calls');
assert.ok(restDbQueryProfileManifest.cases?.[0]?.artifacts?.[0]?.metadata?.contains?.includes('budget_comparison'), 'REST DB query profile artifact must include budget comparison');
assert.ok(restDbQueryProfileManifest.artifacts?.expected?.[0]?.contains?.includes('query_attribution'), 'REST DB query profile expected artifact must include query attribution');

assert.equal(restCrudRouteFamilyCatalog.schema, 'homeboy-rigs/woocommerce-rest-crud-route-family-catalog/v1', 'REST CRUD route-family catalog schema drifted');
assert.equal(restCrudRouteFamilyCatalog.owner_profile, 'product-rest-crud-fuzzer', 'REST CRUD route-family catalog owner profile drifted');
assert.equal(restCrudRouteFamilyCatalog.payload_fixture_manifest, 'manifests/rest-crud-payload-fixtures.json', 'REST CRUD route-family catalog must link the payload fixture manifest');
assert.ok(restCrudRouteFamilyCatalog.route_families.length >= 9, 'REST CRUD route-family catalog must cover product, order, customer, and coupon families');
assert.deepEqual(targetInventory.discovery_manifests?.rest_route_families?.route_family_ids, restCrudRouteFamilyCatalog.route_families.map((family) => family.id), 'target inventory REST route-family discovery ids drifted');
assert.equal(targetInventory.discovery_manifests?.rest_route_families?.payload_fixture_manifest, 'manifests/rest-crud-payload-fixtures.json', 'target inventory REST route-family discovery must link payload fixtures');

assert.equal(restCrudPayloadFixtures.schema, 'homeboy-rigs/woocommerce-rest-crud-payload-fixtures/v1', 'REST CRUD payload fixtures schema drifted');
assert.equal(restCrudPayloadFixtures.status, 'blocked_declarative', 'REST CRUD payload fixtures must stay blocked/declarative');
assert.equal(restCrudPayloadFixtures.runner_behavior, 'none', 'REST CRUD payload fixtures must not claim runner behavior');
assert.equal(restCrudPayloadFixtures.route_family_catalog_manifest, 'manifests/rest-crud-route-family-catalog.json', 'REST CRUD payload fixtures must link the route-family catalog');
assert.equal(restCrudPayloadFixtures.fixture_plan_manifest, 'manifests/rest-crud-fixture-plan.json', 'REST CRUD payload fixtures must link the generated fixture-plan artifact');
assert.equal(restCrudPayloadFixtures.rest_mutation_fixture_opt_ins_manifest, 'manifests/rest-crud-fixture-opt-ins.json', 'REST CRUD payload fixtures must link the generated REST mutation opt-in artifact');
assert.ok(restCrudPayloadFixtures.generic_upstream_contracts.includes('wp-codebox/fuzz-fixture-plan/v1'), 'REST CRUD payload fixtures must name the WP Codebox fixture-plan contract');
assert.ok(restCrudPayloadFixtures.generic_upstream_contracts.includes('wp-codebox/rest-mutation-fixture-opt-in/v1'), 'REST CRUD payload fixtures must name the WP Codebox REST mutation opt-in contract');
assertProfileReadiness(restCrudPayloadFixtures.readiness, 'rest-crud-payload-fixtures.readiness');
assert.equal(restCrudPayloadFixtures.readiness?.level, 'declared', 'REST CRUD payload fixtures must not be executable before generic mutation runner support');
assertFuzzProofBundleRequirements(restCrudPayloadFixtures.readiness?.proof_bundle_requirements, { file: 'rest-crud-payload-fixtures readiness' });
assert.ok(restCrudPayloadFixtures.readiness?.upstream_blockers?.some((blocker) => blocker.includes('Generic REST mutation runner')), 'REST CRUD payload fixtures must name the generic REST mutation runner blocker');
assert.ok(restCrudPayloadFixtures.readiness?.upstream_blockers?.some((blocker) => blocker.includes('delete-boundary')), 'REST CRUD payload fixtures must name the delete-boundary blocker');
assert.deepEqual(targetInventory.discovery_manifests?.rest_payload_fixtures?.family_ids, restCrudPayloadFixtures.families.map((family) => family.id), 'target inventory payload fixture family ids drifted');
assert.deepEqual(targetInventory.discovery_manifests?.rest_payload_fixtures?.readiness, restCrudPayloadFixtures.readiness, 'target inventory payload fixture readiness drifted');
assert.equal(targetInventory.discovery_manifests?.rest_payload_fixtures?.fixture_plan_manifest, 'manifests/rest-crud-fixture-plan.json', 'target inventory must link generated REST CRUD fixture plan');
assert.equal(targetInventory.discovery_manifests?.rest_payload_fixtures?.rest_mutation_fixture_opt_ins_manifest, 'manifests/rest-crud-fixture-opt-ins.json', 'target inventory must link generated REST mutation opt-ins');
assertRestCrudFixturePlanContract(restCrudFixturePlan, restCrudPayloadFixtures);
assertRestMutationFixtureOptInsContract(restCrudFixtureOptIns, restCrudPayloadFixtures, restCrudRouteFamilyCatalog);

const payloadFixtureFamilies = new Map(restCrudPayloadFixtures.families.map((family) => [family.id, family]));
assert.deepEqual(new Set(payloadFixtureFamilies.keys()), new Set(['products', 'orders', 'customers', 'coupons']), 'REST CRUD payload fixture families must cover product/order/customer/coupon');
const routeFamilyIds = new Set(restCrudRouteFamilyCatalog.route_families.map((family) => family.id));
for (const family of restCrudPayloadFixtures.families) {
  assert.equal(family.namespace, 'wc/v3', `${family.id} payload fixture family must target wc/v3`);
  assert.deepEqual(family.roles, ['administrator', 'shop_manager'], `${family.id} payload fixture family must declare Woo REST roles`);
  assert.ok(Array.isArray(family.route_family_ids) && family.route_family_ids.length > 0, `${family.id} payload fixture family requires route_family_ids`);
  assert.ok(family.payload_shapes?.create?.length > 0, `${family.id} payload fixture family requires create payload shapes`);
  assert.ok(family.payload_shapes?.update?.length > 0, `${family.id} payload fixture family requires update payload shapes`);
  assert.ok(family.payload_shapes?.delete?.length > 0, `${family.id} payload fixture family requires delete payload shapes`);
  for (const routeFamilyId of family.route_family_ids) {
    assert.ok(routeFamilyIds.has(routeFamilyId), `${family.id} payload fixture references unknown route family ${routeFamilyId}`);
  }
  assert.deepEqual(family.executable_operations, [], `${family.id} payload fixtures must not claim executable mutations`);
  for (const operation of ['create', 'update', 'delete']) {
    assert.match(family.blocked_operations?.[operation] || '', /generic REST mutation runner|wp-codebox\/fuzz-fixture-plan\/v1|rollback\/isolation|delete-boundary rollback artifact/, `${family.id} ${operation} blocker must name upstream primitives`);
  }
}

for (const family of restCrudRouteFamilyCatalog.route_families) {
  assert.ok(Array.isArray(family.fixture_requirements) && family.fixture_requirements.length > 0, `${family.id} must declare fixture requirements`);
  assert.ok(Array.isArray(family.owned_by?.workloads) && family.owned_by.workloads.length > 0, `${family.id} must declare owning workloads`);
  for (const workloadId of family.owned_by.workloads) {
    assert.ok(declaredIds.has(workloadId), `${family.id} owner workload ${workloadId} must be declared`);
  }
  assert.ok(family.readiness?.delete, `${family.id} must declare delete readiness`);
  for (const operation of ['create', 'read', 'update', 'delete']) {
    assertFuzzReadinessLevel(family.readiness?.[operation]?.level, `${family.id} ${operation} readiness level`);
  }
  if (['products-collection', 'products-batch', 'product-variations-batch'].includes(family.id)) {
    assert.equal(family.mutation_contract?.primitive, 'wordpress.rollback-safe-rest-mutation', `${family.id} must consume the generic rollback-safe REST mutation primitive`);
    assert.deepEqual(family.mutation_contract?.rollback_artifacts, ['raw_result'], `${family.id} must declare raw_result as the rollback artifact`);
    const familyHasDeleteBoundaryContracts = hasDeleteBoundaryContractRefs(family.mutation_contract);
    assert.deepEqual(
      family.mutation_contract?.executable_operations,
      familyHasDeleteBoundaryContracts ? ['create', 'update', 'delete'] : ['create', 'update'],
      `${family.id} executable operations must match declared rollback/delete-boundary contract refs`
    );
    assert.equal(family.payload_fixtures?.namespace, 'wc/v3', `${family.id} payload fixtures must declare wc/v3 namespace`);
    assert.deepEqual(family.payload_fixtures?.roles, ['administrator', 'shop_manager'], `${family.id} payload fixtures must declare Woo REST roles`);
    if (familyHasDeleteBoundaryContracts) {
      assert.equal(family.payload_fixtures?.delete?.level, 'executable', `${family.id} delete payload fixture must be executable when delete-boundary contract refs are present`);
      assert.deepEqual(family.mutation_contract?.delete_boundary_rollback_artifacts, ['wp-codebox/delete-boundary-artifact/v1'], `${family.id} executable delete requires delete-boundary rollback artifacts`);
    } else {
      assert.equal(family.payload_fixtures?.delete?.level, 'declared', `${family.id} delete payload fixture must remain declared without delete-boundary contract refs`);
      assert.match(family.payload_fixtures?.delete?.upstream_blocker || '', /delete-boundary rollback artifact|current workload does not execute delete/, `${family.id} delete payload fixture must name the precise delete blocker`);
    }
  }
  if (family.payload_fixture_family) {
    assert.ok(payloadFixtureFamilies.has(family.payload_fixture_family), `${family.id} payload_fixture_family must exist in the payload fixture manifest`);
  }
  if (family.readiness.delete.level === 'executable') {
    assert.ok(family.mutation_contract?.delete_boundary_rollback_artifacts?.length > 0, `${family.id} executable delete requires delete-boundary rollback artifacts`);
  } else {
    assert.match(family.readiness.delete.upstream_blocker || '', /delete-boundary rollback artifacts|current workload does not execute delete/, `${family.id} blocked delete must name the precise delete-boundary blocker`);
  }
}

assert.equal(blockInventoryRenderingFuzz.schema, 'homeboy-rigs/woocommerce-block-inventory-rendering-fuzz/v1', 'block inventory/rendering fuzz schema drifted');
assert.ok(blockInventoryRenderingFuzz.block_name_prefixes.includes('woocommerce/'), 'block inventory/rendering fuzz must target WooCommerce blocks');
assert.ok(blockInventoryRenderingFuzz.frontend_contexts.includes('checkout'), 'block inventory/rendering fuzz must include checkout context');
assert.equal(blockInventoryRenderingFuzz.readiness?.inventory?.level, 'declared', 'block inventory readiness drifted');
assert.equal(blockInventoryRenderingFuzz.readiness?.rendering?.level, 'executable', 'block rendering readiness drifted');
assert.equal(blockInventoryRenderingFuzz.readiness?.mutation?.level, 'declared', 'block mutation readiness drifted');
assert.deepEqual(targetInventory.targets.blocks.block_name_prefixes, blockInventoryRenderingFuzz.block_name_prefixes, 'target inventory block prefixes must come from block inventory manifest');
assert.deepEqual(targetInventory.targets.blocks.frontend_contexts, blockInventoryRenderingFuzz.frontend_contexts, 'target inventory block contexts must come from block inventory manifest');
assert.deepEqual(targetInventory.discovery_manifests?.blocks?.readiness, blockInventoryRenderingFuzz.readiness, 'target inventory block discovery readiness drifted');
for (const workloadId of blockInventoryRenderingFuzz.owned_by.workloads) {
  assertDeclaredOrExternalDiscoveryWorkload(workloadId, 'block inventory discovery');
}

assert.equal(adminActionInventory.schema, 'homeboy-rigs/woocommerce-admin-action-inventory/v1', 'admin action inventory schema drifted');
assert.ok(adminActionInventory.action_families.some((family) => family.id === 'admin-menu-get-pages' && family.readiness?.level === 'executable'), 'admin action inventory must include executable GET-only admin menu coverage');
assert.ok(adminActionInventory.skip_reason_codes.includes('payment_submission'), 'admin action inventory must classify payment submission skips');
assert.deepEqual(targetInventory.discovery_manifests?.admin_actions?.action_family_ids, adminActionInventory.action_families.map((family) => family.id), 'target inventory admin action discovery ids drifted');
for (const family of adminActionInventory.action_families) {
  assertDeclaredOrExternalDiscoveryWorkload(family.workload, `admin action ${family.id}`);
  assertFuzzReadinessLevel(family.readiness?.level, `admin action ${family.id} readiness level`);
}
assert.deepEqual(targetInventory.discovery_manifests?.db_api_hotspots?.readiness, dbApiHotspotArtifactIo.readiness, 'target inventory DB/API hotspot discovery readiness drifted');
assert.equal(targetInventory.targets.performance_hotspots.artifact_io_manifest, 'manifests/db-api-hotspot-artifact-io.json', 'target inventory must link DB/API hotspot artifact IO manifest');
assert.equal(codeboxSuite.cases?.[0]?.input?.generated_from?.route_inventory_artifact, 'route_inventory');
assert.equal(codeboxSuite.cases?.[0]?.input?.generated_from?.request_cases_artifact, 'rest_request_cases');
assert.equal(codeboxSuite.cases?.[0]?.input?.generated_from?.query_attribution_artifact, 'rest_schema_query_attribution');
assert.equal(codeboxSuite.cases?.[0]?.metadata?.proof_status, 'declared_contract');
assert.equal(codeboxSuite.metadata?.readiness_level, 'declared');
assert.equal(codeboxSuite.metadata?.proof_status, 'declared_contract');
assertNoProofPlaceholders(codeboxSuite, 'codebox suite');

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
