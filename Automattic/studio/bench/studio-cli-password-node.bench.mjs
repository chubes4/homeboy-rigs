import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  STUDIO_PATH,
  artifactDir as studioArtifactDir,
  createStudioSite,
  metric,
  redact,
  safeResult,
  setting,
  variant,
} from './lib/studio-bench.mjs';

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: options.cwd || STUDIO_PATH,
      env: { ...process.env, ...(options.env || {}) },
    });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const elapsedMs = Date.now() - started;
      if (code !== 0 && options.allowFailure !== true) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}; stderr=${stderr.slice(-1500)}`));
        return;
      }
      resolve({ code, stdout, stderr, elapsedMs });
    });
  });
}

async function prepareGeneratePasswordPackage(artifactDir) {
  const packageDir = setting('generate_password_package_dir');
  const packageTgz = setting('generate_password_package_tgz');

  if (!packageDir && !packageTgz) {
    return { package_source: 'installed', steps: [] };
  }

  const steps = [];
  let tgzPath = packageTgz;

  if (packageDir) {
    const pack = await runCommand('npm', ['pack', packageDir, '--pack-destination', artifactDir], {
      cwd: artifactDir,
    });
    steps.push({ name: 'npm_pack_generate_password', ...safeResult(pack) });
    const tarball = pack.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    tgzPath = path.join(artifactDir, tarball);
  }

  const install = await runCommand(
    'npm',
    ['install', '--package-lock=false', '--no-save', tgzPath],
    { cwd: STUDIO_PATH }
  );
  steps.push({ name: 'npm_install_generate_password', ...safeResult(install) });

  const buildCli = await runCommand('npm', ['run', 'build'], {
    cwd: path.join(STUDIO_PATH, 'apps/cli'),
  });
  steps.push({ name: 'build_studio_cli', ...safeResult(buildCli) });

  return { package_source: tgzPath, steps };
}

export default async function studioCliPasswordNodeBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-cli-password-node-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const artifactDir = studioArtifactDir('studio-cli-password-node-artifacts');
  const sitesDir = path.join(artifactDir, 'sites');
  await mkdir(sitesDir, { recursive: true });

  const sitePath = path.join(sitesDir, runId);
  const resultFile = path.join(artifactDir, `result-${runId}.json`);

  const started = Date.now();
  const packagePreparation = await prepareGeneratePasswordPackage(artifactDir);
  const createResult = await createStudioSite(sitePath, {
    name: `Studio Bench ${currentVariant} Password Node ${process.pid}`,
    start: false,
    allowFailure: true,
    timeoutMs: 240000,
  });
  const totalElapsedMs = Date.now() - started;

  const result = {
    variant: currentVariant,
    site_path: sitePath,
    package_preparation: packagePreparation,
    command: safeResult(createResult),
    timings: {
      site_create_no_start_ms: createResult.elapsedMs,
      total_elapsed_ms: totalElapsedMs,
    },
    passed: createResult.code === 0,
  };
  await writeFile(resultFile, JSON.stringify(result, null, 2));

  if (createResult.code !== 0) {
    throw new Error(
      `studio site create failed after generate-password preparation; stderr=${redact(
        createResult.stderr
      ).slice(-1500)}`
    );
  }

  return {
    metrics: {
      success_rate: 1,
      site_create_no_start_ms: metric(createResult.elapsedMs),
      total_elapsed_ms: totalElapsedMs,
    },
    artifacts: {
      raw_result: resultFile,
      site_path: sitePath,
      generate_password_package_source: packagePreparation.package_source,
    },
  };
}
