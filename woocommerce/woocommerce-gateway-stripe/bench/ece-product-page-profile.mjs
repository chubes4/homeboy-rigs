const DEFAULT_PROFILE = 'smoke';

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

export function buildEceProfileOptions(profile = eceBrowserProfile()) {
  if (profile !== 'secure-browser') {
    return {
      profile,
      runtimePreview: null,
      recipeRunArgs: [],
      browserProbeArgs: [],
    };
  }

  const port = previewPort();
  const bind = previewBind();
  const publicUrl = previewPublicUrl();
  const runtimePreview = {
    ...(port ? { port: Number.parseInt(port, 10) } : {}),
    ...(bind ? { bind } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  };

  return {
    profile,
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
