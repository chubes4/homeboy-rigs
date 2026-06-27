import { assertRequiredFuzzProofContracts } from '../../../scripts/fuzz-manifest-helpers.mjs';

export const wooRequiredFuzzProofContracts = new Map([
  ['cart-session-overwrite-race', ['cart-session-race']],
  ['checkout-gateway-compatibility-matrix', ['gateway-compatibility']],
  ['checkout-shipping-cache', ['shipping-cache-invalidation']],
  ['frontend-rendering-request-coverage', ['shop-product-cart-checkout-rendering-requests']],
  ['layered-nav-catalog-crawl', ['catalog-layered-nav-transient-growth']],
  ['layered-nav-count-cache', ['layered-nav-transient-growth']],
  ['options-transients-coverage', ['cache-invalidation-and-transient-growth']],
  ['performance-hotspots-artifact-summary', ['artifact-summary-expectations']],
  ['woocommerce-external-http-guardrail', ['external-http-guardrails']],
]);

export function assertWooRequiredFuzzProofContracts(manifest, options = {}) {
  return assertRequiredFuzzProofContracts(manifest, {
    requiredContracts: wooRequiredFuzzProofContracts.get(manifest.id) || [],
    ...options,
  });
}
