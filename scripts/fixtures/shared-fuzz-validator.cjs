'use strict';

const readinessLevels = new Set(['declared', 'executable', 'proven']);
const safetyClasses = new Set(['read_only', 'idempotent', 'isolated_mutation', 'destructive']);

function collectGenericFuzzWorkloadIssues(manifest, { context = manifest?.id || 'fuzz workload' } = {}) {
  const issues = [];
  if (manifest.schema !== 'homeboy/fuzz-workload/v1') {
    issues.push(`${context} must use schema homeboy/fuzz-workload/v1`);
  }
  for (const field of ['id', 'label', 'safety_class']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      issues.push(`${context} must declare a non-empty string ${field}`);
    }
  }
  if (typeof manifest.safety_class === 'string' && !safetyClasses.has(manifest.safety_class)) {
    issues.push(`${context} safety_class must be one of read_only, idempotent, isolated_mutation, destructive`);
  }
  if (!manifest.metadata || typeof manifest.metadata !== 'object' || Array.isArray(manifest.metadata)) {
    issues.push(`${context} must declare metadata`);
  }
  if (!manifest.target || typeof manifest.target !== 'object' || Array.isArray(manifest.target)) {
    issues.push(`${context} must declare target`);
  }
  if (!manifest.workload || typeof manifest.workload !== 'object' || Array.isArray(manifest.workload)) {
    issues.push(`${context} must declare workload`);
  } else if (typeof manifest.workload.path !== 'string' || manifest.workload.path.trim() === '') {
    issues.push(`${context} workload must declare a non-empty string path`);
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    issues.push(`${context} must declare at least one case`);
  } else {
    for (const runnerCase of manifest.cases) {
      if (runnerCase?.metadata?.safety_class && runnerCase.metadata.safety_class !== manifest.safety_class) {
        issues.push(`${context} case ${runnerCase.case_id || '(unknown)'} metadata.safety_class must match workload safety_class ${manifest.safety_class}`);
      }
      if (runnerCase?.intent) {
        try {
          assertRunnerNeutralFuzzCaseIntent(manifest, runnerCase);
        } catch (error) {
          issues.push(`${context} ${error.message}`);
        }
      }
    }
  }
  return issues;
}

function assertRunnerNeutralFuzzCaseIntent(manifest, runnerCase) {
  const intent = runnerCase.intent;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new Error(`${manifest.id} case intent must be an object`);
  }
  if (intent.schema !== 'homeboy/fuzz-workload-intent/v1') {
    throw new Error(`${manifest.id} case intent schema mismatch`);
  }
  if (intent.type !== 'wordpress-plugin-workload') {
    throw new Error(`${manifest.id} case intent type mismatch`);
  }
  if (!intent.plugin || typeof intent.plugin !== 'object' || Array.isArray(intent.plugin)) {
    throw new Error(`${manifest.id} case intent requires plugin`);
  }
  if (typeof intent.plugin.activation !== 'string') {
    throw new Error(`${manifest.id} case intent plugin.activation must be a string`);
  }
  if (!intent.execute || typeof intent.execute !== 'object' || Array.isArray(intent.execute)) {
    throw new Error(`${manifest.id} case intent requires execute`);
  }
  if (intent.execute.workload_ref !== 'default') {
    throw new Error(`${manifest.id} case intent execute.workload_ref must be default`);
  }
  if (intent.execute.path !== manifest.workload?.path) {
    throw new Error(`${manifest.id} case intent execute.path must match workload.path`);
  }
  if (intent.execute.type !== manifest.workload?.type) {
    throw new Error(`${manifest.id} case intent execute.type must match workload.type`);
  }
  if (!Array.isArray(intent.collect) || intent.collect.length === 0) {
    throw new Error(`${manifest.id} case intent collect must declare at least one artifact`);
  }
  const artifactNames = new Set((runnerCase.artifacts || []).map((artifact) => artifact?.name).filter(Boolean));
  for (const artifact of intent.collect) {
    if (!artifactNames.has(artifact.artifact)) {
      throw new Error(`${manifest.id} case intent collect artifact ${artifact.artifact} is not declared on the case`);
    }
  }
  if (runnerCase.phases !== undefined) {
    throw new Error(`${manifest.id} runner-neutral case intent must not embed runner command phases`);
  }
  return intent;
}

function assertFuzzReadinessMetadata(manifest, { file = manifest.id } = {}) {
  const readiness = manifest.metadata?.readiness;
  if (!readiness || typeof readiness !== 'object' || Array.isArray(readiness)) {
    throw new Error(`${file} requires metadata.readiness`);
  }
  assertFuzzReadinessLevel(readiness.level, `${file} metadata.readiness.level`);
  if (typeof readiness.coverage_contract !== 'string' || readiness.coverage_contract.trim() === '') {
    throw new Error(`${file} metadata.readiness.coverage_contract must describe the declared contract`);
  }
  if (readiness.proof_refs !== undefined) {
    assertStringArray(readiness.proof_refs, `${file} metadata.readiness.proof_refs`);
    for (const proofRef of readiness.proof_refs) {
      assertReviewerFacingRef(proofRef, `${file} metadata.readiness.proof_refs`);
    }
  }
  if (readiness.level === 'proven') {
    if (!Array.isArray(readiness.proof_refs) || readiness.proof_refs.length === 0) {
      throw new Error(`${file} proven readiness requires proof_refs`);
    }
    assertFuzzProofBundle(readiness.proof_bundle, manifest, { file });
  }
  if (readiness.crud !== undefined) {
    assertFuzzCrudReadiness(readiness.crud, { file });
  }
  if (readiness.mutation !== undefined) {
    assertFuzzMutationReadiness(readiness.mutation, { file });
  }
  return readiness;
}

function assertFuzzProofBundle(proofBundle, manifest, { file = manifest.id } = {}) {
  if (!proofBundle || typeof proofBundle !== 'object' || Array.isArray(proofBundle)) {
    throw new Error(`${file} proven readiness requires proof_bundle`);
  }
  for (const field of ['artifact_refs', 'run_ids', 'gap_reports', 'fuzz_result_artifacts']) {
    assertStringArray(proofBundle[field], `${file} metadata.readiness.proof_bundle.${field}`);
  }
  const requiredArtifactNames = new Set([
    ...(manifest.cases || []).flatMap((runnerCase) => runnerCase.artifacts || []),
    ...(manifest.artifacts?.expected || []),
  ].filter((artifact) => artifact?.required === true).map((artifact) => artifact.name));
  for (const artifactName of proofBundle.fuzz_result_artifacts) {
    if (!requiredArtifactNames.has(artifactName)) {
      throw new Error(`${file} proof_bundle.fuzz_result_artifacts ${artifactName} must name a required case or expected artifact`);
    }
  }
  if (proofBundle.canonical_fuzz_envelope_ref !== undefined) {
    assertReviewerFacingArtifactRef(proofBundle.canonical_fuzz_envelope_ref, `${file} metadata.readiness.proof_bundle.canonical_fuzz_envelope_ref`);
  }
}

function assertFuzzCrudReadiness(crud, { file } = {}) {
  for (const operation of ['create', 'read', 'update', 'delete']) {
    assertFuzzReadinessLevel(crud?.[operation]?.level, `${file} metadata.readiness.crud.${operation}.level`);
  }
}

function assertFuzzMutationReadiness(mutation, { file } = {}) {
  if (typeof mutation?.safety_boundary !== 'string' || mutation.safety_boundary.trim() === '') {
    throw new Error(`${file} metadata.readiness.mutation.safety_boundary must describe rollback/isolation boundaries`);
  }
  assertStringArray(mutation.rollback_artifacts, `${file} metadata.readiness.mutation.rollback_artifacts`, { allowEmpty: true });
}

function assertFuzzProofBundleRequirements(requirements, { file } = {}) {
  assertStringArray(requirements?.required_refs, `${file} metadata.readiness.proof_bundle_requirements.required_refs`);
  assertStringArray(requirements?.required_artifacts, `${file} metadata.readiness.proof_bundle_requirements.required_artifacts`);
}

function assertFuzzReadinessLevel(level, label) {
  if (!readinessLevels.has(level)) {
    throw new Error(`${label} must be declared, executable, or proven`);
  }
}

function assertReviewerFacingRef(value, context) {
  if (!/^(https:\/\/|gh:|homeboy-runs:|homeboy:\/\/run\/|artifact:|run:)/.test(value)) {
    throw new Error(`${context} entries must be reviewer-facing refs`);
  }
  if (localOnlyReviewerFacingRef(value)) {
    throw new Error(`${context} entries must not use local evidence`);
  }
}

function assertReviewerFacingArtifactRef(value, context) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} must be a reviewer-facing artifact ref string`);
  }
  if (!/^(https:\/\/|gh:|homeboy-runs:|homeboy:\/\/run\/|homeboy-artifact:\/\/|artifact:|run:)/.test(value)) {
    throw new Error(`${context} must be a reviewer-facing artifact ref`);
  }
  if (localOnlyReviewerFacingRef(value)) {
    throw new Error(`${context} must not use local evidence`);
  }
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

function assertStringArray(value, label, options = {}) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${label} must be a non-empty string array`);
  }
}

module.exports = {
  assertFuzzCrudReadiness,
  assertFuzzMutationReadiness,
  assertFuzzProofBundle,
  assertFuzzProofBundleRequirements,
  assertFuzzReadinessLevel,
  assertFuzzReadinessMetadata,
  assertReviewerFacingRef,
  assertRunnerNeutralFuzzCaseIntent,
  collectGenericFuzzWorkloadIssues,
};
