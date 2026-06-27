#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RIG_ID = 'static-site-importer-fixture-matrix';
export const CANONICAL_FIXTURE_COUNT = 71;

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const plan = buildFixtureMatrixRunPlan(options);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  fs.mkdirSync(path.dirname(plan.output_file), { recursive: true });

  for (const step of plan.steps) {
    runCommand(step);
  }

  const summary = summarizeRun(plan);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export function buildFixtureMatrixRunPlan(input) {
  const options = normalizeOptions(input);
  const settings = {
    SSI_FIXTURE_MATRIX_FIXTURE_ROOT: options.fixtureRoot,
    SSI_FIXTURE_MATRIX_STATIC_SITE_IMPORTER_PATH: options.staticSiteImporter,
    SSI_FIXTURE_MATRIX_RUN: '1',
    ...(options.blocksEnginePhpTransformerPath
      ? { SSI_FIXTURE_MATRIX_BLOCKS_ENGINE_PHP_TRANSFORMER_PATH: options.blocksEnginePhpTransformerPath }
      : {}),
    ...(options.batchSize ? { SSI_FIXTURE_MATRIX_BATCH_SIZE: String(options.batchSize) } : {}),
    ...(options.wordpressVersion ? { SSI_FIXTURE_MATRIX_WORDPRESS_VERSION: options.wordpressVersion } : {}),
    ...(options.wpCodeboxBin ? { SSI_FIXTURE_MATRIX_WP_CODEBOX_BIN: options.wpCodeboxBin } : {}),
  };
  const fixtureCount = countTopLevelFixtureDirectories(options.fixtureRoot);
  const warnings = buildWarnings(options);

  return {
    schema: 'homeboy-rigs/static-site-importer-fixture-matrix-operator-run/v1',
    mode: options.mode,
    rig: RIG_ID,
    runner: options.runner,
    run_id: options.runId,
    static_site_importer: options.staticSiteImporter,
    blocks_engine: options.blocksEngine,
    homeboy_bin: options.homeboyBin,
    fixture_root: options.fixtureRoot,
    fixture_count: fixtureCount,
    canonical_fixture_count: CANONICAL_FIXTURE_COUNT,
    fixture_count_matches_canonical: fixtureCount === CANONICAL_FIXTURE_COUNT,
    output_file: options.output,
    temp_root: options.tempRoot,
    artifact_root: options.artifactRoot,
    shared_state: options.sharedState,
    namespace: options.namespace,
    warnings,
    dependency_overrides: options.blocksEnginePhpTransformerPath
      ? { blocks_engine_php_transformer: { path: options.blocksEnginePhpTransformerPath } }
      : {},
    steps: buildSteps(options, settings),
  };
}

function normalizeOptions(input) {
  if (!input.staticSiteImporter) {
    throw new Error('--static-site-importer is required');
  }

  const blocksEngine = input.blocksEngine ? path.resolve(input.blocksEngine) : '';
  if (!input.fixtureRoot && !blocksEngine) {
    throw new Error('--blocks-engine or --fixture-root is required');
  }
  const fixtureRoot = path.resolve(input.fixtureRoot || path.join(blocksEngine, 'fixtures', 'websites'));

  const defaultBlocksEnginePhpTransformerPath = input.mode === 'release-proof' ? '' : blocksEngine;
  const blocksEnginePhpTransformerPath = input.blocksEnginePhpTransformerPath === undefined
    ? defaultBlocksEnginePhpTransformerPath
    : (input.blocksEnginePhpTransformerPath ? path.resolve(input.blocksEnginePhpTransformerPath) : '');
  const mode = input.mode || (blocksEnginePhpTransformerPath ? 'development-override' : 'release-proof');
  const runId = input.runId || `ssi-matrix-${mode}-${timestamp()}`;
  const namespace = sanitizePathSegment(input.namespace || runId);
  const tempRoot = input.tempRoot ? path.resolve(input.tempRoot) : defaultTempRoot(namespace, input);
  const output = path.resolve(input.output || path.join(process.cwd(), 'artifacts', `${runId}.homeboy-bench.json`));

  return {
    ...input,
    mode,
    runId,
    namespace,
    tempRoot,
    output,
    fixtureRoot,
    blocksEngine,
    blocksEnginePhpTransformerPath,
    passthrough: Array.isArray(input.passthrough) ? input.passthrough : [],
    staticSiteImporter: path.resolve(input.staticSiteImporter),
    sharedState: input.sharedState ? path.resolve(input.sharedState) : path.join(tempRoot, 'shared-state'),
    artifactRoot: input.artifactRoot ? path.resolve(input.artifactRoot) : path.join(tempRoot, 'artifacts'),
    runner: input.runner || '',
    homeboyBin: input.homeboyBin || process.env.HOMEBOY_BIN || 'homeboy',
  };
}

function defaultTempRoot(namespace) {
  return path.resolve(path.join('/tmp', `homeboy-rigs-ssi-fixture-matrix-${namespace}`));
}

function buildWarnings(options) {
  return [
    ...(!options.runner && !options.labOnly ? [{
      code: 'local_runner_default',
      message: 'No --runner/--lab-only routing was provided; the plan will use the local Homeboy runner.',
    }] : []),
    ...(options.allowLocalFallback ? [{
      code: 'local_fallback_allowed',
      message: '--allow-local-fallback permits Lab routing to fall back to local execution if the runner allows it.',
    }] : []),
    ...(options.allowDirtyLabWorkspace ? [{
      code: 'dirty_lab_workspace_allowed',
      message: '--allow-dirty-lab-workspace permits reusing or overwriting a dirty Lab workspace.',
    }] : []),
  ];
}

function buildSteps(options, settings) {
  const steps = [];
  if (!options.skipInstall) {
    steps.push({
      label: 'Refresh installed SSI fixture matrix rig',
      command: options.homeboyBin,
      args: withCommonRouting(['rig', 'install', packageRoot, '--id', RIG_ID, '--reinstall'], options),
    });
  }
  if (!options.skipSync) {
    steps.push({
      label: 'Sync/materialize rig components',
      command: options.homeboyBin,
      args: withCommonRouting(['rig', 'sync', RIG_ID], options),
    });
  }

  const benchArgs = [
    'bench',
    '--rig', RIG_ID,
    '--profile', 'fixture-matrix',
    '--iterations', '1',
    '--path', options.staticSiteImporter,
    '--shared-state', options.sharedState,
    '--run-id', options.runId,
    '--output', options.output,
    '--json',
    '--setting', `static_site_importer_fixture_matrix_namespace=${options.namespace}`,
    ...Object.entries(settings).flatMap(([key, value]) => ['--setting', `bench_env.${key}=${value}`]),
  ];
  if (options.artifactRoot) {
    benchArgs.push('--artifact-root', options.artifactRoot);
  }
  const routedBenchArgs = withCommonRouting(benchArgs, options);
  if (options.passthrough.length > 0) {
    routedBenchArgs.push('--', ...options.passthrough);
  }
  steps.push({
    label: 'Run SSI fixture matrix bench through Homeboy/Lab/WP Codebox',
    command: options.homeboyBin,
    args: routedBenchArgs,
  });

  return steps;
}

function withCommonRouting(args, options) {
  const routed = [...args];
  if (options.runner) {
    routed.push('--runner', options.runner);
  }
  if (options.labOnly) {
    routed.push('--lab-only');
  }
  if (options.allowLocalFallback) {
    routed.push('--allow-local-fallback');
  }
  if (options.detachAfterHandoff) {
    routed.push('--detach-after-handoff');
  }
  if (options.allowDirtyLabWorkspace) {
    routed.push('--allow-dirty-lab-workspace');
  }
  return routed;
}

function runCommand(step) {
  process.stderr.write(`\n# ${step.label}\n${shellCommand(step)}\n`);
  const result = spawnSync(step.command, step.args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${step.label} failed with exit ${result.status}`);
  }
}

export function summarizeRun(plan) {
  const output = readJson(plan.output_file);
  const resultSummary = findFirstKey(output, 'result_summary') || {};
  const artifacts = findFirstKey(output, 'artifacts') || findFirstKey(output, 'artifact_refs') || {};
  return {
    schema: 'homeboy-rigs/static-site-importer-fixture-matrix-operator-summary/v1',
    mode: plan.mode,
    run_id: findFirstKey(output, 'run_id') || plan.run_id,
    fixture_count: Number(findFirstKey(output, 'fixture_count') || plan.fixture_count || 0),
    passed_fixture_count: Number(resultSummary.succeeded || resultSummary.passed || 0),
    failed_fixture_count: Number(resultSummary.failed || 0),
    finding_count: Number(resultSummary.finding_count || 0),
    top_buckets: topObjectCounts(resultSummary.buckets || resultSummary.groups || {}),
    top_kinds: topObjectCounts(resultSummary.kinds || {}),
    top_pattern_families: normalizeSummaryRows(resultSummary.top_pattern_families),
    fixture_exemplars: normalizeSummaryRows(resultSummary.fixture_exemplars),
    diagnostic_blind_spots: normalizeSummaryRows(resultSummary.diagnostic_blind_spots),
    artifact_urls: collectArtifactUrls(artifacts),
    output_file: plan.output_file,
  };
}

function parseArgs(args) {
  const options = { passthrough: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      options.passthrough = args.slice(index + 1);
      break;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('--no-')) {
      options[camelCase(arg.slice(5))] = false;
      continue;
    }
    if (arg.startsWith('--')) {
      const [rawKey, rawValue] = arg.slice(2).split('=');
      const key = camelCase(rawKey);
      const booleanKeys = new Set(['dryRun', 'skipInstall', 'skipSync', 'labOnly', 'allowLocalFallback', 'detachAfterHandoff', 'allowDirtyLabWorkspace']);
      if (booleanKeys.has(key)) {
        options[key] = true;
        continue;
      }
      const value = rawValue === undefined ? args[index + 1] : rawValue;
      if (rawValue === undefined) {
        index += 1;
      }
      options[key] = value;
      continue;
    }
  }
  return options;
}

function countTopLevelFixtureDirectories(fixtureRoot) {
  try {
    return fs.readdirSync(fixtureRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .length;
  } catch {
    return 0;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findFirstKey(value, key) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findFirstKey(child, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function topObjectCounts(value, limit = 10) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value)
    .map(([key, count]) => ({ key, count: Number(count) }))
    .filter((row) => Number.isFinite(row.count))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function normalizeSummaryRows(value, limit = 10) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function collectArtifactUrls(value) {
  const urls = [];
  collectUrls(value, urls);
  return urls;
}

function collectUrls(value, urls) {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const child of Object.values(value)) {
    if (typeof child === 'string' && /^(https:\/\/|gh:|homeboy-runs:|artifact:|run:)/.test(child)) {
      urls.push(child);
    } else {
      collectUrls(child, urls);
    }
  }
}

function shellCommand(step) {
  return [step.command, ...step.args].map(shellQuote).join(' ');
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}

function sanitizePathSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'run';
}

function printHelp() {
  process.stdout.write(`Usage: node WordPress/static-site-importer/tools/run-fixture-matrix.mjs --runner <id> --static-site-importer <path> --blocks-engine <path> [options] [-- <bench args>...]\n\nRuns the canonical Static Site Importer fixture matrix through Homeboy/Lab/WP Codebox.\n\nOptions:\n  --static-site-importer <path>       Static Site Importer checkout/plugin path. Required.\n  --blocks-engine <path>              Blocks Engine checkout. Defaults fixture root and PHP transformer override.\n  --fixture-root <path>               Fixture corpus. Defaults to <blocks-engine>/fixtures/websites.\n  --blocks-engine-php-transformer-path <path>\n                                      Override transformer package/repo path. Defaults to --blocks-engine.\n  --runner <id>                       Homeboy Lab runner, for example homeboy-lab.\n  --mode <development-override|release-proof>\n                                      Labels output; default is development-override when transformer override is used.\n  --run-id <id>                       Stable proof label. Defaults to ssi-matrix-<mode>-<timestamp>.\n  --shared-state <dir>                Shared Homeboy bench state directory.\n  --artifact-root <dir>               Homeboy artifact root.\n  --output <file>                     Structured Homeboy bench output file.\n  --batch-size <n>                    SSI fixture matrix WP Codebox batch size.\n  --wordpress-version <version>       WP Codebox WordPress version.\n  --wp-codebox-bin <path>             WP Codebox CLI path.\n  --lab-only                          Require Lab routing.\n  --allow-local-fallback              Allow selected Lab runner local fallback.\n  --allow-dirty-lab-workspace         Allow runner workspace overwrite.\n  --detach-after-handoff              Return after remote runner accepts the job.\n  --skip-install                      Skip homeboy rig install --reinstall.\n  --skip-sync                         Skip homeboy rig sync.\n  --dry-run                           Print the composed plan without running it.\n\nAny args after -- are passed through to the lower-level bench runner.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
