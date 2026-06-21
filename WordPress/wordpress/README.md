# Legacy WordPress Core Bench/Trace Rigs

This package is a compatibility path for existing bench-oriented WordPress Core
scaffolding. New Core fuzz workload contracts belong in
`../wordpress-develop`, the canonical `WordPress/wordpress-develop` rig package
for `homeboy/fuzz-workload/v1` manifests.

## `wordpress-core-api-route-inventory`

Captures a lightweight inventory of registered WordPress core REST routes without executing API requests. This is an adapter scaffold for existing generic Homeboy Extensions / WP Codebox bench primitives, not a fuzz contract.

Install locally:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/WordPress/wordpress
```

Run the legacy route inventory workload:

```sh
homeboy bench --rig wordpress-core-api-route-inventory --scenario wordpress-core-rest-route-inventory --iterations 1 --shared-state /tmp/wordpress-core-api-inventory
```

Run the legacy bench full-surface profile when you need compatibility with existing Homeboy bench primitives. Current fuzz coverage for `WordPress/wordpress-develop` lives in `../wordpress-develop` and has no benchmark fallback declaration:

```sh
homeboy bench --rig wordpress-core-api-route-inventory --profile full-surface --iterations 1 --shared-state /tmp/wordpress-core-full-surface
```

The coverage manifest lives at `manifests/rest-route-coverage.json`. It keeps core-specific route grouping for this legacy bench package so upstream primitives can stay generic. For Core fuzz coverage, install and validate `../wordpress-develop` instead.
