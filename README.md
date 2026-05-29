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

## Automattic/studio

`rigs/studio-combined/rig.json` is the Studio + Playground combined-fixes dev environment: forks rebased onto trunk, open PRs cherry-picked, Docker-compiled PHP-WASM glue, tarball server, and Studio CLI rewired to local tarballs.

```bash
homeboy rig check studio-combined
homeboy rig up studio-combined
homeboy rig down studio-combined
```

`rigs/studio-combined/rig.json` also declares the `studio-site-create` bench workload for timing fresh Studio site provisioning through the combined-fixes dev copy.

```bash
homeboy bench --rig studio-combined --scenario studio-site-create --iterations 1 --shared-state /tmp/studio-site-create-bench
```

The workload creates one `--no-start` site and one normally-started site per iteration, then reports create, started-site status, stop, and total timings. Artifacts are written below the shared-state directory for inspection.

`studio-db-dropin-startup` isolates Studio's SQLite `db.php` drop-in behavior. It creates a stock stopped site, creates a second stopped site whose valid SQLite `db.php` is changed into a custom drop-in, starts both, and reports whether the custom drop-in survived plus the custom-vs-stock startup delta.

```bash
homeboy bench --rig studio-combined --scenario studio-db-dropin-startup --iterations 1 --shared-state /tmp/studio-db-dropin-bench
homeboy bench --rig studio-combined --scenario studio-db-dropin-startup --iterations 1 --shared-state /tmp/studio-db-dropin-bench-reverse --setting studio_db_dropin_start_order=custom-first
```

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

## WordPress/gutenberg

`rigs/gutenberg-rtc/rig.json` is the planned Gutenberg real-time collaboration stress rig. It is structured around small/medium Playwright editor scenarios plus high-cardinality synthetic Yjs/REST load against the real WordPress sync endpoint.

```bash
homeboy rig install ./WordPress/gutenberg
homeboy rig check gutenberg-rtc
homeboy bench --rig gutenberg-rtc --profile smoke --iterations 1 --setting rtc_clients=10
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
