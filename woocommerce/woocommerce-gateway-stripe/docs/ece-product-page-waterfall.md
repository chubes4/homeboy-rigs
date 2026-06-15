# ECE Product Page Waterfall

`ece-product-page-waterfall` is a browser trace workload for the WooCommerce
Stripe product-page Express Checkout Element performance path reported in
https://github.com/woocommerce/woocommerce-gateway-stripe/issues/1439.

## Scenario

1. Start a disposable WP Codebox WordPress runtime.
2. Activate WooCommerce and WooCommerce Stripe.
3. Run this rig's `bench/fixture-bootstrap.php` in the disposable runtime.
4. Configure Stripe test/ECE settings with product-page ECE enabled.
5. Create a simple purchasable product.
6. Open the product page in a browser probe.
7. Capture network, performance, memory, console, error, HTML, and screenshot
   artifacts.
8. Extract normalized waterfall metrics into `ece-waterfall-metrics.json`.

## Browser Profiles

The default `smoke` profile preserves the existing WP Codebox browser-probe
defaults: local Playground origin, default Chromium context, and the rig's fixed
`1366x900` viewport. Use it for rig health only, not for browser performance
conclusions.

The product-page waterfall rig now has a small browser performance profile
matrix. Generated `ece-waterfall-metrics.json` and `ece-waterfall-metadata.json`
preserve the selected profile name, label, caveat, conclusion scope, wait mode,
and throttle profile so downstream reports can carry the right labels without a
Homeboy core reporting change.

| Profile | Wait | Throttle | Supports | Caveat |
| --- | --- | --- | --- | --- |
| `webperf-desktop-load` | `load` | none | Normal-ish desktop LCP/FCP/TTFB/load/navigation timing shape. | Use for non-throttled absolute load context, not stable synthetic fan-out deltas. |
| `webperf-desktop-slow-4g` | `load` | `low-end-mobile-slow-4g` | Stable synthetic third-party response fan-out and relative waterfall deltas. | Desktop rendering is intentionally paired with a slow synthetic throttle; do not present these as normal desktop absolute timings. |
| `webperf-wallet-fanout` | `load` | `low-end-mobile-slow-4g` | Deterministic ECE create/mount count proof with `card,link,apple_pay,google_pay` requested. | Constructor and mount counts are primary proof; Stripe network/session counters are supporting evidence only. |
| `webperf-below-fold-load` | `load` | none | Product content visible timing while ECE is below the initial viewport and no scroll occurs. | Use to prove deferred startup improves visible product load without requiring ECE readiness before proximity. |
| `webperf-below-fold-scroll-to-ece` | `load` | none | Product content visible timing, then scroll-to-ECE readiness after viewport proximity. | Use for normal-ish desktop below-fold UX validation; not stable synthetic fan-out deltas. |
| `webperf-below-fold-wallet-fanout` | `load` | `low-end-mobile-slow-4g` | Below-fold product-visible proof, post-scroll ECE readiness, and deterministic wallet fan-out evidence. | Constructor and mount counts are primary proof; Stripe network/session counters are supporting evidence only. |
| `webperf-stripe-hints-none` | `load` | `low-end-mobile-slow-4g` | Opt-in no-hint control for Stripe hint experiments. | Use as the baseline for hint comparisons; it does not alter default/fanout profiles. |
| `webperf-stripe-preconnect` | `load` | `low-end-mobile-slow-4g` | Adds product-page preconnect hints for `https://js.stripe.com`, `https://api.stripe.com`, and `https://m.stripe.network`. | Compare against `webperf-stripe-hints-none` to catch visible-load regressions from connection warming. |
| `webperf-stripe-js-preload` | `load` | `low-end-mobile-slow-4g` | Adds Stripe origin preconnect hints plus a `https://js.stripe.com/v3/` script preload. | Aggressive preload can compete with critical product-page resources; treat regressions as expected experiment evidence. |
| `webperf-stripe-deferred-preconnect` | `load` | `low-end-mobile-slow-4g` | Adds Stripe origin preconnect hints and defers Woo Stripe Express Checkout script execution. | Models deferred ECE startup plus connection warming; compare ECE readiness and visible load together. |

Set `woocommerce_stripe_ece_browser_profile=webperf-desktop-load` to keep the
desktop browser context without synthetic CPU/network throttling. This profile
waits for `load` and then records the configured probe duration so LCP/FCP/TTFB,
load, and navigation metrics remain visible without relying on `networkidle`.

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  --setting woocommerce_stripe_ece_browser_profile=webperf-desktop-load \
  woocommerce-gateway-stripe ece-product-page-waterfall \
  --output /tmp/wc-stripe-ece-desktop-load.json
```

Set `woocommerce_stripe_ece_browser_profile=webperf-desktop-slow-4g` to keep
the desktop browser context used by the synthetic ECE fixture while applying WP
Codebox's deterministic `low-end-mobile-slow-4g` CPU/network throttle. This
profile waits for `load` and then records the configured probe duration, rather
than waiting for `networkidle`, because Stripe/product-page probes may keep
third-party network activity alive long enough to make `networkidle` timeout.
The disposable product fixture also provides the Woo settings package surface
expected by the built Stripe assets on classic product pages, and the trace fails
if Stripe bootstrap still emits page errors.

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  --setting woocommerce_stripe_ece_browser_profile=webperf-desktop-slow-4g \
  woocommerce-gateway-stripe ece-product-page-waterfall \
  --output /tmp/wc-stripe-ece-webperf.json
```

Use the `webperf-wallet-fanout` trace profile when proving grouped ECE
construction behavior across baseline/candidate runs. It requests
`card,link,apple_pay,google_pay`, enables the deterministic fan-out assertion,
and records Express Checkout Element create/mount calls without requiring Apple
Pay or Google Pay enrollment in the browser.

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  --profile webperf-wallet-fanout \
  woocommerce-gateway-stripe ece-product-page-waterfall \
  --output /tmp/wc-stripe-ece-wallet-fanout.json
```

Use the below-fold profiles when validating delayed or viewport-proximity ECE
startup strategies. They keep the product title, price, and add-to-cart controls
above the fold while moving the ECE container after `form.cart` and below the
initial viewport. `webperf-below-fold-load` intentionally does not scroll, while
`webperf-below-fold-scroll-to-ece` and `webperf-below-fold-wallet-fanout` record
initial product timing first and then scroll near ECE to prove readiness.

```bash
homeboy trace compare woocommerce-gateway-stripe ece-product-page-below-fold-scroll-to-ece \
  --rig woocommerce-stripe-ece-product-page \
  --profile webperf-below-fold-wallet-fanout \
  --baseline-target origin/develop \
  --candidate ./candidate-worktree \
  --repeat 5 \
  --schedule interleaved \
  --canonical \
  --output /tmp/wc-stripe-ece-below-fold-fanout.compare.json
```

Use the opt-in Stripe hint profiles to compare whether connection warming or
preloading improves ECE readiness without hurting visible load. These profiles
all write the active `stripe_hint_strategy`, emitted `stripe_hint_links`, and
`stripe_defer_express_checkout_script` values into `ece-waterfall-metrics.json`
and `ece-waterfall-metadata.json`.

```bash
homeboy trace compare woocommerce-gateway-stripe ece-product-page-waterfall \
  --rig woocommerce-stripe-ece-product-page \
  --baseline-profile webperf-stripe-hints-none \
  --candidate-profile webperf-stripe-preconnect \
  --repeat 5 \
  --schedule interleaved \
  --output /tmp/wc-stripe-ece-preconnect-compare.json
```

For each run, review `stripe_hint_comparison_signals` first. It groups the
fields that decide whether a hint strategy helped or regressed the product page:

| Group | Fields |
| --- | --- |
| Visible load | `product_content_visible_ms`, `browser_fcp_ms`, `browser_lcp_ms`, `browser_cls` |
| ECE readiness | `ece_render_container_visible_ms`, `ece_render_first_child_ms`, `ece_render_first_iframe_ms`, `ece_render_first_visible_button_ms`, `ece_rendered_visible_button` |
| Resources | `network_response_count`, `stripe_response_count`, `browser_resource_count`, `browser_transfer_size_bytes` |
| Errors | `page_error_count`, `console_message_count`, `stripe_load_page_error_count`, `stripe_elements_session_error_count` |

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

Use `--profile simulated-cls` and `--profile simulated-cls-reserved` for
deterministic product-page CLS evidence that does not depend on live Stripe
wallet eligibility. Both profiles inject a delayed 48px ECE-like button into
`#wc-stripe-express-checkout-element-wallets-link`; the reserved variant applies
the matching ECE container height before the delayed render.

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  --profile simulated-cls \
  woocommerce-gateway-stripe ece-product-page-simulated-cls \
  --output /tmp/wc-stripe-ece-simulated-cls.json

homeboy trace --rig woocommerce-stripe-ece-product-page \
  --profile simulated-cls-reserved \
  woocommerce-gateway-stripe ece-product-page-simulated-cls-reserved \
  --output /tmp/wc-stripe-ece-simulated-cls-reserved.json
```

## Primary Signals

The stable signals are structural:

- ECE container, child, iframe, visible iframe, and visible button timing.
- Product title, price, summary, cart, add-to-cart, and content visible timing
  plus above-fold rects: `product_content_visible_ms`,
  `product_title_visible_ms`, `product_price_visible_ms`,
  `product_summary_visible_ms`, `product_cart_visible_ms`,
  `product_add_to_cart_visible_ms`, `add_to_cart_visible_ms`,
  `ece_container_reserved_ms`, `product_content_above_fold`,
  `product_title_rect`, `product_price_rect`, and `product_add_to_cart_rect`.
- Stripe/Stripe Network response count.
- Total network response count.
- Browser document count.
- JS event listener count.
- DOM node count.
- Long-task count and total duration.
- Browser profile identity and caveats: `browser_profile`,
  `browser_profile_label`, `browser_profile_caveat`,
  `browser_profile_conclusion`, `browser_wait_for`, and
  `browser_throttle_profile`.
- Active Stripe hint strategy: `stripe_hint_strategy`, `stripe_hint_links`,
  `stripe_defer_express_checkout_script`, and grouped
  `stripe_hint_comparison_signals` for compare reports.
- WP Codebox web performance metrics when available: `browser_ttfb_ms`,
  `browser_fcp_ms`, `browser_lcp_ms`, and `browser_nav_duration_ms`.
- Real-wallet evidence classification: `ece_real_wallet_capable` and
  `ece_synthetic_only`.
- Deterministic ECE construction fields: `ece_create_call_count`,
  `ece_instance_count`, `ece_mount_count`, `ece_mount_target_ids`,
  `ece_mount_target_selectors`, and `ece_create_payment_methods`.
- Stripe Elements session status/error counts and visible-button outcome.
- Deterministic CLS fields for simulated profiles: `browser_cls`,
  `browser_layout_shift_count`, `ece_render_final_container_height`,
  `ece_render_final_wallets_link_height`, and metadata-level layout-shift source
  rectangles for the ECE container/sentinel path.

## Secondary Signals

`DOMContentLoaded` and first meaningful paint are recorded, but they should be
treated as secondary until a larger interleaved matrix proves stable medians.
The local workload includes WordPress setup, WP Codebox runtime scheduling,
browser scheduling, and third-party Stripe network variance.

## Render Timing Instrumentation

The browser probe injects a pre-page observer before WooCommerce or Stripe page
scripts run. It records the first time stable product content selectors become
visible, the first time the ECE container reserves layout space, the first time
the ECE container is seen, becomes visible, receives children, receives Stripe
iframes, receives visible iframes, receives visible buttons, and fires a
transition event inside the ECE container.
It also records peak child/iframe/button counts because Stripe can add and then
remove surfaces during wallet eligibility checks.

Product visible-load selectors are rig-owned defaults for the disposable classic
WooCommerce product fixture:

| Metric | Selectors |
| --- | --- |
| `product_content_visible_ms` | `h1.product_title, .product_title, h1`, `.summary .price, p.price, .price`, and `form.cart button[type="submit"], form.cart .single_add_to_cart_button` all visible |
| `product_summary_visible_ms` | `.summary` |
| `product_price_visible_ms` | `.summary .price, p.price, .price` |
| `product_add_to_cart_visible_ms` / `add_to_cart_visible_ms` | `form.cart button[type="submit"], form.cart .single_add_to_cart_button` |
| `ece_container_reserved_ms` | `#wc-stripe-express-checkout-element` with a non-zero bounding-box height |

These fields are written to `ece-waterfall-metrics.json`; ECE-specific render
fields keep the `ece_render_*` prefix. The raw observer events are also preserved in
`ece-waterfall-metadata.json` for debugging false positives or missing marks.

For `webperf-wallet-fanout`, the pre-page script also wraps the Stripe factory,
`stripe.elements()`, `elements.create('expressCheckout', ...)`, and each ECE
instance's `mount(...)`. Metrics contain normalized counts and mount targets;
metadata preserves full create/mount records under
`express_checkout_instrumentation`.

## Known Follow-Ups

- Add named overlay variants for lazy product-page ECE initialization once the
  Stripe PR stack settles.
- Add an ECE-disabled control variant.
- Add interaction probes that intentionally trigger deferred ECE initialization
  and verify button availability after the trigger.
