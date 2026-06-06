export const DEFAULT_PROFILE = 'smoke';
export const REAL_WALLET_PROFILE = 'real-wallet';

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
  return setting('woocommerce_stripe_ece_preview_public_url', process.env.HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL || '');
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
    throw new Error('real-wallet profile requires HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL to be set to an HTTPS public preview origin.');
  }

  if (!validateHttpsPublicUrl(publicUrl)) {
    throw new Error('real-wallet profile requires HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL to be an HTTPS public preview origin, not localhost or plain HTTP.');
  }
}

export function buildEceProfileOptions(profile = eceBrowserProfile()) {
  if (!['secure-browser', REAL_WALLET_PROFILE].includes(profile)) {
    return {
      profile,
      realWalletCapable: false,
      syntheticOnly: true,
      stripePublishableKey: null,
      stripeSecretKey: null,
      runtimePreview: null,
      recipeRunArgs: [],
      browserProbeArgs: [],
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
    browserProbeArgs: [
      'browser=chromium',
      'device=Desktop Chrome',
      'locale=en-US',
      'timezone=America/New_York',
      'mobile=0',
      'touch=0',
    ],
  };
}
