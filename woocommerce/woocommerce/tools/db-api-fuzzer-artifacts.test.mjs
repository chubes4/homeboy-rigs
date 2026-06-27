import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  artifactPostprocessCommand,
  buildArtifactPostprocessPayload,
  buildCoverageGapReport,
  buildPerformanceHotspotsSummary,
  extractRestRequestCases,
  normalizeArtifactPostprocessStep,
  readArtifactTree,
} from './db-api-fuzzer-artifacts.mjs';

function writeJson(root, relativePath, payload) {
  const targetPath = path.join(root, relativePath);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

test('coverage gap report is derived from route inventory and generated request case artifacts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'woo-db-api-gap-'));

  writeJson(root, 'woocommerce-rest-route-inventory/routes.json', {
    routes: [
      { path: '/wc/store/v1/products' },
      { path: '/wc/store/v1/cart' },
    ],
  });
  writeJson(root, 'generated-rest-request-cases/cases.json', {
    schema: 'homeboy/wordpress-rest-request-cases/v1',
    cases: [
      { id: 'products', method: 'GET', path: '/wc/store/v1/products', params: { per_page: 1 } },
    ],
    coverage_gap: {
      gaps: [
        { path: '/wc/store/v1/cart', reason_code: 'dynamic_path_parameter' },
      ],
    },
  });

  const artifacts = readArtifactTree(root);
  const report = buildCoverageGapReport(artifacts);

  assert.equal(report.schema, 'homeboy-rigs/wordpress-coverage-gap-report/v1');
  assert.equal(report.surface_type, 'rest');
  assert.deepEqual(report.expected, { rest_routes: 2 });
  assert.deepEqual(report.covered, ['/wc/store/v1/products']);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.gaps, [{ path: '/wc/store/v1/cart', reason_code: 'dynamic_path_parameter' }]);
  assert.ok(report.evidence_refs.includes('artifact:cases.json'));
});

test('generated REST request cases are capped when consumed by DB/API profilers', () => {
  const artifacts = [
    {
      path: '/artifacts/generated-rest-request-cases/cases.json',
      json: {
        schema: 'homeboy/wordpress-rest-request-cases/v1',
        cases: [
          { id: 'a', method: 'GET', path: '/wc/store/v1/products' },
          { id: 'b', method: 'GET', path: '/wc/store/v1/cart' },
        ],
      },
    },
  ];

  assert.deepEqual(
    extractRestRequestCases(artifacts, { maxRouteCases: 1 }),
    [{ id: 'a', method: 'GET', path: '/wc/store/v1/products', params: {}, source_artifact: '/artifacts/generated-rest-request-cases/cases.json', surface: undefined }]
  );
});

test('performance hotspot summary ranks available artifacts relatively', () => {
  const artifacts = [
    {
      path: '/artifacts/rest-db-query-profile/profile.json',
      json: {
        run_id: 'api-run',
        metadata: { workload: 'rest-db-query-profile', coverage_shape: 'REST API profile' },
        metrics: { total_query_count: 12, total_elapsed_ms: 2500 },
        query_samples: [{ table: 'wp_wc_orders', query_type: 'select' }],
      },
    },
    {
      path: '/artifacts/checkout-shipping-cache/profile.json',
      json: {
        run_id: 'checkout-run',
        metadata: { workload: 'checkout-shipping-cache', coverage_shape: 'checkout shipping cache profile' },
        metrics: { total_query_count: 20, total_elapsed_ms: 1000 },
      },
    },
  ];

  const summary = buildPerformanceHotspotsSummary(artifacts);

  assert.equal(summary.schema, 'homeboy/woocommerce-performance-hotspots-summary/v1');
  assert.equal(summary.threshold_policy, 'relative_ranking_only');
  assert.equal(summary.ranking[0].rank, 1);
  assert.equal(summary.ranking[0].surface, 'checkout');
  assert.ok(summary.ranking[0].relative_score > summary.ranking[1].relative_score);
  assert.deepEqual(Object.keys(summary.ranking[0]).sort(), [
    'fixture_scale',
    'query_attribution',
    'rank',
    'relative_score',
    'request_attribution',
    'run_refs',
    'surface',
  ]);
});

test('generic artifact postprocess contract drives coverage gap output', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'woo-db-api-contract-gap-'));
  writeJson(root, 'woocommerce-rest-route-inventory/routes.json', {
    routes: [{ path: '/wc/store/v1/products' }],
  });
  writeJson(root, 'generated-rest-request-cases/cases.json', {
    schema: 'homeboy/wordpress-rest-request-cases/v1',
    cases: [{ id: 'products', method: 'GET', path: '/wc/store/v1/products' }],
  });

  const step = {
    command: artifactPostprocessCommand,
    args: {
      helper: '${package.root}/tools/db-api-fuzzer-artifacts.mjs',
      action: 'coverage-gap-report',
      input: {
        type: 'artifact-root',
        path: root,
        artifact_globs: ['**/*.json'],
        max_bytes: 1048576,
      },
      output: {
        artifact: 'coverage_gap_report',
        path: 'coverage-gap-report/coverage_gap_report.json',
        kind: 'json',
        contentType: 'application/json',
        schema: 'homeboy-rigs/wordpress-coverage-gap-report/v1',
        semantic_key: 'fuzz.report',
        required_fields: ['surface_type', 'expected', 'covered', 'gaps', 'status', 'evidence_refs'],
      },
      parameters: {
        metric_prefix: 'coverage_gap_report',
      },
    },
  };

  assert.equal(normalizeArtifactPostprocessStep(step).command, 'coverage-gap-report');
  assert.equal(buildArtifactPostprocessPayload(step).status, 'covered');
});

test('generic artifact postprocess contract rejects invented commands and incomplete output bindings', () => {
  assert.throws(
    () => normalizeArtifactPostprocessStep({ command: 'artifact-postprocess', args: {} }),
    /Unsupported artifact postprocess command: artifact-postprocess/
  );

  assert.throws(
    () => normalizeArtifactPostprocessStep({
      command: artifactPostprocessCommand,
      args: {
        helper: '${package.root}/tools/db-api-fuzzer-artifacts.mjs',
        action: 'coverage-gap-report',
        input: { type: 'artifact-root', path: '/tmp/artifacts', artifact_globs: ['**/*.json'] },
        output: { artifact: 'coverage_gap_report', path: 'coverage-gap-report/coverage_gap_report.json', kind: 'json' },
      },
    }),
    /args\.output\.contentType must be a non-empty string/
  );
});

test('generic artifact postprocess contract rejects drifted coverage output schema', () => {
  assert.throws(
    () => normalizeArtifactPostprocessStep({
      command: artifactPostprocessCommand,
      args: {
        helper: '${package.root}/tools/db-api-fuzzer-artifacts.mjs',
        action: 'coverage-gap-report',
        input: { type: 'artifact-root', path: '/tmp/artifacts', artifact_globs: ['**/*.json'] },
        output: {
          artifact: 'coverage_gap_report',
          path: 'coverage-gap-report/coverage_gap_report.json',
          kind: 'json',
          contentType: 'application/json',
          schema: 'homeboy-rigs/wordpress-coverage-gap-report/v1',
          semantic_key: 'fuzz.report',
          required_fields: ['surface_type'],
        },
      },
    }),
    /Coverage gap output required_fields/
  );
});

test('generic artifact postprocess contract rejects drifted hotspot ranking schema', () => {
  assert.throws(
    () => normalizeArtifactPostprocessStep({
      command: artifactPostprocessCommand,
      args: {
        helper: '${package.root}/tools/db-api-fuzzer-artifacts.mjs',
        action: 'performance-hotspots-summary',
        input: { type: 'artifact-root', path: '/tmp/artifacts', artifact_globs: ['**/*.json'] },
        output: {
          artifact: 'performance_hotspots_summary',
          path: 'performance-hotspots-artifact-summary/performance_hotspots_summary.json',
          kind: 'json',
          contentType: 'application/json',
          schema: 'homeboy/woocommerce-performance-hotspots-summary/v1',
          semantic_key: 'fuzz.report',
          ranking: { mode: 'absolute', required_fields: ['rank'] },
        },
      },
    }),
    /ranking\.mode must be relative/
  );
});

test('CLI rejects unsupported artifact commands', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'woo-db-api-cli-'));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./db-api-fuzzer-artifacts.mjs', import.meta.url)),
    'unknown-command',
    root,
    path.join(root, 'out.json'),
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported command: unknown-command/);
});
