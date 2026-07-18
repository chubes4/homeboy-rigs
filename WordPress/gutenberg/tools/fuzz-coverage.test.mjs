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
  assert.match(manifest.schema, /^homeboy-rigs\/(?:wordpress-)?full-surface-coverage\/v1$/);
  assert.ok(manifest.coverage_profiles.fuzzer.authenticated_admin_pages.includes('gutenberg-admin-page-coverage'));
  assert.ok(manifest.coverage_profiles.fuzzer.frontend_rendering.includes('frontend-rendering-request-coverage'));
  assert.ok(manifest.coverage_profiles.fuzzer.block_rendering.includes('block-rendering-coverage'));
  assert.equal(manifest.surfaces.admin_editor_pages.coverage_artifact, 'homeboy-rigs/gutenberg-admin-page-coverage/v1');
  assert.equal(manifest.surfaces.frontend_rendering.coverage_artifact, 'wp-codebox/browser-request-coverage/v1');
});

test('Block Notes fuzz rig owns its complete adversarial corpus', () => {
  const inventoryRig = readJson('rigs/gutenberg-api-route-inventory/rig.json');
  const rig = readJson('shared/wordpress-plugin/fuzz-inventory.base.json');
  const workload = readJson('fuzz/gutenberg-notes-attachment-corpus.json');
  const expectedCases = [
    'orphan',
    'saved-anchor',
    'autosave-anchor',
    'live-create',
    'dirty-live-create',
    'dirty-sibling-live-create',
    'dirty-structural-live-create',
    'nested-live-create',
    'double-live-create',
  ];

  assert.deepEqual(inventoryRig.components.gutenberg.extensions.nodejs, {});
  assert.deepEqual(rig.fuzz_profiles['notes-attachment'], ['gutenberg-notes-attachment-corpus']);
  assert.equal(rig.fuzz_workloads.nodejs[0].path, '${package.root}/fuzz/gutenberg-notes-attachment-corpus.json');
  assert.deepEqual(rig.fuzz_workloads.nodejs[0].env_provider_extensions, ['wordpress']);
  assert.deepEqual(workload.metadata.corpus_cases.map(({ id }) => id), expectedCases);
  assert.equal(workload.case_budget, expectedCases.length);
  assert.equal(workload.limits.max_cases, expectedCases.length);
  assert.equal(workload.workload.path, '${package.root}/fuzz/gutenberg-notes-unsaved-attachment.mjs');
  assert.deepEqual(
    workload.artifacts.expected.map(({ semantic_key }) => semantic_key),
    ['fuzz.case_log', 'fuzz.replay', 'fuzz.report']
  );
});
