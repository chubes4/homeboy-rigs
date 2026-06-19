# WordPress Core Rigs

## `wordpress-core-api-route-inventory`

Captures a lightweight inventory of registered WordPress core REST routes without executing API requests. This is an adapter scaffold for applying generic Homeboy Extensions / WP Codebox API performance primitives to WordPress core later.

Install locally:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/WordPress/wordpress
```

Run the route inventory workload:

```sh
homeboy bench --rig wordpress-core-api-route-inventory --scenario wordpress-core-rest-route-inventory --iterations 1 --shared-state /tmp/wordpress-core-api-inventory
```

The coverage manifest lives at `manifests/rest-route-coverage.json`. It keeps core-specific route grouping in this rig package so upstream primitives can stay generic.
