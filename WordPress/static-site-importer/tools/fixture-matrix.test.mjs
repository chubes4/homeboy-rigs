import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareFindingPackets,
  selectorFamily,
} from './compare-finding-packets.mjs';
import {
  buildFixtureMatrixRecipe,
  classifyStaticSiteFinding,
  createFixtureMatrix,
  normalizeFixtureMatrixResult,
  writeFixtureMatrixArtifacts,
} from '../lib/fixture-matrix.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = path.join(packageRoot, 'fixtures');

test('discovers SSI fixtures and writes Blocks Engine site artifacts', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'ssi-fixture-matrix-'));
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'test-matrix' });
  const written = writeFixtureMatrixArtifacts({ outputDirectory, matrix });
  const artifact = JSON.parse(readFileSync(path.join(outputDirectory, 'simple-site', 'artifact.json'), 'utf8'));

  assert.equal(matrix.schema, 'homeboy-rigs/static-site-importer-fixture-matrix/v1');
  assert.equal(matrix.count, 1);
  assert.equal(matrix.fixtures[0].id, 'simple-site');
  assert.equal(artifact.schema, 'blocks-engine/php-transformer/site-artifact/v1');
  assert.ok(artifact.files.some((file) => file.path === 'website/index.html' && file.content.includes('Simple SSI Fixture')));
  assert.ok(artifact.files.some((file) => file.path === 'website/style.css'));
  assert.equal(written.result.summary.not_run, 1);
});

test('builds a generic WP Codebox recipe with SSI-owned plugin defaults', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'recipe-test' });
  const recipe = buildFixtureMatrixRecipe({
    matrix,
    artifactsDirectory: '/tmp/artifacts',
    playgroundArtifactsDirectory: '/wordpress/wp-content/uploads/static-site-importer-fixture-matrix',
    staticSiteImporterPath: '/tmp/static-site-importer',
  });

  assert.equal(recipe.schema, 'wp-codebox/workspace-recipe/v1');
  assert.deepEqual(recipe.inputs.extra_plugins[0], {
    source: '/tmp/static-site-importer',
    slug: 'static-site-importer',
    activate: true,
  });
  assert.equal(recipe.workflow.steps[0].command, 'wordpress.wp-cli');
  assert.equal(recipe.workflow.steps[0].args[0], 'command=plugin activate static-site-importer/static-site-importer.php');
  assert.match(recipe.workflow.steps[1].args[0], /static-site-importer validate-in-codebox/);
  assert.match(recipe.workflow.steps[1].args[0], /--allow-failure/);
});

test('normalizes SSI diagnostics into product repair groups', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'diagnostic-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          { message: 'Dropped image asset during import' },
          { message: 'Unexpected or invalid content in imported block' },
        ],
      },
    ],
  });

  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.groups.dropped_images, 1);
  assert.equal(result.summary.groups.invalid_block_content, 1);
  assert.equal(classifyStaticSiteFinding({ message: 'canvas target missing' }).repair_mode, 'runtime-dom-target-parity');
});

test('compares finding packet deltas by repair dimensions', () => {
  const summary = compareFindingPackets({
    base_label: 'main',
    candidate_label: 'candidate',
    top: 5,
    base: [
      { kind: 'unsupported_html_fallback', group_key: 'static_site_import_quality', repair_bucket: 'runtime_target_gap', fixture_id: 'hero-site', candidate_repo: 'blocks-engine', selector: 'script:nth-of-type(1)' },
      { kind: 'document_metadata_routed', group_key: 'dropped_images', repair_bucket: 'dropped_images', fixture_id: 'shop-site', candidate_repo: 'static-site-importer', selector: '.gallery img' },
    ],
    candidate: [
      { kind: 'document_metadata_routed', group_key: 'dropped_images', repair_bucket: 'dropped_images', fixture_id: 'shop-site', candidate_repo: 'static-site-importer', selector: '.gallery img' },
      { kind: 'document_metadata_routed', group_key: 'dropped_images', repair_bucket: 'dropped_images', fixture_id: 'portfolio-site', candidate_repo: 'static-site-importer', selector: '.gallery img' },
      { kind: 'invalid_block_content', group_key: 'invalid_block_content', repair_bucket: 'invalid_block_content', fixture_id: 'portfolio-site', candidate_repo: 'blocks-engine', selector: '#hero .cta' },
    ],
  });

  assert.deepEqual(summary.totals, { base: 2, candidate: 3, delta: 1 });
  assert.deepEqual(summary.dimensions.bucket.slice(0, 2), [
    { key: 'dropped_images', base: 1, candidate: 2, delta: 1 },
    { key: 'invalid_block_content', base: 0, candidate: 1, delta: 1 },
  ]);
  assert.ok(summary.dimensions.bucket.some((row) => row.key === 'runtime_target_gap' && row.delta === -1));
  assert.deepEqual(summary.dimensions.fixture_id[0], { key: 'portfolio-site', base: 0, candidate: 2, delta: 2 });
  assert.equal(selectorFamily('script:nth-of-type(1)'), 'script');
  assert.equal(selectorFamily('#hero .cta'), 'id:hero');
});
