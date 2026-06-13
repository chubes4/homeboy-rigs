# WooCommerce Checkout PR Evidence Matrix

This recipe prepares reviewer-facing evidence for WooCommerce issue
https://github.com/woocommerce/woocommerce/issues/62659 and PR
https://github.com/woocommerce/woocommerce/pull/65588.

It intentionally separates ready evidence from prerequisite-dependent evidence.
Do not mark blocked rows as passed until their prerequisite rigs land and produce
artifacts.

## Generate The Reviewer Matrix

```bash
node woocommerce/woocommerce/tools/checkout-pr-evidence-report.mjs
```

The report is generated from
`woocommerce/woocommerce/tools/checkout-pr-evidence-matrix.json` so the expected
old-fix failures, revised-candidate expectations, dependencies, and commands stay
reviewable in one place.

## Reusable Gateway Profile Capability

Real Stripe checkout coverage should build on the existing
`woocommerce/woocommerce-gateway-stripe` rig track instead of adding a
checkout-matrix-only Stripe setup path. The
`woocommerce-stripe-ece-product-page` rig already owns WooCommerce +
WooCommerce Stripe mounting, Stripe checkout path checks, fixture expectations,
and real-wallet/secure-browser profile separation.

The final checkout matrix should treat Stripe as a reusable gateway-plugin
profile capability that can be shared by WooCommerce workloads. Relevant merged
homeboy-rigs PRs in that track include #176, #178, #183, #184, #193, #197, #219,
#220, #235, #236, #238, and #265.

The expanded gateway profile matrix now declares explicit rows for these popular
gateway plugins:

| Profile | Dependency slug | Expected gateway IDs |
|---|---|---|
| `plugin_stripe` | `woocommerce-gateway-stripe` | `stripe` |
| `plugin_woopayments` | `woocommerce-payments` | `woocommerce_payments` |
| `plugin_paypal_payments` | `woocommerce-paypal-payments` | `ppcp-gateway` |
| `plugin_square` | `woocommerce-square` | `square_credit_card` |
| `plugin_razorpay` | `razorpay` | `razorpay` |
| `plugin_mollie` | `mollie-payments-for-woocommerce` | `mollie_wc_gateway_creditcard`, `mollie_wc_gateway_ideal`, `mollie_wc_gateway_paypal` |
| `plugin_klarna` | `klarna-payments-for-woocommerce` | `klarna_payments`, `kco` |

Each runtime profile reports structured `available`, `build_failed`, `skipped`,
and `blocked` fields plus source/prepared path env metadata. Core profiles do
not require any third-party plugin preparation.

## Current Dependencies

| Dependency | Status | Scope |
|---|---|---|
| https://github.com/chubes4/homeboy-rigs/issues/268 | landed | no-payment and order-pay guardrails |
| https://github.com/chubes4/homeboy-rigs/issues/269 | landed | guest, logged-in, customer/session identity guardrails |
| https://github.com/chubes4/homeboy-rigs/issues/270 | landed | checkout hook sequencing and counts |
| https://github.com/chubes4/homeboy-rigs/issues/271 | landed | coupon lifecycle guardrails |
| https://github.com/chubes4/homeboy-rigs/issues/292 | open | real Stripe gateway evidence row |
| https://github.com/Extra-Chill/homeboy-extensions/issues/1336 | open | reusable gateway dependency provider materialization |

## Ready Rows

Run these rows for both the old PR shape and the revised WooCommerce candidate.

```bash
homeboy rig up woocommerce-performance

homeboy bench --rig woocommerce-performance \
  --scenario checkout-gateway-compatibility-matrix \
  --iterations 1 \
  --shared-state /tmp/woocommerce-checkout-pr-65588-old-shape \
  --setting-json 'bench_env={"WC_CHECKOUT_GATEWAY_MATRIX_PROFILES":"core_bacs,core_cheque,core_cod"}'

homeboy bench --rig woocommerce-performance \
  --scenario checkout-concurrent-create-order \
  --iterations 1 \
  --shared-state /tmp/woocommerce-checkout-pr-65588-old-shape
```

Repeat with the revised candidate checked out and
`--shared-state /tmp/woocommerce-checkout-pr-65588-revised-candidate`.

## Expected Interpretation

| Row | Old PR shape | Revised candidate |
|---|---|---|
| Public `create_order()` side effects | Fails: public `WC_Checkout::create_order()` writes `order_awaiting_payment`. | Passes when public `create_order()` does not set `order_awaiting_payment`; payment-start paths own that write. |
| Sequential retry and resume | May appear to work only because the old fix writes the session branch too early. | Passes when retry/resume uses the intended branch after payment start and preserves failure/cancel carts. |
| True concurrent checkout | Unproven by the old PR shape; do not claim `Closes #62659`. | Only passes when duplicate-order count is zero in the concurrent harness. |
| Core gateways | Failure/regression should be visible in `order_awaiting_payment` and cart-clearing metrics. | Passes across BACS, cheque, and COD without unexpected cart clearing. |

## Remaining Blocked Rows

The following rows stay pending until reusable gateway dependency materialization
can either mount each plugin or return structured `build_failed` artifacts without
aborting unrelated/core rows:

| Row | Blocker |
|---|---|
| Real Stripe gateway | https://github.com/chubes4/homeboy-rigs/issues/292 and https://github.com/Extra-Chill/homeboy-extensions/issues/1336; reuse the `woocommerce-stripe-ece-product-page` mounting abstractions instead of duplicating setup |
| Real WooPayments gateway | https://github.com/Extra-Chill/homeboy-extensions/issues/1336 |
| Real WooCommerce PayPal Payments gateway | https://github.com/Extra-Chill/homeboy-extensions/issues/1336 |
| Real WooCommerce Square gateway | https://github.com/Extra-Chill/homeboy-extensions/issues/1336 |
| Real Razorpay for WooCommerce gateway | https://github.com/Extra-Chill/homeboy-extensions/issues/1336 |
| Real Mollie Payments for WooCommerce gateway | https://github.com/Extra-Chill/homeboy-extensions/issues/1336 |
| Real Klarna for WooCommerce gateway | https://github.com/Extra-Chill/homeboy-extensions/issues/1336 |

## Reviewer-Facing Output Contract

The WooCommerce PR evidence should include:

- Links to WooCommerce issue #62659, WooCommerce PR #65588 or replacement PR,
  Jorge's review, and Homeboy Rigs issue #273.
- The old-fix guardrail failure run ID
  `136c2b85-647c-4d85-be13-2c0be175abfd`.
- A table with old PR shape output and revised candidate output for every ready
  row.
- Explicit `blocked` labels for real gateway coverage until #292 and HBEX #1336
  produce stable reusable gateway artifacts or structured build-failure rows.
- Real gateway coverage framed as reusable gateway-plugin profile capability.
  Stripe should share the existing WooCommerce Stripe ECE/product-page rig
  mounting abstractions.
- A PR description note that avoids `Closes #62659` unless the true concurrent
  checkout row passes.
