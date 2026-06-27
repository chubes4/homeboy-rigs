#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWpCodeboxRecipe, wpCodeboxCommand, wpCodeboxBin } from '../../../shared/wp-codebox/recipe.mjs';
import { materializeGeneratedArtifactFixtures } from '../lib/artifact-intake.mjs';
import {
  buildFixtureMatrixRecipe,
  collectFixtureMatrixRunResults,
  createFixtureMatrix,
  normalizeFixtureMatrixResult,
  writeFixtureMatrixArtifacts,
  writeFixtureMatrixResultArtifacts,
} from '../lib/fixture-matrix.mjs';

const DEFAULT_BATCH_SIZE = 10;
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  const options = { ...optionsFromEnv(), ...parseArgs(process.argv.slice(2)) };
  if (options.help) {
    printHelp();
    return;
  }

  const { summary, runtimeError, runtime } = await runFixtureMatrix(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (runtimeError) {
    process.exitCode = runtime.exitCode || 1;
  }
}

export default async function runFixtureMatrixBench() {
  const options = { ...optionsFromEnv(), ...parseArgs(process.argv.slice(2)) };
  const { summary, runtimeError } = await runFixtureMatrix(options);
  if (runtimeError) {
    attachChildCommandFailures(runtimeError, summary.runtime?.child_command_failures || []);
    throw runtimeError;
  }

  const resultSummary = summary.result_summary || {};
  return {
    metrics: {
      fixture_count: Number(summary.fixture_count || 0),
      passed_fixture_count: Number(resultSummary.succeeded || 0),
      failed_fixture_count: Number(resultSummary.failed || 0),
      not_run_fixture_count: Number(resultSummary.not_run || 0),
      finding_count: Number(resultSummary.finding_count || 0),
    },
    artifacts: {
      cli_run: { path: path.join(summary.output_directory, 'cli-run.json') },
      matrix: { path: path.join(summary.output_directory, 'matrix.json') },
      result: { path: summary.result_file },
      summary: { path: path.join(summary.output_directory, 'summary.json') },
      finding_packets: { path: path.join(summary.output_directory, 'finding-packets.json') },
    },
    metadata: {
      matrix_id: summary.matrix_id,
      fixture_root: summary.fixture_root,
      output_directory: summary.output_directory,
      result_summary: summary.result_summary,
      runtime: summary.runtime,
    },
  };
}

export async function runFixtureMatrix(options) {
  const outputDirectory = path.resolve(options.outputDirectory || path.join(process.cwd(), 'artifacts', 'static-site-importer-fixture-matrix'));
  const intake = options.artifactRoot
    ? materializeGeneratedArtifactFixtures({
      artifactRoot: path.resolve(options.artifactRoot),
      fixtureRoot: path.resolve(options.fixtureRoot || path.join(outputDirectory, 'intake-fixtures')),
      entrypoint: options.entrypoint || 'index.html',
      maxDepth: options.maxDepth,
    })
    : null;
  const fixtureRoot = path.resolve(intake?.fixture_root || options.fixtureRoot || path.join(packageRoot, 'fixtures'));
  const staticSiteImporterPath = options.staticSiteImporterPath || process.env.HOMEBOY_STATIC_SITE_IMPORTER_PATH || process.cwd();
  const dependencyOverrides = prepareDependencyOverrides(options);
  ensureComposerDependencies(staticSiteImporterPath, { dependencyOverrides });
  const matrix = createFixtureMatrix({
    id: options.id || `static-site-importer-fixture-matrix-${Date.now()}`,
    fixture_root: fixtureRoot,
    entrypoint: options.entrypoint || 'index.html',
    maxDepth: options.maxDepth,
  });
  const written = writeFixtureMatrixArtifacts({ outputDirectory, matrix });
  const recipe = buildFixtureMatrixRecipe({
    matrix,
    artifactsDirectory: outputDirectory,
    playgroundArtifactsDirectory: options.playgroundArtifactsDirectory || '/wordpress/wp-content/uploads/static-site-importer-fixture-matrix',
    wordpressVersion: options.wordpressVersion,
    staticSiteImporterPath,
    staticSiteImporterPlugin: options.staticSiteImporterPlugin,
    staticSiteImporterSlug: options.staticSiteImporterSlug,
  });
  const recipeFile = path.join(outputDirectory, 'wp-codebox-static-site-fixture-matrix-recipe.json');
  fs.writeFileSync(recipeFile, `${JSON.stringify(recipe, null, 2)}\n`);

  let runtime = null;
  let runtimeError = null;
  let collectedResult = written.result;
  if (options.run) {
    const batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
    const batchRuns = [];
    const batchResults = [];
    const childCommandFailures = [];
    for (const [batchIndex, fixtures] of chunk(matrix.fixtures, batchSize).entries()) {
      const batchNumber = batchIndex + 1;
      const batchSuffix = String(batchNumber).padStart(3, '0');
      const batchMatrix = createFixtureMatrix({
        id: `${matrix.id}-batch-${batchSuffix}`,
        fixture_root: matrix.fixture_root,
        entrypoint: matrix.entrypoint,
        fixtures,
      });
      const batchRecipe = buildFixtureMatrixRecipe({
        matrix: batchMatrix,
        artifactsDirectory: outputDirectory,
        playgroundArtifactsDirectory: options.playgroundArtifactsDirectory || '/wordpress/wp-content/uploads/static-site-importer-fixture-matrix',
        wordpressVersion: options.wordpressVersion,
        staticSiteImporterPath,
        staticSiteImporterPlugin: options.staticSiteImporterPlugin,
        staticSiteImporterSlug: options.staticSiteImporterSlug,
      });
      const batchRecipeFile = path.join(outputDirectory, `wp-codebox-static-site-fixture-matrix-batch-${batchSuffix}.json`);
      const outputFile = path.join(outputDirectory, `wp-codebox-output-batch-${batchSuffix}.json`);
      const artifactRefs = batchArtifactRefs({ outputDirectory, batchSuffix, batchRecipeFile, outputFile });
      fs.writeFileSync(batchRecipeFile, `${JSON.stringify(batchRecipe, null, 2)}\n`);

      let batchRuntime = null;
      let batchError = null;
      try {
        batchRuntime = await runWpCodeboxRecipe({
          recipeFile: batchRecipeFile,
          artifactsDir: outputDirectory,
          outputFile,
          wpCodeboxBin: options.wpCodeboxBin,
        });
      } catch (error) {
        batchError = error;
        batchRuntime = {
          exitCode: error?.code ?? 1,
          outputFile,
          json: parseJsonText(error?.stdout),
        };
        runtimeError ||= error;
        childCommandFailures.push(buildWpCodeboxChildCommandFailure({
          error,
          batchNumber,
          batchSuffix,
          batchRecipeFile,
          outputFile,
          artifactsDir: outputDirectory,
          wpCodeboxBin: options.wpCodeboxBin,
          artifactRefs,
        }));
      }
      batchRuns.push(fixtureMatrixBatchRunSummary({
        batchNumber,
        batchMatrix,
        fixtures,
        batchRecipeFile,
        outputFile,
        batchRuntime,
        batchError,
      }));
      batchResults.push(collectFixtureMatrixRunResults({
        matrix: batchMatrix,
        outputDirectory,
        outputFile,
        codeboxOutput: batchRuntime?.json,
        codeboxError: batchError,
      }));
    }
    collectedResult = normalizeFixtureMatrixResult({
      matrix,
      results: batchResults.flatMap((result) => result.fixtures),
    });
    runtime = {
      exitCode: runtimeError ? (batchRuns.find((batch) => batch.exit_code)?.exit_code || 1) : 0,
      batchSize,
      batches: batchRuns,
      childCommandFailures,
    };
    writeFixtureMatrixResultArtifacts({ outputDirectory, matrix, result: collectedResult });
  }

  const summary = {
    schema: 'homeboy-rigs/static-site-importer-fixture-matrix-cli-run/v1',
    matrix_id: matrix.id,
    fixture_root: matrix.fixture_root,
    fixture_count: matrix.count,
    intake,
    dependency_overrides: dependencyOverrides,
    output_directory: outputDirectory,
    recipe_file: recipeFile,
    artifact_refs: written.artifact_refs,
    ...(runtime?.childCommandFailures?.length ? { child_command_failures: runtime.childCommandFailures } : {}),
    result_file: path.join(outputDirectory, 'static-site-fixture-matrix-result.json'),
    result_summary: collectedResult.summary,
    runtime: runtime ? runtimeSummary(runtime, runtimeError) : null,
  };
  fs.writeFileSync(path.join(outputDirectory, 'cli-run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, runtimeError, runtime };
}

function ensureComposerDependencies(pluginPath, options = {}) {
  const dependencyOverrides = options.dependencyOverrides || {};
  const blocksEnginePhpTransformerPath = dependencyOverrides.blocks_engine_php_transformer?.path || '';
  if (blocksEnginePhpTransformerPath) {
    updateComposerPathRepository(pluginPath, blocksEnginePhpTransformerPath);
    return;
  }

  if (fs.existsSync(path.join(pluginPath, 'vendor', 'autoload.php')) || !fs.existsSync(path.join(pluginPath, 'composer.json'))) {
    return;
  }

  const result = spawnSync('composer', ['install', '--no-interaction', '--prefer-dist', '--no-progress'], {
    cwd: pluginPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`Composer dependency install failed for ${pluginPath}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
}

function prepareDependencyOverrides(options) {
  const blocksEnginePhpTransformerPath = resolveBlocksEnginePhpTransformerPath(options.blocksEnginePhpTransformerPath);
  return {
    ...(blocksEnginePhpTransformerPath
      ? {
        blocks_engine_php_transformer: {
          package: 'automattic/blocks-engine-php-transformer',
          path: blocksEnginePhpTransformerPath,
        },
      }
      : {}),
  };
}

export function resolveBlocksEnginePhpTransformerPath(input) {
  if (!input) {
    return '';
  }

  const candidate = path.resolve(input);
  const packageComposer = path.join(candidate, 'composer.json');
  if (composerPackageName(packageComposer) === 'automattic/blocks-engine-php-transformer') {
    return candidate;
  }

  const nested = path.join(candidate, 'php-transformer');
  if (composerPackageName(path.join(nested, 'composer.json')) === 'automattic/blocks-engine-php-transformer') {
    return nested;
  }

  throw new Error(`Blocks Engine PHP transformer path must point to the package or Blocks Engine repo root: ${input}`);
}

function composerPackageName(composerFile) {
  try {
    const composer = JSON.parse(fs.readFileSync(composerFile, 'utf8'));
    return typeof composer.name === 'string' ? composer.name : '';
  } catch {
    return '';
  }
}

function updateComposerPathRepository(pluginPath, packagePath) {
  const composerFile = path.join(pluginPath, 'composer.json');
  const lockFile = path.join(pluginPath, 'composer.lock');
  const composerJson = fs.readFileSync(composerFile, 'utf8');
  const composerLock = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null;
  let result = null;
  try {
    configureComposerPathRepository(pluginPath, packagePath);
    result = spawnSync('composer', ['update', 'automattic/blocks-engine-php-transformer', '--with-dependencies', '--no-interaction', '--prefer-source', '--no-progress'], {
      cwd: pluginPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.writeFileSync(composerFile, composerJson);
    if (composerLock !== null) {
      fs.writeFileSync(lockFile, composerLock);
    }
  }
  if (result.status !== 0) {
    throw new Error(`Composer dependency override failed for ${pluginPath}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
}

function configureComposerPathRepository(pluginPath, packagePath) {
  const composerFile = path.join(pluginPath, 'composer.json');
  const composer = JSON.parse(fs.readFileSync(composerFile, 'utf8'));
  composer.repositories = composer.repositories && typeof composer.repositories === 'object' && !Array.isArray(composer.repositories)
    ? composer.repositories
    : {};
  composer.repositories['blocks-engine-php-transformer-dev'] = composerPathRepositoryConfig(composer, packagePath);
  fs.writeFileSync(composerFile, `${JSON.stringify(composer, null, 2)}\n`);
}

export function composerPathRepositoryConfig(rootComposer, packagePath) {
  return {
    type: 'path',
    url: packagePath,
    canonical: true,
    options: {
      symlink: false,
      versions: {
        'automattic/blocks-engine-php-transformer': composerPathRepositoryVersion(rootComposer),
      },
    },
  };
}

export function fixtureMatrixBatchRunSummary(input = {}) {
  const batchError = input.batchError || null;
  const batchRuntime = input.batchRuntime || null;
  const fixtureIds = normalizeFixtureIds(input.fixtures);
  return {
    batch: input.batchNumber,
    batch_id: input.batchMatrix?.id || '',
    fixture_ids: fixtureIds,
    fixture_count: fixtureIds.length,
    recipe_file: input.batchRecipeFile || '',
    output_file: input.outputFile || '',
    exit_code: batchRuntime?.exitCode ?? 0,
    error: batchError ? batchError.message : '',
    stderr_tail: batchError ? textTail(batchError.stderr) : '',
    stdout_tail: batchError ? textTail(batchError.stdout) : '',
    parsed_output: Boolean(batchRuntime?.json),
  };
}

function normalizeFixtureIds(fixtures) {
  return Array.isArray(fixtures) ? fixtures.map((fixture) => fixture.id).filter(Boolean) : [];
}

function composerPathRepositoryVersion(rootComposer) {
  const constraint = rootComposer?.require?.['automattic/blocks-engine-php-transformer'];
  if (typeof constraint !== 'string') {
    return '0.1.15';
  }

  const trimmed = constraint.trim();
  const match = trimmed.match(/^\^?(\d+\.\d+\.\d+)$/);
  return match ? match[1] : '0.1.15';
}

function runtimeSummary(runtime, runtimeError) {
  return {
    exit_code: runtime.exitCode,
    ...(runtime.batchSize ? { batch_size: runtime.batchSize } : {}),
    ...(runtime.batches ? { batches: runtime.batches } : {}),
    ...(runtime.childCommandFailures?.length ? { child_command_failures: runtime.childCommandFailures } : {}),
    error: runtimeError ? runtimeError.message : '',
  };
}

function attachChildCommandFailures(error, childCommandFailures) {
  if (!childCommandFailures.length) {
    return;
  }
  error.child_command_failures = childCommandFailures;
}

function buildWpCodeboxChildCommandFailure({ error, batchNumber, batchSuffix, batchRecipeFile, outputFile, artifactsDir, wpCodeboxBin: bin, artifactRefs }) {
  const command = wpCodeboxRecipeRunCommand({ recipeFile: batchRecipeFile, artifactsDir, outputFile, wpCodeboxBin: bin });
  return {
    schema: 'homeboy/child-command-failure/v1',
    kind: 'child_command_failed',
    label: `WP Codebox recipe-run batch ${batchSuffix}`,
    batch: batchNumber,
    batch_id: `batch-${batchSuffix}`,
    command,
    exit_status: exitStatus(error),
    stdout_tail: tailText(error?.stdout),
    stderr_tail: tailText(error?.stderr),
    artifact_refs: artifactRefs,
    message: error?.message || 'WP Codebox recipe-run failed',
  };
}

function wpCodeboxRecipeRunCommand({ recipeFile, artifactsDir, outputFile, wpCodeboxBin: bin }) {
  const base = wpCodeboxCommand(bin || wpCodeboxBin());
  const argv = [
    base.command,
    ...(base.args || []),
    'recipe-run',
    recipeFile,
    '--artifacts-dir', artifactsDir,
    '--output', outputFile,
  ];
  return { argv };
}

function batchArtifactRefs({ outputDirectory, batchSuffix, batchRecipeFile, outputFile }) {
  return {
    artifacts_directory: outputDirectory,
    recipe_file: batchRecipeFile,
    output_file: outputFile,
    cli_run: path.join(outputDirectory, 'cli-run.json'),
    matrix: path.join(outputDirectory, 'matrix.json'),
    result: path.join(outputDirectory, 'static-site-fixture-matrix-result.json'),
    summary: path.join(outputDirectory, 'summary.json'),
    finding_packets: path.join(outputDirectory, 'finding-packets.json'),
    batch_recipe: path.join(outputDirectory, `wp-codebox-static-site-fixture-matrix-batch-${batchSuffix}.json`),
    batch_output: path.join(outputDirectory, `wp-codebox-output-batch-${batchSuffix}.json`),
  };
}

function exitStatus(error) {
  const status = error?.status ?? error?.exitCode ?? error?.code;
  return Number.isInteger(status) ? status : 1;
}

function tailText(value, maxLines = 40) {
  if (!value) {
    return '';
  }
  return String(value).split(/\r?\n/).slice(-maxLines).join('\n');
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--run') {
      options.run = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const [rawKey, rawValue] = arg.slice(2).split('=');
      const key = camelCase(rawKey);
      const value = rawValue === undefined ? args[index + 1] : rawValue;
      if (rawValue === undefined) {
        index += 1;
      }
      options[key] = value;
      continue;
    }
    if (!options.fixtureRoot) {
      options.fixtureRoot = arg;
    }
  }
  return options;
}

function optionsFromEnv(env = process.env) {
  const benchEnv = settingsBenchEnv(env);
  return {
    fixtureRoot: benchEnv.SSI_FIXTURE_MATRIX_FIXTURE_ROOT || env.SSI_FIXTURE_MATRIX_FIXTURE_ROOT,
    outputDirectory: benchEnv.SSI_FIXTURE_MATRIX_OUTPUT_DIRECTORY || env.SSI_FIXTURE_MATRIX_OUTPUT_DIRECTORY || env.HOMEBOY_BENCH_ARTIFACTS_DIR,
    staticSiteImporterPath: benchEnv.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PATH || env.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PATH,
    staticSiteImporterSlug: benchEnv.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_SLUG || env.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_SLUG,
    staticSiteImporterPlugin: benchEnv.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PLUGIN || env.SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PLUGIN,
    entrypoint: benchEnv.SSI_FIXTURE_MATRIX_ENTRYPOINT || env.SSI_FIXTURE_MATRIX_ENTRYPOINT,
    maxDepth: benchEnv.SSI_FIXTURE_MATRIX_MAX_DEPTH || env.SSI_FIXTURE_MATRIX_MAX_DEPTH,
    artifactRoot: benchEnv.SSI_FIXTURE_MATRIX_ARTIFACT_ROOT || env.SSI_FIXTURE_MATRIX_ARTIFACT_ROOT,
    blocksEnginePhpTransformerPath: benchEnv.SSI_FIXTURE_MATRIX_BLOCKS_ENGINE_PHP_TRANSFORMER_PATH || env.SSI_FIXTURE_MATRIX_BLOCKS_ENGINE_PHP_TRANSFORMER_PATH,
    wordpressVersion: benchEnv.SSI_FIXTURE_MATRIX_WORDPRESS_VERSION || env.SSI_FIXTURE_MATRIX_WORDPRESS_VERSION,
    batchSize: benchEnv.SSI_FIXTURE_MATRIX_BATCH_SIZE || env.SSI_FIXTURE_MATRIX_BATCH_SIZE,
    run: isTruthy(benchEnv.SSI_FIXTURE_MATRIX_RUN) || isTruthy(env.SSI_FIXTURE_MATRIX_RUN),
    wpCodeboxBin: benchEnv.SSI_FIXTURE_MATRIX_WP_CODEBOX_BIN || env.SSI_FIXTURE_MATRIX_WP_CODEBOX_BIN,
  };
}

function settingsBenchEnv(env = process.env) {
  try {
    const settings = JSON.parse(env.HOMEBOY_SETTINGS_JSON || '{}');
    return settings && typeof settings.bench_env === 'object' && !Array.isArray(settings.bench_env)
      ? settings.bench_env
      : {};
  } catch {
    return {};
  }
}

function isTruthy(value) {
  return value === true || value === '1' || value === 'true';
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseJsonText(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function textTail(value, maxLength = 4000) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function printHelp() {
  process.stdout.write(`Usage: static-site-fixture-matrix [fixture-root] [options]\n\nOptions:\n  --fixture-root <path>              Static-site fixture root. Defaults to this package's fixtures directory.\n  --output-directory <path>          Artifact output directory.\n  --static-site-importer-path <path> Static Site Importer checkout/plugin directory.\n  --static-site-importer-slug <slug> Plugin slug. Defaults to static-site-importer.\n  --static-site-importer-plugin <p>  Plugin activation file. Defaults to static-site-importer/static-site-importer.php.\n  --artifact-root <path>             Generated artifact root to normalize into fixtures.\n  --blocks-engine-php-transformer-path <path>\n                                     Blocks Engine repo root or php-transformer package path for Composer.\n  --entrypoint <file>                Fixture entrypoint. Defaults to index.html.\n  --max-depth <n>                    Fixture discovery depth. Defaults to 2.\n  --wordpress-version <version>      WP Codebox WordPress version. Defaults to latest.\n  --batch-size <n>                   Fixtures per WP Codebox run when --run is used. Defaults to 10.\n  --run                             Execute WP Codebox recipes. Omit locally to only materialize artifacts.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
