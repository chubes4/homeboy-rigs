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
- https://github.com/chubes4/homeboy-rigs/issues/224
- https://wordpress.org/support/topic/wp_query-get_posts-slow-query-on-dashboard/
- https://github.com/woocommerce/woocommerce/issues/62659
- https://github.com/woocommerce/woocommerce/pull/65588
- https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929
- https://github.com/chubes4/homeboy-rigs/issues/253

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
homeboy bench --rig woocommerce-performance --scenario checkout-shortcode-place-order-latency --iterations 1 --shared-state /tmp/woocommerce-shortcode-checkout
homeboy bench --rig woocommerce-performance --scenario admin-dashboard-physical-products-query --iterations 1 --shared-state /tmp/woocommerce-admin-dashboard-products --setting-json 'bench_env={"WC_ADMIN_DASHBOARD_PRODUCTS":"500","WC_ADMIN_DASHBOARD_TERMS":"20"}'
homeboy bench --rig woocommerce-performance --scenario layered-nav-count-cache --iterations 1 --shared-state /tmp/woocommerce-layered-nav-cache --setting-json 'bench_env={"WC_LAYERED_NAV_CACHE_ITERATIONS":"150","WC_LAYERED_NAV_CACHE_LIMIT":"25"}'
homeboy bench --rig woocommerce-performance --scenario layered-nav-catalog-crawl --iterations 1 --shared-state /tmp/woocommerce-layered-nav-crawl --setting-json 'bench_env={"WC_LAYERED_NAV_CRAWL_REQUESTS":"150","WC_LAYERED_NAV_CRAWL_LIMIT":"25"}'
homeboy bench --rig woocommerce-performance --profile hot --iterations 1 --shared-state /tmp/woocommerce-performance-hot --setting-json 'bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"120","WC_SHIPPING_CACHE_PACKAGES":"24"}' --force-hot
```

`homeboy bench --rig woocommerce-performance` runs through Homeboy Extensions'
`wordpress.bench` / WP Codebox backend. WP Codebox owns the disposable WordPress
runtime, mounts WooCommerce as the runtime plugin, mounts the rig's PHP workload
into `tests/bench/`, and returns the normalized Homeboy `BenchResults` envelope.

## Current Workloads

- `checkout-concurrent-create-order` calls public `WC_Checkout::create_order()`
  twice against the same cart to report duplicate-order behavior, then records
  deterministic guardrails for session/cart side effects: public create-order
  `order_awaiting_payment` mutation, public create-order cart clearing,
  pending/failed retries, completed-order safety, changed-cart retries,
  `template_redirect` cart clearing after paid extension-created orders, and
  legacy coupon independence.
- `checkout-shipping-cache` seeds simple physical products, configures a flat-rate
  US shipping zone, builds a cart, splits cart contents into configurable shipping
  packages, and measures cold, warm, totals-only churn, and address-rehashed
  shipping calculation passes through WooCommerce's checkout/cart shipping cache
  path.
- `checkout-shortcode-place-order-latency` seeds a shortcode checkout page,
  roughly 150 products, 125 variations, and historical CPT orders with HPOS
  disabled, then drives `WC()->checkout()->process_checkout()` for COD and a
  synthetic successful gateway while capturing checkout POST timing, order
  creation timing, query counts, Action Scheduler deltas, and raw JSON evidence
  for the slow place-order report in homeboy-rigs issue #223.
- `layered-nav-count-cache` seeds a real WooCommerce product attribute, terms,
  and simple products, then exercises `Filterer::get_filtered_term_product_counts()`
  across many unique layered-nav count query hashes to measure growth of the
  single `wc_layered_nav_counts_*` taxonomy transient reported in WooCommerce
  issue #17355.
- `admin-dashboard-physical-products-query` seeds configurable simple products
  and product categories with deterministic `_virtual` metadata, sets the
  WooCommerce onboarding state, exercises
  `Shipping::has_physical_products()` plus the dashboard setup-widget PHP path,
  and records whether the reported physical-products SQL appears on the tested
  WooCommerce branch.
- `layered-nav-catalog-crawl` uses real `filter_*` request combinations and
  renders the layered-nav widget list path for each request shape, measuring
  the same transient growth through a crawler/catalog-traffic-shaped path.

## Metrics

The first slice reports:

- `cold_shipping_ms`, `warm_shipping_p50_ms`, `warm_shipping_p95_ms`, and
  `warm_to_cold_ratio`.
- `duplicate_reproduced`, `public_create_order_sets_order_awaiting_payment`,
  `public_create_order_clears_cart`, `pending_retry_reuses_order`,
  `failed_retry_reuses_order`, `completed_order_is_not_reused`,
  `completed_order_status_is_preserved`,
  `changed_cart_retry_creates_new_order`,
  `template_redirect_clears_paid_completed_extension_order`,
  `template_redirect_does_not_clear_without_payment_signal`,
  `template_redirect_does_not_clear_pending_retry_order`,
  `legacy_coupon_independence`, and `guardrail_failure_count` for the checkout
  duplicate-order side-effect guardrails.
- `total_churn_shipping_p50_ms`, `total_churn_to_warm_ratio`, and
  `total_churn_rate_calculation_calls` for package subtotal/total-only churn.
- `rehash_shipping_p50_ms` and `rehash_to_warm_ratio` for address/hash changes.
- Package, item, rate, and session-cache key counts.
- `checkout_post_elapsed_ms`, `checkout_to_order_processed_ms`,
  `order_creation_elapsed_ms`, `thank_you_redirect_resolution_ms`, query count,
  slowest query summaries when `SAVEQUERIES` is available, Action Scheduler job
  deltas, order ID/payment method rows, HPOS mode, checkout renderer, and
  WooCommerce version for shortcode place-order latency.
- `final_transient_entry_count`, `max_transient_entry_count`,
  `final_serialized_value_bytes`, and `cache_exceeded_limit` for layered-nav
  count cache growth.
- `direct_has_physical_products_ms`, `dashboard_setup_widget_ms`,
  `matching_query_elapsed_ms`, `matching_query_count`, `total_query_count`,
  seeded product/term counts, physical/virtual split, onboarding state, and
  WooCommerce version for the admin dashboard physical-products path.

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
