# WooCommerce Stripe ECE Product Page Rig

Durable Homeboy rig package for reproducing and measuring product-page
Express Checkout Element page-load fan-out in WooCommerce Stripe.

## Tracked Bug

- https://github.com/woocommerce/woocommerce-gateway-stripe/issues/1439

## What It Measures

The `ece-product-page-waterfall` trace creates a disposable WP Codebox WordPress
runtime, mounts WooCommerce and WooCommerce Stripe, uses Stripe's benchmark
fixture to create a purchasable product with product-page ECE enabled, opens the
product page in a browser probe, and records waterfall metrics.

Primary metrics:

- `stripe_response_count`
- `network_response_count`
- `browser_document_count`
- `browser_js_event_listener_count`
- `browser_dom_node_count`
- `browser_long_task_count`, `browser_long_task_total_ms`, and
  `browser_long_task_max_ms`

Secondary noisy metrics:

- `browser_dom_content_loaded_ms`
- `browser_first_meaningful_paint_ms`

## Prerequisites

The Stripe checkout must include `tests/benchmarks/fixture-bootstrap.php`, which
is added by https://github.com/woocommerce/woocommerce-gateway-stripe/pull/5522.

For `homeboy rig check`, use `HOMEBOY_WC_STRIPE_COMPONENT_PATH` when the target
Stripe checkout is a worktree instead of `~/Developer/woocommerce-gateway-stripe`:

```bash
export HOMEBOY_WC_STRIPE_COMPONENT_PATH=/path/to/woocommerce-gateway-stripe-worktree
```

The rig also needs a WooCommerce plugin directory. Prefer a packaged WooCommerce
plugin build when tracing Stripe browser behavior:

```bash
export HOMEBOY_WC_STRIPE_WOOCOMMERCE_PATH=/path/to/woocommerce
```

If `wp-codebox` is not installed on `PATH`, point Homeboy at a built WP Codebox
CLI:

```bash
export HOMEBOY_WP_CODEBOX_BIN=/path/to/wp-codebox/packages/cli/dist/index.js
```

## Install

```bash
homeboy rig install /Users/chubes/Developer/homeboy-rigs@<branch>/woocommerce/woocommerce-gateway-stripe
homeboy rig check woocommerce-stripe-ece-product-page
```

## Trace Commands

Run a single trace:

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page woocommerce-gateway-stripe ece-product-page-waterfall
```

Pass `--path /path/to/woocommerce-gateway-stripe-worktree` when tracing a local
candidate branch or proof worktree.

Run repeated traces for noisy timing analysis:

```bash
homeboy trace \
  --rig woocommerce-stripe-ece-product-page \
  --repeat 5 \
  --schedule interleaved \
  --output /tmp/wc-stripe-ece-product-page.json \
  woocommerce-gateway-stripe ece-product-page-waterfall
```

Useful settings:

- `HOMEBOY_WC_STRIPE_ECE_LOCATIONS=product`
- `HOMEBOY_WC_STRIPE_ACCEPTED_PAYMENT_METHODS=card,link`
- `HOMEBOY_WC_STRIPE_ECE_PROBE_DURATION=7s`
- `HOMEBOY_WC_STRIPE_ECE_VIEWPORT=1366x900`

## Interpretation

Use request-count and browser-object metrics as the primary signal. The browser
timing metrics are intentionally secondary because this workload includes local
WP Codebox/Playground runtime work, full WordPress/WooCommerce page load, and
Stripe third-party iframe/network timing.
