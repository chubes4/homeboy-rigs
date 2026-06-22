import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
