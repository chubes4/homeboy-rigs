#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWpCodeboxRecipe } from '../shared/wp-codebox/recipe.mjs';
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

async function runFixtureMatrix(options) {
  const fixtureRoot = path.resolve(options.fixtureRoot || path.join(packageRoot, 'fixtures'));
  const outputDirectory = path.resolve(options.outputDirectory || path.join(process.cwd(), 'artifacts', 'static-site-importer-fixture-matrix'));
  const staticSiteImporterPath = options.staticSiteImporterPath || process.env.HOMEBOY_STATIC_SITE_IMPORTER_PATH || path.resolve(process.env.HOME || '.', 'Developer/static-site-importer');
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
      }
      batchRuns.push({
        batch: batchNumber,
        fixture_count: fixtures.length,
        recipe_file: batchRecipeFile,
        output_file: outputFile,
        exit_code: batchRuntime?.exitCode ?? 0,
        error: batchError ? batchError.message : '',
      });
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
    };
    writeFixtureMatrixResultArtifacts({ outputDirectory, matrix, result: collectedResult });
  }

  const summary = {
    schema: 'homeboy-rigs/static-site-importer-fixture-matrix-cli-run/v1',
    matrix_id: matrix.id,
    fixture_root: matrix.fixture_root,
    fixture_count: matrix.count,
    output_directory: outputDirectory,
    recipe_file: recipeFile,
    artifact_refs: written.artifact_refs,
    result_file: path.join(outputDirectory, 'static-site-fixture-matrix-result.json'),
    result_summary: collectedResult.summary,
    runtime: runtime ? runtimeSummary(runtime, runtimeError) : null,
  };
  fs.writeFileSync(path.join(outputDirectory, 'cli-run.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, runtimeError, runtime };
}

function runtimeSummary(runtime, runtimeError) {
  return {
    exit_code: runtime.exitCode,
    ...(runtime.batchSize ? { batch_size: runtime.batchSize } : {}),
    ...(runtime.batches ? { batches: runtime.batches } : {}),
    error: runtimeError ? runtimeError.message : '',
  };
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

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function printHelp() {
  process.stdout.write(`Usage: static-site-fixture-matrix [fixture-root] [options]\n\nOptions:\n  --fixture-root <path>              Static-site fixture root. Defaults to this package's fixtures directory.\n  --output-directory <path>          Artifact output directory.\n  --static-site-importer-path <path> Static Site Importer checkout/plugin directory.\n  --static-site-importer-slug <slug> Plugin slug. Defaults to static-site-importer.\n  --static-site-importer-plugin <p>  Plugin activation file. Defaults to static-site-importer/static-site-importer.php.\n  --entrypoint <file>                Fixture entrypoint. Defaults to index.html.\n  --max-depth <n>                    Fixture discovery depth. Defaults to 2.\n  --wordpress-version <version>      WP Codebox WordPress version. Defaults to latest.\n  --batch-size <n>                   Fixtures per WP Codebox run when --run is used. Defaults to 10.\n  --run                             Execute WP Codebox recipes. Omit locally to only materialize artifacts.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
