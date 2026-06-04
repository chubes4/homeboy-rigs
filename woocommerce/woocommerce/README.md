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
homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-bench
homeboy bench --rig woocommerce-performance --profile hot --iterations 1 --shared-state /tmp/woocommerce-performance-hot --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"120","WC_SHIPPING_CACHE_PACKAGES":"24"}' --force-hot
```

`homeboy bench --rig woocommerce-performance` runs through Homeboy Extensions'
`wordpress.bench` / WP Codebox backend. WP Codebox owns the disposable WordPress
runtime, mounts WooCommerce as the runtime plugin, mounts the rig's PHP workload
into `tests/bench/`, and returns the normalized Homeboy `BenchResults` envelope.

## Current Workloads

- `checkout-shipping-cache` seeds simple physical products, configures a flat-rate
  US shipping zone, builds a cart, splits cart contents into configurable shipping
  packages, and measures cold, warm, totals-only churn, and address-rehashed
  shipping calculation passes through WooCommerce's checkout/cart shipping cache
  path.

## Metrics

The first slice reports:

- `cold_shipping_ms`, `warm_shipping_p50_ms`, `warm_shipping_p95_ms`, and
  `warm_to_cold_ratio`.
- `total_churn_shipping_p50_ms`, `total_churn_to_warm_ratio`, and
  `total_churn_rate_calculation_calls` for package subtotal/total-only churn.
- `rehash_shipping_p50_ms` and `rehash_to_warm_ratio` for address/hash changes.
- Package, item, rate, and session-cache key counts.

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
