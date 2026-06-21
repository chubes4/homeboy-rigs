import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./lint-rig-packages.mjs', import.meta.url).pathname;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createRigPackage({ rig = {}, fuzzWorkloads = {}, benchWorkloads = {}, benchProfiles = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'homeboy-rigs-lint-'));
  const packageRoot = join(directory, 'Vendor', 'product');
  const rigRoot = join(packageRoot, 'rigs', 'generic-rig');
  const fuzzRoot = join(packageRoot, 'fuzz');
  const benchRoot = join(packageRoot, 'bench');

  mkdirSync(rigRoot, { recursive: true });
  mkdirSync(fuzzRoot, { recursive: true });
  mkdirSync(benchRoot, { recursive: true });
  writeJson(join(benchRoot, 'generic.workload.json'), { id: 'generic' });

  for (const [name, workload] of Object.entries(fuzzWorkloads)) {
    writeJson(join(fuzzRoot, `${name}.json`), workload);
  }

  writeJson(join(rigRoot, 'rig.json'), {
    id: 'generic-rig',
    description: 'Generic lint fixture rig.',
    fuzz_workloads: {
      generic: [
        { path: '${package.root}/fuzz/generic-fuzz.json' },
      ],
    },
    bench_workloads: benchWorkloads,
    bench_profiles: benchProfiles,
    ...rig,
  });

  return directory;
}

function fuzzWorkload(overrides = {}) {
  return {
    schema: 'homeboy/fuzz-workload/v1',
    id: 'generic-fuzz',
    label: 'Generic fuzz workload',
    safety_class: 'read_only',
    surface_ids: ['generic-surface'],
    operations: ['generic-operation'],
    metadata: { kind: 'generic-fuzz' },
    target: { type: 'generic' },
    workload: {
      runner: 'generic',
      type: 'json',
      path: '${package.root}/bench/generic.workload.json',
    },
    cases: [
      { case_id: 'generic-fuzz:default' },
    ],
    ...overrides,
  };
}

function runLint(directory) {
  return spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
}

test('accepts generic declared fuzz workloads', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });

  const result = runLint(directory);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('accepts package root linting from a direct package directory', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });

  const result = runLint(join(directory, 'Vendor', 'product'));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('rejects missing declared fuzz workload files', () => {
  const directory = createRigPackage();
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /declares missing file/);
});

test('rejects invalid declared fuzz workload shapes', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload({ schema: 'wrong', label: '' }),
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use schema homeboy\/fuzz-workload\/v1/);
  assert.match(result.stderr, /must declare a non-empty string label/);
});

test('rejects missing fuzz workload backing files', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload({
        workload: {
          runner: 'generic',
          type: 'json',
          path: '${package.root}/bench/missing.workload.json',
        },
      }),
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workload path .*missing\.workload\.json does not exist/);
});

test('rejects duplicate declared fuzz workload ids per rig', () => {
  const directory = createRigPackage({
    rig: {
      fuzz_workloads: {
        generic: [
          { path: '${package.root}/fuzz/generic-fuzz.json' },
          { path: '${package.root}/fuzz/generic-fuzz-copy.json' },
        ],
      },
    },
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
      'generic-fuzz-copy': fuzzWorkload(),
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fuzz workload id generic-fuzz is declared more than once in this rig/);
});

test('rejects fuzz ids in bench workloads and profiles', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
    benchWorkloads: {
      generic: [
        { path: '${package.root}/bench/generic-fuzz.php' },
      ],
    },
    benchProfiles: {
      smoke: ['generic-fuzz'],
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bench_workloads declares generic-fuzz, but that id belongs to a fuzz workload/);
  assert.match(result.stderr, /bench profile smoke references generic-fuzz, but that id belongs to a fuzz workload/);
});
