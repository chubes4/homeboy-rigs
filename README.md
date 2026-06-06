# homeboy-rigs

Personal `homeboy rig`, `homeboy stack`, and portable bench assets. The repo is organized by the fully qualified GitHub repo or site/workspace that owns the workflow.

A **rig** is a declarative spec for a reproducible local dev environment: components, services, symlinks, patches, and pipelines for `up` / `check` / `down`. See: [homeboy rig docs](https://github.com/Extra-Chill/homeboy/tree/main/docs).

## Layout

```text
<owner>/<repo-or-site>/
  rigs/<id>/rig.json
  stacks/    # homeboy stack specs
  bench/     # portable bench workloads used by those rigs
```

Examples:

```text
Automattic/studio/rigs/studio-combined/rig.json
Automattic/studio/stacks/studio-combined.json
Automattic/studio/bench/studio-agent-runtime.bench.mjs
WordPress/wordpress-playground/stacks/playground-combined.json
```

This keeps bench workloads beside the rig that uses them and makes ownership obvious when this repo becomes a shared rig package.

## Install

Install a package subpath with Homeboy's rig package lifecycle:

```bash
homeboy rig install --all https://github.com/chubes4/homeboy-rigs.git//Automattic/studio
```

Stack specs currently need to be copied into `~/.config/homeboy/stacks/` until stack package installation lands:

```bash
mkdir -p ~/.config/homeboy/stacks
cp Automattic/studio/stacks/*.json ~/.config/homeboy/stacks/
cp WordPress/wordpress-playground/stacks/*.json ~/.config/homeboy/stacks/
```

## Lint

Run the repo-local package lint before opening rig package PRs:

```bash
node scripts/lint-rig-packages.mjs
```

The lint path scans for unresolved conflict markers, validates JSON specs, and
runs `php -l` against PHP bench workloads when PHP is available. GitHub Actions
runs the same script with PHP installed.

## Automattic/studio

`rigs/studio-combined/rig.json` is the Studio + Playground combined-fixes dev environment: forks rebased onto trunk, open PRs cherry-picked, Docker-compiled PHP-WASM glue, tarball server, and Studio CLI rewired to local tarballs.

```bash
homeboy rig check studio-combined
homeboy rig up studio-combined
homeboy rig down studio-combined
```

`rigs/studio-combined/rig.json` also declares Studio slow-path bench workloads for timing fresh provisioning, SQLite drop-in startup behavior, wp-admin page loads, and Site Editor readiness through the combined-fixes dev copy.

```bash
homeboy bench --rig studio-combined --scenario studio-site-create --iterations 1 --shared-state /tmp/studio-site-create-bench
```

The workload creates one `--no-start` site and one normally-started site per iteration, then reports create, started-site status, stop, and total timings. Artifacts are written below the shared-state directory for inspection.

Use this focused matrix when investigating user reports that Studio feels slow, hangs during local site startup, or returns intermittent 502 responses:

```bash
# CLI-only provisioning and startup boundaries.
homeboy bench --rig studio-combined --scenario studio-site-create --iterations 1 --shared-state /tmp/studio-slow-path-bench
homeboy bench --rig studio-combined --scenario studio-db-dropin-startup --iterations 1 --shared-state /tmp/studio-slow-path-bench

# Browser-visible wp-admin paths.
homeboy bench --rig studio-combined --scenario studio-page-timing-matrix --iterations 1 --shared-state /tmp/studio-slow-path-bench
homeboy bench --rig studio-combined --scenario studio-wordpress-admin-scale-sweep --iterations 1 --shared-state /tmp/studio-slow-path-bench
homeboy bench --rig studio-combined --scenario studio-dashboard-browser --iterations 1 --shared-state /tmp/studio-slow-path-bench
homeboy bench --rig studio-combined --scenario studio-admin-theme-page-browser --iterations 1 --shared-state /tmp/studio-slow-path-bench

# Site Editor readiness and REST/bootstrap diagnostics.
homeboy bench --rig studio-combined --scenario studio-site-editor-diagnostics --iterations 1 --shared-state /tmp/studio-slow-path-bench
homeboy bench --rig studio-combined --scenario studio-site-editor-preload-diagnostics --iterations 1 --shared-state /tmp/studio-slow-path-bench
homeboy bench --rig studio-combined --scenario studio-rest-latency-diagnostics --iterations 1 --shared-state /tmp/studio-slow-path-bench
```

Run the CLI-only scenarios first to separate Studio provisioning and Playground startup cost from browser-visible WordPress admin cost. Use `studio-page-timing-matrix` next to sweep multiple wp-admin and frontend URLs in one logged-in browser session. Use `studio-wordpress-admin-scale-sweep` when plugin admin screens need page-profiler diagnostics across one prepared site. Use the focused browser scenarios when a matrix page needs a dedicated trace, use `studio-site-editor-diagnostics` when the signal points at Site Editor readiness, and use `studio-rest-latency-diagnostics` when the signal points at per-request REST latency, WordPress bootstrap time, or browser-vs-WordPress transport overhead.

`studio-site-editor-preload-diagnostics` injects a focused set of Site Editor REST preloads into a fresh Studio site's `site-editor.php`, loads the Site Editor once, and reports whether watched routes were satisfied from preload/cache or still reached the network. The artifact includes the page profiler's `restWaterfall.preloadDiagnostics` rows so remaining network requests are classified by likely cause, such as `_locale` query mismatches, fetch-all `per_page` rewrites, duplicate/single-use cache consumption, or no matching preload. Set `HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXACT_VISIBLE=1` to add exact visible `_locale=user` route variants alongside the default probe preloads.

`studio-rest-latency-diagnostics` logs into a fresh Studio site, extracts a real REST nonce from the post editor, and fetches a static asset, the front page, representative authenticated REST endpoints, and `admin-ajax.php` several times in one browser session. By default it installs WordPress bootstrap and request profilers so route summaries can compare browser timing, WordPress entry-to-shutdown timing, MU-plugin-to-shutdown timing, and likely outer transport/proxy overhead. Use `studio_rest_latency_iterations`, `studio_rest_latency_routes`, and `studio_rest_latency_profile_wordpress=0` to adjust the matrix or run an uninstrumented control:

```bash
homeboy bench --rig studio-combined \
  --scenario studio-rest-latency-diagnostics \
  --setting studio_rest_latency_iterations=5 \
  --iterations 1 \
  --shared-state /tmp/studio-rest-latency
```

`studio-page-timing-matrix` visits a configurable path list and records per-page HTTP status, ready time, DOMContentLoaded, load, TTFB, first contentful paint, request counts, failed requests, slowest requests, login-form regressions, and timeout markers. `elapsed_ms` is the page-ready timing, not a network-idle wait, because editor screens intentionally keep background requests such as heartbeat alive. A short network-idle probe is still reported separately as diagnostic data. By default it covers the front page, sample page, Dashboard, Plugins, Themes, Add Themes, Posts, Add New Post, and Site Editor. Override the paths with a comma-separated string or JSON array, or include `admin-menu` to crawl every wp-admin URL exposed in the current site's admin menu:

```bash
homeboy bench --rig studio-combined \
  --scenario studio-page-timing-matrix \
  --setting studio_page_timing_paths='/,/sample-page/,admin-menu' \
  --iterations 1 \
  --shared-state /tmp/studio-page-timing
```

`studio-wordpress-admin-scale-sweep` is the reusable plugin-admin stress rig. It logs into one prepared Studio site, profiles every page in a manifest with the Homeboy WordPress page profiler, and writes one combined artifact with per-page ready time, REST count, REST bytes, slowest resources, failures, trace/screenshot references, and a summary table sorted by the worst pages and requests. It can create a fresh Studio site or target an existing site with `HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_SITE_PATH`. Provide pages with `HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_MANIFEST_JSON` or `HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_MANIFEST`:

```bash
HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_MANIFEST_JSON='{"pages":[{"id":"pipelines","path":"/wp-admin/admin.php?page=datamachine-pipelines","ready":{"selector":".datamachine-pipelines-app"}},{"id":"jobs","path":"/wp-admin/admin.php?page=datamachine-jobs","ready":{"selector":".datamachine-jobs-app"}}]}' \
homeboy bench --rig studio-combined \
  --scenario studio-wordpress-admin-scale-sweep \
  --iterations 1 \
  --shared-state /tmp/studio-admin-scale-sweep
```

Manifest pages may include an `interactions` array. The rig records those declarations now and runs them only when the installed Homeboy Extensions page profiler exposes a compatible declarative interaction hook, so the workload stays usable with current released extension APIs.

The Studio trace workload exercises the packaged app at `apps/studio/out` and records create-site readiness boundaries across the desktop shell, CLI log output, `cli.json`, HTTP readiness, `getSiteDetails()`, and the visible running-state UI.

```bash
homeboy trace --rig studio-combined studio list
homeboy trace --rig studio-combined studio studio-app-create-site --output /tmp/studio-app-create-site-trace.json
```

Canonical Studio create-site trace spans, pending Homeboy's trace span summary support:

| Span | From | To |
|---|---|---|
| `app_launch` | `desktop.app_launch_start` | `desktop.first_window.ready` |
| `submit_to_temp_site` | `ui.create_site.submit_clicked` | `probe.site_details_seen` |
| `submit_to_cli` | `ui.create_site.submit_clicked` | `cli.validating_site_configuration` |
| `site_scaffold` | `cli.validating_site_configuration` | `cli.starting_wordpress_server` |
| `server_to_port` | `cli.starting_wordpress_server` | `probe.cli_config_port_known` |
| `port_to_first_http` | `probe.cli_config_port_known` | `probe.http_first_response` |
| `http_warmup` | `probe.http_first_response` | `probe.http_ready` |
| `ready_to_state` | `probe.http_ready` | `probe.site_details_running_true` |
| `state_to_ui` | `probe.site_details_running_true` | `ui.site.running_visible` |
| `submit_to_running` | `ui.create_site.submit_clicked` | `ui.site.running_visible` |

The Studio agent site-build rigs are model/substrate-specific. Use `studio-agent-claude-ssi` or `studio-agent-gpt55-ssi` for current Static Site Importer site-build runs, and `studio-agent-claude-trunk` as the trunk reference.

```bash
homeboy rig up studio-agent-claude-ssi
homeboy bench --rig studio-agent-claude-ssi --scenario studio-agent-site-build --iterations 1 --shared-state /tmp/studio-agent-bench
```

The site-build workload accepts a runtime namespace for parallel prompt-variant runs. The prompt variant still controls benchmark semantics; `studio_bench_namespace` only isolates runtime resources such as artifacts, Studio CLI config, appdata, daemon sockets, temp files, site roots, and the derived port range.

```bash
HOMEBOY_SETTINGS_STUDIO_SITE_BUILD_PROMPT_VARIANT=restaurant \
HOMEBOY_SETTINGS_STUDIO_BENCH_NAMESPACE=restaurant-a \
homeboy bench --rig studio-agent-claude-ssi --scenario studio-agent-site-build --iterations 1 --shared-state /tmp/studio-agent-bench &

HOMEBOY_SETTINGS_STUDIO_SITE_BUILD_PROMPT_VARIANT=saas \
HOMEBOY_SETTINGS_STUDIO_BENCH_NAMESPACE=saas-a \
homeboy bench --rig studio-agent-gpt55-ssi --scenario studio-agent-site-build --iterations 1 --shared-state /tmp/studio-agent-bench &

wait
```

The site-build workload also emits generated-theme UX gates in `generated-theme-ux-gates.json`. This first slice catches serialized `wp:freeform` count drift against the Static Site Importer report and CSS-hidden reveal content that lacks an editor override, which can make the Site Editor canvas appear blank even when the frontend looks acceptable. Remaining gates to automate are Site Editor above-the-fold visible text, footer utility links converted into responsive navigation overlays, and fixed/sticky chrome overlapping the WordPress admin bar.

Mixed-source prompt variants such as `astro-docs-content-collection`, `markdown-blog-launch-site`, and `static-content-library` intentionally depend on Static Site Importer support for importing a source tree with `index.html`, `styles.css`, and plain `.md`/`.markdown` content files. They should be used against SSI branches that implement that mixed HTML shell plus Markdown content path; the prompts explicitly exclude MDX and do not require Studio changes.

### Studio Bench Harness Cleanup

Keep the Studio bench harness layered so each repo owns the smallest stable surface it can support:

- `homeboy-rigs` owns Studio-specific workloads, prompts, and experimental harness wiring while APIs are still moving.
- `homeboy-extensions/nodejs` is the future home for generic Node and browser benchmark utilities once those helpers are reusable outside Studio.
- `homeboy-extensions/wordpress` is the future home for generic WordPress and block quality probes once their contracts are stable.
- `homeboy` core owns benchmark orchestration only; it should stay generic and substrate-agnostic.

Issue [#185](https://github.com/chubes4/homeboy-rigs/issues/185) tracks thinning duplicated helper logic after upstream promotion. Studio native-block quality probing now uses the promoted Homeboy Extensions block theme quality probe from `Extra-Chill/homeboy-extensions#1018`. Fixture plugin install/restore, browser waterfall collection, and trace reporter adoption remain blocked until `Extra-Chill/homeboy-extensions#1132`, `#1131`, and `#1133` land; rigs should not add local fallback shims for those contracts.

Cleanup should move in small waves:

1. Build a shared local Studio bench helper foundation for repeated filesystem, artifact, CLI, and appdata setup.
2. Refactor small workloads onto that foundation without changing benchmark semantics.
3. Replace hardcoded prompt wiring with a dynamic prompt catalog.
4. Extract site-build helpers after repeated setup and probe shapes are clear.
5. Make benchmark files thin orchestrators that compose stable helpers and report metrics.
6. Promote helpers into `homeboy-extensions/*` only after the local APIs settle and at least one non-Studio consumer shape is obvious.

### Cross-run design repetition

Use Homeboy's persisted run store, not bench-side scanning, to detect when repeated `studio-agent-site-build` runs of the same `prompt_variant` are cooking the same visual recipe. Every bench run already records the design fingerprint (`design_repetition_signature`, motifs, palette labels, recipe flags, type pairing) under `results.scenarios[].metadata.*` and `results.scenarios[].metrics.*` in the run record, so `homeboy runs distribution` can aggregate them across runs by component, rig, and scenario.

```bash
# Most-repeated repetition signatures across recent site-build runs.
homeboy runs distribution \
  --kind bench --component studio --rig studio-agent-claude-ssi \
  --scenario studio-agent-site-build \
  --field results.scenarios.metadata.design_repetition_signature \
  --limit 30

# Recurring motifs and palette labels (array fields are flattened automatically).
homeboy runs distribution \
  --kind bench --component studio --rig studio-agent-claude-ssi \
  --scenario studio-agent-site-build \
  --field results.scenarios.metadata.design.motifs \
  --field results.scenarios.metadata.design.palette_labels \
  --limit 30

# Type-pairing concentration across runs.
homeboy runs distribution \
  --kind bench --component studio --rig studio-agent-claude-ssi \
  --scenario studio-agent-site-build \
  --field results.scenarios.metadata.design_type_pairing_signature \
  --limit 30
```

`repeated_values` in the output is the human-meaningful signal: any value with `run_count > 1` is a fingerprint axis the bench has emitted on more than one site. When the latest run's signature shows up there too, the new site is reproducing a prior recipe. The same values are queryable per scenario, exportable across hosts via `homeboy runs export`, and never depend on a temp-dir cache surviving cleanup.

The deterministic write-path workload is `bench/studio-bfb-write-path.bench.mjs`. It creates a fresh Studio site per run, inserts one raw HTML page, and reports phase timings plus stored-block quality metrics (`core_html_blocks`, `bfb_fallback_count`, `serialized_block_comments`, etc.) scoped to that inserted page.

WooCommerce site-generation benchmarks are tracked as future work until the Studio/Static Site Importer store-generation substrate exists. Keep store-specific prompts, product seeding checks, and Woo quality metrics out of this repo until there is a runnable workload.

`rigs/studio-agent-claude-ssi/rig.json` and `rigs/studio-agent-gpt55-ssi/rig.json` are paired bench rigs for Studio agent-runtime and SSI site-build A/B checks across models. `rigs/studio-agent-claude-trunk/rig.json` remains available for trunk-vs-SSI comparisons. They share `bench/studio-agent-runtime.bench.mjs`, `bench/studio-agent-site-build.bench.mjs`, and `bench/studio-bfb-write-path.bench.mjs`.

`stacks/studio-combined.json` rebuilds `fork/dev/combined-fixes` from `origin/trunk` plus Chris's active Automattic/studio local-dev PRs.

## WordPress/wordpress-playground

`stacks/playground-combined.json` rebuilds `origin/dev/combined-fixes` from `upstream/trunk` plus Chris's active PHP-WASM and worker-pool PRs.

`rigs/playground-cli-diagnostics/rig.json` runs focused Playground CLI repros against the local `~/Developer/wordpress-playground` checkout. The first workload captures whether Blueprint `runPHP` fatal errors surface useful diagnostics or collapse to a blank `Error:` line.

```bash
homeboy rig install --all ./WordPress/wordpress-playground
homeboy rig check playground-cli-diagnostics
homeboy bench --rig playground-cli-diagnostics --scenario playground-cli-runphp-errors --iterations 1 --shared-state /tmp/playground-cli-diagnostics
```

## woocommerce/woocommerce

`rigs/woocommerce-performance/rig.json` runs WooCommerce checkout/shipping cache
performance workloads against a local WooCommerce monorepo checkout mounted into
the WP Codebox WordPress bench runtime.

```bash
homeboy rig install /Users/chubes/Developer/homeboy-rigs@<branch>/woocommerce/woocommerce
homeboy rig check woocommerce-performance
homeboy rig up woocommerce-performance
homeboy bench --rig woocommerce-performance --scenario checkout-shipping-cache --iterations 1 --shared-state /tmp/woocommerce-performance-bench
```

The runner must provide `~/Developer/woocommerce/plugins/woocommerce`. The rig
check reports missing checkout, Composer dependency, and generated feature-config
prerequisites with targeted messages. Use `homeboy rig up` for the safe dependency
prep path before benchmarking.

## woocommerce/woocommerce-gateway-stripe

`rigs/woocommerce-stripe-ece-product-page/rig.json` runs the product-page
Express Checkout Element browser waterfall trace against a local WooCommerce
Stripe checkout plus a packaged WooCommerce dependency.

```bash
homeboy rig install /Users/chubes/Developer/homeboy-rigs@<branch>/woocommerce/woocommerce-gateway-stripe
homeboy rig check woocommerce-stripe-ece-product-page
homeboy trace --rig woocommerce-stripe-ece-product-page woocommerce-gateway-stripe ece-product-page-waterfall --output /tmp/wc-stripe-ece-waterfall.json
```

Additional trace scenarios cover post-load interactions for scrolling to the ECE
container, changing quantity, and attempting variation changes while preserving
the original load-only `smoke` behavior.

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page woocommerce-gateway-stripe ece-product-page-scroll-to-ece
homeboy trace --rig woocommerce-stripe-ece-product-page woocommerce-gateway-stripe ece-product-page-quantity-change
homeboy trace --rig woocommerce-stripe-ece-product-page woocommerce-gateway-stripe ece-product-page-variation-change
```

The `smoke` profile keeps the default WP Codebox browser behavior. The optional
`secure-browser` profile depends on generic upstream preview/profile contracts
from Extra-Chill/homeboy#3554 and Automattic/wp-codebox#651/#652 and keeps
Stripe-specific scenario behavior in this rig package.
Default local HTTP/headless traces are request/lifecycle evidence, not wallet
eligibility proof. Secure-context plumbing evidence requires the
`secure-browser` profile and an HTTPS public preview URL; each trace records
requested/effective browser context metadata so the evidence type is explicit.

```bash
homeboy trace --rig woocommerce-stripe-ece-product-page \
  --setting woocommerce_stripe_ece_browser_profile=secure-browser \
  --setting woocommerce_stripe_ece_preview_public_url=https://example.test \
  woocommerce-gateway-stripe ece-product-page-waterfall \
  --output /tmp/wc-stripe-ece-secure-browser.json
```

Use the `real-wallet` profile for real-wallet-capable evidence. It fails fast
unless `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, and an HTTPS public
`HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL` are present. Metrics explicitly mark
real-wallet artifacts with `ece_real_wallet_capable: true` and synthetic traces
with `ece_synthetic_only: true`.

```bash
export STRIPE_PUBLISHABLE_KEY=pk_test_...
export STRIPE_SECRET_KEY=sk_test_...
export HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL=https://example.test

homeboy trace --rig woocommerce-stripe-ece-product-page \
  --profile real-wallet \
  woocommerce-gateway-stripe ece-product-page-waterfall \
  --output /tmp/wc-stripe-ece-real-wallet.json
```

## chubes4/isolated-block-editor

`rigs/isolated-block-editor/rig.json` runs the checks used while shaving Isolated Block Editor toward modern Gutenberg APIs.

## Conventions

- **Component paths** use `~/Developer/<repo>` for primary checkouts and `~/Developer/<repo>@<branch-slug>` for worktrees, mirroring the data-machine-code workspace convention.
- **Package directories** use the owning repo's fully qualified name. Cross-repo rigs live under the product/workflow owner.
- **Bench workloads** live beside their owning rig and use `${package.root}` so installed rig packages resolve their own portable workload files.
- **Branches** in `components.<id>.branch` document the expected branch — rigs don't currently enforce branch state, but the field hints to humans reading the spec.
- **Patches** carry a unique marker string (`PHP-WASM-COMBINED-FIXES TSRMLS fallback`, etc.) that identifies the patch in the file. Marker-based idempotency means re-running `up` is safe.
- **External services** (`kind: external`) are processes the rig didn't spawn — the rig only knows how to *stop* them via `discover.pattern`. Use this for stale daemons that need recycling after a build.

## What does NOT belong here

- Site state (DB, uploads) — Studio site backups handle that.
- Agent state (MEMORY.md, wiki, skills) — DMC GitSync handles that.
- Source code (plugins, themes) — already tracked in their own repos.
- Secrets — rigs reference env vars or sigillo paths; never embed.

## Per-machine state

Each rig writes runtime state (PIDs, last-up timestamps, service status) to `<id>.state/` next to `<id>.json`. Those directories are `.gitignore`d — they're not portable across machines.
