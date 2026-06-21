import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workload = readFileSync(path.join(__dirname, 'admin-page-coverage.php'), 'utf8');
const rig = JSON.parse(readFileSync(path.join(__dirname, '../rigs/woocommerce-performance/rig.json'), 'utf8'));
const browserCoverageRig = JSON.parse(readFileSync(path.join(__dirname, '../rigs/woocommerce-browser-coverage/rig.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(__dirname, '../manifests/full-surface-coverage.json'), 'utf8'));
const adminFuzzManifest = JSON.parse(readFileSync(path.join(__dirname, '../fuzz/admin-page-coverage.json'), 'utf8'));
const adminAssetsCheck = path.join(__dirname, '../tools/check-admin-assets.sh');

const summarizeArtifactVisits = (visits) => {
  const measuredVisits = visits.filter((visit) => visit.status !== 'skipped');
  const httpErrors = measuredVisits.filter((visit) => Number(visit.status_code) >= 400);
  const requestErrors = measuredVisits.filter((visit) => visit.status === 'error');
  const permissionBoundarySkips = visits.filter(
    (visit) => visit.status === 'skipped' && visit.reasons?.includes('permission_boundary')
  );

  return {
    success_rate: measuredVisits.length > 0 ? (measuredVisits.length - httpErrors.length - requestErrors.length) / measuredVisits.length : 0,
    http_error_count: httpErrors.length,
    skipped_permission_count: permissionBoundarySkips.length,
  };
};

test('admin page coverage is bounded and skips unsafe admin actions', () => {
  assert.match(workload, /WC_ADMIN_PAGE_COVERAGE_LIMIT/);
  assert.match(workload, /min\( 100,/);
  assert.match(workload, /admin asset registries are missing/);
  assert.match(workload, /post-new\.php/);
  assert.match(workload, /plugin-install\.php/);
  assert.match(workload, /unsafe_query_arg_/);
  assert.match(workload, /setup_or_onboarding_screen/);
});

test('admin page coverage reports summarized query attribution without dropping raw logs', () => {
  assert.match(workload, /'request_logs'\s*=>\s*\$request_logs/);
  assert.match(workload, /homeboy-rigs\/woocommerce-admin-query-attribution\/v1/);
  assert.match(workload, /'sample_source'\s*=>\s*'request_logs\.query_shapes'/);
  assert.match(workload, /'sample_limit_per_request'\s*=>\s*25/);
  assert.match(workload, /'query_shape_sample_count'\s*=>\s*\$query_attribution\['sample_count'\]/);
  assert.match(workload, /'distinct_query_shape_count'\s*=>\s*count\( \$query_shape_counts \)/);
  assert.match(workload, /'top_query_shape_count'\s*=>\s*isset\( \$query_attribution\['top_query_shapes'\]\[0\]\['count'\] \)/);
  assert.match(workload, /'top_query_shapes'\s*=>\s*\$query_attribution\['top_query_shapes'\]/);
  assert.match(workload, /'top_query_families'\s*=>\s*\$query_attribution\['top_query_families'\]/);
  assert.match(workload, /'query_attribution'\s*=>\s*\$query_attribution/);
  assert.ok(workload.includes("preg_replace( '/\\b\\d+(?:\\.\\d+)?\\b/', '?'"));
  assert.match(workload, /return 'select:' \. \$matches\[1\]/);
});

test('admin page coverage is wired into executable full-surface profile', () => {
  assert.ok(
    rig.fuzz_workloads.wordpress.some((entry) => entry.path.includes('fuzz/admin-page-coverage.json')),
    'expected fuzz workload declaration'
  );
  assert.ok(
    !Object.values(rig.bench_workloads).flat().some((entry) => entry.path.includes('admin-page-coverage')),
    'admin page coverage must not use bench fallback'
  );
  assert.deepEqual(manifest.coverage_profiles['full-surface'].authenticated_admin_pages, ['admin-page-coverage']);
});

test('admin coverage rigs fail preflight when WooCommerce admin assets are missing', () => {
  assert.ok(
    rig.pipeline.check.some((entry) => entry.command?.includes('tools/check-admin-assets.sh')),
    'expected woocommerce-performance admin asset preflight'
  );
  assert.ok(
    browserCoverageRig.pipeline.check.some((entry) => entry.command?.includes('tools/check-admin-assets.sh')),
    'expected woocommerce-browser-coverage admin asset preflight'
  );

  const woocommercePath = mkdtempSync(path.join(tmpdir(), 'homeboy-woo-assets-'));
  const missing = spawnSync('bash', [adminAssetsCheck, woocommercePath], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /admin asset registries are missing/);

  mkdirSync(path.join(woocommercePath, 'assets/client/admin/wp-admin-scripts'), { recursive: true });
  writeFileSync(path.join(woocommercePath, 'assets/client/admin/wp-admin-scripts/index.asset.php'), '<?php return array();');
  const ready = spawnSync('bash', [adminAssetsCheck, woocommercePath], { encoding: 'utf8' });
  assert.equal(ready.status, 0);
});

test('admin page coverage artifact includes additive bottleneck summaries', () => {
  for (const rawField of ['visits', 'request_logs']) {
    assert.match(workload, new RegExp(`'${rawField}'\\s*=>\\s*\\$${rawField}`));
  }

  for (const summaryField of [
    'top_slow_visited_pages',
    'top_query_count_pages',
    'status_code_counts',
    'permission_skip_count',
    'php_error_summaries',
    'php_fatal_summaries',
  ]) {
    assert.match(workload, new RegExp(`'${summaryField}'\\s*=>`));
  }

  assert.match(workload, /label'\s*=>\s*\(string\) \( \$visit\['label'\]/);
  assert.match(workload, /page'\s*=>\s*\(string\) \( \$visit\['page'\]/);
  assert.match(workload, /role'\s*=>\s*\(string\) \( \$visit\['role'\]/);
  assert.match(workload, /status'\s*=>\s*\(string\) \( \$visit\['status'\]/);
  assert.match(workload, /elapsed_ms'\s*=>\s*isset\( \$visit\['elapsed_ms'\] \)/);
  assert.match(workload, /usort\( \$top_slow_visited_pages/);
  assert.match(workload, /usort\( \$top_query_count_pages/);
});

test('admin page coverage treats expected shop-manager 403s as permission-boundary skips', () => {
  assert.match(workload, /permission_boundary/);
  assert.match(workload, /skipped_permission_count/);
  assert.match(workload, /user_can\( \(int\) \$role_data\['user_id'\], \(string\) \$target\['capability'\] \)/);

  const permissionBoundaryOnly = summarizeArtifactVisits([
    {
      role: 'shop_manager',
      status: 'visited',
      status_code: 200,
      page: 'admin.php?page=wc-admin',
    },
    {
      role: 'shop_manager',
      status: 'skipped',
      status_code: 403,
      reasons: ['permission_boundary'],
      capability: 'manage_options',
      page: 'options-general.php',
    },
  ]);

  assert.equal(permissionBoundaryOnly.success_rate, 1);
  assert.equal(permissionBoundaryOnly.http_error_count, 0);
  assert.equal(permissionBoundaryOnly.skipped_permission_count, 1);

  const trueFailure = summarizeArtifactVisits([
    {
      role: 'shop_manager',
      status: 'visited',
      status_code: 500,
      page: 'admin.php?page=wc-admin',
    },
  ]);

  assert.equal(trueFailure.success_rate, 0);
  assert.equal(trueFailure.http_error_count, 1);
  assert.equal(trueFailure.skipped_permission_count, 0);
});

test('admin page coverage declares safe menu enumeration and role-boundary contracts', () => {
  assert.match(workload, /homeboy-rigs\/woocommerce-admin-page-enumeration-contract\/v1/);
  assert.match(workload, /homeboy-rigs\/woocommerce-admin-page-coverage\/v1/);
  assert.match(workload, /'administrator'\s*=>\s*array/);
  assert.match(workload, /'shop_manager'\s*=>\s*array/);
  assert.match(workload, /'skip_reason_codes'\s*=>\s*\$safe_skip_reason_codes/);
  assert.match(workload, /'destructive_reason_codes'\s*=>\s*array/);
  assert.match(workload, /'skip_reason_counts'\s*=>\s*\$skip_reason_counts/);
  assert.match(workload, /'contract'\s*=>\s*\$enumeration_contract/);
  assert.match(workload, /'schema'\s*=>\s*\$enumeration_contract\['artifact_expectations'\]\['schema'\]/);

  assert.equal(
    manifest.surfaces.authenticated_admin_pages.enumeration_contract.schema,
    'homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1'
  );
  assert.deepEqual(manifest.surfaces.authenticated_admin_pages.enumeration_contract.methods, ['GET']);
  assert.ok(manifest.surfaces.authenticated_admin_pages.enumeration_contract.skip_reason_codes.includes('permission_boundary'));
  assert.ok(manifest.surfaces.authenticated_admin_pages.enumeration_contract.skip_reason_codes.includes('unsafe_query_arg_delete'));
  assert.deepEqual(
    manifest.surfaces.authenticated_admin_pages.enumeration_contract.artifact_expectations.required,
    ['contract', 'targets', 'visits', 'skipped', 'request_logs', 'query_attribution', 'metrics']
  );
});

test('admin fuzz manifest requires the generic fuzz artifact contract', () => {
  assert.ok(adminFuzzManifest.operations.includes('safe-menu-enumeration-contract'));
  assert.ok(adminFuzzManifest.operations.includes('skipped-destructive-reason-classification'));
  assert.equal(adminFuzzManifest.metadata.admin_page_contract_schema, 'homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1');
  assert.equal(adminFuzzManifest.metadata.artifact_contract_schema, 'homeboy-rigs/woocommerce-admin-page-coverage/v1');
  assert.equal(adminFuzzManifest.artifacts.expected[0].required, true);
  assert.equal(adminFuzzManifest.artifacts.expected[0].schema, 'homeboy-rigs/woocommerce-admin-page-coverage/v1');
  assert.equal(adminFuzzManifest.cases[0].artifacts[0].required, true);
  assert.deepEqual(adminFuzzManifest.cases[0].artifacts[0].metadata.required_fields, [
    'schema',
    'contract',
    'targets',
    'visits',
    'skipped',
    'request_logs',
    'query_attribution',
    'metrics',
  ]);
});
