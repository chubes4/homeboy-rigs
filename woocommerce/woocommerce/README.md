# WooCommerce Performance Homeboy Rig

Durable Homeboy rig package for reproducing WooCommerce large-merchant
performance bugs in disposable WordPress/WooCommerce runtimes.

## Goals

- Exercise concrete WooCommerce checkout and shipping performance paths against a
  real mounted WooCommerce checkout.
- Capture bounded JSON metrics and artifacts that can be linked back to upstream
  WooCommerce issues and PRs.
- Keep reusable Homeboy or WordPress helper extraction out of the first rig until
  repeated WooCommerce workloads make the helper shape obvious.

## Tracked Bug Cluster

- https://github.com/woocommerce/woocommerce/issues/49259
- https://github.com/woocommerce/woocommerce/issues/32055
- https://github.com/woocommerce/woocommerce/issues/26569
- https://github.com/woocommerce/woocommerce/issues/17355
- https://github.com/woocommerce/woocommerce/issues/62659
- https://github.com/woocommerce/woocommerce/pull/65588
- https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929
- https://github.com/chubes4/homeboy-rigs/issues/255

## Install

```bash
homeboy rig install /Users/chubes/Developer/homeboy-rigs@<branch>/woocommerce/woocommerce
homeboy rig check woocommerce-performance
```

## Runner Prerequisites

The rig mounts a local WooCommerce checkout into the disposable WP Codebox
WordPress runtime. On local and Lab runners, the checkout must exist at:

```text
~/Developer/woocommerce/plugins/woocommerce
```

This path mirrors the WooCommerce monorepo layout after cloning
https://github.com/woocommerce/woocommerce into `~/Developer/woocommerce`.
Homeboy core Lab offload provisioning gaps are tracked in:

- https://github.com/Extra-Chill/homeboy/issues/3474
- https://github.com/Extra-Chill/homeboy/issues/3475
- https://github.com/Extra-Chill/homeboy/issues/3476

Fresh WooCommerce source checkouts also need PHP package dependencies and the
generated React admin feature config before the plugin can load in WP Codebox.
Run the rig-owned deterministic prep pipeline:

```bash
homeboy rig up woocommerce-performance
homeboy rig check woocommerce-performance
```

`homeboy rig up woocommerce-performance` is intentionally bounded:

- It runs `composer install --no-interaction --no-progress` only when
  `vendor/autoload_packages.php` is missing.
- It runs `php bin/generate-feature-config.php` only when
  `includes/react-admin/feature-config.php` is missing.
- It does not modify WooCommerce source files or switch branches.

Equivalent manual prep, when needed for debugging:

```bash
cd ~/Developer/woocommerce/plugins/woocommerce
XDEBUG_MODE=off composer install --no-interaction --no-progress
php bin/generate-feature-config.php
```

## Benchmark Commands

```bash
homeboy rig up woocommerce-performance
homeboy bench --rig woocommerce-performance --scenario checkout-gateway-compatibility-matrix --iterations 1 --shared-state /tmp/woocommerce-gateway-matrix
homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-bench
homeboy bench --rig woocommerce-performance --scenario layered-nav-count-cache --iterations 1 --shared-state /tmp/woocommerce-layered-nav-cache --setting-json 'bench_env={"WC_LAYERED_NAV_CACHE_ITERATIONS":"150","WC_LAYERED_NAV_CACHE_LIMIT":"25"}'
homeboy bench --rig woocommerce-performance --scenario layered-nav-catalog-crawl --iterations 1 --shared-state /tmp/woocommerce-layered-nav-crawl --setting-json 'bench_env={"WC_LAYERED_NAV_CRAWL_REQUESTS":"150","WC_LAYERED_NAV_CRAWL_LIMIT":"25"}'
homeboy bench --rig woocommerce-performance --profile hot --iterations 1 --shared-state /tmp/woocommerce-performance-hot --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"120","WC_SHIPPING_CACHE_PACKAGES":"24"}' --force-hot
```

`homeboy bench --rig woocommerce-performance` runs through Homeboy Extensions'
`wordpress.bench` / WP Codebox backend. WP Codebox owns the disposable WordPress
runtime, mounts WooCommerce as the runtime plugin, mounts the rig's PHP workload
into `tests/bench/`, and returns the normalized Homeboy `BenchResults` envelope.

## Current Workloads

- `checkout-gateway-compatibility-matrix` runs the duplicate-checkout/order
  idempotency repro across core BACS, Cheque, and COD gateway controls plus
  opportunistic real-plugin profiles for WooCommerce Stripe Gateway,
  WooCommerce PayPal Payments, and WooPayments when those plugin entrypoints are
  mounted in the WP Codebox runtime. It captures plugin activation/version
  details without secrets and links evidence to WooCommerce issue #62659,
  WooCommerce PR #65588, Jorge's PR review, and Homeboy Rigs issue #255.
  Limit the matrix during focused smokes with
  `WC_CHECKOUT_GATEWAY_MATRIX_PROFILES=core_bacs,plugin_stripe`. Plugin profiles
  report explicit skip details when their entrypoint is unavailable or activation
  fails, so the core controls remain runnable without gateway secrets.
- `checkout-shipping-cache` seeds simple physical products, configures a flat-rate
  US shipping zone, builds a cart, splits cart contents into configurable shipping
  packages, and measures cold, warm, totals-only churn, and address-rehashed
  shipping calculation passes through WooCommerce's checkout/cart shipping cache
  path.
- `layered-nav-count-cache` seeds a real WooCommerce product attribute, terms,
  and simple products, then exercises `Filterer::get_filtered_term_product_counts()`
  across many unique layered-nav count query hashes to measure growth of the
  single `wc_layered_nav_counts_*` taxonomy transient reported in WooCommerce
  issue #17355.
- `layered-nav-catalog-crawl` uses real `filter_*` request combinations and
  renders the layered-nav widget list path for each request shape, measuring
  the same transient growth through a crawler/catalog-traffic-shaped path.

## Metrics

The first slice reports:

- Gateway matrix counts for `order_awaiting_payment` writes/branches, duplicate
  checkout attempts, duplicate order counts, payment success/failure/cancel
  cart/session state, unexpected cart clearing, redirect presence, and
  order-received URL timing.
- `cold_shipping_ms`, `warm_shipping_p50_ms`, `warm_shipping_p95_ms`, and
  `warm_to_cold_ratio`.
- `total_churn_shipping_p50_ms`, `total_churn_to_warm_ratio`, and
  `total_churn_rate_calculation_calls` for package subtotal/total-only churn.
- `rehash_shipping_p50_ms` and `rehash_to_warm_ratio` for address/hash changes.
- Package, item, rate, and session-cache key counts.
- `final_transient_entry_count`, `max_transient_entry_count`,
  `final_serialized_value_bytes`, and `cache_exceeded_limit` for layered-nav
  count cache growth.

See `docs/checkout-shipping-cache.md` for workload details and current TODOs.

## Matrix Report

Use the report generator to prepare compact Markdown evidence for WooCommerce PR
comments without inventing missing baseline/candidate numbers:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs \
  --input /tmp/woocommerce-performance-bench
```

The report separates timing evidence from shipping-rate call-count evidence and
documents the cache invalidation controls covered by the current workload. See
`docs/checkout-shipping-cache-matrix-report.md` for the planned matrix commands
and current dependency blockers.

## Checkout PR Evidence Matrix

Use the checkout PR evidence generator when preparing the final reviewer-facing
proof loop for WooCommerce issue #62659 and PR #65588:

```bash
node woocommerce/woocommerce/tools/checkout-pr-evidence-report.mjs
```

The generated matrix is intentionally dependency-aware. It lists the old PR shape
failure run, ready commands for public `create_order()` side effects, sequential
retry, true concurrent checkout, and core gateway rows, and keeps no-payment,
order-pay, identity, coupon lifecycle, hook sequencing, and real Stripe rows
blocked until their prerequisite issues land. See
`docs/checkout-pr-evidence-matrix.md` for the full recipe.
