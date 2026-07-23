import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = 'Automattic/jetpack';
const supportedGenericPrimitives = new Set([
  'wordpress.browser-scenario',
  'wordpress.fuzz-admin-pages',
  'wordpress.inventory-database',
  'wordpress.inventory-plugin-module-options-tables',
  'wordpress.rest-route-inventory',
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function resolvePackagePath(workloadPath) {
  return workloadPath.replace('${package.root}', packageRoot);
}

test('every Jetpack full-surface workload resolves to an executable implementation', () => {
  const inventory = readJson(`${packageRoot}/shared/wordpress-plugin/fuzz-inventory.base.json`);
  const workloadPaths = new Map();
  for (const entry of inventory.fuzz_workloads.wordpress) {
    const relativePath = resolvePackagePath(entry.path);
    const workload = readJson(relativePath);
    workloadPaths.set(workload.id, { relativePath, workload });
  }

  const profile = inventory.fuzz_profiles['full-surface'];
  assert.equal(profile.length, 14, 'full-surface profile must retain all 14 workloads');
  assert.equal(new Set(profile).size, profile.length, 'full-surface profile workload ids must be unique');

  for (const workloadId of profile) {
    const resolved = workloadPaths.get(workloadId);
    assert.ok(resolved, `${workloadId} must be listed in the Jetpack workload inventory`);
    const { relativePath, workload } = resolved;
    const executable = workload.workload;
    assert.ok(executable && typeof executable === 'object', `${relativePath} must declare workload`);
    for (const fuzzCase of workload.cases ?? []) {
      const phaseSteps = Object.values(fuzzCase.phases ?? {}).flat();
      assert.ok(
        phaseSteps.every((step) => step.command !== 'wordpress.ensure-external-http-guardrail'),
        `${workloadId} must enforce HTTP isolation through an executable workload or registered recipe command`,
      );
    }

    if (executable.type === 'php') {
      assert.match(executable.path, /^\$\{package\.root\}\/.*\.php$/);
      assert.ok(existsSync(path.join(repoRoot, resolvePackagePath(executable.path))), `${workloadId} PHP workload must exist`);
      continue;
    }

    if (executable.type === 'json') {
      assert.match(executable.path, /^\$\{package\.root\}\/.*\.json$/);
      const jsonPath = resolvePackagePath(executable.path);
      assert.ok(existsSync(path.join(repoRoot, jsonPath)), `${workloadId} JSON workload must exist`);
      const jsonWorkload = readJson(jsonPath);
      assert.ok(Array.isArray(jsonWorkload.run) || Array.isArray(jsonWorkload.steps), `${workloadId} JSON workload must define run or steps`);
      for (const fuzzCase of workload.cases ?? []) {
        assert.equal(fuzzCase.phases, undefined, `${workloadId} JSON case must use runner-neutral intent lowering`);
        assert.equal(fuzzCase.intent?.execute?.path, executable.path, `${workloadId} intent path must match workload path`);
        assert.equal(fuzzCase.intent?.execute?.type, 'json', `${workloadId} intent must hydrate its JSON workload`);
      }
      continue;
    }

    assert.equal(executable.type, 'declarative', `${workloadId} must resolve to PHP, executable JSON, or a declarative primitive`);
    assert.equal(workload.metadata?.generic_primitive?.status, 'supported', `${workloadId} declarative primitive must be explicitly supported`);
    assert.equal(executable.command, workload.metadata.generic_primitive.command, `${workloadId} workload command must match its supported primitive`);
    assert.ok(supportedGenericPrimitives.has(executable.command), `${workloadId} must use a supported WordPress primitive`);
    if (executable.command === 'wordpress.browser-scenario') {
      for (const fuzzCase of workload.cases ?? []) {
        assert.equal(fuzzCase.phases, undefined, `${workloadId} browser case must use runner-neutral intent lowering`);
        assert.ok(fuzzCase.intent?.execute?.parameters?.['scenario-json'], `${workloadId} browser case must provide scenario-json parameters`);
      }
    }
  }
});
