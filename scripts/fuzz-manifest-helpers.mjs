import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadWordPressHelperModule } from '../shared/wordpress-helper-loader.mjs';

export const fuzzCrudOperations = new Set(['create', 'read', 'update', 'delete']);
export const fuzzProofBundleFields = new Set(['artifact_refs', 'run_ids', 'gap_reports', 'fuzz_result_artifacts', 'canonical_fuzz_envelope_ref']);

const wordpressFuzzContracts = loadWordPressHelperModule({
  helperName: 'fuzz-manifest-contracts',
  manifestFileName: 'fuzz-manifest-contracts.js',
});

export const fuzzReadinessLevels = wordpressFuzzContracts.fuzzReadinessLevels;
export const fuzzCaseIntentSchema = wordpressFuzzContracts.fuzzCaseIntentSchema;
export const fullSurfaceCoverageTypes = wordpressFuzzContracts.fullSurfaceCoverageTypes;
export const fullSurfaceGapReportFields = wordpressFuzzContracts.fullSurfaceGapReportFields;

export const assertFullSurfaceCoverageManifest = wordpressFuzzContracts.assertFullSurfaceCoverageManifest;
export const assertGenericArtifactPostprocessWorkloadContract = wordpressFuzzContracts.assertGenericArtifactPostprocessWorkloadContract;
export const assertGenericFuzzManifest = wordpressFuzzContracts.assertGenericFuzzManifest;
export const assertRunnerNeutralFuzzCaseIntent = wordpressFuzzContracts.assertRunnerNeutralFuzzCaseIntent;

export function readJson(root, ...parts) {
  return JSON.parse(readFileSync(path.join(root, ...parts), 'utf8'));
}

export function readMaterializedRig(root, ...parts) {
  const file = path.join(root, ...parts);
  return materializeRigSpec(file, JSON.parse(readFileSync(file, 'utf8')));
}

function materializeRigSpec(file, rig, seen = new Set()) {
  const extendPath = typeof rig.extends === 'string' ? rig.extends.trim() : '';
  if (!extendPath) {
    return rig;
  }

  const parentFile = path.resolve(path.dirname(file), extendPath);
  if (seen.has(parentFile)) {
    throw new Error(`${file}: rig extends cycle includes ${parentFile}`);
  }

  seen.add(parentFile);
  const parentRig = JSON.parse(readFileSync(parentFile, 'utf8'));
  const materializedParent = materializeRigSpec(parentFile, parentRig, seen);
  seen.delete(parentFile);

  return deepMergeRigSpec(materializedParent, rig);
}

function deepMergeRigSpec(parent, child) {
  if (Array.isArray(parent) && isArrayMergeDirective(child)) {
    return applyArrayMergeDirective(parent, child);
  }

  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
    return child;
  }

  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    return child;
  }

  const merged = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    if (key === 'extends') {
      continue;
    }

    const parentValue = merged[key];
    merged[key] = parentValue && value && shouldRecurseMerge(parentValue, value)
      ? deepMergeRigSpec(parentValue, value)
      : value;
  }

  return merged;
}

function shouldRecurseMerge(parentValue, childValue) {
  if (Array.isArray(parentValue) && isArrayMergeDirective(childValue)) {
    return true;
  }

  return typeof parentValue === 'object'
    && typeof childValue === 'object'
    && !Array.isArray(parentValue)
    && !Array.isArray(childValue);
}

function isArrayMergeDirective(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (Object.hasOwn(value, '$append') || Object.hasOwn(value, '$merge_by'));
}

function applyArrayMergeDirective(parent, directive) {
  if (Object.hasOwn(directive, '$append')) {
    return [...parent, ...asDirectiveEntries(directive.$append)];
  }

  const key = typeof directive.$merge_by === 'string' ? directive.$merge_by.trim() : '';
  const entries = asDirectiveEntries(directive.entries);
  if (!key) {
    return directive;
  }

  const merged = [...parent];
  for (const entry of entries) {
    const entryKey = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry[key] : undefined;
    const index = merged.findIndex((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate[key] === entryKey);
    if (entryKey === undefined || index === -1) {
      merged.push(entry);
      continue;
    }
    merged[index] = deepMergeRigSpec(merged[index], entry);
  }

  return merged;
}

function asDirectiveEntries(value) {
  return Array.isArray(value) ? value : [];
}

export function workloadIdFromPath(workloadPath) {
  return path.basename(workloadPath)
    .replace(/\.workload\.json$/, '')
    .replace(/\.bench\.mjs$/, '')
    .replace(/\.php$/, '')
    .replace(/\.mjs$/, '')
    .replace(/\.js$/, '')
    .replace(/\.json$/, '');
}

export function declaredFuzzIds(rig, runner = 'wordpress') {
  return new Set((rig.fuzz_workloads?.[runner] || []).map((entry) => workloadIdFromPath(entry.path || entry)));
}

export function declaredBenchWorkloadIds(rig) {
  return new Set(
    Object.values(rig.bench_workloads || {})
      .flat()
      .map((entry) => workloadIdFromPath(entry.path || entry))
  );
}

export function declaredBenchProfileIds(rig) {
  return new Set(Object.values(rig.bench_profiles || {}).flat());
}

export function collectFuzzManifests(packageRoot, { declaredIds } = {}) {
  const fuzzDir = path.join(packageRoot, 'fuzz');

  return readdirSync(fuzzDir)
    .filter((file) => file.endsWith('.json'))
    .filter((file) => !declaredIds || declaredIds.has(workloadIdFromPath(file)))
    .sort()
    .map((file) => ({
      file,
      path: path.join(fuzzDir, file),
      manifest: readJson(fuzzDir, file),
    }));
}

export function fullSurfaceRequiredArtifactIds(coverageManifest, profile = 'full-surface') {
  const workloadIds = Object.entries(coverageManifest.coverage_profiles?.[profile] || {})
    .filter(([surface]) => surface !== 'browser_requests')
    .flatMap(([, ids]) => ids);

  return new Set(workloadIds.filter((workloadId) => (
    coverageManifest.workloads?.[workloadId]?.artifact_expectations?.required || []
  ).length > 0));
}

export function fuzzManifestHasExecutableArtifactContract(manifest) {
  return ['executable', 'proven'].includes(manifest.metadata?.readiness?.level)
    && manifest.metadata?.generic_primitive?.status !== 'blocked';
}

export function assertFuzzProofBundle(proofBundle, manifest, { file } = {}) {
  if (proofBundle?.canonical_fuzz_envelope_ref !== undefined) {
    assertCanonicalFuzzEnvelopeRef(proofBundle, { file: file || manifest.id });
    assertOptionalFuzzResultArtifacts(proofBundle, manifest, { file: file || manifest.id });
    return proofBundle;
  }

  assert.ok(proofBundle && typeof proofBundle === 'object' && !Array.isArray(proofBundle), `${file || manifest.id} proof_bundle must be an object`);
  return proofBundle;
}

export function assertCanonicalFuzzEnvelopeRef(proofBundle, { file = 'fuzz workload' } = {}) {
  if (proofBundle?.canonical_fuzz_envelope_ref === undefined) {
    return;
  }

  assertReviewerFacingFuzzRef(
    proofBundle.canonical_fuzz_envelope_ref,
    `${file} metadata.readiness.proof_bundle.canonical_fuzz_envelope_ref`
  );
}

export function assertReviewerFacingFuzzRef(value, context) {
  assert.equal(typeof value, 'string', `${context} must be a reviewer-facing artifact ref string`);
  assert.ok(value.trim().length > 0, `${context} must be a reviewer-facing artifact ref string`);

  const result = normalizeReviewerFacingFuzzRef(value);
  if (!result.ok) {
    assert.fail(`${context} ${result.message}`);
  }
}

export function normalizeReviewerFacingFuzzRef(value) {
  const cliResult = normalizeReviewerFacingFuzzRefWithHomeboy(value);
  return cliResult;
}

function normalizeReviewerFacingFuzzRefWithHomeboy(value) {
  const command = homeboyArtifactRefNormalizerCommand();
  const result = spawnSync(command[0], [...command.slice(1), '--input', JSON.stringify(value)], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  if (result.error?.code === 'ENOENT') {
    return { status: 'rejected', ok: false, message: 'requires Homeboy contract normalize artifact-ref support' };
  }

  const stderr = (result.stderr || '').trim();
  const stdout = (result.stdout || '').trim();
  if (result.status === 0) {
    const payload = stdout ? JSON.parse(stdout) : null;
    return { status: 'normalized', ok: true, value: payload?.data?.normalized || value };
  }

  if (/unrecognized subcommand 'normalize'|unrecognized subcommand 'artifact-ref'|Usage: homeboy contract\b/.test(stderr)) {
    return { status: 'rejected', ok: false, message: 'requires Homeboy contract normalize artifact-ref support' };
  }

  const payload = stdout ? JSON.parse(stdout) : null;
  return { status: 'rejected', ok: false, message: payload?.error?.message || stderr || 'must be a reviewer-facing artifact ref' };
}

function homeboyArtifactRefNormalizerCommand() {
  return [process.env.HOMEBOY_BIN || 'homeboy', 'contract', 'normalize', 'artifact-ref'];
}

function assertOptionalFuzzResultArtifacts(proofBundle, manifest, { file = manifest.id } = {}) {
  if (proofBundle.fuzz_result_artifacts === undefined) {
    return;
  }

  assertStringArray(proofBundle.fuzz_result_artifacts, `${file} metadata.readiness.proof_bundle.fuzz_result_artifacts`);
  const requiredArtifactNames = new Set([
    ...(manifest.cases || []).flatMap((runnerCase) => runnerCase.artifacts || []),
    ...(manifest.artifacts?.expected || []),
  ].filter((artifact) => artifact?.required === true).map((artifact) => artifact.name));
  for (const artifactName of proofBundle.fuzz_result_artifacts) {
    assert.ok(requiredArtifactNames.has(artifactName), `${file} proof_bundle.fuzz_result_artifacts ${artifactName} must name a required case or expected artifact`);
  }
}

export function assertRequiredFuzzProofContracts(manifest, {
  requiredContracts = [],
  runnerCase = manifest.cases?.[0],
  file = manifest.id,
} = {}) {
  if (requiredContracts.length === 0) {
    return;
  }

  const proofContracts = manifest.proof_contracts || [];
  assert.ok(Array.isArray(proofContracts), `${file} proof_contracts must be an array`);

  const proofContractIds = new Set(proofContracts.map((contract) => contract.id));
  for (const contractId of requiredContracts) {
    assert.ok(proofContractIds.has(contractId), `${file} missing proof contract ${contractId}`);
  }

  for (const contract of proofContracts) {
    assert.equal(typeof contract.description, 'string', `${file} proof contract ${contract.id} requires description`);
    assert.ok(contract.description.length > 0, `${file} proof contract ${contract.id} description must not be empty`);
    assert.equal(typeof contract.required_artifact, 'string', `${file} proof contract ${contract.id} requires required_artifact`);
  }

  const requiredArtifactNames = new Set(proofContracts.map((contract) => contract.required_artifact));
  for (const artifactName of requiredArtifactNames) {
    const caseArtifact = runnerCase?.artifacts?.find((artifact) => artifact.name === artifactName);
    const expectedArtifact = manifest.artifacts?.expected?.find((artifact) => artifact.name === artifactName);
    assert.equal(caseArtifact?.required, true, `${file} proof artifact ${artifactName} must be required on the case`);
    assert.equal(expectedArtifact?.required, true, `${file} proof artifact ${artifactName} must be required in expected artifacts`);
  }
}

function collectRequiredArtifactNames(manifest) {
  return new Set([
    ...(manifest.cases || []).flatMap((runnerCase) => runnerCase.artifacts || []),
    ...(manifest.artifacts?.expected || []),
  ]
    .filter((artifact) => artifact?.required === true)
    .map((artifact) => artifact?.name)
    .filter(Boolean));
}

function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  for (const entry of value) {
    assert.equal(typeof entry, 'string', `${label} entries must be strings`);
    assert.notEqual(entry.trim(), '', `${label} entries must be non-empty`);
  }
}
