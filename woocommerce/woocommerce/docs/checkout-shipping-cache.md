# Checkout Shipping Cache Workload

`checkout-shipping-cache` is the first WooCommerce performance rig workload for
large-merchant checkout/shipping cache bugs.

## Issue Links

- https://github.com/woocommerce/woocommerce/issues/49259
- https://github.com/woocommerce/woocommerce/issues/32055
- https://github.com/woocommerce/woocommerce/issues/26569

## What It Does

The workload runs inside Homeboy Extensions' `wordpress.bench` runtime with the
local WooCommerce checkout mounted as an active plugin.

It performs this practical first slice:

1. Verifies WooCommerce is loaded and the cart/session APIs are available.
2. Seeds configurable simple physical products with deterministic SKUs.
3. Configures WooCommerce base/customer location and a flat-rate US shipping zone.
4. Builds a cart with configurable line-item cardinality.
5. Splits cart contents into configurable synthetic shipping packages with the
   `woocommerce_cart_shipping_packages` filter.
6. Measures one cold `WC()->cart->calculate_shipping()` pass after clearing known
   session cache keys.
7. Measures repeated warm passes against the same package hash.
8. Measures repeated address/postcode changes that force package-hash rechecks.
9. Writes raw timing rows to `HOMEBOY_BENCH_SHARED_STATE` when provided.

## Runner Prep

Before running the workload, `homeboy rig check woocommerce-performance` verifies
that the runner has:

- The WooCommerce monorepo checkout at `~/Developer/woocommerce`.
- The plugin path at `~/Developer/woocommerce/plugins/woocommerce`.
- Composer-generated PHP dependencies, especially `vendor/autoload_packages.php`.
- Generated feature config at `includes/react-admin/feature-config.php`.

Use the rig-owned prep pipeline when dependency artifacts are missing:

```bash
homeboy rig up woocommerce-performance
homeboy rig check woocommerce-performance
```

This intentionally avoids browser checkout automation in the first pass. The
target bug cluster is the server-side shipping cache path, and direct WooCommerce
cart/checkout API calls make the signal faster and less brittle while still using
real WooCommerce internals.

## Settings

The rig sets conservative defaults through `bench_env`:

- `WC_SHIPPING_CACHE_CART_ITEMS=40`
- `WC_SHIPPING_CACHE_PACKAGES=8`
- `WC_SHIPPING_CACHE_WARM_RUNS=5`
- `WC_SHIPPING_CACHE_REHASH_RUNS=3`

Override them with Homeboy settings, for example:

```bash
homeboy bench \
  --rig woocommerce-performance \
  --scenario checkout-shipping-cache \
  --iterations 1 \
  --shared-state /tmp/woocommerce-performance-hot \
  --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"200","WC_SHIPPING_CACHE_PACKAGES":"40"}' \
  --force-hot
```

## Artifact Shape

When `HOMEBOY_BENCH_SHARED_STATE` is set, the workload writes:

```text
<shared-state>/checkout-shipping-cache/<run-id>.json
```

The artifact contains the run ID, issue URLs, seeded product IDs, shipping zone
ID, per-pass timing rows, session cache keys observed, and the same summary
metrics returned in the Homeboy BenchResults envelope.

## Current TODOs

- Add a browser checkout Store API or shortcode checkout variant after the direct
  server-side signal is stable.
- Promote repeated cart/product/shipping seed helpers into Homeboy Extensions'
  WordPress package only after a second WooCommerce workload needs them.
- Add an upstream WooCommerce issue/PR comment template once artifact hosting for
  this rig is settled.
