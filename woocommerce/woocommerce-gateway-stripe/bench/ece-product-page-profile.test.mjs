import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { evaluateEceRealWalletAssetHealth, realWalletAssetHealthSummary } from './ece-product-page-asset-health.mjs';
import { evaluateEceFixtureHealth, fixtureHealthSummary } from './ece-product-page-fixture-health.mjs';
import { buildEceProfileOptions } from './ece-product-page-profile.mjs';
import { DEFAULT_ECE_SCENARIO_ID, eceInteractionScript, eceProductPageScenario, eceProductPageScenarioIds, eceSimulatedClsScript } from './ece-product-page-scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('default smoke profile preserves browser probe defaults', () => {
  const options = buildEceProfileOptions('smoke');

  assert.equal(options.profile, 'smoke');
  assert.equal(options.profileLabel, 'Smoke');
  assert.match(options.profileCaveat, /rig health/);
  assert.equal(options.profileConclusion, 'Rig health and fixture availability only.');
  assert.equal(options.throttleProfile, null);
  assert.equal(options.runtimePreview, null);
  assert.deepEqual(options.recipeRunArgs, []);
  assert.deepEqual(options.browserProbeArgs, []);
  assert.ok(options.browserProbeAssertions.includes('assert=advisory:no-page-errors'));
  assert.ok(options.browserProbeAssertions.includes('assert=advisory:exists:#wc-stripe-express-checkout-element'));
  assert.equal(options.waitFor, null);
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
    assert.equal(options.profileLabel, 'Secure desktop browser');
    assert.match(options.profileCaveat, /secure-context plumbing/);
    assert.equal(options.throttleProfile, null);
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
    assert.ok(options.browserProbeAssertions.includes('assert=advisory:no-page-errors'));
    assert.equal(options.waitFor, null);
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

test('webperf desktop load profile uses load wait without synthetic throttle', () => {
  const options = buildEceProfileOptions('webperf-desktop-load');

  assert.equal(options.profile, 'webperf-desktop-load');
  assert.equal(options.profileLabel, 'Desktop load');
  assert.match(options.profileCaveat, /without synthetic CPU\/network throttle/);
  assert.match(options.profileConclusion, /Non-throttled desktop/);
  assert.equal(options.runtimePreview, null);
  assert.deepEqual(options.recipeRunArgs, []);
  assert.equal(options.waitFor, 'load');
  assert.equal(options.throttleProfile, null);
  assert.ok(options.browserProbeArgs.includes('device=Desktop Chrome'));
  assert.ok(options.browserProbeArgs.includes('mobile=0'));
  assert.ok(options.browserProbeArgs.includes('touch=0'));
  assert.ok(!options.browserProbeArgs.some((arg) => arg.startsWith('throttle=')));
  assert.ok(!options.browserProbeArgs.includes('profile=low-end-mobile-slow-4g'));
});

test('webperf desktop slow 4g profile keeps desktop context while applying Codebox throttle', () => {
  const options = buildEceProfileOptions('webperf-desktop-slow-4g');

  assert.equal(options.profile, 'webperf-desktop-slow-4g');
  assert.equal(options.profileLabel, 'Desktop slow 4G');
  assert.match(options.profileCaveat, /stable synthetic third-party fan-out deltas/);
  assert.match(options.profileConclusion, /Stable synthetic third-party response fan-out/);
  assert.equal(options.runtimePreview, null);
  assert.deepEqual(options.recipeRunArgs, []);
  assert.equal(options.waitFor, 'load');
  assert.equal(options.throttleProfile, 'low-end-mobile-slow-4g');
  assert.ok(options.browserProbeArgs.includes('device=Desktop Chrome'));
  assert.ok(options.browserProbeArgs.includes('mobile=0'));
  assert.ok(options.browserProbeArgs.includes('touch=0'));
  assert.ok(options.browserProbeArgs.includes('throttle=low-end-mobile-slow-4g'));
  assert.ok(!options.browserProbeArgs.includes('profile=low-end-mobile-slow-4g'));
});

test('rig manifest exposes the ECE webperf profile matrix', () => {
  const manifestPath = path.join(__dirname, '../rigs/woocommerce-stripe-ece-product-page/rig.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  assert.deepEqual(manifest.trace_profiles['webperf-desktop-load'], {
    scenario: 'ece-product-page-waterfall',
    settings: {
      woocommerce_stripe_ece_browser_profile: 'webperf-desktop-load',
    },
  });
  assert.deepEqual(manifest.trace_profiles['webperf-desktop-slow-4g'], {
    scenario: 'ece-product-page-waterfall',
    settings: {
      woocommerce_stripe_ece_browser_profile: 'webperf-desktop-slow-4g',
    },
  });
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
    assert.equal(options.profileLabel, 'Real-wallet desktop browser');
    assert.match(options.profileCaveat, /live Stripe keys/);
    assert.equal(options.throttleProfile, null);
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
    assert.ok(options.browserProbeAssertions.includes('assert=advisory:no-page-errors'));
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

test('fixture health passes for a structurally valid ECE product page', () => {
  const health = evaluateEceFixtureHealth({
    html: '<html><body><h1 class="product_title">Stripe Benchmark Product</h1><form class="cart"><div id="wc-stripe-express-checkout-element"></div></form></body></html>',
    htmlPath: '/tmp/browser/page.html',
    summaryPath: '/tmp/browser/summary.json',
    scriptResult: {
      title: 'Stripe Benchmark Product',
      locationHref: 'https://example.test/stripe-benchmark-product/',
      eceContainer: true,
      fixtureHealth: {
        hasCartForm: true,
        hasSummary: true,
        hasStripeParams: true,
        productTitleMatches: true,
      },
    },
    summary: { summary: { finalUrl: 'https://example.test/stripe-benchmark-product/' } },
  });

  assert.equal(health.ok, true);
  assert.deepEqual(health.failures, []);
});

test('real-wallet asset health fails on critical Woo Stripe asset failures and missing ECE startup', () => {
  const health = evaluateEceRealWalletAssetHealth({
    profileOptions: { realWalletCapable: true },
    networkEntries: [
      {
        type: 'response',
        url: 'https://example.test/wp-content/plugins/woocommerce-gateway-stripe/build/express-checkout.js?ver=10.8.0',
        status: 502,
      },
      {
        type: 'requestfailed',
        url: 'https://example.test/wp-content/plugins/woocommerce/assets/client/blocks/wc-blocks.css?ver=1',
        errorText: 'net::ERR_ABORTED',
      },
    ],
    metrics: {
      stripe_elements_session_response_count: 0,
      ece_render_peak_child_count: 0,
      ece_render_peak_iframe_count: 0,
      ece_render_peak_visible_button_count: 0,
    },
  });

  assert.equal(health.ok, false);
  assert.equal(health.details.failed_asset_count, 2);
  assert.ok(health.failures.some((failure) => /Critical Woo\/ECE frontend assets failed/.test(failure)));
  assert.ok(health.failures.some((failure) => /Stripe Elements session/.test(failure)));
  assert.ok(health.failures.some((failure) => /never observed ECE children/.test(failure)));
  assert.match(realWalletAssetHealthSummary(health), /asset health failed/);
});

test('real-wallet asset health is profile-scoped and passes when assets and ECE startup are healthy', () => {
  assert.equal(evaluateEceRealWalletAssetHealth({ profileOptions: { realWalletCapable: false } }).ok, true);

  const health = evaluateEceRealWalletAssetHealth({
    profileOptions: { realWalletCapable: true },
    networkEntries: [
      {
        type: 'response',
        url: 'https://example.test/wp-content/plugins/woocommerce-gateway-stripe/build/express-checkout.js?ver=10.8.0',
        status: 200,
      },
    ],
    metrics: {
      stripe_elements_session_response_count: 1,
      ece_render_peak_child_count: 1,
      ece_render_peak_iframe_count: 1,
      ece_render_peak_visible_button_count: 0,
    },
  });

  assert.equal(health.ok, true);
  assert.equal(health.details.failed_asset_count, 0);
});

test('fixture health fails loudly with artifact pointers for invalid product pages', () => {
  const health = evaluateEceFixtureHealth({
    html: 'fetch failed\nFatal error: broken fixture',
    htmlPath: '/tmp/browser/page.html',
    summaryPath: '/tmp/browser/summary.json',
    consolePath: '/tmp/browser/console.jsonl',
    errorsPath: '/tmp/browser/errors.jsonl',
    pageErrors: [{ text: 'PHP Warning: add-to-cart template missing' }],
    scriptResult: {
      title: 'Error',
      locationHref: 'https://example.test/?post_type=product&name=stripe-benchmark-product',
      eceContainer: false,
      fixtureHealth: {
        hasCartForm: false,
        hasStripeParams: false,
        productTitleMatches: false,
      },
    },
  });

  assert.equal(health.ok, false);
  assert.ok(health.failures.some((failure) => /benchmark product/.test(failure)));
  assert.ok(health.failures.some((failure) => /tiny fetch-failed page/.test(failure)));
  assert.ok(health.failures.some((failure) => /fatal\/parse\/critical-error/.test(failure)));
  assert.ok(health.failures.some((failure) => /add-to-cart\/template warnings/.test(failure)));
  assert.ok(health.failures.some((failure) => /form\.cart/.test(failure)));
  assert.ok(health.failures.some((failure) => /ECE mount/.test(failure)));
  assert.ok(health.failures.some((failure) => /Stripe Express Checkout params/.test(failure)));
  assert.ok(fixtureHealthSummary(health).includes('Captured HTML: /tmp/browser/page.html'));
});

test('waterfall recipe passes structural assertions to browser-probe', () => {
  const tracePath = path.join(__dirname, 'ece-product-page-waterfall.trace.mjs');
  const traceSource = readFileSync(tracePath, 'utf8');

  assert.match(traceSource, /\.\.\.profileOptions\.browserProbeAssertions/);
  assert.match(traceSource, /id: 'fixture-health'/);
  assert.match(traceSource, /id: 'real-wallet-asset-health'/);
});

test('fixture bootstrap forces a tiny Woo-compatible classic theme', () => {
  const fixtureBootstrapPath = path.join(__dirname, 'fixture-bootstrap.php');
  const fixtureBootstrapSource = readFileSync(fixtureBootstrapPath, 'utf8');

  assert.match(fixtureBootstrapSource, /ensure_classic_woocommerce_theme/);
  assert.match(fixtureBootstrapSource, /add_theme_support\( 'woocommerce' \)/);
  assert.match(fixtureBootstrapSource, /switch_theme\( 'homeboy-stripe-ece-classic' \)/);
});
