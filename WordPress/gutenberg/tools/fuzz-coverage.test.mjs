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
  const runnerSource = readFileSync(path.join(root, 'fuzz/gutenberg-notes-unsaved-attachment.mjs'), 'utf8');
  const traceSource = readFileSync(path.join(root, 'bench/notes-unsaved-attachment.trace.mjs'), 'utf8');
  const browserScriptStart = traceSource.indexOf('const browserScript = `') + 'const browserScript = `'.length;
  const browserScriptEnd = traceSource.indexOf('`;\n\ntry {', browserScriptStart);
  const browserScriptTemplate = traceSource.slice(browserScriptStart, browserScriptEnd);
  const browserScript = Function(
    'readinessTimeoutMs',
    'targetCase',
    'process',
    `return \`${browserScriptTemplate}\``
  )(20000, 'orphan', { env: { HOMEBOY_SEED: '1' } });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const expectedCases = [
    'orphan',
    'saved-anchor',
    'live-create',
    'dirty-live-create',
    'dirty-sibling-live-create',
    'dirty-structural-live-create',
    'nested-live-create',
    'double-live-create',
    'inline-range-live-create',
    'no-saved-match',
    'ambiguous-contentless',
    'empty-saved-content',
    'store-coherence',
    'repair-sync-race',
    'crdt-peer-lineage',
  ];

  assert.deepEqual(inventoryRig.components.gutenberg.extensions.nodejs, {});
  assert.deepEqual(rig.fuzz_profiles['notes-attachment'], ['gutenberg-notes-attachment-corpus']);
  assert.equal(rig.fuzz_workloads.nodejs[0].path, '${package.root}/fuzz/gutenberg-notes-attachment-corpus.json');
  assert.deepEqual(rig.fuzz_workloads.nodejs[0].env_provider_extensions, ['wordpress']);
  assert.deepEqual(workload.metadata.corpus_cases.map(({ id }) => id), expectedCases);
  assert.equal(workload.case_budget, expectedCases.length);
  assert.equal(workload.limits.max_cases, expectedCases.length);
  assert.deepEqual(workload.operations, workload.coverage.operations);
  for (const caseId of expectedCases) {
    assert.match(runnerSource, new RegExp(`\\[ '${caseId}',`));
  }
  assert.equal(workload.workload.path, '${package.root}/fuzz/gutenberg-notes-unsaved-attachment.mjs');
  assert.match(
    workload.metadata.readiness.coverage_contract,
    /builds the exact Gutenberg checkout.*proves plugin bundle provenance/
  );
  assert.match(runnerSource, /npm.*run.*build.*--skip-types/s);
  assert.match(runnerSource, /npm.*ci/s);
  assert.match(runnerSource, /build\/scripts\/core-data\/index\.min\.js/);
  assert.match(traceSource, /gutenberg-plugin-assets-loaded/);
  assert.match(traceSource, /\/wp-content\/plugins\/gutenberg\/build\//);
  assert.match(traceSource, /contenteditable.*data-placeholder.*Add a note/s);
  assert.match(traceSource, /inline-range-live-create/);
  assert.match(traceSource, /core\/note/);
  assert.match(traceSource, /reloadedNoteEntityResolvesToAttachment/);
  assert.match(traceSource, /targetedPersistenceObserved/);
  assert.match(traceSource, /no-saved-match/);
  assert.match(traceSource, /ambiguous-contentless/);
  assert.match(traceSource, /empty-saved-content/);
  assert.match(traceSource, /store-coherence/);
  assert.match(traceSource, /repair-sync-race/);
  assert.match(traceSource, /crdt-peer-lineage/);
  assert.match(traceSource, /actorTimeline/);
  assert.match(traceSource, /HOMEBOY_SEED/);
  assert.doesNotThrow(() => new AsyncFunction(browserScript));
  assert.match(runnerSource, /seed: process\.env\.HOMEBOY_SEED/);
  assert.deepEqual(
    workload.artifacts.expected.map(({ semantic_key }) => semantic_key),
    ['fuzz.case_log', 'fuzz.replay', 'fuzz.report']
  );
});
