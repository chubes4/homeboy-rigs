import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const toolPath = fileURLToPath(new URL('./aggressive-firehose-command-plan.mjs', import.meta.url));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function runTool(args, options = {}) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    ...options,
  });
}

function readPlan(args = []) {
  const result = runTool(['--json', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('command plan writes isolation proof before destructive fuzz run commands', () => {
  const plan = readPlan(['--artifact-root', '/tmp/woo-firehose-artifacts']);
  const writeIndex = plan.plan_items.findIndex((item) => item.purpose === 'write_homeboy_isolation_proof');
  const firstRunIndex = plan.plan_items.findIndex((item) => item.purpose.startsWith('request_aggressive_isolated_firehose:'));

  assert.ok(writeIndex > -1, 'plan must include isolation proof preflight command');
  assert.ok(firstRunIndex > -1, 'plan must include fuzz run commands');
  assert.ok(writeIndex < firstRunIndex, 'isolation proof must be generated before fuzz runs');
  assert.deepEqual(plan.plan_items[writeIndex].command_argv, [
    'node',
    'tools/aggressive-firehose-command-plan.mjs',
    '--write-isolation-proof',
    '/tmp/woo-firehose-artifacts/isolation-proof/homeboy-isolation-proof.json',
  ]);
});

test('generated fuzz run commands pass the isolation proof artifact to the runner', () => {
  const plan = readPlan(['--artifact-root', '/tmp/woo-firehose-artifacts']);
  const fuzzRunItems = plan.plan_items.filter((item) => item.purpose.startsWith('request_aggressive_isolated_firehose:'));

  assert.ok(fuzzRunItems.length > 0, 'expected at least one fuzz run command');
  for (const item of fuzzRunItems) {
    assert.deepEqual(item.command_argv.slice(0, 3), ['homeboy', 'fuzz', 'plan']);
    assert.ok(item.command_argv.includes('--path'), `${item.purpose} must pass an explicit component path`);
    const isolationProofIndex = item.command_argv.indexOf('--isolation-proof');
    assert.ok(isolationProofIndex > -1, `${item.purpose} must include --isolation-proof`);
    assert.equal(
      item.command_argv[isolationProofIndex + 1],
      '/tmp/woo-firehose-artifacts/isolation-proof/homeboy-isolation-proof.json'
    );
  }
});

test('generated workload requests delegate to core homeboy fuzz plan', () => {
  const plan = readPlan(['--artifact-root', '/tmp/woo-firehose-artifacts']);
  const fuzzRunItems = plan.plan_items.filter((item) => item.purpose.startsWith('request_aggressive_isolated_firehose:'));

  assert.equal(plan.core_planner.help_validated, true);
  assert.deepEqual(plan.core_planner.command, ['homeboy', 'fuzz', 'plan']);
  assert.ok(plan.core_planner.required_flags.includes('--require-result-envelope'));

  for (const item of fuzzRunItems) {
    assert.ok(item.command_argv.includes('--require-case-log'), `${item.purpose} must require case logs`);
    assert.ok(item.command_argv.includes('--require-coverage-summary'), `${item.purpose} must require coverage summary`);
    assert.ok(
      item.command_argv.includes('fuzz.campaign_manifest=manifests/aggressive-isolated-fuzz-campaign.json'),
      `${item.purpose} must pass the campaign manifest to the core planner`
    );
    assert.ok(item.command_argv.includes('--hbex-aggressive-isolated-mode'), `${item.purpose} must preserve HBEX extension args`);
  }
});

test('isolation proof writer emits the homeboy isolation proof contract', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'woo-firehose-proof-'));
  const proofPath = path.join(root, 'homeboy-isolation-proof.json');
  const result = runTool(['--write-isolation-proof', proofPath]);

  assert.equal(result.status, 0, result.stderr);

  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  assert.equal(proof.schema, 'homeboy/isolation-proof/v1');
  assert.equal(proof.runtime_kind, 'ephemeral-runner');
  assert.equal(proof.disposable, true);
  assert.equal(proof.teardown_required, true);
  assert.equal(proof.mutation_boundary, 'offloaded-homeboy-lab-wp-codebox-disposable-sandbox');
  assert.ok(proof.proof_artifacts.length > 0);
  assert.equal(proof.destructive_execution.boundary, 'offloaded_homeboy_lab_wp_codebox_disposable_sandbox');
  assert.equal(proof.disposable_boundary.lab_runner_required, true);
  assert.equal(proof.disposable_boundary.wp_codebox_sandbox_required, true);
  assert.equal(proof.disposable_boundary.host_wordpress_mutation_allowed, false);
  assert.equal(proof.evidence_semantics.runner_receives_artifact_with_flag, '--isolation-proof');
});

test('reviewer artifact ref collection does not emit unsupported Homeboy flags', () => {
  const plan = readPlan(['--artifact-root', '/tmp/woo-firehose-artifacts']);
  const refsItem = plan.plan_items.find((item) => item.purpose === 'collect_reviewer_facing_artifact_refs');

  assert.ok(refsItem, 'plan must include reviewer artifact ref collection');
  assert.deepEqual(refsItem.command_argv.slice(0, 3), ['homeboy', 'runs', 'refs']);
  assert.equal(refsItem.command_argv.includes('--tracker-ref'), false);
});
