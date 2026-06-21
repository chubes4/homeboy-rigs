#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const root = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : process.cwd();
const ignoredDirectories = new Set(['.git', '.claude', '.datamachine', '.opencode', 'node_modules', 'vendor']);
const phpFiles = [];
const rigFiles = [];
const jsonFiles = [];
const fuzzWorkloadFiles = [];
const portableSourceFiles = [];
const failures = [];
const studioModelRigGenerator = join(root, 'scripts/generate-studio-agent-model-rigs.mjs');
const personalPathPrefix = '/Users/' + 'chubes/';
const tsrmlsPatchMarker = 'PHP-WASM-COMBINED-FIXES ' + 'TSRMLS fallback';

if (!existsSync(root)) {
  console.error(`Lint root does not exist: ${root}`);
  process.exit(1);
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        walk(join(directory, entry.name));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.php')) {
      phpFiles.push(join(directory, entry.name));
    }

    if (entry.isFile() && entry.name === 'rig.json') {
      rigFiles.push(join(directory, entry.name));
    }

    if (entry.isFile() && entry.name.endsWith('.json')) {
      jsonFiles.push(join(directory, entry.name));

      if (directory.split('/').includes('fuzz')) {
        fuzzWorkloadFiles.push(join(directory, entry.name));
      }
    }

    if (entry.isFile() && /\.(json|mjs|js)$/.test(entry.name)) {
      portableSourceFiles.push(join(directory, entry.name));
    }
  }
}

function lintRigPortability(file, fuzzWorkloadsByPackageRoot) {
  const rel = relative(root, file);
  const contents = readFileSync(file, 'utf8');
  let rig;

  try {
    rig = JSON.parse(contents);
  } catch (error) {
    failures.push(`${rel}: invalid JSON: ${error.message}`);
    return;
  }

  const pipelineCommands = Object.values(rig.pipeline || {})
    .flatMap((steps) => Array.isArray(steps) ? steps : [])
    .map((step) => step.command || '')
    .join('\n');

  if (rel.startsWith('WordPress/gutenberg/rigs/') && /\$HOME\/Developer\/gutenberg|~\/Developer\/gutenberg/.test(pipelineCommands)) {
    failures.push(`${rel}: Gutenberg rig checks must reference ${'${components.gutenberg.path}'} instead of a hard-coded personal checkout path`);
  }

  if (rel === 'chubes4/isolated-block-editor/rigs/isolated-block-editor/rig.json' && contents.includes('/var/lib/datamachine')) {
    failures.push(`${rel}: isolated-block-editor must use the component path or shared node_modules setting instead of /var/lib/datamachine`);
  }

  if (/WP Codebox CLI/.test(pipelineCommands) && /command -v wp-codebox|Developer\/wp-codebox|HOMEBOY_WP_CODEBOX_BIN/.test(pipelineCommands)) {
    failures.push(`${rel}: use shared/wp-codebox/check-cli.sh instead of duplicating WP Codebox CLI discovery in rig commands`);
  }

  lintFuzzWorkloads(rel, file, rig, fuzzWorkloadsByPackageRoot);
  lintBenchProfiles(rel, file, rig, fuzzWorkloadsByPackageRoot);
}

function packageRootForRig(file) {
  const rel = relative(root, file);
  const rigsIndex = rel.indexOf('/rigs/');

  if (rigsIndex === -1) {
    return dirname(file);
  }

  return join(root, rel.slice(0, rigsIndex));
}

function packageRootForFuzzWorkload(file) {
  const rel = relative(root, file);
  const fuzzIndex = rel.indexOf('/fuzz/');

  if (fuzzIndex === -1) {
    return null;
  }

  return join(root, rel.slice(0, fuzzIndex));
}

function workloadIdFromPath(path) {
  return basename(path)
    .replace(/\.workload\.json$/, '')
    .replace(/\.bench\.mjs$/, '')
    .replace(/\.php$/, '')
    .replace(/\.mjs$/, '')
    .replace(/\.js$/, '')
    .replace(/\.json$/, '');
}

function resolvePackagePath(path, packageRoot) {
  if (typeof path !== 'string' || !path) {
    return null;
  }

  const expandedPath = path.replaceAll('${package.root}', packageRoot);
  if (expandedPath.includes('${')) {
    return null;
  }

  return isAbsolute(expandedPath) ? expandedPath : resolve(packageRoot, expandedPath);
}

function collectFuzzWorkloads() {
  const fuzzWorkloadsByPackageRoot = new Map();

  for (const file of jsonFiles) {
    const packageRoot = packageRootForFuzzWorkload(file);
    if (!packageRoot) {
      continue;
    }

    let workload;
    try {
      workload = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }

    if (workload.schema !== 'homeboy/fuzz-workload/v1') {
      continue;
    }

    const workloadIds = new Set([workloadIdFromPath(file)]);
    if (typeof workload.id === 'string' && workload.id) {
      workloadIds.add(workload.id);
    }

    if (!fuzzWorkloadsByPackageRoot.has(packageRoot)) {
      fuzzWorkloadsByPackageRoot.set(packageRoot, new Map());
    }

    const packageWorkloads = fuzzWorkloadsByPackageRoot.get(packageRoot);
    for (const workloadId of workloadIds) {
      packageWorkloads.set(workloadId, { file, workload });
    }
  }

  return fuzzWorkloadsByPackageRoot;
}

function validateFuzzWorkloadShape(rel, workload, context, packageRoot) {
  if (workload.schema !== 'homeboy/fuzz-workload/v1') {
    failures.push(`${rel}: ${context} must use schema homeboy/fuzz-workload/v1`);
  }

  for (const field of ['id', 'label', 'safety_class']) {
    if (typeof workload[field] !== 'string' || workload[field].trim() === '') {
      failures.push(`${rel}: ${context} must declare a non-empty string ${field}`);
    }
  }

  if (!workload.metadata || typeof workload.metadata !== 'object' || Array.isArray(workload.metadata)) {
    failures.push(`${rel}: ${context} must declare metadata`);
  }

  if (!workload.target || typeof workload.target !== 'object' || Array.isArray(workload.target)) {
    failures.push(`${rel}: ${context} must declare target`);
  }

  if (!workload.workload || typeof workload.workload !== 'object' || Array.isArray(workload.workload)) {
    failures.push(`${rel}: ${context} must declare workload`);
  } else if (typeof workload.workload.path !== 'string' || workload.workload.path.trim() === '') {
    failures.push(`${rel}: ${context} workload must declare a non-empty string path`);
  } else {
    const workloadPath = resolvePackagePath(workload.workload.path, packageRoot);
    if (!workloadPath) {
      failures.push(`${rel}: ${context} workload path must be resolvable`);
    } else if (!existsSync(workloadPath)) {
      failures.push(`${rel}: ${context} workload path ${relative(root, workloadPath)} does not exist`);
    }
  }

  if (!Array.isArray(workload.cases) || workload.cases.length === 0) {
    failures.push(`${rel}: ${context} must declare at least one case`);
  }
}

function fuzzWorkloadId(workload, path) {
  return typeof workload.id === 'string' && workload.id ? workload.id : workloadIdFromPath(path);
}

function lintFuzzWorkloads(rel, file, rig, fuzzWorkloadsByPackageRoot) {
  if (!rig.fuzz_workloads) {
    return;
  }

  const packageRoot = packageRootForRig(file);
  const packageWorkloads = fuzzWorkloadsByPackageRoot.get(packageRoot) || new Map();
  const rigWorkloadIds = new Map();

  for (const [runner, workloads] of Object.entries(rig.fuzz_workloads)) {
    if (!Array.isArray(workloads)) {
      failures.push(`${rel}: fuzz_workloads ${runner} must be an array of workload declarations`);
      continue;
    }

    for (const declaration of workloads) {
      const declarationPath = typeof declaration === 'string' ? declaration : declaration?.path;
      const resolvedPath = resolvePackagePath(declarationPath, packageRoot);
      if (!resolvedPath) {
        failures.push(`${rel}: fuzz_workloads ${runner} declaration must use a resolvable path`);
        continue;
      }

      const declarationRel = relative(root, resolvedPath);
      if (!existsSync(resolvedPath)) {
        failures.push(`${rel}: fuzz_workloads ${runner} declares missing file ${declarationRel}`);
        continue;
      }

      let workload;
      try {
        workload = JSON.parse(readFileSync(resolvedPath, 'utf8'));
      } catch (error) {
        failures.push(`${rel}: fuzz_workloads ${runner} declares invalid JSON file ${declarationRel}: ${error.message}`);
        continue;
      }

      validateFuzzWorkloadShape(rel, workload, `fuzz workload ${declarationRel}`, packageRoot);

      const workloadId = fuzzWorkloadId(workload, resolvedPath);
      const packageWorkload = packageWorkloads.get(workloadId);
      if (!packageWorkload || packageWorkload.file !== resolvedPath) {
        failures.push(`${rel}: fuzz_workloads ${runner} declares ${declarationRel}, but fuzz workload id ${workloadId} is not unique within this package`);
      }

      if (rigWorkloadIds.has(workloadId)) {
        failures.push(`${rel}: fuzz workload id ${workloadId} is declared more than once in this rig`);
      } else {
        rigWorkloadIds.set(workloadId, declarationRel);
      }
    }
  }
}

function lintBenchProfiles(rel, file, rig, fuzzWorkloadsByPackageRoot) {
  if (!rig.bench_profiles && !rig.bench_workloads) {
    return;
  }

  const fuzzWorkloadIds = new Set((fuzzWorkloadsByPackageRoot.get(packageRootForRig(file)) || new Map()).keys());
  const workloadIds = new Set();
  for (const workloads of Object.values(rig.bench_workloads || {})) {
    if (!Array.isArray(workloads)) {
      continue;
    }

    for (const workload of workloads) {
      const path = typeof workload === 'string' ? workload : workload?.path;
      if (path) {
        const workloadId = workloadIdFromPath(path);
        workloadIds.add(workloadId);

        if (fuzzWorkloadIds.has(workloadId)) {
          failures.push(`${rel}: bench_workloads declares ${workloadId}, but that id belongs to a fuzz workload in this package`);
        }
      }
    }
  }

  if (!rig.bench_profiles) {
    return;
  }

  for (const [profile, workloadRefs] of Object.entries(rig.bench_profiles)) {
    if (!Array.isArray(workloadRefs)) {
      failures.push(`${rel}: bench profile ${profile} must be an array of workload ids`);
      continue;
    }

    for (const workloadRef of workloadRefs) {
      if (fuzzWorkloadIds.has(workloadRef)) {
        failures.push(`${rel}: bench profile ${profile} references ${workloadRef}, but that id belongs to a fuzz workload in this package`);
      }

      if (!workloadIds.has(workloadRef)) {
        failures.push(`${rel}: bench profile ${profile} references ${workloadRef}, but bench_workloads does not declare a matching workload file`);
      }
    }
  }
}

function lintPortableSource(file) {
  const rel = relative(root, file);
  const contents = readFileSync(file, 'utf8');

  if (contents.includes(personalPathPrefix)) {
    failures.push(`${rel}: use $HOME, homedir(), component paths, or settings instead of hard-coded /Users/chubes paths`);
  }

  if (contents.includes(tsrmlsPatchMarker)) {
    failures.push(`${rel}: TSRMLS fallback defines are owned by WordPress/wordpress-playground#3512; do not patch Playground source in rigs`);
  }
}

function lintFuzzWorkload(file) {
  const rel = relative(root, file);
  let workload;

  try {
    workload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`${rel}: invalid JSON: ${error.message}`);
    return;
  }

  if (workload.schema !== 'homeboy/fuzz-workload/v1') {
    failures.push(`${rel}: fuzz workload schema must be homeboy/fuzz-workload/v1`);
  }

  for (const field of ['id', 'label', 'safety_class']) {
    if (typeof workload[field] !== 'string' || workload[field].length === 0) {
      failures.push(`${rel}: fuzz workload must define non-empty string field ${field}`);
    }
  }

  for (const field of ['surface_ids', 'operations', 'cases']) {
    if (!Array.isArray(workload[field]) || workload[field].length === 0) {
      failures.push(`${rel}: fuzz workload must define non-empty array field ${field}`);
    }
  }

  if (!workload.target || typeof workload.target.type !== 'string') {
    failures.push(`${rel}: fuzz workload must define target.type`);
  }

  if (!workload.metadata || typeof workload.metadata.kind !== 'string') {
    failures.push(`${rel}: fuzz workload must define metadata.kind`);
  }

  if (workload.limits) {
    if (!Number.isInteger(workload.limits.max_cases) || workload.limits.max_cases < 1) {
      failures.push(`${rel}: limits.max_cases must be a positive integer`);
    }

    if (!Number.isInteger(workload.limits.max_duration_seconds) || workload.limits.max_duration_seconds < 1) {
      failures.push(`${rel}: limits.max_duration_seconds must be a positive integer`);
    }
  }
}

function lintPhp(file) {
  const result = spawnSync('php', ['-l', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    failures.push(`${relative(root, file)}: PHP syntax check failed${output ? `: ${output}` : ''}`);
  }
}

function hasPhp() {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function reportFailures() {
  if (failures.length === 0) {
    return;
  }

  console.error('Rig package lint failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function lintGeneratedStudioModelRigs() {
  if (!existsSync(studioModelRigGenerator)) {
    return;
  }

  const result = spawnSync('node', [studioModelRigGenerator, '--check'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    failures.push(`Studio agent model rig generation check failed${output ? `: ${output}` : ''}`);
  }
}

walk(root);

const fuzzWorkloadsByPackageRoot = collectFuzzWorkloads();

rigFiles.forEach((file) => lintRigPortability(file, fuzzWorkloadsByPackageRoot));
fuzzWorkloadFiles.forEach(lintFuzzWorkload);
portableSourceFiles.forEach(lintPortableSource);
lintGeneratedStudioModelRigs();

reportFailures();

if (!hasPhp()) {
  console.warn(`PHP not found; skipped syntax checks for ${phpFiles.length} PHP file(s).`);
  process.exit(0);
}

phpFiles.forEach(lintPhp);

reportFailures();

console.log('Rig package lint passed.');
console.log(`- PHP syntax: ${phpFiles.length} file(s)`);
console.log(`- rig portability: ${rigFiles.length} rig(s)`);
console.log(`- fuzz workloads: ${fuzzWorkloadFiles.length} workload(s)`);
console.log(`- portable source paths: ${portableSourceFiles.length} file(s)`);
