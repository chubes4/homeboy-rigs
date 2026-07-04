# WordPress Plugin Performance Rig Template

Composable template for adapting the WooCommerce full-surface performance rig
shape to any WordPress plugin. Use this when a plugin needs durable Homeboy
bench evidence across frontend, wp-admin, REST, and plugin-specific hot paths
without copying WooCommerce-specific fixtures or thresholds.

This is documentation only. A plugin package should still live under its owning
repo path, for example `Automattic/jetpack/` or `WordPress/gutenberg/`, with
bench workloads beside the rig that consumes them.

## Package Shape

```text
<owner>/<plugin-repo>/
  README.md
  rigs/<plugin>-performance/rig.json
  bench/
    surface-inventory.php
    admin-page-coverage.php
    rest-route-coverage.php
    frontend-page-coverage.php
    <plugin-hot-path>.php
```

Use the shared template as the contract for what each package documents and
emits. Keep generic helpers in `shared/` only after at least two plugin rigs use
the same shape.

## Surface Discovery

Start with an inventory workload that discovers the plugin's safe, meaningful
runtime surfaces from the loaded WordPress install:

- Plugin entrypoint, version, active modules, feature flags, and relevant options.
- Public post types, taxonomies, blocks, shortcodes, widgets, and templates.
- wp-admin menu and submenu URLs registered by the plugin.
- REST routes registered by the plugin namespace or callbacks.
- AJAX actions, cron hooks, Action Scheduler groups, custom tables, and CLI
  commands when they are part of user-visible behavior.
- Frontend URLs that exercise plugin output with deterministic fixtures.

The inventory artifact should drive the later coverage workloads. Hand-picked
paths are acceptable for the first slice, but each skipped discovered surface
needs an explicit reason such as unsafe mutation, missing fixture, unsupported
role, or duplicate alias.

## Safe Coverage

Coverage workloads should prefer GET/read-only behavior and isolate mutations in
disposable WP Codebox runtimes.

Admin coverage:

- Log in as `administrator` and any plugin-critical lower-privilege role.
- Visit safe menu/submenu URLs discovered from `global $menu` and `$submenu`.
- Skip installers, updaters, importers, exporters, destructive tools, and actions
  requiring nonce-backed POSTs unless a focused workload owns the mutation.
- Record HTTP status, redirects, page-ready time, PHP notices/fatals, query
  count, slow query summaries, REST calls, request bytes, and failed resources.

Frontend coverage:

- Visit fixture-backed public pages that render plugin blocks, shortcodes,
  templates, widgets, forms, and deferred UI.
- Record TTFB, DOM readiness, page-ready time, request count, transferred bytes,
  failed resources, console errors, key selectors, and screenshot/trace paths
  when a browser runner is available.
- Use Homeboy Extensions browser helpers for deferred-initialization checks when
  the plugin should avoid loading feature code until a user action or viewport
  condition.

REST coverage:

- Discover routes after plugins and themes finish registering REST endpoints.
- Classify route methods as safe read, safe write fixture, unsafe write, or skip.
- For safe reads, call representative authenticated and unauthenticated cases.
- For writes, use focused workloads with deterministic fixtures, idempotent
  cleanup, nonce/capability checks, and bounded assertions.
- Record status, elapsed time, response bytes, DB queries, cache mutations, and
  sanitized error bodies.

## Readiness Checks

The rig `check` pipeline should fail before benchmarking when the selected plugin
checkout cannot load in the disposable runtime:

- Required Composer, npm, build, or generated asset outputs are present.
- Plugin entrypoint exists and activates without fatal errors.
- Required companion plugins are mounted or reported as unavailable.
- Required PHP extensions, WordPress version, and database tables are present.
- Feature flags and options needed for coverage are set to deterministic values.
- Browser coverage has a reachable site URL and login credentials from the
  runtime, not hard-coded local paths or secrets.

Readiness failures should explain the missing artifact and the prep command that
produces it. Do not silently skip a full-surface profile because the plugin could
not load.

## Fixture Setup

Fixtures should be deterministic, small by default, and configurable upward for
regression hunts:

- Seed users, roles, options, post types, terms, media placeholders, and plugin
  entities through public APIs where possible.
- Use stable IDs or slugs only inside the disposable runtime.
- Capture fixture counts and configuration in the artifact metadata.
- Provide settings for scale dimensions such as product count, form submissions,
  order history, API pages, taxonomy breadth, or enabled modules.
- Keep external services disabled or replaced with local fakes unless a focused
  integration workload explicitly owns the dependency.

## Metrics Schema

Emit a normalized `BenchResults` summary with stable scalar metrics and a richer
artifact for debugging. Prefer names that include the surface and unit:

```json
{
  "plugin_version": "1.2.3",
  "surface_total_count": 42,
  "admin_safe_page_count": 12,
  "admin_error_count": 0,
  "admin_ready_p95_ms": 850,
  "frontend_ready_p95_ms": 720,
  "rest_safe_route_count": 18,
  "rest_error_count": 0,
  "rest_elapsed_p95_ms": 120,
  "db_query_p95": 75,
  "slow_query_count": 0,
  "fixture_entity_count": 250,
  "regression_failure_count": 0
}
```

Metric rules:

- Use milliseconds for elapsed time and bytes for size metrics.
- Keep booleans for direct pass/fail guardrails.
- Store high-cardinality rows, URLs, queries, console logs, and screenshots in
  artifacts instead of top-level metrics.
- Include plugin git revision, WordPress version, PHP version, enabled modules,
  fixture scale, and workload settings in metadata.

## Artifacts

Each workload should write enough reviewer-facing evidence to explain failures:

- `surface-inventory.json` with discovered and skipped surfaces.
- `admin-coverage.json` with one row per visited admin page.
- `frontend-coverage.json` with one row per public URL and optional browser trace
  or screenshot references.
- `rest-coverage.json` with one row per route case.
- `db-profile.json` with query count summaries and sanitized slow query shapes.
- `regression-summary.json` with thresholds, observed values, and failures.

Artifacts must avoid secrets, auth cookies, nonces, local-only absolute paths, and
unbounded response bodies. Store sampled URLs and sanitized query shapes rather
than full dumps.

## Regression Thresholds

Start with generous thresholds that catch clear regressions without making the rig
flaky. Tighten them only after the same workload has stable history.

Recommended first thresholds:

- Zero PHP fatals and zero unexpected activation failures.
- Zero unexpected 5xx responses on safe admin, frontend, and REST coverage.
- Zero unsafe-surface executions in a full-surface profile.
- Bounded p95 elapsed time for known hot paths, with fixture scale included in the
  metric name or metadata.
- Bounded query growth for repeated calls, for example warm p95 should stay within
  a documented ratio of cold p95.
- Explicit budget for external requests, third-party scripts, or early deferred
  feature requests when relevant.

Treat thresholds as workload inputs and report both the budget and observed value
in `regression-summary.json`.

## Plugin-Specific Workloads

Full-surface coverage is the baseline. Plugin-specific workloads plug in beside
it when they exercise a real user or operator path that generic coverage cannot
prove:

- A store, form, membership, search, analytics, checkout, sync, import, export,
  email, or background-processing path.
- A known issue or PR review concern with linked upstream tracker.
- A scale dimension that generic page coverage does not create.
- A mutation path that needs a focused fixture, nonce/capability setup, and
  idempotency assertions.

Each plugin-specific workload should document:

- The upstream issue, PR, or product concern it proves.
- Required fixtures and scale settings.
- Safe cleanup or disposable-runtime assumptions.
- Metrics and artifacts it adds to the baseline schema.
- Regression thresholds and the reason they are useful.

## Full-Surface Profile Checklist

Before calling a plugin rig's profile `full-surface`, confirm:

- The profile references concrete workload files declared in `rig.json`.
- Inventory, admin, frontend, REST, readiness, and fixture setup are represented.
- Skipped surfaces have explicit, reviewable reasons.
- Artifacts are bounded, sanitized, and linked from the bench results.
- Threshold failures are reported as metrics and assertions, not hidden in logs.
- The README explains install, `rig check`, focused scenarios, and the
  full-surface command.
