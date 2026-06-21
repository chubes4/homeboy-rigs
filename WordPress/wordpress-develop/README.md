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

- `fuzz/rest-api.json` covers REST route inventory and representative safe request cases.
- `fuzz/db-inventory-query-profile.json` covers database inventory and REST/query attribution.
- `fuzz/admin-page-coverage.json` covers core admin page discovery and browser-visible admin readiness.
- `fuzz/hooks-cron-options.json` covers hooks, scheduled events, autoloaded options, transients, and rewrite state.
- `fuzz/content-types-taxonomies.json` covers post types, post statuses, taxonomies, terms, and permalink surfaces.
- `fuzz/media-users.json` covers attachment/media metadata, REST media endpoints, users, roles, and capabilities.
- `fuzz/performance-surfaces.json` covers representative bootstrap, REST, admin, editor, cron, media, and query surfaces as performance observation targets.

Supporting manifests live in `manifests/` and define the intended coverage gap report shape. The manifests are declarative until Homeboy Extensions exposes a first-class fuzz runner for these generic WordPress primitives.
