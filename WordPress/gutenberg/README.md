# Gutenberg Rigs

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
