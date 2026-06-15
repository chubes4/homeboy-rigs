import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRequestSummary } from './ece-request-summary.mjs';
import { validateStripeEceAssetProvenance } from './ece-product-page-assets.mjs';
import { buildEceProfileOptions } from './ece-product-page-profile.mjs';
import { DEFAULT_ECE_SCENARIO_ID, eceInteractionScript, eceProductPageScenario, eceProductPageScenarioIds, eceSimulatedClsScript } from './ece-product-page-scenarios.mjs';

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
  assert.equal(eceProductPageScenario('ece-product-page-simulated-cls').simulatedCls, 'unreserved');
  assert.equal(eceProductPageScenario('ece-product-page-simulated-cls-reserved').simulatedCls, 'reserved');
  assert.equal(eceProductPageScenario('ece-product-page-simulated-cls').waitFor, 'load');
  assert.equal(eceProductPageScenario('ece-product-page-simulated-cls-reserved').waitFor, 'load');
  assert.ok(eceProductPageScenarioIds().includes(DEFAULT_ECE_SCENARIO_ID));
  assert.ok(eceProductPageScenarioIds().includes('ece-product-page-scroll-to-ece'));
  assert.ok(eceProductPageScenarioIds().includes('ece-product-page-simulated-cls'));
  assert.ok(eceProductPageScenarioIds().includes('ece-product-page-simulated-cls-reserved'));
});

test('ECE interaction scripts keep Stripe selectors in the rig', () => {
  assert.match(eceInteractionScript(eceProductPageScenario('ece-product-page-scroll-to-ece')), /#wc-stripe-express-checkout-element/);
  assert.match(eceInteractionScript(eceProductPageScenario('ece-product-page-quantity-change')), /quantity_change/);
  assert.match(eceInteractionScript(eceProductPageScenario('ece-product-page-simulated-cls')), /simulated_cls_render/);
});

test('ECE simulated CLS scripts track root and grouped ECE containers', () => {
  const unreservedScript = eceSimulatedClsScript(eceProductPageScenario('ece-product-page-simulated-cls'));
  const reservedScript = eceSimulatedClsScript(eceProductPageScenario('ece-product-page-simulated-cls-reserved'));

  assert.match(unreservedScript, /homeboy-stripe-ece-simulated-button/);
  assert.match(unreservedScript, /#wc-stripe-express-checkout-element/);
  assert.match(unreservedScript, /#wc-stripe-express-checkout-element-wallets-link/);
  assert.ok(!unreservedScript.includes("].join('\n');"));
  assert.doesNotMatch(unreservedScript, /min-height: 48px/);
  assert.match(reservedScript, /min-height: 48px/);
});

test('ECE request summary counts responses by host and type', () => {
  assert.deepEqual(
    buildRequestSummary([
      { url: 'https://example.test/product', resourceType: 'document' },
      { url: 'https://api.stripe.com/v1/elements/sessions', request: { resourceType: 'fetch' } },
      { request: { url: 'https://api.stripe.com/v1/payment_methods', resourceType: 'xhr' } },
      { url: 'not a url', type: 'response' },
    ]),
    {
      total: 4,
      by_host: {
        'api.stripe.com': 2,
        'example.test': 1,
        unknown: 1,
      },
      by_type: {
        document: 1,
        fetch: 1,
        response: 1,
        xhr: 1,
      },
    }
  );
});

async function writeStripeEceFixture({ includeBuild = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'stripe-ece-assets.'));

  await mkdir(path.join(root, 'client/entrypoints/express-checkout'), { recursive: true });
  await writeFile(path.join(root, 'client/entrypoints/express-checkout/index.js'), 'window.__ece_fixture = true;\n');
  await writeFile(path.join(root, 'client/entrypoints/express-checkout/styles.scss'), '.wc-stripe-ece { display: block; }\n');

  if (includeBuild) {
    await mkdir(path.join(root, 'build'), { recursive: true });
    await writeFile(path.join(root, 'build/express-checkout.js'), 'window.__ece_fixture_built = true;\n');
    await writeFile(path.join(root, 'build/express-checkout.css'), '.wc-stripe-ece{display:block}\n');
    await writeFile(path.join(root, 'build/express-checkout.asset.php'), "<?php return array( 'dependencies' => array(), 'version' => 'fixture' );\n");
  }

  return root;
}

test('Stripe ECE asset provenance passes with generated build artifacts', async () => {
  const root = await writeStripeEceFixture();
  const result = await validateStripeEceAssetProvenance(root);

  assert.equal(result.status, 'pass');
  assert.equal(result.newest_source.startsWith('client/entrypoints/express-checkout/'), true);
  assert.deepEqual(
    result.build_files.map((file) => file.path),
    ['build/express-checkout.js', 'build/express-checkout.css', 'build/express-checkout.asset.php']
  );
});

test('Stripe ECE asset provenance fails when build artifacts are absent', async () => {
  const root = await writeStripeEceFixture({ includeBuild: false });

  await assert.rejects(
    () => validateStripeEceAssetProvenance(root),
    /Missing build artifact\(s\):\n- build\/express-checkout\.js\n- build\/express-checkout\.css\n- build\/express-checkout\.asset\.php/
  );
});
