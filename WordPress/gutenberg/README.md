# Gutenberg RTC Homeboy Rig

Durable Homeboy rig package for stress testing Gutenberg real-time collaboration
in the post editor.

## Goals

- Exercise the real `/wp-sync/v1/updates` WordPress endpoint inside the
  WP Codebox-backed WordPress bench runtime.
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

`homeboy bench --rig gutenberg-rtc` runs through Homeboy Extensions'
`wordpress.bench` / WP Codebox backend. WP Codebox owns the disposable WordPress
runtime, mounts Gutenberg as the runtime plugin, mounts the rig's PHP workload
into `tests/bench/`, and returns the normalized Homeboy `BenchResults` envelope.

## Layers

```text
WP Codebox WordPress runtime      disposable WP 7.1 runtime, no Docker/wp-env
Synthetic REST clients            10-1000 clients, real WP sync endpoint load
Homeboy BenchResults              normalized metrics, metadata, artifacts
```

See `docs/rtc-rig-plan.md` for the implementation plan.

## Current Workloads

- `gutenberg-rtc-protocol-load` runs inside WP Codebox, creates a draft post,
  enables RTC, and drives `/wp-sync/v1/updates` with configurable synthetic
  clients using opaque sync payloads.
