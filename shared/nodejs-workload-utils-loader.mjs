import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bootstrapCommand = 'homeboy extension setup nodejs';
const envVar = 'HOMEBOY_NODEJS_WORKLOAD_UTILS';
const helperRelativePath = path.join('nodejs', 'scripts', 'bench', 'lib', 'workload-utils.mjs');

function siblingExtensionsPath() {
  // shared/ lives at the homeboy-rigs repo root; the homeboy-extensions
  // checkout is a sibling of that repo root.
  const repoRoot = path.resolve(__dirname, '..');
  return path.join(path.dirname(repoRoot), 'homeboy-extensions', helperRelativePath);
}

function resolveWorkloadUtilsPath() {
  const explicit = process.env[envVar];
  if (explicit) {
    return explicit;
  }

  const sibling = siblingExtensionsPath();
  return existsSync(sibling) ? sibling : '';
}

function workloadUtilsDiagnostic() {
  return [
    'Homeboy Extensions Node workload utilities are unavailable.',
    `Run ${bootstrapCommand}, then export:`,
    `  ${envVar}=/path/to/homeboy-extensions/${helperRelativePath}`,
  ].join('\n');
}

function toImportTarget(target) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return target;
  }
  return pathToFileURL(path.resolve(target)).href;
}

export async function loadNodeWorkloadUtils() {
  const resolved = resolveWorkloadUtilsPath();
  if (!resolved) {
    throw new Error(workloadUtilsDiagnostic());
  }
  return import(toImportTarget(resolved));
}

export {
  bootstrapCommand as nodeWorkloadUtilsBootstrapCommand,
  envVar as nodeWorkloadUtilsEnvVar,
};
