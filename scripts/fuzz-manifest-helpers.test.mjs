import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFuzzReadinessMetadata,
  assertGenericFuzzManifest,
  declaredFuzzIds,
  workloadIdFromPath,
} from './fuzz-manifest-helpers.mjs';

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
        phases: { action: [{ command: 'product.inventory' }] },
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
  });

  assert.equal(runnerCase.case_id, 'product-fuzz:default');
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
        phases: { action: [{ command: 'product.inventory' }] },
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

test('assertFuzzReadinessMetadata accepts proven readiness with proof bundle linkage', () => {
  assert.doesNotThrow(() => assertFuzzReadinessMetadata(fuzzManifest({
    metadata: {
      workload_path: '${package.root}/bench/product.workload.json',
      readiness: {
        level: 'proven',
        coverage_contract: 'Product API CRUD coverage with reviewer-facing fuzz run artifacts.',
        proof_refs: ['https://github.com/example/product/issues/123'],
        proof_bundle: {
          artifact_refs: ['https://github.com/example/product/issues/123#issuecomment-456'],
          run_ids: ['run:product-fuzz-proof'],
          gap_reports: ['https://github.com/example/product/issues/124'],
          fuzz_result_artifacts: ['report'],
        },
      },
    },
  }), { file: 'product-fuzz.json' }));
});

test('assertFuzzReadinessMetadata rejects proven readiness without proof refs', () => {
  assert.throws(
    () => assertFuzzReadinessMetadata(fuzzManifest({
      metadata: {
        workload_path: '${package.root}/bench/product.workload.json',
        readiness: {
          level: 'proven',
          coverage_contract: 'Product API CRUD coverage.',
        },
      },
    }), { file: 'product-fuzz.json' }),
    /proven readiness requires proof_refs/
  );
});

test('assertFuzzReadinessMetadata rejects proven readiness without proof bundle linkage', () => {
  assert.throws(
    () => assertFuzzReadinessMetadata(fuzzManifest({
      metadata: {
        workload_path: '${package.root}/bench/product.workload.json',
        readiness: {
          level: 'proven',
          coverage_contract: 'Product API CRUD coverage.',
          proof_refs: ['https://github.com/example/product/issues/123'],
        },
      },
    }), { file: 'product-fuzz.json' }),
    /proven readiness requires proof_bundle/
  );
});

test('assertFuzzReadinessMetadata rejects local proof bundle refs', () => {
  assert.throws(
    () => assertFuzzReadinessMetadata(fuzzManifest({
      metadata: {
        workload_path: '${package.root}/bench/product.workload.json',
        readiness: {
          level: 'proven',
          coverage_contract: 'Product API CRUD coverage.',
          proof_refs: ['https://github.com/example/product/issues/123'],
          proof_bundle: {
            artifact_refs: ['https://localhost:8881/artifacts/product-fuzz'],
            run_ids: ['run:product-fuzz-proof'],
            gap_reports: ['https://github.com/example/product/issues/124'],
            fuzz_result_artifacts: ['report'],
          },
        },
      },
    }), { file: 'product-fuzz.json' }),
    /must not use local URLs/
  );
});

test('assertFuzzReadinessMetadata rejects proof bundle artifacts that are not required outputs', () => {
  assert.throws(
    () => assertFuzzReadinessMetadata(fuzzManifest({
      metadata: {
        workload_path: '${package.root}/bench/product.workload.json',
        readiness: {
          level: 'proven',
          coverage_contract: 'Product API CRUD coverage.',
          proof_refs: ['https://github.com/example/product/issues/123'],
          proof_bundle: {
            artifact_refs: ['https://github.com/example/product/issues/123#issuecomment-456'],
            run_ids: ['run:product-fuzz-proof'],
            gap_reports: ['https://github.com/example/product/issues/124'],
            fuzz_result_artifacts: ['missing-report'],
          },
        },
      },
    }), { file: 'product-fuzz.json' }),
    /must name a required case or expected artifact/
  );
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
