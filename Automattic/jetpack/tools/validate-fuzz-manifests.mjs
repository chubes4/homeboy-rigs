#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFullSurfaceCoverageManifest,
  assertGenericFuzzManifest,
  collectFuzzManifests,
  declaredBenchProfileIds,
  declaredBenchWorkloadIds,
  declaredFuzzIds,
  fuzzManifestHasExecutableArtifactContract,
  readJson,
} from '../../../scripts/fuzz-manifest-helpers.mjs';
import { assertJetpackFuzzManifestReadinessContract } from './fuzz-workload-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const apiRig = readJson(packageRoot, 'rigs/jetpack-api-route-inventory/rig.json');
const browserRig = readJson(packageRoot, 'rigs/jetpack-browser-coverage/rig.json');
const fullSurfaceCoverage = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const restRouteCoverage = readJson(packageRoot, 'manifests/rest-route-coverage.json');
const stableWorkloads = readJson(packageRoot, 'manifests/stable-workloads.json');
const legacyLabCommandGeneratorKey = 'lab_' + 'command_generator';
const generatedRestCases = readJson(packageRoot, 'bench/generated-rest-request-cases.workload.json');
const dbInventory = readJson(packageRoot, 'bench/db-inventory.workload.json');
const fuzzManifests = collectFuzzManifests(packageRoot);
const warnings = [];

const expectedFuzzIds = new Set([
  'db-inventory',
  'generated-rest-request-cases',
  'jetpack-admin-page-coverage',
  'jetpack-connected-disconnected-fixtures',
  'jetpack-cron-sync-actions',
  'jetpack-external-http-guardrail',
  'jetpack-module-option-table-inventory',
  'jetpack-module-state-matrix',
  'jetpack-options-matrix',
  'jetpack-performance-observation',
  'jetpack-public-module-frontend-coverage',
  'jetpack-rest-route-inventory',
  'jetpack-sync-queue-coverage',
  'rest-db-query-profile',
]);

const expectedBrowserScenarios = new Set([
  'dashboard',
  'connection',
  'modules',
  'settings',
  'public_post_modules',
  'public_page_modules',
]);

const expectedStableWorkloadIds = new Set([
  'admin-and-public-coverage',
  'db-and-module-inventory',
  'external-http-guardrail',
  'rest-db-query-profile',
]);

assertFullSurfaceCoverageManifest(fullSurfaceCoverage, { file: 'Jetpack full-surface coverage' });
assert.equal(fuzzManifests.length, expectedFuzzIds.size, 'expected one Jetpack fuzz manifest per declared API fuzz workload');
assert.equal(apiRig.bench_workloads, undefined, 'Jetpack fuzz coverage must not use bench_workloads as a fallback');
assert.equal(apiRig.bench_profiles, undefined, 'Jetpack fuzz coverage must not use bench_profiles as a fallback');
assert.equal(stableWorkloads.schema, 'homeboy-rigs/jetpack-stable-workloads/v1', 'Jetpack stable workload schema drifted');
assert.equal(stableWorkloads.rig, 'rigs/jetpack-api-route-inventory/rig.json', 'Jetpack stable workloads must target API inventory rig');
assert.equal(stableWorkloads[legacyLabCommandGeneratorKey], undefined, 'Jetpack stable workload planning must use homeboy fuzz stable-plan directly');

const declaredIds = declaredFuzzIds(apiRig);
const benchWorkloadIds = declaredBenchWorkloadIds(apiRig);
const benchProfileIds = declaredBenchProfileIds(apiRig);
const actualFuzzIds = new Set(fuzzManifests.map(({ manifest }) => manifest.id));
const profile = fullSurfaceCoverage.coverage_profiles['full-surface'];
const profileFuzzIds = new Set(Object.entries(profile)
  .filter(([surface]) => surface !== 'browser_requests')
  .flatMap(([, workloadIds]) => workloadIds));

assert.deepEqual(actualFuzzIds, expectedFuzzIds, 'Jetpack fuzz manifest ids drifted');
assert.deepEqual(declaredIds, expectedFuzzIds, 'rig fuzz_workloads.wordpress ids drifted');
assert.deepEqual(profileFuzzIds, expectedFuzzIds, 'Jetpack full-surface fuzz workload mapping drifted');
assert.deepEqual(new Set(profile.browser_requests), expectedBrowserScenarios, 'Jetpack full-surface browser scenarios drifted');
assert.deepEqual(new Set(browserRig.trace_profiles['full-surface']), new Set(['jetpack-browser-coverage']), 'Jetpack browser full-surface trace profile drifted');
assertJetpackStableWorkloads(stableWorkloads, expectedStableWorkloadIds, expectedFuzzIds);

for (const scenario of expectedBrowserScenarios) {
  assert.ok(
    readdirSync(path.join(packageRoot, 'browser-scenarios')).includes(`${scenario}.json`),
    `${scenario} browser scenario file is missing`
  );
}

for (const [surface, workloadIds] of Object.entries(profile)) {
  if (surface === 'browser_requests') {
    continue;
  }

  for (const workloadId of workloadIds) {
    assert.ok(declaredIds.has(workloadId), `${workloadId} full-surface profile entry must route through fuzz_workloads.wordpress`);
    assert.equal(fullSurfaceCoverage.workloads?.[workloadId]?.surface, surface, `${workloadId} full-surface workload metadata surface drifted`);
  }
}

for (const [workloadId, metadata] of Object.entries(fullSurfaceCoverage.workloads || {})) {
  assert.equal(typeof metadata.coverage_shape, 'string', `${workloadId} coverage_shape must be reviewer-readable`);
  assert.ok(metadata.coverage_shape.length > 24, `${workloadId} coverage_shape must not be a placeholder`);
  assert.ok(Array.isArray(metadata.safety?.notes) && metadata.safety.notes.length > 0, `${workloadId} safety notes are required`);
  assert.ok(Array.isArray(metadata.artifact_expectations?.required), `${workloadId} artifact_expectations.required must be an array`);
  assert.ok(metadata.artifact_expectations.required.length > 0, `${workloadId} must declare required artifact expectations`);
}

const workloadsById = new Map(fuzzManifests.map(({ file, manifest }) => [manifest.id, { file, manifest }]));

for (const { file, manifest } of fuzzManifests) {
  const runnerCase = assertGenericFuzzManifest(manifest, {
    file,
    declaredIds,
    benchWorkloadIds,
    benchProfileIds,
    targetSlug: 'jetpack',
    workloadTypes: ['php', 'json', 'generic'],
    requireCaseSafetyClass: true,
    requireCaseArtifacts: false,
    requireExpectedArtifacts: false,
    requireExpectedArtifactSemanticKeys: true,
  });

  assert.equal(manifest.metadata?.kind, 'wordpress-plugin-fuzz', `${manifest.id} metadata.kind mismatch`);
  assert.equal(manifest.metadata?.wordpress_runner, 'wp-codebox', `${manifest.id} metadata.wordpress_runner must be wp-codebox`);
  assert.equal(manifest.target?.component, 'jetpack', `${manifest.id} target.component mismatch`);
  assertJetpackFuzzManifestReadinessContract(manifest, { file });

  if (!manifest.metadata?.readiness) {
    warnings.push(`${manifest.id} does not declare metadata.readiness; treating coverage as declared, not proven`);
  }

  if (fuzzManifestHasExecutableArtifactContract(manifest)) {
    for (const artifact of runnerCase.artifacts) {
      if (artifact.required !== true) {
        warnings.push(`${manifest.id} case artifact ${artifact.name} is not required yet; proof readiness is incomplete`);
      }
    }
    for (const artifact of manifest.artifacts.expected) {
      if (artifact.required !== true) {
        warnings.push(`${manifest.id} expected artifact ${artifact.name} is not required yet; proof readiness is incomplete`);
      }
    }
  }

  assert.ok(manifest.artifacts.expected.some((artifact) => artifact.semantic_key === 'fuzz.report'), `${manifest.id} must declare a fuzz.report artifact contract`);
}

assert.deepEqual(new Set(restRouteCoverage.namespaces.map((entry) => entry.namespace)), new Set(['jetpack/v4', 'wpcom/v2']), 'Jetpack REST namespaces drifted');
assert.deepEqual(new Set(restRouteCoverage.target_selection.route_namespace_allowlist), new Set(['jetpack/v4', 'wpcom/v2']), 'Jetpack REST target namespace allowlist drifted');
assert.deepEqual(new Set(restRouteCoverage.target_selection.method_allowlist), new Set(['GET']), 'Jetpack REST generated cases must stay GET-only');
assert.ok(restRouteCoverage.target_selection.excluded_methods.includes('POST'), 'Jetpack REST mutating methods must remain excluded');
assert.ok(restRouteCoverage.artifact_expectations.required_for_executable.includes('rest_request_cases'), 'Jetpack REST executable cases require request-case artifacts');
assert.ok(restRouteCoverage.artifact_expectations.required_for_executable.includes('rest_skip_reasons'), 'Jetpack REST executable cases require skip-reason artifacts');
assert.ok(restRouteCoverage.artifact_expectations.optional_until_connected_fixture.includes('connected_site_response_samples'), 'connected-site samples must remain optional until fixtures exist');
assert.ok(restRouteCoverage.skip_reason_codes.includes('credential_unavailable'), 'Jetpack REST skip reasons must classify unavailable WP.com credentials');

const generatedCaseIds = new Set(generatedRestCases.rest_request_cases.map((restCase) => restCase.id));
for (const requiredCase of restRouteCoverage.required_generated_cases) {
  const generatedCase = generatedRestCases.rest_request_cases.find((restCase) => restCase.id === requiredCase.id);
  assert.ok(generatedCaseIds.has(requiredCase.id), `generated REST cases missing ${requiredCase.id}`);
  assert.equal(typeof requiredCase.permission_class, 'string', `${requiredCase.id} must classify permission boundary`);
  assert.equal(generatedCase.method, 'GET', `${requiredCase.id} generated request case must stay GET-only`);
  assert.equal(generatedCase.mutating, false, `${requiredCase.id} generated request case must not claim mutating coverage`);
  assert.equal(generatedCase.persona, requiredCase.persona, `${requiredCase.id} generated request case persona drifted`);
  if (requiredCase.skip_reason) {
    assert.equal(generatedCase.skip_reason, requiredCase.skip_reason, `${requiredCase.id} generated request case skip reason drifted`);
  }
}

assert.equal(generatedRestCases.metadata.mutating_methods_allowed, false, 'Jetpack generated REST workload must not allow mutating methods');
assert.equal(generatedRestCases.metadata.real_wpcom_credentials_allowed, false, 'Jetpack generated REST workload must not require real WP.com credentials');
assert.ok(generatedRestCases.metadata.required_artifacts.includes('rest_request_cases'), 'Jetpack generated REST workload must require request-case artifact');
assert.ok(generatedRestCases.metadata.required_artifacts.includes('rest_skip_reasons'), 'Jetpack generated REST workload must require skip-reason artifact');

const generatedRestManifest = manifestFor('generated-rest-request-cases');
assert.ok(generatedRestManifest.cases[0].inputs.skip_reason_codes.includes('connected_required'), 'generated REST fuzz manifest must declare connected skip reasons');
assert.equal(generatedRestManifest.cases[0].inputs.real_wpcom_credentials_allowed, false, 'generated REST fuzz manifest must not allow real WP.com credentials');
assert.equal(generatedRestManifest.cases[0].inputs.mutating_methods_allowed, false, 'generated REST fuzz manifest must not allow mutating methods');
assert.ok(generatedRestManifest.cases[0].artifacts.every((artifact) => artifact.required === true), 'executable generated REST case artifacts must be required');

const dbRun = dbInventory.run?.[0] || {};
assert.equal(dbRun['include-options'], true, 'Jetpack DB inventory must include options');
assert.ok(dbRun.table_prefixes.includes('jpsq_'), 'Jetpack DB inventory must include sync queue tables');
assert.ok(dbRun.option_names.includes('jetpack_active_modules'), 'Jetpack DB inventory must include active module option');
assert.ok(dbRun.module_inventory.expected_modules.includes('stats'), 'Jetpack DB inventory must include representative modules');

assertBoundary('jetpack-options-matrix', {
  safetyClass: 'isolated_mutation',
  operations: ['option-default-read', 'option-update-disposable-mutation', 'read-update-safety-classification', 'connected-state-blocker-classification', 'serialization-boundary-classification'],
  inputs: { secret_placeholders_only: true, execute_mutations: true, mutation_mode: 'upstream_disposable_destructive_contract', connected_state_required_for_mutation: false, connected_remote_state_provisioning_required: true, runtime_isolation_required_for_mutation: true, rollback_required: false },
});
assertBoundary('jetpack-module-state-matrix', {
  safetyClass: 'isolated_mutation',
  operations: ['module-discovery', 'module-group-inventory', 'module-activate-deactivate-disposable-mutation', 'connected-state-blocker-classification', 'disposable-destructive-contract-classification'],
  inputs: { external_dispatch: false, execute_mutations: true, mutation_mode: 'upstream_disposable_destructive_contract', connected_state_required_for_mutation: false, connected_remote_state_provisioning_required: true, runtime_isolation_required_for_mutation: true, rollback_required: false },
});
assertBoundary('jetpack-sync-queue-coverage', {
  safetyClass: 'isolated_mutation',
  operations: ['sync-queue-discovery', 'sync-action-inventory', 'queue-option-disposable-mutation'],
  inputs: { remote_dispatch: false, force_http_guardrail: true, connected_remote_state_provisioning_required: true, rollback_required: false },
});
assertBoundary('jetpack-cron-sync-actions', {
  safetyClass: 'isolated_mutation',
  operations: ['cron-event-inventory', 'sync-action-inventory', 'queue-option-delta', 'disposable-cron-mutation'],
  inputs: { remote_dispatch: false, force_http_guardrail: true, connected_remote_state_provisioning_required: true, rollback_required: false },
});
assertBoundary('jetpack-connected-disconnected-fixtures', {
  safetyClass: 'isolated_mutation',
  operations: ['local-placeholder-connected-fixture-state', 'disconnected-fixture-state', 'token-placeholder-serialization', 'skip-reason-classification'],
  inputs: { real_wpcom_credentials_allowed: false, real_tokens_allowed: false, network_calls_allowed: false, wpcom_sandbox_required: false, connected_remote_state_provisioning_required: true, guessed_connected_state_support_allowed: false, secret_placeholders_only: true, restore_original_values: true, reset_after_each_state: true, rollback_required: false },
});
assertConnectedDisconnectedFixtureContract();
assertDisposableMutationSplitContract();

const moduleInventory = manifestFor('jetpack-module-option-table-inventory');
assert.equal(moduleInventory.safety_class, 'read_only', 'Jetpack module inventory must remain read-only');
assert.ok(moduleInventory.coverage.operations.includes('module-option-inventory'), 'Jetpack module inventory must cover module options');
assert.ok(moduleInventory.coverage.operations.includes('module-table-inventory'), 'Jetpack module inventory must cover module tables');
assert.equal(moduleInventory.cases[0].inputs.read_only, true, 'Jetpack module inventory must use a read-only primitive');
assert.equal(moduleInventory.cases[0].inputs.secret_placeholders_only, true, 'Jetpack module inventory must not expose secrets');
assert.ok(moduleInventory.cases[0].inputs.option_keys.includes('jetpack_active_modules'), 'Jetpack module inventory must enumerate product-specific active module option');
assert.ok(moduleInventory.cases[0].inputs.option_keys.includes('jetpack_private_options'), 'Jetpack module inventory must enumerate private option placeholders');
assert.ok(moduleInventory.cases[0].inputs.option_keys.includes('jpsq_sync_checkout'), 'Jetpack module inventory must enumerate sync queue option keys');
assert.ok(moduleInventory.cases[0].inputs.read_safe_option_keys.includes('jetpack_options'), 'Jetpack module inventory must classify read-safe options');
assert.ok(moduleInventory.cases[0].inputs.update_planned_option_keys.includes('jetpack_sync_settings'), 'Jetpack module inventory must keep connected option writes planned');
assert.ok(moduleInventory.cases[0].inputs.connected_state_blocked_option_keys.includes('jetpack_private_options'), 'Jetpack module inventory must classify connected-state blockers');
assert.ok(Object.keys(moduleInventory.cases[0].inputs.module_groups).includes('security'), 'Jetpack module inventory must group security modules');
assert.ok(moduleInventory.artifacts.expected.some((artifact) => artifact.semantic_key === 'fuzz.inventory'), 'Jetpack module inventory must declare safety inventory artifact');

const optionsMatrix = manifestFor('jetpack-options-matrix');
assert.ok(optionsMatrix.cases[0].inputs.option_keys.includes('jetpack_active_modules'), 'Jetpack options matrix must enumerate active module option');
assert.ok(optionsMatrix.cases[0].inputs.option_keys.includes('jetpack_private_options'), 'Jetpack options matrix must enumerate private option placeholders');
assert.ok(optionsMatrix.cases[0].inputs.connected_state_blocked_option_keys.includes('jpsq_sync_checkout'), 'Jetpack options matrix must classify sync queue connected-state blockers');
assert.ok(optionsMatrix.artifacts.expected.some((artifact) => artifact.semantic_key === 'fuzz.disposable_destructive_contract'), 'Jetpack options matrix must declare disposable destructive contract artifact');

const moduleState = manifestFor('jetpack-module-state-matrix');
assert.ok(Object.keys(moduleState.cases[0].inputs.module_groups).includes('traffic'), 'Jetpack module state matrix must group traffic modules');
assert.ok(moduleState.cases[0].inputs.connected_state_blockers.includes('publicize'), 'Jetpack module state matrix must classify connected-state module blockers');
assert.ok(moduleState.artifacts.expected.some((artifact) => artifact.semantic_key === 'fuzz.disposable_destructive_contract'), 'Jetpack module state matrix must declare disposable destructive contract artifact');

const adminPageCoverage = manifestFor('jetpack-admin-page-coverage');
assert.ok(adminPageCoverage.cases[0].inputs.include_menu_slugs.includes('jetpack'), 'Jetpack admin coverage must include dashboard menu');
assert.ok(adminPageCoverage.cases[0].inputs.include_menu_slugs.includes('jetpack_modules'), 'Jetpack admin coverage must include module menu');
assert.ok(adminPageCoverage.cases[0].inputs.skip_reason_codes.includes('destructive_action'), 'Jetpack admin coverage must classify destructive skips');
assert.ok(adminPageCoverage.cases[0].artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.skip_reasons'), 'Jetpack admin coverage must emit skip reason artifact contract');

const publicFrontend = manifestFor('jetpack-public-module-frontend-coverage');
assert.deepEqual(new Set(publicFrontend.cases[0].inputs.states), new Set(['connected', 'disconnected']), 'Jetpack public frontend coverage must cover fixture states');
assert.ok(publicFrontend.cases[0].inputs.request_classes.includes('xhr'), 'Jetpack public frontend coverage must include XHR requests');
assert.ok(publicFrontend.cases[0].inputs.request_classes.includes('fetch'), 'Jetpack public frontend coverage must include fetch requests');
assert.ok(publicFrontend.cases[0].inputs.skip_reason_codes.includes('connection_required'), 'Jetpack public frontend coverage must classify connection skips');

const externalHttp = manifestFor('jetpack-external-http-guardrail');
assert.equal(externalHttp.network_guardrail.block_network, true, 'Jetpack external HTTP guardrail must block network probes');
assert.equal(externalHttp.network_guardrail.real_external_service_calls_allowed, false, 'Jetpack external HTTP guardrail must not permit live service calls');
assert.ok(externalHttp.network_guardrail.allowlist_domains.includes('public-api.wordpress.com'), 'Jetpack external HTTP guardrail must declare WP.com boundary');
assert.ok(externalHttp.network_guardrail.blocked_domains.includes('jetpack-homeboy-guardrail.invalid'), 'Jetpack external HTTP guardrail must declare blocked hosts');
assert.ok(externalHttp.network_guardrail.probe_hosts.includes('jetpack-homeboy-guardrail.invalid'), 'Jetpack external HTTP guardrail must use synthetic probe host');
assert.deepEqual(
  new Set(externalHttp.metadata.endpoint_classes.map((endpointClass) => endpointClass.class)),
  new Set(['connection-api', 'sync-dispatch', 'module-service-api', 'synthetic-blocked-probe']),
  'Jetpack external HTTP guardrail endpoint classes drifted'
);
assert.deepEqual(
  new Set(externalHttp.metadata.host_policy.allowed_boundaries.map((boundary) => boundary.host)),
  new Set(['public-api.wordpress.com']),
  'Jetpack external HTTP guardrail allowed host policy drifted'
);
assert.deepEqual(
  new Set(externalHttp.metadata.host_policy.blocked_hosts.map((boundary) => boundary.host)),
  new Set(['jetpack-homeboy-guardrail.invalid']),
  'Jetpack external HTTP guardrail blocked host policy drifted'
);
assert.equal(externalHttp.metadata.secret_redaction.raw_secret_values_allowed_in_artifacts, false, 'Jetpack external HTTP guardrail must redact raw secrets from artifacts');
assert.ok(externalHttp.metadata.secret_redaction.expectations.includes('jetpack_blog_token_redacted'), 'Jetpack external HTTP guardrail must redact Jetpack blog tokens');
assert.equal(externalHttp.metadata.connection_requirements.real_wpcom_credentials_allowed, false, 'Jetpack external HTTP guardrail must not require live WPCOM credentials');
assert.ok(externalHttp.metadata.proof_artifact_expectations.required_before_proven.includes('redaction_assertion_rows'), 'Jetpack external HTTP guardrail proof must include redaction assertions');
assert.ok(externalHttp.metadata.proof_artifact_expectations.required_before_proven.includes('connection_state_skip_rows'), 'Jetpack external HTTP guardrail proof must include connection skip rows');
assert.equal(externalHttp.cases[0].inputs.real_external_service_calls_allowed, false, 'Jetpack external HTTP guardrail case must disallow live external service calls');
assert.equal(externalHttp.cases[0].inputs.secret_redaction_required, true, 'Jetpack external HTTP guardrail case must require redaction checks');

const performance = manifestFor('jetpack-performance-observation');
assert.ok(performance.cases[0].inputs.observation_surfaces.includes('external_http_guardrail'), 'Jetpack performance observation must summarize HTTP guardrails');
assert.equal(performance.cases[0].inputs.proof_required_before_status_p, true, 'Jetpack performance observation must not claim status without proof');
assertPerformanceObservationContract(performance);

const restQueryProfile = manifestFor('rest-db-query-profile');
assertRestQueryProfileContract(restQueryProfile);

for (const warning of warnings) {
  console.warn(`Warning: ${warning}`);
}

console.log(`validated ${fuzzManifests.length} Jetpack fuzz manifests; no fuzz IDs are present in bench_workloads or bench_profiles`);

function manifestFor(workloadId) {
  const entry = workloadsById.get(workloadId);
  assert.ok(entry, `${workloadId} fuzz manifest is missing`);
  return entry.manifest;
}

function assertBoundary(workloadId, { safetyClass, operations, inputs }) {
  const manifest = manifestFor(workloadId);
  const runnerCase = manifest.cases[0];

  assert.equal(manifest.safety_class, safetyClass, `${workloadId} safety class drifted`);
  for (const operation of operations) {
    assert.ok(manifest.operations.includes(operation), `${workloadId} must declare ${operation}`);
  }
  for (const [key, value] of Object.entries(inputs)) {
    assert.equal(runnerCase.inputs?.[key], value, `${workloadId} input ${key} drifted`);
  }
}

function assertPerformanceObservationContract(manifest) {
  const runCaps = manifest.metadata?.optional_run_caps || {};
  assert.equal(manifest.metadata?.relative_hotspot_artifacts?.primary, true, 'Jetpack performance observation must make relative hotspot artifacts primary');
  assert.ok(manifest.metadata.relative_hotspot_artifacts.required.includes('rest_db_query_profile'), 'Jetpack performance observation must require REST DB hotspot artifact');
  assert.equal(runCaps.max_external_http_attempts, 0, 'Jetpack performance observation must cap external HTTP attempts at zero when caps are retained');
  assert.equal(runCaps.max_sync_queue_delta, 0, 'Jetpack performance observation must cap sync queue delta at zero when caps are retained');
  assert.ok(manifest.metadata.observed_surfaces.includes('db-query-profile'), 'Jetpack performance observation must include DB query profile surface');
  assert.ok(manifest.metadata.hotspot_classes.includes('duplicate-db-query'), 'Jetpack performance observation must classify duplicate DB query hotspots');
  assert.equal(manifest.metadata.query_attribution_expectations.source_artifact, 'rest_db_query_profile', 'Jetpack performance observation query attribution source drifted');
  assert.deepEqual(new Set(manifest.cases[0].inputs.states), new Set(['connected', 'disconnected']), 'Jetpack performance observation must caveat connected and disconnected states');
  assert.ok(manifest.metadata.connected_state_caveats.length >= 2, 'Jetpack performance observation must document connected-state caveats');
  assertArtifactContains(manifest, 'jetpack_performance_observation', ['relative_hotspot_comparison', 'hotspot_classification', 'query_attribution_summary', 'connected_state_caveats']);
  assertArtifactContains(manifest, 'jetpack_performance_surface_summary', ['surface_rollups', 'optional_run_cap_status', 'artifact_inputs', 'skip_reason_rollups']);
}

function assertRestQueryProfileContract(manifest) {
  const budgets = manifest.metadata?.product_budgets || {};
  assert.equal(budgets.max_profiled_rest_cases, manifest.case_budget, 'Jetpack REST DB query profile case budget drifted');
  assert.equal(budgets.max_slow_queries_per_case, 0, 'Jetpack REST DB query profile must budget zero slow queries per case');
  assert.ok(manifest.metadata.observed_surfaces.includes('jetpack/v4'), 'Jetpack REST DB query profile must cover Jetpack REST namespace');
  assert.ok(manifest.metadata.observed_surfaces.includes('wpcom/v2'), 'Jetpack REST DB query profile must cover WPCOM REST namespace');
  assert.ok(manifest.metadata.hotspot_classes.includes('sync-queue-table-read'), 'Jetpack REST DB query profile must classify sync queue table reads');
  assert.ok(manifest.metadata.query_attribution_expectations.required_fields.includes('callers'), 'Jetpack REST DB query profile must require caller attribution');
  assert.equal(manifest.cases[0].inputs.query_attribution_required, true, 'Jetpack REST DB query profile must require query attribution');
  assert.equal(manifest.cases[0].inputs.external_service_calls_allowed, false, 'Jetpack REST DB query profile must not allow external service calls');
  assert.deepEqual(new Set(manifest.cases[0].inputs.states), new Set(['connected', 'disconnected']), 'Jetpack REST DB query profile must caveat connected and disconnected states');
  assert.ok(manifest.metadata.connected_state_caveats.length >= 2, 'Jetpack REST DB query profile must document connected-state caveats');
  assertArtifactContains(manifest, 'rest_db_query_profile', ['per_route_query_counts', 'hotspot_classification', 'query_attribution', 'budget_comparison', 'connected_state_caveats']);
}

function assertArtifactContains(manifest, artifactName, expectedFields) {
  const caseArtifact = manifest.cases[0].artifacts.find((artifact) => artifact.name === artifactName);
  const expectedArtifact = manifest.artifacts.expected.find((artifact) => artifact.name === artifactName);
  assert.ok(caseArtifact, `${manifest.id} case artifact ${artifactName} is missing`);
  assert.ok(expectedArtifact, `${manifest.id} expected artifact ${artifactName} is missing`);
  for (const field of expectedFields) {
    assert.ok(caseArtifact.metadata?.contains?.includes(field), `${manifest.id} case artifact ${artifactName} must contain ${field}`);
    assert.ok(expectedArtifact.contains?.includes(field), `${manifest.id} expected artifact ${artifactName} must contain ${field}`);
  }
}

function assertJetpackStableWorkloads(manifest, expectedIds, expectedFuzzIds) {
  assert.deepEqual(new Set(manifest.contracts.map((contract) => contract.id)), expectedIds, 'Jetpack stable workload ids drifted');
  assert.ok(Array.isArray(manifest.comparison_surfaces) && manifest.comparison_surfaces.includes('relative-hotspot-artifacts'), 'Jetpack stable workloads must compare relative hotspot artifacts');

  for (const contract of manifest.contracts) {
    assert.equal(contract.readiness, 'executable', `${contract.id} must be executable`);
    assert.ok(Array.isArray(contract.entry_workloads) && contract.entry_workloads.length > 0, `${contract.id} must declare entry workloads`);
    assert.ok(Array.isArray(contract.observed_surfaces) && contract.observed_surfaces.length > 0, `${contract.id} must declare observed surfaces`);
    assert.ok(contract.expected_observations?.required_artifacts?.length > 0, `${contract.id} must require artifacts`);
    assert.ok(Array.isArray(contract.relative_hotspot_artifacts) && contract.relative_hotspot_artifacts.length > 0, `${contract.id} must declare relative hotspot artifacts`);
    if (contract.optional_run_caps) {
      assert.ok(contract.optional_run_caps.max_duration_seconds > 0, `${contract.id} optional run caps must bound duration when retained`);
    }

    for (const workloadId of contract.entry_workloads) {
      assert.ok(expectedFuzzIds.has(workloadId), `${contract.id} entry workload ${workloadId} must be a declared Jetpack fuzz workload`);
    }
  }
}

function assertConnectedDisconnectedFixtureContract() {
  const manifest = manifestFor('jetpack-connected-disconnected-fixtures');
  const runnerCase = manifest.cases[0];
  const metadata = manifest.metadata || {};
  const states = new Set(['connected', 'disconnected']);

  assert.deepEqual(new Set(metadata.fixture_states), states, 'Jetpack connection fixture metadata states drifted');
  assert.deepEqual(new Set(runnerCase.inputs?.fixture_states), states, 'Jetpack connection fixture input states drifted');
  assert.deepEqual(new Set(Object.keys(metadata.fixture_state_contract || {})), states, 'Jetpack connection fixture state contract must describe both states');
  assert.deepEqual(new Set(Object.keys(runnerCase.inputs?.explicit_fixture_states || {})), states, 'Jetpack connection fixture inputs must name both explicit fixture states');

  assert.equal(metadata.fixture_state_contract.connected.network_calls_allowed, false, 'Connected fixture contract must not allow network calls');
  assert.equal(metadata.fixture_state_contract.disconnected.network_calls_allowed, false, 'Disconnected fixture contract must not allow network calls');
  assert.equal(metadata.fake_token_policy?.real_wpcom_credentials_allowed, false, 'Connection fixture must forbid real WP.com credentials');
  assert.equal(metadata.fake_token_policy?.real_tokens_allowed, false, 'Connection fixture must forbid real tokens');
  assert.equal(metadata.fake_token_policy?.placeholder_tokens_only, true, 'Connection fixture must use placeholder tokens only');
  assert.ok(metadata.fake_token_policy.redact_token_fields.includes('blog_token'), 'Connection fixture must redact blog_token fields');
  assert.ok(metadata.fake_token_policy.redact_token_fields.includes('user_token'), 'Connection fixture must redact user_token fields');
  assert.ok(metadata.fake_token_policy.artifact_must_not_contain_patterns.includes('Bearer '), 'Connection fixture must forbid bearer-token artifacts');
  assert.ok(runnerCase.inputs.allowed_fake_tokens.every((token) => token.startsWith('__JETPACK_FAKE_')), 'Connection fixture fake tokens must be obvious placeholders');

  assert.ok(Array.isArray(metadata.wpcom_sandbox_blockers) && metadata.wpcom_sandbox_blockers.length >= 2, 'Connection fixture must declare WP.com sandbox blockers');
  assert.ok(metadata.wpcom_sandbox_blockers.some((blocker) => blocker.includes('No WP.com OAuth')), 'Connection fixture must document missing WP.com OAuth sandbox');
  assert.equal(metadata.connected_remote_state_contract?.level, 'blocked_until_provisioned', 'Connection fixture must block true WP.com connected state until provisioned');
  assert.equal(metadata.connected_remote_state_contract?.guessed_support_allowed, false, 'Connection fixture must not guess WP.com connected-state support');
  assert.equal(metadata.connected_remote_state_contract?.local_placeholder_state_is_remote_support, false, 'Local placeholder state must not count as remote connected-state support');
  assert.ok(metadata.connected_remote_state_contract.required_provisioning.includes('wpcom_oauth_app'), 'Connection fixture must require a WP.com OAuth app for remote state');
  assert.ok(metadata.connected_remote_state_contract.required_provisioning.includes('wpcom_sandbox_blog'), 'Connection fixture must require a WP.com sandbox blog for remote state');
  assert.ok(metadata.connected_remote_state_contract.required_provisioning.includes('wpcom_service_account'), 'Connection fixture must require a WP.com service account for remote state');
  assert.equal(runnerCase.inputs.connected_remote_state_provisioning_required, true, 'Connection fixture inputs must require connected remote-state provisioning');
  assert.equal(runnerCase.inputs.guessed_connected_state_support_allowed, false, 'Connection fixture inputs must forbid guessed connected-state support');
  assert.ok(runnerCase.inputs.skip_reason_codes.includes('credential_unavailable'), 'Connection fixture must classify credential skips');
  assert.ok(runnerCase.inputs.skip_reason_codes.includes('external_service_required'), 'Connection fixture must classify external service skips');
  assert.ok(runnerCase.inputs.skip_reason_codes.includes('connection_required'), 'Connection fixture must classify connection-required skips');

  assert.ok(metadata.module_availability_expectations.available_in_both_states.includes('shortcodes'), 'Connection fixture must document state-independent modules');
  assert.ok(metadata.module_availability_expectations.requires_connected_or_wpcom_service.includes('stats'), 'Connection fixture must document WP.com-dependent modules');
  assert.ok(runnerCase.inputs.module_availability_expectations.requires_connected_or_wpcom_service.includes('publicize'), 'Connection fixture inputs must preserve module availability expectations');

  assert.equal(metadata.reset_contract.snapshot_before_mutation, true, 'Connection fixture must snapshot before mutation');
  assert.equal(metadata.reset_contract.restore_original_values, true, 'Connection fixture must restore original values');
  assert.equal(metadata.reset_contract.rollback_required, false, 'Connection fixture must not require rollback for disposable local fixture mutation');
  assert.equal(metadata.reset_contract.reset_after_each_state, true, 'Connection fixture must reset after each state');
  assert.ok(metadata.reset_contract.option_patterns.includes('jetpack_private_options'), 'Connection fixture reset contract must include private options');
  assert.ok(metadata.artifact_expectations.required.includes('fixture_reset_rows'), 'Connection fixture must require fixture reset artifact rows');
  assert.ok(metadata.artifact_expectations.required.includes('redaction_rows'), 'Connection fixture must require redaction artifact rows');

  assert.ok(runnerCase.artifacts.some((artifact) => artifact.name === 'connection_fixture_reset_report' && artifact.metadata?.semantic_key === 'fuzz.fixture_reset_report'), 'Connection fixture must declare a reset report case artifact');
  assert.ok(manifest.artifacts.expected.some((artifact) => artifact.name === 'connection_fixture_reset_report' && artifact.semantic_key === 'fuzz.fixture_reset_report'), 'Connection fixture must declare a reset report expected artifact');
  assert.ok(metadata.proof_artifact_expectations.connection_fixture_matrix.includes('module_expectations'), 'Connection fixture proof matrix must include module expectations');
  assert.ok(metadata.proof_artifact_expectations.connection_skip_reasons.includes('blocked_by_wpcom_sandbox'), 'Connection fixture skip proof must include WP.com blocker status');
  assert.ok(metadata.proof_artifact_expectations.connection_reset_report.includes('leaked_keys'), 'Connection fixture reset proof must include leaked key checks');
}

function assertDisposableMutationSplitContract() {
  for (const workloadId of ['jetpack-options-matrix', 'jetpack-module-state-matrix', 'jetpack-sync-queue-coverage', 'jetpack-cron-sync-actions']) {
    const manifest = manifestFor(workloadId);
    const runnerCase = manifest.cases[0];
    const contract = manifest.metadata?.upstream_disposable_destructive_contract;

    assert.equal(manifest.safety_class, 'isolated_mutation', `${workloadId} local mutation must be isolated mutation`);
    assert.equal(contract?.contract, 'wordpress-disposable-destructive-contract', `${workloadId} must wire to upstream disposable destructive contract`);
    assert.equal(contract?.fixture_scope, 'wp-codebox-disposable-wordpress', `${workloadId} must target disposable WordPress fixtures`);
    assert.equal(contract?.rollback_required, false, `${workloadId} disposable mutation must not be rollback-blocked`);
    assert.equal(contract?.remote_state_allowed, false, `${workloadId} disposable mutation must not claim remote-state writes`);
    assert.equal(runnerCase.inputs?.rollback_required, false, `${workloadId} case must not require rollback`);
    assert.equal(runnerCase.inputs?.connected_remote_state_provisioning_required, true, `${workloadId} must keep connected WP.com behavior provision-blocked`);
  }
}
