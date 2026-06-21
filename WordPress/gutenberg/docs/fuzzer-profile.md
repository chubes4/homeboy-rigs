# Gutenberg Fuzzer Profile

This scaffold keeps Gutenberg-specific coverage knowledge inside `homeboy-rigs/WordPress/gutenberg`. Homeboy core and Homeboy Extensions only need to run declared fuzz workloads through the existing WordPress runner and preserve their artifacts.

## Coverage Shape

The `fuzzer` profile composes the same surface classes as the Woo full-surface rig:

- REST route coverage through `gutenberg-rest-route-fuzz` and `gutenberg-rest-request-cases-fuzz`, covering the declared `wp/v2` and `__experimental` Gutenberg-facing namespaces.
- Safe `wp-admin` and editor page coverage through `gutenberg-admin-page-coverage`, plus browser request coverage through `block-editor-browser-coverage` and `site-editor-browser-coverage` manifests that point at the rig-owned browser scenarios for post editor, Site Editor, template editor, and patterns.
- Dynamic block rendering coverage through `block-rendering-coverage` request cases.
- Frontend rendering/request coverage through `frontend-rendering-request-coverage` and the disposable published fixture page created by `gutenberg-browser-coverage.trace.mjs`.
- Block editor load/action probes through the browser action scenario files in `browser-scenarios/`.
- DB inventory and REST query profiling through `gutenberg-db-inventory-fuzz` and `gutenberg-rest-db-query-profile-fuzz`, including request-case, route, method, query-type, table, stack, and caller attribution.
- Runtime state inventory through `gutenberg-hooks-options-inventory`, including Gutenberg option prefixes, postmeta keys, block/editor/template/pattern post types, and pattern taxonomy state.
- Hook, option, postmeta, template/pattern, cron, transient, and editor-state inventory through `gutenberg-hooks-options-inventory`.
- Editor, Site Editor, block-rendering, pattern-preview, notes-unsaved-attachment, and external HTTP performance summaries through `gutenberg-editor-performance-observation`.
- Gutenberg 1 API/DB Lab cell recovery through `manifests/api-db-lab-cell.json`: REST namespaces, role permission boundaries, query/table attribution, option/postmeta state, entity fixtures, and required proof artifact sections.
- External HTTP guardrails through `gutenberg-external-http-guardrail-fuzz`.
- Coverage-gap reporting shape in `manifests/fuzzer-profile.json` and `manifests/full-surface-coverage.json`.

## Commands

Install and check the rig package:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/WordPress/gutenberg
homeboy rig check gutenberg-api-route-inventory
homeboy rig check gutenberg-browser-coverage
```

Inspect and run fuzzer manifests through Homeboy's generic fuzz command:

```sh
homeboy fuzz list --rig gutenberg-api-route-inventory
homeboy fuzz run --rig gutenberg-api-route-inventory --workload gutenberg-rest-route-fuzz --run-id gutenberg-rest-route-fuzz --seed 1 --max-duration 10m
```

Run heavy campaigns through the offloaded Lab path and use persisted `homeboy runs` artifacts as proof; listing workloads does not prove execution.

## Gap Report Contract

A consumer can produce `homeboy-rigs/gutenberg-fuzzer-coverage-gap/v1` from the artifacts emitted by the fuzz runner. The report should include:

- REST routes from `manifests/rest-route-coverage.json` that were registered but do not have generated safe request cases.
- Protected editor routes from `manifests/rest-route-coverage.json` that do not have authenticated editor cases and unauthenticated `401`/`403` boundary cases.
- Target browser scenarios from `manifests/full-surface-coverage.json` that did not produce browser request coverage.
- Safe admin/editor enumeration targets that were skipped without an explicit destructive or permission reason code.
- Frontend rendering fixture pages or dynamic block rendering requests that did not produce browser request coverage.
- Covered REST routes without DB query profiles, query attribution groups, or with query counts/durations over `manifests/rest-route-budgets.json`.
- Gutenberg option prefixes, postmeta keys, block/editor/template/pattern entities, or pattern taxonomy state missing from DB/runtime inventory artifacts.
- Missing hook, option, postmeta, template, pattern, cron, transient, or editor-state inventory sections.
- Missing editor, Site Editor, block-rendering, pattern-preview, notes-unsaved-attachment, or external HTTP performance summary sections.
- REST namespaces without generated cases, routes without role permission-boundary cases, queries without table/key attribution, and entities without state artifacts from the Gutenberg 1 API/DB Lab cell contract.
- Unapproved outbound hosts observed by `gutenberg-external-http-guardrail-fuzz`.
- Fixture or primitive gaps that prevent a surface from being interpreted as covered.

## Runtime-State Contract

`gutenberg-hooks-options-inventory` emits a read-only runtime-state artifact. The artifact summary is not proof unless it has sections for `hooks`, `options`, `postmeta`, `templates`, `patterns`, `cron`, `transients`, and `editor_state`. The profile calls out cron/state surfaces because editor fixtures can change scheduled core events, remote-cache transients, and option/autoload pressure even when no Gutenberg-specific cron hook is registered.

## Performance Observation Contract

`gutenberg-editor-performance-observation` is a summary contract, not a local benchmark. A valid artifact links the underlying browser, REST query-profile, block-rendering, pattern-preview, and notes-unsaved-attachment artifacts, then summarizes:

- Post editor readiness, REST preloads, REST request count, asset request count, long tasks, and console errors.
- Site Editor readiness, REST preloads, REST request count, template/global-styles request counts, and long tasks.
- Block-rendering counts, block renderer request counts, server render time, query count, and cache hits.
- Pattern preview iframe count, fixture asset request count, unique fixture asset count, preview ready time, and long tasks.
- Notes unsaved attachment upload/autosave state, editor notices, and unsaved attachment recovery state.

## External HTTP Guardrail Contract

`gutenberg-external-http-guardrail-fuzz` installs the WordPress HTTP guardrail with `block_network=true`. `api.wordpress.org` is the only approved host, `patterns.wordpress.org` is the synthetic blocked probe host, and real external service calls are not allowed. A valid artifact summarizes approved hosts, blocked hosts, unexpected allowed hosts, and request samples.

## D/E/P Status

The Gutenberg REST and DB fuzz surfaces are declared and executable in this package. They are proof-ready only when the fuzz runner preserves the required artifacts declared by each fuzz workload:

- `rest_route_inventory` for registered route and namespace coverage.
- `rest_request_cases` for generated safe cases and permission-boundary cases.
- `rest_db_query_profile` for route/query attribution and budget comparison.
- `db_inventory` and `gutenberg_runtime_state` for option, postmeta, block, editor, template, pattern, taxonomy, cron, transient, and editor-state inventory.
- `external_http_guardrail`, `gutenberg_performance_observation`, and browser request coverage artifacts for outbound host, editor-screen, and performance-observation gaps.

Until reviewer-facing run artifacts or issue/PR evidence link those reports, the full REST/DB rows remain `D/E`, not `P`. Pattern-preview performance has separate targeted `D/E/P partial` evidence in `WordPress/gutenberg/README.md`.

## Current Limits

The scaffold does not run local benchmarks and does not add Gutenberg-specific primitives upstream. Deeper action fuzzing can be added by expanding the rig-owned files under `browser-scenarios/` once the first artifact bundle identifies high-value editor interactions. Destructive editor actions are represented as skipped reason codes rather than executed browser steps.

The `gutenberg-api-route-inventory` rig intentionally declares generic `fuzz_workloads` only. REST/DB helper files under `bench/` are workload inputs consumed by those fuzz manifests, not legacy `bench_workloads` or `bench_profiles`.
