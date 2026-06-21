# Jetpack Rigs

## `jetpack-api-route-inventory`

Declares the Jetpack fuzz coverage suite for REST/API, module state, admin pages, database/query profiling, options, sync queue behavior, external HTTP guardrails, and browser/admin request coverage. The suite uses generic fuzz workload manifests under `fuzz/`; it does not declare fuzz workloads as bench fallbacks.

Install locally:

```sh
homeboy rig install $HOME/Developer/homeboy-rigs@<branch>/Automattic/jetpack
```

Check the rig package:

```sh
homeboy rig check jetpack-api-route-inventory
homeboy rig check jetpack-browser-coverage
```

Run fuzz workloads only through the fuzz runner surface once available in the target Homeboy install. Do not use `homeboy bench` as a fallback for these coverage manifests.

```sh
homeboy fuzz --rig jetpack-api-route-inventory --workload jetpack-rest-route-inventory
```

The coverage manifests live under `manifests/`, with executable/declarative fuzz workload manifests under `fuzz/`. External HTTP guardrail probes use `.invalid` synthetic hosts and an empty allowlist so no real external service calls are expected.
