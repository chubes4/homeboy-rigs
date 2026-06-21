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
- `fuzz/admin-page-coverage.json` covers core admin page discovery and browser-visible admin readiness.
- `fuzz/hooks-cron-options.json` covers hooks, scheduled events, autoloaded options, transients, and rewrite state.
- `fuzz/content-types-taxonomies.json` covers post types, post statuses, taxonomies, terms, and permalink surfaces.
- `fuzz/media-users.json` covers attachment/media metadata, REST media endpoints, users, roles, and capabilities.
- `fuzz/performance-surfaces.json` covers representative bootstrap, REST, admin, editor, cron, media, and query surfaces as performance observation targets.

Supporting manifests live in `manifests/` and define the intended coverage gap report shape. The manifests are declarative until Homeboy Extensions exposes a first-class fuzz runner for these generic WordPress primitives.

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
