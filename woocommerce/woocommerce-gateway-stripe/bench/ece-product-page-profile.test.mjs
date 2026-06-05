import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEceProfileOptions } from './ece-product-page-profile.mjs';

test('default smoke profile preserves browser probe defaults', () => {
  const options = buildEceProfileOptions('smoke');

  assert.equal(options.profile, 'smoke');
  assert.equal(options.runtimePreview, null);
  assert.deepEqual(options.recipeRunArgs, []);
  assert.deepEqual(options.browserProbeArgs, []);
});

test('secure-browser profile uses generic preview and browser profile args', () => {
  const previous = {
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL,
  };

  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT = '49800';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND = '127.0.0.1';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL = 'https://example.test';

  try {
    const options = buildEceProfileOptions('secure-browser');

    assert.equal(options.profile, 'secure-browser');
    assert.deepEqual(options.runtimePreview, {
      port: 49800,
      bind: '127.0.0.1',
      publicUrl: 'https://example.test',
    });
    assert.deepEqual(options.recipeRunArgs, [
      '--preview-port',
      '49800',
      '--preview-bind',
      '127.0.0.1',
      '--preview-public-url',
      'https://example.test',
    ]);
    assert.ok(options.browserProbeArgs.includes('browser=chromium'));
    assert.ok(options.browserProbeArgs.includes('device=Desktop Chrome'));
    assert.ok(options.browserProbeArgs.includes('locale=en-US'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
