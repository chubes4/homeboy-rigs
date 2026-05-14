import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const RESULT_PREFIX = 'EVAL_RUNNER_RESULT_FILE=';

export const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
export const SHARED_STATE = process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir();

if (!STUDIO_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}

export function setting(key) {
  try {
    const settings = JSON.parse(process.env.HOMEBOY_SETTINGS_JSON || '{}');
    if (settings && typeof settings[key] === 'string') {
      return settings[key];
    }
  } catch {
    // Ignore malformed settings and fall back to direct env/debug defaults.
  }

  return process.env[`HOMEBOY_SETTINGS_${key.toUpperCase()}`] || '';
}

export function variant() {
  return setting('studio_bench_variant') || path.basename(STUDIO_PATH);
}

export function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function expandHome(value) {
  if (!value) {
    return value;
  }
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function redact(text) {
  return String(text || '')
    .replace(/("adminPassword"\s*:\s*")[^"]+(")/g, '$1[redacted]$2')
    .replace(/(--admin-password\s+)\S+/g, '$1[redacted]')
    .replace(/(autoLoginUrl"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|password|key|nonce)=)[^&#\s]+/gi, '$1[redacted]');
}

export async function sanitizeArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string') {
    return;
  }
  await writeFile(artifact.path, redact(await readFile(artifact.path, 'utf8')));
}

export function safeResult(result) {
  if (!result) {
    return result;
  }
  return {
    code: result.code,
    elapsedMs: result.elapsedMs,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

export function artifactDir(name, sharedState = SHARED_STATE) {
  return path.join(sharedState, name);
}

export function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || STUDIO_PATH,
      env: { ...process.env, ...(options.env || {}) },
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
              `${args.join(' ')} timed out after ${options.timeoutMs}ms; stdout=${stdout.slice(-1000)}; stderr=${stderr.slice(-1000)}`
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
      const elapsedMs = Date.now() - started;
      if (code !== 0 && options.allowFailure !== true) {
        reject(new Error(`${args.join(' ')} exited ${code}; stderr=${stderr.slice(0, 1500)}`));
        return;
      }
      resolve({ code, stdout, stderr, elapsedMs });
    });
  });
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
