function finiteRoundedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const rounded = finiteRoundedNumber(value);
    if (rounded !== null) {
      return rounded;
    }
  }

  return null;
}

function entryUrl(entry) {
  return entry?.url || entry?.request?.url || entry?.response?.url || '';
}

function entryResourceType(entry) {
  return entry?.resourceType || entry?.request?.resourceType || entry?.type || '';
}

function entryTimingMs(entry) {
  return firstNumber(
    entry?.responseEnd,
    entry?.response?.responseEnd,
    entry?.endTime,
    entry?.response?.endTime,
    entry?.t_ms,
    entry?.time_ms,
    entry?.timestamp_ms,
    entry?.startTime,
    entry?.request?.startTime
  );
}

function isStripeJsEntry(entry) {
  const url = entryUrl(entry);
  if (!/https?:\/\/js\.stripe\.com\//i.test(url)) {
    return false;
  }

  const resourceType = entryResourceType(entry);
  return !resourceType || /script|response|request/i.test(resourceType) || /\.js(?:\?|$|#)/i.test(url);
}

function normalizeMethod(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

function normalizeMethods(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeMethods(entry));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).filter((key) => value[key] !== false).map(normalizeMethod).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map(normalizeMethod).filter(Boolean);
  }

  return [];
}

function uniqueMethods(values) {
  return [...new Set(values.flatMap((value) => normalizeMethods(value)))];
}

export function summarizeEceReadinessMetrics({ metrics = {}, networkEntries = [], walletFanoutEvidence = {} } = {}) {
  const requestedMethods = uniqueMethods([metrics.ece_requested_accepted_payment_methods]);
  const createdMethods = uniqueMethods([metrics.ece_create_payment_methods]);
  const walletMethods = Object.keys(walletFanoutEvidence.wallets || {}).map(normalizeMethod).filter(Boolean);
  const methodSet = new Set([...requestedMethods, ...createdMethods, ...walletMethods]);
  const paymentMethodDetails = [...methodSet].sort().map((method) => {
    const wallet = walletFanoutEvidence.wallets?.[method] || null;

    return {
      method,
      requested: requestedMethods.includes(method) || wallet?.requested === true,
      created: createdMethods.includes(method),
      eligible: wallet?.eligible ?? null,
      rendered: wallet?.rendered ?? null,
      observed: wallet?.observed ?? null,
    };
  });
  const observedPaymentMethods = paymentMethodDetails.filter((entry) => entry.observed === true).map((entry) => entry.method);
  const renderedPaymentMethods = paymentMethodDetails.filter((entry) => entry.rendered === true).map((entry) => entry.method);

  return {
    ece_ready_ms: firstNumber(
      metrics.ece_render_first_visible_button_ms,
      metrics.ece_render_first_visible_iframe_ms,
      metrics.ece_render_first_iframe_ms,
      metrics.ece_render_first_child_ms,
      metrics.ece_render_container_visible_ms,
      metrics.ece_render_container_seen_ms
    ),
    ece_visible_ms: firstNumber(metrics.ece_render_container_visible_ms),
    ece_first_iframe_ms: firstNumber(metrics.ece_render_first_iframe_ms),
    stripe_js_loaded_ms: firstNumber(
      metrics.stripe_js_available_ms,
      ...networkEntries.filter(isStripeJsEntry).map(entryTimingMs)
    ),
    ece_available_payment_methods: {
      requested: requestedMethods,
      created: createdMethods,
      rendered: renderedPaymentMethods,
      observed: observedPaymentMethods,
    },
    ece_available_payment_method_details: paymentMethodDetails,
  };
}
