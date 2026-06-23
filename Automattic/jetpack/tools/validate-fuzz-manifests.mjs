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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const apiRig = readJson(packageRoot, 'rigs/jetpack-api-route-inventory/rig.json');
const browserRig = readJson(packageRoot, 'rigs/jetpack-browser-coverage/rig.json');
const fullSurfaceCoverage = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const restRouteCoverage = readJson(packageRoot, 'manifests/rest-route-coverage.json');
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

assertFullSurfaceCoverageManifest(fullSurfaceCoverage, { file: 'Jetpack full-surface coverage' });
assert.equal(fuzzManifests.length, expectedFuzzIds.size, 'expected one Jetpack fuzz manifest per declared API fuzz workload');
assert.equal(apiRig.bench_workloads, undefined, 'Jetpack fuzz coverage must not use bench_workloads as a fallback');
assert.equal(apiRig.bench_profiles, undefined, 'Jetpack fuzz coverage must not use bench_profiles as a fallback');

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

const generatedCaseIds = new Set(generatedRestCases.rest_request_cases.map((restCase) => restCase.id));
for (const requiredCase of restRouteCoverage.required_generated_cases) {
  assert.ok(generatedCaseIds.has(requiredCase.id), `generated REST cases missing ${requiredCase.id}`);
  assert.equal(typeof requiredCase.permission_class, 'string', `${requiredCase.id} must classify permission boundary`);
}

const dbRun = dbInventory.run?.[0] || {};
assert.equal(dbRun['include-options'], true, 'Jetpack DB inventory must include options');
assert.ok(dbRun.table_prefixes.includes('jpsq_'), 'Jetpack DB inventory must include sync queue tables');
assert.ok(dbRun.option_names.includes('jetpack_active_modules'), 'Jetpack DB inventory must include active module option');
assert.ok(dbRun.module_inventory.expected_modules.includes('stats'), 'Jetpack DB inventory must include representative modules');

assertBoundary('jetpack-options-matrix', {
  safetyClass: 'isolated_mutation',
  operations: ['option-default-read', 'option-update-rollback', 'serialization-boundary-classification'],
  inputs: { secret_placeholders_only: true, restore_original_values: true, rollback_required: true },
});
assertBoundary('jetpack-module-state-matrix', {
  safetyClass: 'isolated_mutation',
  operations: ['module-discovery', 'module-activate-deactivate', 'rollback-safe-module-state'],
  inputs: { synthetic_connection: false, external_dispatch: false, restore_original_values: true, rollback_required: true },
});
assertBoundary('jetpack-sync-queue-coverage', {
  safetyClass: 'isolated_mutation',
  operations: ['sync-queue-discovery', 'sync-action-inventory', 'queue-option-rollback'],
  inputs: { remote_dispatch: false, force_http_guardrail: true, restore_original_values: true, rollback_required: true },
});
assertBoundary('jetpack-cron-sync-actions', {
  safetyClass: 'isolated_mutation',
  operations: ['cron-event-inventory', 'sync-action-inventory', 'queue-option-delta', 'rollback-safe-cron-mutation'],
  inputs: { remote_dispatch: false, force_http_guardrail: true },
});
assertBoundary('jetpack-connected-disconnected-fixtures', {
  safetyClass: 'isolated_mutation',
  operations: ['connected-fixture-state', 'disconnected-fixture-state', 'token-placeholder-serialization'],
  inputs: { real_wpcom_credentials_allowed: false, secret_placeholders_only: true, restore_original_values: true, rollback_required: true },
});

const moduleInventory = manifestFor('jetpack-module-option-table-inventory');
assert.equal(moduleInventory.safety_class, 'read_only', 'Jetpack module inventory must remain read-only');
assert.ok(moduleInventory.coverage.operations.includes('module-option-inventory'), 'Jetpack module inventory must cover module options');
assert.ok(moduleInventory.coverage.operations.includes('module-table-inventory'), 'Jetpack module inventory must cover module tables');
assert.equal(moduleInventory.cases[0].inputs.read_only, true, 'Jetpack module inventory must use a read-only primitive');
assert.equal(moduleInventory.cases[0].inputs.secret_placeholders_only, true, 'Jetpack module inventory must not expose secrets');

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
