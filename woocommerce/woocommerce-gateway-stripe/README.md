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

The default `ece-product-page-waterfall` scenario remains load-only. Additional
scenario IDs reuse the same fixture and add post-load product-page interactions:

- `ece-product-page-scroll-to-ece`
- `ece-product-page-quantity-change`
- `ece-product-page-variation-change`

Primary metrics:

- `ece_render_container_seen_ms`
- `ece_render_first_child_ms`
- `ece_render_first_iframe_ms`
- `ece_render_first_visible_iframe_ms`
- `ece_render_first_visible_button_ms`
- `ece_render_peak_child_count`
- `ece_render_peak_iframe_count`
- `ece_render_peak_visible_iframe_count`
- `stripe_response_count`
- `network_response_count`
- `console_message_count`
- `page_error_count`
- `ece_interaction_event_count`
- `ece_interaction_succeeded`
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

Run the lifecycle matrix explicitly to compare load-only and interaction
scenarios:

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  woocommerce-gateway-stripe ece-product-page-waterfall
homeboy trace --rig woocommerce-stripe-ece-product-page \
  woocommerce-gateway-stripe ece-product-page-scroll-to-ece
homeboy trace --rig woocommerce-stripe-ece-product-page \
  woocommerce-gateway-stripe ece-product-page-quantity-change
homeboy trace --rig woocommerce-stripe-ece-product-page \
  woocommerce-gateway-stripe ece-product-page-variation-change
```

Run one interaction scenario directly:

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  woocommerce-gateway-stripe ece-product-page-quantity-change
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

The ECE render metrics are captured by a `pre-page-script` observer injected
before page scripts run. They are intended to match the merchant-visible symptom:
how long it takes for Express Checkout containers, iframes, and visible button
surfaces to appear after the browser starts loading the product page.

The metadata artifact records requested and effective browser context, including
requested viewport, effective viewport, browser profile, preview settings, final
URL, user agent, and whether the page ran in `window.isSecureContext`. Treat the
default local HTTP/headless profile as request/lifecycle evidence only. It can
show Stripe requests, ECE containers, iframes, buttons, console output, and page
errors, but it is not wallet-eligibility proof. Use the `secure-browser` profile
with an HTTPS public preview URL when collecting secure-context wallet evidence.
