# WordPress Fuzz Coverage Matrix

This matrix tracks the current rig-package coverage shape for WooCommerce,
WordPress Core, Gutenberg, and Jetpack. It separates three levels of confidence:

- **Declared**: the repo names the surface in a manifest, scenario file, or rig profile.
- **Executable**: the repo contains a workload or trace file plus a rig/profile path that can run it.
- **Proven**: the repo links the workload to reviewer-facing bug evidence, PR evidence, run IDs, gap reports, and required fuzz result artifacts. A full-surface proof bundle is not committed here.

Status key: `D` declared, `E` executable, `P` proven, `Partial` covered by narrower workloads only, `Pending` waiting on another minion/upstream PR, `Gap` not yet represented beyond generic template guidance.

This page is an inventory and coverage contract, not a proof bundle. Product
manifest skeletons can move a row to `D` or `D/E` when they name the surface,
wire it to a rig/profile, and declare the expected artifact shape. A row moves
to `P` only when `metadata.readiness.proof_bundle` links reviewer-facing proof
artifact refs, run IDs, gap reports, and required fuzz result artifacts; no
full-surface product row is proven by this matrix alone.

Product manifest validators share generic workload-shape, rig-linkage, and
bench/fuzz separation checks through `scripts/fuzz-manifest-helpers.mjs`. The
same helper validates the shared full-surface `coverage_map` for REST, admin,
frontend, browser, and database surfaces, plus the shared `gap_report` artifact
schema. Product-specific validators remain responsible for product namespaces,
routes, fixtures, thresholds, skip reasons, and proof contracts.

Generic readiness metadata is available for product manifests that need an
explicit fuzz-readiness contract without claiming proof. `metadata.readiness`
uses `level: declared|executable|proven`, a `coverage_contract` string,
optional `proof_refs`, optional `upstream_blockers`, optional CRUD operation
levels for `create`, `read`, `update`, and `delete`, and optional mutation
rollback fields (`safety_boundary`, `rollback_artifacts`). `level: proven`
requires a `proof_bundle` with non-local `artifact_refs`, reviewer-facing
`run_ids`, `gap_reports`, and `fuzz_result_artifacts` that name required case or
expected artifacts. Product packages can use this shared shape to distinguish
planned CRUD/mutation coverage from executable workloads and reviewer-facing
proof artifacts.

The repo-wide package linter reports missing `metadata.readiness` on fuzz
manifests as a warning. Use `node scripts/lint-rig-packages.mjs
--strict-fuzz-readiness` when a package is ready to make readiness metadata a
hard gate. Manifests that opt into `level: proven` must keep their proof
artifacts required and linked through the proof bundle so proof claims cannot
silently pass with optional output or local-only evidence.

## Summary

| Project | API | DB | Admin | External HTTP | Hooks / cron / options | Frontend / rendering | Performance-related fuzz |
|---|---|---|---|---|---|---|---|
| WooCommerce | D/E/P partial | D/E/P partial | D/E/P partial | D/E | D/E/P partial | D/E/P partial | D/E/P partial |
| WordPress Core | D/E | D/E | D/E | D/E | D/E | D/E | D/E partial |
| Gutenberg | D/E | D/E | D/E | D/E | D/E | D/E/P partial | D/E/P partial |
| Jetpack | D/E | D/E read-only, D mutation | D/E | D/E | D/E read-only, D mutation | D/E partial | D partial |

## WooCommerce

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E/P partial | `woocommerce/woocommerce/manifests/full-surface-coverage.json`, `woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json`, `fuzz/rest-permission-boundary-matrix.json`, `fuzz/rest-namespace-generated-cases.json`, `fuzz/rest-schema-query-attribution.json`, `bench/woocommerce-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json`, `bench/rest-product-batch-import.php` | Route inventory, generated safe GET cases, namespace classification, permission-boundary matrix, and schema/query attribution declarations are executable. The DB/API campaign manifest declares the offloaded Codebox fuzz-suite run set plus generic artifact-postprocess outputs for coverage gap and hotspot summary artifacts. Product batch import gives mutation/performance proof for catalog REST behavior, but full REST namespace proof still needs baseline/candidate artifacts per upstream PR or issue. |
| DB | D/E/P partial | `woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json`, `fuzz/options-transients-coverage.json`, `fuzz/action-scheduler-lookup-table-coverage.json`, `fuzz/rollback-safe-options-transients-mutations.json`, `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `bench/coverage-gap-report.workload.json`, `bench/performance-hotspots-artifact-summary.workload.json`, checkout, layered-nav, and admin dashboard workloads | Query counts, schema/query attribution, lookup-table inventory, transient growth, Action Scheduler deltas, option/transient inventory, rollback-safe mutation contracts, and physical-product dashboard query metrics are documented. The campaign postprocess contracts consume an offloaded artifact root and require reviewer-facing `coverage_gap_report` and `performance_hotspots_summary` artifacts before proof. This is proven for targeted bug clusters, not complete schema/query coverage. |
| Admin | D/E/P partial | `fuzz/admin-page-coverage.json`, `bench/admin-page-coverage.php`, `browser-scenarios/products_admin.json`, `orders_admin.json`, `analytics_admin.json` | Bounded safe GET coverage runs through the generic fuzz workload and emits an explicit `homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1` contract for `$menu`/`$submenu` enumeration, administrator vs shop-manager expectations, skipped/destructive reason codes, required JSON artifact fields, request logs, query attribution, and metrics. Destructive admin actions remain intentionally skipped. |
| External HTTP | D/E | `bench/woocommerce-external-http-guardrail.php`, `manifests/full-surface-coverage.json` | Guardrail is executable for marketplace/payment/tax/shipping host probes. Reviewer-facing proof artifacts are still pending. |
| Hooks / cron / options | D/E/P partial | `fuzz/options-transients-coverage.json`, `fuzz/action-scheduler-lookup-table-coverage.json`, `fuzz/rollback-safe-options-transients-mutations.json`, `checkout-shortcode-place-order-latency.php`, gateway readiness/matrix workloads, fixture option setup in Woo and Stripe rigs | Action Scheduler deltas, lookup tables, gateway option state, checkout session mutation, option/transient inventory, rollback-safe isolated option mutation, and page-option setup are covered by targeted workloads. General hook inventory remains D/E only until run artifacts exist. |
| Frontend / rendering | D/E/P partial | `fuzz/frontend-rendering-request-coverage.json`, `bench/woocommerce-browser-coverage.trace.mjs`, `browser-scenarios/shop.json`, `product.json`, `cart.json`, `checkout.json`, `rigs/woocommerce-browser-coverage/rig.json`, `cart-session-overwrite-race.trace.mjs` | Shop/product/cart/checkout, frontend request capture, skipped-destructive reason codes, and browser cart-session race coverage are executable. Checkout duplicate-order and cart/session bug coverage is issue-linked; broader visual/rendering parity is not claimed. |
| Performance-related fuzz | D/E/P partial | `fuzz/performance-hotspots-artifact-summary.json`, `checkout-concurrent-create-order.php`, `checkout-shipping-cache.php`, `layered-nav-count-cache.php`, `layered-nav-catalog-crawl.php`, `admin-dashboard-physical-products-query.php`, `cart-session-overwrite-race.php` | Proven for the documented checkout duplicate-order, shipping cache, layered-nav transient, and admin dashboard query bug clusters listed in `woocommerce/woocommerce/README.md`. Full-surface performance summary remains D/E until new run artifacts exist. |

CRUD/mutation readiness: read paths are executable across REST route inventory,
generated safe requests, browser rendering, and DB/query attribution. Create and
update are proven only for targeted catalog, checkout, cart/session, option, and
transient bug clusters; delete remains declared-only unless a workload records a
rollback-safe destructive fixture. Upstream blockers are safe CRUD fixture
primitives, durable fuzz artifact manifests, and reviewer-facing run links for
full namespace proof.

WooCommerce fuzz manifests also carry explicit WP Codebox fixture metadata
(`wp-codebox`, disposable WordPress, WooCommerce component activation) and
case-level safety classes that must match the workload safety class. Use
`homeboy fuzz list --rig woocommerce-performance` before focused
`homeboy fuzz run` recipes; `homeboy bench` is not a substitute for missing fuzz
support or reviewer-facing fuzz artifacts.

## WordPress Core

Canonical Core fuzz contracts live under `WordPress/wordpress-develop`. The
legacy `WordPress/wordpress` package remains listed only where existing
bench/trace workloads back compatibility coverage; it is not a fuzz-contract or
benchmark-fallback path for the canonical Core fuzz rig.

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `WordPress/wordpress-develop/fuzz/rest-api.json`, `WordPress/wordpress-develop/manifests/rest-route-coverage.json`; legacy compatibility: `WordPress/wordpress/bench/wordpress-core-rest-route-inventory.php`, `WordPress/wordpress/bench/generated-rest-request-cases.workload.json` | Route inventory, generated safe REST cases, and role permission-boundary contracts are declared/executable. No reviewer-facing proof bundle is linked yet. |
| DB | D/E | `WordPress/wordpress-develop/fuzz/db-inventory-query-profile.json`; legacy compatibility: `WordPress/wordpress/bench/db-inventory.workload.json`, `WordPress/wordpress/bench/rest-db-query-profile.workload.json` | Schema inventory, REST query profile, and options/postmeta/rewrite attribution contracts are declared/executable. Core-specific proof artifacts are pending. |
| Admin | D/E | `WordPress/wordpress-develop/fuzz/admin-page-coverage.json`; legacy compatibility: `WordPress/wordpress/browser-scenarios/posts_list.json`, `post_editor.json`, `pages_list.json`, `page_editor.json`, `site_editor.json`, `media_library.json`, `media_new.json`, `users_list.json`, `profile.json`, `WordPress/wordpress/rigs/wordpress-core-browser-coverage/rig.json` | Safe Woo-equivalent Core wp-admin menu/submenu enumeration is declared with administrator/editor/author/contributor/subscriber role boundaries, skipped destructive reason codes, query attribution, and a required artifact contract. Proof artifacts are pending. |
| External HTTP | D/E | Legacy compatibility: `WordPress/wordpress/bench/wordpress-core-external-http-guardrail.php` | Guardrail executable exists; proof artifacts are pending. |
| Hooks / cron / options | D/E | `WordPress/wordpress-develop/fuzz/hooks-cron-options.json`, `manifests/hooks-cron-options.json`, `manifests/fuzzer-profile.json`, `rigs/wordpress-core-fuzz-coverage/rig.json` | Hook inventory, cron scheduling, autoloaded options, transients, postmeta, rewrite rules, and rewrite query attribution are declared with required proof artifact names. Proof artifacts are pending before P. |
| Frontend / rendering | D/E | `WordPress/wordpress-develop/fuzz/frontend-rendering-request-coverage.json`; legacy compatibility: `WordPress/wordpress/browser-scenarios/front_page.json`, posts/pages/media/users scenarios, `WordPress/wordpress/bench/wordpress-core-browser-coverage.trace.mjs` | Frontend request/rendering coverage is declared for front page, singular posts/pages, archive, search, feed, attachment, and browser request capture. Rendering correctness and visual comparison are not claimed. |
| Performance-related fuzz | D/E partial | `WordPress/wordpress-develop/fuzz/performance-surfaces.json`, `WordPress/wordpress-develop/manifests/performance-surfaces.json`; legacy compatibility: REST generated cases, DB inventory/profile, external HTTP guardrail, browser coverage profile | The full-surface profile declares representative frontend, REST, admin, editor, cron, media, option/autoload, request-timing, query-count, and asset observations, but no targeted core performance bug proof is linked. |

CRUD/mutation readiness: read coverage is declared/executable for REST, admin,
frontend, media, user, option, postmeta, hook, cron, and rewrite inventories.
Create/update/delete remain declared-only until upstream fuzz runner primitives
provide rollback-safe Core fixture mutation and durable artifact manifests. The
legacy `WordPress/wordpress` package should not grow product-specific mutation
workarounds; canonical contracts belong under `WordPress/wordpress-develop`.

## Gutenberg

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `WordPress/gutenberg/manifests/rest-route-coverage.json`, `bench/gutenberg-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json` | Route inventory, declared `wp/v2` and `__experimental` namespace coverage, generated safe REST cases, and protected-route permission-boundary cases are executable through fuzz workloads. Gap reporting is declared in `manifests/full-surface-coverage.json`; reviewer-facing proof artifacts are pending. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `manifests/fuzzer-profile.json` | DB inventory/profile hooks are executable through the fuzzer/full-surface profile, including query attribution, Gutenberg option prefixes, postmeta keys, block/editor/template/pattern entities, and pattern taxonomy state. No complete fixture DB proof bundle is committed. |
| Admin | D/E | `fuzz/gutenberg-admin-page-coverage.json`, `bench/gutenberg-admin-page-coverage.php`, `browser-scenarios/post_editor.json`, `site_editor.json`, `template_editor.json`, `patterns.json`, `rigs/gutenberg-browser-coverage/rig.json` | Safe wp-admin/editor enumeration, editor browser scenarios, and skipped destructive reason codes are declared/executable. Proof artifacts are pending. |
| External HTTP | D/E | `bench/gutenberg-external-http-guardrail.php` | Guardrail executable exists; reviewer-facing proof artifacts are pending. |
| Hooks / cron / options | D/E | `fuzz/gutenberg-hooks-options-inventory.json`, `manifests/fuzzer-profile.json`, `bench/notes-unsaved-attachment.trace.mjs` | The fuzzer profile declares hook, option-prefix, postmeta, template/pattern/entity, cron/state, transient, and editor-state inventory with required artifact expectations. Notes unsaved attachment state is included in the runtime/performance artifact contracts. Proof artifacts are pending. |
| Frontend / rendering | D/E/P partial | `fuzz/frontend-rendering-request-coverage.json`, `fuzz/block-rendering-coverage.json`, `bench/gutenberg-browser-coverage.trace.mjs`, `browser-scenarios/frontend_rendering.json`, `bench/pattern-preview-assets.trace.mjs`, `rigs/gutenberg-pattern-preview-assets/rig.json` | Pattern preview asset fan-out is linked to WordPress/gutenberg#68979 and #71547 in `WordPress/gutenberg/README.md`. Frontend fixture rendering and dynamic block request coverage are declared/executable; broader visual proof remains pending. |
| Performance-related fuzz | D/E/P partial | `fuzz/gutenberg-editor-performance-observation.json`, `manifests/fuzzer-profile.json`, `docs/fuzzer-profile.md`, pattern preview, notes unsaved attachment, browser coverage, DB query profile, and external HTTP guardrail traces | The pattern-preview workload is a proven targeted performance repro. Editor, Site Editor, block-rendering, notes unsaved attachment, HTTP guardrail, and artifact-summary contracts are declared and validated; they still need accumulated proof artifacts before P. |

CRUD/mutation readiness: read coverage is executable for REST route inventory,
editor/admin/browser surfaces, block rendering, template/pattern entities, and DB
query attribution. Create/update are partially executable through editor state
and fixture traces but proven only for targeted pattern-preview and notes-related
bugs. Delete remains declared-only until upstream fixture rollback primitives can
exercise template, pattern, and block-entity deletion without product-specific
cleanup shims.

## Jetpack

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `Automattic/jetpack/manifests/rest-route-coverage.json`, `bench/jetpack-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json`, `fuzz/jetpack-rest-route-inventory.json` | Jetpack/WP.com route inventory and generated safe GET case contracts are declared with existing rig entry points. P status needs generic REST fuzz runner artifacts, route coverage diffs, run IDs, and a gap report; this package does not claim complete Jetpack REST fuzz execution. |
| DB | D/E read-only, D mutation | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `fuzz/db-inventory.json`, `fuzz/jetpack-module-option-table-inventory.json`, `fuzz/jetpack-options-matrix.json`, `fuzz/jetpack-connected-disconnected-fixtures.json` | Read-only DB inventory/profile and module option/table inventory are declared with executable entry points. Option write/rollback and connected-fixture mutation remain declared until generic database inventory/profile, isolated mutation, rollback artifact, and fixture-restore primitives produce reviewer-facing artifacts. |
| Admin | D/E | `fuzz/jetpack-admin-page-coverage.json`, `browser-scenarios/dashboard.json`, `connection.json`, `modules.json`, `settings.json`, `rigs/jetpack-browser-coverage/rig.json` | Jetpack wp-admin menu/submenu/hash-route enumeration, destructive skip reason codes, and browser scenarios are declared with executable rig/trace paths. P status needs admin-page coverage artifacts, skip-reason artifacts, request logs, run IDs, and a gap report from the generic admin coverage runner. |
| External HTTP | D/E | `fuzz/jetpack-external-http-guardrail.json`, `bench/jetpack-external-http-guardrail.php` | Connection, WP.com, sync, and module HTTP guardrails declare blocked synthetic probes and WP.com boundary classification. Proof needs persisted guardrail collection artifacts and run IDs; live WordPress.com service calls are not part of the fixture. |
| Hooks / cron / options | D/E read-only, D mutation | `fuzz/jetpack-options-matrix.json`, `fuzz/jetpack-module-option-table-inventory.json`, `fuzz/jetpack-sync-queue-coverage.json`, `fuzz/jetpack-cron-sync-actions.json`, `fuzz/jetpack-module-state-matrix.json`, `fuzz/jetpack-connected-disconnected-fixtures.json` | Module option/table inventory is the executable read-only win. Option/module/sync/cron mutation rows are product-layer declarations tied to generic plugin option, module-state, sync-queue, cron-action, rollback, and artifact-manifest primitives; they are not proven fuzz execution yet. |
| Frontend / rendering | D/E partial | `fuzz/jetpack-public-module-frontend-coverage.json`, `bench/jetpack-browser-coverage.trace.mjs`, browser scenarios for dashboard/connection/modules/settings/public post/public page | Browser/admin and public-module request coverage are declared with executable trace paths for local fixture states and skip classifications. Rendering correctness, connected remote behavior, and full module coverage need browser request artifacts, module scenario matrices, skip-reason artifacts, run IDs, and gap reports. |
| Performance-related fuzz | D partial | `fuzz/jetpack-performance-observation.json`, REST generated cases, DB inventory/profile, external HTTP guardrail, browser coverage profile | Performance observation is currently a manifest-level summary contract for timing, query counts, assets, sync, HTTP guardrails, skip counts, and slow-surface summaries. No targeted Jetpack performance bug repro or reviewer-facing fuzz proof bundle is linked in this package yet. |

CRUD/mutation readiness: read coverage is executable or traceable for REST
inventory, DB/query inventory, module option/table inventory, admin/browser
paths, public-module fixture pages, and external HTTP guardrails. Option/module
state, sync queue, cron, and connected/disconnected fixture mutations are
declared as product-layer contracts only until generic upstream primitives can
run isolated mutations, restore fixture state, and emit rollback artifacts.
Create/update/delete for connected remote state are blocked on safe WP.com and
Jetpack sandbox primitives and should not be emulated with local product-specific
fallbacks.

Next Jetpack proof artifacts: non-local `homeboy fuzz run` IDs, REST route
coverage diffs, admin and browser request coverage artifacts, DB inventory/query
profile artifacts, external HTTP guardrail collections, module/option/sync/cron
rollback rows, connected/disconnected skip-reason artifacts, coverage gap
reports, and `metadata.readiness.proof_bundle.fuzz_result_artifacts` entries for
any row promoted to P.

## Pending Cross-Project Work

- Core REST permission-boundary, DB schema/query attribution, admin safe-page enumeration, and hook/cron/options/postmeta/rewrite inventory are D/E in `WordPress/wordpress-develop`; they still need proof artifacts before P.
- Jetpack module option/table inventory, public-module frontend scenarios, and external HTTP guardrails have declared executable entry points, while sync/cron action coverage, rollback-safe mutation rows, connected/disconnected fixture mutation, and performance observation summaries remain contract-level until generic upstream fuzz primitives emit proof artifacts.
- All four projects need durable proof bundles or linked run artifacts before the full-surface rows can move from `D/E` to `P`; WooCommerce admin coverage has the contract shape but still needs fresh reviewer-facing fuzz run artifacts for any newly discovered admin surfaces.
- Visual rendering correctness remains outside this matrix unless a workload explicitly uses WP Codebox visual comparison or another reviewer-facing visual artifact.
- Safe CRUD/mutation execution across Core, Gutenberg, and Jetpack is blocked on upstream fuzz runner primitives for disposable fixture mutation, rollback artifact manifests, and durable proof links. Product rigs should declare those blockers in `metadata.readiness.upstream_blockers` instead of adding cleanup shims.
