# ECE Product Page Waterfall

`ece-product-page-waterfall` is a browser trace workload for the WooCommerce
Stripe product-page Express Checkout Element performance path reported in
https://github.com/woocommerce/woocommerce-gateway-stripe/issues/1439.

## Scenario

1. Start a disposable WP Codebox WordPress runtime.
2. Activate WooCommerce and WooCommerce Stripe.
3. Run `tests/benchmarks/fixture-bootstrap.php` from the Stripe checkout.
4. Configure Stripe test/ECE settings with product-page ECE enabled.
5. Create a simple purchasable product.
6. Open the product page in a browser probe.
7. Capture network, performance, memory, console, error, HTML, and screenshot
   artifacts.
8. Extract normalized waterfall metrics into `ece-waterfall-metrics.json`.

## Browser Profiles

The default `smoke` profile preserves the existing WP Codebox browser-probe
defaults: local Playground origin, default Chromium context, and the rig's fixed
`1366x900` viewport.

Set `woocommerce_stripe_ece_browser_profile=secure-browser` to run the same
Stripe product-page scenario through generic secure/browser-visible upstream
knobs:

- Homeboy trace `port_range_size` allocates a preview port and exposes it as
  `HOMEBOY_INVOCATION_PORT_BASE/MAX` once Extra-Chill/homeboy#3554 lands.
- WP Codebox recipe/CLI preview routing receives `preview.port`,
  `preview.bind`, and `preview.publicUrl` from generic preview settings once
  Automattic/wp-codebox#651 lands.
- `wordpress.browser-probe` receives generic browser context args such as
  `browser=chromium`, `device=Desktop Chrome`, `locale=en-US`, and `timezone`
  once Automattic/wp-codebox#652 lands.

The profile does not encode Stripe, wallet, or payment semantics in WP Codebox.
Those decisions stay in this Homeboy Rigs workload.

Example secure-profile run against upstream branches that provide the generic
contracts:

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  --setting woocommerce_stripe_ece_browser_profile=secure-browser \
  --setting woocommerce_stripe_ece_preview_public_url=https://example.test \
  woocommerce-gateway-stripe ece-product-page-waterfall \
  --output /tmp/wc-stripe-ece-secure-browser.json
```

If `woocommerce_stripe_ece_preview_port` is not set, the workload uses
`HOMEBOY_INVOCATION_PORT_BASE` when Homeboy provides it. The preview bind
defaults to `127.0.0.1`.

Set `woocommerce_stripe_ece_browser_profile=real-wallet` or use
`--profile real-wallet` to collect real-wallet-capable ECE evidence. This
profile refuses to run unless `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`,
and an HTTPS public `HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL` are present.
The keys are written only into the temporary WordPress setup script for the
disposable run.

```bash
export STRIPE_PUBLISHABLE_KEY=pk_test_...
export STRIPE_SECRET_KEY=sk_test_...
export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL=https://example.test

homeboy trace --rig woocommerce-stripe-ece-product-page \
  --profile real-wallet \
  woocommerce-gateway-stripe ece-product-page-waterfall \
  --output /tmp/wc-stripe-ece-real-wallet.json
```

## Primary Signals

The stable signals are structural:

- ECE container, child, iframe, visible iframe, and visible button timing.
- Stripe/Stripe Network response count.
- Total network response count.
- Browser document count.
- JS event listener count.
- DOM node count.
- Long-task count and total duration.
- Real-wallet evidence classification: `ece_real_wallet_capable` and
  `ece_synthetic_only`.
- Stripe Elements session status/error counts and visible-button outcome.

## Secondary Signals

`DOMContentLoaded` and first meaningful paint are recorded, but they should be
treated as secondary until a larger interleaved matrix proves stable medians.
The local workload includes WordPress setup, WP Codebox runtime scheduling,
browser scheduling, and third-party Stripe network variance.

## Render Timing Instrumentation

The browser probe injects a pre-page observer before WooCommerce or Stripe page
scripts run. It records the first time the ECE container is seen, becomes
visible, receives children, receives Stripe iframes, receives visible iframes,
receives visible buttons, and fires a transition event inside the ECE container.
It also records peak child/iframe/button counts because Stripe can add and then
remove surfaces during wallet eligibility checks.

These fields are written to `ece-waterfall-metrics.json` with the
`ece_render_*` prefix. The raw observer events are also preserved in
`ece-waterfall-metadata.json` for debugging false positives or missing marks.

## Known Follow-Ups

- Add named overlay variants for fan-out reduction and lazy product-page ECE
  initialization once the Stripe PR stack settles.
- Add an ECE-disabled control variant.
- Add interaction probes that intentionally trigger deferred ECE initialization
  and verify button availability after the trigger.
