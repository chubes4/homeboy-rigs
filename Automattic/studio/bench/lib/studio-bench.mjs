import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadNodeWorkloadUtils } from '../../../../shared/nodejs-workload-utils-loader.mjs';

const {
  artifactDir: nodeArtifactDir,
  expandHome,
  metric,
  redactText,
  runNode,
  safeResult: nodeSafeResult,
  sanitizeArtifactFile,
  setting,
} = await loadNodeWorkloadUtils();

const RESULT_PREFIX = 'EVAL_RUNNER_RESULT_FILE=';

export const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
export const SHARED_STATE = process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir();

if (!STUDIO_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}

export { expandHome, metric, setting };

export function artifactDir(name, sharedState = SHARED_STATE) {
  return nodeArtifactDir(name, { sharedState });
}

export function variant() {
  return setting('studio_bench_variant') || path.basename(STUDIO_PATH);
}

export function redact(text) {
  return redactText(String(text || ''), { replacement: '[redacted]' });
}

export function safeResult(result) {
  return nodeSafeResult(result, { redaction: { replacement: '[redacted]' } });
}

export async function sanitizeArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string') {
    return;
  }
  await sanitizeArtifactFile(artifact.path, { profile: 'web', replacement: '[redacted]' });
}

export function run(args, options = {}) {
  return runNode(args, { cwd: STUDIO_PATH, ...options });
}

export async function runCli(args, options = {}) {
  const cliPath = path.join(STUDIO_PATH, 'apps/cli/dist/cli/main.mjs');
  return run([cliPath, ...args], options);
}

export async function createStudioSite(sitePath, options = {}) {
  const name = options.name || `Studio Bench ${variant()} ${options.nameSuffix || 'Site'} ${process.pid}`;
  return runCli(
    [
      'site',
      'create',
      '--name',
      name,
      '--path',
      sitePath,
      ...(options.wp ? ['--wp', options.wp] : []),
      ...(options.php ? ['--php', options.php] : []),
      ...(options.start === false ? ['--no-start'] : []),
      '--skip-browser',
      '--skip-log-details',
    ],
    options
  );
}

export async function stopStudioSite(sitePath, options = {}) {
  return runCli(['site', 'stop', '--path', sitePath], { allowFailure: true, ...options });
}

export async function startStudioSite(sitePath, options = {}) {
  return runCli(['site', 'start', '--path', sitePath, '--skip-browser'], options);
}

export async function studioSiteStatus(sitePath, options = {}) {
  return runCli(['site', 'status', '--path', sitePath, '--format', 'json'], options);
}

export function parseStudioSiteStatus(stdout) {
  const jsonStart = String(stdout || '').indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`site status did not emit JSON: ${redact(stdout).slice(0, 1000)}`);
  }
  return JSON.parse(String(stdout).slice(jsonStart));
}

export async function studioSiteStatusJson(sitePath, options = {}) {
  const { stdout } = await studioSiteStatus(sitePath, options);
  return parseStudioSiteStatus(stdout);
}

export async function runEval(prompt, vars, options = {}) {
  const evalRunner = path.join(STUDIO_PATH, 'apps/cli/dist/cli/eval-runner.mjs');
  const { code, stdout, stderr } = await run(
    [evalRunner, prompt, 'unused-provider-slot', JSON.stringify({ vars: { prompt, ...vars } })],
    {
      allowFailure: true,
      ...options,
      env: {
        CLAUDECODE: '',
        ...(options.env || {}),
      },
    }
  );

  const marker = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(RESULT_PREFIX));

  if (!marker) {
    throw new Error(`eval runner did not emit result marker; exit=${code}; stderr=${stderr.slice(0, 1500)}`);
  }

  const resultFile = marker.slice(RESULT_PREFIX.length);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  return { result, resultFile, exitCode: code, stderr };
}
