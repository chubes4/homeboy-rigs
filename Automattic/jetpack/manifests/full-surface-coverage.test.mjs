import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertFullSurfaceCoverageManifest } from '../../../scripts/fuzz-manifest-helpers.mjs';

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
  'performance_observation',
  'read_only_inventory',
]);

test('Jetpack full-surface manifest uses shared coverage-map and gap-report schema', () => {
  assertFullSurfaceCoverageManifest(manifest, { file: 'Jetpack full-surface coverage' });
});

function workloadIdFromPath(workloadPath) {
  return path.basename(workloadPath).replace(/\.json$/, '');
}

function readFuzzManifest(name) {
  return JSON.parse(readFileSync(path.join(fuzzRoot, `${name}.json`), 'utf8'));
}

function defaultCase(manifest) {
  assert.ok(Array.isArray(manifest.cases), `${manifest.id} must declare cases`);
  assert.ok(manifest.cases.length > 0, `${manifest.id} must declare at least one case`);
  return manifest.cases[0];
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
  const guardrail = readFuzzManifest('jetpack-external-http-guardrail');

  assert.equal(guardrail.network_guardrail.block_network, true);
  assert.ok(guardrail.network_guardrail.allowlist_domains.includes('public-api.wordpress.com'));
  assert.equal(guardrail.network_guardrail.real_external_service_calls_allowed, false);
  assert.ok(guardrail.network_guardrail.probe_hosts.includes('jetpack-homeboy-guardrail.invalid'));
  assert.ok(guardrail.network_guardrail.expectations.some((expectation) => expectation.classification === 'blocked'));
  assert.ok(guardrail.network_guardrail.expectations.some((expectation) => expectation.classification === 'allowlisted_boundary_not_called'));
});

test('Jetpack REST request cases cover namespaces and permission classes', () => {
  const routeCoverage = JSON.parse(readFileSync(path.join(__dirname, 'rest-route-coverage.json'), 'utf8'));
  const generatedCases = JSON.parse(readFileSync(path.join(packageRoot, 'bench/generated-rest-request-cases.workload.json'), 'utf8'));
  const casesById = new Map(generatedCases.rest_request_cases.map((restCase) => [restCase.id, restCase]));

  assert.deepEqual(new Set(routeCoverage.namespaces.map((entry) => entry.namespace)), new Set(['jetpack/v4', 'wpcom/v2']));

  for (const requiredCase of routeCoverage.required_generated_cases) {
    const generatedCase = casesById.get(requiredCase.id);
    assert.ok(generatedCase, `${requiredCase.id} is missing from generated REST request cases`);
    assert.equal(generatedCase.method, requiredCase.method);
    assert.equal(generatedCase.path, requiredCase.path);
    assert.equal(generatedCase.permission_class, requiredCase.permission_class);
    assert.equal(typeof generatedCase.permission_class, 'string');
    assert.ok(Array.isArray(generatedCase.expected_statuses), `${requiredCase.id} needs explicit expected statuses`);
  }
});

test('Jetpack DB inventory declares module tables and options', () => {
  const dbInventory = JSON.parse(readFileSync(path.join(packageRoot, 'bench/db-inventory.workload.json'), 'utf8'));
  const dbFuzz = JSON.parse(readFileSync(path.join(fuzzRoot, 'db-inventory.json'), 'utf8'));
  const [runStep] = dbInventory.run;

  assert.equal(runStep['include-options'], true);
  assert.ok(runStep.table_prefixes.includes('jpsq_'));
  assert.ok(runStep.option_names.includes('jetpack_active_modules'));
  assert.ok(runStep.module_inventory.expected_modules.includes('stats'));
  assert.ok(dbFuzz.operations.includes('module-option-inventory'));
});

test('Jetpack option/module/sync fuzz workloads declare rollback-safe boundaries', () => {
  const workloadIds = [
    'jetpack-options-matrix',
    'jetpack-module-state-matrix',
    'jetpack-sync-queue-coverage',
    'jetpack-cron-sync-actions',
    'jetpack-connected-disconnected-fixtures',
  ];

  for (const workloadId of workloadIds) {
    const workload = JSON.parse(readFileSync(path.join(fuzzRoot, `${workloadId}.json`), 'utf8'));
    const firstCase = workload.cases[0];
    const serializedInputs = JSON.stringify(firstCase.inputs || {});
    const serializedArgs = JSON.stringify(firstCase.phases?.action || []);

    assert.equal(workload.safety_class, 'isolated_mutation', `${workloadId} should be isolated mutation coverage`);
    assert.ok(serializedInputs.includes('rollback') || serializedArgs.includes('rollback'), `${workloadId} must require rollback-safe mutation handling`);
    assert.ok(serializedInputs.includes('restore_original_values') || serializedArgs.includes('restore_original_values'), `${workloadId} must restore original values`);
  }
});

test('Jetpack inventory fuzz workloads define module option/table and cron sync primitives', () => {
  const moduleInventory = JSON.parse(readFileSync(path.join(fuzzRoot, 'jetpack-module-option-table-inventory.json'), 'utf8'));
  const cronSyncActions = JSON.parse(readFileSync(path.join(fuzzRoot, 'jetpack-cron-sync-actions.json'), 'utf8'));

  assert.equal(moduleInventory.safety_class, 'read_only');
  assert.ok(moduleInventory.coverage.operations.includes('module-option-inventory'));
  assert.ok(moduleInventory.coverage.operations.includes('module-table-inventory'));
  assert.ok(moduleInventory.cases[0].inputs.read_only);
  assert.ok(moduleInventory.cases[0].inputs.secret_placeholders_only);

  assert.ok(cronSyncActions.coverage.operations.includes('cron-event-inventory'));
  assert.ok(cronSyncActions.coverage.operations.includes('sync-action-inventory'));
  assert.equal(cronSyncActions.cases[0].inputs.remote_dispatch, false);
  assert.equal(cronSyncActions.cases[0].inputs.force_http_guardrail, true);
  assert.ok(cronSyncActions.cases[0].inputs.cron_hooks.length > 0);
  assert.ok(cronSyncActions.cases[0].inputs.synthetic_actions.length > 0);
});

test('Jetpack admin page coverage enumerates wp-admin menus with explicit skip reasons', () => {
  const admin = readFuzzManifest('jetpack-admin-page-coverage');
  const testCase = defaultCase(admin);
  const inputs = testCase.inputs;
  const targetContract = admin.metadata.admin_target_contract;

  assert.ok(inputs.menu_sources.includes('global_menu'));
  assert.ok(inputs.menu_sources.includes('global_submenu'));
  assert.ok(inputs.include_menu_slugs.includes('jetpack'));
  assert.ok(inputs.include_menu_slugs.includes('jetpack_modules'));
  assert.ok(inputs.include_menu_slugs.includes('jetpack#/settings?term=performance'));
  assert.equal(targetContract.product, 'jetpack');
  assert.equal(targetContract.default_capability, 'manage_options');
  assert.equal(targetContract.request_policy.get_first, true);
  assert.deepEqual(targetContract.request_policy.safe_methods, ['GET']);
  assert.equal(targetContract.request_policy.mutating_methods_allowed, false);
  assert.ok(inputs.skip_reason_codes.includes('destructive_action'));
  assert.ok(inputs.skip_reason_codes.includes('credential_unavailable'));
  assert.ok(testCase.artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.admin_menu_enumeration'));
  assert.ok(testCase.artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.skip_reasons'));
});

test('Jetpack admin page coverage declares product-specific page targets and proof artifacts', () => {
  const admin = readFuzzManifest('jetpack-admin-page-coverage');
  const targetContract = admin.metadata.admin_target_contract;
  const targetsById = new Map(targetContract.page_targets.map((target) => [target.id, target]));
  const skipReasonsByCode = new Map(targetContract.skip_reasons.map((skipReason) => [skipReason.code, skipReason]));
  const proofArtifactsByName = new Map(targetContract.proof_artifact_expectations.map((artifact) => [artifact.name, artifact]));

  assert.ok(targetsById.has('jetpack-dashboard'));
  assert.ok(targetsById.has('jetpack-connection'));
  assert.ok(targetsById.has('jetpack-settings-performance'));
  assert.ok(targetsById.has('jetpack-modules'));

  for (const target of targetContract.page_targets) {
    assert.equal(target.required_capability, 'manage_options', `${target.id} must declare its capability requirement`);
    assert.deepEqual(target.safe_methods, ['GET'], `${target.id} must stay GET-only`);
    assert.ok(target.admin_path.startsWith('/wp-admin/admin.php?page='), `${target.id} needs a concrete admin.php target`);
    assert.ok(target.proof_artifacts.includes('admin_page_coverage'), `${target.id} needs page coverage proof`);
  }

  assert.equal(targetsById.get('jetpack-connection').hash_route, '#/connection');
  assert.ok(targetsById.get('jetpack-connection').destructive_skip_codes.includes('connection_mutation'));
  assert.ok(targetsById.get('jetpack-modules').destructive_skip_codes.includes('module_state_mutation'));
  assert.ok(skipReasonsByCode.get('module_state_mutation').reason.includes('module-state lane'));
  assert.ok(skipReasonsByCode.get('connection_mutation').reason.includes('WordPress.com'));
  assert.ok(proofArtifactsByName.get('admin_page_coverage').required_fields.includes('required_capability'));
  assert.ok(proofArtifactsByName.get('admin_skip_reasons').required_fields.includes('matched_pattern'));
  assert.ok(proofArtifactsByName.get('admin_query_attribution').required_fields.includes('caller_summary'));
});

test('Jetpack public frontend coverage declares module routes, request classes, and state skips', () => {
  const frontend = readFuzzManifest('jetpack-public-module-frontend-coverage');
  const testCase = defaultCase(frontend);
  const inputs = testCase.inputs;
  const modules = new Set(inputs.module_scenarios.map((scenario) => scenario.module));

  assert.deepEqual(new Set(inputs.states), new Set(['connected', 'disconnected']));
  assert.ok(modules.has('shortcodes'));
  assert.ok(modules.has('contact-form'));
  assert.ok(modules.has('related-posts'));
  assert.ok(modules.has('stats'));
  assert.ok(inputs.request_classes.includes('xhr'));
  assert.ok(inputs.request_classes.includes('fetch'));
  assert.ok(inputs.skip_reason_codes.includes('connection_required'));
  assert.ok(testCase.artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.browser_request_matrix'));
});

test('Jetpack connected/disconnected fixture coverage classifies credential-dependent skips', () => {
  const fixtures = readFuzzManifest('jetpack-connected-disconnected-fixtures');
  const inputs = defaultCase(fixtures).inputs;

  assert.deepEqual(new Set(inputs.states), new Set(['connected', 'disconnected']));
  assert.equal(inputs.real_wpcom_credentials_allowed, false);
  assert.equal(inputs.secret_placeholders_only, true);
  assert.equal(inputs.restore_original_values, true);
  assert.ok(inputs.fixture_options.includes('jetpack_options'));
  assert.ok(inputs.skip_reason_codes.includes('credential_unavailable'));
  assert.ok(inputs.skip_reason_codes.includes('connected_required'));
});

test('Jetpack performance observation declares non-benchmark observation surfaces and artifacts', () => {
  const performance = readFuzzManifest('jetpack-performance-observation');
  const testCase = defaultCase(performance);
  const inputs = testCase.inputs;

  assert.ok(inputs.observation_surfaces.includes('admin_page_coverage'));
  assert.ok(inputs.observation_surfaces.includes('public_module_frontend_coverage'));
  assert.ok(inputs.observation_surfaces.includes('external_http_guardrail'));
  assert.ok(inputs.metrics.includes('duration_ms'));
  assert.ok(inputs.metrics.includes('query_count'));
  assert.equal(inputs.proof_required_before_status_p, true);
  assert.ok(performance.coverage.operations.includes('slow-surface-classification'));
  assert.ok(testCase.artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.performance_surface_summary'));
});

test('Jetpack browser trace includes admin and public module scenarios', () => {
  assert.deepEqual(new Set(manifest.surfaces.browser_requests.scenarios), new Set([
    'dashboard',
    'connection',
    'modules',
    'settings',
    'public_post_modules',
    'public_page_modules',
  ]));

  for (const scenario of manifest.surfaces.browser_requests.scenarios) {
    assert.ok(readdirSync(path.join(packageRoot, 'browser-scenarios')).includes(`${scenario}.json`), `${scenario} needs a browser scenario file`);
  }
});
