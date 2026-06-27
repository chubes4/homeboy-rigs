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

### Code freshness guard

Before running, the wrapper resolves the git freshness of the override/source
checkouts (`--blocks-engine` / `--blocks-engine-php-transformer-path` and
`--static-site-importer`) relative to their upstream. The plan and operator
summary include a `code_freshness` block (per path: `branch`, `upstream`,
`behind`, `ahead`, `dirty`, `commit`, `status`) plus the resolved
`transformer_commit` so findings are attributable to the exact code under test.

If any override is **behind or diverged** vs upstream, the wrapper warns loudly
and **refuses to run** (exit non-zero) — a stale transformer produces
semantic-parity findings that may already be fixed upstream (phantom findings).
Refresh the checkout to upstream, or pass `--allow-stale-override` to proceed
anyway. `--dry-run` always prints the resolved freshness and whether it *would*
block, without running. Fresh/clean (or ahead-only) checkouts proceed with no
new friction.

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
- WP Codebox `wordpress.editor-canvas-probe` command for the editor-side block
  validity step (see below).

SSI-specific behavior remains here: plugin slug/defaults, fixture artifact
packing, `static-site-importer validate-artifact` command construction,
artifact expectations, and diagnostic-to-repair grouping.

## Editor Block Validity Gate

The PHP `validate-artifact` step proves blocks *serialize* (PHP
`parse_blocks`/`serialize_blocks` round-trip). It does **not** run the editor's
JS save-comparison validation, which is what surfaces the "This block contains
unexpected or invalid content" warning users actually see.

After each fixture's import step, `buildFixtureMatrixRecipe` appends a
`wordpress.editor-canvas-probe` step that opens the imported post in the real
block editor canvas (same WP Codebox sandbox) and probes the
`editor_block_invalid` selector group (`.block-editor-warning`,
`.block-editor-block-list__block.is-invalid`). This reuses the existing
wp-codebox editor command and mirrors the `wp.blocks.validateBlock` pass in
`Automattic/studio/bench/studio-agent-site-build.bench.mjs` rather than
rebuilding a validator.

`collectEditorValidationDiagnostics` reads the probe's `selectorSummary`
(invalid-warning matches) — and, when present, per-block `isValid`/`validateBlock`
results — back into `editor_block_invalid` diagnostics. These classify into the
Blocks Engine feature/visual-parity bucket (`candidate_repo: blocks-engine`,
`repair_mode: editor-block-validation-parity`) with the unacceptable
`editor_block_invalid` loss class, so the honest gate fails the fixture. Valid
blocks emit nothing. Set `editorValidation: false` to omit the step.

Live caveat: a full editor-validation pass requires a healthy Lab runner (the
runner currently has a controller/daemon version drift). The wiring and the
finding-parsing/gating logic are unit-tested in
`tools/fixture-matrix.test.mjs`. For per-block name/clientId fidelity equal to
the studio bench, wp-codebox's `editor-actions`/`inspectState` would need to
emit `getBlocks()` `isValid` (or run `wp.blocks.validateBlock`); the probe path
used here detects invalid blocks via the warning DOM without any wp-codebox
change, which `collectEditorValidationDiagnostics` already consumes.

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
