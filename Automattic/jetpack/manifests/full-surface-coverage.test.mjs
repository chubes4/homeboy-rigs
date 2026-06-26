import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const fuzzRoot = path.join(packageRoot, 'fuzz');

function readFuzzManifest(name) {
  return JSON.parse(readFileSync(path.join(fuzzRoot, `${name}.json`), 'utf8'));
}

function defaultCase(manifest) {
  assert.ok(Array.isArray(manifest.cases), `${manifest.id} must declare cases`);
  assert.ok(manifest.cases.length > 0, `${manifest.id} must declare at least one case`);
  return manifest.cases[0];
}

test('Jetpack external HTTP guardrail blocks synthetic probes', () => {
  const guardrail = readFuzzManifest('jetpack-external-http-guardrail');
  const metadata = guardrail.metadata;
  const caseInputs = defaultCase(guardrail).inputs;

  assert.ok(guardrail.network_guardrail.expectations.some((expectation) => expectation.classification === 'blocked'));
  assert.ok(guardrail.network_guardrail.expectations.some((expectation) => expectation.classification === 'allowlisted_boundary_not_called'));
  assert.equal(metadata.host_policy.unknown_hosts, 'blocked_and_reported');
  assert.ok(metadata.secret_redaction.expectations.includes('authorization_headers_redacted'));
  assert.ok(metadata.connection_requirements.states.includes('connected'));
  assert.ok(metadata.connection_requirements.states.includes('disconnected'));
  assert.ok(caseInputs.skip_reason_codes.includes('blocked_external_http'));
});

test('Jetpack REST request cases cover namespaces and permission classes', () => {
  const routeCoverage = JSON.parse(readFileSync(path.join(__dirname, 'rest-route-coverage.json'), 'utf8'));
  const generatedCases = JSON.parse(readFileSync(path.join(packageRoot, 'bench/generated-rest-request-cases.workload.json'), 'utf8'));
  const casesById = new Map(generatedCases.rest_request_cases.map((restCase) => [restCase.id, restCase]));

  for (const requiredCase of routeCoverage.required_generated_cases) {
    const generatedCase = casesById.get(requiredCase.id);
    assert.ok(generatedCase, `${requiredCase.id} is missing from generated REST request cases`);
    assert.equal(generatedCase.path, requiredCase.path);
    assert.equal(generatedCase.permission_class, requiredCase.permission_class);
    assert.ok(Array.isArray(generatedCase.expected_statuses), `${requiredCase.id} needs explicit expected statuses`);
  }
});

test('Jetpack cron and sync manifests declare product-specific hooks, blockers, fixtures, and proof artifacts', () => {
  const cronSyncActions = readFuzzManifest('jetpack-cron-sync-actions');
  const syncQueueCoverage = readFuzzManifest('jetpack-sync-queue-coverage');
  const cronInputs = defaultCase(cronSyncActions).inputs;
  const queueInputs = defaultCase(syncQueueCoverage).inputs;

  assert.ok(cronInputs.product_hook_inventory.some((entry) => entry.hook === 'jetpack_sync_cron'));
  assert.ok(cronInputs.product_hook_inventory.some((entry) => entry.disconnected_blocker === 'connected_required'));
  assert.ok(cronInputs.product_action_inventory.every((entry) => entry.action.startsWith('jetpack_sync_')));
  assert.ok(cronInputs.queue_surfaces.some((surface) => surface.name === 'jpsq_sync_checkout'));
  assert.ok(cronInputs.connection_state_blockers.some((blocker) => blocker.reason_code === 'wpcom_boundary_blocked'));
  assert.ok(cronInputs.replay_fixture_requirements.includes('external_http_guardrail'));
  assert.ok(cronInputs.proof_artifact_expectations.includes('proof artifact index'));

  assert.ok(queueInputs.product_action_inventory.every((entry) => entry.action.startsWith('jetpack_sync_')));
  assert.ok(queueInputs.queue_surfaces.some((surface) => surface.name === 'incremental_sync_queue'));
  assert.ok(queueInputs.connection_state_blockers.some((blocker) => blocker.reason_code === 'connected_required'));
  assert.ok(queueInputs.replay_fixture_requirements.includes('synthetic_connection_placeholders'));
  assert.ok(queueInputs.proof_artifact_expectations.includes('queue option before/after/restore rows'));

  for (const workload of [cronSyncActions, syncQueueCoverage]) {
    assert.ok(workload.metadata.readiness.upstream_blockers.some((blocker) => blocker.includes('does not add a generic')));
    assert.ok(workload.artifacts.expected.some((artifact) => artifact.semantic_key === 'fuzz.replay_fixture' && artifact.required === true));
    assert.ok(workload.artifacts.expected.some((artifact) => artifact.semantic_key === 'fuzz.proof_index' && artifact.required === true));
  }
});

test('Jetpack admin page coverage enumerates wp-admin menus with explicit skip reasons', () => {
  const admin = readFuzzManifest('jetpack-admin-page-coverage');
  const testCase = defaultCase(admin);
  const inputs = testCase.inputs;
  const targetContract = admin.metadata.admin_target_contract;

  assert.ok(inputs.menu_sources.includes('global_menu'));
  assert.ok(inputs.menu_sources.includes('global_submenu'));
  assert.ok(inputs.include_menu_slugs.includes('jetpack#/settings?term=performance'));
  assert.equal(targetContract.product, 'jetpack');
  assert.equal(targetContract.default_capability, 'manage_options');
  assert.equal(targetContract.request_policy.get_first, true);
  assert.deepEqual(targetContract.request_policy.safe_methods, ['GET']);
  assert.ok(inputs.skip_reason_codes.includes('credential_unavailable'));
  assert.ok(testCase.artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.admin_menu_enumeration'));
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

  assert.ok(modules.has('shortcodes'));
  assert.ok(modules.has('contact-form'));
  assert.ok(modules.has('related-posts'));
  assert.ok(modules.has('stats'));
  assert.ok(testCase.artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.browser_request_matrix'));
});

test('Jetpack performance observation declares non-benchmark observation surfaces and artifacts', () => {
  const performance = readFuzzManifest('jetpack-performance-observation');
  const testCase = defaultCase(performance);
  const inputs = testCase.inputs;

  assert.ok(inputs.observation_surfaces.includes('admin_page_coverage'));
  assert.ok(inputs.observation_surfaces.includes('public_module_frontend_coverage'));
  assert.ok(inputs.metrics.includes('duration_ms'));
  assert.ok(inputs.metrics.includes('query_count'));
  assert.ok(performance.coverage.operations.includes('slow-surface-classification'));
  assert.ok(testCase.artifacts.some((artifact) => artifact.metadata?.semantic_key === 'fuzz.performance_surface_summary'));
});
