# Checkout Shipping Cache Matrix Report

This is the report shell for WooCommerce shipping-cache fuzz evidence packages.
It is safe to paste into WooCommerce PR comments after replacing planned rows
with real baseline/candidate artifacts.

Generate the current report shape locally:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs
```

The domain matrix lives in
`woocommerce/woocommerce/tools/checkout-shipping-cache-matrix.json`; the report
script only renders that data plus optional workload artifacts. This keeps the
Woo-specific matrix shape close to the future Homeboy core evidence-matrix
primitive without depending on unreleased core.

Generate from one exported artifact directory:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs \
  --input /tmp/woocommerce-shipping-cache-artifacts
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

homeboy fuzz run --rig woocommerce-performance --workload checkout-shipping-cache --run-id woocommerce-shipping-cache-40x1 --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload checkout-shipping-cache --run-id woocommerce-shipping-cache-40x8 --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload checkout-shipping-cache --run-id woocommerce-shipping-cache-200x8 --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload checkout-shipping-cache --run-id woocommerce-shipping-cache-200x40 --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload checkout-shipping-cache --run-id woocommerce-shipping-cache-1000x40 --seed 1 --max-duration 15m
```

## Dependency Blockers

- Extra-Chill/homeboy#3516 is needed before this report can consume canonical
  Homeboy baseline/candidate exports directly from the run corpus.
- Extra-Chill/homeboy-extensions#1089 added deterministic expensive shipping
  method fixture support for the matrix dimension.
