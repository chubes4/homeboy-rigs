import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { emitStableWorkloadLabCommands } from './stable-workload-lab-command-planner.mjs';

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createPackage() {
  const root = mkdtempSync(path.join(tmpdir(), 'homeboy-rigs-stable-plan-'));
  const packageRoot = path.join(root, 'Vendor', 'product');
  const toolsRoot = path.join(packageRoot, 'tools');
  const manifestRoot = path.join(packageRoot, 'manifests');
  mkdirSync(toolsRoot, { recursive: true });
  mkdirSync(manifestRoot, { recursive: true });
  writeFileSync(path.join(toolsRoot, 'stable-workload-lab-commands.mjs'), '');
  writeJson(path.join(manifestRoot, 'stable-workloads.json'), {
    profile_id: 'stable-profile',
    contracts: [
      {
        id: 'stable-contract',
        entry_workloads: ['stable-workload'],
      },
    ],
  });
  return { moduleUrl: pathToFileURL(path.join(toolsRoot, 'stable-workload-lab-commands.mjs')).href };
}

function createHomeboyWithoutStablePlan() {
  const root = mkdtempSync(path.join(tmpdir(), 'homeboy-rigs-homeboy-'));
  const bin = path.join(root, 'homeboy');
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'fuzz help stable-plan') {
  console.error("error: unrecognized subcommand 'stable-plan'");
  process.exit(2);
}
console.error('unexpected homeboy call');
process.exit(64);
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('prefer-core-planner falls back to rig-local migration planner when core command is unavailable', () => {
  const previousHomeboyBin = process.env.HOMEBOY_BIN;
  process.env.HOMEBOY_BIN = createHomeboyWithoutStablePlan();
  const writes = [];

  try {
    emitStableWorkloadLabCommands({
      ...createPackage(),
      productLabel: 'Product',
      component: 'product',
      rigId: 'product-rig',
      schema: 'homeboy-rigs/product-stable-lab-command-plan/v1',
      defaultRunIdPrefix: 'product-stable',
    }, ['--prefer-core-planner', '--json', '--run-id-prefix', 'stable-proof'], {
      write: (value) => writes.push(value),
    });
  } finally {
    if (previousHomeboyBin === undefined) {
      delete process.env.HOMEBOY_BIN;
    } else {
      process.env.HOMEBOY_BIN = previousHomeboyBin;
    }
  }

  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.planner, 'homeboy-rigs-local-compat');
  assert.equal(payload.migration_target, 'homeboy fuzz stable-plan');
  assert.deepEqual(payload.run_commands[0].command.slice(0, 4), ['homeboy', 'fuzz', 'run', '--lab-only']);
});
