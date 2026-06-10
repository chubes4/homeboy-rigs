# WooCommerce Stripe ECE Product Page Rig

Durable Homeboy rig package for reproducing and measuring product-page
Express Checkout Element page-load fan-out in WooCommerce Stripe.

## Tracked Bug

- https://github.com/woocommerce/woocommerce-gateway-stripe/issues/1439

## What It Measures

The `ece-product-page-waterfall` trace creates a disposable WP Codebox WordPress
runtime, mounts WooCommerce and WooCommerce Stripe, uses this rig's benchmark
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
- `ece_real_wallet_capable`
- `ece_synthetic_only`
- `ece_rendered_visible_button`
- `stripe_elements_session_response_count`
- `stripe_elements_session_status`
- `stripe_elements_session_error_count`
- `stripe_load_console_message_count`
- `stripe_load_page_error_count`

Secondary noisy metrics:

- `browser_dom_content_loaded_ms`
- `browser_first_meaningful_paint_ms`

## Prerequisites

The rig owns its benchmark fixture at `bench/fixture-bootstrap.php`; the target
Stripe checkout does not need benchmark fixture files.

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

## Real Wallet Profile

The default `smoke`, `hot`, and interaction profiles remain synthetic lifecycle
evidence. They intentionally keep working with the rig benchmark fixture's
placeholder keys so network, DOM, and CLS-style render timing can be collected
without real Stripe credentials.

Use the `real-wallet` profile when collecting real-wallet-capable ECE evidence:

```bash
export STRIPE_PUBLISHABLE_KEY=pk_test_...
export STRIPE_SECRET_KEY=sk_test_...
export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL=https://your-public-preview.example

homeboy trace --rig woocommerce-stripe-ece-product-page \
  --profile real-wallet \
  woocommerce-gateway-stripe ece-product-page-waterfall
```

The profile fails before WP Codebox starts when either `STRIPE_PUBLISHABLE_KEY`
or `STRIPE_SECRET_KEY` is absent. It also requires
`HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL` to be an HTTPS public origin; local
HTTP origins and `localhost` are rejected because wallet eligibility requires a
secure, public browser context.

The real keys are injected only into the disposable WordPress setup step. They
are not added to CLI arguments or recorded in metrics artifacts. Real-wallet
artifacts explicitly report `ece_real_wallet_capable: true` and
`ece_synthetic_only: false`; synthetic profiles report the inverse.

Real-wallet evidence records:

- Stripe Elements session response count, first status, and error count.
- Stripe/ECE console and page-error counts.
- Browser wallet capability flags such as Payment Request and Apple Pay support.
- Whether a visible ECE button rendered by the end of the probe.

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
for secure-context browser plumbing checks, and use the `real-wallet` profile
with Stripe test keys plus an HTTPS public preview URL when collecting
real-wallet-capable evidence.
