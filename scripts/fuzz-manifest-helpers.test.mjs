import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFuzzProofBundle,
  assertFuzzReadinessMetadata,
  assertGenericFuzzManifest,
  assertJetpackFuzzManifestReadinessContract,
  declaredFuzzIds,
  fullSurfaceRequiredArtifactIds,
  fuzzManifestHasExecutableArtifactContract,
  fuzzProofBundleFields,
  workloadIdFromPath,
} from './fuzz-manifest-helpers.mjs';

process.env.HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR = new URL('./fixtures/shared-fuzz-validator.cjs', import.meta.url).pathname;

function fuzzManifest(overrides = {}) {
  return {
    schema: 'homeboy/fuzz-workload/v1',
    id: 'product-fuzz',
    label: 'Product fuzz',
    safety_class: 'read_only',
    surface_ids: ['product-api'],
    operations: ['route-inventory'],
    case_budget: 10,
    duration_budget_seconds: 60,
    metadata: { workload_path: '${package.root}/bench/product.workload.json' },
    target: { type: 'wordpress-plugin', slug: 'product' },
    workload: { runner: 'wp-codebox', type: 'json', path: '${package.root}/bench/product.workload.json' },
    cases: [
      {
        case_id: 'product-fuzz:default',
        surface_ids: ['product-api'],
        operations: ['route-inventory'],
        intent: {
          schema: 'homeboy/fuzz-workload-intent/v1',
          type: 'wordpress-plugin-workload',
          plugin: { activation: 'product/product.php' },
          execute: {
            workload_ref: 'default',
            path: '${package.root}/bench/product.workload.json',
            type: 'json',
          },
          collect: [{ artifact: 'report' }],
        },
        artifacts: [{ name: 'report', path: 'report.json', required: true }],
        metadata: { safety_class: 'read_only' },
      },
    ],
    limits: { max_cases: 10, max_duration_seconds: 60 },
    coverage: { surface_ids: ['product-api'], operations: ['route-inventory'] },
    artifacts: { expected: [{ name: 'report', semantic_key: 'fuzz.report', required: true }] },
    ...overrides,
  };
}

test('workloadIdFromPath strips supported workload suffixes', () => {
  assert.equal(workloadIdFromPath('${package.root}/fuzz/product-fuzz.json'), 'product-fuzz');
  assert.equal(workloadIdFromPath('${package.root}/bench/product-fuzz.workload.json'), 'product-fuzz');
  assert.equal(workloadIdFromPath('${package.root}/bench/product-fuzz.php'), 'product-fuzz');
});

test('declaredFuzzIds accepts object and string workload declarations', () => {
  assert.deepEqual(declaredFuzzIds({
    fuzz_workloads: {
      wordpress: [
        { path: '${package.root}/fuzz/product-fuzz.json' },
        '${package.root}/fuzz/other-fuzz.json',
      ],
    },
  }), new Set(['product-fuzz', 'other-fuzz']));
});

test('assertGenericFuzzManifest accepts a linked generic fuzz workload contract', () => {
  const runnerCase = assertGenericFuzzManifest(fuzzManifest(), {
    file: 'product-fuzz.json',
    declaredIds: new Set(['product-fuzz']),
    targetSlug: 'product',
    requireCaseSafetyClass: true,
    requireExpectedArtifactSemanticKeys: true,
    requireRunnerNeutralIntent: true,
  });

  assert.equal(runnerCase.case_id, 'product-fuzz:default');
});

test('assertGenericFuzzManifest rejects runner commands when intent is required', () => {
  assert.throws(
    () => assertGenericFuzzManifest(fuzzManifest({
      cases: [
        {
          case_id: 'product-fuzz:default',
          surface_ids: ['product-api'],
          operations: ['route-inventory'],
          phases: { action: [{ command: 'wordpress.run-workload' }] },
          artifacts: [{ name: 'report', path: 'report.json', required: true }],
          metadata: { safety_class: 'read_only' },
        },
      ],
    }), {
      file: 'product-fuzz.json',
      declaredIds: new Set(['product-fuzz']),
      targetSlug: 'product',
      requireRunnerNeutralIntent: true,
    }),
    /requires runner-neutral case intent/
  );
});

test('assertGenericFuzzManifest rejects fuzz workloads that leak into bench paths', () => {
  assert.throws(
    () => assertGenericFuzzManifest(fuzzManifest(), {
      file: 'product-fuzz.json',
      declaredIds: new Set(['product-fuzz']),
      benchWorkloadIds: new Set(['product-fuzz']),
      targetSlug: 'product',
    }),
    /must not appear in bench_workloads/
  );
});

test('assertGenericFuzzManifest can preserve product-specific optional artifact semantics', () => {
  const manifest = fuzzManifest({
    cases: [
      {
        case_id: 'product-fuzz:default',
        surface_ids: ['product-api'],
        operations: ['route-inventory'],
        intent: {
          schema: 'homeboy/fuzz-workload-intent/v1',
          type: 'wordpress-plugin-workload',
          plugin: { activation: 'product/product.php' },
          execute: {
            workload_ref: 'default',
            path: '${package.root}/bench/product.workload.json',
            type: 'json',
          },
          collect: [{ artifact: 'diagnostic' }],
        },
        artifacts: [{ name: 'diagnostic', path: 'diagnostic.json', required: false }],
      },
    ],
    artifacts: { expected: [{ name: 'diagnostic', semantic_key: 'fuzz.diagnostic', required: false }] },
  });

  assert.doesNotThrow(() => assertGenericFuzzManifest(manifest, {
    file: 'product-fuzz.json',
    declaredIds: new Set(['product-fuzz']),
    targetSlug: 'product',
    requireCaseArtifacts: false,
    requireExpectedArtifacts: false,
    requireExpectedArtifactSemanticKeys: true,
  }));
});

test('fullSurfaceRequiredArtifactIds follows reviewer-facing coverage artifact expectations', () => {
  assert.deepEqual(fullSurfaceRequiredArtifactIds({
    coverage_profiles: {
      'full-surface': {
        rest_api: ['route-inventory', 'route-cases'],
        browser_requests: ['shop'],
      },
    },
    workloads: {
      'route-inventory': { artifact_expectations: { required: ['metrics'] } },
      'route-cases': { artifact_expectations: { required: [] } },
      shop: { artifact_expectations: { required: ['browser trace'] } },
    },
  }), new Set(['route-inventory']));
});

test('fuzzManifestHasExecutableArtifactContract excludes declared or blocked contracts', () => {
  assert.equal(fuzzManifestHasExecutableArtifactContract(fuzzManifest()), false);
  assert.equal(fuzzManifestHasExecutableArtifactContract(fuzzManifest({
    metadata: {
      workload_path: '${package.root}/bench/product.workload.json',
      readiness: { level: 'executable', coverage_contract: 'Executable product fuzz contract.' },
    },
  })), true);
  assert.equal(fuzzManifestHasExecutableArtifactContract(fuzzManifest({
    metadata: {
      workload_path: '${package.root}/bench/product.workload.json',
      readiness: { level: 'declared' },
    },
  })), false);
  assert.equal(fuzzManifestHasExecutableArtifactContract(fuzzManifest({
    metadata: {
      workload_path: '${package.root}/bench/product.workload.json',
      readiness: { level: 'executable', coverage_contract: 'Blocked product fuzz contract.' },
      generic_primitive: { status: 'blocked' },
    },
  })), false);
});

test('assertJetpackFuzzManifestReadinessContract rejects executable readiness with optional artifacts', () => {
  assert.throws(
    () => assertJetpackFuzzManifestReadinessContract(fuzzManifest({
      target: { type: 'wordpress-plugin', slug: 'jetpack', component: 'jetpack' },
      metadata: {
        workload_path: '${package.root}/bench/product.workload.json',
        readiness: { level: 'executable', coverage_contract: 'Jetpack executable fuzz contract.' },
      },
      cases: [
        {
          case_id: 'product-fuzz:default',
          surface_ids: ['product-api'],
          operations: ['route-inventory'],
          artifacts: [{ name: 'report', path: 'report.json', required: false }],
        },
      ],
    }), { file: 'jetpack-fuzz.json' }),
    /executable Jetpack readiness requires case artifact report to be required/
  );
});

test('assertFuzzReadinessMetadata accepts declared CRUD and isolated mutation contracts', () => {
  assert.doesNotThrow(() => assertFuzzReadinessMetadata(fuzzManifest({
    metadata: {
      workload_path: '${package.root}/bench/product.workload.json',
      readiness: {
        level: 'executable',
        coverage_contract: 'Catalog REST CRUD coverage with rollback-safe option mutation proof artifacts.',
        upstream_blockers: ['homeboy fuzz runner needs durable artifact manifest links before full proof'],
        crud: {
          create: { level: 'declared', upstream_blocker: 'safe fixture create primitive is not available upstream' },
          read: { level: 'executable' },
          update: { level: 'declared', upstream_blocker: 'safe fixture update primitive is not available upstream' },
          delete: { level: 'declared', upstream_blocker: 'safe fixture delete primitive is not available upstream' },
        },
        mutation: {
          safety_boundary: 'Runs in disposable WP Codebox with rollback artifacts for changed options/transients.',
          rollback_artifacts: ['rollback_report'],
        },
      },
    },
  }), { file: 'product-fuzz.json' }));
});

test('assertGenericFuzzManifest can require readiness metadata', () => {
  assert.throws(
    () => assertGenericFuzzManifest(fuzzManifest(), {
      file: 'product-fuzz.json',
      declaredIds: new Set(['product-fuzz']),
      targetSlug: 'product',
      requireReadinessMetadata: true,
    }),
    /requires metadata.readiness/
  );
});

test('assertFuzzProofBundle accepts a canonical fuzz envelope artifact ref alongside legacy refs', () => {
  assert.ok(fuzzProofBundleFields.has('canonical_fuzz_envelope_ref'));
  assert.doesNotThrow(() => assertFuzzProofBundle({
    artifact_refs: ['https://github.com/chubes4/homeboy-rigs/issues/254'],
    run_ids: ['run:product-fuzz'],
    gap_reports: ['https://github.com/chubes4/homeboy-rigs/issues/253'],
    fuzz_result_artifacts: ['report'],
    canonical_fuzz_envelope_ref: 'homeboy-runs:product-fuzz/artifacts/fuzz-envelope.json',
  }, fuzzManifest(), { file: 'product-fuzz.json' }));
});

test('assertFuzzProofBundle accepts Homeboy run artifact refs for canonical fuzz envelopes', () => {
  assert.doesNotThrow(() => assertFuzzProofBundle({
    artifact_refs: ['https://github.com/chubes4/homeboy-rigs/issues/254'],
    run_ids: ['run:product-fuzz'],
    gap_reports: ['https://github.com/chubes4/homeboy-rigs/issues/253'],
    fuzz_result_artifacts: ['report'],
    canonical_fuzz_envelope_ref: 'homeboy://run/product-fuzz/artifact/fuzz-envelope',
  }, fuzzManifest(), { file: 'product-fuzz.json' }));
});

test('assertFuzzProofBundle rejects local canonical fuzz envelope artifact refs', () => {
  assert.throws(
    () => assertFuzzProofBundle({
      artifact_refs: ['https://github.com/chubes4/homeboy-rigs/issues/254'],
      run_ids: ['run:product-fuzz'],
      gap_reports: ['https://github.com/chubes4/homeboy-rigs/issues/253'],
      fuzz_result_artifacts: ['report'],
      canonical_fuzz_envelope_ref: 'https://localhost:8881/fuzz-envelope.json',
    }, fuzzManifest(), { file: 'product-fuzz.json' }),
    /canonical_fuzz_envelope_ref must not use local evidence/
  );
});
