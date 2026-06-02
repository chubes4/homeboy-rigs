# Gutenberg RTC Rig Plan

## 1. Rig Contract

Create a package installable with `homeboy rig install ./WordPress/gutenberg`.
The rig points at the local Gutenberg checkout and owns the Gutenberg-specific
protocol-load workload. Homeboy Extensions' `wordpress.bench` adapter runs that
workload on a disposable WP Codebox WordPress runtime.

```text
WordPress/gutenberg/
  rigs/gutenberg-rtc/rig.json
  bench/gutenberg-rtc-protocol-load.php
```

## 2. Protocol Load Workload

Purpose: stress the real WordPress REST sync endpoint at high cardinality.

Scenarios:

- 10 synthetic clients smoke.
- 100 synthetic clients normal load.
- 1000 synthetic clients hot load.
- Burst joins, staggered joins, churn, and offline catch-up.
- Compaction threshold pressure and request-size boundary pressure.

Metrics:

- `client_count`
- `requests_total`
- `requests_per_second`
- `sync_p50_ms`
- `sync_p95_ms`
- `sync_p99_ms`
- `http_4xx_count`
- `http_5xx_count`
- `stored_update_count`
- `compaction_count`
- `divergent_clients`
- `final_crdt_equal`

`divergent_clients` is a tracked stress signal for opaque synthetic payloads,
not a correctness gate. It counts clients whose observed synthetic update set
differs from the baseline client after catch-up. Treat non-zero values as scale
matrix evidence to compare across runs. In real Yjs payload mode, divergence is a
convergence failure because all clients should share the same final document
state.

Artifacts:

- Seed and scenario config.
- Per-client final CRDT state vector hash.
- HTTP response histogram.
- Storage room summary.

## 3. Implementation Sequence

1. Make `homeboy bench list --rig gutenberg-rtc` discover the `homeboy-rigs`
   protocol scenario.
2. Implement `protocol-load` as a PHP `wordpress.bench` workload mounted from
   the rig package into the disposable Codebox runtime.
3. Create one post, enable collaboration, and hit `/wp-sync/v1/updates` directly
   through the WordPress REST server.
4. Add artifact capture and deterministic seeds.
5. Run local smoke with 10 synthetic clients.
6. Add hot profiles: 100 synthetic clients and 1000 synthetic clients, intended
   for `homeboy bench --runner <lab-runner>` or `--force-hot`.
7. Promote recurring failures into Gutenberg issues/PRs with artifact links.

## 4. Guardrails

- Do not use 1000 browser tabs as the primary hot path; that mostly measures
  Chromium and host process limits.
- Use synthetic clients for 100/1000-client load while preserving the real
  WordPress REST server, auth, permission, storage, compaction, and payload
  limits.
- Treat opaque synthetic-payload divergence as a metric, not a hard failure;
  reserve convergence failure gates for realistic document payloads.
- Keep scenario failures reproducible with `seed`, `client_count`, `operation`
  profile, and created post ID in the artifact.
- Do not publish local-only artifact paths as maintainer-facing evidence; mirror
  evidence into PR comments, issue comments, or persisted Homeboy artifacts.
