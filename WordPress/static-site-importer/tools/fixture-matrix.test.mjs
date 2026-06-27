import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import runFixtureMatrixBench, {
  composerPathRepositoryConfig,
  fixtureMatrixBatchRunSummary,
  resolveBlocksEnginePhpTransformerPath,
  runFixtureMatrix,
} from '../bench/static-site-fixture-matrix.bench.mjs';
import {
  buildCodeFreshness,
  buildFixtureMatrixRunPlan,
  CANONICAL_FIXTURE_COUNT,
  resolvePathFreshness,
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
  collectFixtureMatrixRunResults,
  createFixtureMatrix,
  normalizeFixtureMatrixResult,
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
            source_path: 'website/index.html',
            selector: '#hero canvas',
            message: 'Runtime island preserved for editor-safe import.',
          },
          {
            kind: 'html_canvas_runtime_fallback',
            loss_class: 'preserved_runtime_island',
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
  assert.deepEqual(plan.warnings.map((warning) => warning.code), [
    'local_runner_default',
    'local_fallback_allowed',
    'dirty_lab_workspace_allowed',
  ]);
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
