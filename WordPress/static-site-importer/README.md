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

Generated/static artifact roots can be normalized into matrix fixtures first:

```bash
node WordPress/static-site-importer/tools/artifact-intake.mjs \
  --artifact-root /path/to/generated-artifacts \
  --fixture-root /tmp/ssi-fixtures \
  --manifest /tmp/ssi-fixtures/intake.json

node WordPress/static-site-importer/bench/static-site-fixture-matrix.bench.mjs \
  --artifact-root /path/to/generated-artifacts \
  --output-directory /tmp/ssi-matrix \
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

## Generated Artifact Intake Contract

`--artifact-root` accepts any directory containing one or more generated static
site artifacts. Discovery is structural, not fixture-specific:

- A directory with `index.html` becomes one fixture.
- A directory with `website/index.html` becomes one fixture from `website/`.
- A directory with `artifact.json`, `website-artifact.json`, or
  `static-site-candidate.json` containing `files[].path` entries under
  `website/` becomes one materialized fixture.

The bridge writes normal fixture directories under the requested fixture root,
then the existing matrix path discovers them and writes `<fixture-id>/artifact.json`
for SSI validation.
