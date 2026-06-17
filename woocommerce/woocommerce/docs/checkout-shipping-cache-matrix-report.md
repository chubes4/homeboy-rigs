# Checkout Shipping Cache Matrix Report

This is the report shell for WooCommerce shipping-cache evidence packages. It is
safe to paste into WooCommerce PR comments after replacing planned rows with real
baseline/candidate artifacts.

Generate the current report shape locally:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs
```

The domain matrix lives in
`woocommerce/woocommerce/tools/checkout-shipping-cache-matrix.json`; the report
script only renders that data plus optional workload artifacts. This keeps the
Woo-specific matrix shape close to the future Homeboy core evidence-matrix
primitive without depending on unreleased core.

Generate from one shared-state directory:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs \
  --input /tmp/woocommerce-performance-bench
```

Generate baseline/candidate deltas when Homeboy comparison/export artifacts are
available:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs \
  --baseline /tmp/woocommerce-performance-baseline \
  --candidate /tmp/woocommerce-performance-candidate
```

## Matrix Commands

```bash
homeboy rig up woocommerce-performance
homeboy rig check woocommerce-performance

homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-40x1 --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"40","WC_SHIPPING_CACHE_PACKAGES":"1","WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS":"3"}'
homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-40x8 --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"40","WC_SHIPPING_CACHE_PACKAGES":"8","WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS":"3"}'
homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-200x8 --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"200","WC_SHIPPING_CACHE_PACKAGES":"8","WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS":"5"}' --force-hot
homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-200x40 --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"200","WC_SHIPPING_CACHE_PACKAGES":"40","WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS":"5"}' --force-hot
homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-1000x40 --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"1000","WC_SHIPPING_CACHE_PACKAGES":"40","WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS":"5"}' --force-hot
```

## Dependency Blockers

- Extra-Chill/homeboy#3516 is needed before this report can consume canonical
  Homeboy baseline/candidate exports instead of local shared-state directories.
- Extra-Chill/homeboy-extensions#1089 added deterministic expensive shipping
  method fixture support for the matrix dimension.
