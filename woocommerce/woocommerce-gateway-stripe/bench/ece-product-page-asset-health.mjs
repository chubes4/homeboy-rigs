function entryUrl(entry) {
  return entry?.url || entry?.request?.url || entry?.response?.url || '';
}

function entryStatus(entry) {
  return entry?.status ?? entry?.response?.status ?? entry?.responseStatus ?? null;
}

function entryFailureText(entry) {
  return [entry?.errorText, entry?.failure?.errorText, entry?.response?.errorText, entry?.message, entry?.text]
    .filter(Boolean)
    .join(' ');
}

function isCriticalAssetUrl(url) {
  if (!/\.(?:js|css)(?:\?|$)/i.test(url)) {
    return false;
  }

  return /\/wp-content\/plugins\/(?:woocommerce-gateway-stripe|woocommerce)\//.test(url);
}

function assetLabel(url) {
  const match = /\/wp-content\/plugins\/([^?#]+)/.exec(url);
  return match ? `/wp-content/plugins/${match[1]}` : url;
}

function assetFailure(entry) {
  const status = entryStatus(entry);
  const failureText = entryFailureText(entry);

  if (typeof status === 'number' && status >= 400) {
    return `HTTP ${status}`;
  }

  if (/net::ERR_|ERR_ABORTED|failed|aborted|blocked/i.test(failureText)) {
    return failureText || 'request failed';
  }

  return '';
}

function metricNumber(metrics, key) {
  const value = metrics?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function evaluateEceRealWalletAssetHealth({ networkEntries = [], metrics = {}, profileOptions = {} } = {}) {
  const failures = [];

  if (profileOptions.realWalletCapable !== true) {
    return {
      ok: true,
      failures,
      details: {
        checked: false,
      },
    };
  }

  const failedAssets = networkEntries
    .map((entry) => ({ entry, url: entryUrl(entry), reason: assetFailure(entry) }))
    .filter(({ url, reason }) => url && reason && isCriticalAssetUrl(url));
  const failedAssetLabels = failedAssets.map(({ url, reason }) => `${assetLabel(url)} (${reason})`);

  if (failedAssetLabels.length > 0) {
    failures.push(`Critical Woo/ECE frontend assets failed to load: ${failedAssetLabels.slice(0, 8).join('; ')}.`);
  }

  if (metricNumber(metrics, 'stripe_elements_session_response_count') < 1) {
    failures.push('Real-wallet ECE did not start a Stripe Elements session request.');
  }

  const peakChildCount = metricNumber(metrics, 'ece_render_peak_child_count');
  const peakIframeCount = metricNumber(metrics, 'ece_render_peak_iframe_count');
  const peakVisibleButtonCount = metricNumber(metrics, 'ece_render_peak_visible_button_count');
  if (peakChildCount < 1 && peakIframeCount < 1 && peakVisibleButtonCount < 1) {
    failures.push('Real-wallet ECE render probe never observed ECE children, iframes, or visible buttons.');
  }

  return {
    ok: failures.length === 0,
    failures,
    details: {
      checked: true,
      failed_asset_count: failedAssets.length,
      failed_assets: failedAssetLabels.slice(0, 20),
      stripe_elements_session_response_count: metricNumber(metrics, 'stripe_elements_session_response_count'),
      ece_render_peak_child_count: peakChildCount,
      ece_render_peak_iframe_count: peakIframeCount,
      ece_render_peak_visible_button_count: peakVisibleButtonCount,
    },
  };
}

export function realWalletAssetHealthSummary(health) {
  if (health.ok) {
    return health.details?.checked === false ? 'Real-wallet asset health was not required for this profile.' : 'Real-wallet Woo Stripe ECE asset health passed.';
  }

  return `Real-wallet Woo Stripe ECE asset health failed: ${health.failures.join(' ')}`;
}
