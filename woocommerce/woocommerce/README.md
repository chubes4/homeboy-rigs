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

## Bench Fixtures

WooCommerce-specific PHP bench fixtures live under `bench/lib/` in this rig
package. Workloads can require `bench/lib/woocommerce-fixtures.php` for reusable
store shapes and `bench/lib/woocommerce-expensive-shipping.php` for deterministic
shipping-rate cost simulation.

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
```

Run a focused workload from the table with the shared command shape:

```bash
homeboy fuzz run --rig woocommerce-performance --workload <workload> --run-id <run-id> --seed 1 --max-duration <duration>
```

| Workload | Example run id | Duration |
|---|---|---|
| `cart-session-overwrite-race` | `wc-cart-session-overwrite-race` | `10m` |
| `checkout-concurrent-create-order` | `wc-checkout-atomicity` | `10m` |
| `checkout-gateway-compatibility-matrix` | `wc-gateway-matrix` | `15m` |
| `checkout-shipping-cache` | `wc-shipping-cache` | `15m` |
| `layered-nav-count-cache` | `wc-layered-nav-count-cache` | `15m` |
| `layered-nav-catalog-crawl` | `wc-layered-nav-catalog-crawl` | `15m` |
| `admin-page-coverage` | `wc-admin-coverage` | `15m` |
| `woocommerce-rest-route-inventory` | `wc-rest-route-inventory` | `10m` |
| `generated-rest-request-cases` | `wc-rest-generated-cases` | `20m` |
| `rest-db-query-profile` | `wc-rest-db-query-profile` | `20m` |
| `db-inventory` | `wc-db-inventory` | `10m` |
| `rest-permission-boundary-matrix` | `wc-rest-permission-boundary-matrix` | `20m` |
| `rest-namespace-generated-cases` | `wc-rest-namespace-generated-cases` | `20m` |
| `rest-schema-query-attribution` | `wc-rest-schema-query-attribution` | `20m` |
| `action-scheduler-lookup-table-coverage` | `wc-action-scheduler-lookup-table-coverage` | `15m` |
| `options-transients-coverage` | `wc-options-transients-coverage` | `15m` |
| `rollback-safe-options-transients-mutations` | `wc-rollback-safe-options-transients-mutations` | `15m` |
| `frontend-rendering-request-coverage` | `wc-frontend-rendering-request-coverage` | `15m` |
| `woocommerce-external-http-guardrail` | `wc-external-http-guardrail` | `10m` |

`homeboy fuzz list --rig woocommerce-performance` resolves the rig's
WooCommerce component and `fuzz_workloads.wordpress` declarations before any
focused `homeboy fuzz run` proof command. Fuzz workloads are not
registered through `bench_workloads`; checkout atomicity, shipping cache
guardrails, layered-nav cache coverage, admin coverage, REST coverage, namespace
generated cases, permission boundaries, schema/query attribution, DB inventory,
Action Scheduler, lookup tables, isolated options/transients, frontend
rendering, performance summaries, and external HTTP guardrails all run through
`homeboy fuzz`.

The rig exposes `smoke`, `fuzzer`, and `full-surface` `fuzz_profiles` for fleet
orchestration. These profiles only group existing fuzz workload declarations;
they do not change readiness levels or convert declarations into proof.

The `full-surface` profile also links discovery manifests for route families,
Woo blocks, admin action families, and DB/API hotspot artifact IO through
`fuzz_profile_metadata` and the generated `manifests/target-inventory.json`.
Those manifests are inventory contracts, not new executable workload IDs. The
validator allows explicit external discovery references, such as the browser
coverage rig, while rejecting drift from declared Woo fuzz workloads.

The Woo DB/API fuzz progression is split into two focused profiles:

- `db-api-performance-fuzzer` groups read-only REST route inventory, generated
  safe request cases, REST DB query profiling, DB inventory, schema/query
  attribution, gap reporting, hotspot summary declarations, and contract-backed
  REST CRUD fixture artifacts. Create, update, and delete are executable through
  the upstream WP Codebox/Homeboy/HBEX contracts and require reviewer-facing
  artifacts before proven status.
- `product-rest-crud-fuzzer` makes product and variation batch create/update plus
  readback executable through `rest-product-batch-import`; delete execution is
  represented by the fixture-plan/delete-boundary contracts and remains
  not-proven until reviewer-facing artifact refs exist.

Woo scale profiles live in `manifests/scale-profiles.json`. They declare
product-owned values for large catalogs, variation-heavy catalogs, HPOS order
history, customers, coupons, layered-nav attributes, shipping/tax zones, Action
Scheduler backlog, polluted options/transients, admin list tables, and REST
pagination/search/filter collection scale. Each profile feeds the Homeboy
Extensions generic WordPress workload scale profile schema through
`workload_scale_profile`; this rig does not implement generic fixture generation
or claim local benchmark/fuzz proof for those declarations.

The aggressive isolated firehose, product chaos sequence packs, and generated REST
CRUD fixture-plan handoff are executable contract surfaces, not proof claims.
Every operation in `manifests/rest-crud-fixture-plan.json` is contract-backed by
the upstream offloaded runner stack and still requires reviewer-facing isolation,
delete-boundary, and fuzz-suite artifact refs before any `proven` claim.

The aggressive isolated firehose campaign shape is declared in
`manifests/aggressive-isolated-fuzz-campaign.json`. Change that manifest when
adding product surfaces, artifact expectations, isolation proof requirements,
HBEX flags, or reviewer-facing ref collection semantics. Command execution is
owned by the Homeboy/HBEX fuzz runner; this rig package does not preserve
consumer-side command-array renderers as product proof.

The hotspot and coverage aggregation workloads are data-only declarations for
the intended `homeboy.artifact-postprocess` shape. Do not shim aggregation in the
rig: Homeboy must first ship a real artifact-postprocess runner primitive for
persisted artifact roots, then collect the declared `fuzz.report` artifact before
those contracts can execute or become proven.

The DB/API campaign manifest wires those two aggregation workloads to generic
postprocess metadata instead of abstract proof placeholders:

`coverage-gap-report` and `performance-hotspots-artifact-summary` are not listed
as runnable operator commands while upstream artifact-postprocess is missing.
Their declared `homeboy.artifact-postprocess` steps will consume the offloaded
`${artifacts.root}` JSON artifact root and emit reviewer-facing
`coverage_gap_report` and `performance_hotspots_summary` JSON artifacts after the
upstream primitive exists. The manifest records the exact `helper`, `action`,
`input`, `output`, and `parameters` contract for each output; it does not contain
live proof refs yet.

The DB/API campaign contract lives in `manifests/db-api-fuzz-campaign.json` and
requires reviewer-facing refs for `wp-codebox/fuzz-suite-result/v1`,
`wp-codebox/wordpress-hotspots/v1`, Homeboy fuzz coverage, Homeboy hotspot
summary, and the coverage gap report before anyone can mark it proven. Run the
campaign commands from that manifest only through an approved Homeboy
Lab/runner/offloaded environment; do not run local benchmarks as campaign proof.
See `docs/db-api-performance-fuzzer.md` for the reviewer-facing operator recipe
covering inventory, planning, offloaded run handoff, persisted evidence refs,
artifact schemas, and baseline/candidate comparison.

The declared full-surface fuzz proof is API/DB/admin/server coverage plus the
issue-focused checkout/catalog workloads above. Browser request and performance
summary fuzz manifests are proof-ready declarations until a `homeboy fuzz run`
produces reviewer-facing artifacts. Performance timing remains in
`bench_workloads`. Use Homeboy Lab for heavy `homeboy fuzz run` proof when the
runner has a `homeboy` binary that exposes the `fuzz` command; do not substitute
`homeboy bench` for missing fuzz support.

## Stable Lab Matrix

`manifests/stable-workloads.json` names the stable Woo workload IDs used for
longitudinal hotspot comparison. The IDs are Woo-owned contracts that expand to
declared `fuzz_workloads.wordpress` entries; Homeboy core only runs those
workload IDs, persists artifacts, and compares completed runs.

Generate the Lab-only command plan without executing any workload:

```bash
node woocommerce/woocommerce/tools/stable-workload-lab-commands.mjs \
  --runner LAB_RUNNER_ID \
  --artifact-root ARTIFACT_ROOT \
  --run-id-prefix woo-stable-YYYYMMDD \
  --tracker-ref github:woocommerce/woocommerce#ISSUE_OR_PR
```

For a focused proof, pass one or more stable IDs:

```bash
node woocommerce/woocommerce/tools/stable-workload-lab-commands.mjs \
  --stable-id rest-db-query-profile,store-api-product-browse \
  --runner LAB_RUNNER_ID \
  --artifact-root ARTIFACT_ROOT \
  --run-id-prefix woo-stable-YYYYMMDD
```

The generated run commands use `homeboy fuzz run --lab-only --rig
woocommerce-performance --workload <declared-workload>` with stable run IDs and
`stable-workload:<id>` tracker refs. After the Lab runs complete, use the
generated `homeboy runs refs`, `homeboy runs compare`, and `homeboy runs
hotspots --baseline-run BASELINE_RUN_ID --candidate-run CANDIDATE_RUN_ID`
commands to compare persisted evidence over time. Keep reviewer-facing proof in
Homeboy run/artifact refs; local paths and local-only URLs are not proof.

Each Woo fuzz manifest declares the WP Codebox fixture contract in metadata:
`wp-codebox` runtime, disposable WordPress scope, WooCommerce component, and
`woocommerce/woocommerce.php` activation. The validator rejects fixture metadata
drift and case safety classes that do not match the workload safety class.

## Benchmark Commands

```bash
homeboy rig up woocommerce-performance
homeboy bench --rig woocommerce-performance --scenario checkout-shortcode-place-order-latency --iterations 1 --shared-state /tmp/woocommerce-shortcode-checkout
homeboy bench --rig woocommerce-performance --scenario admin-dashboard-physical-products-query --iterations 1 --shared-state /tmp/woocommerce-admin-dashboard-products --setting-json 'bench_env={"WC_ADMIN_DASHBOARD_PRODUCTS":"500","WC_ADMIN_DASHBOARD_TERMS":"20"}'
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
  the bounded safe GET set as administrator and shop manager through the generic
  fuzz workload path and disposable WP Codebox HTTP runtime. It emits the
  `homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1` contract for
  `$menu`/`$submenu` enumeration, GET-only scope, administrator vs shop-manager
  expectations, skipped/destructive reason codes, and required artifact fields.
  The JSON artifact uses `homeboy-rigs/woocommerce-admin-page-coverage/v1` and
  records targets, visits, skipped rows, request logs, query attribution, metrics,
  HTTP status, redirects when visible, request timing, PHP notices/errors observed
  by a temporary runtime-only MU plugin, DB query counts and query shapes when
  available, and skip reason counts.
- `rest-permission-boundary-matrix` extends generated REST request coverage with
  namespace and role-boundary expectations for Store API, wc/v*, wc-admin, and
  wc-analytics routes. It is D/E until run artifacts prove route-level statuses.
- `rest-namespace-generated-cases` declares proof-ready namespace classification
  and generated safe GET case coverage for Store API, wc/v*, wc-admin, and
  wc-analytics routes, including route-gap attribution for missing or skipped
  cases.
- `rest-schema-query-attribution` declares route-level schema, SQL query shape,
  and route-to-table attribution for generated safe request cases, with capped
  query samples suitable for reviewer artifacts.
- `action-scheduler-lookup-table-coverage` declares Action Scheduler delta,
  WooCommerce lookup-table inventory, and lookup row attribution around fixture
  setup and safe request cases without dispatching live jobs.
- `options-transients-coverage` declares option, transient, Action Scheduler,
  lookup-table, and isolated option mutation coverage. It is D/E
  until artifacts show mutation rows and transient/action deltas.
- `rollback-safe-options-transients-mutations` narrows the isolated mutation
  contract to mutation verification, transient growth attribution, and skipped
  sensitive option reasons so options/transients proof can be reviewed without
  inferring mutation safety from the broader inventory workload.
- `frontend-rendering-request-coverage` declares shop, product, cart, checkout,
  asset, XHR/fetch, and skipped-destructive-action frontend coverage. It is D/E
  until browser request artifacts prove the scenario set.
- `performance-hotspots-artifact-summary` defines the summary contract for
  checkout/cart/catalog/admin/API timing, query counts, cache invalidation,
  transient growth, gateway compatibility, and HTTP guardrail evidence. It does
  not claim proof without linked fuzz run artifacts.

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
  `php_error_notice_count`, `max_query_count`, `avg_query_count`,
  `skip_reason_counts`, `admin_page_contract_schema`, and
  `artifact_contract_schema` for bounded authenticated wp-admin/Woo admin page
  coverage.

## Unproven Admin Surfaces

The admin-page contract is executable and validated, but these surfaces remain
unproven until a fresh offloaded `homeboy fuzz run` artifact is linked to the
relevant tracker or PR:

- Woo admin pages registered only by optional extensions or feature flags absent
  from the selected WooCommerce checkout.
- Setup, onboarding, install/update/export, create, activation, deletion, trash,
  and other destructive/action-bearing admin screens, which are intentionally
  skipped with explicit reason codes.
- Non-GET admin mutations, AJAX handlers, and REST endpoints outside the
  enumerated menu/submenu GET page set.
- Visual correctness of Woo admin React screens; this workload captures request,
  status, PHP error, and query evidence, not screenshot parity.
- `direct_has_physical_products_ms`, `dashboard_setup_widget_ms`,
  `matching_query_elapsed_ms`, `matching_query_count`, `total_query_count`,
  seeded product/term counts, physical/virtual split, onboarding state, and
  WooCommerce version for the admin dashboard physical-products path.

See `docs/checkout-shipping-cache.md` for workload details and current TODOs.

For baseline/candidate duplicate-checkout comparisons, run the focused fuzz
workload against each WooCommerce checkout and keep the artifacts attached to the
WooCommerce tracker or PR:

```bash
homeboy fuzz list --rig woocommerce-performance
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
