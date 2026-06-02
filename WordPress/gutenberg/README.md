# Gutenberg RTC Homeboy Rig

Durable Homeboy rig package for stress testing Gutenberg real-time collaboration
in the post editor.

## Goals

- Exercise the real `/wp-sync/v1/updates` WordPress endpoint through the
  Homeboy Extensions WordPress bench adapter on a disposable WP Codebox runtime.
- Capture benchmark metrics, traces, final document snapshots, seeds, and
  reproduction commands as Homeboy artifacts.
- Keep repeatable failures tied to Gutenberg issues or PRs before using rig
  results as maintainer-facing evidence.

## Initial Commands

```bash
homeboy rig install /Users/chubes/Developer/homeboy-rigs@<branch>/WordPress/gutenberg
homeboy rig check gutenberg-rtc
homeboy bench --rig gutenberg-rtc --scenario gutenberg-rtc-protocol-load --iterations 1
homeboy bench --rig gutenberg-rtc --profile hot --iterations 1 --setting-json 'bench_env={"GUTENBERG_RTC_CLIENTS":"1000"}' --force-hot
```

`homeboy-rigs` owns the RTC workload. `homeboy bench --rig gutenberg-rtc`
runs it through Homeboy Extensions' `wordpress.bench` adapter, which uses
WP Codebox as a disposable WordPress runtime substrate. The adapter mounts
Gutenberg as the runtime plugin, mounts the rig's PHP workload into
`tests/bench/`, and returns the normalized Homeboy `BenchResults` envelope.

## Layers

```text
homeboy-rigs workload             Gutenberg-specific protocol-load PHP workload
Homeboy Extensions wordpress.bench adapter and BenchResults envelope
WP Codebox runtime substrate      disposable WP 7.0 runtime, no Docker/wp-env
Synthetic REST clients            10-1000 clients, real WP sync endpoint load
```

See `docs/rtc-rig-plan.md` for the implementation plan.

## Current Workloads

- `gutenberg-rtc-protocol-load` is a `homeboy-rigs` PHP workload that runs in
  the disposable WP Codebox runtime, creates a draft post, enables RTC, and
  drives `/wp-sync/v1/updates` with configurable synthetic clients using opaque
  sync payloads.

## Metric Semantics

- `divergent_clients` is an opaque synthetic-payload stress signal for the
  protocol-load workload. Opaque payloads are intentionally not a full Yjs
  document model, so non-zero divergence means clients observed different
  synthetic update sets under load; it is not by itself a correctness failure.
- Pass/fail gates for opaque protocol-load runs stay tied to endpoint health,
  request handling, and artifact capture. Track `divergent_clients` over time in
  scale-matrix summaries to spot changes in sync behavior under load.
- When the workload runs with real Yjs payloads, non-zero divergence is a
  convergence failure because clients should reach the same document state.
