# Shared WP Codebox Helpers

These helpers are rig-local adapters for seams that are still settling between
Homeboy, Homeboy Extensions, and WP Codebox. They exist to keep duplicated rig
workloads thin while upstream contracts are promoted.

Ownership rules:

- `homeboy-rigs` owns only workload-specific composition and temporary adapters
  in this directory.
- `homeboy-extensions/wordpress` owns stable generic WordPress and WP Codebox
  helper contracts after their shape is proven by more than one rig.
- `homeboy` core owns benchmark orchestration and should not absorb
  WP Codebox-specific behavior.
- WP Codebox owns recipe execution semantics, browser primitives, artifact bundle
  schemas, screenshots, DOM snapshots, traces, and visual comparison artifacts.

Temporary local seams:

- `artifacts.mjs` keeps rig call sites on the manifest-aware artifact resolver
  while WP Codebox/Homeboy artifact file manifests settle. The current
  `files/browser/*` fallback is compatibility glue, not a contract to copy.
- `recipe.mjs` centralizes WP Codebox CLI discovery and recipe invocation until
  typed rig requirements and command-scoped filesystem assertions are available
  upstream.
- `check-cli.sh` is the rig check-pipeline shim for WP Codebox executable
  discovery. New rigs should call it instead of adding another `command -v
  wp-codebox` check.
- `browser-coverage-trace.mjs` is shared only for browser request-coverage traces
  that already match this repo's minimal scenario shape. Do not expand it into a
  generic browser framework here.

Deprecation path:

- Track rig-local thinning in [homeboy-rigs#185](https://github.com/chubes4/homeboy-rigs/issues/185).
- Prefer promoted helpers from Homeboy Extensions when available; recent examples
  include `Extra-Chill/homeboy-extensions#1009`, `#1018`, `#1134`, and `#1141`.
- When adding a new helper here, include the upstream gap it proves and the
  promotion trigger. If the gap is already solved upstream, consume the upstream
  helper instead of adding a local fallback shim.
