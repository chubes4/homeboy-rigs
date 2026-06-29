import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertFullSurfaceCoverageManifest } from './fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const productManifests = [
  {
    product: 'woocommerce/woocommerce',
    file: 'woocommerce/woocommerce/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'server_requests', 'browser_requests', 'authenticated_admin_pages', 'options_transients', 'frontend_rendering', 'performance_hotspots'],
    actionFamilies: ['catalog', 'checkout', 'cart_session', 'orders', 'payments', 'shipping_tax', 'admin', 'rest_api', 'options_transients', 'database', 'external_http', 'frontend_rendering'],
    hotspots: ['checkout', 'cart', 'catalog', 'admin', 'api'],
  },
  {
    product: 'WordPress/wordpress-develop',
    file: 'WordPress/wordpress-develop/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'admin', 'frontend_rendering', 'hooks_cron_options', 'content_registration', 'media_users', 'performance_surfaces'],
    actionFamilies: ['rest_api', 'database', 'admin', 'frontend', 'hooks', 'cron', 'options', 'content', 'media', 'users', 'rewrite', 'performance'],
    hotspots: ['rest', 'admin', 'frontend', 'editor', 'cron', 'media', 'options', 'database'],
  },
  {
    product: 'WordPress/gutenberg',
    file: 'WordPress/gutenberg/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'server_requests', 'browser_requests', 'admin_editor_pages', 'frontend_rendering', 'runtime_state', 'performance_observation'],
    actionFamilies: ['editor', 'site_editor', 'templates', 'patterns', 'blocks', 'rest_api', 'database', 'admin', 'frontend', 'external_http', 'performance'],
    hotspots: ['editor', 'site_editor', 'pattern_preview', 'block_rendering', 'api', 'database', 'assets'],
  },
  {
    product: 'Automattic/jetpack',
    file: 'Automattic/jetpack/manifests/full-surface-coverage.json',
    taxonomy: ['rest_api', 'database', 'server_requests', 'browser_requests', 'authenticated_admin_pages', 'options', 'modules', 'sync', 'connection_fixtures', 'public_frontend', 'performance_observation'],
    actionFamilies: ['connection', 'modules', 'sync', 'cron', 'options', 'rest_api', 'database', 'admin', 'public_frontend', 'external_http', 'performance'],
    hotspots: ['connection', 'sync', 'modules', 'admin', 'rest', 'public_frontend', 'external_http', 'database'],
  },
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

    assertFullSurfaceCoverageManifest(manifest, { file: productManifest.product });
    assert.equal(manifest.property, productManifest.product);
    assert.equal(manifest.execution_claim_policy, 'product_manifest_only_no_runner_support_claim');
    assert.equal(manifest.requires_primitives, undefined, `${productManifest.product} must not own generic primitive requirements`);
    assert.ok(matrix && typeof matrix === 'object' && !Array.isArray(matrix), `${productManifest.product} requires product_surface_matrix`);

    assertStringArray(matrix.taxonomy, productManifest.taxonomy, `${productManifest.product} taxonomy`);
    assertStringArray(matrix.action_family_labels, productManifest.actionFamilies, `${productManifest.product} action families`);
    assertStringArray(matrix.relative_hotspot_labels, productManifest.hotspots, `${productManifest.product} relative hotspots`);
    assertStringMap(matrix.fixture_shapes, `${productManifest.product} fixture_shapes`);
    assertStringMap(matrix.side_effect_policies, `${productManifest.product} side_effect_policies`);
  }
});

test('blocked product matrix state stays explicit and non-executable', () => {
  for (const productManifest of productManifests) {
    const manifest = readJson(productManifest.file);
    const blockers = manifest.product_surface_matrix.blocked_upstream_contract_refs;

    assert.ok(Array.isArray(blockers), `${productManifest.product} blockers must be an array`);
    assert.ok(blockers.length > 0, `${productManifest.product} must declare blockers for unsupported upstream contracts`);
    for (const blocker of blockers) {
      assert.match(blocker, /^upstream:[a-z0-9._-]+#[a-z0-9._-]+$/i, `${productManifest.product} blocker ${blocker} must be an explicit upstream contract ref`);
    }

    const matrixText = JSON.stringify(manifest.product_surface_matrix);
    assert.doesNotMatch(matrixText, /\b(executable|supported|proven|available)\b/i, `${productManifest.product} matrix must not claim unsupported execution`);
    assert.match(matrixText, /\b(blocked|classified|declaration|declared|require|requires)\b/i, `${productManifest.product} matrix must describe blocked or declaration-only state`);
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
