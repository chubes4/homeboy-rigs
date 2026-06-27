# Static Site Importer Rigs

`static-site-importer-fixture-matrix` is a product-level fixture matrix for Static
Site Importer quality checks. It keeps SSI-specific defaults, fixture discovery,
expected artifact names, and diagnostic grouping in this package while invoking
generic Homeboy/Homeboy Extensions primitives for WP Codebox recipe execution.

```bash
homeboy rig check static-site-importer-fixture-matrix
node WordPress/static-site-importer/bench/static-site-fixture-matrix.bench.mjs \
  --fixture-root WordPress/static-site-importer/fixtures \
  --static-site-importer-path ~/Developer/static-site-importer \
  --blocks-engine-php-transformer-path ~/Developer/blocks-engine
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

Use `--blocks-engine-php-transformer-path` to test a local Blocks Engine checkout
without cutting a PHP transformer release first. The bench installs SSI's
Composer dependencies through a temporary path repository and records the
override in `cli-run.json` under `dependency_overrides`. The path may point at
either the Blocks Engine repo root or the `php-transformer/` package directory.

## Canonical Blocks Engine Matrix

Use the operator wrapper for the release-free development loop against the
canonical Blocks Engine fixture corpus (`blocks-engine/fixtures/websites`, 71
top-level fixtures):

```bash
node WordPress/static-site-importer/tools/run-fixture-matrix.mjs \
  --runner homeboy-lab \
  --static-site-importer ~/Developer/static-site-importer \
  --blocks-engine ~/Developer/blocks-engine \
  --lab-only
```

The wrapper composes the existing Homeboy surfaces rather than replacing the
lower-level bench:

- `homeboy rig install <this package> --id static-site-importer-fixture-matrix --reinstall`
- `homeboy rig sync static-site-importer-fixture-matrix`
- `homeboy bench --rig static-site-importer-fixture-matrix --profile fixture-matrix --iterations 1`

It sets the SSI matrix bench environment for the canonical fixture root, Static
Site Importer checkout, WP Codebox execution, shared state, and optional Blocks
Engine PHP transformer override. By default, `--blocks-engine` also supplies the
release-free transformer override path. Use `--blocks-engine-php-transformer-path`
to point at a different repo/package, or run a final release/bump proof with
`--mode release-proof` and the released SSI dependency installed.

The fixture matrix is a deterministic transformer feedback gate, not a
performance benchmark. The rig and wrapper run a single Homeboy bench iteration
by default; use repeated runs only for explicitly separate performance work.

Output is a JSON operator summary with the run ID, fixture count, pass/fail
counts, finding count, top buckets/kinds when present in Homeboy output, artifact
URLs, and the structured Homeboy bench output file. Pass `--dry-run` to inspect
the composed commands without running Lab/WP Codebox. Arguments after `--` are
forwarded to the lower-level bench, preserving the existing script options:

```bash
node WordPress/static-site-importer/tools/run-fixture-matrix.mjs \
  --runner homeboy-lab \
  --static-site-importer ~/Developer/static-site-importer \
  --blocks-engine ~/Developer/blocks-engine \
  --batch-size 5 \
  --run-id ssi-matrix-dev-$(date +%Y%m%d) \
  -- --wordpress-version latest
```

Compare two fixture-matrix finding-packet artifacts without requiring Homeboy run
state:

```bash
node WordPress/static-site-importer/tools/compare-finding-packets.mjs \
  --base /path/to/main/finding-packets.json \
  --candidate /path/to/candidate/finding-packets.json \
  --base-label current-main \
  --candidate-label candidate \
  --top 20
```

The comparison reports signed count deltas by repair bucket, `group_key`, kind,
fixture, candidate repo, and selector family. Positive deltas mean the candidate
has more findings in that group; negative deltas mean fewer findings.

## Generic Invocation

The workload composes these generic surfaces:

- Homeboy rig package discovery and `bench_workloads.nodejs` registration.
- Repo-level `shared/wp-codebox/check-cli.sh` for rig-level WP Codebox CLI availability.
- Repo-level `shared/wp-codebox/recipe.mjs` for Homeboy Extensions WP Codebox recipe
  execution when `--run` is explicitly provided.
- WP Codebox `workspace-recipe/v1` steps using generic `wordpress.wp-cli`
  commands.

SSI-specific behavior remains here: plugin slug/defaults, fixture artifact
packing, `static-site-importer validate-artifact` command construction,
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
