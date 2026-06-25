# Static Site Importer Rigs

`static-site-importer-fixture-matrix` is a product-level fixture matrix for Static
Site Importer quality checks. It keeps SSI-specific defaults, fixture discovery,
expected artifact names, and diagnostic grouping in this package while invoking
generic Homeboy/Homeboy Extensions primitives for WP Codebox recipe execution.

```bash
homeboy rig check static-site-importer-fixture-matrix
node WordPress/static-site-importer/bench/static-site-fixture-matrix.mjs \
  --fixture-root WordPress/static-site-importer/fixtures \
  --static-site-importer-path ~/Developer/static-site-importer
```

Add `--run` only in an approved non-local execution environment. The default
command writes matrix, recipe, summary, result, and finding-packet artifacts
without launching WP Codebox.

## Generic Invocation

The workload composes these generic surfaces:

- Homeboy rig package discovery and `bench_workloads.nodejs` registration.
- `shared/wp-codebox/check-cli.sh` for rig-level WP Codebox CLI availability.
- `shared/wp-codebox/recipe.mjs` for Homeboy Extensions WP Codebox recipe
  execution when `--run` is explicitly provided.
- WP Codebox `workspace-recipe/v1` steps using generic `wordpress.wp-cli`
  commands.

SSI-specific behavior remains here: plugin slug/defaults, fixture artifact
packing, `static-site-importer validate-in-codebox` command construction,
artifact expectations, and diagnostic-to-repair grouping.
