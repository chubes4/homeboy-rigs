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

## Current Limits

The scaffold does not run local benchmarks and does not add Gutenberg-specific primitives upstream. Deeper action fuzzing can be added by expanding the rig-owned files under `browser-scenarios/` once the first artifact bundle identifies high-value editor interactions. Destructive editor actions are represented as skipped reason codes rather than executed browser steps.
