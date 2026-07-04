export function validatePortableSource({ rel, contents }) {
  if (rel !== 'woocommerce/woocommerce-gateway-stripe/bench/ece-product-page-waterfall.trace.mjs') {
    return [];
  }

  if (!/Developer\/woocommerce\/plugins\/woocommerce/.test(contents)) {
    return [];
  }

  return [`${rel}: Woo Stripe ECE workload must use the declared WooCommerce component/env path instead of a local Developer fallback`];
}
