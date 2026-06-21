# WordPress Core Fuzz Coverage Rigs

## `wordpress-core-fuzz-coverage`

Declares a WordPress Core coverage/fuzz suite for `WordPress/wordpress-develop` using generic `homeboy/fuzz-workload/v1` manifests. The package keeps WordPress-specific surface knowledge in `homeboy-rigs`; Homeboy core only needs to understand the generic fuzz workload contract.

Install locally:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/WordPress/wordpress-develop
```

Validate the rig package without running workloads:

```sh
homeboy rig check wordpress-core-fuzz-coverage
node scripts/lint-rig-packages.mjs WordPress/wordpress-develop
```

The suite intentionally declares `fuzz_workloads` and `fuzz_profiles` only. It does not register `bench_workloads` or `bench_profiles`, so there is no benchmark fallback path. These manifests are D/E coverage contracts until `homeboy fuzz run` artifacts prove the surfaces.

## Coverage Shape

The `fuzzer` profile groups these manifests:

- `fuzz/rest-api.json` covers REST route inventory, generated safe request cases, and role permission boundaries.
- `fuzz/db-inventory-query-profile.json` covers database schema inventory and REST/query attribution, including options, postmeta, and rewrite attribution.
- `fuzz/admin-page-coverage.json` covers Woo-equivalent safe Core wp-admin menu/submenu enumeration, browser-visible admin readiness, role boundary checks for administrator/editor/author/contributor/subscriber, query attribution, skipped destructive reason codes, and a required `homeboy-rigs/wordpress-core-admin-page-coverage/v1` artifact contract.
- `fuzz/frontend-rendering-request-coverage.json` covers frontend request/rendering paths for the front page, singular posts/pages, archives, search, feeds, attachments, and skipped unsafe request reasons.
- `fuzz/hooks-cron-options.json` covers hook inventory, cron schedule state, autoloaded options, transients, postmeta, rewrite rules, and rewrite query attribution with required proof artifact names defined in `manifests/hooks-cron-options.json`.
- `fuzz/content-types-taxonomies.json` covers post types, post statuses, taxonomies, terms, permalink surfaces, posts/pages list rendering, and post/page editor readiness.
- `fuzz/media-users.json` covers attachment/media metadata, REST media endpoints, users, roles, capabilities, media library rendering, users list rendering, and profile screen rendering.
- `fuzz/performance-surfaces.json` covers representative frontend, REST, admin, editor, media, cron, and option/autoload pages as performance observation targets, including request timing, query count, and asset observations.

Supporting manifests live in `manifests/` and define the intended coverage gap report shape. The manifests stay declarative until an offloaded `homeboy fuzz run` records persisted run evidence for the selected workload.

## Browser Request Coverage

`WordPress/wordpress/bench/wordpress-core-browser-coverage.trace.mjs` remains the executable WP Codebox browser request/rendering trace. It seeds one post, one page, and an author user, then visits read-only frontend/admin scenarios for front page, posts, post editor shell, pages, page editor shell, Site Editor shell, media library, media upload shell, users, and profile. It captures WP Codebox request coverage, console/errors, network, HTML, screenshots, and DOM snapshots without submitting forms or invoking bulk/destructive actions.

## Artifact Contracts

Core fuzz artifacts use required `fuzz.report` contracts for newly tightened surfaces:

- `homeboy-rigs/wordpress-core-admin-page-coverage/v1`: `summary`, `visits`, `skipped`, `request_logs`, `query_attribution`, and `role_boundary_summary`.
- `homeboy-rigs/wordpress-core-frontend-rendering-request-coverage/v1`: `summary`, `requests`, `rendered_paths`, `template_contexts`, `request_coverage`, and `skipped`.
- `homeboy-rigs/wordpress-core-content-types-taxonomies/v1`: content registration, posts/pages scenario, and skipped reason rows.
- `homeboy-rigs/wordpress-core-media-users/v1`: media/user scenario, role/capability, and skipped reason rows.

Static contract tests live in `fuzz/core-fuzz-contracts.test.mjs` and can run with `node --test WordPress/wordpress-develop/fuzz/core-fuzz-contracts.test.mjs`. These tests validate wiring and artifact declarations only; they do not run local fuzz or benchmark workloads.

## Proof Artifacts

Runtime-state coverage expects `hooks-cron-options/` artifacts for hook inventory, cron schedule rows, autoloaded options, transient state, rewrite rules, and a runtime-state summary. Performance coverage expects `performance-surfaces/performance_surfaces.json` with one observation row per declared surface and request timing/query count fields for every non-database-only page.

These are proof contracts, not local benchmark instructions. Collect them through offloaded `homeboy fuzz run` evidence; do not use `homeboy bench` as a fallback for this Core package.

## D/E/P Proof Contract

`D` is a manifest declaration: the surface is named in `fuzz/*.json` and included in a rig `fuzz_profiles` entry. `E` is an executable contract: the workload validates, references an existing manifest, and declares expected artifact semantic keys. `P` requires reviewer-facing run evidence from an approved fuzz/offloaded runner; local fuzz or benchmark output is not committed as proof.

For WordPress Core REST API and database coverage, a proof-ready bundle must include these artifact roles:

- `fuzz.rest.route_inventory` for the registered route inventory.
- `fuzz.rest.generated_cases` for generated safe GET/HEAD/OPTIONS request cases.
- `fuzz.rest.permission_boundaries` for anonymous, subscriber, author, editor, and administrator boundary rows.
- `fuzz.db.schema_inventory` for tables, columns, indexes, and row counts.
- `fuzz.db.rest_query_attribution` for REST case query profiles.
- `fuzz.db.options_postmeta_rewrite_attribution` for options, postmeta, and rewrite query attribution.
- `fuzz.runtime.rewrite_postmeta_options_inventory` for runtime rewrite, postmeta, option, transient, hook, and cron inventory.

The legacy `WordPress/wordpress` package remains a compatibility path for existing bench/trace workloads. Current fuzz coverage for `WordPress/wordpress-develop` is declared here and has no benchmark fallback declaration.
