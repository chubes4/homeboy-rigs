import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import runFixtureMatrixBench, {
  boundedConcurrency,
  composerPathRepositoryConfig,
  fixtureMatrixBatchRunSummary,
  mapWithConcurrency,
  resolveBlocksEnginePhpTransformerPath,
  runFixtureMatrix,
} from '../bench/static-site-fixture-matrix.bench.mjs';
import {
  buildCodeFreshness,
  buildFixtureMatrixRunPlan,
  CANONICAL_FIXTURE_COUNT,
  resolvePathFreshness,
  summarizeBenchRun,
  summarizeRun,
} from './run-fixture-matrix.mjs';
import {
  compareFindingPackets,
  selectorFamily,
} from './compare-finding-packets.mjs';
import {
  buildFixtureMatrixRecipe,
  classifyFixture,
  classifyStaticSiteFinding,
  collectEditorValidationDiagnostics,
  collectFixtureMatrixRunResults,
  collectVisualParityDiagnostics,
  createFixtureMatrix,
  editorBlockValidationStep,
  EDITOR_INVALID_BLOCK_SELECTOR_GROUP,
  normalizeFixtureMatrixResult,
  normalizeLossClass,
  VISUAL_PARITY_MISMATCH_KIND,
  visualParityCompareStep,
  writeFixtureMatrixArtifacts,
} from '../lib/fixture-matrix.mjs';
import { materializeGeneratedArtifactFixtures } from '../lib/artifact-intake.mjs';

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
  assert.match(recipe.workflow.steps[1].args[0], /static-site-importer validate-artifact/);
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

test('gates fixture matrix failures by unacceptable loss classes', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'loss-class-gate-test' });
  const acceptableResult = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          {
            kind: 'runtime_dependency_missing_dom_target',
            loss_class: 'preserved_runtime_island',
            runtime_carried: true,
            source_path: 'website/index.html',
            selector: '#hero canvas',
            message: 'Runtime island preserved for editor-safe import.',
          },
          {
            kind: 'html_canvas_runtime_fallback',
            loss_class: 'preserved_runtime_island',
            runtime_carried: true,
            source_path: 'website/index.html',
            selector: '#hero canvas',
            message: 'Blocks Engine reported the same preserved runtime island.',
          },
        ],
      },
    ],
  });

  assert.equal(acceptableResult.summary.succeeded, 1);
  assert.equal(acceptableResult.summary.failed, 0);
  assert.equal(acceptableResult.summary.acceptable_finding_count, 1);
  assert.equal(acceptableResult.summary.unacceptable_finding_count, 0);
  assert.equal(acceptableResult.summary.preserved_runtime_island_count, 1);
  assert.equal(acceptableResult.findings.length, 1);
  assert.equal(acceptableResult.fixtures[0].raw_status, 'failed');
  assert.equal(acceptableResult.fixtures[0].status, 'passed');
  assert.equal(acceptableResult.fixtures[0].quality_gate.loss_classes.preserved_runtime_island, 1);

  const unacceptableResult = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
      },
    ],
  });

  assert.equal(unacceptableResult.summary.failed, 1);
  assert.equal(unacceptableResult.summary.unacceptable_finding_count, 1);
  assert.equal(unacceptableResult.summary.unacceptable_loss_classes.fixture_failed, 1);
});

test('fails the gate when a preserved_runtime_island carries no runtime-carried signal', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'runtime-island-no-signal-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          {
            kind: 'html_form_fallback',
            loss_class: 'preserved_runtime_island',
            source_path: 'posts/page-contact.post_content',
            selector: 'form#contact',
            message: 'Contact form markup preserved but no handler was carried.',
          },
        ],
      },
    ],
  });

  const finding = result.findings[0];
  assert.equal(finding.loss_class, 'preserved_runtime_island');
  assert.equal(finding.loss_acceptance, 'unacceptable');
  assert.equal(finding.acceptable_loss, false);
  assert.equal(result.summary.preserved_runtime_island_count, 1);
  assert.equal(result.summary.acceptable_finding_count, 0);
  assert.equal(result.summary.unacceptable_finding_count, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.succeeded, 0);
  assert.equal(result.fixtures[0].status, 'failed');
});

test('passes the gate when a preserved_runtime_island carries a runtime-carried signal', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'runtime-island-signal-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          {
            kind: 'html_form_fallback',
            loss_class: 'preserved_runtime_island',
            runtime_mapped: 'wp-block-contact-form',
            source_path: 'posts/page-contact.post_content',
            selector: 'form#contact',
            message: 'Contact form markup preserved and behavior mapped to a native block.',
          },
        ],
      },
    ],
  });

  const finding = result.findings[0];
  assert.equal(finding.loss_class, 'preserved_runtime_island');
  assert.equal(finding.loss_acceptance, 'acceptable');
  assert.equal(finding.acceptable_loss, true);
  assert.equal(result.summary.acceptable_finding_count, 1);
  assert.equal(result.summary.unacceptable_finding_count, 0);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.fixtures[0].status, 'passed');
});

test('normalizes the transformer-emitted runtime_island_preserved loss class to the canonical preserved_runtime_island', () => {
  // The php-transformer emits `runtime_island_preserved` (FallbackDiagnostic /
  // HtmlTransformer). The alias must deterministically canonicalize it without
  // relying on the wording regex fallback.
  assert.equal(normalizeLossClass('runtime_island_preserved'), 'preserved_runtime_island');
  assert.equal(normalizeLossClass('preserved_runtime_island'), 'preserved_runtime_island');
  assert.equal(normalizeLossClass('runtime_island'), 'preserved_runtime_island');
});

test('classifies a transformer runtime_island_preserved finding as acceptable without relying on message wording', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'runtime-island-preserved-alias-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          {
            kind: 'html_script_fallback',
            // Exact string emitted by the php-transformer; carries no
            // "runtime island" wording in kind/message so acceptance must come
            // from the explicit alias, not the wording regex fallback.
            loss_class: 'runtime_island_preserved',
            runtime_carried: true,
            source_path: 'website/index.html',
            selector: 'script#app',
            message: 'Script kept verbatim.',
          },
        ],
      },
    ],
  });

  const finding = result.findings[0];
  assert.equal(finding.loss_class, 'preserved_runtime_island');
  assert.equal(finding.loss_acceptance, 'acceptable');
  assert.equal(finding.acceptable_loss, true);
  assert.equal(result.summary.acceptable_finding_count, 1);
  assert.equal(result.summary.unacceptable_finding_count, 0);
  assert.equal(result.summary.preserved_runtime_island_count, 1);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.fixtures[0].status, 'passed');
});

test('keeps native_conversion findings acceptable without a runtime-carried signal', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'native-conversion-acceptance-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          {
            kind: 'native_block_conversion',
            loss_class: 'native_conversion',
            source_path: 'website/index.html',
            message: 'Converted natively to editor blocks.',
          },
        ],
      },
    ],
  });

  const finding = result.findings[0];
  assert.equal(finding.loss_class, 'native_conversion');
  assert.equal(finding.loss_acceptance, 'acceptable');
  assert.equal(result.summary.acceptable_finding_count, 1);
  assert.equal(result.summary.unacceptable_finding_count, 0);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.fixtures[0].status, 'passed');
});

test('classifies fixtures into generic product taxonomy from metadata and files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-fixture-taxonomy-'));
  const shop = path.join(root, 'spring-shop');
  const shader = path.join(root, 'interactive-demo');
  mkdirSync(path.join(shop, 'products'), { recursive: true });
  mkdirSync(path.join(shader, 'assets'), { recursive: true });
  writeFileSync(path.join(shop, 'index.html'), '<h1>Catalog</h1>');
  writeFileSync(path.join(shop, 'products', 'shoe.html'), '<h2>Shoe</h2>');
  writeFileSync(path.join(shader, 'index.html'), '<canvas id="hero"></canvas>');
  writeFileSync(path.join(shader, 'assets', 'shader.js'), 'document.querySelector("canvas");');

  const matrix = createFixtureMatrix({ fixture_root: root });

  assert.equal(classifyFixture({ product_class: 'docs' }).fixture_class, 'docs/blog');
  assert.equal(matrix.fixtures.find((fixture) => fixture.id === 'spring-shop').fixture_class, 'ecommerce/catalog');
  assert.equal(matrix.fixtures.find((fixture) => fixture.id === 'interactive-demo').fixture_class, 'canvas/webgl/audio/runtime-heavy');
});

test('classifies fixtures from directory taxonomy before heuristic fallback', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-fixture-directory-taxonomy-'));
  const cases = [
    ['marketing-static', 'spring-shop', '<h1>Product Catalog Checkout</h1>', 'marketing/static'],
    ['docs-blog', 'admin-portal', '<h1>Dashboard Settings</h1>', 'docs/blog'],
    ['ecommerce-catalog', 'launch-page', '<h1>Marketing Landing Hero</h1>', 'ecommerce/catalog'],
    ['app-dashboard', 'news-guide', '<article>Blog documentation tutorial</article>', 'app/dashboard'],
    ['runtime-heavy', 'plain-copy', '<h1>Simple static brochure</h1>', 'canvas/webgl/audio/runtime-heavy'],
    ['canvas-webgl-audio', 'plain-copy', '<h1>Simple static brochure</h1>', 'canvas/webgl/audio/runtime-heavy'],
    ['edge-cases', 'shop-catalog', '<h1>Product Catalog Checkout</h1>', 'unknown'],
  ];

  for (const [directoryClass, fixtureName, html] of cases) {
    const fixtureDirectory = path.join(root, directoryClass, fixtureName);
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(path.join(fixtureDirectory, 'index.html'), html);
  }

  const matrix = createFixtureMatrix({ fixture_root: root });
  const byId = new Map(matrix.fixtures.map((fixture) => [fixture.id, fixture]));

  for (const [directoryClass, fixtureName, , fixtureClass] of cases) {
    assert.equal(byId.get(`${directoryClass}-${fixtureName}`).fixture_class, fixtureClass);
    assert.deepEqual(byId.get(`${directoryClass}-${fixtureName}`).taxonomy.signals, ['directory_taxonomy']);
  }

  assert.equal(classifyFixture({ fixture_class: 'docs/blog', root, directory: path.join(root, 'marketing-static', 'manual') }).fixture_class, 'docs/blog');
});

test('rolls fixture matrix summaries up by fixture class and repair bucket', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-fixture-class-rollups-'));
  const shop = path.join(root, 'shop-catalog');
  const docs = path.join(root, 'docs-blog');
  mkdirSync(shop, { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(shop, 'index.html'), '<h1>Shop</h1>');
  writeFileSync(path.join(docs, 'index.html'), '<article>Docs</article>');
  const matrix = createFixtureMatrix({ fixture_root: root, id: 'taxonomy-rollup-test' });

  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'shop-catalog',
        status: 'failed',
        diagnostics: [
          { kind: 'missing_asset', message: 'Missing image asset for product gallery' },
          { kind: 'invalid_block_content', message: 'Unexpected or invalid content in product card' },
        ],
      },
      {
        fixture_id: 'docs-blog',
        status: 'passed',
      },
    ],
  });

  assert.equal(result.fixtures.find((fixture) => fixture.fixture_id === 'shop-catalog').fixture_class, 'ecommerce/catalog');
  assert.equal(result.findings[0].fixture_class, 'ecommerce/catalog');
  assert.equal(result.summary.fixture_classes['ecommerce/catalog'], 1);
  assert.equal(result.summary.classes['ecommerce/catalog'].failed, 1);
  assert.equal(result.summary.classes['ecommerce/catalog'].repair_buckets.dropped_images, 1);
  assert.equal(result.summary.classes['ecommerce/catalog'].repair_buckets.invalid_block_content, 1);
  assert.equal(result.summary.quality_budgets['ecommerce/catalog'].findings_per_fixture, 2);
  assert.deepEqual(result.summary.quality_budgets['docs/blog'].dominant_repair_buckets, []);
});

test('aggregates pattern families, fixture exemplars, and diagnostic blind spots', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'diagnostic-rollup-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          {
            kind: 'runtime_dependency_missing_dom_target',
            repair_bucket: 'runtime_target_gap',
            candidate_repo: 'blocks-engine',
            source_path: 'website/index.html',
            selector: '#hero canvas',
            source_html_preview: '<canvas id="hero"></canvas>',
            emitted_block_preview: '<!-- wp:group -->',
            message: 'Runtime target #hero canvas is missing after import.',
          },
          { message: 'Unclassified import quality issue.' },
        ],
      },
    ],
  });

  assert.equal(result.summary.top_pattern_families[0].key, 'runtime_target_gap:runtime_dependency_missing_dom_target:id:hero');
  assert.equal(result.summary.fixture_exemplars[0].fixture_id, 'simple-site');
  assert.equal(result.summary.fixture_exemplars[0].source_snippet, '<canvas id="hero"></canvas>');
  assert.equal(result.fanout_groups[0].count, 1);
  assert.ok(result.summary.diagnostic_blind_spots.some((spot) => spot.kind === 'generic_finding_family'));
});

test('suppresses count-only fixture diagnostics from actionable fanout rollups', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'count-only-diagnostic-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: [
          2,
          {
            kind: 'core_html_block',
            repair_bucket: 'fallback_block',
            selector: 'input#email',
            source_path: 'posts/page-contact.post_content',
            message: 'generated_document_contains_core_html',
          },
        ],
      },
    ],
  });

  assert.equal(result.summary.finding_count, 2);
  assert.equal(result.summary.actionable_finding_count, 1);
  assert.equal(result.summary.non_actionable_finding_count, 1);
  assert.equal(result.findings.find((finding) => finding.kind === 'static_site_fixture_diagnostic').actionability, 'count_only');
  assert.equal(result.summary.top_pattern_families[0].key, 'fallback_block:core_html_block:input');
  assert.equal(result.summary.top_pattern_families.some((family) => family.key === 'static_site_import_quality:static_site_fixture_diagnostic:(none)'), false);
  assert.equal(result.fanout_groups.length, 1);
  assert.equal(result.fanout_groups[0].findings.length, 1);
  assert.equal(result.fanout_groups[0].findings[0].kind, 'core_html_block');
});

test('splits acceptable and unacceptable pattern rollups for minion fanout', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-fanout-rollups-'));
  for (const fixture of ['fixture-alpha', 'fixture-beta', 'fixture-gamma']) {
    mkdirSync(path.join(root, fixture), { recursive: true });
    writeFileSync(path.join(root, fixture, 'index.html'), '<main>Fixture</main>');
  }

  const matrix = createFixtureMatrix({ fixture_root: root, id: 'fanout-rollup-test' });

  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'fixture-alpha',
        status: 'failed',
        diagnostics: [
          {
            kind: 'layout_shift',
            candidate_repo: 'blocks-engine',
            source_path: 'website/index.html',
            message: 'Unexpected layout shift in imported hero.',
          },
          {
            kind: 'native_block_conversion',
            loss_class: 'native_conversion',
            candidate_repo: 'blocks-engine',
            source_path: 'website/index.html',
            message: 'Converted natively to editor blocks.',
          },
        ],
      },
      {
        fixture_id: 'fixture-beta',
        status: 'failed',
        diagnostics: [
          {
            kind: 'layout_shift',
            candidate_repo: 'blocks-engine',
            source_path: 'website/index.html',
            message: 'Unexpected layout shift in imported hero.',
          },
        ],
      },
      {
        fixture_id: 'fixture-gamma',
        status: 'failed',
        diagnostics: [
          {
            kind: 'font_color_loss',
            candidate_repo: 'static-site-importer',
            source_path: 'website/index.html',
            message: 'Font color changed after import.',
          },
        ],
      },
    ],
  });

  assert.equal(result.summary.finding_count, 4);
  assert.equal(result.summary.actionable_finding_count, 4);
  assert.equal(result.summary.acceptable_finding_count, 1);
  assert.equal(result.summary.unacceptable_finding_count, 3);
  assert.equal(result.summary.groups.static_site_import_quality, 4);
  assert.equal(result.summary.top_acceptable_pattern_families[0].key, 'static_site_import_quality:native_block_conversion:(none)');
  assert.equal(result.summary.top_unacceptable_pattern_families[0].key, 'static_site_import_quality:layout_shift:(none)');
  assert.equal(result.summary.top_unacceptable_pattern_families[0].count, 2);
  assert.equal(result.summary.unacceptable_candidate_repos[0].candidate_repo, 'blocks-engine');
  assert.equal(result.summary.unacceptable_candidate_repos[0].count, 2);
  assert.equal(result.summary.unacceptable_candidate_repos[0].top_pattern_families[0].key, 'static_site_import_quality:layout_shift:(none)');
  assert.equal(result.fanout_groups[0].acceptance, 'unacceptable');
  assert.equal(result.fanout_groups[0].candidate_repo, 'blocks-engine');
  assert.equal(result.fanout_groups[0].pattern_family, 'static_site_import_quality:layout_shift:(none)');
  assert.equal(result.fanout_groups[0].count, 2);
  assert.notEqual(result.fanout_groups[0].group_key, 'static_site_import_quality');
});

test('suppresses pre-normalized count-only fixture diagnostics with fixture source paths', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'pre-normalized-count-only-diagnostic-test' });
  const fixturePath = matrix.fixtures[0].fixture_path;
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        fixture_path: fixturePath,
        status: 'failed',
        diagnostics: [
          {
            kind: 'static_site_fixture_diagnostic',
            group_key: 'static_site_import_quality',
            repair_bucket: 'static_site_import_quality',
            source_path: fixturePath,
            reason: '2',
          },
          {
            kind: 'core_html_block',
            repair_bucket: 'fallback_block',
            selector: 'input#email',
            source_path: 'posts/page-contact.post_content',
            message: 'generated_document_contains_core_html',
          },
        ],
      },
    ],
  });

  assert.equal(result.summary.finding_count, 2);
  assert.equal(result.summary.actionable_finding_count, 1);
  assert.equal(result.summary.non_actionable_finding_count, 1);
  assert.equal(result.findings.find((finding) => finding.kind === 'static_site_fixture_diagnostic').actionability, 'count_only');
  assert.equal(result.summary.top_pattern_families.some((family) => family.key === 'static_site_import_quality:static_site_fixture_diagnostic:(none)'), false);
  assert.equal(result.summary.fixture_exemplars.some((exemplar) => exemplar.kind === 'static_site_fixture_diagnostic'), false);
  assert.equal(result.summary.diagnostic_blind_spots.some((spot) => spot.exemplars.some((exemplar) => exemplar.kind === 'static_site_fixture_diagnostic')), false);
  assert.equal(result.fanout_groups.length, 1);
  assert.equal(result.fanout_groups[0].findings.some((finding) => finding.kind === 'static_site_fixture_diagnostic'), false);
});

test('collects SSI finding packet source and observed context from fixture artifacts', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'ssi-finding-packet-context-'));
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'packet-context-test' });
  const fixtureDirectory = path.join(outputDirectory, 'simple-site');
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(path.join(fixtureDirectory, 'import-report.json'), JSON.stringify({
    success: false,
    fixture_id: 'simple-site',
    finding_packets: {
      packets: [
        {
          type: 'runtime_dependency_missing_dom_target',
          severity: 'error',
          source: {
            path: 'website/index.html',
            selector: '.shader canvas',
            snippet: '<canvas class="shader"></canvas>',
          },
          observed: {
            reason_code: 'runtime_dependency_missing_dom_target',
            output: '<!-- wp:html /-->',
          },
          expected: {
            outcome: 'Runtime target should exist after import.',
          },
        },
      ],
    },
  }));

  const result = collectFixtureMatrixRunResults({ matrix, outputDirectory });
  const finding = result.findings[0];

  assert.equal(result.summary.finding_count, 1);
  assert.equal(finding.source_path, 'website/index.html');
  assert.equal(finding.selector, '.shader canvas');
  assert.equal(finding.selector_family, 'class:shader');
  assert.equal(finding.source_snippet, '<canvas class="shader"></canvas>');
  assert.equal(finding.observed_output, '<!-- wp:html /-->');
});

test('materializes generated artifact roots into matrix-compatible fixtures', () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'ssi-generated-artifacts-'));
  const fixtureOutput = mkdtempSync(path.join(tmpdir(), 'ssi-generated-fixtures-'));
  mkdirSync(path.join(sourceRoot, 'static-sites', 'alpha', 'assets'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'static-sites', 'alpha', 'index.html'), '<h1>Alpha</h1>');
  writeFileSync(path.join(sourceRoot, 'static-sites', 'alpha', 'assets', 'style.css'), 'body { color: black; }');
  mkdirSync(path.join(sourceRoot, 'artifact-candidate'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'artifact-candidate', 'artifact.json'), JSON.stringify({
    schema: 'blocks-engine/php-transformer/site-artifact/v1',
    metadata: { site: 'Beta Site' },
    files: [
      { path: 'website/index.html', content: '<h1>Beta</h1>' },
      { path: 'website/assets/style.css', content: 'body { color: blue; }' },
    ],
  }));

  const intake = materializeGeneratedArtifactFixtures({ artifactRoot: sourceRoot, fixtureRoot: fixtureOutput });
  const matrix = createFixtureMatrix({ fixture_root: intake.fixture_root });

  assert.equal(intake.count, 2);
  assert.deepEqual(matrix.fixtures.map((fixture) => fixture.id), ['alpha', 'beta-site']);
  assert.equal(readFileSync(path.join(fixtureOutput, 'alpha', 'index.html'), 'utf8'), '<h1>Alpha</h1>');
  assert.equal(readFileSync(path.join(fixtureOutput, 'beta-site', 'index.html'), 'utf8'), '<h1>Beta</h1>');
});

test('resolves Blocks Engine PHP transformer override paths', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'blocks-engine-'));
  const packageRoot = path.join(repoRoot, 'php-transformer');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, 'composer.json'), JSON.stringify({
    name: 'automattic/blocks-engine-php-transformer',
  }));

  assert.equal(resolveBlocksEnginePhpTransformerPath(repoRoot), packageRoot);
  assert.equal(resolveBlocksEnginePhpTransformerPath(packageRoot), packageRoot);
});

test('builds Composer path repository override matching SSI constraints', () => {
  const config = composerPathRepositoryConfig({
    require: {
      'automattic/blocks-engine-php-transformer': '^0.1.15',
    },
  }, '/tmp/blocks-engine/php-transformer');

  assert.deepEqual(config, {
    type: 'path',
    url: '/tmp/blocks-engine/php-transformer',
    canonical: true,
    options: {
      symlink: false,
      versions: {
        'automattic/blocks-engine-php-transformer': '0.1.15',
      },
    },
  });
});

test('summarizes failed WP Codebox batches with fixture ids and child output tails', () => {
  const stderr = `${'x'.repeat(4100)}stderr failure for fixture-beta`;
  const stdout = 'stdout includes child JSON/error context';
  const summary = fixtureMatrixBatchRunSummary({
    batchNumber: 2,
    batchMatrix: { id: 'matrix-batch-002' },
    fixtures: [{ id: 'fixture-alpha' }, { id: 'fixture-beta' }],
    batchRecipeFile: '/tmp/wp-codebox-static-site-fixture-matrix-batch-002.json',
    outputFile: '/tmp/wp-codebox-output-batch-002.json',
    batchRuntime: { exitCode: 1, json: { ok: false } },
    batchError: { message: 'recipe-run failed', stderr, stdout },
  });

  assert.equal(summary.batch, 2);
  assert.equal(summary.batch_id, 'matrix-batch-002');
  assert.deepEqual(summary.fixture_ids, ['fixture-alpha', 'fixture-beta']);
  assert.equal(summary.fixture_count, 2);
  assert.equal(summary.exit_code, 1);
  assert.equal(summary.error, 'recipe-run failed');
  assert.equal(summary.parsed_output, true);
  assert.equal(summary.stderr_tail.length, 4000);
  assert.match(summary.stderr_tail, /stderr failure for fixture-beta$/);
  assert.equal(summary.stdout_tail, stdout);
});

test('builds one-command canonical Blocks Engine fixture matrix plan', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-canonical-matrix-'));
  const staticSiteImporter = path.join(root, 'static-site-importer');
  const blocksEngine = path.join(root, 'blocks-engine');
  const fixtureRoot = path.join(blocksEngine, 'fixtures', 'websites');
  mkdirSync(staticSiteImporter, { recursive: true });
  for (let index = 1; index <= CANONICAL_FIXTURE_COUNT; index += 1) {
    mkdirSync(path.join(fixtureRoot, `fixture-${String(index).padStart(2, '0')}`), { recursive: true });
  }

  const plan = buildFixtureMatrixRunPlan({
    runner: 'homeboy-lab',
    staticSiteImporter,
    blocksEngine,
    homeboyBin: '/tmp/homeboy-latest',
    runId: 'ssi-matrix-dev-proof',
    passthrough: ['--batch-size', '5'],
    skipInstall: true,
  });

  assert.equal(plan.mode, 'development-override');
  assert.equal(plan.homeboy_bin, '/tmp/homeboy-latest');
  assert.equal(plan.fixture_root, fixtureRoot);
  assert.equal(plan.fixture_count, CANONICAL_FIXTURE_COUNT);
  assert.equal(plan.fixture_count_matches_canonical, true);
  assert.equal(plan.namespace, 'ssi-matrix-dev-proof');
  assert.equal(plan.temp_root, '/tmp/homeboy-rigs-ssi-fixture-matrix-ssi-matrix-dev-proof');
  assert.equal(plan.shared_state, '/tmp/homeboy-rigs-ssi-fixture-matrix-ssi-matrix-dev-proof/shared-state');
  assert.equal(plan.artifact_root, '/tmp/homeboy-rigs-ssi-fixture-matrix-ssi-matrix-dev-proof/artifacts');
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.dependency_overrides.blocks_engine_php_transformer.path, blocksEngine);
  assert.equal(plan.steps.some((step) => step.args.includes('install')), false);
  assert.ok(plan.steps.some((step) => step.args.includes('sync')));

  const benchStep = plan.steps.at(-1);
  assert.deepEqual(benchStep.args.slice(0, 7), ['bench', '--rig', 'static-site-importer-fixture-matrix', '--profile', 'fixture-matrix', '--iterations', '1']);
  assert.equal(benchStep.command, '/tmp/homeboy-latest');
  assert.ok(benchStep.args.includes('--runner'));
  assert.ok(benchStep.args.includes('homeboy-lab'));
  assert.ok(benchStep.args.includes(`bench_env.SSI_FIXTURE_MATRIX_FIXTURE_ROOT=${fixtureRoot}`));
  assert.ok(benchStep.args.includes(`bench_env.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PATH=${staticSiteImporter}`));
  assert.ok(benchStep.args.includes(`bench_env.SSI_FIXTURE_MATRIX_BLOCKS_ENGINE_PHP_TRANSFORMER_PATH=${blocksEngine}`));
  assert.ok(benchStep.args.includes('bench_env.SSI_FIXTURE_MATRIX_RUN=1'));
  assert.ok(benchStep.args.includes('static_site_importer_fixture_matrix_namespace=ssi-matrix-dev-proof'));
  assert.ok(benchStep.args.includes('/tmp/homeboy-rigs-ssi-fixture-matrix-ssi-matrix-dev-proof/artifacts'));
  assert.deepEqual(benchStep.args.slice(-3), ['--', '--batch-size', '5']);

  const releasePlan = buildFixtureMatrixRunPlan({
    mode: 'release-proof',
    staticSiteImporter,
    blocksEngine,
    passthrough: [],
  });
  assert.deepEqual(releasePlan.dependency_overrides, {});
  assert.equal(releasePlan.steps.at(-1).args.some((arg) => arg.includes('SSI_FIXTURE_MATRIX_BLOCKS_ENGINE_PHP_TRANSFORMER_PATH')), false);
});

test('fixture matrix records generic child command failures for failed WP Codebox batches', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-codebox-failure-'));
  const staticSiteImporter = path.join(root, 'static-site-importer');
  const fixtureRoot = path.join(root, 'fixtures');
  const outputDirectory = path.join(root, 'artifacts');
  const helperPath = path.join(root, 'wp-codebox-recipe-helper.cjs');
  mkdirSync(staticSiteImporter, { recursive: true });
  mkdirSync(path.join(fixtureRoot, 'failing-fixture'), { recursive: true });
  writeFileSync(path.join(fixtureRoot, 'failing-fixture', 'index.html'), '<h1>Failing fixture</h1>');
  writeFileSync(helperPath, `
function wpCodeboxBin() { return '/tmp/wp-codebox'; }
function wpCodeboxCommand(bin) { return { command: bin, args: [] }; }
async function runWpCodeboxRecipe() {
  const error = new Error('recipe-run failed');
  error.code = 17;
  error.stdout = 'stdout line 1\\nstdout line 2';
  error.stderr = 'stderr line 1\\nstderr line 2';
  throw error;
}
module.exports = { wpCodeboxBin, wpCodeboxCommand, runWpCodeboxRecipe };
`, 'utf8');
  const previousHelper = process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
  const previousFixtureRoot = process.env.SSI_FIXTURE_MATRIX_FIXTURE_ROOT;
  const previousOutputDirectory = process.env.SSI_FIXTURE_MATRIX_OUTPUT_DIRECTORY;
  const previousImporterPath = process.env.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PATH;
  const previousRun = process.env.SSI_FIXTURE_MATRIX_RUN;
  const previousBatchSize = process.env.SSI_FIXTURE_MATRIX_BATCH_SIZE;
  process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER = helperPath;

  try {
    const { summary, runtimeError } = await runFixtureMatrix({
      fixtureRoot,
      outputDirectory,
      staticSiteImporterPath: staticSiteImporter,
      run: true,
      batchSize: 1,
    });
    const failure = summary.runtime.child_command_failures[0];

    assert.equal(runtimeError.message, 'recipe-run failed');
    assert.equal(summary.runtime.exit_code, 17);
    assert.equal(failure.schema, 'homeboy/child-command-failure/v1');
    assert.equal(failure.exit_status, 17);
    assert.equal(failure.batch_id, 'batch-001');
    assert.deepEqual(failure.command.argv, [
      '/tmp/wp-codebox',
      'recipe-run',
      failure.artifact_refs.batch_recipe,
      '--artifacts-dir', outputDirectory,
      '--output', failure.artifact_refs.batch_output,
    ]);
    assert.equal(failure.stdout_tail, 'stdout line 1\nstdout line 2');
    assert.equal(failure.stderr_tail, 'stderr line 1\nstderr line 2');
    assert.equal(failure.artifact_refs.artifacts_directory, outputDirectory);
    assert.equal(failure.artifact_refs.output_file, failure.artifact_refs.batch_output);
    assert.ok(readFileSync(path.join(outputDirectory, 'cli-run.json'), 'utf8').includes('child_command_failures'));

    process.env.SSI_FIXTURE_MATRIX_FIXTURE_ROOT = fixtureRoot;
    process.env.SSI_FIXTURE_MATRIX_OUTPUT_DIRECTORY = path.join(root, 'bench-export-artifacts');
    process.env.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PATH = staticSiteImporter;
    process.env.SSI_FIXTURE_MATRIX_RUN = '1';
    process.env.SSI_FIXTURE_MATRIX_BATCH_SIZE = '1';
    await assert.rejects(
      () => runFixtureMatrixBench(),
      (error) => {
        assert.equal(error.message, 'recipe-run failed');
        assert.equal(error.child_command_failures[0].exit_status, 17);
        assert.equal(error.child_command_failures[0].artifact_refs.artifacts_directory, process.env.SSI_FIXTURE_MATRIX_OUTPUT_DIRECTORY);
        return true;
      }
    );
  } finally {
    if (previousHelper === undefined) {
      delete process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
    } else {
      process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER = previousHelper;
    }
    restoreEnv('SSI_FIXTURE_MATRIX_FIXTURE_ROOT', previousFixtureRoot);
    restoreEnv('SSI_FIXTURE_MATRIX_OUTPUT_DIRECTORY', previousOutputDirectory);
    restoreEnv('SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PATH', previousImporterPath);
    restoreEnv('SSI_FIXTURE_MATRIX_RUN', previousRun);
    restoreEnv('SSI_FIXTURE_MATRIX_BATCH_SIZE', previousBatchSize);
  }
});

function fakeGitRunner(stateByPath) {
  return (cwd, args) => {
    const state = stateByPath[path.resolve(cwd)];
    if (!state) {
      return { status: 1, stdout: '', stderr: 'not a git repo' };
    }
    const joined = args.join(' ');
    if (joined === 'rev-parse --is-inside-work-tree') {
      return { status: 0, stdout: 'true', stderr: '' };
    }
    if (joined === 'rev-parse --abbrev-ref HEAD') {
      return { status: 0, stdout: state.branch || 'trunk', stderr: '' };
    }
    if (joined === 'rev-parse HEAD') {
      return { status: 0, stdout: state.commit || 'deadbeef', stderr: '' };
    }
    if (joined === 'status --porcelain') {
      return { status: 0, stdout: state.dirty ? ' M file.php' : '', stderr: '' };
    }
    if (joined === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
      return state.upstream
        ? { status: 0, stdout: state.upstream, stderr: '' }
        : { status: 128, stdout: '', stderr: 'no upstream' };
    }
    if (args[0] === 'rev-list') {
      return { status: 0, stdout: `${state.behind || 0}\t${state.ahead || 0}`, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unhandled git command' };
  };
}

test('code freshness guard blocks stale overrides unless explicitly allowed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-freshness-stale-'));
  const staticSiteImporter = path.join(root, 'static-site-importer');
  const blocksEngine = path.join(root, 'blocks-engine');
  const fixtureRoot = path.join(blocksEngine, 'fixtures', 'websites');
  mkdirSync(staticSiteImporter, { recursive: true });
  mkdirSync(path.join(fixtureRoot, 'fixture-a'), { recursive: true });

  const gitRunner = fakeGitRunner({
    [path.resolve(blocksEngine)]: { branch: 'trunk', upstream: 'origin/trunk', behind: 33, ahead: 0, commit: 'staleabc' },
    [path.resolve(staticSiteImporter)]: { branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, commit: 'freshxyz' },
  });

  const stalePlan = buildFixtureMatrixRunPlan({
    staticSiteImporter,
    blocksEngine,
    runId: 'ssi-freshness-stale',
    skipInstall: true,
    skipSync: true,
    gitRunner,
  });

  assert.equal(stalePlan.code_freshness.would_block, true);
  assert.deepEqual(stalePlan.code_freshness.stale_overrides, ['blocks_engine_php_transformer_path']);
  assert.equal(stalePlan.code_freshness.paths.blocks_engine_php_transformer_path.status, 'behind');
  assert.equal(stalePlan.code_freshness.paths.blocks_engine_php_transformer_path.behind, 33);
  assert.equal(stalePlan.code_freshness.paths.static_site_importer.status, 'fresh');
  assert.equal(stalePlan.transformer_commit, 'staleabc');
  assert.ok(stalePlan.warnings.some((warning) => warning.code === 'stale_override'));
  assert.equal(stalePlan.warnings.some((warning) => warning.code === 'stale_override_allowed'), false);

  const allowedPlan = buildFixtureMatrixRunPlan({
    staticSiteImporter,
    blocksEngine,
    runId: 'ssi-freshness-stale-allowed',
    skipInstall: true,
    skipSync: true,
    allowStaleOverride: true,
    gitRunner,
  });

  assert.equal(allowedPlan.code_freshness.would_block, true);
  assert.equal(allowedPlan.allow_stale_override, true);
  assert.ok(allowedPlan.warnings.some((warning) => warning.code === 'stale_override_allowed'));
});

test('code freshness guard lets fresh and diverged overrides through with accurate status', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-freshness-fresh-'));
  const staticSiteImporter = path.join(root, 'static-site-importer');
  const blocksEngine = path.join(root, 'blocks-engine');
  const fixtureRoot = path.join(blocksEngine, 'fixtures', 'websites');
  mkdirSync(staticSiteImporter, { recursive: true });
  mkdirSync(path.join(fixtureRoot, 'fixture-a'), { recursive: true });

  const freshPlan = buildFixtureMatrixRunPlan({
    staticSiteImporter,
    blocksEngine,
    runId: 'ssi-freshness-fresh',
    skipInstall: true,
    skipSync: true,
    gitRunner: fakeGitRunner({
      [path.resolve(blocksEngine)]: { branch: 'trunk', upstream: 'origin/trunk', behind: 0, ahead: 2, commit: 'aheadcommit' },
      [path.resolve(staticSiteImporter)]: { branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, commit: 'freshcommit' },
    }),
  });

  assert.equal(freshPlan.code_freshness.would_block, false);
  assert.deepEqual(freshPlan.code_freshness.stale_overrides, []);
  assert.equal(freshPlan.code_freshness.paths.blocks_engine_php_transformer_path.status, 'ahead');
  assert.equal(freshPlan.warnings.some((warning) => warning.code === 'stale_override'), false);

  const diverged = resolvePathFreshness(
    'blocks_engine_php_transformer_path',
    blocksEngine,
    fakeGitRunner({
      [path.resolve(blocksEngine)]: { branch: 'trunk', upstream: 'origin/trunk', behind: 5, ahead: 3, dirty: true, commit: 'divergedc' },
    }),
  );
  assert.equal(diverged.status, 'diverged');
  assert.equal(diverged.stale, true);
  assert.equal(diverged.dirty, true);
});

test('code freshness marks non-git override paths without blocking', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-freshness-nongit-'));
  const staticSiteImporter = path.join(root, 'static-site-importer');
  const blocksEngine = path.join(root, 'blocks-engine');
  mkdirSync(staticSiteImporter, { recursive: true });
  mkdirSync(path.join(blocksEngine, 'fixtures', 'websites', 'fixture-a'), { recursive: true });

  const freshness = buildCodeFreshness(
    {
      staticSiteImporter,
      blocksEngine,
      blocksEnginePhpTransformerPath: blocksEngine,
    },
    fakeGitRunner({}),
  );

  assert.equal(freshness.would_block, false);
  assert.equal(freshness.paths.blocks_engine_php_transformer_path.in_git_repo, false);
  assert.equal(freshness.paths.blocks_engine_php_transformer_path.status, 'not_git');
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test('fixture matrix dry-run plan surfaces local fallback and dirty workspace warnings', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-warning-plan-'));
  const staticSiteImporter = path.join(root, 'static-site-importer');
  const fixtureRoot = path.join(root, 'fixtures');
  mkdirSync(staticSiteImporter, { recursive: true });
  mkdirSync(path.join(fixtureRoot, 'fixture-a'), { recursive: true });

  const plan = buildFixtureMatrixRunPlan({
    staticSiteImporter,
    fixtureRoot,
    runId: 'proof/run 1',
    allowLocalFallback: true,
    allowDirtyLabWorkspace: true,
    skipInstall: true,
    skipSync: true,
  });

  assert.equal(plan.namespace, 'proof-run-1');
  assert.equal(plan.temp_root, '/tmp/homeboy-rigs-ssi-fixture-matrix-proof-run-1');
  // The single-fixture temp corpus drifts from the canonical pin, so the plan
  // surfaces a non-silent drift warning alongside the routing warnings.
  assert.deepEqual(plan.warnings.map((warning) => warning.code), [
    'local_runner_default',
    'local_fallback_allowed',
    'dirty_lab_workspace_allowed',
    'canonical_fixture_count_drift',
  ]);
  assert.equal(plan.fixture_count_matches_canonical, false);
  assert.match(
    plan.warnings.find((warning) => warning.code === 'canonical_fixture_count_drift').message,
    /CANONICAL_FIXTURE_COUNT is \d+/,
  );
});

test('operator summary preserves matrix rollups for fanout agents', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-operator-summary-'));
  const outputFile = path.join(root, 'homeboy-bench.json');
  writeFileSync(outputFile, JSON.stringify({
    run_id: 'ssi-matrix-rollup-proof',
    result_summary: {
      failed: 71,
      finding_count: 1126,
      groups: { runtime_target_gap: 806 },
      top_pattern_families: [
        { key: 'runtime_target_gap:runtime_dependency_missing_dom_target:canvas', count: 312, fixture_ids: ['shader-site'] },
      ],
      fixture_exemplars: [
        { fixture_id: 'shader-site', selector: 'canvas', reason: 'Runtime target missing.' },
      ],
      diagnostic_blind_spots: [
        { kind: 'missing_source_context', count: 12 },
      ],
    },
  }));

  const summary = summarizeRun({
    mode: 'development-override',
    run_id: 'planned-run',
    fixture_count: 71,
    output_file: outputFile,
  });

  assert.equal(summary.run_id, 'ssi-matrix-rollup-proof');
  assert.equal(summary.top_pattern_families[0].count, 312);
  assert.equal(summary.fixture_exemplars[0].fixture_id, 'shader-site');
  assert.equal(summary.diagnostic_blind_spots[0].kind, 'missing_source_context');
});

test('summarizeBenchRun emits the operator summary on a gate-FAIL instead of throwing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-bench-gate-fail-'));
  const outputFile = path.join(root, 'homeboy-bench.json');
  writeFileSync(outputFile, JSON.stringify({
    run_id: 'ssi-live-2',
    result_summary: {
      succeeded: 0,
      failed: 2,
      finding_count: 22,
      groups: { runtime_target_gap: 18, dropped_images: 4 },
    },
    artifacts: { run: 'homeboy-runs:ssi-live-2', report: 'https://example.test/report.json' },
  }));

  const plan = {
    mode: 'development-override',
    run_id: 'planned-run',
    fixture_count: 2,
    output_file: outputFile,
  };

  // The bench exited non-zero (gate-FAIL) but wrote a valid result payload.
  let result;
  assert.doesNotThrow(() => {
    result = summarizeBenchRun({ plan, benchStatus: 1, benchLabel: 'Run SSI fixture matrix bench' });
  });

  assert.equal(result.gateFailed, true);
  assert.equal(result.summary.status, 'failed');
  assert.equal(result.summary.run_id, 'ssi-live-2');
  assert.equal(result.summary.passed_fixture_count, 0);
  assert.equal(result.summary.failed_fixture_count, 2);
  assert.equal(result.summary.finding_count, 22);
  assert.deepEqual(result.summary.top_buckets[0], { key: 'runtime_target_gap', count: 18 });
  assert.deepEqual(result.summary.artifact_urls, ['homeboy-runs:ssi-live-2', 'https://example.test/report.json']);
});

test('summarizeBenchRun reports a clean pass when the bench exits zero', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-bench-pass-'));
  const outputFile = path.join(root, 'homeboy-bench.json');
  writeFileSync(outputFile, JSON.stringify({
    run_id: 'ssi-pass',
    result_summary: { succeeded: 2, failed: 0, finding_count: 0 },
  }));

  const result = summarizeBenchRun({
    plan: { mode: 'release-proof', run_id: 'planned-run', fixture_count: 2, output_file: outputFile },
    benchStatus: 0,
    benchLabel: 'Run SSI fixture matrix bench',
  });

  assert.equal(result.gateFailed, false);
  assert.equal(result.summary.status, 'passed');
  assert.equal(result.summary.passed_fixture_count, 2);
  assert.equal(result.summary.failed_fixture_count, 0);
});

test('summarizeBenchRun still throws when a non-zero bench produced no parseable result', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-bench-crash-'));
  const missingOutput = path.join(root, 'never-written.json');

  // No output file at all -> genuine crash, keep throwing.
  assert.throws(
    () => summarizeBenchRun({
      plan: { mode: 'development-override', run_id: 'planned-run', output_file: missingOutput },
      benchStatus: 1,
      benchLabel: 'Run SSI fixture matrix bench',
    }),
    /Run SSI fixture matrix bench failed with exit 1/,
  );

  // Output exists but is unparseable / carries no result payload -> still a crash.
  const garbageOutput = path.join(root, 'garbage.json');
  writeFileSync(garbageOutput, 'not json at all');
  assert.throws(
    () => summarizeBenchRun({
      plan: { mode: 'development-override', run_id: 'planned-run', output_file: garbageOutput },
      benchStatus: 1,
      benchLabel: 'Run SSI fixture matrix bench',
    }),
    /failed with exit 1/,
  );
});

test('mapWithConcurrency runs bounded N in parallel and preserves input ordering', async () => {
  const items = Array.from({ length: 10 }, (_value, index) => index);
  let inFlight = 0;
  let peakInFlight = 0;

  const results = await mapWithConcurrency(items, 3, async (value) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    // Yield so the pool genuinely overlaps work rather than resolving instantly.
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value * 2;
  });

  // Up to 3 workers actually overlapped (proves real parallelism), never more.
  assert.equal(peakInFlight, 3);
  // Results stay aligned to input order regardless of completion order.
  assert.deepEqual(results, items.map((value) => value * 2));
});

test('mapWithConcurrency handles empty input and caps the pool at item count', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);

  let peakInFlight = 0;
  let inFlight = 0;
  const results = await mapWithConcurrency([1, 2], 8, async (value) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value;
  });
  assert.deepEqual(results, [1, 2]);
  assert.equal(peakInFlight, 2);
});

test('boundedConcurrency clamps to the hard cap and falls back on invalid input', () => {
  assert.equal(boundedConcurrency('8', 4, 16), 8);
  assert.equal(boundedConcurrency('500', 4, 16), 16);
  assert.equal(boundedConcurrency(undefined, 4, 16), 4);
  assert.equal(boundedConcurrency('0', 4, 16), 4);
  assert.equal(boundedConcurrency('not-a-number', 4, 16), 4);
  assert.equal(boundedConcurrency('-3', 4, 16), 4);
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

test('recipe runs an editor-canvas-probe editor-validation step after each import', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'editor-validation-recipe-test' });
  const recipe = buildFixtureMatrixRecipe({
    matrix,
    artifactsDirectory: '/tmp/artifacts',
    staticSiteImporterPath: '/tmp/static-site-importer',
  });

  // [activate, validate(simple-site), editor-validation(simple-site)]
  assert.equal(recipe.workflow.steps[1].command, 'wordpress.wp-cli');
  assert.match(recipe.workflow.steps[1].args[0], /static-site-importer validate-artifact/);
  const editorStep = recipe.workflow.steps[2];
  assert.equal(editorStep.command, 'wordpress.editor-canvas-probe');
  assert.ok(editorStep.args.some((arg) => arg.startsWith('url=')));
  const selectorGroupsArg = editorStep.args.find((arg) => arg.startsWith('selector-groups-json='));
  const selectorGroups = JSON.parse(selectorGroupsArg.slice('selector-groups-json='.length));
  assert.equal(selectorGroups[0].name, EDITOR_INVALID_BLOCK_SELECTOR_GROUP);
  assert.ok(selectorGroups[0].selectors.includes('.block-editor-warning'));

  const disabled = buildFixtureMatrixRecipe({
    matrix,
    artifactsDirectory: '/tmp/artifacts',
    staticSiteImporterPath: '/tmp/static-site-importer',
    editorValidation: false,
  });
  assert.equal(disabled.workflow.steps.some((step) => step.command === 'wordpress.editor-canvas-probe'), false);
});

test('editorBlockValidationStep composes the existing editor-canvas-probe command', () => {
  const step = editorBlockValidationStep({ fixture: { id: 'shop', editor_url: '/wp-admin/post.php?post=42&action=edit' } });
  assert.equal(step.command, 'wordpress.editor-canvas-probe');
  assert.ok(step.args.includes('url=/wp-admin/post.php?post=42&action=edit'));
});

test('editor-canvas-probe invalid-block warnings become gating editor_block_invalid findings', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'editor-canvas-invalid-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'simple-site',
        status: 'failed',
        diagnostics: collectEditorValidationDiagnostics({
          summary: {
            selectorSummary: {
              groups: [
                {
                  name: 'editor_block_invalid',
                  selector: '.block-editor-warning',
                  count: 2,
                  visible_count: 2,
                  first_match: { text: 'This block contains unexpected or invalid content' },
                },
              ],
            },
          },
        }),
      },
    ],
  });

  const finding = result.findings[0];
  assert.equal(finding.kind, 'editor_block_invalid');
  assert.equal(finding.group_key, 'editor_block_invalid');
  assert.equal(finding.repair_bucket, 'editor_block_invalid');
  assert.equal(finding.candidate_repo, 'blocks-engine');
  assert.equal(finding.loss_class, 'editor_block_invalid');
  assert.equal(finding.loss_acceptance, 'unacceptable');
  assert.equal(finding.selector, '.block-editor-warning');
  assert.equal(result.summary.unacceptable_finding_count, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.succeeded, 0);
  assert.equal(result.fixtures[0].status, 'failed');
});

test('per-block editor validity (isValid=false) becomes an editor_block_invalid finding with block name and selector', () => {
  const diagnostics = collectEditorValidationDiagnostics({
    editor_validation: {
      blocks: [
        { name: 'core/paragraph', clientId: 'abc-1', isValid: true },
        {
          name: 'core/columns',
          clientId: 'abc-2',
          isValid: false,
          issues: ['Block validation failed for "core/columns"'],
        },
      ],
    },
  });

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'editor_block_invalid');
  assert.equal(diagnostics[0].block_name, 'core/columns');
  assert.equal(diagnostics[0].selector, '[data-block="abc-2"]');

  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'editor-block-validity-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [{ fixture_id: 'simple-site', status: 'failed', diagnostics }],
  });
  assert.equal(result.findings[0].observed_block_name, 'core/columns');
  assert.equal(result.findings[0].loss_acceptance, 'unacceptable');
  assert.equal(result.fixtures[0].status, 'failed');
});

test('valid editor blocks produce no editor_block_invalid findings', () => {
  const noWarnings = collectEditorValidationDiagnostics({
    summary: {
      selectorSummary: {
        groups: [{ name: 'editor_block_invalid', selector: '.block-editor-warning', count: 0, visible_count: 0 }],
      },
    },
    editor_validation: {
      blocks: [
        { name: 'core/paragraph', clientId: 'ok-1', isValid: true },
        { name: 'core/heading', clientId: 'ok-2', isValid: true },
      ],
    },
  });
  assert.deepEqual(noWarnings, []);

  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'editor-valid-negative-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [{ fixture_id: 'simple-site', status: 'passed', diagnostics: noWarnings }],
  });
  assert.equal(result.summary.unacceptable_finding_count, 0);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.fixtures[0].status, 'passed');
});

test('editor_block_invalid findings collected from fixture artifacts gate the matrix', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'ssi-editor-validation-artifact-'));
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'editor-validation-artifact-test' });
  const fixtureDirectory = path.join(outputDirectory, 'simple-site');
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(path.join(fixtureDirectory, 'editor-canvas-summary.json'), JSON.stringify({
    schema: 'wp-codebox/editor-canvas-probe/v1',
    summary: {
      selectorSummary: {
        groups: [
          {
            name: 'editor_block_invalid',
            selector: '.block-editor-warning',
            count: 1,
            visible_count: 1,
            first_match: { text: 'This block contains unexpected or invalid content' },
          },
        ],
      },
    },
  }));

  const result = collectFixtureMatrixRunResults({ matrix, outputDirectory });
  const finding = result.findings.find((item) => item.kind === 'editor_block_invalid');
  assert.ok(finding, 'expected an editor_block_invalid finding from the canvas-probe artifact');
  assert.equal(finding.loss_acceptance, 'unacceptable');
  assert.equal(result.fixtures[0].status, 'failed');
});

test('scores editor-quality metrics from generic block composition and rolls them up', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ssi-editor-quality-'));
  const marketing = path.join(root, 'marketing-static');
  const docs = path.join(root, 'docs-blog');
  mkdirSync(marketing, { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(marketing, 'index.html'), '<h1>Landing</h1>');
  writeFileSync(path.join(docs, 'index.html'), '<article>Docs</article>');
  const matrix = createFixtureMatrix({ fixture_root: root, id: 'editor-quality-test' });

  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [
      {
        fixture_id: 'marketing-static',
        status: 'passed',
        // 8 native (core/* + jetpack/* + woocommerce/*), 2 core/html => 0.8 / 0.2.
        block_type_counts: {
          'core/paragraph': 4,
          'core/heading': 2,
          'jetpack/contact-form': 1,
          'woocommerce/product': 1,
          'core/html': 2,
        },
      },
      {
        fixture_id: 'docs-blog',
        status: 'passed',
        // 6 native, 4 core/html => 0.6 / 0.4.
        block_type_counts: {
          'core/paragraph': 6,
          'core/html': 4,
        },
      },
    ],
  });

  const marketingFixture = result.fixtures.find((fixture) => fixture.fixture_id === 'marketing-static');
  assert.equal(marketingFixture.editor_quality.block_total, 10);
  assert.equal(marketingFixture.editor_quality.native_block_count, 8);
  assert.equal(marketingFixture.editor_quality.core_html_block_count, 2);
  assert.equal(marketingFixture.editor_quality.native_conversion_rate, 0.8);
  assert.equal(marketingFixture.editor_quality.core_html_fallback_ratio, 0.2);
  assert.equal(marketingFixture.editor_quality.source, 'block_type_breakdown');
  assert.equal(marketingFixture.editor_quality.editor_invalid_count, 0);

  // Aggregate uses summed totals (14 native / 20 total = 0.7; 6 core/html / 20 = 0.3).
  assert.equal(result.summary.editor_quality.block_total, 20);
  assert.equal(result.summary.editor_quality.native_block_count, 14);
  assert.equal(result.summary.editor_quality.core_html_block_count, 6);
  assert.equal(result.summary.editor_quality.native_conversion_rate, 0.7);
  assert.equal(result.summary.editor_quality.core_html_fallback_ratio, 0.3);
  assert.equal(result.summary.editor_quality.scored_fixture_count, 2);
  assert.equal(result.summary.editor_quality.native_rate_gate.enabled, false);

  // Per-class rollup carries the same generic metric.
  assert.equal(result.summary.quality_budgets['docs/blog'].editor_quality.native_conversion_rate, 0.6);
  assert.equal(result.summary.classes['marketing/static'].editor_quality.native_conversion_rate, 0.8);
});

test('opt-in native-rate gate fails low-native fixtures while editor_invalid_count reuses #537 findings', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'native-rate-gate-test' });
  const makeResult = () => ({
    fixture_id: 'simple-site',
    status: 'passed',
    // 3 native / 7 total ≈ 0.43 native conversion rate.
    block_type_counts: { 'core/paragraph': 3, 'core/html': 4 },
    diagnostics: [
      { kind: 'editor_block_invalid', selector: '.block-editor-warning', message: 'Editor rendered 1 invalid-block warning for the imported post.' },
    ],
  });

  // Gate off (default): metrics are scored, but no native-rate finding is emitted.
  const ungated = normalizeFixtureMatrixResult({ matrix, results: [makeResult()] });
  assert.equal(ungated.fixtures[0].editor_quality.editor_invalid_count, 1);
  assert.ok(ungated.fixtures[0].editor_quality.native_conversion_rate < 0.5);
  assert.equal(ungated.findings.some((finding) => finding.kind === 'native_conversion_rate_below_min'), false);

  // Gate on: the low-native fixture earns an unacceptable finding and fails.
  const gated = normalizeFixtureMatrixResult({ matrix, results: [makeResult()], editorQuality: { minNativeRate: 0.8 } });
  const finding = gated.findings.find((row) => row.kind === 'native_conversion_rate_below_min');
  assert.ok(finding, 'expected a native_conversion_rate_below_min finding when the gate is enabled');
  assert.equal(finding.loss_class, 'low_native_conversion');
  assert.equal(finding.loss_acceptance, 'unacceptable');
  assert.equal(gated.fixtures[0].status, 'failed');
  assert.equal(gated.summary.editor_quality.native_rate_gate.enabled, true);
  assert.equal(gated.summary.editor_quality.native_rate_gate.min_native_rate, 0.8);
});

test('recipe runs a wordpress.visual-compare visual-parity step after each import', () => {
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'visual-parity-recipe-test' });
  const recipe = buildFixtureMatrixRecipe({
    matrix,
    artifactsDirectory: '/tmp/artifacts',
    staticSiteImporterPath: '/tmp/static-site-importer',
    pixelThreshold: 0.05,
  });

  // [activate, validate(simple-site), editor-validation(simple-site), visual-compare(simple-site)]
  const visualStep = recipe.workflow.steps[3];
  assert.equal(visualStep.command, 'wordpress.visual-compare');
  assert.ok(visualStep.args.some((arg) => arg.startsWith('source-url=')));
  assert.ok(visualStep.args.some((arg) => arg.startsWith('candidate-url=')));
  assert.ok(visualStep.args.includes('threshold=0.05'));

  const disabled = buildFixtureMatrixRecipe({
    matrix,
    artifactsDirectory: '/tmp/artifacts',
    staticSiteImporterPath: '/tmp/static-site-importer',
    visualParity: false,
  });
  assert.equal(disabled.workflow.steps.some((step) => step.command === 'wordpress.visual-compare'), false);
});

test('visualParityCompareStep composes the existing wordpress.visual-compare command with per-fixture overrides', () => {
  const step = visualParityCompareStep({
    fixture: { id: 'shop', source_url: 'http://127.0.0.1:4173/shop/index.html', candidate_url: '/?p=42' },
    pixelThreshold: 0.2,
  });
  assert.equal(step.command, 'wordpress.visual-compare');
  assert.ok(step.args.includes('source-url=http://127.0.0.1:4173/shop/index.html'));
  assert.ok(step.args.includes('candidate-url=/?p=42'));
  assert.ok(step.args.includes('threshold=0.2'));
  assert.ok(step.args.includes('source-label=shop-source'));
  assert.ok(step.args.includes('candidate-label=shop-candidate'));
});

test('(a) visual-compare mismatch at/under threshold produces no finding', () => {
  const payload = {
    schema: 'wp-codebox/visual-compare/v1',
    comparison: { mismatchPixels: 1000, totalPixels: 2048000, dimensionMismatch: false },
  };
  // ratio ~0.0005, threshold 0.1 -> captured, no diagnostic.
  assert.deepEqual(collectVisualParityDiagnostics(payload, { threshold: 0.1, gate: true }), []);

  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'visual-parity-under-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [{ fixture_id: 'simple-site', status: 'passed', diagnostics: collectVisualParityDiagnostics(payload, { threshold: 0.1, gate: true }) }],
  });
  assert.equal(result.findings.some((finding) => finding.kind === VISUAL_PARITY_MISMATCH_KIND), false);
  assert.equal(result.fixtures[0].status, 'passed');
});

test('(b) visual-compare mismatch over threshold with gate on becomes a gating unacceptable finding', () => {
  const payload = {
    schema: 'homeboy/VisualParityArtifact/v1',
    summary: { mismatch_pixels: 600000, total_pixels: 2048000, dimension_mismatch: false },
    artifacts: { source_screenshot: 'files/browser/visual-compare/source.png', candidate_screenshot: 'files/browser/visual-compare/candidate.png', diff_screenshot: 'files/browser/visual-compare/diff.png' },
  };
  const diagnostics = collectVisualParityDiagnostics(payload, { threshold: 0.1, gate: true });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, VISUAL_PARITY_MISMATCH_KIND);
  assert.equal(diagnostics[0].gate, true);

  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'visual-parity-gate-on-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [{ fixture_id: 'simple-site', status: 'passed', diagnostics }],
  });
  const finding = result.findings.find((item) => item.kind === VISUAL_PARITY_MISMATCH_KIND);
  assert.ok(finding, 'expected a visual_parity_mismatch finding');
  assert.equal(finding.group_key, 'visual_parity_mismatch');
  assert.equal(finding.repair_bucket, 'visual_parity_mismatch');
  assert.equal(finding.candidate_repo, 'blocks-engine');
  assert.equal(finding.loss_class, 'visual_parity_mismatch');
  assert.equal(finding.loss_acceptance, 'unacceptable');
  assert.equal(result.summary.unacceptable_finding_count, 1);
  assert.equal(result.fixtures[0].status, 'failed');
});

test('(c) visual-compare mismatch over threshold with gate off is captured but non-gating', () => {
  const payload = {
    schema: 'homeboy/VisualParityArtifact/v1',
    summary: { mismatch_pixels: 600000, total_pixels: 2048000, dimension_mismatch: false },
  };
  const diagnostics = collectVisualParityDiagnostics(payload, { threshold: 0.1, gate: false });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].gate, undefined);

  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'visual-parity-gate-off-test' });
  const result = normalizeFixtureMatrixResult({
    matrix,
    results: [{ fixture_id: 'simple-site', status: 'passed', diagnostics }],
  });
  const finding = result.findings.find((item) => item.kind === VISUAL_PARITY_MISMATCH_KIND);
  assert.ok(finding, 'expected a captured visual_parity_mismatch finding');
  assert.equal(finding.loss_acceptance, 'acceptable');
  assert.equal(result.summary.unacceptable_finding_count, 0);
  assert.equal(result.fixtures[0].status, 'passed');
});

test('visual-compare artifacts collected from fixture files gate the matrix when gating is opted in', () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), 'ssi-visual-parity-artifact-'));
  const matrix = createFixtureMatrix({ fixture_root: fixtureRoot, id: 'visual-parity-artifact-test' });
  const fixtureDirectory = path.join(outputDirectory, 'simple-site');
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(path.join(fixtureDirectory, 'visual-diff.json'), JSON.stringify({
    schema: 'wp-codebox/visual-compare/v1',
    comparison: { mismatchPixels: 700000, totalPixels: 2048000, dimensionMismatch: false },
    files: {
      sourceScreenshot: 'files/browser/visual-compare/source.png',
      candidateScreenshot: 'files/browser/visual-compare/candidate.png',
      diffScreenshot: 'files/browser/visual-compare/diff.png',
      visualDiff: 'files/browser/visual-compare/visual-diff.json',
    },
  }));

  const gated = collectFixtureMatrixRunResults({ matrix, outputDirectory, visualParity: { threshold: 0.1, gate: true } });
  const finding = gated.findings.find((item) => item.kind === VISUAL_PARITY_MISMATCH_KIND);
  assert.ok(finding, 'expected a visual_parity_mismatch finding from the visual-compare artifact');
  assert.equal(finding.loss_acceptance, 'unacceptable');
  assert.equal(gated.fixtures[0].status, 'failed');
  // The visual_parity_artifacts slot captures screenshots + diff + metrics.
  assert.equal(gated.fixtures[0].visual_parity_artifacts.schema, 'static-site-importer/visual-parity-artifacts/v1');
  assert.equal(gated.fixtures[0].visual_parity_artifacts.artifacts.diff_screenshot.status, 'captured');
  assert.equal(gated.fixtures[0].visual_parity_artifacts.metrics.mismatch_pixels, 700000);

  // Same artifact, gate off (default) -> captured, non-gating.
  const captured = collectFixtureMatrixRunResults({ matrix, outputDirectory });
  const capturedFinding = captured.findings.find((item) => item.kind === VISUAL_PARITY_MISMATCH_KIND);
  assert.ok(capturedFinding, 'expected the mismatch to still be captured');
  assert.equal(capturedFinding.loss_acceptance, 'acceptable');
  assert.equal(captured.fixtures[0].status, 'passed');
});

test('visual-compare dimension mismatch gates even with zero pixel metrics when gating is on', () => {
  const payload = { comparison: { mismatchPixels: 0, totalPixels: 0, dimensionMismatch: true } };
  const diagnostics = collectVisualParityDiagnostics(payload, { gate: true });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].dimension_mismatch, true);
});
