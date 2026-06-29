# Shared WP Codebox Contract Adapters

These files are thin product-level adapters to promoted upstream WP Codebox
contracts. They must not implement generic CLI discovery, recipe execution,
watchdogs, duplicate-run dedupe, artifact schema fallback, or proof policy inside
Homeboy Rigs.

Ownership rules:

- `homeboy-rigs` owns only workload-specific composition and direct calls to
  promoted upstream helpers in this directory.
- `homeboy-extensions/wordpress` owns stable generic WordPress and WP Codebox
  helper contracts after their shape is proven by more than one rig.
- `homeboy` core owns benchmark orchestration and should not absorb
  WP Codebox-specific behavior.
- WP Codebox owns recipe execution semantics, browser primitives, artifact bundle
  schemas, screenshots, DOM snapshots, traces, and visual comparison artifacts.

Allowed local files:

- `artifacts.mjs` delegates artifact resolution to the upstream artifact helper.
- `recipe.mjs` delegates binary, command, and recipe-run behavior to the upstream
  recipe helper.
- `browser-coverage-trace.mjs` is shared only for browser request-coverage traces
  that already match this repo's minimal scenario shape.

Explicit blockers:

- Executable discovery and check-pipeline requirements belong in Homeboy or
  Homeboy Extensions, not in Rigs shell shims.
- Recipe wall caps, child reaping, stderr shaping, duplicate-run dedupe, and
  filesystem assertions belong upstream of Rigs.
- Artifact fallback from legacy `files/browser/*` layouts is not accepted here;
  Rigs requires the upstream manifest-aware resolver contract.

Deprecation path:

- Track rig-local thinning in [homeboy-rigs#185](https://github.com/chubes4/homeboy-rigs/issues/185).
- Prefer promoted helpers from Homeboy Extensions when available; recent examples
  include `Extra-Chill/homeboy-extensions#1009`, `#1018`, `#1134`, and `#1141`.
- Do not add new generic helpers here. If a promoted upstream contract is missing,
  record the blocker against the owning upstream repository and keep the rig
  downscoped until that contract exists.
