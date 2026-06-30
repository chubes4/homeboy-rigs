import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertArtifactPostprocessWorkloadContract,
  assertFullSurfaceCoverageManifest,
} from '../../../scripts/fuzz-manifest-helpers.mjs';
import {
  assertWooRequiredFuzzProofContracts,
  wooRequiredFuzzProofContracts,
} from '../tools/fuzz-proof-contracts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const repoRoot = path.join(packageRoot, '..', '..');

process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST = path.join(repoRoot, 'scripts/fixtures/homeboy-extension-wordpress/lib/helper-manifest.js');
delete process.env.HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR;

const manifest = JSON.parse(readFileSync(path.join(__dirname, 'full-surface-coverage.json'), 'utf8'));
const performanceRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-performance/rig.json'), 'utf8'));
const browserRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-browser-coverage/rig.json'), 'utf8'));
const generatedRestCases = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/generated-rest-request-cases.json'), 'utf8'));
const codeboxFuzzSuiteWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/codebox-fuzz-suite-contract.json'), 'utf8'));
const codeboxFuzzSuiteManifest = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/codebox-fuzz-suite-contract.json'), 'utf8'));
const dbApiFuzzCampaign = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/db-api-fuzz-campaign.json'), 'utf8'));
const aggressiveIsolatedCampaign = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/aggressive-isolated-fuzz-campaign.json'), 'utf8'));
const aggressiveDestructiveWorkloads = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/aggressive-destructive-workloads.json'), 'utf8'));
const restCrudRouteFamilyCatalog = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/rest-crud-route-family-catalog.json'), 'utf8'));
const restCrudFixturePlan = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/rest-crud-fixture-plan.json'), 'utf8'));
const restCrudPayloadFixtures = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/rest-crud-payload-fixtures.json'), 'utf8'));
const targetInventory = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/target-inventory.json'), 'utf8'));
const productChaosSequencePacks = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/product-chaos-sequence-packs.json'), 'utf8'));
const performanceHotspots = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/performance-hotspots-artifact-summary.json'), 'utf8'));
const restDbQueryProfileWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'bench/rest-db-query-profile.workload.json'), 'utf8'));
const coverageGapReport = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/coverage-gap-report.json'), 'utf8'));
const coverageGapReportWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'bench/coverage-gap-report.workload.json'), 'utf8'));
const performanceHotspotsWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'bench/performance-hotspots-artifact-summary.workload.json'), 'utf8'));
const runtimePrepScript = readFileSync(path.join(packageRoot, 'tools/prepare-runtime-dependency.sh'), 'utf8');

const workloadIdFromPath = (workloadPath) => path.basename(workloadPath, path.extname(workloadPath));
const genericExecutableReadinessStates = new Set([
  'targeted_workload_executable',
  'isolated_mutation_executable',
  'destructive_isolated_executable',
  'sensitive_isolated_executable',
  'executable_in_isolated_sandbox',
]);

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
  for (const workloadId of wooRequiredFuzzProofContracts.keys()) {
    const workloadPath = path.join(packageRoot, 'fuzz', `${workloadId}.json`);
    const workload = JSON.parse(readFileSync(workloadPath, 'utf8'));

    assertWooRequiredFuzzProofContracts(workload);
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

test('Woo Composer prep delegates to Homeboy dependency install primitive', () => {
  const composerRequirements = [
    ...performanceRig.pipeline.check,
    ...performanceRig.pipeline.fuzz_prepare,
  ].filter((step) => step.label === 'WooCommerce Composer package autoloader exists or can be prepared');

  assert.equal(composerRequirements.length, 2);
  for (const requirement of composerRequirements) {
    assert.match(requirement.prepare_command, /prepare-runtime-dependency\.sh" composer/);
  }

  assert.match(runtimePrepScript, /homeboy deps install --path "\$woocommerce_plugin_source"/);
  assert.doesNotMatch(runtimePrepScript, /composer --working-dir=.* install/);
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

test('REST DB query profile consumes generated request case artifacts with caps', () => {
  const profilerSteps = restDbQueryProfileWorkload.run.filter((step) => (
    step.type === 'rest-db-query-profiler'
  ));

  assert.equal(profilerSteps.length, 1);
  for (const step of profilerSteps) {
    assert.equal(step.rest_request_cases, undefined, `${step.type} must not fall back to hard-coded route cases`);
    assert.equal(step.rest_request_cases_source.type, 'artifact');
    assert.equal(step.rest_request_cases_source.schema, 'homeboy/wordpress-rest-request-cases/v1');
    assert.deepEqual(step.rest_request_cases_source.artifact_globs, ['generated-rest-request-cases/*.json']);
    assert.equal(step.rest_request_cases_source.maxRouteCases, 80);
    assert.equal(step.rest_request_cases_source.maxArtifactBytes, 1048576);
    assert.equal(step.sampleLimit, 50);
    assert.equal(step.fallback_policy, 'require_generated_rest_request_cases_artifact');
  }
});

test('coverage gap and hotspot reports declare the generic artifact postprocess contract', () => {
  assert.equal(coverageGapReport.metadata.readiness.level, 'executable');
  assert.equal(coverageGapReport.workload.path, '${package.root}/bench/coverage-gap-report.workload.json');
  assert.equal(coverageGapReport.workload.type, 'json');
  assert.equal(coverageGapReport.safety_class, 'read_only');
  assert.equal(coverageGapReport.artifacts.expected[0].name, 'coverage_gap_report');
  assertArtifactPostprocessWorkloadContract(coverageGapReportWorkload, {
    id: 'coverage-gap-report',
    action: 'coverage-gap-report',
    artifact: 'coverage_gap_report',
    outputPath: 'coverage-gap-report/coverage_gap_report.json',
    schema: 'homeboy-rigs/wordpress-coverage-gap-report/v1',
  });

  assert.equal(performanceHotspots.metadata.readiness.level, 'executable');
  assert.equal(performanceHotspots.workload.path, '${package.root}/bench/performance-hotspots-artifact-summary.workload.json');
  assert.equal(performanceHotspots.workload.type, 'json');
  assert.equal(performanceHotspots.safety_class, 'read_only');
  assert.equal(performanceHotspots.artifacts.expected[0].name, 'performance_hotspots_summary');
  assertArtifactPostprocessWorkloadContract(performanceHotspotsWorkload, {
    id: 'performance-hotspots-artifact-summary',
    action: 'performance-hotspots-summary',
    artifact: 'performance_hotspots_summary',
    outputPath: 'performance-hotspots-artifact-summary/performance_hotspots_summary.json',
    schema: 'homeboy/woocommerce-performance-hotspots-summary/v1',
  });
});

test('DB/API campaign consumes executable Codebox fixture contracts without proof refs', () => {
  assert.equal(dbApiFuzzCampaign.suite_manifest, 'manifests/codebox-fuzz-suite-contract.json');
  assert.equal(codeboxFuzzSuiteWorkload.metadata.fixture.suite_manifest, '${package.root}/manifests/codebox-fuzz-suite-contract.json');
  assert.equal(codeboxFuzzSuiteManifest.target.metadata.proof_bundle, undefined);
  assert.equal(codeboxFuzzSuiteManifest.target.metadata.proof_bundle_requirements.status, 'required_before_proven');
  assert.equal(codeboxFuzzSuiteManifest.target.metadata.profile.fixture_contracts.readiness_level, 'executable');
  assert.equal(codeboxFuzzSuiteManifest.target.metadata.profile.fixture_contracts.execution_enabled, true);
  assert.equal(codeboxFuzzSuiteWorkload.metadata.readiness.level, 'executable');
  assert.equal(codeboxFuzzSuiteWorkload.metadata.readiness.execution_enabled, true);
  assert.equal(performanceRig.fuzz_profile_metadata['db-api-performance-fuzzer'].fixture_contracts.execution_enabled, true);
  assert.equal(performanceRig.fuzz_profile_metadata['product-rest-crud-fuzzer'].fixture_contracts.execution_enabled, true);
  assert.equal(performanceRig.fuzz_profile_metadata['db-api-performance-fuzzer'].readiness.crud.create.level, 'executable');
  assert.equal(performanceRig.fuzz_profile_metadata['db-api-performance-fuzzer'].readiness.crud.update.level, 'executable');
  assert.equal(performanceRig.fuzz_profile_metadata['db-api-performance-fuzzer'].readiness.crud.delete.level, 'executable');
  assert.equal(performanceRig.fuzz_profile_metadata['product-rest-crud-fuzzer'].readiness.crud.delete.level, 'executable');
});

test('aggressive destructive Woo workloads declare isolation, dynamic IDs, and side-effect policy gates', () => {
  assert.equal(
    aggressiveIsolatedCampaign.fixture_sources.aggressive_destructive_workloads,
    'manifests/aggressive-destructive-workloads.json'
  );
  assert.equal(aggressiveDestructiveWorkloads.execution_scope, 'offloaded_codebox_homeboy_hbex_isolated_sandbox');
  assert.equal(aggressiveDestructiveWorkloads.local_execution_enabled, false);
  assert.equal(aggressiveDestructiveWorkloads.destructive_full_coverage_proven, false);
  assert.equal(aggressiveDestructiveWorkloads.readiness.level, 'executable');
  assert.equal(aggressiveDestructiveWorkloads.readiness.execution_enabled, true);
  assert.deepEqual(aggressiveDestructiveWorkloads.readiness.missing_upstream_contracts, []);
  assert.ok(aggressiveDestructiveWorkloads.readiness.contract_ids.includes('homeboy/isolation-proof/v1'));
  assert.ok(aggressiveDestructiveWorkloads.readiness.contract_ids.includes('wp-codebox/sandbox-isolation-proof/v1'));
  assert.ok(aggressiveDestructiveWorkloads.readiness.contract_ids.includes('homeboy/wordpress-fuzz-runtime-workload-operation/v1'));
  assert.equal(aggressiveDestructiveWorkloads.readiness.proof_bundle_requirements.status, 'required_before_proven');
  assert.equal(aggressiveDestructiveWorkloads.dynamic_id_policy.scope, 'fixture_owned_only');
  assert.equal(aggressiveDestructiveWorkloads.dynamic_id_policy.placeholder_ids_allowed, false);
  assert.equal(aggressiveDestructiveWorkloads.dynamic_id_policy.foreign_ids_allowed, false);

  const requiredWorkloadIds = new Set([
    'product-variation-destructive-lifecycle',
    'order-refund-destructive-lifecycle',
    'coupon-customer-destructive-lifecycle',
    'stock-inventory-destructive-lifecycle',
    'cart-checkout-session-destructive-lifecycle',
    'hpos-order-table-destructive-lifecycle',
    'action-scheduler-destructive-lifecycle',
  ]);
  assert.deepEqual(new Set(aggressiveDestructiveWorkloads.workloads.map((workload) => workload.id)), requiredWorkloadIds);

  const requiredArtifacts = new Set(aggressiveDestructiveWorkloads.required_artifacts_per_workload);
  for (const artifact of [
    'disposable_sandbox_boundary',
    'mutation_isolation_artifact',
    'delete_boundary_artifact',
    'fixture_dynamic_id_manifest',
    'side_effect_policy_evidence',
    'destructive_case_ledger',
    'sandbox_teardown_evidence',
    'artifact_bundle_ref',
  ]) {
    assert.ok(requiredArtifacts.has(artifact), `global destructive workload artifact requirements must include ${artifact}`);
  }

  for (const workload of aggressiveDestructiveWorkloads.workloads) {
    assert.ok(workload.fixture_family, `${workload.id} must bind to a fixture family`);
    assert.ok(workload.fixture_dynamic_ids.length > 0, `${workload.id} must use fixture-owned dynamic IDs`);
    assert.ok(workload.disposable_mutation_scope.length > 0, `${workload.id} must declare disposable mutation scope`);
    for (const artifact of requiredArtifacts) {
      assert.ok(workload.required_artifacts.includes(artifact), `${workload.id} must require ${artifact}`);
    }
  }
});

test('REST CRUD fixture plan advertises executable state only through explicit upstream contracts', () => {
  assert.equal(restCrudFixturePlan.metadata.execution_enabled, true);
  assert.equal(restCrudFixturePlan.metadata.readiness_level, 'executable');
  assert.equal(restCrudPayloadFixtures.status, 'contract_backed_executable');
  assert.equal(restCrudPayloadFixtures.readiness.level, 'executable');
  assert.equal(restCrudPayloadFixtures.readiness.execution_enabled, true);
  assert.equal(restCrudPayloadFixtures.readiness.upstream_blockers, undefined);
  assert.ok(restCrudFixturePlan.metadata.contract_ids.includes('homeboy/isolation-proof/v1'));
  assert.ok(restCrudFixturePlan.metadata.contract_ids.includes('wp-codebox/sandbox-isolation-proof/v1'));

  const surfaces = targetInventory.discovery_manifests.product_surface_taxonomy.surfaces;
  const surfaceByResourceKind = new Map([
    ['product', 'products'],
    ['order', 'orders'],
    ['customer', 'customers'],
    ['coupon', 'coupons'],
  ]);

  for (const operation of restCrudFixturePlan.operations) {
    assert.equal(operation.expected.execute, true, `${operation.id} must be contract-backed executable`);
    assert.equal(operation.expected.readiness_level, 'executable', `${operation.id} readiness drifted`);
    assert.ok(operation.expected.contract_ids.includes('homeboy/isolation-proof/v1'), `${operation.id} must wire Homeboy isolation proof`);
    assert.ok(operation.expected.contract_ids.includes('wp-codebox/sandbox-isolation-proof/v1'), `${operation.id} must wire WP Codebox sandbox isolation proof`);
    const surfaceId = surfaceByResourceKind.get(operation.resource.kind);
    assert.ok(surfaceId, `${operation.id} must map to a target inventory surface`);
    const state = surfaces[surfaceId].operation_readiness[operation.metadata.operation];
    assert.ok(state, `${operation.id} must declare ${operation.metadata.operation} readiness`);
    assert.ok(genericExecutableReadinessStates.has(state), `${operation.id} must map to contract-backed executable target inventory state`);
  }

  for (const family of restCrudPayloadFixtures.families) {
    assert.deepEqual(family.executable_operations, ['create', 'update', 'delete']);
    assert.equal(family.blocked_operations, undefined, `${family.id} must not fake blocked operations for available contracts`);
  }

  assert.equal(targetInventory.discovery_manifests.rest_payload_fixtures.readiness.level, 'executable');
  assert.equal(targetInventory.discovery_manifests.rest_payload_fixtures.readiness.execution_enabled, true);
  assert.equal(targetInventory.discovery_manifests.rest_payload_fixtures.readiness.upstream_blockers, undefined);
  assert.equal(targetInventory.discovery_manifests.rest_route_families.readiness.level, 'executable');
  assert.equal(targetInventory.discovery_manifests.rest_route_families.readiness.execution_enabled, true);

  assert.equal(productChaosSequencePacks.execution_enabled, true);
  assert.equal(productChaosSequencePacks.readiness.execution_enabled, true);
  assert.equal(aggressiveIsolatedCampaign.readiness.execution_enabled, true);
  assert.equal(performanceRig.fuzz_profile_metadata['aggressive-isolated-firehose'].readiness.execution_enabled, true);
  assert.equal(targetInventory.discovery_manifests.product_chaos_sequence_packs.readiness.execution_enabled, true);

  for (const family of aggressiveIsolatedCampaign.fixture_families) {
    assert.ok(genericExecutableReadinessStates.has(family.readiness), `${family.id} fixture family must wire executable upstream contracts`);
  }
  for (const sequencePack of productChaosSequencePacks.sequence_packs) {
    assert.ok(genericExecutableReadinessStates.has(sequencePack.readiness), `${sequencePack.id} sequence pack must wire executable upstream contracts`);
  }
});

test('REST CRUD route family catalog matches executable fixture-plan state', () => {
  const staleContractLanguage = /missing_generic_rest_mutation_runner|generic REST mutation runner|upstream_blocker|rollback|revert/i;
  const manifestTexts = [
    JSON.stringify(restCrudRouteFamilyCatalog),
    JSON.stringify(restCrudPayloadFixtures),
    JSON.stringify(targetInventory.discovery_manifests.rest_route_families),
    JSON.stringify(targetInventory.discovery_manifests.rest_payload_fixtures),
    JSON.stringify(codeboxFuzzSuiteManifest),
    JSON.stringify(codeboxFuzzSuiteWorkload.metadata.readiness),
    JSON.stringify(performanceRig.fuzz_profile_metadata['aggressive-isolated-firehose']),
    JSON.stringify(performanceRig.fuzz_profile_metadata['db-api-performance-fuzzer']),
    JSON.stringify(performanceRig.fuzz_profile_metadata['product-rest-crud-fuzzer']),
  ];

  for (const text of manifestTexts) {
    assert.doesNotMatch(text.replaceAll(/"rollback_artifacts":\[[^\]]*\],?/g, ''), staleContractLanguage);
  }

  const expectedFamilies = new Set(targetInventory.discovery_manifests.rest_route_families.route_family_ids);
  assert.deepEqual(new Set(restCrudRouteFamilyCatalog.route_families.map((family) => family.id)), expectedFamilies);

  const fixtureOperationsByFamily = new Map();
  for (const family of restCrudPayloadFixtures.families) {
    for (const routeFamilyId of family.route_family_ids) {
      fixtureOperationsByFamily.set(routeFamilyId, family.executable_operations);
    }
  }

  for (const routeFamily of restCrudRouteFamilyCatalog.route_families) {
    const executableOperations = fixtureOperationsByFamily.get(routeFamily.id);
    assert.ok(executableOperations, `${routeFamily.id} must map to payload fixture operations`);
    for (const operation of executableOperations) {
      assert.equal(
        routeFamily.readiness?.[operation]?.level,
        'executable',
        `${routeFamily.id} ${operation} readiness must agree with executable fixture operations`
      );
    }
    assert.deepEqual(routeFamily.mutation_contract?.executable_operations, executableOperations);
  }
});

test('aggressive destructive Woo workloads cover required destructive surface families', () => {
  const workloadSurfaces = new Map(
    aggressiveDestructiveWorkloads.workloads.map((workload) => [workload.id, new Set(workload.surfaces)])
  );

  assert.ok(workloadSurfaces.get('product-variation-destructive-lifecycle').has('variations'));
  assert.ok(workloadSurfaces.get('order-refund-destructive-lifecycle').has('refunds'));
  assert.ok(workloadSurfaces.get('coupon-customer-destructive-lifecycle').has('customers'));
  assert.ok(workloadSurfaces.get('stock-inventory-destructive-lifecycle').has('inventory'));
  assert.ok(workloadSurfaces.get('cart-checkout-session-destructive-lifecycle').has('sessions'));
  assert.ok(workloadSurfaces.get('hpos-order-table-destructive-lifecycle').has('hpos'));
  assert.ok(workloadSurfaces.get('action-scheduler-destructive-lifecycle').has('action_scheduler'));

  const hposMutationScope = new Set(
    aggressiveDestructiveWorkloads.workloads.find((workload) => workload.id === 'hpos-order-table-destructive-lifecycle').disposable_mutation_scope
  );
  assert.ok(hposMutationScope.has('wp_wc_orders'));
  assert.ok(hposMutationScope.has('wp_wc_order_addresses'));
  assert.ok(hposMutationScope.has('wp_wc_order_operational_data'));

  const actionSchedulerMutationScope = new Set(
    aggressiveDestructiveWorkloads.workloads.find((workload) => workload.id === 'action-scheduler-destructive-lifecycle').disposable_mutation_scope
  );
  assert.ok(actionSchedulerMutationScope.has('wp_actionscheduler_actions'));
  assert.ok(actionSchedulerMutationScope.has('wp_actionscheduler_claims'));
  assert.ok(actionSchedulerMutationScope.has('wp_actionscheduler_logs'));
});

test('external side-effect policy blocks live effects and requires skip or isolated mock evidence', () => {
  assert.equal(aggressiveDestructiveWorkloads.side_effect_policy.live_external_effects_allowed, false);
  assert.equal(aggressiveDestructiveWorkloads.side_effect_policy.required_artifact, 'side_effect_policy_evidence');

  const policies = new Map(
    aggressiveDestructiveWorkloads.side_effect_policy.surfaces.map((surface) => [surface.id, surface])
  );
  for (const policyId of ['payment', 'tax', 'shipping', 'webhook', 'marketplace', 'credential_bearing_settings']) {
    const policy = policies.get(policyId);
    assert.ok(policy, `${policyId} side-effect policy must be declared`);
    assert.ok(policy.blocked_live_effects.length > 0, `${policyId} policy must list blocked live effects`);
    assert.ok(policy.allowed_evidence.includes('safe_skip_artifact'), `${policyId} policy must allow safe skip evidence`);
  }

  assert.ok(policies.get('payment').allowed_evidence.includes('isolated_mock_execution_artifact'));
  assert.deepEqual(policies.get('marketplace').allowed_evidence, ['safe_skip_artifact']);
  assert.deepEqual(policies.get('credential_bearing_settings').allowed_evidence, ['safe_skip_artifact']);

  for (const workload of aggressiveDestructiveWorkloads.workloads) {
    for (const policyId of workload.side_effect_surfaces) {
      assert.ok(policies.has(policyId), `${workload.id} references unknown side-effect policy ${policyId}`);
      assert.ok(
        workload.required_artifacts.includes(aggressiveDestructiveWorkloads.side_effect_policy.required_artifact),
        `${workload.id} must require side-effect evidence when referencing ${policyId}`
      );
    }
  }
});
