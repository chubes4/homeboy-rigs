# Gutenberg Rigs

## `gutenberg-api-route-inventory`

Captures a lightweight inventory of registered Gutenberg-facing REST routes
without executing API requests. This is an adapter scaffold for applying generic
Homeboy Extensions / WP Codebox API performance primitives to Gutenberg later.

Install locally:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/WordPress/gutenberg
```

Run the route inventory workload:

```sh
homeboy bench --rig gutenberg-api-route-inventory --scenario gutenberg-rest-route-inventory --iterations 1 --shared-state /tmp/gutenberg-api-inventory
```

Run the currently executable full-surface profile:

```sh
homeboy bench --rig gutenberg-api-route-inventory --profile full-surface --iterations 1 --shared-state /tmp/gutenberg-full-surface
```

The coverage manifest lives at `manifests/rest-route-coverage.json`. It keeps
Gutenberg-specific route grouping in this rig package so upstream primitives can
stay generic.

## `gutenberg` fuzzer profile

`manifests/fuzzer-profile.json` defines a rig-owned Gutenberg fuzzer profile analogous to the Woo full-surface shape. It composes REST route coverage, `wp-admin` and editor page coverage, block editor load/action probes, Site Editor probes, block rendering, DB query/profile hooks, hook/option/postmeta/runtime-state inventory, editor performance observation summaries, external HTTP guardrails, and coverage-gap reporting without moving Gutenberg-specific knowledge into Homeboy core or Homeboy Extensions.

Run the fuzzer manifests through the WordPress extension runner:

```sh
homeboy fuzz --rig gutenberg-api-route-inventory --runner wordpress --shared-state /tmp/gutenberg-fuzzer
```

See `docs/fuzzer-profile.md` for the gap-report contract and current limits.

Current D/E-only fuzz workload additions:

- `gutenberg-hooks-options-inventory` declares hook, option, postmeta, template/pattern, cron/state, transient, and editor-state inventory so remote-cache pressure is visible in the same artifact. It is not P until a fuzz run emits the runtime-state artifact.
- `gutenberg-editor-performance-observation` declares editor, Site Editor, block rendering, pattern preview, notes unsaved attachment, request timing, query count, asset fanout, and HTTP guardrail summaries. Pattern preview has issue-linked proof separately; this summary manifest needs its own artifacts before P.
- `gutenberg-external-http-guardrail-fuzz` blocks network, treats `api.wordpress.org` as the only approved host, treats `patterns.wordpress.org` as the synthetic blocked probe host, and expects no real external service calls.

## `gutenberg-pattern-preview-assets`

Reproduces the pattern preview asset fan-out reported in [WordPress/gutenberg#68979](https://github.com/WordPress/gutenberg/issues/68979), with downstream request-spike symptoms discussed in [WordPress/gutenberg#71547](https://github.com/WordPress/gutenberg/issues/71547).

The workload mounts the local Gutenberg checkout plus a generated fixture plugin that registers synthetic blocks with unique editor scripts/styles and synthetic patterns that use those blocks. It opens the page editor, captures browser network/performance artifacts, and reports whether pattern preview iframes repeatedly load the same fixture assets.

Install locally:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/WordPress/gutenberg
```

Run the baseline repro:

```sh
homeboy trace --rig gutenberg-pattern-preview-assets gutenberg pattern-preview-assets
```

Useful environment knobs:

```sh
HOMEBOY_GUTENBERG_PATTERN_ASSETS_BLOCK_COUNT=6
HOMEBOY_GUTENBERG_PATTERN_ASSETS_PATTERN_COUNT=12
HOMEBOY_GUTENBERG_PATTERN_ASSETS_PROBE_DURATION=12s
HOMEBOY_GUTENBERG_PATTERN_ASSETS_WP_VERSION=7.0
HOMEBOY_GUTENBERG_PATTERN_ASSETS_READINESS_TIMEOUT_MS=12000
HOMEBOY_GUTENBERG_PATTERN_ASSETS_ASSET_DELAY_MS=0
HOMEBOY_GUTENBERG_PATTERN_ASSETS_SERIALIZE_DELAY=0
```

`HOMEBOY_GUTENBERG_PATTERN_ASSETS_ASSET_DELAY_MS` makes the fixture serve block assets through PHP with a fixed response delay. `HOMEBOY_GUTENBERG_PATTERN_ASSETS_SERIALIZE_DELAY=1` holds a file lock during that delay to model constrained PHP worker/program-execution capacity, which is the host-level pressure described in the linked issues.

The workload records preview readiness timings, long-task totals, fixture asset response counts, unique fixture asset counts, and browser error counts in `pattern-preview-assets-metrics.json`.
