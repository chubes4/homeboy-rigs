import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readMaterializedRig } from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rig = readMaterializedRig(__dirname, '../rigs/woocommerce-performance/rig.json');
const browserCoverageRig = readMaterializedRig(__dirname, '../rigs/woocommerce-browser-coverage/rig.json');
const adminAssetsCheck = path.join(__dirname, '../tools/check-admin-assets.sh');

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
