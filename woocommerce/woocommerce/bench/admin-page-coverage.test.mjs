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
const adminAssetsCheck = path.join(__dirname, '../tools/check-admin-assets.sh');

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
  assert.match(workload, /'top_query_shapes'\s*=>\s*\$query_attribution\['top_query_shapes'\]/);
  assert.match(workload, /'top_query_families'\s*=>\s*\$query_attribution\['top_query_families'\]/);
  assert.match(workload, /'query_attribution'\s*=>\s*\$query_attribution/);
  assert.ok(workload.includes("preg_replace( '/\\b\\d+(?:\\.\\d+)?\\b/', '?'"));
  assert.match(workload, /return 'select:' \. \$matches\[1\]/);
});

test('admin page coverage is wired into executable full-surface profile', () => {
  assert.ok(
    rig.bench_workloads.wordpress.some((entry) => entry.path.includes('bench/admin-page-coverage.php')),
    'expected workload declaration'
  );
  assert.ok(rig.bench_profiles['full-surface'].includes('admin-page-coverage'));
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
