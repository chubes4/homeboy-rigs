# Jetpack Rigs

## `jetpack-api-route-inventory`

Declares the Jetpack fuzz coverage suite for REST/API, module state, module option/table inventory, admin pages, database/query profiling, options, cron/sync actions, sync queue behavior, connected/disconnected fixture state, public-module frontend rendering, performance observation summaries, external HTTP guardrails, and browser/admin request coverage. The suite uses generic fuzz workload manifests under `fuzz/`; it does not declare fuzz workloads as bench fallbacks, and it does not claim that full Jetpack fuzz execution is proven.

Install locally:

```sh
homeboy rig install ./Automattic/jetpack
```

Check the rig package:

```sh
homeboy rig check jetpack-api-route-inventory
homeboy rig check jetpack-browser-coverage
```

Validate manifest shape locally; run fuzz workloads only through the generic fuzz command in target Homeboy installs that expose it. Do not use `homeboy bench` as a fallback for these coverage manifests.

```sh
node Automattic/jetpack/tools/validate-fuzz-manifests.mjs
homeboy fuzz list --rig jetpack-api-route-inventory
```

Use offloaded Lab runners for proof campaigns. Listing workloads confirms declarations only; P status requires persisted `homeboy fuzz run` artifacts, coverage gap reports, and non-local proof references.

Generate Lab-only commands for stable Jetpack profiling proof runs:

```sh
node Automattic/jetpack/tools/stable-workload-lab-commands.mjs \
  --prefer-core-planner \
  --runner LAB_RUNNER_ID \
  --artifact-root ARTIFACT_ROOT \
  --run-id-prefix jetpack-stable-YYYYMMDD \
  --tracker-ref github:Automattic/jetpack#ISSUE_OR_PR
```

The generator emits one `homeboy fuzz run --lab-only` command per stable workload entry and compare commands for persisted refs, elapsed-time trends, and hotspot deltas. It does not execute workloads locally. When the installed Homeboy includes `homeboy fuzz stable-plan`, `--prefer-core-planner` delegates planning to core; otherwise the rig-local migration planner emits the same Lab-only command surface.

The rig exposes `smoke`, `fuzzer`, and `full-surface` `fuzz_profiles` for fleet
orchestration. These profiles only group existing fuzz workload declarations;
they do not change readiness levels or convert declarations into proof.

The coverage manifests live under `manifests/`, with executable/declarative fuzz workload manifests under `fuzz/`. REST cases declare permission classifications for public, local-authenticated, administrator, connected-site, and WP.com-dependent boundaries. DB inventory declares Jetpack table prefixes plus module/options state. External HTTP guardrail probes block `.invalid` synthetic hosts, declare `public-api.wordpress.com` as the WP.com allowlisted boundary, and still disallow real external service calls in the fixture. Local module/options/sync/cron mutation routes through the upstream disposable destructive contract and is not blocked on rollback. True WP.com connected-state behavior stays blocked until an explicit OAuth app, sandbox blog, service account, or exact equivalent is provisioned.

Current Jetpack coverage status:

- D/E read-only: `jetpack-rest-route-inventory`, generated REST cases, `db-inventory`, `rest-db-query-profile`, `jetpack-module-option-table-inventory`, admin/browser request coverage paths, public-module frontend request coverage, and external HTTP guardrail contracts.
- E local disposable mutation: `jetpack-options-matrix`, `jetpack-module-state-matrix`, `jetpack-cron-sync-actions`, and `jetpack-sync-queue-coverage` wire to the upstream disposable destructive contract with `rollback_required=false`.
- D connected remote state: true WP.com connected behavior remains provision-blocked until an OAuth app, sandbox blog, service account, or exact equivalent exists; local placeholder connection fixtures only classify boundaries and skips.
- D performance: `jetpack-performance-observation` is a summary contract for relative hotspot artifacts, query-count, asset, sync, skip-count, slow-surface, and HTTP guardrail outputs; no targeted Jetpack performance bug repro is linked here yet.

Next proof artifacts before any Jetpack row moves to P: non-local `homeboy fuzz run` IDs, REST route coverage diffs, admin/browser request coverage artifacts, DB inventory/query profile artifacts, external HTTP guardrail collections, module/option/sync/cron disposable mutation contract rows, connected/disconnected skip-reason artifacts, coverage gap reports, and `metadata.readiness.proof_bundle.fuzz_result_artifacts` entries.
