import path from 'node:path';

export const GUTENBERG_PATH = process.env.HOMEBOY_COMPONENT_PATH;

if (!GUTENBERG_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}

const workloadUtilsPath = process.env.HOMEBOY_NODEJS_WORKLOAD_UTILS;

if (!workloadUtilsPath) {
  throw new Error('HOMEBOY_NODEJS_WORKLOAD_UTILS is required');
}

const workloadUtils = await import(workloadUtilsPath);

export const artifactDir = workloadUtils.artifactDir;
export const metric = workloadUtils.metric;
export const percentile = workloadUtils.percentile;
export const runCommand = workloadUtils.runCommand;
export const setting = workloadUtils.setting;
export const writeJson = workloadUtils.writeJson;
export const writeText = workloadUtils.writeText;

export const redact = workloadUtils.redactText;

export function runId(name) {
  return workloadUtils.runId(name, { namespaceSetting: 'gutenberg_rtc_namespace' });
}

export async function runNpmScript(script, args = [], options = {}) {
  return runCommand('npm', ['run', script, '--', ...args], options);
}

export async function runWpEnvTest(args, options = {}) {
  return runNpmScript('wp-env-test', args, options);
}

export async function runPlaywrightSpecSuite({ id, specs, timeoutMs = 900000 }) {
  const idForRun = runId(id);
  const outDir = path.join(artifactDir('gutenberg-rtc-playwright'), idForRun);
  await mkdir(outDir, { recursive: true });

  const args = [
    '--project=chromium',
    ...specs.map((spec) => `test/e2e/specs/editor/collaboration/${spec}`),
  ];
  const result = await runNpmScript('test:e2e', args, {
    allowFailure: true,
    timeoutMs,
    env: {
      PLAYWRIGHT_HTML_REPORT: path.join(outDir, 'html-report'),
      PLAYWRIGHT_BLOB_OUTPUT_DIR: path.join(outDir, 'blob-report'),
    },
  });

  const stdoutFile = path.join(outDir, 'stdout.txt');
  const stderrFile = path.join(outDir, 'stderr.txt');
  const resultFile = path.join(outDir, 'result.json');
  await writeText(stdoutFile, result.stdout);
  await writeText(stderrFile, result.stderr);
  await writeJson(resultFile, {
    id,
    specs,
    command: `npm run test:e2e -- ${args.join(' ')}`,
    exit_code: result.code,
    elapsed_ms: result.elapsedMs,
  });

  if (result.code !== 0) {
    throw new Error(`${id} failed; raw_result=${resultFile}; stderr=${redact(result.stderr).slice(0, 1200)}`);
  }

  return {
    metrics: {
      success_rate: 1,
      spec_count: specs.length,
      elapsed_ms: metric(result.elapsedMs),
      exit_code: result.code,
    },
    artifacts: {
      raw_result: resultFile,
      stdout: stdoutFile,
      stderr: stderrFile,
    },
    metadata: {
      specs,
      command: `npm run test:e2e -- ${args.join(' ')}`,
    },
  };
}
