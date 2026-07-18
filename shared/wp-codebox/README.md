# Shared WP Codebox Contract Adapters

These files are thin product-level adapters to promoted upstream WP Codebox,
Homeboy, and Homeboy Extensions contracts. They must not implement generic CLI
discovery, recipe execution, watchdogs, duplicate-run dedupe, artifact schema
interpretation, or proof policy inside Homeboy Rigs.

Ownership rules:

- `homeboy-rigs` owns only workload-specific composition and direct calls to
  promoted upstream helpers in this directory.
- `homeboy-extensions/wordpress` owns stable generic WordPress and WP Codebox
  helper contracts after their shape is proven by more than one rig.
- `homeboy` core owns benchmark orchestration and should not absorb
  WP Codebox-specific behavior.
- WP Codebox owns recipe execution semantics, browser primitives, artifact bundle
  schemas, screenshots, DOM snapshots, traces, and visual comparison artifacts.

Contract IDs consumed here:

- `wp-codebox/wordpress-fuzz-runtime-contract/v1`
- `wp-codebox/fuzz-artifact-bundle/v1`
- `wp-codebox/sandbox-isolation-proof/v1`
- `homeboy/isolation-proof/v1`
- `homeboy/wordpress-fuzz-runtime-workload-operation/v1`

Allowed local files:

- `artifacts.mjs` delegates artifact resolution to the upstream artifact helper.
- `recipe.mjs` delegates binary, command, and recipe-run behavior to the upstream
  recipe helper.
  that already match this repo's minimal scenario shape.

Explicit boundaries:

- Executable discovery and check-pipeline requirements belong in Homeboy or
  Homeboy Extensions, not in Rigs shell shims.
- Recipe wall caps, child reaping, stderr shaping, duplicate-run dedupe, and
  filesystem assertions belong upstream of Rigs.
- Artifact resolution consumes manifest-aware upstream artifact contracts; Rigs
  does not parse legacy bundle layouts.

Deprecation path:

- Track rig-local thinning in [homeboy-rigs#185](https://github.com/chubes4/homeboy-rigs/issues/185).
- Prefer promoted helpers from Homeboy Extensions when available; recent examples
  include `Extra-Chill/homeboy-extensions#1009`, `#1018`, `#1134`, `#1141`,
  `#2016`, `#2017`, and `#2018`.
- Do not add new generic helpers here. Rigs consumes public contract IDs and keeps
  product-specific composition in product manifests.
