import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const productManifests = [
  {
    product: 'woocommerce/woocommerce',
    file: 'woocommerce/woocommerce/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'server_requests', 'browser_requests', 'authenticated_admin_pages', 'options_transients', 'frontend_rendering', 'performance_hotspots'],
    actionFamilies: ['catalog', 'checkout', 'cart_session', 'orders', 'payments', 'shipping_tax', 'admin', 'rest_api', 'options_transients', 'database', 'external_http', 'frontend_rendering'],
    hotspots: ['checkout', 'cart', 'catalog', 'admin', 'api'],
    missingContracts: [],
  },
  {
    product: 'WordPress/wordpress-develop',
    file: 'WordPress/wordpress-develop/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'admin', 'frontend_rendering', 'hooks_cron_options', 'content_registration', 'media_users', 'performance_surfaces'],
    actionFamilies: ['rest_api', 'database', 'admin', 'frontend', 'hooks', 'cron', 'options', 'content', 'media', 'users', 'rewrite', 'performance'],
    hotspots: ['rest', 'admin', 'frontend', 'editor', 'cron', 'media', 'options', 'database'],
    missingContracts: [],
  },
  {
    product: 'WordPress/gutenberg',
    file: 'WordPress/gutenberg/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'server_requests', 'browser_requests', 'admin_editor_pages', 'frontend_rendering', 'runtime_state', 'performance_observation'],
    actionFamilies: ['editor', 'site_editor', 'templates', 'patterns', 'blocks', 'rest_api', 'database', 'admin', 'frontend', 'external_http', 'performance'],
    hotspots: ['editor', 'site_editor', 'pattern_preview', 'block_rendering', 'api', 'database', 'assets'],
    missingContracts: [],
  },
  {
    product: 'Automattic/jetpack',
    file: 'Automattic/jetpack/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'server_requests', 'browser_requests', 'authenticated_admin_pages', 'options', 'modules', 'sync', 'connection_fixtures', 'public_frontend', 'performance_observation'],
    actionFamilies: ['connection', 'modules', 'sync', 'cron', 'options', 'rest_api', 'database', 'admin', 'public_frontend', 'external_http', 'performance'],
    hotspots: ['connection', 'sync', 'modules', 'admin', 'rest', 'public_frontend', 'external_http', 'database'],
    missingContracts: ['jetpack/wpcom-connected-state-sandbox-contract/v1'],
  },
];

const upstreamContractIds = [
  'wp-codebox/wordpress-fuzz-runtime-contract/v1',
  'homeboy/isolation-proof/v1',
  'homeboy/fuzz-action-model/v1',
  'homeboy/fuzz-exploration-policy/v1',
  'homeboy/wordpress-surface-family-contracts/v1',
  'homeboy/wordpress-fuzz-runtime-workload-operation/v1',
  'wp-codebox/fuzz-artifact-bundle/v1',
  'wp-codebox/sandbox-isolation-proof/v1',
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function assertStringMap(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    assert.equal(typeof entry, 'string', `${label}.${key} must be a string`);
    assert.notEqual(entry.trim(), '', `${label}.${key} must be non-empty`);
  }
}

function assertStringArray(value, expected, label) {
  assert.deepEqual(value, expected, `${label} drifted`);
  for (const entry of value) {
    assert.equal(typeof entry, 'string', `${label} entries must be strings`);
    assert.notEqual(entry.trim(), '', `${label} entries must be non-empty`);
  }
}

test('product full-surface manifests keep product-owned matrix contracts', () => {
  for (const productManifest of productManifests) {
    const manifest = readJson(productManifest.file);
    const matrix = manifest.product_surface_matrix;

    assert.match(manifest.schema, /^homeboy-rigs\/(?:wordpress-)?full-surface-coverage\/v1$/);
    assert.equal(manifest.property, productManifest.product);
    assert.equal(manifest.execution_claim_policy, 'product_manifest_only_no_runner_support_claim');
    assert.ok(matrix && typeof matrix === 'object' && !Array.isArray(matrix), `${productManifest.product} requires product_surface_matrix`);

    assertStringArray(matrix.taxonomy, productManifest.taxonomy, `${productManifest.product} taxonomy`);
    assertStringArray(matrix.action_family_labels, productManifest.actionFamilies, `${productManifest.product} action families`);
    assertStringArray(matrix.relative_hotspot_labels, productManifest.hotspots, `${productManifest.product} relative hotspots`);
    assertStringMap(matrix.fixture_shapes, `${productManifest.product} fixture_shapes`);
    assertStringMap(matrix.side_effect_policies, `${productManifest.product} side_effect_policies`);
  }
});

test('product matrix readiness is wired to explicit upstream contract ids', () => {
  for (const productManifest of productManifests) {
    const manifest = readJson(productManifest.file);
    const contracts = manifest.product_surface_matrix.upstream_contracts;
    const readiness = manifest.product_surface_matrix.readiness_contract;

    assert.ok(contracts && typeof contracts === 'object' && !Array.isArray(contracts), `${productManifest.product} requires upstream_contracts`);
    assert.deepEqual(contracts.contract_ids, upstreamContractIds, `${productManifest.product} upstream contract ids drifted`);
    assert.ok(contracts.source_prs && typeof contracts.source_prs === 'object' && !Array.isArray(contracts.source_prs), `${productManifest.product} upstream source PRs must be recorded`);
    assertStringMap(contracts.source_prs, `${productManifest.product} upstream source PRs`);

    assert.ok(readiness && typeof readiness === 'object' && !Array.isArray(readiness), `${productManifest.product} requires readiness_contract`);
    assert.equal(readiness.schema, 'homeboy-rigs/product-surface-readiness-contract/v1');
    assert.equal(readiness.level, 'executable');
    assert.deepEqual(readiness.contract_ids, upstreamContractIds);
    assert.deepEqual(readiness.missing_upstream_contracts || [], productManifest.missingContracts);
    for (const missing of readiness.missing_upstream_contracts || []) {
      assert.match(missing, /^[a-z0-9._/-]+\/v\d+$/i, `${productManifest.product} missing contract ${missing} must name an exact schema id`);
    }
  }
});

test('product matrices do not define generic runner or Codebox behavior', () => {
  const genericBehaviorKeys = new Set([
    'command',
    'runner',
    'runner_support_status',
    'prepare_command',
    'feature_check',
    'capability_check',
    'shim',
    'fallback',
    'wp_codebox_recipe',
  ]);

  function visit(value, pathParts) {
    if (!value || typeof value !== 'object') {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      assert.ok(!genericBehaviorKeys.has(key), `${pathParts.concat(key).join('.')} must stay out of product matrices`);
      visit(child, pathParts.concat(key));
    }
  }

  for (const productManifest of productManifests) {
    const manifest = readJson(productManifest.file);
    visit(manifest.product_surface_matrix, [productManifest.product, 'product_surface_matrix']);
  }
});

test('Jetpack module-state matrix resolves to a real PHP Codebox workload', () => {
  const workloadPath = 'Automattic/jetpack/fuzz/jetpack-module-state-matrix.json';
  const workload = readJson(workloadPath);
  const phpWorkload = '${package.root}/bench/jetpack-module-state-matrix.php';
  const action = workload.cases[0].phases.action;

  assert.equal(workload.metadata.workload_path, phpWorkload);
  assert.equal(workload.workload.type, 'php');
  assert.equal(workload.workload.path, phpWorkload);
  assert.ok(existsSync(path.join(repoRoot, 'Automattic/jetpack/bench/jetpack-module-state-matrix.php')));
  assert.deepEqual(action, [{
    command: 'wordpress.run-workload',
    args: [`path=${phpWorkload}`, 'type=php'],
  }]);
  assert.deepEqual(workload.artifacts.expected.map(({ name }) => name), ['module_state_matrix']);
  assert.equal(workload.metadata.readiness.mutation.rollback_required, true);
});
