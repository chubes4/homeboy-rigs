import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(packageRoot, 'fuzz/tb-backend-api-fuzz.json');
const runnerPath = path.join(packageRoot, 'fuzz/api-fuzz-runner.mjs');
const rigPath = path.join(packageRoot, 'rigs/tb-backend-api-fuzz/rig.json');

test('TrickBook API fuzz workload is wired through its owning rig', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const rig = JSON.parse(fs.readFileSync(rigPath, 'utf8'));
  const runner = fs.readFileSync(runnerPath, 'utf8');

  assert.equal(manifest.schema, 'homeboy/fuzz-workload/v1');
  assert.equal(manifest.id, 'tb-backend-api-fuzz');
  assert.equal(manifest.safety_class, 'isolated_mutation');
  assert.equal(manifest.case_budget, 21);
  assert.equal(manifest.metadata.tracker, 'github:wbaxterh/TB-Backend');
  assert.deepEqual(rig.fuzz_profiles.isolated, [manifest.id]);
  assert.match(rig.fuzz_workloads.nodejs[0].path, /tb-backend-api-fuzz\.json$/);
  assert.equal(rig.fuzz.default_component, 'tb-backend');
  assert.match(runner, /newsletter\.stats-unauth/);
  assert.match(runner, /listings\.userId-operator/);
  assert.doesNotMatch(runner, /contact\.unauth/);
});
