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

## Primary Signals

The stable signals are structural:

- ECE container, child, iframe, visible iframe, and visible button timing.
- Stripe/Stripe Network response count.
- Total network response count.
- Browser document count.
- JS event listener count.
- DOM node count.
- Long-task count and total duration.

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
