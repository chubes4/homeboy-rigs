import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bootstrapCommand = 'homeboy extension setup nodejs';
const envVar = 'HOMEBOY_NODEJS_WORKLOAD_UTILS';
const helperRelativePath = path.join('nodejs', 'scripts', 'bench', 'lib', 'workload-utils.mjs');

function resolveWorkloadUtilsPath() {
  return process.env[envVar] || '';
}

function workloadUtilsDiagnostic() {
  return [
    'Homeboy Extensions Node workload utilities are unavailable.',
    `Run ${bootstrapCommand}, then inject the helper path explicitly:`,
    `  ${envVar}=/path/to/homeboy-extensions/${helperRelativePath}`,
    'This loader does not discover local sibling checkouts.',
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
