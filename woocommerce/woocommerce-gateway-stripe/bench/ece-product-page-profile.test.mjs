import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEceProfileOptions } from './ece-product-page-profile.mjs';
import { DEFAULT_ECE_SCENARIO_ID, eceInteractionScript, eceProductPageScenario, eceProductPageScenarioIds } from './ece-product-page-scenarios.mjs';

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

test('real-wallet profile fails fast when Stripe keys are missing', () => {
  const previous = {
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL,
  };

  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL = 'https://example.test';

  try {
    assert.throws(
      () => buildEceProfileOptions('real-wallet'),
      /real-wallet profile requires STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY/
    );
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

test('real-wallet profile requires an HTTPS public preview origin', () => {
  const previous = {
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL,
  };

  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_real_fixture';
  process.env.STRIPE_SECRET_KEY = 'sk_test_real_fixture';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL = 'http://localhost:49800';

  try {
    assert.throws(
      () => buildEceProfileOptions('real-wallet'),
      /HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL to be an HTTPS public preview origin/
    );
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

test('real-wallet profile carries real-wallet evidence settings without leaking keys into CLI args', () => {
  const previous = {
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL,
  };

  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_real_fixture';
  process.env.STRIPE_SECRET_KEY = 'sk_test_real_fixture';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT = '49800';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND = '127.0.0.1';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL = 'https://ece-wallet.example.test';

  try {
    const options = buildEceProfileOptions('real-wallet');

    assert.equal(options.profile, 'real-wallet');
    assert.equal(options.realWalletCapable, true);
    assert.equal(options.syntheticOnly, false);
    assert.equal(options.stripePublishableKey, 'pk_test_real_fixture');
    assert.equal(options.stripeSecretKey, 'sk_test_real_fixture');
    assert.deepEqual(options.runtimePreview, {
      port: 49800,
      bind: '127.0.0.1',
      publicUrl: 'https://ece-wallet.example.test',
    });
    assert.deepEqual(options.recipeRunArgs, [
      '--preview-port',
      '49800',
      '--preview-bind',
      '127.0.0.1',
      '--preview-public-url',
      'https://ece-wallet.example.test',
    ]);
    assert.ok(!options.recipeRunArgs.join(' ').includes('sk_test_real_fixture'));
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

test('ECE scenario registry preserves load-only default and exposes interactions', () => {
  assert.equal(eceProductPageScenario().id, DEFAULT_ECE_SCENARIO_ID);
  assert.equal(eceProductPageScenario(DEFAULT_ECE_SCENARIO_ID).interaction, 'load-only');
  assert.equal(eceProductPageScenario('ece-product-page-scroll-to-ece').interaction, 'scroll-to-ece');
  assert.equal(eceProductPageScenario('ece-product-page-quantity-change').interaction, 'quantity-change');
  assert.ok(eceProductPageScenarioIds().includes(DEFAULT_ECE_SCENARIO_ID));
  assert.ok(eceProductPageScenarioIds().includes('ece-product-page-scroll-to-ece'));
});

test('ECE interaction scripts keep Stripe selectors in the rig', () => {
  assert.match(eceInteractionScript(eceProductPageScenario('ece-product-page-scroll-to-ece')), /#wc-stripe-express-checkout-element/);
  assert.match(eceInteractionScript(eceProductPageScenario('ece-product-page-quantity-change')), /quantity_change/);
});
