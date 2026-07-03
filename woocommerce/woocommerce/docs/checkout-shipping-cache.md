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
6. Measures one cold `WC()->shipping()->calculate_shipping()` pass after clearing known
   session cache keys.
7. Measures repeated warm passes against the same package hash.
8. Measures field-specific churn for package fields that should not matter to
   shipping rates: `subtotal`, `total`, `package_id`, `package_name`, `rates`,
   and `package_index`.
9. Preserves the legacy aggregate `total_churn_*` rows for existing dashboards.
10. Measures real rehash guardrails for shipping-relevant inputs:
   destination/postcode and `contents_cost`.
11. Measures a synthetic unknown package key that should invalidate by default.
12. Adds a filter-extension guardrail for
   `woocommerce_shipping_package_hash_ignored_fields`, proving the synthetic key
   can be excluded once WooCommerce exposes that ignored-fields filter.
13. Writes raw timing rows to `HOMEBOY_BENCH_SHARED_STATE` when provided.

## Runner Prep

Before running the workload, `homeboy rig check woocommerce-performance` verifies
that the runner has:

- A WooCommerce monorepo checkout supplied through the rig component path settings.
- The WooCommerce plugin path inside that checkout, typically `plugins/woocommerce` for the monorepo layout.
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
- `WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS=3`
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

Each row now includes:

```json
{
  "label": "subtotal_churn_1",
  "phase_type": "field_churn",
  "churn_field": "subtotal",
  "elapsed_ms": 1.23,
  "package_count": 8,
  "rate_count": 8,
  "rate_calculation_calls": 0,
  "cache_invalidated": false,
  "session_cache_keys": ["shipping_for_package_0"]
}
```

The summary retains legacy keys such as `warm_shipping_p50_ms`,
`total_churn_rate_calculation_calls`, and `rehash_rate_calculation_calls`, and
adds explicit `per_churn_metrics` entries plus flattened reviewer-facing counters
such as `subtotal_churn_rate_calculation_calls`,
`destination_postcode_rehash_rate_calculation_calls`,
`unknown_package_key_rehash_rate_calculation_calls`, and
`filter_ignored_unknown_package_key_rate_calculation_calls`.

Reviewer-facing smoke command/result shape:

```bash
homeboy bench \
  --rig woocommerce-performance \
  --scenario checkout-shipping-cache \
  --iterations 1 \
  --shared-state /tmp/woocommerce-shipping-cache-323 \
  --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"40","WC_SHIPPING_CACHE_PACKAGES":"8","WC_SHIPPING_CACHE_WARM_RUNS":"2","WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS":"1","WC_SHIPPING_CACHE_REHASH_RUNS":"1"}'
```

Expected result shape: one cold row, `warm_*` rows, field-specific
`*_churn_*` rows for subtotal/package metadata, `total_field_churn_*` rows,
legacy `total_churn_*` rows, real-input `*_rehash_*` guardrail rows, `rehash_*` rows, and
`filter_ignored_unknown_package_key_*` rows. The unknown-key guardrail should
show invalidation by default; the filter-extension row should drop back to warm
cache behavior once WooCommerce honors
`woocommerce_shipping_package_hash_ignored_fields`.

## Matrix Report

Use `tools/checkout-shipping-cache-matrix-report.mjs` to generate the compact
Markdown report shell and to summarize real shared-state artifacts when they are
available:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs \
  --input /tmp/woocommerce-performance-bench
```

The report keeps timing evidence separate from shipping-rate call-count evidence
and leaves baseline/candidate red-green deltas empty unless real artifacts are
provided.

## Current TODOs

- Add a browser checkout Store API or shortcode checkout variant after the direct
  server-side signal is stable.
- Promote repeated cart/product/shipping seed helpers into Homeboy Extensions'
  WordPress package only after a second WooCommerce workload needs them.
- Add an upstream WooCommerce issue/PR comment template once artifact hosting for
  this rig is settled.
