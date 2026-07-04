import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveTestHomeboyWordPressHelperManifest } from './test-homeboy-wordpress-helper-manifest.mjs';

const script = new URL('./lint-rig-packages.mjs', import.meta.url).pathname;
const wordpressHelperManifest = resolveTestHomeboyWordPressHelperManifest();
const wordpressCoreFuzzValidatorModule = new URL('../WordPress/wordpress-develop/tools/fuzz-workload-validator.mjs', import.meta.url).href;
const wordpressCoreFuzzValidatorSource = `export { validateFuzzWorkload } from ${JSON.stringify(wordpressCoreFuzzValidatorModule)};\n`;

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFakeHomeboyBin(directory) {
  const bin = join(directory, 'fake-homeboy.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const [command, subcommand, first, second, third] = process.argv.slice(2);
if (command === 'contract' && subcommand === 'normalize' && first === 'artifact-ref' && second === '--input') {
  const value = JSON.parse(third);
  if (typeof value === 'string' && /^homeboy:\\/\\//.test(value)) {
    console.log(JSON.stringify({ success: true, data: { normalized: value } }));
    process.exit(0);
  }
  console.log(JSON.stringify({ success: false, error: { message: "Invalid argument 'artifact-ref'" } }));
  process.exit(1);
}

if (command !== 'contract' || subcommand !== 'validate') {
  console.error(\`unexpected homeboy args: ${'${process.argv.slice(2).join(" ")}'}\`);
  process.exit(64);
}

const isFuzzWorkload = first === '--file' && third === 'homeboy/fuzz-workload/v1';
const file = second;
const schema = third;

if (!isFuzzWorkload) {
  console.error(\`unexpected homeboy args: ${'${process.argv.slice(2).join(" ")}'}\`);
  process.exit(64);
}

const payload = JSON.parse(readFileSync(file, 'utf8'));

const workload = payload;
if (workload.schema !== 'homeboy/fuzz-workload/v1') {
  console.error('must use schema homeboy/fuzz-workload/v1');
  process.exit(1);
}

console.log(JSON.stringify({ success: true, data: { file, schema, valid: true } }));
`);
  chmodSync(bin, 0o755);
  return bin;
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
  const toolsRoot = join(directory, 'WordPress', 'wordpress-develop', 'tools');

  mkdirSync(fuzzRoot, { recursive: true });
  mkdirSync(manifestsRoot, { recursive: true });
  mkdirSync(toolsRoot, { recursive: true });
  writeJson(join(manifestsRoot, 'rest-route-coverage.json'), { schema: 'test' });
  writeJson(join(fuzzRoot, `${workload.id}.json`), workload);
  writeFileSync(join(toolsRoot, 'fuzz-workload-validator.mjs'), wordpressCoreFuzzValidatorSource);

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

function runLint(directory, env = {}) {
  return spawnSync(process.execPath, [script, directory], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOMEBOY_BIN: writeFakeHomeboyBin(directory),
      HOMEBOY_WORDPRESS_HELPER_MANIFEST: wordpressHelperManifest,
      ...env,
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

const cleanupPolicyCases = [
  {
    name: 'rejects rigs with resources, empty down lifecycle, and no cleanup policy',
    expectedStatus: 'fail',
    rig: {
      resources: { ports: [8080] },
      pipeline: { down: [] },
    },
    patterns: [/declared resources and empty or missing pipeline\.down must declare lifecycle\.cleanup intent/],
  },
  {
    name: 'rejects rigs with resources, missing down lifecycle, and no cleanup policy',
    expectedStatus: 'fail',
    rig: {
      resources: { ports: [8080] },
      pipeline: {
        up: [{ kind: 'check', label: 'generic check', command: 'true' }],
      },
    },
    patterns: [/declared resources and empty or missing pipeline\.down must declare lifecycle\.cleanup intent/],
  },
  {
    name: 'rejects inherited resources with missing down lifecycle and no cleanup policy',
    expectedStatus: 'fail',
    inherited: {
      resources: { paths: ['${components.product.path}'] },
      pipeline: {
        up: [{ kind: 'check', label: 'generic check', command: 'true' }],
      },
    },
    patterns: [/declared resources and empty or missing pipeline\.down must declare lifecycle\.cleanup intent/],
  },
  {
    name: 'accepts inherited cleanup policy for inherited resources with missing down lifecycle',
    expectedStatus: 'pass',
    inherited: {
      lifecycle: {
        cleanup: {
          intent: 'manual',
          reason: 'The inherited rig resources are user-owned checkout state.',
        },
      },
      resources: { paths: ['${components.product.path}'] },
      pipeline: {
        up: [{ kind: 'check', label: 'generic check', command: 'true' }],
      },
    },
  },
  {
    name: 'accepts explicit cleanup policy for rigs with resources and empty down lifecycle',
    expectedStatus: 'pass',
    rig: {
      lifecycle: {
        cleanup: {
          intent: 'external',
          reason: 'The runner owns the declared resource boundary.',
        },
      },
      resources: { exclusive: ['generic:${env.HOMEBOY_SETTINGS_GENERIC_NAMESPACE}'] },
      pipeline: { down: [] },
    },
    absentPatterns: [/declared resources and empty or missing pipeline\.down/],
  },
  {
    name: 'validates cleanup policy metadata without runtime cleanup proof',
    expectedStatus: 'fail',
    rig: {
      lifecycle: { cleanup: { intent: 'external', reason: '   ' } },
    },
    patterns: [/lifecycle\.cleanup\.reason must explain the cleanup boundary/],
  },
  {
    name: 'rejects invalid explicit cleanup policy',
    expectedStatus: 'fail',
    rig: {
      lifecycle: { cleanup: { intent: 'implicit' } },
    },
    patterns: [
      /lifecycle\.cleanup\.intent must be one of none, external, manual, pipeline/,
      /lifecycle\.cleanup\.reason must explain the cleanup boundary/,
    ],
  },
];

for (const cleanupCase of cleanupPolicyCases) {
  test(cleanupCase.name, () => {
    const directory = createRigPackage({
      rig: cleanupCase.inherited ? {} : cleanupCase.rig,
      fuzzWorkloads: { 'generic-fuzz': fuzzWorkload() },
    });

    if (cleanupCase.inherited) {
      const packageRoot = join(directory, 'Vendor', 'product');
      writeJson(join(packageRoot, 'rigs', 'base.json'), cleanupCase.inherited);
      writeJson(join(packageRoot, 'rigs', 'generic-rig', 'rig.json'), {
        extends: '../base.json',
        id: 'generic-rig',
        description: 'Generic lint fixture rig.',
        fuzz_workloads: {
          generic: [{ path: '${package.root}/fuzz/generic-fuzz.json' }],
        },
      });
    }

    const result = runLint(directory);

    if (cleanupCase.expectedStatus === 'pass') {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } else {
      assert.notEqual(result.status, 0);
    }
    for (const pattern of cleanupCase.patterns || []) {
      assert.match(result.stderr, pattern);
    }
    for (const pattern of cleanupCase.absentPatterns || []) {
      assert.doesNotMatch(result.stderr, pattern);
    }
  });
}

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

test('accepts package-root scoped lint for rigs and fuzz directories', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });
  const result = runLint(join(directory, 'Vendor', 'product'));

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('discovers product fuzz workload validators without central product branches', () => {
  const directory = createRigPackage({
    fuzzWorkloads: {
      'generic-fuzz': fuzzWorkload(),
    },
  });
  const toolsRoot = join(directory, 'Vendor', 'product', 'tools');
  mkdirSync(toolsRoot, { recursive: true });
  writeFileSync(join(toolsRoot, 'fuzz-workload-validator.mjs'), `
export function validateFuzzWorkload({ rel, workload }) {
  return workload.id === 'generic-fuzz' ? [\`${'${rel}'}: product-local validator ran\`] : [];
}
`);

  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /product-local validator ran/);
});

test('discovers product portable source validators without central product branches', () => {
  const directory = createRigPackage();
  const packageRoot = join(directory, 'Vendor', 'product');
  const toolsRoot = join(packageRoot, 'tools');
  mkdirSync(toolsRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'bench', 'portable-source.mjs'), 'const productLocalMarker = true;\n');
  writeFileSync(join(toolsRoot, 'portable-source-validator.mjs'), `
export function validatePortableSource({ rel, contents }) {
  return contents.includes('productLocalMarker') ? [\`${'${rel}'}: product-local portable source validator ran\`] : [];
}
`);

  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /product-local portable source validator ran/);
});

const wordpressCoreProofArtifactCases = [
  {
    name: 'requires WordPress Core REST fuzz permission proof artifacts',
    lintPackageRoot: false,
    workload: fuzzWorkload({
      id: 'rest-api',
      surface_ids: ['wordpress-core-rest-routes'],
      operations: ['rest-route-inventory', 'generated-rest-case-plan'],
      workload: { runner: 'wp-codebox', type: 'declarative', path: '${package.root}/manifests/rest-route-coverage.json' },
      artifacts: { expected: [] },
    }),
    patterns: [/role-boundary-execution/, /fuzz\.rest\.permission_boundaries/],
  },
  {
    name: 'requires WordPress Core DB attribution proof artifacts',
    lintPackageRoot: false,
    workload: fuzzWorkload({
      id: 'db-inventory-query-profile',
      surface_ids: ['wordpress-core-database'],
      operations: ['db-inventory'],
      workload: { runner: 'wp-codebox', type: 'declarative', path: '${package.root}/manifests/rest-route-coverage.json' },
      artifacts: { expected: [] },
    }),
    patterns: [/wordpress-core-postmeta/, /rewrite-query-attribution/, /fuzz\.db\.options_postmeta_rewrite_attribution/],
  },
  {
    name: 'requires WordPress Core proof artifacts when linting package root directly',
    lintPackageRoot: true,
    workload: fuzzWorkload({
      id: 'rest-api',
      surface_ids: ['wordpress-core-rest-routes'],
      operations: ['rest-route-inventory'],
      workload: { runner: 'wp-codebox', type: 'declarative', path: '${package.root}/manifests/rest-route-coverage.json' },
      artifacts: { expected: [] },
    }),
    patterns: [/fuzz\/rest-api\.json: rest-api must declare expected artifact semantic key fuzz\.rest\.route_inventory/],
  },
];

for (const proofCase of wordpressCoreProofArtifactCases) {
  test(proofCase.name, () => {
    const directory = createWordPressDevelopFuzzPackage(proofCase.workload);
    const lintTarget = proofCase.lintPackageRoot ? join(directory, 'WordPress', 'wordpress-develop') : directory;
    const result = runLint(lintTarget);

    assert.notEqual(result.status, 0);
    for (const pattern of proofCase.patterns) {
      assert.match(result.stderr, pattern);
    }
  });
}

test('rejects WordPress Core fuzz workloads outside wordpress-develop', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homeboy-rigs-wp-legacy-lint-'));
  const fuzzRoot = join(directory, 'WordPress', 'wordpress', 'fuzz');
  const toolsRoot = join(directory, 'WordPress', 'wordpress-develop', 'tools');

  mkdirSync(fuzzRoot, { recursive: true });
  mkdirSync(toolsRoot, { recursive: true });
  writeFileSync(join(toolsRoot, 'fuzz-workload-validator.mjs'), wordpressCoreFuzzValidatorSource);
  writeJson(join(fuzzRoot, 'rest-api.json'), fuzzWorkload({
    id: 'rest-api',
    surface_ids: ['wordpress-core-rest-routes'],
    target: { type: 'wordpress-core', component: 'wordpress' },
  }));

  const result = runLint(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WordPress Core fuzz workloads must live under WordPress\/wordpress-develop\/fuzz/);
});
