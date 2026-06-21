# Gutenberg Fuzzer Profile

This scaffold keeps Gutenberg-specific coverage knowledge inside `homeboy-rigs/WordPress/gutenberg`. Homeboy core and Homeboy Extensions only need to run declared fuzz workloads through the existing WordPress runner and preserve their artifacts.

## Coverage Shape

The `fuzzer` profile composes the same surface classes as the Woo full-surface rig:

- REST route coverage through `gutenberg-rest-route-fuzz` and `gutenberg-rest-request-cases-fuzz`.
- Safe `wp-admin` and editor page coverage through `gutenberg-admin-page-coverage`, plus browser request coverage through `block-editor-browser-coverage` and `site-editor-browser-coverage` manifests that point at the rig-owned browser scenarios for post editor, Site Editor, template editor, and patterns.
- Dynamic block rendering coverage through `block-rendering-coverage` request cases.
- Frontend rendering/request coverage through `frontend-rendering-request-coverage` and the disposable published fixture page created by `gutenberg-browser-coverage.trace.mjs`.
- Block editor load/action probes through the browser action scenario files in `browser-scenarios/`.
- DB inventory and REST query profiling through `gutenberg-db-inventory-fuzz` and `gutenberg-rest-db-query-profile-fuzz`.
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
- Target browser scenarios from `manifests/full-surface-coverage.json` that did not produce browser request coverage.
- Safe admin/editor enumeration targets that were skipped without an explicit destructive or permission reason code.
- Frontend rendering fixture pages or dynamic block rendering requests that did not produce browser request coverage.
- Covered REST routes without DB query profiles or with query counts/durations over `manifests/rest-route-budgets.json`.
- Unapproved outbound hosts observed by `gutenberg-external-http-guardrail-fuzz`.
- Fixture or primitive gaps that prevent a surface from being interpreted as covered.

## Current Limits

The scaffold does not run local benchmarks and does not add Gutenberg-specific primitives upstream. Deeper action fuzzing can be added by expanding the rig-owned files under `browser-scenarios/` once the first artifact bundle identifies high-value editor interactions. Destructive editor actions are represented as skipped reason codes rather than executed browser steps.
