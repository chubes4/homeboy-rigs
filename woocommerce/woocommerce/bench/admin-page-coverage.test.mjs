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
  assert.match(workload, /jetpack-connection\/dist\/jetpack-connection\.js/);
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
  const missingJetpack = spawnSync('bash', [adminAssetsCheck, woocommercePath], { encoding: 'utf8' });
  assert.equal(missingJetpack.status, 1);
  assert.match(missingJetpack.stderr, /Jetpack connection build output is missing/);

  mkdirSync(path.join(woocommercePath, 'vendor/automattic/jetpack-connection/dist'), { recursive: true });
  writeFileSync(path.join(woocommercePath, 'vendor/automattic/jetpack-connection/dist/jetpack-connection.js'), '/* built */');
  const ready = spawnSync('bash', [adminAssetsCheck, woocommercePath], { encoding: 'utf8' });
  assert.equal(ready.status, 0);
});
