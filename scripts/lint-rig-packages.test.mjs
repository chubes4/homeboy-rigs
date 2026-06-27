import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./lint-rig-packages.mjs', import.meta.url).pathname;
const sharedValidator = new URL('./fixtures/shared-fuzz-validator.cjs', import.meta.url).pathname;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createRigPackage({ rig = {}, fuzzWorkloads = {}, benchWorkloads = {}, benchProfiles = {}, fuzzProfiles = {} } = {}) {
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
    fuzz_profiles: fuzzProfiles,
    ...rig,
  });

  return directory;
}

function createWordPressDevelopFuzzPackage(workload) {
  const directory = mkdtempSync(join(tmpdir(), 'homeboy-rigs-wp-lint-'));
  const fuzzRoot = join(directory, 'WordPress', 'wordpress-develop', 'fuzz');
  const manifestsRoot = join(directory, 'WordPress', 'wordpress-develop', 'manifests');

  mkdirSync(fuzzRoot, { recursive: true });
  mkdirSync(manifestsRoot, { recursive: true });
  writeJson(join(manifestsRoot, 'rest-route-coverage.json'), { schema: 'test' });
  writeJson(join(fuzzRoot, `${workload.id}.json`), workload);

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
  return spawnSync(process.execPath, [script, directory], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR: sharedValidator,
    },
  });
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

test('rejects missing declared fuzz workload files', () => {
  const directory = createRigPackage();
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /declares missing file/);
});

test('rejects committed local Developer checkout paths in rigs', () => {
  const directory = createRigPackage({
    rig: {
      components: {
        product: {
          path: '~/Developer/product',
          branch: 'main',
        },
      },
    },
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });

  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /use portable component path settings instead of committed ~\/Developer or \$HOME\/Developer checkout paths/);
});

test('accepts registry-backed components with portable path settings', () => {
  const directory = createRigPackage({
    rig: {
      components: {
        product: {
          component_id: 'product',
          path_setting: 'HOMEBOY_RIG_COMPONENT_PATH__GENERIC_RIG__PRODUCT',
          default_ref: 'origin/main',
          branch: 'main',
        },
      },
    },
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });

  const result = runLint(directory);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('rejects shared paths where link and target are the same path', () => {
  const directory = createRigPackage({
    rig: {
      shared_paths: [
        {
          link: '${components.product.path}/node_modules',
          target: '${components.product.path}/node_modules',
        },
      ],
    },
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });

  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shared_paths\[0\] link and target must differ unless allow_self_target is true/);
});

test('accepts explicitly allowed shared path self-targets', () => {
  const directory = createRigPackage({
    rig: {
      shared_paths: [
        {
          link: '${components.product.path}/cache',
          target: '${components.product.path}/cache',
          allow_self_target: true,
        },
      ],
    },
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });

  const result = runLint(directory);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('rejects committed local Developer checkout paths in stacks', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });
  const stackRoot = join(directory, 'Vendor', 'product', 'stacks');
  mkdirSync(stackRoot, { recursive: true });
  writeJson(join(stackRoot, 'combined.json'), {
    id: 'combined',
    component: 'product',
    component_path: '$HOME/Developer/product',
  });

  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stacks\/combined\.json: use portable component path settings/);
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

test('rejects fuzz workload safety classes outside the Homeboy contract', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload({ safety_class: 'read_only_inventory' }),
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /safety_class must be one of read_only, idempotent, isolated_mutation, destructive/);
});

test('rejects fuzz case safety classes that drift from the workload', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload({
        safety_class: 'read_only',
        cases: [
          { case_id: 'generic-fuzz:default', metadata: { safety_class: 'isolated_mutation' } },
        ],
      }),
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /case generic-fuzz:default metadata\.safety_class must match workload safety_class read_only/);
});

test('rejects runner-neutral fuzz intent that embeds command phases', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload({
        cases: [
          {
            case_id: 'generic-fuzz:default',
            phases: { action: [{ command: 'wordpress.run-workload' }] },
            artifacts: [{ name: 'generic_report' }],
            intent: {
              schema: 'homeboy/fuzz-workload-intent/v1',
              type: 'wordpress-plugin-workload',
              plugin: { activation: 'generic/generic.php' },
              execute: {
                workload_ref: 'default',
                path: '${package.root}/bench/generic.workload.json',
                type: 'json',
              },
              collect: [{ artifact: 'generic_report' }],
            },
          },
        ],
      }),
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runner-neutral case intent must not embed runner command phases/);
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

test('rejects fuzz profiles that reference undeclared fuzz workloads', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
    fuzzProfiles: {
      smoke: ['generic-fuzz', 'missing-fuzz'],
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fuzz profile smoke references missing-fuzz, but fuzz_workloads does not declare a matching workload file/);
});

test('rejects proven fuzz readiness without proof bundle linkage', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload({
        metadata: {
          kind: 'generic-fuzz',
          readiness: {
            level: 'proven',
            coverage_contract: 'Generic fuzz coverage is proven.',
            proof_refs: ['https://github.com/example/product/issues/123'],
          },
        },
      }),
    },
  });
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /proven readiness requires proof_bundle/);
});

test('accepts package-root scoped lint for rigs and fuzz directories', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });
  const result = runLint(join(directory, 'Vendor', 'product'));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('requires WordPress Core REST fuzz permission proof artifacts', () => {
  const directory = createWordPressDevelopFuzzPackage(fuzzWorkload({
    id: 'rest-api',
    surface_ids: ['wordpress-core-rest-routes'],
    operations: ['rest-route-inventory', 'generated-rest-case-plan'],
    workload: { runner: 'wp-codebox', type: 'declarative', path: '${package.root}/manifests/rest-route-coverage.json' },
    artifacts: { expected: [] },
  }));
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /role-boundary-execution/);
  assert.match(result.stderr, /fuzz\.rest\.permission_boundaries/);
});

test('requires WordPress Core DB attribution proof artifacts', () => {
  const directory = createWordPressDevelopFuzzPackage(fuzzWorkload({
    id: 'db-inventory-query-profile',
    surface_ids: ['wordpress-core-database'],
    operations: ['db-inventory'],
    workload: { runner: 'wp-codebox', type: 'declarative', path: '${package.root}/manifests/rest-route-coverage.json' },
    artifacts: { expected: [] },
  }));
  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wordpress-core-postmeta/);
  assert.match(result.stderr, /rewrite-query-attribution/);
  assert.match(result.stderr, /fuzz\.db\.options_postmeta_rewrite_attribution/);
});

test('requires WordPress Core proof artifacts when linting package root directly', () => {
  const directory = createWordPressDevelopFuzzPackage(fuzzWorkload({
    id: 'rest-api',
    surface_ids: ['wordpress-core-rest-routes'],
    operations: ['rest-route-inventory'],
    workload: { runner: 'wp-codebox', type: 'declarative', path: '${package.root}/manifests/rest-route-coverage.json' },
    artifacts: { expected: [] },
  }));
  const result = runLint(join(directory, 'WordPress', 'wordpress-develop'));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fuzz\/rest-api\.json: rest-api must declare expected artifact semantic key fuzz\.rest\.route_inventory/);
});

test('rejects WordPress Core fuzz workloads outside wordpress-develop', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homeboy-rigs-wp-legacy-lint-'));
  const fuzzRoot = join(directory, 'WordPress', 'wordpress', 'fuzz');

  mkdirSync(fuzzRoot, { recursive: true });
  writeJson(join(fuzzRoot, 'rest-api.json'), fuzzWorkload({
    id: 'rest-api',
    surface_ids: ['wordpress-core-rest-routes'],
    target: { type: 'wordpress-core', component: 'wordpress' },
  }));

  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WordPress Core fuzz workloads must live under WordPress\/wordpress-develop\/fuzz/);
});
