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
- https://github.com/chubes4/homeboy-rigs/issues/255

## Install

```bash
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/woocommerce/woocommerce
homeboy rig check woocommerce-performance
```

## Runner Prerequisites

The rig mounts the selected WooCommerce checkout into disposable WP Codebox
WordPress runtimes. Pass `--path /absolute/path/to/plugins/woocommerce` when
validating a specific WooCommerce worktree.

The checkout gateway compatibility matrix defaults to the `core_only` profile
set so BACS, Cheque, and COD controls can run even when real gateway plugin
materialization is unavailable. Select the focused Stripe profile set when the
runner can prepare WooCommerce Stripe Gateway:

```bash
homeboy fuzz run --rig woocommerce-performance --workload checkout-gateway-compatibility-matrix --run-id wc-gateway-stripe --seed 1 --max-duration 15m \
  --setting-json 'bench_env={"WC_CHECKOUT_GATEWAY_MATRIX_PROFILE_SET":"stripe"}' \
  --setting-json 'validation_dependencies=["woocommerce-gateway-stripe"]'
```

Supported gateway matrix profile sets are `core_only`, `stripe`, and
`all_configured_gateways`. `WC_CHECKOUT_GATEWAY_MATRIX_PROFILES` remains the
lowest-level escape hatch for comma-separated profile ids or gateway ids.

Homeboy Extensions resolves that dependency through the runner dependency
contract, prepares a runnable artifact when the source checkout needs Composer
materialization, mounts the prepared plugin into WP Codebox, and attaches
`prepared_dependencies` provenance to the final fuzz results. The workload
artifact reports the runtime side of that same contract: configured dependency,
source path when explicitly provided, git revision when visible, prepared artifact
path when exported, mounted plugin directory, plugin version, and status. If the
dependency provider exports a prepared artifact path that is unavailable in the
runtime, the workload records `build_failed` inside the matrix artifact instead
of hiding the failure behind a generic skipped profile.

This deliberately reuses the mounting shape proven by the WooCommerce Stripe ECE
product-page rig without duplicating its browser fixture. That rig owns direct WP
Codebox recipe mounting for Stripe product-page traces:

```json
{"source":"/path/to/woocommerce-gateway-stripe","slug":"woocommerce-gateway-stripe","pluginFile":"woocommerce-gateway-stripe/woocommerce-gateway-stripe.php","activate":true}
```

The gateway matrix is a WordPress fuzz workload, so it consumes the same
slug/entrypoint/runtime metadata through Homeboy Extensions' WordPress dependency
contract instead of building a second Stripe-specific mount path in this rig.

PayPal Payments and WooPayments stay optional. Mount them for focused coverage by
adding them to `validation_dependencies` or by overriding `wp_codebox_extra_plugins`
and the matching artifact path env values:

```bash
homeboy fuzz run --rig woocommerce-performance --workload checkout-gateway-compatibility-matrix --run-id wc-gateway-mounted-plugins --seed 1 --max-duration 15m \
  --setting-json 'wp_codebox_extra_plugins=[{"source":"/path/to/woocommerce-paypal-payments","slug":"woocommerce-paypal-payments","pluginFile":"woocommerce-paypal-payments/woocommerce-paypal-payments.php","activate":false},{"source":"/path/to/woocommerce-payments","slug":"woocommerce-payments","pluginFile":"woocommerce-payments/woocommerce-payments.php","activate":false}]' \
  --setting-json 'bench_env={"WC_CHECKOUT_GATEWAY_MATRIX_PAYPAL_PAYMENTS_PATH":"/path/to/woocommerce-paypal-payments","WC_CHECKOUT_GATEWAY_MATRIX_WOOPAYMENTS_PATH":"/path/to/woocommerce-payments"}'
```

Unavailable gateway plugin profiles skip explicitly as `not_configured` when no
path is configured, `entrypoint_missing` when a configured path did not mount the
expected plugin file, `build_failed` when a prepared artifact path is configured
but unavailable, or `activation_failed` when WordPress rejects activation or the
gateway does not register after activation.
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
- It uses the same Composer install prep when
  `vendor/automattic/jetpack-connection/dist/jetpack-connection.js` is missing.
- It runs `php bin/generate-feature-config.php` only when
  `includes/react-admin/feature-config.php` is missing.
- It runs `pnpm --filter @woocommerce/plugin-woocommerce build:admin` only when
  `assets/client/admin/wp-admin-scripts/command-palette.asset.php` is missing.
- It does not modify WooCommerce source files or switch branches.

Admin coverage fuzz runs require built WooCommerce admin JS outputs.
`homeboy rig check woocommerce-performance` fails before fuzz execution when
`assets/client/admin/wp-admin-scripts/*.asset.php` registries or
`vendor/automattic/jetpack-connection/dist/jetpack-connection.js` are missing.

Equivalent manual prep, when needed for debugging, should run from the selected
WooCommerce plugin directory.

## Fuzz Commands

```bash
homeboy rig up woocommerce-performance
homeboy fuzz list --rig woocommerce-performance
homeboy fuzz run --rig woocommerce-performance --workload cart-session-overwrite-race --run-id wc-cart-session-overwrite-race --seed 1 --max-duration 10m
homeboy fuzz run --rig woocommerce-performance --workload checkout-concurrent-create-order --run-id wc-checkout-atomicity --seed 1 --max-duration 10m
homeboy fuzz run --rig woocommerce-performance --workload checkout-gateway-compatibility-matrix --run-id wc-gateway-matrix --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload checkout-shipping-cache --run-id wc-shipping-cache --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload layered-nav-count-cache --run-id wc-layered-nav-count-cache --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload layered-nav-catalog-crawl --run-id wc-layered-nav-catalog-crawl --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload admin-page-coverage --run-id wc-admin-coverage --seed 1 --max-duration 15m
homeboy fuzz run --rig woocommerce-performance --workload woocommerce-rest-route-inventory --run-id wc-rest-route-inventory --seed 1 --max-duration 10m
homeboy fuzz run --rig woocommerce-performance --workload generated-rest-request-cases --run-id wc-rest-generated-cases --seed 1 --max-duration 20m
homeboy fuzz run --rig woocommerce-performance --workload rest-db-query-profile --run-id wc-rest-db-query-profile --seed 1 --max-duration 20m
homeboy fuzz run --rig woocommerce-performance --workload db-inventory --run-id wc-db-inventory --seed 1 --max-duration 10m
homeboy fuzz run --rig woocommerce-performance --workload woocommerce-external-http-guardrail --run-id wc-external-http-guardrail --seed 1 --max-duration 10m
```

`homeboy fuzz --rig woocommerce-performance` resolves the rig's WooCommerce
component and `fuzz_workloads.wordpress` declarations. Fuzz workloads are not
registered through `bench_workloads`, so there is no legacy bench fallback path
for checkout atomicity, shipping cache guardrails, layered-nav cache coverage,
admin coverage, REST coverage, DB inventory, or external HTTP guardrails.

The declared full-surface fuzz proof is API/DB/admin/server coverage plus the
issue-focused checkout/catalog workloads above. Browser request coverage remains
the separate `woocommerce-browser-coverage` trace profile, and performance timing
remains in `bench_workloads`. Use Homeboy Lab for heavy `homeboy fuzz run` proof
when the runner has a `homeboy` binary that exposes the `fuzz` command; do not
substitute `homeboy bench` for missing fuzz support.

## Benchmark Commands

```bash
homeboy rig up woocommerce-performance
homeboy bench --rig woocommerce-performance --scenario checkout-shortcode-place-order-latency --iterations 1 --shared-state /tmp/woocommerce-shortcode-checkout
homeboy bench --rig woocommerce-performance --scenario admin-dashboard-physical-products-query --iterations 1 --shared-state /tmp/woocommerce-admin-dashboard-products --setting-json 'bench_env={"WC_ADMIN_DASHBOARD_PRODUCTS":"500","WC_ADMIN_DASHBOARD_TERMS":"20"}'
homeboy bench --rig woocommerce-performance --scenario rest-product-batch-import --iterations 1 --shared-state /tmp/woocommerce-rest-product-batch-import
homeboy bench --rig woocommerce-performance --profile hot --iterations 1 --shared-state /tmp/woocommerce-performance-hot --force-hot
```

The `hot` bench profile now contains only true performance workloads. Full-surface
coverage moved to fuzz workload declarations.

`homeboy bench --rig woocommerce-performance` runs through Homeboy Extensions'
`wordpress.bench` / WP Codebox backend. WP Codebox owns the disposable WordPress
runtime, mounts WooCommerce as the runtime plugin, mounts the rig's PHP workload
into `tests/bench/`, and returns the normalized Homeboy `BenchResults` envelope.

## Current Fuzz Workloads

- `checkout-concurrent-create-order` calls public `WC_Checkout::create_order()`
  twice against the same cart to report duplicate-order behavior, then records
  deterministic guardrails for session/cart side effects: public create-order
  `order_awaiting_payment` mutation, public create-order cart clearing,
  pending/failed retries, completed-order safety, changed-cart retries,
  `template_redirect` cart clearing after paid extension-created orders, and
  legacy coupon independence.
- `checkout-gateway-compatibility-matrix` runs the duplicate-checkout/order
  idempotency repro across core BACS, Cheque, and COD gateway controls plus
  first-class mounted real-plugin profiles for WooCommerce Stripe Gateway,
  WooCommerce PayPal Payments, and WooPayments when those plugin paths are
  configured. It captures configured dependency/source/prepared paths, mounted
  plugin directory, best-effort git revision, plugin version, and status details
  without secrets, and links evidence to WooCommerce issue #62659, WooCommerce PR
  #65588, Jorge's PR review, and Homeboy Rigs issue #255.
  Limit the matrix during focused smokes with
  `WC_CHECKOUT_GATEWAY_MATRIX_PROFILE_SET=stripe` or
  `WC_CHECKOUT_GATEWAY_MATRIX_PROFILES=core_bacs,plugin_stripe`. Plugin profiles
  report explicit `not_configured`, `entrypoint_missing`, `activation_failed`, or
  `build_failed` details when their entrypoint is unavailable, activation fails,
  or dependency materialization fails, so the core controls remain runnable
  without gateway secrets.
- `checkout-shipping-cache` seeds simple physical products, configures a flat-rate
  US shipping zone, builds a cart, splits cart contents into configurable shipping
  packages, and measures cold, warm, totals-only churn, and address-rehashed
  shipping calculation passes through WooCommerce's checkout/cart shipping cache
  path.
- `checkout-concurrent-create-order` seeds one WooCommerce cart/session, then
  fires simultaneous `/?wc-ajax=checkout` POSTs with the same session cookie to
  distinguish true request races from sequential `create_order()` retry fixes.
  It links evidence to WooCommerce issue #62659, PR #65588, Jorge's review, and
  homeboy-rigs issue #254.
- `layered-nav-count-cache` seeds a real WooCommerce product attribute, terms,
  and simple products, then exercises `Filterer::get_filtered_term_product_counts()`
  across many unique layered-nav count query hashes to measure growth of the
  single `wc_layered_nav_counts_*` taxonomy transient reported in WooCommerce
  issue #17355.
- `layered-nav-catalog-crawl` uses real `filter_*` request combinations and
  renders the layered-nav widget list path for each request shape, measuring
  the same transient growth through a crawler/catalog-traffic-shaped path.
- `woocommerce-rest-route-inventory` loads WooCommerce in the WP Codebox bench
  runtime, registers REST routes, calls `rest_get_server()->get_routes()`, and
  writes a shared-state JSON inventory of WooCommerce route paths, methods,
  argument names/required flags, and callback summaries. It classifies registered
  routes into `wc/v*`, `wc/store*`, `wc-admin`, `wc-analytics`, and `wc_other` so
  future API performance scenarios can start from full route coverage instead of
  hand-picked endpoints.
- `admin-page-coverage` enumerates registered wp-admin menu and submenu URLs,
  skips known unsafe creation/install/update/export/action targets, then visits
  the bounded safe GET set as admin and shop manager through the disposable WP
  Codebox HTTP runtime. It records HTTP status, redirects when visible, request
  timing, PHP notices/errors observed by a temporary runtime-only MU plugin, DB
  query counts and query shapes when available, and explicit skipped reasons.

## Current Bench Workloads

- `checkout-shortcode-place-order-latency` seeds a shortcode checkout page,
  roughly 150 products, 125 variations, and historical CPT orders with HPOS
  disabled, then drives `WC()->checkout()->process_checkout()` for COD and a
  synthetic successful gateway while capturing checkout POST timing, order
  creation timing, query counts, Action Scheduler deltas, and raw JSON evidence
  for the slow place-order report in homeboy-rigs issue #223.
- `admin-dashboard-physical-products-query` seeds configurable simple products
  and product categories with deterministic `_virtual` metadata, sets the
  WooCommerce onboarding state, exercises
  `Shipping::has_physical_products()` plus the dashboard setup-widget PHP path,
  and records whether the reported physical-products SQL appears on the tested
  WooCommerce branch.
- `rest-product-batch-import` measures WooCommerce REST product batch import
  throughput and related query behavior for generated catalog shapes.

## Metrics

The first slice reports:

- Gateway matrix counts for `order_awaiting_payment` writes/branches, duplicate
  checkout attempts, duplicate order counts, payment success/failure/cancel
  cart/session state, unexpected cart clearing, redirect presence, and
  order-received URL timing.
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
- `checkout_request_count`, `successful_response_count`, `unique_order_count`,
  `duplicate_reproduced`, `cart_item_owner_order_count`,
  `payment_attempt_count_observed`, `safe_losing_response_count`,
  `cart_session_integrity_after_burst_iteration_count`, and
  `repeated_iteration_stability` for true concurrent checkout duplicate-order
  behavior.
- `final_transient_entry_count`, `max_transient_entry_count`,
  `final_serialized_value_bytes`, and `cache_exceeded_limit` for layered-nav
  count cache growth.
- `total_route_count`, `woocommerce_route_count`, `wc_rest_route_count`,
  `wc_store_route_count`, `wc_admin_route_count`, `wc_analytics_route_count`, and
  `wc_other_route_count` for the first full WooCommerce API coverage primitive.
- `enumerated_admin_url_count`, `visited_admin_url_count`, `total_visit_count`,
  `skipped_unsafe_count`, `http_error_count`, `request_error_count`,
  `php_error_notice_count`, `max_query_count`, and `avg_query_count` for bounded
  authenticated wp-admin/Woo admin page coverage.
- `direct_has_physical_products_ms`, `dashboard_setup_widget_ms`,
  `matching_query_elapsed_ms`, `matching_query_count`, `total_query_count`,
  seeded product/term counts, physical/virtual split, onboarding state, and
  WooCommerce version for the admin dashboard physical-products path.

See `docs/checkout-shipping-cache.md` for workload details and current TODOs.

For baseline/candidate duplicate-checkout comparisons, run the focused fuzz
workload against each WooCommerce checkout and keep the artifacts attached to the
WooCommerce tracker or PR:

```bash
homeboy fuzz run --rig woocommerce-performance --workload checkout-concurrent-create-order --run-id wc-checkout-baseline --seed 1 --max-duration 10m
homeboy fuzz run --rig woocommerce-performance --workload checkout-concurrent-create-order --run-id wc-checkout-candidate --seed 1 --max-duration 10m
```

Use `bench_env.WC_CONCURRENT_CHECKOUT_REQUESTS`,
`bench_env.WC_CONCURRENT_CHECKOUT_ITERATIONS`, and
`bench_env.WC_CONCURRENT_CHECKOUT_PAYMENT_MODE` to adjust burst width,
repetition, and COD vs no-payment-needed checkout paths.

## Matrix Report

Use the report generator to prepare compact Markdown evidence for WooCommerce PR
comments without inventing missing baseline/candidate numbers:

```bash
node woocommerce/woocommerce/tools/checkout-shipping-cache-matrix-report.mjs \
  --input /tmp/woocommerce-shipping-cache-artifacts
```

The report separates timing evidence from shipping-rate call-count evidence and
documents the cache invalidation controls covered by the current workload. See
`docs/checkout-shipping-cache-matrix-report.md` for the planned matrix commands
and current dependency blockers.
