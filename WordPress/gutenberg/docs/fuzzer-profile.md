# Gutenberg Fuzzer Profile

This scaffold keeps Gutenberg-specific coverage knowledge inside `homeboy-rigs/WordPress/gutenberg`. Homeboy core and Homeboy Extensions only need to run declared fuzz workloads through the existing WordPress runner and preserve their artifacts.

## Coverage Shape

The `fuzzer` profile composes the same surface classes as the Woo full-surface rig:

- REST route coverage through `gutenberg-rest-route-fuzz` and `gutenberg-rest-request-cases-fuzz`, covering the declared `wp/v2` and `__experimental` Gutenberg-facing namespaces.
- `wp-admin` and editor page coverage through `block-editor-browser-coverage` and `site-editor-browser-coverage` manifests that point at the rig-owned browser scenarios for post editor, Site Editor, template editor, and patterns.
- Dynamic block rendering coverage through `block-rendering-coverage` request cases.
- Block editor load/action probes through the browser action scenario files in `browser-scenarios/`.
- DB inventory and REST query profiling through `gutenberg-db-inventory-fuzz` and `gutenberg-rest-db-query-profile-fuzz`, including request-case, route, method, query-type, table, stack, and caller attribution.
- Runtime state inventory through `gutenberg-hooks-options-inventory`, including Gutenberg option prefixes, postmeta keys, block/editor/template/pattern post types, and pattern taxonomy state.
- External HTTP guardrails through `gutenberg-external-http-guardrail-fuzz`.
- Coverage-gap reporting shape in `manifests/fuzzer-profile.json` and `manifests/full-surface-coverage.json`.

## Commands

Install and check the rig package:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/WordPress/gutenberg
homeboy rig check gutenberg-api-route-inventory
homeboy rig check gutenberg-browser-coverage
```

Run the fuzzer manifests through the WordPress extension runner:

```sh
homeboy fuzz --rig gutenberg-api-route-inventory --runner wordpress --shared-state /tmp/gutenberg-fuzzer
```

## Gap Report Contract

A consumer can produce `homeboy-rigs/gutenberg-fuzzer-coverage-gap/v1` from the artifacts emitted by the fuzz runner. The report should include:

- REST routes from `manifests/rest-route-coverage.json` that were registered but do not have generated safe request cases.
- Protected editor routes from `manifests/rest-route-coverage.json` that do not have authenticated editor cases and unauthenticated `401`/`403` boundary cases.
- Target browser scenarios from `manifests/full-surface-coverage.json` that did not produce browser request coverage.
- Covered REST routes without DB query profiles, query attribution groups, or with query counts/durations over `manifests/rest-route-budgets.json`.
- Gutenberg option prefixes, postmeta keys, block/editor/template/pattern entities, or pattern taxonomy state missing from DB/runtime inventory artifacts.
- Unapproved outbound hosts observed by `gutenberg-external-http-guardrail-fuzz`.
- Fixture or primitive gaps that prevent a surface from being interpreted as covered.

## D/E/P Status

The Gutenberg REST and DB fuzz surfaces are declared and executable in this package. They are proof-ready only when the fuzz runner preserves the required artifacts declared by each fuzz workload:

- `rest_route_inventory` for registered route and namespace coverage.
- `rest_request_cases` for generated safe cases and permission-boundary cases.
- `rest_db_query_profile` for route/query attribution and budget comparison.
- `db_inventory` and `gutenberg_runtime_state` for option, postmeta, block, editor, template, pattern, and taxonomy inventory.
- `external_http_guardrail` and browser request coverage artifacts for outbound host and editor-screen gaps.

Until reviewer-facing run artifacts or issue/PR evidence link those reports, the full REST/DB rows remain `D/E`, not `P`. Pattern-preview performance has separate targeted `D/E/P partial` evidence in `WordPress/gutenberg/README.md`.

## Current Limits

The scaffold does not run local benchmarks and does not add Gutenberg-specific primitives upstream. Deeper action fuzzing can be added by expanding the rig-owned files under `browser-scenarios/` once the first artifact bundle identifies high-value editor interactions.

The `gutenberg-api-route-inventory` rig intentionally declares generic `fuzz_workloads` only. REST/DB helper files under `bench/` are workload inputs consumed by those fuzz manifests, not legacy `bench_workloads` or `bench_profiles`.
