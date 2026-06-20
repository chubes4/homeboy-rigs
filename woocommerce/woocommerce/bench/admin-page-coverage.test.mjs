import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workload = readFileSync(path.join(__dirname, 'admin-page-coverage.php'), 'utf8');
const rig = JSON.parse(readFileSync(path.join(__dirname, '../rigs/woocommerce-performance/rig.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(__dirname, '../manifests/full-surface-coverage.json'), 'utf8'));

test('admin page coverage is bounded and skips unsafe admin actions', () => {
  assert.match(workload, /WC_ADMIN_PAGE_COVERAGE_LIMIT/);
  assert.match(workload, /min\( 100,/);
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
