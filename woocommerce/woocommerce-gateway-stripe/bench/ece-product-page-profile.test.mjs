import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { evaluateEceRealWalletAssetHealth, realWalletAssetHealthSummary } from './ece-product-page-asset-health.mjs';
import { evaluateEceFixtureHealth, fixtureHealthSummary } from './ece-product-page-fixture-health.mjs';
import { buildEceProfileOptions } from './ece-product-page-profile.mjs';
import { DEFAULT_ECE_SCENARIO_ID, eceInteractionScript, eceProductPageScenario, eceProductPageScenarioIds, eceSimulatedClsScript } from './ece-product-page-scenarios.mjs';
import { classifyEceWalletFanoutEvidence, ECE_FANOUT_REVIEWER_READY, ECE_FANOUT_SUPPLEMENTAL, groupedWalletLayoutSummary } from './ece-product-page-wallet-classification.mjs';
import { wpCodeboxBin, wpCodeboxCommand } from './ece-product-page-wp-codebox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('WP Codebox helper centralizes binary resolution', () => {
  assert.equal(wpCodeboxBin({}), 'wp-codebox');
  assert.equal(wpCodeboxBin({ HOMEBOY_SETTINGS_WP_CODEBOX_BIN: '/tmp/wp-codebox-settings.js' }), '/tmp/wp-codebox-settings.js');
  assert.equal(
    wpCodeboxBin({
      HOMEBOY_WP_CODEBOX_BIN: '/tmp/wp-codebox-env.mjs',
      HOMEBOY_SETTINGS_WP_CODEBOX_BIN: '/tmp/wp-codebox-settings.js',
    }),
    '/tmp/wp-codebox-env.mjs'
  );

  assert.deepEqual(wpCodeboxCommand('/tmp/wp-codebox.mjs'), { command: 'node', args: ['/tmp/wp-codebox.mjs'] });
  assert.deepEqual(wpCodeboxCommand('wp-codebox'), { command: 'wp-codebox', args: [] });
});

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

test('webperf wallet fanout profile supplies a non-secret synthetic publishable key', () => {
  const previous = {
    HOMEBOY_SETTINGS_WOOCOMMERCE_STRIPE_ECE_REQUIRE_FANOUT_PROOF: process.env.HOMEBOY_SETTINGS_WOOCOMMERCE_STRIPE_ECE_REQUIRE_FANOUT_PROOF,
    HOMEBOY_WC_STRIPE_REQUIRE_FANOUT_PROOF: process.env.HOMEBOY_WC_STRIPE_REQUIRE_FANOUT_PROOF,
    HOMEBOY_WC_STRIPE_SYNTHETIC_PUBLISHABLE_KEY: process.env.HOMEBOY_WC_STRIPE_SYNTHETIC_PUBLISHABLE_KEY,
  };

  process.env.HOMEBOY_SETTINGS_WOOCOMMERCE_STRIPE_ECE_REQUIRE_FANOUT_PROOF = '1';
  process.env.HOMEBOY_WC_STRIPE_SYNTHETIC_PUBLISHABLE_KEY = 'pk_test_custom_synthetic_fixture';

  try {
    const options = buildEceProfileOptions('webperf-desktop-slow-4g');

    assert.equal(options.syntheticOnly, true);
    assert.equal(options.realWalletCapable, false);
    assert.equal(options.stripePublishableKey, 'pk_test_custom_synthetic_fixture');
    assert.equal(options.stripeSecretKey, null);
    assert.deepEqual(options.recipeRunArgs, []);
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
  assert.deepEqual(manifest.trace_profiles['webperf-wallet-fanout'], {
    scenario: 'ece-product-page-waterfall',
    settings: {
      woocommerce_stripe_ece_browser_profile: 'webperf-desktop-slow-4g',
      woocommerce_stripe_accepted_payment_methods: 'card,link,apple_pay,google_pay',
      woocommerce_stripe_ece_require_fanout_proof: '1',
    },
  });
  assert.equal(manifest.trace_profiles['real-wallet'].public_preview, undefined);
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
    HOMEBOY_PREVIEW_PUBLIC_URL: process.env.HOMEBOY_PREVIEW_PUBLIC_URL,
  };

  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_real_fixture';
  process.env.STRIPE_SECRET_KEY = 'sk_test_real_fixture';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL = 'http://localhost:49800';
  delete process.env.HOMEBOY_PREVIEW_PUBLIC_URL;

  try {
    assert.throws(
      () => buildEceProfileOptions('real-wallet'),
      /HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL or HOMEBOY_PREVIEW_PUBLIC_URL to be an HTTPS public preview origin/
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

test('real-wallet profile accepts Homeboy native preview public URL', () => {
  const previous = {
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND,
    HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL: process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL,
    HOMEBOY_PREVIEW_PUBLIC_URL: process.env.HOMEBOY_PREVIEW_PUBLIC_URL,
  };

  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_real_fixture';
  process.env.STRIPE_SECRET_KEY = 'sk_test_real_fixture';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT = '49800';
  process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND = '127.0.0.1';
  delete process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL;
  process.env.HOMEBOY_PREVIEW_PUBLIC_URL = 'https://native-preview.example.test';

  try {
    const options = buildEceProfileOptions('real-wallet');

    assert.deepEqual(options.runtimePreview, {
      port: 49800,
      bind: '127.0.0.1',
      publicUrl: 'https://native-preview.example.test',
    });
    assert.deepEqual(options.recipeRunArgs, [
      '--preview-port',
      '49800',
      '--preview-bind',
      '127.0.0.1',
      '--preview-public-url',
      'https://native-preview.example.test',
    ]);
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

test('wallet fanout classification keeps card-link real-wallet smoke supplemental', () => {
  const evidence = classifyEceWalletFanoutEvidence({
    requestedPaymentMethods: ['card', 'link'],
    realWalletCapable: true,
    syntheticOnly: false,
    eceConstructed: true,
    browserEligibility: {
      secureContext: true,
      paymentRequestSupported: true,
      applePaySessionSupported: false,
    },
    renderedWallets: {
      link: true,
    },
    observedWallets: {
      link: true,
    },
  });

  assert.equal(evidence.classification, 'supplemental smoke only');
  assert.equal(evidence.valid_fanout_proof, false);
  assert.equal(evidence.requested_wallet_fanout, false);
  assert.deepEqual(evidence.reason_codes, ['wallet_fanout_not_requested']);
  assert.deepEqual(evidence.wallets.apple_pay, {
    method: 'apple_pay',
    requested: false,
    eligible: false,
    rendered: false,
    observed: false,
  });
});

test('wallet fanout classification reports browser eligibility and missing observed wallets', () => {
  const evidence = classifyEceWalletFanoutEvidence({
    requestedPaymentMethods: ['card', 'link', 'apple_pay', 'google_pay'],
    realWalletCapable: true,
    syntheticOnly: false,
    eceConstructed: true,
    browserEligibility: {
      secureContext: true,
      paymentRequestSupported: true,
      applePaySessionSupported: false,
    },
    renderedWallets: {
      link: true,
    },
    observedWallets: {
      link: true,
    },
  });

  assert.equal(evidence.classification, 'supplemental smoke only');
  assert.equal(evidence.valid_fanout_proof, false);
  assert.equal(evidence.requested_wallet_fanout, true);
  assert.ok(evidence.reason_codes.includes('apple_pay_browser_not_eligible'));
  assert.ok(evidence.reason_codes.includes('apple_pay_not_observed'));
  assert.ok(evidence.reason_codes.includes('google_pay_not_observed'));
  assert.ok(evidence.reason_codes.includes('wallet_fanout_not_observed'));
  assert.equal(evidence.wallets.google_pay.eligible, true);
  assert.equal(evidence.wallets.link.observed, true);
});

test('wallet fanout classification marks synthetic fanout with ECE construction as reviewer ready', () => {
  const evidence = classifyEceWalletFanoutEvidence({
    requestedPaymentMethods: ['card', 'link', 'apple_pay', 'google_pay'],
    realWalletCapable: false,
    syntheticOnly: true,
    eceConstructed: true,
    browserEligibility: {
      secureContext: false,
      paymentRequestSupported: false,
      applePaySessionSupported: false,
    },
  });

  assert.equal(evidence.classification, ECE_FANOUT_REVIEWER_READY);
  assert.equal(evidence.valid_fanout_proof, true);
  assert.equal(evidence.observed_wallet_fanout, false);
  assert.deepEqual(evidence.reason_codes, []);
});

test('wallet fanout classification requires ECE construction for synthetic proof', () => {
  const evidence = classifyEceWalletFanoutEvidence({
    requestedPaymentMethods: ['card', 'link', 'apple_pay', 'google_pay'],
    realWalletCapable: false,
    syntheticOnly: true,
    eceConstructed: false,
  });

  assert.equal(evidence.classification, ECE_FANOUT_SUPPLEMENTAL);
  assert.equal(evidence.valid_fanout_proof, false);
  assert.ok(evidence.reason_codes.includes('ece_not_constructed'));
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
  assert.match(traceSource, /woocommerce_stripe_accepted_payment_methods/);
  assert.match(traceSource, /woocommerce_stripe_ece_require_fanout_proof/);
  assert.match(traceSource, /#wc-stripe-express-checkout-element-apple_pay/);
  assert.match(traceSource, /#wc-stripe-express-checkout-element-google_pay/);
  assert.match(traceSource, /#wc-stripe-express-checkout-element-wallets-link/);
  assert.match(traceSource, /homeboy-stripe-ece-fanout-proof-style/);
  assert.match(traceSource, /display: block !important; width: 100% !important/);
  assert.match(traceSource, /join\('\\\\n'\)/);
  assert.match(traceSource, /ece-wallet-fanout-proof/);
  assert.match(traceSource, /installStripeEceInstrumentation/);
  assert.match(traceSource, /express_checkout_create_calls/);
  assert.match(traceSource, /express_checkout_mount_calls/);
  assert.match(traceSource, /ece_instance_count/);
  assert.match(traceSource, /ece_mount_count/);
  assert.match(traceSource, /ece_mount_target_selectors/);
  assert.match(traceSource, /id: 'ece-construction-observed'/);
  assert.match(traceSource, /id: 'ece-grouped-wallet-layout'/);
  assert.match(traceSource, /id: 'fixture-health'/);
  assert.match(traceSource, /id: 'real-wallet-asset-health'/);
  assert.match(traceSource, /build\/express-checkout\.js/);
  assert.match(traceSource, /npm', \['run', 'build:webpack'\]/);
  assert.match(traceSource, /profile_publishable_key/);
  assert.match(traceSource, /stripe_publishable_key/);
  assert.match(traceSource, /homeboy_stripe_ece_asset_src_or_empty_data_uri/);
  assert.match(traceSource, /data:" \. \$mime_type \. ","/);
});

test('grouped wallet layout summary catches collapsed and wrapped grouped containers', () => {
  assert.equal(
    groupedWalletLayoutSummary({
      ece_render_wallets_link_present: true,
      ece_render_final_container_height: 48,
      ece_render_final_wallets_link_width: 360,
      ece_render_final_wallets_link_height: 48,
      ece_render_final_apple_pay_height: 48,
      ece_render_final_google_pay_height: 48,
      ece_render_final_link_height: 48,
    }).dimensionsPass,
    true
  );
  assert.equal(
    groupedWalletLayoutSummary({
      ece_render_wallets_link_present: true,
      ece_render_final_container_height: 0,
      ece_render_final_wallets_link_width: 360,
      ece_render_final_wallets_link_height: 0,
      ece_render_final_apple_pay_height: 48,
      ece_render_final_google_pay_height: 48,
      ece_render_final_link_height: 48,
    }).dimensionsPass,
    false
  );
  assert.equal(
    groupedWalletLayoutSummary({
      ece_render_wallets_link_present: true,
      ece_render_final_container_height: 160,
      ece_render_final_wallets_link_width: 360,
      ece_render_final_wallets_link_height: 144,
      ece_render_final_apple_pay_height: 48,
      ece_render_final_google_pay_height: 48,
      ece_render_final_link_height: 48,
    }).dimensionsPass,
    false
  );
});

test('fixture bootstrap forces a tiny Woo-compatible classic theme', () => {
  const fixtureBootstrapPath = path.join(__dirname, 'fixture-bootstrap.php');
  const fixtureBootstrapSource = readFileSync(fixtureBootstrapPath, 'utf8');

  assert.match(fixtureBootstrapSource, /ensure_classic_woocommerce_theme/);
  assert.match(fixtureBootstrapSource, /add_theme_support\( 'woocommerce' \)/);
  assert.match(fixtureBootstrapSource, /switch_theme\( 'homeboy-stripe-ece-classic' \)/);
});
