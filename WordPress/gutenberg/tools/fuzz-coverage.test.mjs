import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));

test('Gutenberg full-surface profile names proof-ready admin and frontend coverage', () => {
  const manifest = readJson('manifests/full-surface-coverage.json');
  assert.ok(manifest.coverage_profiles.fuzzer.authenticated_admin_pages.includes('gutenberg-admin-page-coverage'));
  assert.ok(manifest.coverage_profiles.fuzzer.frontend_rendering.includes('frontend-rendering-request-coverage'));
  assert.ok(manifest.coverage_profiles.fuzzer.block_rendering.includes('block-rendering-coverage'));
  assert.equal(manifest.surfaces.admin_editor_pages.coverage_artifact, 'homeboy-rigs/gutenberg-admin-page-coverage/v1');
  assert.equal(manifest.surfaces.frontend_rendering.coverage_artifact, 'wp-codebox/browser-request-coverage/v1');
});

test('Gutenberg admin coverage is read-only and records skipped destructive reason codes', () => {
  const workload = readFileSync(path.join(root, 'bench/gutenberg-admin-page-coverage.php'), 'utf8');
  const manifest = readJson('fuzz/gutenberg-admin-page-coverage.json');

  assert.equal(manifest.safety_class, 'read_only');
  assert.ok(manifest.operations.includes('skipped-destructive-action-classification'));
  assert.ok(manifest.metadata.skipped_reason_codes.includes('nonce_action_url'));
  assert.match(workload, /GUTENBERG_ADMIN_PAGE_COVERAGE_LIMIT/);
  assert.match(workload, /install_update_import_export_screen/);
  assert.match(workload, /unsafe_query_arg_/);
  assert.match(workload, /homeboy-rigs\/gutenberg-admin-page-coverage\/v1/);
});

test('Gutenberg browser trace includes frontend fixture and all editor surfaces', () => {
  const trace = readFileSync(path.join(root, 'bench/gutenberg-browser-coverage.trace.mjs'), 'utf8');
  for (const scenario of ['post_editor', 'site_editor', 'template_editor', 'patterns', 'frontend_rendering']) {
    assert.match(trace, new RegExp(`id: '${scenario}'`));
  }
  assert.match(trace, /gutenberg-fuzz-rendering-fixture/);
  assert.match(trace, /wp_insert_post/);
});

test('Pattern preview proof contract keeps asset fanout artifacts explicit', () => {
  const trace = readFileSync(path.join(root, 'bench/pattern-preview-assets.trace.mjs'), 'utf8');
  assert.match(trace, /fixture_asset_response_count/);
  assert.match(trace, /duplicate_fixture_asset_count/);
  assert.match(trace, /Pattern preview asset metrics/);
  assert.match(trace, /Browser network log/);
});
