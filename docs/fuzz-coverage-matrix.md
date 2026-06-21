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
| WordPress Core | D/E | D/E | D/E | D/E | D/E | D/E | D/E partial |
| Gutenberg | D/E | D/E | D/E | D/E | D/E | D/E/P partial | D/E/P partial |
| Jetpack | D/E | D/E | D/E | D/E | D/E | D/E | D/E partial |

## WooCommerce

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E/P partial | `woocommerce/woocommerce/manifests/full-surface-coverage.json`, `fuzz/rest-permission-boundary-matrix.json`, `fuzz/rest-namespace-generated-cases.json`, `fuzz/rest-schema-query-attribution.json`, `bench/woocommerce-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json`, `bench/rest-product-batch-import.php` | Route inventory, generated safe GET cases, namespace classification, permission-boundary matrix, and schema/query attribution declarations are executable. Product batch import gives mutation/performance proof for catalog REST behavior, but full REST namespace proof still needs baseline/candidate artifacts per upstream PR or issue. |
| DB | D/E/P partial | `fuzz/options-transients-coverage.json`, `fuzz/action-scheduler-lookup-table-coverage.json`, `fuzz/rollback-safe-options-transients-mutations.json`, `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, checkout, layered-nav, and admin dashboard workloads | Query counts, schema/query attribution, lookup-table inventory, transient growth, Action Scheduler deltas, option/transient inventory, rollback-safe mutation contracts, and physical-product dashboard query metrics are documented. This is proven for targeted bug clusters, not complete schema/query coverage. |
| Admin | D/E/P partial | `fuzz/admin-page-coverage.json`, `bench/admin-page-coverage.php`, `browser-scenarios/products_admin.json`, `orders_admin.json`, `analytics_admin.json` | Bounded safe GET coverage runs through the generic fuzz workload and emits an explicit `homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1` contract for `$menu`/`$submenu` enumeration, administrator vs shop-manager expectations, skipped/destructive reason codes, required JSON artifact fields, request logs, query attribution, and metrics. Destructive admin actions remain intentionally skipped. |
| External HTTP | D/E | `bench/woocommerce-external-http-guardrail.php`, `manifests/full-surface-coverage.json` | Guardrail is executable for marketplace/payment/tax/shipping host probes. Reviewer-facing proof artifacts are still pending. |
| Hooks / cron / options | D/E/P partial | `fuzz/options-transients-coverage.json`, `fuzz/action-scheduler-lookup-table-coverage.json`, `fuzz/rollback-safe-options-transients-mutations.json`, `checkout-shortcode-place-order-latency.php`, gateway readiness/matrix workloads, fixture option setup in Woo and Stripe rigs | Action Scheduler deltas, lookup tables, gateway option state, checkout session mutation, option/transient inventory, rollback-safe isolated option mutation, and page-option setup are covered by targeted workloads. General hook inventory remains D/E only until run artifacts exist. |
| Frontend / rendering | D/E/P partial | `fuzz/frontend-rendering-request-coverage.json`, `bench/woocommerce-browser-coverage.trace.mjs`, `browser-scenarios/shop.json`, `product.json`, `cart.json`, `checkout.json`, `rigs/woocommerce-browser-coverage/rig.json`, `cart-session-overwrite-race.trace.mjs` | Shop/product/cart/checkout, frontend request capture, skipped-destructive reason codes, and browser cart-session race coverage are executable. Checkout duplicate-order and cart/session bug coverage is issue-linked; broader visual/rendering parity is not claimed. |
| Performance-related fuzz | D/E/P partial | `fuzz/performance-hotspots-artifact-summary.json`, `checkout-concurrent-create-order.php`, `checkout-shipping-cache.php`, `layered-nav-count-cache.php`, `layered-nav-catalog-crawl.php`, `admin-dashboard-physical-products-query.php`, `cart-session-overwrite-race.php` | Proven for the documented checkout duplicate-order, shipping cache, layered-nav transient, and admin dashboard query bug clusters listed in `woocommerce/woocommerce/README.md`. Full-surface performance summary remains D/E until new run artifacts exist. |

## WordPress Core

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `WordPress/wordpress/manifests/rest-route-coverage.json`, `bench/wordpress-core-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json` | Route inventory and generated safe REST cases are executable. No committed proof bundle is linked yet. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json` | Inventory and REST query profile primitives are present. Core-specific schema/query proof is pending. |
| Admin | D/E | `WordPress/wordpress-develop/fuzz/admin-page-coverage.json`, `browser-scenarios/posts_list.json`, `post_editor.json`, `pages_list.json`, `page_editor.json`, `site_editor.json`, `media_library.json`, `media_new.json`, `users_list.json`, `profile.json`, `rigs/wordpress-core-browser-coverage/rig.json` | Safe Woo-equivalent Core wp-admin menu/submenu enumeration is declared with administrator/editor/author/contributor/subscriber role boundaries, skipped destructive reason codes, query attribution, and a required artifact contract. Proof artifacts are pending. |
| External HTTP | D/E | `bench/wordpress-core-external-http-guardrail.php` | Guardrail executable exists; proof artifacts are pending. |
| Hooks / cron / options | D/E | `WordPress/wordpress-develop/fuzz/hooks-cron-options.json`, `manifests/hooks-cron-options.json`, `manifests/fuzzer-profile.json`, `rigs/wordpress-core-fuzz-coverage/rig.json` | Hook inventory, cron scheduling, autoloaded options, transients, and rewrite rules are declared with required proof artifact names. Proof artifacts are pending before P. |
| Frontend / rendering | D/E | `WordPress/wordpress-develop/fuzz/frontend-rendering-request-coverage.json`, `browser-scenarios/front_page.json`, posts/pages/media/users scenarios, `bench/wordpress-core-browser-coverage.trace.mjs` | Frontend request/rendering coverage is declared for front page, singular posts/pages, archive, search, feed, attachment, and browser request capture. Rendering correctness and visual comparison are not claimed. |
| Performance-related fuzz | D/E partial | `WordPress/wordpress-develop/fuzz/performance-surfaces.json`, `manifests/performance-surfaces.json`, REST generated cases, DB inventory/profile, external HTTP guardrail, browser coverage profile | The full-surface profile declares representative frontend, REST, admin, editor, cron, media, option/autoload, request-timing, query-count, and asset observations, but no targeted core performance bug proof is linked. |

## Gutenberg

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `WordPress/gutenberg/manifests/rest-route-coverage.json`, `bench/gutenberg-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json` | Route inventory and generated safe REST cases are executable. Gap reporting is declared in `manifests/full-surface-coverage.json`; proof artifacts are pending. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `manifests/fuzzer-profile.json` | DB inventory/profile hooks are executable through the fuzzer/full-surface profile. No complete fixture DB proof bundle is committed. |
| Admin | D/E | `browser-scenarios/post_editor.json`, `site_editor.json`, `template_editor.json`, `patterns.json`, `rigs/gutenberg-browser-coverage/rig.json` | Editor/admin browser coverage is executable. Safe wp-admin enumeration outside editor scenarios is not claimed. |
| External HTTP | D/E | `bench/gutenberg-external-http-guardrail.php` | Guardrail executable exists; reviewer-facing proof artifacts are pending. |
| Hooks / cron / options | D/E | `fuzz/gutenberg-hooks-options-inventory.json`, `manifests/fuzzer-profile.json`, `bench/notes-unsaved-attachment.trace.mjs` | The fuzzer profile declares hook, option, postmeta, template/pattern, cron/state, transient, and editor-state inventory. Notes unsaved attachment state is included in the runtime/performance artifact contracts. Proof artifacts are pending. |
| Frontend / rendering | D/E/P partial | `bench/gutenberg-browser-coverage.trace.mjs`, `bench/pattern-preview-assets.trace.mjs`, `rigs/gutenberg-pattern-preview-assets/rig.json` | Pattern preview asset fan-out is linked to WordPress/gutenberg#68979 and #71547 in `WordPress/gutenberg/README.md`. Broader rendering/visual proof remains pending. |
| Performance-related fuzz | D/E/P partial | `fuzz/gutenberg-editor-performance-observation.json`, `manifests/fuzzer-profile.json`, `docs/fuzzer-profile.md`, pattern preview, notes unsaved attachment, browser coverage, DB query profile, and external HTTP guardrail traces | The pattern-preview workload is a proven targeted performance repro. Editor, Site Editor, block-rendering, notes unsaved attachment, HTTP guardrail, and artifact-summary contracts are declared and validated; they still need accumulated proof artifacts before P. |

## Jetpack

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `Automattic/jetpack/manifests/rest-route-coverage.json`, `bench/jetpack-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json` | Jetpack/WP.com route inventory and generated cases are executable. Proof artifacts are pending. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `fuzz/jetpack-module-option-table-inventory.json`, `fuzz/jetpack-options-matrix.json`, `fuzz/jetpack-connected-disconnected-fixtures.json` | Connected-site fixture DB inventory/profile and read-only module option/table fixtures are declared and executable. Proof artifacts are pending. |
| Admin | D/E | `fuzz/jetpack-admin-page-coverage.json`, `browser-scenarios/dashboard.json`, `connection.json`, `modules.json`, `settings.json`, `rigs/jetpack-browser-coverage/rig.json` | Jetpack admin-page enumeration and browser scenarios are executable declarations. Proof artifacts are pending. |
| External HTTP | D/E | `bench/jetpack-external-http-guardrail.php` | Connection, WP.com, sync, and module HTTP guardrails are declared/executable. Reviewer-facing proof artifacts are pending. |
| Hooks / cron / options | D/E | `fuzz/jetpack-options-matrix.json`, `fuzz/jetpack-module-option-table-inventory.json`, `fuzz/jetpack-sync-queue-coverage.json`, `fuzz/jetpack-cron-sync-actions.json`, `fuzz/jetpack-module-state-matrix.json`, `fuzz/jetpack-connected-disconnected-fixtures.json` | Module option/table inventory, sync queue actions, cron/sync action inventory, serialization boundaries, connected/disconnected fixtures, and rollback-safe option/module/queue mutations are declared. Proof artifacts are pending. |
| Frontend / rendering | D/E | `fuzz/jetpack-public-module-frontend-coverage.json`, `bench/jetpack-browser-coverage.trace.mjs`, browser scenarios for dashboard/connection/modules/settings | Admin rendering/request and public-module frontend rendering/request coverage are declared/executable. Proof artifacts are pending. |
| Performance-related fuzz | D/E partial | `fuzz/jetpack-performance-observation.json`, REST generated cases, DB inventory/profile, external HTTP guardrail, browser coverage profile | Executable primitives and summary artifact contracts exist, but no targeted Jetpack performance bug repro is linked in this package yet. |

## Pending Cross-Project Work

- Core admin safe-page enumeration, frontend rendering/request coverage, and hook/cron/options inventory are D/E in `WordPress/wordpress-develop`; they still need proof artifacts before P.
- Jetpack module option/table inventory, sync/cron action coverage, rollback-safe mutation rows, and public-module frontend scenarios are D/E; they still need proof artifacts before P.
- All four projects need durable proof bundles or linked run artifacts before the full-surface rows can move from `D/E` to `P`; WooCommerce admin coverage has the contract shape but still needs fresh reviewer-facing fuzz run artifacts for any newly discovered admin surfaces.
- Visual rendering correctness remains outside this matrix unless a workload explicitly uses WP Codebox visual comparison or another reviewer-facing visual artifact.
