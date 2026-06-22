import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const fuzzReadinessLevels = new Set(['declared', 'executable', 'proven']);
export const fuzzCrudOperations = new Set(['create', 'read', 'update', 'delete']);

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
  assert.ok(Array.isArray(runnerCase.phases?.action), `${manifest.id} requires action phase`);
  assert.ok(runnerCase.phases.action.length > 0, `${manifest.id} requires at least one action step`);
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

export function assertFuzzReadinessMetadata(manifest, { file = manifest.id } = {}) {
  const readiness = manifest.metadata?.readiness;
  assert.ok(readiness && typeof readiness === 'object' && !Array.isArray(readiness), `${file} requires metadata.readiness`);

  assert.ok(fuzzReadinessLevels.has(readiness.level), `${file} metadata.readiness.level must be declared, executable, or proven`);
  assert.equal(typeof readiness.coverage_contract, 'string', `${file} metadata.readiness.coverage_contract must describe the declared contract`);
  assert.notEqual(readiness.coverage_contract.trim(), '', `${file} metadata.readiness.coverage_contract must describe the declared contract`);

  if (readiness.level === 'proven') {
    assert.ok(Array.isArray(readiness.proof_refs) && readiness.proof_refs.length > 0, `${file} proven readiness requires proof_refs`);
  }

  if (readiness.upstream_blockers !== undefined) {
    assert.ok(Array.isArray(readiness.upstream_blockers), `${file} metadata.readiness.upstream_blockers must be an array`);
    for (const blocker of readiness.upstream_blockers) {
      assert.equal(typeof blocker, 'string', `${file} metadata.readiness.upstream_blockers entries must be strings`);
      assert.notEqual(blocker.trim(), '', `${file} metadata.readiness.upstream_blockers entries must be non-empty`);
    }
  }

  if (readiness.crud !== undefined) {
    assertFuzzCrudReadiness(readiness.crud, { file });
  }

  if (readiness.mutation !== undefined) {
    assertFuzzMutationReadiness(readiness.mutation, { file });
  }
}

export function assertFuzzCrudReadiness(crud, { file } = {}) {
  assert.ok(crud && typeof crud === 'object' && !Array.isArray(crud), `${file} metadata.readiness.crud must be an object`);

  for (const operation of fuzzCrudOperations) {
    assert.ok(crud[operation] && typeof crud[operation] === 'object' && !Array.isArray(crud[operation]), `${file} metadata.readiness.crud.${operation} must be an object`);
    assert.ok(fuzzReadinessLevels.has(crud[operation].level), `${file} metadata.readiness.crud.${operation}.level must be declared, executable, or proven`);

    if (crud[operation].upstream_blocker !== undefined) {
      assert.equal(typeof crud[operation].upstream_blocker, 'string', `${file} metadata.readiness.crud.${operation}.upstream_blocker must be a string`);
      assert.notEqual(crud[operation].upstream_blocker.trim(), '', `${file} metadata.readiness.crud.${operation}.upstream_blocker must be non-empty`);
    }
  }
}

export function assertFuzzMutationReadiness(mutation, { file } = {}) {
  assert.ok(mutation && typeof mutation === 'object' && !Array.isArray(mutation), `${file} metadata.readiness.mutation must be an object`);
  assert.equal(typeof mutation.safety_boundary, 'string', `${file} metadata.readiness.mutation.safety_boundary must describe rollback/isolation boundaries`);
  assert.notEqual(mutation.safety_boundary.trim(), '', `${file} metadata.readiness.mutation.safety_boundary must describe rollback/isolation boundaries`);

  assert.ok(Array.isArray(mutation.rollback_artifacts), `${file} metadata.readiness.mutation.rollback_artifacts must be an array`);
  for (const artifact of mutation.rollback_artifacts) {
    assert.equal(typeof artifact, 'string', `${file} metadata.readiness.mutation.rollback_artifacts entries must be strings`);
    assert.notEqual(artifact.trim(), '', `${file} metadata.readiness.mutation.rollback_artifacts entries must be non-empty`);
  }
}
