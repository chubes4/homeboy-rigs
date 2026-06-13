export const ECE_WALLET_METHODS = ['apple_pay', 'google_pay', 'link'];

export const ECE_FANOUT_REVIEWER_READY = 'reviewer-ready fanout proof';
export const ECE_FANOUT_SUPPLEMENTAL = 'supplemental smoke only';

function includesAll(values, expected) {
  return expected.every((value) => values.includes(value));
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function groupedWalletLayoutSummary(metrics = {}) {
  const groupedPresent = metrics.ece_render_wallets_link_present === true;
  const groupedWidth = metrics.ece_render_final_wallets_link_width;
  const groupedHeight = metrics.ece_render_final_wallets_link_height;
  const maxWalletHeight = Math.max(
    0,
    metrics.ece_render_final_apple_pay_height || 0,
    metrics.ece_render_final_google_pay_height || 0,
    metrics.ece_render_final_link_height || 0
  );
  const singleRowHeightLimit = maxWalletHeight > 0 ? maxWalletHeight + 12 : 80;
  const dimensionsPass =
    groupedPresent &&
    positiveNumber(groupedWidth) &&
    positiveNumber(groupedHeight) &&
    groupedHeight <= singleRowHeightLimit &&
    (!positiveNumber(metrics.ece_render_final_container_height) || metrics.ece_render_final_container_height >= groupedHeight);

  return {
    groupedPresent,
    groupedWidth,
    groupedHeight,
    maxWalletHeight,
    singleRowHeightLimit,
    dimensionsPass,
  };
}

function walletEvidence(method, input) {
  const requested = input.requestedPaymentMethods.includes(method);
  const rendered = input.renderedWallets?.[method] === true;
  const observed = input.observedWallets?.[method] === true || rendered;
  const secureContext = input.browserEligibility?.secureContext === true;
  const paymentRequestSupported = input.browserEligibility?.paymentRequestSupported === true;
  const applePaySessionSupported = input.browserEligibility?.applePaySessionSupported === true;

  const eligible =
    method === 'apple_pay'
      ? secureContext && applePaySessionSupported
      : method === 'google_pay'
        ? secureContext && paymentRequestSupported
        : secureContext;

  return {
    method,
    requested,
    eligible,
    rendered,
    observed,
  };
}

export function classifyEceWalletFanoutEvidence(input) {
  const requestedPaymentMethods = Array.isArray(input.requestedPaymentMethods) ? input.requestedPaymentMethods : [];
  const normalizedInput = {
    ...input,
    requestedPaymentMethods,
  };
  const wallets = Object.fromEntries(ECE_WALLET_METHODS.map((method) => [method, walletEvidence(method, normalizedInput)]));
  const reasonCodes = [];
  const requestedWalletFanout = includesAll(requestedPaymentMethods, ECE_WALLET_METHODS);
  const observedWalletFanout = ECE_WALLET_METHODS.every((method) => wallets[method].observed);

  if (!requestedWalletFanout) {
    reasonCodes.push('wallet_fanout_not_requested');
  }

  if (input.realWalletCapable && input.browserEligibility?.secureContext !== true) {
    reasonCodes.push('browser_not_secure_context');
  }

  for (const method of ECE_WALLET_METHODS) {
    if (input.realWalletCapable && wallets[method].requested && !wallets[method].eligible) {
      reasonCodes.push(`${method}_browser_not_eligible`);
    }
    if (input.syntheticOnly !== true && wallets[method].requested && !wallets[method].observed) {
      reasonCodes.push(`${method}_not_observed`);
    }
  }

  const validFanoutProof = requestedWalletFanout && (input.syntheticOnly === true || observedWalletFanout);
  if (requestedWalletFanout && !validFanoutProof) {
    reasonCodes.push('wallet_fanout_not_observed');
  }

  if (requestedWalletFanout && input.eceConstructed === false) {
    reasonCodes.push('ece_not_constructed');
  }

  const constructedEnough = input.eceConstructed !== false;
  const classification = validFanoutProof && constructedEnough ? ECE_FANOUT_REVIEWER_READY : ECE_FANOUT_SUPPLEMENTAL;

  return {
    classification,
    valid_fanout_proof: validFanoutProof && constructedEnough,
    requested_wallet_fanout: requestedWalletFanout,
    observed_wallet_fanout: observedWalletFanout,
    reason_codes: [...new Set(reasonCodes)],
    wallets,
  };
}
