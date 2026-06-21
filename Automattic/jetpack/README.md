# Jetpack Rigs

## `jetpack-api-route-inventory`

Declares the Jetpack fuzz coverage suite for REST/API, module state, module option/table inventory, admin pages, database/query profiling, options, cron/sync actions, sync queue behavior, connected/disconnected fixture state, public-module frontend rendering, performance observation summaries, external HTTP guardrails, and browser/admin request coverage. The suite uses generic fuzz workload manifests under `fuzz/`; it does not declare fuzz workloads as bench fallbacks.

Install locally:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/Automattic/jetpack
```

Check the rig package:

```sh
homeboy rig check jetpack-api-route-inventory
homeboy rig check jetpack-browser-coverage
```

Run fuzz workloads only through the generic fuzz command in target Homeboy installs that expose it. Do not use `homeboy bench` as a fallback for these coverage manifests.

```sh
homeboy fuzz list --rig jetpack-api-route-inventory
homeboy fuzz run --rig jetpack-api-route-inventory --workload jetpack-rest-route-inventory --run-id jetpack-rest-route-inventory --seed 1 --max-duration 10m
```

Use offloaded Lab runners for proof campaigns. Listing workloads confirms declarations only; P status requires persisted `homeboy fuzz run` artifacts.

The coverage manifests live under `manifests/`, with executable/declarative fuzz workload manifests under `fuzz/`. REST cases declare permission classifications for public, local-authenticated, administrator, connected-site, and WP.com-dependent boundaries. DB inventory declares Jetpack table prefixes plus module/options state. External HTTP guardrail probes block `.invalid` synthetic hosts, declare `public-api.wordpress.com` as the WP.com allowlisted boundary, and still disallow real external service calls in the fixture.

Current D/E-only additions that still need `homeboy fuzz run` artifacts before P:

- `jetpack-module-option-table-inventory` covers read-only module option, autoload, serialization-boundary, and custom-table inventory used to seed module-state fuzz cases.
- `jetpack-options-matrix` covers rollback-safe option mutations, before/after/restore rows, secret placeholder classification, and serialized-value boundaries.
- `jetpack-cron-sync-actions` covers Jetpack cron hooks, local sync actions, queue option deltas, blocked remote dispatch, and rollback-safe cron/queue mutation rows.
- `jetpack-sync-queue-coverage` covers local queue serialization, retry boundary rows, and queue option rollback expectations without WordPress.com dispatch.
- `jetpack-connected-disconnected-fixtures` covers connection-state fixture boundaries, token-placeholder serialization, and WP.com-dependent skip reasons.
- `jetpack-public-module-frontend-coverage` covers public-module rendering and request scenarios across connected/disconnected expectations.
- `jetpack-performance-observation` covers Jetpack admin, REST, sync, module frontend, query-count, request-timing, asset, and external HTTP guardrail summary artifacts.
