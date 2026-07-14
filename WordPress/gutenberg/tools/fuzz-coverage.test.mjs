import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertFullSurfaceCoverageManifest } from '../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));

test('Gutenberg full-surface profile names proof-ready admin and frontend coverage', () => {
  const manifest = readJson('manifests/full-surface-coverage.json');
  assertFullSurfaceCoverageManifest(manifest, { file: 'Gutenberg full-surface coverage' });
  assert.ok(manifest.coverage_profiles.fuzzer.authenticated_admin_pages.includes('gutenberg-admin-page-coverage'));
  assert.ok(manifest.coverage_profiles.fuzzer.frontend_rendering.includes('frontend-rendering-request-coverage'));
  assert.ok(manifest.coverage_profiles.fuzzer.block_rendering.includes('block-rendering-coverage'));
  assert.equal(manifest.surfaces.admin_editor_pages.coverage_artifact, 'homeboy-rigs/gutenberg-admin-page-coverage/v1');
  assert.equal(manifest.surfaces.frontend_rendering.coverage_artifact, 'wp-codebox/browser-request-coverage/v1');
});
