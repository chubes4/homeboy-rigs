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

`manifests/fuzzer-profile.json` defines a rig-owned Gutenberg fuzzer profile analogous to the Woo full-surface shape. It composes REST route coverage, safe `wp-admin` and editor page enumeration, block editor load/action probes, Site Editor probes, block rendering, frontend rendering/request coverage, DB query/profile hooks, hook/option/postmeta/runtime-state inventory, editor performance observation summaries, external HTTP guardrails, and coverage-gap reporting without moving Gutenberg-specific knowledge into Homeboy core or Homeboy Extensions.

Inspect and run fuzzer manifests through Homeboy's generic fuzz command:

```sh
homeboy fuzz list --rig gutenberg-api-route-inventory
homeboy fuzz run --rig gutenberg-api-route-inventory --workload gutenberg-rest-route-fuzz --run-id gutenberg-rest-route-fuzz --seed 1 --max-duration 10m
```

Use an offloaded Lab runner for heavy proof campaigns. A `homeboy fuzz list` result is only a declaration check; P status requires persisted `homeboy fuzz run` evidence and artifacts.

See `docs/fuzzer-profile.md` for the gap-report contract and current limits.

`manifests/api-db-lab-cell.json` recovers the Gutenberg 1 API/DB Lab cell as a coverage contract. It pins REST namespace coverage, role permission-boundary expectations, DB query attribution fields, option/postmeta state attribution, entity fixtures, and the proof artifact sections required before this surface can be marked P.

Current D/E-only fuzz workload additions:

- `gutenberg-hooks-options-inventory` declares hook, option, postmeta, template/pattern, cron/state, transient, and editor-state inventory so remote-cache pressure is visible in the same artifact. It is not P until a fuzz run emits the runtime-state artifact.
- `gutenberg-editor-performance-observation` declares editor, Site Editor, block rendering, pattern preview, notes unsaved attachment, request timing, query count, asset fanout, and HTTP guardrail summaries. Pattern preview has issue-linked proof separately; this summary manifest needs its own artifacts before P.
- `gutenberg-admin-page-coverage` declares bounded read-only `wp-admin`/editor enumeration and records skipped destructive reason codes instead of executing unsafe actions.
- `frontend-rendering-request-coverage` declares browser request coverage for a disposable published Gutenberg fixture page and dynamic block rendering requests.
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
