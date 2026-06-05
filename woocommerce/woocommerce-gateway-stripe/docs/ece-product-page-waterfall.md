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

## Known Follow-Ups

- Add named overlay variants for fan-out reduction and lazy product-page ECE
  initialization once the Stripe PR stack settles.
- Add an ECE-disabled control variant.
- Add interaction probes that intentionally trigger deferred ECE initialization
  and verify button availability after the trigger.
