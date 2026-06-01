# Gutenberg RTC Rig Plan

## 1. Rig Contract

Create a package installable with `homeboy rig install ./WordPress/gutenberg`.
The rig points at the local Gutenberg checkout and runs WordPress benchmark
workloads through Homeboy Extensions' WP Codebox backend.

```text
WordPress/gutenberg/
  rigs/gutenberg-rtc/rig.json
  bench/gutenberg-rtc-protocol-load.php
```

## 2. Benchmark Pyramid

### Browser Basic

Purpose: catch visible editor bugs and small-team correctness regressions.

Scenarios:

- 2 users editing the same paragraph.
- 2 users editing different blocks.
- 3 users at the default client limit.
- 4 users over the default client limit, expecting graceful rejection.
- Reload, close, reconnect, and stale awareness cleanup.

Metrics:

- `mutual_discovery_ms`
- `first_sync_ms`
- `convergence_ms`
- `rest_error_count`
- `final_state_equal`

Artifacts:

- Playwright trace.
- Screenshot on failure.
- Final block JSON for each client.
- Sync request log.

### Browser Tabs

Purpose: model real user tab explosion without pretending Chromium process count
is a scalable load generator.

Scenarios:

- 1 user with 5 tabs on the same post.
- 10 users with 5 tabs each.
- Mixed foreground/background tabs to exercise the 25s background polling path.
- Session expiry and manual retry flows.

Metrics:

- `tabs_opened`
- `background_poll_count`
- `foreground_poll_count`
- `disconnect_dialog_count`
- `reconnect_success_rate`

### Protocol Load

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

### Conflict Fuzzer

Purpose: find correctness bugs in concurrent operations, not just perf cliffs.

Operation set:

- Insert text.
- Delete text.
- Replace text.
- Split paragraph.
- Merge paragraph.
- Insert block.
- Move block.
- Update block attributes.
- Undo/redo.
- Save/autosave/reload.

Invariant checks:

- Every active client converges to the same block tree.
- Persisted post content parses as valid block markup.
- `_crdt_document` remains readable after reload.
- No client gets stuck disconnected after retries unless the scenario expects it.

### Settings Matrix

Purpose: prove bugs are not hidden behind one idealized site shape.

Axes:

- Collaboration enabled/disabled.
- Roles: admin, editor, author, contributor, mixed permissions.
- Post status: auto-draft, draft, scheduled, published.
- Document size: tiny, normal, large, huge.
- Metabox compatibility on/off.
- Autosave/revisions pressure.
- Permalink settings.
- Classic editor-adjacent screens where RTC must stay disabled.

## 3. Implementation Sequence

1. Make `homeboy bench list --rig gutenberg-rtc` discover the WP Codebox-backed
   protocol scenario.
2. Implement `protocol-load` as a PHP `wordpress.bench` workload mounted from
   the rig package into the disposable Codebox runtime.
3. Create one post, enable collaboration, and hit `/wp-sync/v1/updates` directly
   through the WordPress REST server.
4. Add artifact capture and deterministic seeds.
5. Run local smoke with 10 synthetic clients.
7. Add hot profiles: 100 synthetic clients and 1000 synthetic clients, intended
   for `homeboy bench --runner <lab-runner>` or `--force-hot`.
8. Promote recurring failures into Gutenberg issues/PRs with artifact links.

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
