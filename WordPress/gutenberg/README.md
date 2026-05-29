# Gutenberg RTC Homeboy Rig

Durable Homeboy rig package for stress testing Gutenberg real-time collaboration
in the post editor.

## Goals

- Exercise real editor behavior with Playwright for small and medium scenarios.
- Exercise the real `/wp-sync/v1/updates` WordPress endpoint with synthetic Yjs
  clients for high-cardinality load.
- Capture benchmark metrics, traces, final document snapshots, seeds, and
  reproduction commands as Homeboy artifacts.
- Keep repeatable failures tied to Gutenberg issues or PRs before using rig
  results as maintainer-facing evidence.

## Initial Commands

```bash
homeboy rig install /Users/chubes/Developer/homeboy-rigs@<branch>/WordPress/gutenberg
homeboy rig check gutenberg-rtc
homeboy bench --rig gutenberg-rtc --scenario gutenberg-rtc-browser-basic --iterations 1
homeboy bench --rig gutenberg-rtc --scenario gutenberg-rtc-protocol-load --iterations 1 --setting rtc_clients=100
homeboy bench --rig gutenberg-rtc --profile hot --iterations 1 --setting rtc_clients=1000 --force-hot
```

`homeboy bench --rig gutenberg-rtc` runs the rig's `bench_prepare` pipeline before
the timed workload. That pipeline installs Gutenberg npm dependencies when
`node_modules/.bin/wp-env` is missing, then Homeboy runs the normal rig health
check before benchmark timing starts.

## Layers

```text
Playwright editor sessions        2-25 clients, real UI correctness
Synthetic Yjs/REST clients        10-1000 clients, real WP sync endpoint load
Seeded conflict fuzzer            deterministic operation streams
Settings matrix                   roles, post states, metaboxes, autosave, doc size
```

See `docs/rtc-rig-plan.md` for the implementation plan.

## Current Workloads

- `gutenberg-rtc-browser-basic` runs core two-user collaboration Playwright specs.
- `gutenberg-rtc-browser-tabs` runs reload, self-presence, and cursor-awareness specs.
- `gutenberg-rtc-protocol-load` starts `wp-env-test`, creates a draft post, enables RTC, then drives `/wp-sync/v1/updates` with configurable synthetic clients. It uses Yjs when Gutenberg dependencies expose `yjs`, and falls back to opaque sync payloads so endpoint/storage load still runs on lean installs.
- `gutenberg-rtc-conflict-fuzzer` runs the existing stress, undo/redo, and block-gauntlet specs as the first correctness gauntlet.
- `gutenberg-rtc-settings-matrix` runs metabox, document-size, sync-error, and autodraft specs.
