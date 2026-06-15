export const DEFAULT_PROFILE = 'smoke';
export const REAL_WALLET_PROFILE = 'real-wallet';
export const WEBPERF_DESKTOP_LOAD_PROFILE = 'webperf-desktop-load';
export const WEBPERF_DESKTOP_SLOW_4G_PROFILE = 'webperf-desktop-slow-4g';
export const WEBPERF_STRIPE_HINTS_NONE_PROFILE = 'webperf-stripe-hints-none';
export const WEBPERF_STRIPE_PRECONNECT_PROFILE = 'webperf-stripe-preconnect';
export const WEBPERF_STRIPE_JS_PRELOAD_PROFILE = 'webperf-stripe-js-preload';
export const WEBPERF_STRIPE_DEFERRED_PRECONNECT_PROFILE = 'webperf-stripe-deferred-preconnect';

const STRIPE_HINT_ORIGINS = [
  'https://js.stripe.com',
  'https://api.stripe.com',
  'https://m.stripe.network',
];

const STRIPE_JS_URL = 'https://js.stripe.com/v3/';

const DESKTOP_BROWSER_PROBE_ARGS = [
  'browser=chromium',
  'device=Desktop Chrome',
  'locale=en-US',
  'timezone=America/New_York',
  'mobile=0',
  'touch=0',
];

const STRUCTURAL_BROWSER_ASSERTIONS = [
  'assert=advisory:no-page-errors',
  'assert=advisory:exists:#wc-stripe-express-checkout-element',
  'assert=request-count-by-type:document>=1',
  'assert=metric:browser_resource_count>=1',
];

const WEBPERF_BROWSER_ASSERTIONS = [
  ...STRUCTURAL_BROWSER_ASSERTIONS,
  'assert=metric:browser_nav_duration_ms>=0',
  'assert=metric:browser_ttfb_ms>=0',
  'assert=metric:browser_fcp_ms>=0',
  'assert=metric:browser_lcp_ms>=0',
];

const PROFILE_METADATA = {
  [DEFAULT_PROFILE]: {
    label: 'Smoke',
    caveat: 'Smoke profile uses WP Codebox browser-probe defaults; use it for rig health, not browser performance conclusions.',
    conclusion: 'Rig health and fixture availability only.',
  },
  'secure-browser': {
    label: 'Secure desktop browser',
    caveat: 'Secure-browser profile exercises preview/browser visibility contracts; use it for secure-context plumbing evidence.',
    conclusion: 'Secure preview routing and browser-visible integration behavior.',
  },
  [REAL_WALLET_PROFILE]: {
    label: 'Real-wallet desktop browser',
    caveat: 'Real-wallet profile depends on live Stripe keys, HTTPS preview routing, wallet eligibility, and third-party variance.',
    conclusion: 'Wallet-capable ECE behavior under real Stripe configuration.',
  },
  [WEBPERF_DESKTOP_LOAD_PROFILE]: {
    label: 'Desktop load',
    caveat: 'Desktop load profile uses a desktop browser context without synthetic CPU/network throttle; use it for normal-ish absolute load timings, not stable synthetic fan-out deltas.',
    conclusion: 'Non-throttled desktop LCP/FCP/TTFB/load/navigation timing shape.',
  },
  [WEBPERF_DESKTOP_SLOW_4G_PROFILE]: {
    label: 'Desktop slow 4G',
    caveat: 'Desktop slow-4g profile keeps desktop rendering while applying deterministic low-end-mobile-slow-4g throttle; use it for stable synthetic third-party fan-out deltas, not absolute desktop timings.',
    conclusion: 'Stable synthetic third-party response fan-out and relative waterfall deltas.',
  },
  [WEBPERF_STRIPE_HINTS_NONE_PROFILE]: {
    label: 'Stripe hints baseline',
    caveat: 'Stripe hints baseline uses the slow-4g webperf browser profile without preconnect, preload, or deferred ECE startup.',
    conclusion: 'Opt-in no-hint control for Stripe hint experiments.',
  },
  [WEBPERF_STRIPE_PRECONNECT_PROFILE]: {
    label: 'Stripe preconnect',
    caveat: 'Stripe preconnect profile warms Stripe origins during product-page head parsing; compare against the no-hint control for visible-load regressions.',
    conclusion: 'Opt-in Stripe origin connection warming experiment.',
  },
  [WEBPERF_STRIPE_JS_PRELOAD_PROFILE]: {
    label: 'Stripe.js preload',
    caveat: 'Stripe.js preload profile models an aggressive Stripe.js script preload and may compete with product-page critical resources.',
    conclusion: 'Opt-in Stripe.js preload experiment for readiness versus visible-load tradeoffs.',
  },
  [WEBPERF_STRIPE_DEFERRED_PRECONNECT_PROFILE]: {
    label: 'Deferred ECE plus Stripe preconnect',
    caveat: 'Deferred ECE plus preconnect profile warms Stripe origins while deferring Woo Stripe Express Checkout script execution.',
    conclusion: 'Opt-in deferred ECE startup with connection warming experiment.',
  },
};

const SYNTHETIC_FANOUT_PUBLISHABLE_KEY = 'pk_test_TYooMQauvdEDq54NiTphI7jx';

function profileMetadata(profile) {
  return PROFILE_METADATA[profile] || PROFILE_METADATA[DEFAULT_PROFILE];
}

export function setting(name, defaultValue = '') {
  const envName = `HOMEBOY_SETTINGS_${name.toUpperCase()}`;
  if (process.env[envName]) {
    return process.env[envName];
  }

  try {
    const settings = JSON.parse(process.env.HOMEBOY_SETTINGS_JSON || '{}');
    return settings[name] ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

export function eceBrowserProfile() {
  return setting('woocommerce_stripe_ece_browser_profile', process.env.HOMEBOY_WC_STRIPE_ECE_BROWSER_PROFILE || DEFAULT_PROFILE) || DEFAULT_PROFILE;
}

export function previewPort() {
  return setting('woocommerce_stripe_ece_preview_port', process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PORT || process.env.HOMEBOY_INVOCATION_PORT_BASE || '');
}

export function previewBind() {
  return setting('woocommerce_stripe_ece_preview_bind', process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_BIND || '127.0.0.1');
}

export function previewPublicUrl() {
  return setting('woocommerce_stripe_ece_preview_public_url', process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL || process.env.HOMEBOY_PREVIEW_PUBLIC_URL || '');
}

function requireSyntheticFanoutProof() {
  return ['1', 'true', 'yes'].includes(
    String(setting('woocommerce_stripe_ece_require_fanout_proof', process.env.HOMEBOY_WC_STRIPE_REQUIRE_FANOUT_PROOF || '')).toLowerCase()
  );
}

function syntheticFanoutPublishableKey() {
  return process.env.HOMEBOY_WC_STRIPE_SYNTHETIC_PUBLISHABLE_KEY || SYNTHETIC_FANOUT_PUBLISHABLE_KEY;
}

function profileHintStrategy(profile) {
  const configured = setting('woocommerce_stripe_ece_hint_strategy', process.env.HOMEBOY_WC_STRIPE_ECE_HINT_STRATEGY || '').trim();
  if (configured) {
    return configured;
  }

  switch (profile) {
    case WEBPERF_STRIPE_PRECONNECT_PROFILE:
      return 'stripe-preconnect';
    case WEBPERF_STRIPE_JS_PRELOAD_PROFILE:
      return 'stripe-js-preload';
    case WEBPERF_STRIPE_DEFERRED_PRECONNECT_PROFILE:
      return 'stripe-deferred-preconnect';
    default:
      return 'none';
  }
}

function buildHintOptions(strategy) {
  const preconnectLinks = ['stripe-preconnect', 'stripe-js-preload', 'stripe-deferred-preconnect'].includes(strategy)
    ? STRIPE_HINT_ORIGINS.map((href) => ({ rel: 'preconnect', href, crossorigin: true }))
    : [];
  const preloadLinks = strategy === 'stripe-js-preload'
    ? [{ rel: 'preload', href: STRIPE_JS_URL, as: 'script', crossorigin: true }]
    : [];

  return {
    hintStrategy: strategy,
    hintLinks: [...preconnectLinks, ...preloadLinks],
    deferExpressCheckoutScript: strategy === 'stripe-deferred-preconnect',
  };
}

function webperfProfileOptions(profile, metadata, { throttleProfile = null, hintStrategy = 'none' } = {}) {
  const fanoutProof = requireSyntheticFanoutProof();
  const hintOptions = buildHintOptions(hintStrategy);

  return {
    profile,
    profileLabel: metadata.label,
    profileCaveat: metadata.caveat,
    profileConclusion: metadata.conclusion,
    throttleProfile,
    realWalletCapable: false,
    syntheticOnly: true,
    stripePublishableKey: fanoutProof ? syntheticFanoutPublishableKey() : null,
    stripeSecretKey: null,
    runtimePreview: null,
    recipeRunArgs: [],
    browserProbeArgs: [
      ...DESKTOP_BROWSER_PROBE_ARGS,
      ...(throttleProfile ? [`throttle=${throttleProfile}`] : []),
    ],
    browserProbeAssertions: WEBPERF_BROWSER_ASSERTIONS,
    waitFor: 'load',
    ...hintOptions,
  };
}

function validateHttpsPublicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function requireRealWalletProfileEnv(publicUrl) {
  const missing = ['STRIPE_PUBLISHABLE_KEY', 'STRIPE_SECRET_KEY'].filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`real-wallet profile requires ${missing.join(' and ')} to render real Stripe Express Checkout wallet evidence.`);
  }

  if (!publicUrl) {
    throw new Error('real-wallet profile requires HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL or HOMEBOY_PREVIEW_PUBLIC_URL to be set to an HTTPS public preview origin.');
  }

  if (!validateHttpsPublicUrl(publicUrl)) {
    throw new Error('real-wallet profile requires HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL or HOMEBOY_PREVIEW_PUBLIC_URL to be an HTTPS public preview origin, not localhost or plain HTTP.');
  }
}

export function buildEceProfileOptions(profile = eceBrowserProfile()) {
  const metadata = profileMetadata(profile);
  const hintStrategy = profileHintStrategy(profile);

  if (profile === WEBPERF_DESKTOP_LOAD_PROFILE) {
    return webperfProfileOptions(profile, metadata, { hintStrategy });
  }

  if ([
    WEBPERF_DESKTOP_SLOW_4G_PROFILE,
    WEBPERF_STRIPE_HINTS_NONE_PROFILE,
    WEBPERF_STRIPE_PRECONNECT_PROFILE,
    WEBPERF_STRIPE_JS_PRELOAD_PROFILE,
    WEBPERF_STRIPE_DEFERRED_PRECONNECT_PROFILE,
  ].includes(profile)) {
    return webperfProfileOptions(profile, metadata, {
      throttleProfile: 'low-end-mobile-slow-4g',
      hintStrategy,
    });
  }

  if (!['secure-browser', REAL_WALLET_PROFILE].includes(profile)) {
    return {
      profile,
      profileLabel: metadata.label,
      profileCaveat: metadata.caveat,
      profileConclusion: metadata.conclusion,
      throttleProfile: null,
      realWalletCapable: false,
      syntheticOnly: true,
      stripePublishableKey: null,
      stripeSecretKey: null,
      runtimePreview: null,
      recipeRunArgs: [],
      browserProbeArgs: [],
      browserProbeAssertions: STRUCTURAL_BROWSER_ASSERTIONS,
      waitFor: null,
      ...buildHintOptions(hintStrategy),
    };
  }

  const port = previewPort();
  const bind = previewBind();
  const publicUrl = previewPublicUrl();

  if (profile === REAL_WALLET_PROFILE) {
    requireRealWalletProfileEnv(publicUrl);
  }

  const runtimePreview = {
    ...(port ? { port: Number.parseInt(port, 10) } : {}),
    ...(bind ? { bind } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  };

  return {
    profile,
    profileLabel: metadata.label,
    profileCaveat: metadata.caveat,
    profileConclusion: metadata.conclusion,
    throttleProfile: null,
    realWalletCapable: profile === REAL_WALLET_PROFILE,
    syntheticOnly: profile !== REAL_WALLET_PROFILE,
    stripePublishableKey: profile === REAL_WALLET_PROFILE ? process.env.STRIPE_PUBLISHABLE_KEY : null,
    stripeSecretKey: profile === REAL_WALLET_PROFILE ? process.env.STRIPE_SECRET_KEY : null,
    runtimePreview: Object.keys(runtimePreview).length > 0 ? runtimePreview : null,
    recipeRunArgs: [
      ...(port ? ['--preview-port', port] : []),
      ...(bind ? ['--preview-bind', bind] : []),
      ...(publicUrl ? ['--preview-public-url', publicUrl] : []),
    ],
    browserProbeArgs: DESKTOP_BROWSER_PROBE_ARGS,
    browserProbeAssertions: STRUCTURAL_BROWSER_ASSERTIONS,
    waitFor: null,
    ...buildHintOptions(hintStrategy),
  };
}
