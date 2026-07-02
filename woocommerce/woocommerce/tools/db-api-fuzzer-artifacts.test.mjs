import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCoverageGapReport,
  buildPerformanceHotspotsSummary,
  classifyGenericArtifactSurface,
  classifyWooCommercePerformanceSurface,
  extractRestRequestCases,
} from './db-api-fuzzer-artifacts.mjs';

test('coverage gap report is derived from route inventory and generated request case artifacts', () => {
  const artifacts = [
    {
      path: '/artifacts/woocommerce-rest-route-inventory/routes.json',
      json: {
        routes: [
          { path: '/wc/store/v1/products' },
          { path: '/wc/store/v1/cart' },
        ],
      },
    },
    {
      path: '/artifacts/generated-rest-request-cases/cases.json',
      json: {
        schema: 'homeboy/wordpress-rest-request-cases/v1',
        cases: [
          { id: 'products', method: 'GET', path: '/wc/store/v1/products', params: { per_page: 1 } },
        ],
        coverage_gap: {
          gaps: [
            { path: '/wc/store/v1/cart', reason_code: 'dynamic_path_parameter' },
          ],
        },
      },
    },
  ];
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

  const summary = buildPerformanceHotspotsSummary(artifacts, {
    classifySurface: classifyWooCommercePerformanceSurface,
  });

  assert.equal(summary.schema, 'homeboy-rigs/woocommerce-performance-hotspots-summary/v1');
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

test('generic artifact scanning does not bake in WooCommerce hotspot labels', () => {
  assert.equal(
    classifyGenericArtifactSurface('checkout-shipping-cache', { metadata: { coverage_shape: 'checkout shipping cache profile' } }),
    'checkout shipping cache profile'
  );
  assert.equal(
    classifyWooCommercePerformanceSurface('checkout-shipping-cache', { metadata: { coverage_shape: 'checkout shipping cache profile' } }),
    'checkout'
  );
});
