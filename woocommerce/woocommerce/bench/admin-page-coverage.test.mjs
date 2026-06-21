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
