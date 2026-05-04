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
Automattic/studio/rigs/studio/rig.json
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

`rigs/studio/rig.json` is the Studio + Playground combined-fixes dev environment: forks rebased onto trunk, open PRs cherry-picked, Docker-compiled PHP-WASM glue, tarball server, and Studio CLI rewired to local tarballs.

```bash
homeboy rig check studio
homeboy rig up studio
homeboy rig down studio
```

`rigs/studio/rig.json` also declares the `studio-site-create` bench workload for timing fresh Studio site provisioning through the combined-fixes dev copy.

```bash
homeboy bench --rig studio --scenario studio-site-create --iterations 1 --shared-state /tmp/studio-site-create-bench
```

The workload creates one `--no-start` site and one normally-started site per iteration, then reports create, started-site status, stop, and total timings. Artifacts are written below the shared-state directory for inspection.

The Studio trace workload exercises the packaged app at `apps/studio/out` and records create-site readiness boundaries across the desktop shell, CLI log output, `cli.json`, HTTP readiness, `getSiteDetails()`, and the visible running-state UI.

```bash
homeboy trace --rig studio studio list
homeboy trace --rig studio studio studio-app-create-site --output /tmp/studio-app-create-site-trace.json
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

`rigs/studio-bfb/rig.json` is the local Studio/BFB mu-plugin playground rig. It verifies raw HTML writes store native blocks through the BFB substrate and declares `studio-agent-claude-ssi` as its default benchmark baseline for same-substrate agent site-build comparisons.

```bash
homeboy rig up studio-bfb
homeboy bench --rig studio-bfb --iterations 1 --shared-state /tmp/studio-bfb-bench
```

The site-build workload accepts a runtime namespace for parallel prompt-variant runs. The prompt variant still controls benchmark semantics; `studio_bench_namespace` only isolates runtime resources such as artifacts, Studio CLI config, appdata, daemon sockets, temp files, site roots, and the derived port range.

```bash
HOMEBOY_SETTINGS_STUDIO_SITE_BUILD_PROMPT_VARIANT=restaurant \
HOMEBOY_SETTINGS_STUDIO_BENCH_NAMESPACE=restaurant-a \
homeboy bench --rig studio-bfb --scenario studio-agent-site-build --iterations 1 --shared-state /tmp/studio-bfb-bench &

HOMEBOY_SETTINGS_STUDIO_SITE_BUILD_PROMPT_VARIANT=saas \
HOMEBOY_SETTINGS_STUDIO_BENCH_NAMESPACE=saas-a \
homeboy bench --rig studio-bfb --scenario studio-agent-site-build --iterations 1 --shared-state /tmp/studio-bfb-bench &

wait
```

The site-build workload also emits generated-theme UX gates in `generated-theme-ux-gates.json`. This first slice catches serialized `wp:freeform` count drift against the Static Site Importer report and CSS-hidden reveal content that lacks an editor override, which can make the Site Editor canvas appear blank even when the frontend looks acceptable. Remaining gates to automate are Site Editor above-the-fold visible text, footer utility links converted into responsive navigation overlays, and fixed/sticky chrome overlapping the WordPress admin bar.

Mixed-source prompt variants such as `astro-docs-content-collection`, `markdown-blog-launch-site`, and `static-content-library` intentionally depend on Static Site Importer support for importing a source tree with `index.html`, `styles.css`, and plain `.md`/`.markdown` content files. They should be used against SSI branches that implement that mixed HTML shell plus Markdown content path; the prompts explicitly exclude MDX and do not require Studio changes.

### Cross-run design repetition

Use Homeboy's persisted run store, not bench-side scanning, to detect when repeated `studio-agent-site-build` runs of the same `prompt_variant` are cooking the same visual recipe. Every bench run already records the design fingerprint (`design_repetition_signature`, motifs, palette labels, recipe flags, type pairing) under `results.scenarios[].metadata.*` and `results.scenarios[].metrics.*` in the run record, so `homeboy runs distribution` can aggregate them across runs by component, rig, and scenario.

```bash
# Most-repeated repetition signatures across recent site-build runs.
homeboy runs distribution \
  --kind bench --component studio --rig studio-bfb \
  --scenario studio-agent-site-build \
  --field results.scenarios.metadata.design_repetition_signature \
  --limit 30

# Recurring motifs and palette labels (array fields are flattened automatically).
homeboy runs distribution \
  --kind bench --component studio --rig studio-bfb \
  --scenario studio-agent-site-build \
  --field results.scenarios.metadata.design.motifs \
  --field results.scenarios.metadata.design.palette_labels \
  --limit 30

# Type-pairing concentration across runs.
homeboy runs distribution \
  --kind bench --component studio --rig studio-bfb \
  --scenario studio-agent-site-build \
  --field results.scenarios.metadata.design_type_pairing_signature \
  --limit 30
```

`repeated_values` in the output is the human-meaningful signal: any value with `run_count > 1` is a fingerprint axis the bench has emitted on more than one site. When the latest run's signature shows up there too, the new site is reproducing a prior recipe. The same values are queryable per scenario, exportable across hosts via `homeboy runs export`, and never depend on a temp-dir cache surviving cleanup.

The deterministic write-path workload is `bench/studio-bfb-write-path.bench.mjs`. It creates a fresh Studio site per run, inserts one raw HTML page, and reports phase timings plus stored-block quality metrics (`core_html_blocks`, `bfb_fallback_count`, `serialized_block_comments`, etc.) scoped to that inserted page.

`bench/studio-ssi-woo-fixture-validation.bench.mjs` carries a disabled fixture scaffold for Static Site Importer WooCommerce primitives. It records the static store fixture and `products.json` manifest, then reports a skip until SSI implements manifest validation, product seeding, and product context forwarding. Enable it with `HOMEBOY_ENABLE_SSI_WOO_FIXTURE=1` only against an SSI branch that exposes those primitives; the rig must not seed WooCommerce products itself.

`rigs/studio-agent-claude-ssi/rig.json` and `rigs/studio-agent-gpt55-ssi/rig.json` are paired bench rigs for Studio agent-runtime and SSI site-build A/B checks across models. `rigs/studio-agent-claude-trunk/rig.json` remains available for trunk-vs-SSI comparisons. They share `bench/studio-agent-runtime.bench.mjs`.

`stacks/studio-combined.json` rebuilds `fork/dev/combined-fixes` from `origin/trunk` plus Chris's active Automattic/studio local-dev PRs.

## WordPress/wordpress-playground

`stacks/playground-combined.json` rebuilds `origin/dev/combined-fixes` from `upstream/trunk` plus Chris's active PHP-WASM and worker-pool PRs.

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
