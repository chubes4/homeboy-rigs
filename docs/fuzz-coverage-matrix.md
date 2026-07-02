# WordPress Fuzz Coverage Matrix

This matrix tracks the current rig-package coverage shape for WooCommerce,
WordPress Core, Gutenberg, and Jetpack from product-owned manifests. It separates three levels of confidence:

- **Declared**: the repo names the surface in a manifest, scenario file, or rig profile.
- **Executable**: the repo contains a workload or trace file plus a rig/profile path that can run it.
- **Proven**: the repo links the workload to reviewer-facing bug evidence, PR evidence, run IDs, gap reports, and required fuzz result artifacts. A full-surface proof bundle is not committed here.

Status key: `D` declared, `E` executable, `P` proven, `Partial` covered by narrower workloads only, `Gap` not yet represented beyond generic template guidance. `P` is never inferred from a smoke profile or from local output.

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
safety fields (`safety_boundary`, `mutation_artifacts`). `level: proven`
requires a `proof_bundle` with reviewer-facing `canonical_fuzz_envelope_ref` as
the primary proof pointer. Product packages can use this shared shape to
distinguish planned CRUD/mutation coverage from executable workloads and
reviewer-facing proof artifacts.

The repo-wide package linter reports missing `metadata.readiness` on fuzz
manifests as a warning. Run it with `HOMEBOY_WORDPRESS_HELPER_MANIFEST` pointing
at the injected Homeboy Extensions WordPress helper manifest, and use
`node scripts/lint-rig-packages.mjs --strict-fuzz-readiness` when a package is
ready to make readiness metadata a hard gate. Manifests that opt into `level: proven` must keep their proof
artifacts required and linked through the proof bundle so proof claims cannot
silently pass with optional output or local-only evidence.

## Summary

| Project | API | DB | Admin | External HTTP | Hooks / cron / options | Frontend / rendering | Performance-related fuzz |
|---|---|---|---|---|---|---|---|
| WooCommerce | D/E/P partial | D/E/P partial | D/E/P partial | D/E | D/E/P partial | D/E/P partial | D/E/P partial |
| WordPress Core | D/E | D/E | D/E | D/E | D/E | D/E | D/E partial |
| Gutenberg | D/E | D/E | D/E | D/E | D/E | D/E/P partial | D/E/P partial |
| Jetpack | D/E | D/E | D/E | D/E | D/E | D/E partial | D/E |

## Executable contract IDs

| Project | Contract-backed destructive or mutation state | Exact contract IDs | True blockers |
|---|---|---|---|
| WooCommerce | Product, variation, order, coupon, customer, stock, cart/session, HPOS table, and Action Scheduler destructive lifecycle workloads are executable in offloaded disposable WP Codebox isolation. Manifest evidence: `manifests/aggressive-destructive-workloads.json`, `manifests/rest-crud-fixture-plan.json`, `manifests/product-chaos-sequence-packs.json`, `manifests/target-inventory.json`. | `wp-codebox/wordpress-fuzz-runtime-contract/v1`, `wp-codebox/fuzz-fixture-plan/v1`, `wp-codebox/rest-mutation-fixture-opt-in/v1`, `homeboy/isolation-proof/v1`, `homeboy/fuzz-action-model/v1`, `homeboy/fuzz-exploration-policy/v1`, `homeboy/wordpress-surface-family-contracts/v1`, `homeboy/wordpress-fuzz-runtime-workload-operation/v1`, `wp-codebox/fuzz-artifact-bundle/v1`, `wp-codebox/sandbox-isolation-proof/v1`, `wp-codebox/delete-boundary-artifact/v1`, `wp-codebox/mutation-isolation-artifact/v1`, `homeboy-extensions/generate-database-observations/v1`, `homeboy-extensions/generate-admin-observations/v1`, `homeboy-extensions/generate-browser-observations/v1`, `homeboy-extensions/generate-editor-observations/v1`. | No missing upstream contracts for executable destructive coverage. Proven status still requires reviewer-facing query fingerprint, cache/transient churn, DB write-set, duplicate query, option/autoload churn, admin/browser action-step, replay/minimize, relative hotspot, convergence, and artifact-bundle refs listed by the manifests. Live payment, tax, shipping, webhook, marketplace, and credential-bearing settings effects require safe skip or isolated mock evidence. |
| WordPress Core | Read-only REST, DB, admin, frontend, hook/cron/options, content, media, user, and performance observations are executable. Create, update, and delete are not executable in this package because the Core manifest does not declare product-owned mutation workloads. | `homeboy-rigs/wordpress-full-surface-coverage/v1`, `homeboy/wordpress-rest-route-inventory/v1`, `homeboy/wordpress-rest-request-cases/v1`, `homeboy-rigs/wordpress-core-admin-page-coverage/v1`, `wp-codebox/browser-request-coverage/v1`, `homeboy/wordpress-db-inventory/v1`, `homeboy/wordpress-rest-db-query-profile/v1`, `homeboy/wordpress-runtime-state-coverage/v1`. | Disposable Core fixture mutation workloads and reviewer-facing proof artifacts are absent from the Core manifests. |
| Gutenberg | Read-only REST, DB, admin/editor, frontend/block rendering, browser, runtime-state, and performance observation contracts are executable. Template, pattern, and block-entity mutations are not product-owned executable destructive coverage in this package. | `homeboy-rigs/wordpress-full-surface-coverage/v1`, `homeboy/wordpress-rest-route-inventory/v1`, `homeboy/wordpress-rest-request-cases/v1`, `homeboy-rigs/gutenberg-admin-page-coverage/v1`, `wp-codebox/browser-request-coverage/v1`, `homeboy/wordpress-db-inventory/v1`, `homeboy/wordpress-rest-db-query-profile/v1`, `homeboy/gutenberg-runtime-state-coverage/v1`, `homeboy/gutenberg-performance-observation/v1`. | Destructive editor/entity mutation manifests and reviewer-facing proof artifacts are absent from the Gutenberg manifests. |
| Jetpack | REST, DB/query inventory, admin, external HTTP guardrails, public frontend, browser coverage, performance observation, options, module state, sync queue, cron sync actions, and connected/disconnected fixture states are executable manifest rows. | `homeboy-rigs/wordpress-full-surface-coverage/v1`, `homeboy/wordpress-rest-route-inventory/v1`, `homeboy/wordpress-rest-request-cases/v1`, `homeboy/wordpress-db-inventory/v1`, `homeboy/wordpress-rest-db-query-profile/v1`, `homeboy/wordpress-admin-page-coverage/v1`, `wp-codebox/browser-request-coverage/v1`, `homeboy/jetpack-module-option-table-inventory/v1`, `homeboy/jetpack-performance-observation/v1`. | Proven status needs reviewer-facing run artifacts, coverage gap reports, and persisted guardrail/request artifacts. Connected remote WP.com state remains blocked on safe WP.com sandbox credentials and must not be emulated locally. |

## WooCommerce

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E/P partial | `woocommerce/woocommerce/manifests/full-surface-coverage.json`, `woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json`, `woocommerce/woocommerce/manifests/rest-crud-fixture-plan.json`, `woocommerce/woocommerce/manifests/aggressive-destructive-workloads.json`, `fuzz/rest-permission-boundary-matrix.json`, `fuzz/rest-namespace-generated-cases.json`, `fuzz/rest-schema-query-attribution.json`, `bench/woocommerce-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json`, `bench/rest-product-batch-import.php` | Route inventory, generated safe GET cases, namespace classification, permission-boundary matrix, schema/query attribution, and REST create/update/delete fixture-plan operations are executable through the exact contract IDs above. Product batch import remains targeted proven evidence; full namespace P still requires reviewer-facing baseline/candidate artifacts. |
| DB | D/E/P partial | `woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json`, `woocommerce/woocommerce/manifests/aggressive-destructive-workloads.json`, `woocommerce/woocommerce/manifests/target-inventory.json`, `fuzz/options-transients-coverage.json`, `fuzz/action-scheduler-lookup-table-coverage.json`, `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `bench/coverage-gap-report.workload.json`, `bench/performance-hotspots-artifact-summary.workload.json`, checkout, layered-nav, and admin dashboard workloads | Query counts, schema/query attribution, lookup-table inventory, transient growth, Action Scheduler deltas, option/transient inventory, isolated mutation contracts, HPOS table destructive lifecycle coverage, and physical-product dashboard query metrics are documented. The campaign postprocess contracts consume an offloaded artifact root and require reviewer-facing `coverage_gap_report` and `performance_hotspots_summary` artifacts before proof. This is proven for targeted bug clusters, not complete schema/query coverage. |
| Admin | D/E/P partial | `fuzz/admin-page-coverage.json`, `bench/admin-page-coverage.php`, `browser-scenarios/products_admin.json`, `orders_admin.json`, `analytics_admin.json` | Bounded safe GET coverage runs through the generic fuzz workload and emits an explicit `homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1` contract for `$menu`/`$submenu` enumeration, administrator vs shop-manager expectations, skipped/destructive reason codes, required JSON artifact fields, request logs, query attribution, and metrics. Destructive admin actions remain intentionally skipped. |
| External HTTP | D/E | `bench/woocommerce-external-http-guardrail.php`, `manifests/full-surface-coverage.json` | Guardrail is executable for marketplace/payment/tax/shipping host probes. Reviewer-facing proof artifacts are still pending. |
| Hooks / cron / options | D/E/P partial | `fuzz/options-transients-coverage.json`, `fuzz/action-scheduler-lookup-table-coverage.json`, `checkout-shortcode-place-order-latency.php`, gateway readiness/matrix workloads, fixture option setup in Woo and Stripe rigs, `manifests/aggressive-destructive-workloads.json` | Action Scheduler deltas, lookup tables, gateway option state, checkout session mutation, option/transient inventory, isolated option mutation, page-option setup, and Action Scheduler destructive lifecycle coverage are executable where backed by the listed contracts. General hook inventory remains D/E until reviewer-facing run artifacts exist. |
| Frontend / rendering | D/E/P partial | `fuzz/frontend-rendering-request-coverage.json`, `bench/woocommerce-browser-coverage.trace.mjs`, `browser-scenarios/shop.json`, `product.json`, `cart.json`, `checkout.json`, `rigs/woocommerce-browser-coverage/rig.json`, `cart-session-overwrite-race.trace.mjs` | Shop/product/cart/checkout, frontend request capture, skipped-destructive reason codes, and browser cart-session race coverage are executable. Checkout duplicate-order and cart/session bug coverage is issue-linked; broader visual/rendering parity is not claimed. |
| Performance-related fuzz | D/E/P partial | `fuzz/performance-hotspots-artifact-summary.json`, `checkout-concurrent-create-order.php`, `checkout-shipping-cache.php`, `layered-nav-count-cache.php`, `layered-nav-catalog-crawl.php`, `admin-dashboard-physical-products-query.php`, `cart-session-overwrite-race.php` | Proven for the documented checkout duplicate-order, shipping cache, layered-nav transient, and admin dashboard query bug clusters listed in `woocommerce/woocommerce/README.md`. Relative hotspot output (`homeboy-rigs/woocommerce-performance-hotspots-summary/v1`) is the primary performance evidence for full-surface runs; hard thresholds and smoke output are not proof. |

CRUD/mutation readiness: read paths are executable across REST route inventory,
generated safe requests, browser rendering, and DB/query attribution. Create,
update, and delete are executable for the Woo-owned product, variation, order,
coupon, customer, stock, cart/session, HPOS, and Action Scheduler families where
`rest-crud-fixture-plan.json`, `aggressive-destructive-workloads.json`, and
`target-inventory.json` declare `execute:true`, `execution_enabled:true`, empty
`missing_upstream_contracts`, and the exact contract IDs above. P still requires
reviewer-facing artifact refs; live external effects remain safe-skip or isolated
mock only.

WooCommerce fuzz manifests also carry explicit WP Codebox fixture metadata
(`wp-codebox`, disposable WordPress, WooCommerce component activation) and
case-level safety classes that must match the workload safety class. Use
`homeboy fuzz list --rig woocommerce-performance` before focused
`homeboy fuzz run` recipes; `homeboy bench` is not a substitute for missing fuzz
support or reviewer-facing fuzz artifacts.

## WordPress Core

Canonical Core fuzz contracts live under `WordPress/wordpress-develop`.

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `WordPress/wordpress-develop/fuzz/rest-api.json`, `WordPress/wordpress-develop/manifests/rest-route-coverage.json` | Route inventory, generated safe REST cases, and role permission-boundary contracts are declared/executable. No reviewer-facing proof bundle is linked yet. |
| DB | D/E | `WordPress/wordpress-develop/fuzz/db-inventory-query-profile.json` | Schema inventory, REST query profile, and options/postmeta/rewrite attribution contracts are declared/executable. Core-specific proof artifacts are pending. |
| Admin | D/E | `WordPress/wordpress-develop/fuzz/admin-page-coverage.json` | Safe Woo-equivalent Core wp-admin menu/submenu enumeration is declared with administrator/editor/author/contributor/subscriber role boundaries, skipped destructive reason codes, query attribution, and a required artifact contract. Proof artifacts are pending. |
| External HTTP | D/E | `WordPress/wordpress-develop/fuzz/performance-surfaces.json` | External HTTP/performance observation coverage is declared. Proof artifacts are pending. |
| Hooks / cron / options | D/E | `WordPress/wordpress-develop/fuzz/hooks-cron-options.json`, `manifests/hooks-cron-options.json`, `manifests/fuzzer-profile.json`, `rigs/wordpress-core-fuzz-coverage/rig.json` | Hook inventory, cron scheduling, autoloaded options, transients, postmeta, rewrite rules, and rewrite query attribution are declared with required proof artifact names. Proof artifacts are pending before P. |
| Frontend / rendering | D/E | `WordPress/wordpress-develop/fuzz/frontend-rendering-request-coverage.json` | Frontend request/rendering coverage is declared for front page, singular posts/pages, archive, search, feed, attachment, and browser request capture. Rendering correctness and visual comparison are not claimed. |
| Performance-related fuzz | D/E partial | `WordPress/wordpress-develop/fuzz/performance-surfaces.json`, `WordPress/wordpress-develop/manifests/performance-surfaces.json` | The full-surface profile declares representative frontend, REST, admin, editor, cron, media, option/autoload, request-timing, query-count, and asset observations, but no targeted core performance bug proof is linked. |

CRUD/mutation readiness: read coverage is declared/executable for REST, admin,
frontend, media, user, option, postmeta, hook, cron, and rewrite inventories.
Create/update/delete remain declared-only until upstream fuzz runner primitives
provide disposable Core fixture mutation and durable artifact manifests.

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
bugs. Delete remains declared-only until upstream fixture mutation primitives can
exercise template, pattern, and block-entity deletion without product-specific
cleanup shims.

## Jetpack

| Surface | Status | Current assets | Proven / missing edge |
|---|---|---|---|
| API | D/E | `Automattic/jetpack/manifests/rest-route-coverage.json`, `bench/jetpack-rest-route-inventory.php`, `bench/generated-rest-request-cases.workload.json`, `fuzz/jetpack-rest-route-inventory.json` | Jetpack/WP.com route inventory and generated safe GET case contracts are declared with existing rig entry points. P status needs generic REST fuzz runner artifacts, route coverage diffs, run IDs, and a gap report; this package does not claim complete Jetpack REST fuzz execution. |
| DB | D/E | `bench/db-inventory.workload.json`, `bench/rest-db-query-profile.workload.json`, `fuzz/db-inventory.json`, `fuzz/jetpack-module-option-table-inventory.json`, `fuzz/jetpack-options-matrix.json`, `fuzz/jetpack-connected-disconnected-fixtures.json` | DB inventory/profile, module option/table inventory, option matrix, and connected/disconnected fixture coverage are declared with executable entry points in `manifests/full-surface-coverage.json`. P needs reviewer-facing DB/query, option matrix, connection fixture, and gap-report artifacts. |
| Admin | D/E | `fuzz/jetpack-admin-page-coverage.json`, `browser-scenarios/dashboard.json`, `connection.json`, `modules.json`, `settings.json`, `rigs/jetpack-browser-coverage/rig.json` | Jetpack wp-admin menu/submenu/hash-route enumeration, destructive skip reason codes, and browser scenarios are declared with executable rig/trace paths. P status needs admin-page coverage artifacts, skip-reason artifacts, request logs, run IDs, and a gap report from the generic admin coverage runner. |
| External HTTP | D/E | `fuzz/jetpack-external-http-guardrail.json`, `bench/jetpack-external-http-guardrail.php` | Connection, WP.com, sync, and module HTTP guardrails declare blocked synthetic probes and WP.com boundary classification. Proof needs persisted guardrail collection artifacts and run IDs; live WordPress.com service calls are not part of the fixture. |
| Hooks / cron / options | D/E | `fuzz/jetpack-options-matrix.json`, `fuzz/jetpack-module-option-table-inventory.json`, `fuzz/jetpack-sync-queue-coverage.json`, `fuzz/jetpack-cron-sync-actions.json`, `fuzz/jetpack-module-state-matrix.json`, `fuzz/jetpack-connected-disconnected-fixtures.json` | Module option/table inventory, option matrix, module state, sync queue, cron sync actions, and connected/disconnected fixture rows are executable manifest coverage. P needs persisted option/module/sync/cron artifacts, run IDs, and gap reports. |
| Frontend / rendering | D/E partial | `fuzz/jetpack-public-module-frontend-coverage.json`, `bench/jetpack-browser-coverage.trace.mjs`, browser scenarios for dashboard/connection/modules/settings/public post/public page | Browser/admin and public-module request coverage are declared with executable trace paths for local fixture states and skip classifications. Rendering correctness, connected remote behavior, and full module coverage need browser request artifacts, module scenario matrices, skip-reason artifacts, run IDs, and gap reports. |
| Performance-related fuzz | D/E | `fuzz/jetpack-performance-observation.json`, REST generated cases, DB inventory/profile, external HTTP guardrail, browser coverage profile | Performance observation is an executable summary contract for timing, query counts, assets, sync, HTTP guardrails, skip counts, and slow-surface summaries. No targeted Jetpack performance bug repro or reviewer-facing fuzz proof bundle is linked in this package yet. |

CRUD/mutation readiness: read coverage is executable or traceable for REST
inventory, DB/query inventory, module option/table inventory, admin/browser
paths, public-module fixture pages, and external HTTP guardrails. Option/module
state, sync queue, cron, and connected/disconnected fixture mutations are D/E in
`Automattic/jetpack/manifests/full-surface-coverage.json`. Create/update/delete
for connected remote WP.com state are blocked on safe WP.com sandbox credentials
and must not be emulated with local product-specific fallbacks.

Next Jetpack proof artifacts: non-local `homeboy fuzz run` IDs, REST route
coverage diffs, admin and browser request coverage artifacts, DB inventory/query
profile artifacts, external HTTP guardrail collections, module/option/sync/cron
mutation rows, connected/disconnected skip-reason artifacts, coverage gap
reports, and `metadata.readiness.proof_bundle.fuzz_result_artifacts` entries for
any row promoted to P.

## Pending Cross-Project Work

- Core REST permission-boundary, DB schema/query attribution, admin safe-page enumeration, and hook/cron/options/postmeta/rewrite inventory are D/E in `WordPress/wordpress-develop`; they still need proof artifacts before P.
- Jetpack module option/table inventory, public-module frontend scenarios, external HTTP guardrails, sync/cron action coverage, isolated mutation rows, connected/disconnected fixture mutation, and performance observation summaries have executable manifest rows; they still need reviewer-facing proof artifacts before P.
- All four projects need durable proof bundles or linked run artifacts before the full-surface rows can move from `D/E` to `P`; WooCommerce admin coverage has the contract shape but still needs fresh reviewer-facing fuzz run artifacts for any newly discovered admin surfaces.
- Visual rendering correctness remains outside this matrix unless a workload explicitly uses WP Codebox visual comparison or another reviewer-facing visual artifact.
- Safe CRUD/mutation execution across Core and Gutenberg is blocked until product manifests declare disposable fixture mutation workloads and required artifact contracts. Product rigs should declare real blockers in `metadata.readiness.upstream_blockers` instead of adding cleanup shims.
