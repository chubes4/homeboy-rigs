import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadWordPressHelperModule } from '../shared/wordpress-helper-loader.mjs';

export const fuzzReadinessLevels = new Set(['declared', 'executable', 'proven']);
export const fuzzCrudOperations = new Set(['create', 'read', 'update', 'delete']);
export const fuzzCaseIntentSchema = 'homeboy/fuzz-workload-intent/v1';
export const fuzzProofBundleFields = new Set(['artifact_refs', 'run_ids', 'gap_reports', 'fuzz_result_artifacts', 'canonical_fuzz_envelope_ref']);
export const fullSurfaceCoverageTypes = new Set(['rest', 'admin', 'frontend', 'browser', 'database']);
export const fullSurfaceGapReportFields = new Set(['surface_type', 'expected', 'covered', 'gaps', 'status', 'evidence_refs']);

function loadGenericFuzzManifestValidator() {
  return loadWordPressHelperModule({
    helperName: 'wordpress-fuzz-manifest-validator',
    envVar: 'HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR',
    manifestFileName: 'wordpress-fuzz-manifest-validator.js',
    packageImport: 'homeboy-extension-wordpress/wordpress-fuzz-manifest-validator',
  });
}

export function readJson(root, ...parts) {
  return JSON.parse(readFileSync(path.join(root, ...parts), 'utf8'));
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

export function assertGenericFuzzManifest(manifest, {
  file,
  declaredIds,
  benchWorkloadIds = new Set(),
  benchProfileIds = new Set(),
  targetType = 'wordpress-plugin',
  targetSlug,
  workloadTypes = ['php', 'json'],
  requireCaseSafetyClass = false,
  requireCaseArtifacts = true,
  requireExpectedArtifacts = true,
  requireExpectedArtifactSemanticKeys = false,
  requireReadinessMetadata = false,
  requireRunnerNeutralIntent = false,
} = {}) {
  assert.equal(manifest.schema, 'homeboy/fuzz-workload/v1', `${file} schema mismatch`);
  assert.equal(typeof manifest.id, 'string', `${file} requires id`);

  if (declaredIds) {
    assert.ok(declaredIds.has(manifest.id), `${manifest.id} is not declared in rig fuzz_workloads.wordpress`);
  }

  assert.ok(!benchWorkloadIds.has(manifest.id), `${manifest.id} must not appear in bench_workloads`);
  assert.ok(!benchProfileIds.has(manifest.id), `${manifest.id} must not appear in bench_profiles`);

  assert.equal(manifest.target?.type, targetType, `${manifest.id} target.type mismatch`);
  if (targetSlug) {
    assert.equal(manifest.target?.slug, targetSlug, `${manifest.id} target.slug mismatch`);
  }

  assert.equal(manifest.workload?.runner, 'wp-codebox', `${manifest.id} workload.runner mismatch`);
  assert.equal(manifest.workload?.path, manifest.metadata?.workload_path, `${manifest.id} workload path must match metadata`);
  assert.ok(workloadTypes.includes(manifest.workload?.type), `${manifest.id} workload.type must be ${workloadTypes.join(', or ')}`);
  assert.deepEqual(manifest.coverage?.surface_ids, manifest.surface_ids, `${manifest.id} coverage surface ids drifted`);
  assert.deepEqual(manifest.coverage?.operations, manifest.operations, `${manifest.id} coverage operations drifted`);
  assert.equal(manifest.limits?.max_cases, manifest.case_budget, `${manifest.id} max_cases must match case_budget`);
  assert.equal(manifest.limits?.max_duration_seconds, manifest.duration_budget_seconds, `${manifest.id} max_duration_seconds must match duration_budget_seconds`);

  if (requireReadinessMetadata || manifest.metadata?.readiness) {
    assertFuzzReadinessMetadata(manifest, { file });
  }

  assert.equal(manifest.cases?.length, 1, `${manifest.id} requires one default runner case`);
  const [runnerCase] = manifest.cases;
  assert.equal(runnerCase.case_id, `${manifest.id}:default`, `${manifest.id} default case id mismatch`);
  if (requireCaseSafetyClass) {
    assert.equal(runnerCase.metadata?.safety_class, manifest.safety_class, `${manifest.id} case safety class must match workload safety class`);
  }
  assert.deepEqual(runnerCase.surface_ids, manifest.surface_ids, `${manifest.id} case surface ids drifted`);
  assert.deepEqual(runnerCase.operations, manifest.operations, `${manifest.id} case operations drifted`);
  if (runnerCase.intent) {
    assertRunnerNeutralFuzzCaseIntent(manifest, runnerCase);
  } else {
    assert.equal(requireRunnerNeutralIntent, false, `${manifest.id} requires runner-neutral case intent`);
    assert.ok(Array.isArray(runnerCase.phases?.action), `${manifest.id} requires action phase`);
    assert.ok(runnerCase.phases.action.length > 0, `${manifest.id} requires at least one action step`);
  }
  assert.ok(Array.isArray(runnerCase.artifacts), `${manifest.id} requires case artifacts`);
  assert.ok(Array.isArray(manifest.artifacts?.expected), `${manifest.id} requires expected artifacts`);

  if (requireCaseArtifacts) {
    for (const artifact of runnerCase.artifacts) {
      assert.equal(artifact.required, true, `${manifest.id} case artifact ${artifact.name} must be required`);
    }
  }

  for (const artifact of manifest.artifacts.expected) {
    if (requireExpectedArtifacts) {
      assert.equal(artifact.required, true, `${manifest.id} expected artifact ${artifact.name} must be required`);
    }
    if (requireExpectedArtifactSemanticKeys) {
      assert.equal(typeof artifact.semantic_key, 'string', `${manifest.id} expected artifact ${artifact.name} requires semantic_key`);
    }
  }

  return runnerCase;
}

export function assertRunnerNeutralFuzzCaseIntent(manifest, runnerCase) {
  return loadGenericFuzzManifestValidator().assertRunnerNeutralFuzzCaseIntent(manifest, runnerCase);
}

export function assertFuzzReadinessMetadata(manifest, { file = manifest.id } = {}) {
  return loadGenericFuzzManifestValidator().assertFuzzReadinessMetadata(manifest, { file });
}

export function assertFuzzProofBundle(proofBundle, manifest, { file } = {}) {
  if (proofBundle?.canonical_fuzz_envelope_ref !== undefined) {
    assertCanonicalFuzzEnvelopeRef(proofBundle, { file: file || manifest.id });
    assertOptionalFuzzResultArtifacts(proofBundle, manifest, { file: file || manifest.id });
    return proofBundle;
  }

  return loadGenericFuzzManifestValidator().assertFuzzProofBundle(proofBundle, manifest, { file });
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
  if (cliResult.status !== 'unavailable') {
    return cliResult;
  }

  return normalizeReviewerFacingFuzzRefWithTransitionalFallback(value);
}

function normalizeReviewerFacingFuzzRefWithHomeboy(value) {
  const command = homeboyArtifactRefNormalizerCommand();
  const result = spawnSync(command[0], [...command.slice(1), value], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  if (result.error?.code === 'ENOENT') {
    return { status: 'unavailable', ok: false, message: 'homeboy artifact ref normalizer is unavailable' };
  }

  const stderr = (result.stderr || '').trim();
  if (result.status === 0) {
    return { status: 'normalized', ok: true, value: (result.stdout || '').trim() || value };
  }

  if (/unrecognized subcommand 'normalize'|unrecognized subcommand 'artifact-ref'|Usage: homeboy contract\b/.test(stderr)) {
    return { status: 'unavailable', ok: false, message: 'homeboy artifact ref normalizer is unavailable' };
  }

  return { status: 'rejected', ok: false, message: stderr || 'must be a reviewer-facing artifact ref' };
}

function homeboyArtifactRefNormalizerCommand() {
  if (process.env.HOMEBOY_ARTIFACT_REF_NORMALIZER_COMMAND) {
    const command = JSON.parse(process.env.HOMEBOY_ARTIFACT_REF_NORMALIZER_COMMAND);
    assert.ok(Array.isArray(command) && command.length > 0, 'HOMEBOY_ARTIFACT_REF_NORMALIZER_COMMAND must be a JSON command array');
    return command;
  }

  return ['homeboy', 'contract', 'normalize', 'artifact-ref'];
}

// Transitional only: local Studio machines may still have a pre-normalizer
// Homeboy release on PATH. Remove when the released CLI is ubiquitous.
function normalizeReviewerFacingFuzzRefWithTransitionalFallback(value) {
  if (!reviewerFacingArtifactRefScheme(value)) {
    return { status: 'fallback', ok: false, message: 'must be a reviewer-facing artifact ref' };
  }

  if (localOnlyReviewerFacingRef(value)) {
    return { status: 'fallback', ok: false, message: 'must not use local evidence' };
  }

  return { status: 'fallback', ok: true, value };
}

function reviewerFacingArtifactRefScheme(value) {
  return /^(https:\/\/|gh:|homeboy-runs:|homeboy:\/\/run\/|homeboy-artifact:\/\/|artifact:|run:)/.test(value);
}

function localOnlyReviewerFacingRef(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  const ref = value.trim();
  return localOnlyRefValue(ref) || localOnlySchemePayload(ref);
}

function localOnlySchemePayload(ref) {
  const match = /^(?:artifact:|run:|homeboy-runs:|homeboy-artifact:\/\/)(.*)$/i.exec(ref);
  return Boolean(match && localOnlyRefValue(match[1]));
}

function localOnlyRefValue(ref) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(ref)
    || /^file:\/\//i.test(ref)
    || /^\/Users\//.test(ref)
    || /^\/private\//.test(ref)
    || /^\/tmp(?:\/|$)/.test(ref)
    || /^\.\.?(?:\/|$)/.test(ref);
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

export function assertArtifactPostprocessWorkloadContract(workload, { id, action, artifact, outputPath, schema, runnerSupportStatus = 'supported', readinessLevel = 'executable' }) {
  assert.equal(workload.schema, 'wp-codebox/wordpress-workload-run/v1', `${id} workload must use the generic workload-run contract`);
  assert.equal(workload.id, id, `${id} workload id drifted`);
  assert.equal(workload.steps?.length, 1, `${id} must declare one artifact postprocess step`);
  assert.equal(workload.steps[0].command, 'homeboy.artifact-postprocess', `${id} must use the generic artifact postprocess command`);
  assert.equal(workload.steps[0].type, undefined, `${id} must not invent an unsupported step type`);
  assert.equal(workload.steps[0].runner_support_status, undefined, `${id} runner support status belongs in metadata, not the executable step`);

  const args = workload.steps[0].args;
  assert.equal(args.helper, '${package.root}/tools/db-api-fuzzer-artifacts.mjs', `${id} helper drifted`);
  assert.equal(args.action, action, `${id} action drifted`);
  assert.deepEqual(args.input, {
    type: 'artifact-root',
    path: '${artifacts.root}',
    artifact_globs: ['**/*.json'],
    max_bytes: 1048576,
  }, `${id} input artifact binding drifted`);
  assert.equal(args.output.artifact, artifact, `${id} output artifact drifted`);
  assert.equal(args.output.path, outputPath, `${id} output path drifted`);
  assert.equal(args.output.kind, 'json', `${id} output kind drifted`);
  assert.equal(args.output.contentType, 'application/json', `${id} output contentType drifted`);
  assert.equal(args.output.schema, schema, `${id} output schema drifted`);
  assert.equal(args.output.semantic_key, 'fuzz.report', `${id} semantic key drifted`);

  assert.deepEqual(workload.artifacts?.[0], {
    name: artifact,
    path: outputPath,
    kind: 'json',
    contentType: 'application/json',
    required: true,
    metadata: {
      schema,
      semantic_key: 'fuzz.report',
    },
  }, `${id} collected artifact declaration drifted`);

  assert.equal(workload.metadata?.runner_support_status, runnerSupportStatus, `${id} artifact-postprocess runner support status drifted`);
  assert.equal(workload.metadata?.readiness?.level, readinessLevel, `${id} artifact-postprocess readiness level drifted`);
  assert.ok(workload.metadata?.readiness?.proven_when?.some((condition) => condition.includes('artifact root')), `${id} readiness must describe the artifact-root proof condition`);
  assert.ok(workload.metadata?.readiness?.proven_when?.some((condition) => condition.includes('reviewer-facing evidence')), `${id} readiness must describe the reviewer-facing artifact proof condition`);
  if (runnerSupportStatus === 'blocked') {
    assert.equal(workload.metadata?.generic_primitive?.status, 'blocked', `${id} blocked workload must mark the generic primitive as blocked`);
    assert.ok(workload.metadata?.missing_upstream_contract?.includes('artifact-postprocess'), `${id} blocked workload must name the missing upstream artifact-postprocess contract`);
  } else {
    assert.equal(workload.metadata?.missing_upstream_contract, undefined, `${id} must not claim missing upstream artifact-postprocess fields`);
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

export function assertFuzzCrudReadiness(crud, { file } = {}) {
  return loadGenericFuzzManifestValidator().assertFuzzCrudReadiness(crud, { file });
}

export function assertFuzzReadinessLevel(level, label) {
  return loadGenericFuzzManifestValidator().assertFuzzReadinessLevel(level, label);
}

export function assertExecutableCrudMutationSafety(readiness, { file } = {}) {
  const executableMutations = ['create', 'update', 'delete'].filter((operation) => ['executable', 'proven'].includes(readiness?.crud?.[operation]?.level));
  if (executableMutations.length === 0) {
    return;
  }

  assert.ok(readiness.mutation, `${file} executable CRUD mutation readiness requires metadata.readiness.mutation`);
  assertFuzzMutationReadiness(readiness.mutation, { file });
  assert.ok(readiness.mutation.disposable_sandbox_boundary_artifacts.length > 0, `${file} executable CRUD mutation readiness requires disposable_sandbox_boundary_artifacts`);
  assert.ok(readiness.mutation.mutation_isolation_artifacts.length > 0, `${file} executable CRUD mutation readiness requires mutation_isolation_artifacts`);
  assert.ok(readiness.mutation.teardown_discard_evidence.length > 0, `${file} executable CRUD mutation readiness requires teardown_discard_evidence`);
  assert.ok(readiness.mutation.artifact_bundle_refs.length > 0, `${file} executable CRUD mutation readiness requires artifact_bundle_refs`);

  for (const operation of executableMutations) {
    const safetyClass = readiness.crud[operation].safety_class;
    assert.ok(
      ['isolated_mutation', 'synthetic_checkout_mutation', 'bounded_catalog_fixture_mutation', 'bounded_admin_fixture_mutation'].includes(safetyClass),
      `${file} executable CRUD ${operation} requires an isolated mutation safety_class`
    );
  }
}

export function assertFuzzProofBundleRequirements(requirements, { file } = {}) {
  return loadGenericFuzzManifestValidator().assertFuzzProofBundleRequirements(requirements, { file });
}

export function assertFuzzMutationReadiness(mutation, { file } = {}) {
  return loadGenericFuzzManifestValidator().assertFuzzMutationReadiness(mutation, { file });
}

export function assertFullSurfaceCoverageManifest(manifest, { file = manifest.property } = {}) {
  assert.equal(manifest.schema, 'homeboy-rigs/wordpress-full-surface-coverage/v1', `${file} schema mismatch`);
  assert.equal(typeof manifest.property, 'string', `${file} requires property`);
  assert.notEqual(manifest.property.trim(), '', `${file} requires non-empty property`);
  assert.ok(manifest.coverage_map && typeof manifest.coverage_map === 'object' && !Array.isArray(manifest.coverage_map), `${file} requires coverage_map`);

  const declaredSurfaceTypes = new Set(fullSurfaceCoverageTypes);
  if (!manifest.coverage_map.browser) {
    declaredSurfaceTypes.delete('browser');
  }

  for (const surfaceType of declaredSurfaceTypes) {
    const entry = manifest.coverage_map[surfaceType];
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `${file} coverage_map.${surfaceType} must be an object`);
    assert.equal(entry.surface_type, surfaceType, `${file} coverage_map.${surfaceType}.surface_type mismatch`);
    assert.equal(typeof entry.surface_id, 'string', `${file} coverage_map.${surfaceType}.surface_id must be a string`);
    assert.notEqual(entry.surface_id.trim(), '', `${file} coverage_map.${surfaceType}.surface_id must be non-empty`);
    assert.equal(typeof entry.coverage_goal, 'string', `${file} coverage_map.${surfaceType}.coverage_goal must be a string`);
    assert.notEqual(entry.coverage_goal.trim(), '', `${file} coverage_map.${surfaceType}.coverage_goal must be non-empty`);
    assertStringArray(entry.workload_ids, `${file} coverage_map.${surfaceType}.workload_ids`);
    assertStringArray(entry.artifact_schemas, `${file} coverage_map.${surfaceType}.artifact_schemas`);
  }

  assert.ok(manifest.gap_report && typeof manifest.gap_report === 'object' && !Array.isArray(manifest.gap_report), `${file} requires gap_report`);
  assert.equal(manifest.gap_report.schema, 'homeboy-rigs/wordpress-coverage-gap-report/v1', `${file} gap_report.schema mismatch`);
  assertStringArray(manifest.gap_report.inputs, `${file} gap_report.inputs`);
  assertStringArray(manifest.gap_report.required_fields, `${file} gap_report.required_fields`);
  assert.equal(manifest.gap_report.semantic_key, 'fuzz.report', `${file} gap_report.semantic_key mismatch`);
  assert.ok(manifest.gap_report.compare && typeof manifest.gap_report.compare === 'object' && !Array.isArray(manifest.gap_report.compare), `${file} gap_report.compare must be an object`);

  const requiredFields = new Set(manifest.gap_report.required_fields);
  for (const field of fullSurfaceGapReportFields) {
    assert.ok(requiredFields.has(field), `${file} gap_report.required_fields missing ${field}`);
  }

  for (const surfaceType of declaredSurfaceTypes) {
    assert.equal(typeof manifest.gap_report.compare[surfaceType], 'string', `${file} gap_report.compare.${surfaceType} must be a string`);
    assert.notEqual(manifest.gap_report.compare[surfaceType].trim(), '', `${file} gap_report.compare.${surfaceType} must be non-empty`);
  }
}

function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  for (const entry of value) {
    assert.equal(typeof entry, 'string', `${label} entries must be strings`);
    assert.notEqual(entry.trim(), '', `${label} entries must be non-empty`);
  }
}
