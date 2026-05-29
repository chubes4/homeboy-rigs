import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const GUTENBERG_PATH = process.env.HOMEBOY_COMPONENT_PATH;
export const SHARED_STATE = process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir();

if (!GUTENBERG_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}

export function setting(key, fallback = '') {
  try {
    const settings = JSON.parse(process.env.HOMEBOY_SETTINGS_JSON || '{}');
    if (settings && settings[key] !== undefined) {
      return String(settings[key]);
    }
  } catch {
    // Ignore malformed settings and use direct env/defaults.
  }

  return process.env[`HOMEBOY_SETTINGS_${key.toUpperCase()}`] || fallback;
}

export function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function artifactDir(name) {
  return path.join(SHARED_STATE, name);
}

export function runId(name) {
  const namespace = setting('gutenberg_rtc_namespace', path.basename(GUTENBERG_PATH));
  return `${namespace}-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function redact(text) {
  return String(text || '')
    .replace(/(Authorization:\s*Basic\s+)[A-Za-z0-9+/=._:-]+/gi, '$1[redacted]')
    .replace(/("password"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/([?&](?:_wpnonce|token|password|key)=)[^&#\s]+/gi, '$1[redacted]');
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: options.cwd || GUTENBERG_PATH,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGKILL');
          reject(
            new Error(
              `${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms; stdout=${redact(stdout).slice(-1200)}; stderr=${redact(stderr).slice(-1200)}`
            )
          );
        }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      const elapsedMs = performance.now() - started;
      const result = { code, stdout, stderr, elapsedMs };
      if (code !== 0 && options.allowFailure !== true) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}; stderr=${redact(stderr).slice(0, 2000)}`));
        return;
      }
      resolve(result);
    });
  });
}

export async function runNpmScript(script, args = [], options = {}) {
  return runCommand('npm', ['run', script, '--', ...args], options);
}

export async function runWpEnvTest(args, options = {}) {
  return runNpmScript('wp-env-test', args, options);
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function writeText(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, redact(data));
}

export function percentile(values, pct) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (pct / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
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
