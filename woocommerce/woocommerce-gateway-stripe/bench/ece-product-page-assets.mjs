import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ECE_SOURCE_FILES = [
  'client/entrypoints/express-checkout/index.js',
  'client/entrypoints/express-checkout/styles.scss',
];

export const ECE_BUILD_FILES = [
  'build/express-checkout.js',
  'build/express-checkout.css',
  'build/express-checkout.asset.php',
];

const DEFAULT_BASE_REFS = ['origin/develop', 'develop', 'origin/trunk', 'origin/main', 'main'];
const MTIME_TOLERANCE_MS = 1000;

async function fileDetails(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const details = await stat(absolutePath);

  return {
    path: relativePath,
    size: details.size,
    mtimeMs: details.mtimeMs,
  };
}

async function git(root, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: root });
  return stdout.trim();
}

async function gitRefExists(root, ref) {
  try {
    await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function detectGitBaseRef(root, requestedBaseRef) {
  if (requestedBaseRef) {
    return (await gitRefExists(root, requestedBaseRef)) ? requestedBaseRef : null;
  }

  for (const ref of DEFAULT_BASE_REFS) {
    if (await gitRefExists(root, ref)) {
      return ref;
    }
  }

  return null;
}

async function changedFilesSinceBase(root, baseRef, paths) {
  if (!baseRef) {
    return [];
  }

  const output = await git(root, ['diff', '--name-only', `${baseRef}...HEAD`, '--', ...paths]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function formatPaths(paths) {
  return paths.map((entry) => `- ${entry}`).join('\n');
}

export async function validateStripeEceAssetProvenance(componentPath, options = {}) {
  const skipped = ['0', 'false', 'off', 'skip'].includes(String(options.mode || '').toLowerCase());
  if (skipped) {
    return {
      status: 'skipped',
      reason: 'HOMEBOY_WC_STRIPE_ECE_ASSET_CHECK disabled asset provenance validation.',
    };
  }

  const [sources, builds] = await Promise.all([
    Promise.all(ECE_SOURCE_FILES.map((file) => fileDetails(componentPath, file))),
    Promise.all(
      ECE_BUILD_FILES.map(async (file) => {
        try {
          return await fileDetails(componentPath, file);
        } catch {
          return { path: file, missing: true };
        }
      })
    ),
  ]);

  const missingBuilds = builds.filter((file) => file.missing).map((file) => file.path);
  if (missingBuilds.length > 0) {
    throw new Error(
      `Stripe ECE rig refuses to measure raw or unbuilt frontend assets. Missing build artifact(s):\n${formatPaths(missingBuilds)}\nRun the Stripe plugin webpack/Sass build or mount a packaged plugin before tracing.`
    );
  }

  const emptyBuilds = builds.filter((file) => file.size <= 0).map((file) => file.path);
  if (emptyBuilds.length > 0) {
    throw new Error(`Stripe ECE build artifact(s) are empty:\n${formatPaths(emptyBuilds)}`);
  }

  const assetPhp = await readFile(path.join(componentPath, 'build/express-checkout.asset.php'), 'utf8');
  if (!/'version'\s*=>\s*['"][^'"]+['"]/.test(assetPhp)) {
    throw new Error('Stripe ECE build artifact build/express-checkout.asset.php does not declare a non-empty asset version.');
  }

  const newestSource = sources.reduce((latest, file) => (file.mtimeMs > latest.mtimeMs ? file : latest), sources[0]);
  const staleBuilds = builds
    .filter((file) => file.mtimeMs + MTIME_TOLERANCE_MS < newestSource.mtimeMs)
    .map((file) => file.path);

  if (staleBuilds.length > 0) {
    throw new Error(
      `Stripe ECE build artifact(s) are older than ${newestSource.path}; rebuild frontend assets before tracing candidate performance:\n${formatPaths(staleBuilds)}`
    );
  }

  const baseRef = await detectGitBaseRef(componentPath, options.baseRef || '');
  const changedSourceFiles = await changedFilesSinceBase(componentPath, baseRef, ECE_SOURCE_FILES);

  return {
    status: 'pass',
    base_ref: baseRef,
    changed_source_files: changedSourceFiles,
    newest_source: newestSource.path,
    source_files: sources,
    build_files: builds,
  };
}
