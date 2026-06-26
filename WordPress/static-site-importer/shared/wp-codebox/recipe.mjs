import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 50;

export function wpCodeboxBin(env = process.env) {
  return env.HOMEBOY_WP_CODEBOX_BIN
    || env.HOMEBOY_SETTINGS_WP_CODEBOX_BIN
    || env.WP_CODEBOX_BIN
    || 'wp-codebox';
}

export function wpCodeboxCommand(bin = wpCodeboxBin()) {
  if (/\.(?:js|cjs|mjs)$/.test(bin)) {
    return { command: process.execPath, args: [bin] };
  }

  return { command: bin, args: [] };
}

export async function runWpCodeboxRecipe({
  recipeFile,
  artifactsDir,
  outputFile,
  recipeRunArgs = [],
  maxBuffer = DEFAULT_MAX_BUFFER,
  wpCodeboxBin: explicitWpCodeboxBin,
  env = process.env,
  cwd,
} = {}) {
  if (!recipeFile) {
    throw new Error('runWpCodeboxRecipe requires recipeFile.');
  }
  if (!artifactsDir) {
    throw new Error('runWpCodeboxRecipe requires artifactsDir.');
  }

  await fs.mkdir(artifactsDir, { recursive: true });
  if (outputFile) {
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
  }

  const { command, args } = wpCodeboxCommand(explicitWpCodeboxBin || wpCodeboxBin(env));
  const commandArgs = [
    ...args,
    'recipe-run',
    '--recipe',
    recipeFile,
    '--artifacts',
    artifactsDir,
    ...recipeRunArgs,
    '--json',
  ];

  try {
    const result = await execFileAsync(command, commandArgs, { cwd, env, maxBuffer });
    if (outputFile) {
      await fs.writeFile(outputFile, result.stdout);
    }
    return { ...result, json: parseWpCodeboxJson(result.stdout) };
  } catch (error) {
    if (outputFile && typeof error?.stdout === 'string' && error.stdout) {
      await fs.writeFile(outputFile, error.stdout);
    }
    throw error;
  }
}

function parseWpCodeboxJson(stdout) {
  const trimmed = String(stdout || '').trim();
  return trimmed ? JSON.parse(trimmed) : null;
}
