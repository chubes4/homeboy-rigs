import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function wpCodeboxBin(env = process.env) {
  const explicit = env.HOMEBOY_WP_CODEBOX_BIN || env.HOMEBOY_SETTINGS_WP_CODEBOX_BIN;
  if (explicit) {
    return explicit;
  }

  const checkoutBin = path.join(env.HOME || '', 'Developer/wp-codebox/packages/cli/dist/index.js');
  return existsSync(checkoutBin) ? checkoutBin : 'wp-codebox';
}

export function wpCodeboxCommand(bin = wpCodeboxBin()) {
  if (/\.(?:js|cjs|mjs)$/.test(bin)) {
    return { command: 'node', args: [bin] };
  }

  return { command: bin, args: [] };
}

export async function runWpCodeboxRecipe({
  recipeFile,
  artifactsDir,
  outputFile,
  recipeRunArgs = [],
  event,
  maxBuffer = 1024 * 1024 * 50,
}) {
  const { command, args } = wpCodeboxCommand();
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

  event?.('wp_codebox', 'recipe.start', { recipe_file: recipeFile, artifacts_dir: artifactsDir });

  try {
    const result = await execFileAsync(command, commandArgs, { maxBuffer });
    await writeFile(outputFile, result.stdout);
    event?.('wp_codebox', 'recipe.done', { output_file: outputFile, artifacts_dir: artifactsDir });
    return result;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout) {
      await writeFile(outputFile, error.stdout);
    }

    event?.('wp_codebox', 'recipe.failed', {
      output_file: outputFile,
      artifacts_dir: artifactsDir,
      exit_code: error?.code ?? null,
    });
    throw error;
  }
}
