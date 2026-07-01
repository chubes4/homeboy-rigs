#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertFuzzReadinessMetadata,
  collectGenericFuzzWorkloadIssues,
} from './fuzz-manifest-helpers.mjs';

const args = process.argv.slice(2);
const strictFuzzReadiness = args.includes('--strict-fuzz-readiness');
const rootArg = args.find((arg) => !arg.startsWith('--'));
const root = rootArg ? resolve(process.cwd(), rootArg) : process.cwd();
// Keep this set a superset of homeboy core's `IGNORED_DIRECTORIES`
// (src/core/rig/lint.rs) so a rig package never passes one linter and fails the
// other. Core ignores `.sampleplugin` (generated WP Codebox sample-plugin
// scaffolds); homeboy-rigs additionally has a real top-level `.datamachine/`.
// The unified policy is the union of both. Converging this linter onto the core
// primitive is tracked in Extra-Chill/homeboy#6783; the lint-only entry point
// CI needs to consume `run_package_lint` (and the matching core `.datamachine`
// ignore) is tracked in Extra-Chill/homeboy#6825.
const ignoredDirectories = new Set(['.git', '.claude', '.sampleplugin', '.datamachine', '.opencode', 'node_modules', 'vendor']);
const phpFiles = [];
const rigFiles = [];
const jsonFiles = [];
const fuzzWorkloadFiles = [];
const portableSourceFiles = [];
const fuzzManifestValidators = [];
const fuzzWorkloadValidatorFiles = [];
const portableSourceValidatorFiles = [];
const failures = [];
const warnings = [];
const studioModelRigGenerator = join(root, 'scripts/generate-studio-agent-model-rigs.mjs');
const personalPathPrefix = '/Users/' + 'chubes/';
const localDeveloperCheckoutPattern = /(?:~|\$HOME)\/Developer\//;
const tsrmlsPatchMarker = 'PHP-WASM-COMBINED-FIXES ' + 'TSRMLS fallback';
const cleanupIntentContractSchema = 'homeboy/resource-cleanup-intent/v1';
const cleanupIntents = new Set(['none', 'external', 'manual', 'pipeline']);
const homeboyBin = process.env.HOMEBOY_BIN || 'homeboy';

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

    if (entry.isFile() && entry.name === 'validate-fuzz-manifests.mjs') {
      fuzzManifestValidators.push(join(directory, entry.name));
    }

    if (entry.isFile() && entry.name === 'fuzz-workload-validator.mjs') {
      fuzzWorkloadValidatorFiles.push(join(directory, entry.name));
    }

    if (entry.isFile() && entry.name === 'portable-source-validator.mjs') {
      portableSourceValidatorFiles.push(join(directory, entry.name));
    }
  }
}

async function loadPortableSourceValidators() {
  const validators = [];

  for (const file of portableSourceValidatorFiles.sort()) {
    try {
      const module = await import(pathToFileURL(file));
      const validate = module.validatePortableSource || module.default;
      if (typeof validate !== 'function') {
        failures.push(`${relative(root, file)}: portable source validator must export validatePortableSource(sourceContext) or a default function`);
        continue;
      }
      validators.push({ file, validate });
    } catch (error) {
      failures.push(`${relative(root, file)}: failed to load portable source validator: ${error.message}`);
    }
  }

  return validators;
}

async function loadFuzzWorkloadValidators() {
  const validators = [];

  for (const file of fuzzWorkloadValidatorFiles.sort()) {
    try {
      const module = await import(pathToFileURL(file));
      const validate = module.validateFuzzWorkload || module.default;
      if (typeof validate !== 'function') {
        failures.push(`${relative(root, file)}: fuzz workload validator must export validateFuzzWorkload(workloadContext) or a default function`);
        continue;
      }
      validators.push({ file, validate });
    } catch (error) {
      failures.push(`${relative(root, file)}: failed to load fuzz workload validator: ${error.message}`);
    }
  }

  return validators;
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

  if (/Automattic\/studio\/rigs\/studio-(?:canonical-loop-proof|native-live-runtime-open)\/rig\.json/.test(rel) && /--out\s+\/tmp\//.test(contents)) {
    failures.push(`${rel}: proof rig checks must let proof scripts use Homeboy artifact env output directories instead of hard-coded /tmp outputs`);
  }

  if (localDeveloperCheckoutPattern.test(contents)) {
    failures.push(`${rel}: use portable component path settings instead of committed ~/Developer or $HOME/Developer checkout paths`);
  }

  if (/shared\/wp-codebox\/check-cli\.sh|command -v wp-codebox|Developer\/wp-codebox|HOMEBOY_WP_CODEBOX_BIN/.test(pipelineCommands)) {
    failures.push(`${rel}: WP Codebox executable discovery belongs upstream; do not add rig-local CLI checks or fallback discovery`);
  }

  lintSharedPaths(rel, rig);
  lintLifecycleCleanup(rel, rig);

  lintFuzzWorkloads(rel, file, rig, fuzzWorkloadsByPackageRoot);
  lintFuzzProfiles(rel, rig);
  lintBenchProfiles(rel, file, rig, fuzzWorkloadsByPackageRoot);
}

function hasDeclaredResources(resources) {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return false;
  }

  return Object.values(resources).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
}

function lifecycleCleanupPolicy(rig) {
  const cleanup = rig.lifecycle?.cleanup;
  return cleanup && typeof cleanup === 'object' && !Array.isArray(cleanup) ? cleanup : null;
}

function lintLifecycleCleanup(rel, rig) {
  const cleanup = lifecycleCleanupPolicy(rig);

  if (cleanup) {
    validateHomeboyCleanupIntentContract(rel, cleanup);

    if (!cleanupIntents.has(cleanup.intent)) {
      failures.push(`${rel}: lifecycle.cleanup.intent must be one of ${[...cleanupIntents].join(', ')}`);
    }

    if (typeof cleanup.reason !== 'string' || cleanup.reason.trim() === '') {
      failures.push(`${rel}: lifecycle.cleanup.reason must explain the cleanup boundary`);
    }
  }

  if (!hasDeclaredResources(rig.resources) || !Array.isArray(rig.pipeline?.down) || rig.pipeline.down.length > 0 || cleanup) {
    return;
  }

  failures.push(`${rel}: rigs with declared resources and empty pipeline.down must declare lifecycle.cleanup intent`);
}

function cleanupContractForRigPolicy(rel, cleanup) {
  const owner = typeof cleanup.intent === 'string' ? cleanup.intent : '';
  const reason = typeof cleanup.reason === 'string' ? cleanup.reason : '';
  const metadata = {
    owner,
    declared_by: rel,
    reason,
  };
  const contract = {
    schema: cleanupIntentContractSchema,
    intent: cleanup.intent === 'pipeline' ? 'apply' : 'dry_run',
    ownership: {
      dry_run: metadata,
    },
  };

  if (cleanup.intent === 'pipeline') {
    contract.ownership.apply = metadata;
  }

  return contract;
}

function validateHomeboyCleanupIntentContract(rel, cleanup) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'homeboy-rigs-cleanup-intent-'));
  const contractFile = join(temporaryDirectory, 'cleanup-intent.json');

  try {
    writeFileSync(contractFile, `${JSON.stringify(cleanupContractForRigPolicy(rel, cleanup), null, 2)}\n`);
    const result = spawnSync(homeboyBin, ['contract', 'validate', cleanupIntentContractSchema, '--file', contractFile], {
      encoding: 'utf8',
    });

    if (result.error) {
      failures.push(`${rel}: failed to run Homeboy cleanup intent contract validator: ${result.error.message}`);
      return;
    }

    if (result.status === 0) {
      return;
    }

    failures.push(`${rel}: lifecycle.cleanup failed Homeboy cleanup intent contract validation: ${formatHomeboyValidationFailure(result)}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function formatHomeboyValidationFailure(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();

  if (!output) {
    return `validator exited with status ${result.status}`;
  }

  try {
    const payload = JSON.parse(output);
    const details = payload.error?.details || {};
    const path = details.path || details.field;
    const error = details.error || payload.error?.message;

    return [path, error].filter(Boolean).join(': ') || output;
  } catch {
    return output;
  }
}

function lintSharedPaths(rel, rig) {
  if (!rig.shared_paths) {
    return;
  }

  if (!Array.isArray(rig.shared_paths)) {
    failures.push(`${rel}: shared_paths must be an array`);
    return;
  }

  rig.shared_paths.forEach((sharedPath, index) => {
    if (!sharedPath || typeof sharedPath !== 'object' || Array.isArray(sharedPath)) {
      failures.push(`${rel}: shared_paths[${index}] must be an object`);
      return;
    }

    const link = typeof sharedPath.link === 'string' ? sharedPath.link.trim() : '';
    const target = typeof sharedPath.target === 'string' ? sharedPath.target.trim() : '';

    if (!link || !target) {
      return;
    }

    if (link === target && sharedPath.allow_self_target !== true) {
      failures.push(`${rel}: shared_paths[${index}] link and target must differ unless allow_self_target is true`);
    }
  });
}

function packageRootForRig(file) {
  const rel = relative(root, file);
  if (rel.startsWith('rigs/')) {
    return root;
  }

  const rigsIndex = rel.indexOf('/rigs/');

  if (rigsIndex === -1) {
    return dirname(file);
  }

  return join(root, rel.slice(0, rigsIndex));
}

function packageRootForFuzzWorkload(file) {
  const rel = relative(root, file);
  if (rel.startsWith('fuzz/')) {
    return root;
  }

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
  for (const issue of collectGenericFuzzWorkloadIssues(workload, { context })) {
    failures.push(`${rel}: ${issue}`);
  }

  if (workload.workload && typeof workload.workload === 'object' && !Array.isArray(workload.workload) && typeof workload.workload.path === 'string' && workload.workload.path.trim() !== '') {
    const workloadPath = resolvePackagePath(workload.workload.path, packageRoot);
    if (!workloadPath) {
      failures.push(`${rel}: ${context} workload path must be resolvable`);
    } else if (!existsSync(workloadPath)) {
      failures.push(`${rel}: ${context} workload path ${relative(root, workloadPath)} does not exist`);
    }
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

function lintFuzzProfiles(rel, rig) {
  if (!rig.fuzz_profiles) {
    return;
  }

  const workloadIds = new Set();

  for (const workloads of Object.values(rig.fuzz_workloads || {})) {
    if (!Array.isArray(workloads)) {
      continue;
    }

    for (const workload of workloads) {
      const path = typeof workload === 'string' ? workload : workload?.path;
      if (path) {
        workloadIds.add(workloadIdFromPath(path));
      }
    }
  }

  for (const [profile, workloadRefs] of Object.entries(rig.fuzz_profiles)) {
    if (!Array.isArray(workloadRefs)) {
      failures.push(`${rel}: fuzz profile ${profile} must be an array of workload ids`);
      continue;
    }

    for (const workloadRef of workloadRefs) {
      if (!workloadIds.has(workloadRef)) {
        failures.push(`${rel}: fuzz profile ${profile} references ${workloadRef}, but fuzz_workloads does not declare a matching workload file`);
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

function lintPortableSource(file, portableSourceValidators) {
  const rel = relative(root, file);
  const contents = readFileSync(file, 'utf8');

  if (contents.includes(personalPathPrefix)) {
    failures.push(`${rel}: use $HOME, homedir(), component paths, or settings instead of hard-coded /Users/chubes paths`);
  }

  if (rel.includes('/stacks/') && localDeveloperCheckoutPattern.test(contents)) {
    failures.push(`${rel}: use portable component path settings instead of committed ~/Developer or $HOME/Developer checkout paths`);
  }

  if (contents.includes(tsrmlsPatchMarker)) {
    failures.push(`${rel}: TSRMLS fallback defines are owned by WordPress/wordpress-playground#3512; do not patch Playground source in rigs`);
  }

  if (rel === 'Automattic/studio/proofs/studio-native-live-runtime-open.mjs' && contents.includes('studio-native-local-runtime.local')) {
    failures.push(`${rel}: live runtime proof must require an explicit runtime URL instead of falling back to local DNS`);
  }

  lintProductPortableSourceValidators(rel, file, contents, portableSourceValidators);
}

function lintFuzzWorkload(file, fuzzWorkloadValidators) {
  const rel = relative(root, file);
  let workload;

  try {
    workload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`${rel}: invalid JSON: ${error.message}`);
    return;
  }

  for (const issue of collectGenericFuzzWorkloadIssues(workload, { context: 'fuzz workload' })) {
    failures.push(`${rel}: ${issue}`);
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

  lintFuzzReadinessMetadata(rel, workload);
  lintProductFuzzWorkloadValidators(rel, file, workload, fuzzWorkloadValidators);

  if (workload.limits) {
    if (!Number.isInteger(workload.limits.max_cases) || workload.limits.max_cases < 1) {
      failures.push(`${rel}: limits.max_cases must be a positive integer`);
    }

    if (!Number.isInteger(workload.limits.max_duration_seconds) || workload.limits.max_duration_seconds < 1) {
      failures.push(`${rel}: limits.max_duration_seconds must be a positive integer`);
    }
  }
}

function lintFuzzReadinessMetadata(rel, workload) {
  if (!workload.metadata?.readiness) {
    const message = `${rel}: fuzz workload should declare metadata.readiness.level and coverage_contract`;
    if (strictFuzzReadiness) {
      failures.push(message);
    } else {
      warnings.push(message);
    }
    return;
  }

  try {
    assertFuzzReadinessMetadata(workload, { file: rel });
  } catch (error) {
    failures.push(error.message);
    return;
  }

  const readinessLevel = workload.metadata.readiness.level;
  const optionalArtifactNames = [
    ...(workload.cases || []).flatMap((runnerCase) => runnerCase.artifacts || []),
    ...(workload.artifacts?.expected || []),
  ]
    .filter((artifact) => artifact?.required !== true)
    .map((artifact) => artifact?.name)
    .filter(Boolean);

  if (readinessLevel === 'proven' && optionalArtifactNames.length > 0) {
    failures.push(`${rel}: proven fuzz readiness requires required proof artifacts (${[...new Set(optionalArtifactNames)].join(', ')})`);
  } else if (readinessLevel === 'executable' && optionalArtifactNames.length > 0) {
    warnings.push(`${rel}: executable fuzz readiness has optional artifact(s): ${[...new Set(optionalArtifactNames)].join(', ')}`);
  }
}

function lintProductFuzzWorkloadValidators(rel, file, workload, fuzzWorkloadValidators) {
  for (const validator of fuzzWorkloadValidators) {
    try {
      const issues = validator.validate({ rel, root, file, workload });
      if (issues === undefined) {
        continue;
      }
      if (!Array.isArray(issues)) {
        failures.push(`${relative(root, validator.file)}: validateFuzzWorkload must return an array of failure strings or undefined`);
        continue;
      }
      failures.push(...issues);
    } catch (error) {
      failures.push(error.message);
    }
  }
}

function lintProductPortableSourceValidators(rel, file, contents, portableSourceValidators) {
  for (const validator of portableSourceValidators) {
    try {
      const issues = validator.validate({ rel, root, file, contents });
      if (issues === undefined) {
        continue;
      }
      if (!Array.isArray(issues)) {
        failures.push(`${relative(root, validator.file)}: validatePortableSource must return an array of failure strings or undefined`);
        continue;
      }
      failures.push(...issues);
    } catch (error) {
      failures.push(error.message);
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

function reportWarnings() {
  if (warnings.length === 0) {
    return;
  }

  console.warn('Rig package lint warnings:');
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
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

function lintFuzzManifestValidators() {
  for (const validator of fuzzManifestValidators) {
    const result = spawnSync('node', [validator], { encoding: 'utf8' });
    if (result.status !== 0) {
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      failures.push(`${relative(root, validator)} failed${output ? `: ${output}` : ''}`);
    }
  }
}

walk(root);

const portableSourceValidators = await loadPortableSourceValidators();
const fuzzWorkloadValidators = await loadFuzzWorkloadValidators();
const fuzzWorkloadsByPackageRoot = collectFuzzWorkloads();

rigFiles.forEach((file) => lintRigPortability(file, fuzzWorkloadsByPackageRoot));
fuzzWorkloadFiles.forEach((file) => lintFuzzWorkload(file, fuzzWorkloadValidators));
portableSourceFiles.forEach((file) => lintPortableSource(file, portableSourceValidators));
lintGeneratedStudioModelRigs();
lintFuzzManifestValidators();

reportFailures();

if (!hasPhp()) {
  reportWarnings();
  console.warn(`PHP not found; skipped syntax checks for ${phpFiles.length} PHP file(s).`);
  process.exit(0);
}

phpFiles.forEach(lintPhp);

reportFailures();

reportWarnings();

console.log('Rig package lint passed.');
console.log(`- PHP syntax: ${phpFiles.length} file(s)`);
console.log(`- rig portability: ${rigFiles.length} rig(s)`);
console.log(`- fuzz workloads: ${fuzzWorkloadFiles.length} workload(s)`);
console.log(`- portable source paths: ${portableSourceFiles.length} file(s)`);
