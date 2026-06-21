# WordPress Fuzz Coverage Matrix

This matrix tracks the current rig-package coverage shape for WooCommerce,
WordPress Core, Gutenberg, and Jetpack. It separates three levels of confidence:

- **Declared**: the repo names the surface in a manifest, scenario file, or rig profile.
- **Executable**: the repo contains a workload or trace file plus a rig/profile path that can run it.
- **Proven**: the repo links the workload to reviewer-facing bug evidence, PR evidence, or a documented artifact contract. A full-surface proof bundle is not committed here.

Status key: `D` declared, `E` executable, `P` proven, `Partial` covered by narrower workloads only, `Pending` waiting on another minion/upstream PR, `Gap` not yet represented beyond generic template guidance.

## Summary

| Project | API | DB | Admin | External HTTP | Hooks / cron / options | Frontend / rendering | Performance-related fuzz |
|---|---|---|---|---|---|---|---|
| WooCommerce | D/E/P partial | D/E/P partial | D/E/P partial | D/E | D/E/P partial | D/E/P partial | D/E/P partial |
| WordPress Core | D/E | D/E | D via browser scenarios, E partial | D/E | Gap | D/E partial | D/E partial |
| Gutenberg | D/E | D/E | D/E | D/E | D/E partial | D/E/P partial | D/E/P partial |
| Jetpack | D/E | D/E | D/E | D/E | Gap | D/E | D/E partial |

## WooCommerce

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E/P partial | `woocommerce/woocommerce/manifests/full-surface-coverage.json`, `bench/woocommerce-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json`, `bench/rest-product-batch-import.php` | Route inventory and generated safe GET cases are executable. Product batch import gives mutation/performance proof for catalog REST behavior, but full REST namespace proof still needs baseline/candidate artifacts per upstream PR or issue. |
| DB | D/E/P partial | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, checkout, layered-nav, and admin dashboard workloads | Query counts, transient growth, Action Scheduler deltas, and physical-product dashboard query metrics are documented in `woocommerce/woocommerce/README.md`. This is proven for targeted bug clusters, not complete schema/query coverage. |
| Admin | D/E/P partial | `bench/admin-page-coverage.php`, `browser-scenarios/products_admin.json`, `orders_admin.json`, `analytics_admin.json` | Bounded safe GET coverage runs as administrator and shop manager. It proves page enumeration and error/query capture shape, while destructive admin actions remain intentionally skipped. |
| External HTTP | D/E | `bench/woocommerce-external-http-guardrail.php`, `manifests/full-surface-coverage.json` | Guardrail is executable for marketplace/payment/tax/shipping host probes. Reviewer-facing proof artifacts are still pending. |
| Hooks / cron / options | D/E/P partial | `checkout-shortcode-place-order-latency.php`, gateway readiness/matrix workloads, fixture option setup in Woo and Stripe rigs | Action Scheduler deltas, gateway option state, checkout session mutation, and page-option setup are covered by targeted workloads. General hook, cron, and option inventory is still a gap. |
| Frontend / rendering | D/E/P partial | `bench/woocommerce-browser-coverage.trace.mjs`, `browser-scenarios/shop.json`, `product.json`, `cart.json`, `checkout.json`, `rigs/woocommerce-browser-coverage/rig.json`, `cart-session-overwrite-race.trace.mjs` | Shop/product/cart/checkout and browser cart-session race coverage are executable. Checkout duplicate-order and cart/session bug coverage is issue-linked; broader visual/rendering parity is not claimed. |
| Performance-related fuzz | D/E/P partial | `checkout-concurrent-create-order.php`, `checkout-shipping-cache.php`, `layered-nav-count-cache.php`, `layered-nav-catalog-crawl.php`, `admin-dashboard-physical-products-query.php`, `cart-session-overwrite-race.php` | Proven for the documented checkout duplicate-order, shipping cache, layered-nav transient, and admin dashboard query bug clusters listed in `woocommerce/woocommerce/README.md`. Full-surface performance fuzz remains incremental. |

## WordPress Core

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `WordPress/wordpress/manifests/rest-route-coverage.json`, `bench/wordpress-core-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json` | Route inventory and generated safe REST cases are executable. No committed proof bundle is linked yet. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json` | Inventory and REST query profile primitives are present. Core-specific schema/query proof is pending. |
| Admin | D partial / E partial | `browser-scenarios/post_editor.json`, `site_editor.json`, `media_library.json`, `rigs/wordpress-core-browser-coverage/rig.json` | Browser scenarios cover editor/admin-like flows, but there is no core admin-page enumeration workload equivalent to WooCommerce's `admin-page-coverage.php`. Pending minion PR: core admin safe-page coverage. |
| External HTTP | D/E | `bench/wordpress-core-external-http-guardrail.php` | Guardrail executable exists; proof artifacts are pending. |
| Hooks / cron / options | Gap | None beyond generic WordPress runtime behavior | Pending minion PR: core hook/cron/options inventory and option-mutation guardrails. |
| Frontend / rendering | D/E partial | `browser-scenarios/front_page.json`, editor scenarios, `bench/wordpress-core-browser-coverage.trace.mjs` | Front page and editor browser request coverage are executable. Rendering correctness and visual comparison are not claimed. |
| Performance-related fuzz | D/E partial | REST generated cases, DB inventory/profile, external HTTP guardrail, browser coverage profile | The full-surface profile is executable as primitives, but no targeted core performance bug proof is linked. |

## Gutenberg

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `WordPress/gutenberg/manifests/rest-route-coverage.json`, `bench/gutenberg-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json` | Route inventory and generated safe REST cases are executable. Gap reporting is declared in `manifests/full-surface-coverage.json`; proof artifacts are pending. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `manifests/fuzzer-profile.json` | DB inventory/profile hooks are executable through the fuzzer/full-surface profile. No complete fixture DB proof bundle is committed. |
| Admin | D/E | `browser-scenarios/post_editor.json`, `site_editor.json`, `template_editor.json`, `patterns.json`, `rigs/gutenberg-browser-coverage/rig.json` | Editor/admin browser coverage is executable. Safe wp-admin enumeration outside editor scenarios is not claimed. |
| External HTTP | D/E | `bench/gutenberg-external-http-guardrail.php` | Guardrail executable exists; reviewer-facing proof artifacts are pending. |
| Hooks / cron / options | D/E partial | `manifests/fuzzer-profile.json`, `bench/notes-unsaved-attachment.trace.mjs` | The fuzzer profile declares DB query/profile hooks, and the notes workload exercises option-backed fixture state. General hook/cron/options inventory is pending. |
| Frontend / rendering | D/E/P partial | `bench/gutenberg-browser-coverage.trace.mjs`, `bench/pattern-preview-assets.trace.mjs`, `rigs/gutenberg-pattern-preview-assets/rig.json` | Pattern preview asset fan-out is linked to WordPress/gutenberg#68979 and #71547 in `WordPress/gutenberg/README.md`. Broader rendering/visual proof remains pending. |
| Performance-related fuzz | D/E/P partial | `manifests/fuzzer-profile.json`, `docs/fuzzer-profile.md`, pattern preview and browser coverage traces | The pattern-preview workload is a proven targeted performance repro. The generic fuzzer profile is executable but still needs accumulated proof artifacts. |

## Jetpack

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `Automattic/jetpack/manifests/rest-route-coverage.json`, `bench/jetpack-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json` | Jetpack/WP.com route inventory and generated cases are executable. Proof artifacts are pending. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json` | Connected-site fixture DB inventory/profile is declared and executable. Proof for module-specific tables/options is pending. |
| Admin | D/E | `browser-scenarios/dashboard.json`, `connection.json`, `modules.json`, `settings.json`, `rigs/jetpack-browser-coverage/rig.json` | Jetpack admin browser scenarios are executable. No separate wp-admin menu enumeration workload is present. |
| External HTTP | D/E | `bench/jetpack-external-http-guardrail.php` | Connection, WP.com, sync, and module HTTP guardrails are declared/executable. Reviewer-facing proof artifacts are pending. |
| Hooks / cron / options | Gap | None beyond DB/profile primitives | Pending minion PR: Jetpack module option matrix, sync/cron hook inventory, and connection-state guardrails. |
| Frontend / rendering | D/E | `bench/jetpack-browser-coverage.trace.mjs`, browser scenarios for dashboard/connection/modules/settings | Admin rendering/request coverage is executable. Public-module frontend rendering coverage is not yet declared. |
| Performance-related fuzz | D/E partial | REST generated cases, DB inventory/profile, external HTTP guardrail, browser coverage profile | Executable primitives exist, but no targeted Jetpack performance bug repro is linked in this package yet. |

## Pending Cross-Project Work

- Core admin safe-page enumeration and hook/cron/options inventory need a follow-up minion PR before Core can claim more than partial admin and no hook/options coverage.
- Jetpack module option/sync/cron coverage and public-module frontend scenarios need a follow-up minion PR.
- All four projects need durable proof bundles or linked run artifacts before the full-surface rows can move from `D/E` to `P`.
- Visual rendering correctness remains outside this matrix unless a workload explicitly uses WP Codebox visual comparison or another reviewer-facing visual artifact.
