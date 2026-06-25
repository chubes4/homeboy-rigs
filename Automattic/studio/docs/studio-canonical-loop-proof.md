# Studio Canonical Loop Proof

This is a minimal, safe proof skeleton for the canonical website artifact loop:

1. Host request arrives with prompt, fanout targets, artifact contract, and user-change intent.
2. Codebox/fanout generation produces a website artifact.
3. Studio Native stores that artifact as the canonical site source.
4. Static Site Importer materializes the artifact into a block theme in an ephemeral Codebox/site.
5. A user change mutates the original canonical artifact.
6. Reimport materializes the updated artifact.
7. Progress and diagnostics artifacts explain what happened.

Current status: the default proof is filesystem-only and stubbed. A stronger `local-wp` mode exercises Static Site Importer through a local WordPress install with WP-CLI, while Codebox fanout and Studio Native canonical storage remain explicitly stubbed until a Studio Native runtime is available.

## Safe Validation

```bash
node Automattic/studio/proofs/studio-canonical-loop-proof.mjs --check
node scripts/lint-rig-packages.mjs Automattic/studio
```

## Run The Stub Proof

```bash
node Automattic/studio/proofs/studio-canonical-loop-proof.mjs \
  --out /tmp/studio-canonical-loop-proof
```

## Run The Local WordPress Proof

Run this from a Studio site directory that has Static Site Importer active:

```bash
node /path/to/homeboy-rigs/Automattic/studio/proofs/studio-canonical-loop-proof.mjs \
  --mode local-wp \
  --out /tmp/studio-canonical-loop-local-wp-proof
```

`local-wp` mode writes the same proof artifacts as stub mode, but the initial materialization and reimport materialization are performed through `static_site_importer_ability_import_website_artifact()` via `studio wp eval-file`.

The script writes:

- `progress.json` for phase-by-phase evidence.
- `diagnostics.json` for assertions, real/stubbed boundaries, and blockers.
- `codebox-fanout-artifact.json` for the generated website artifact stub.
- `studio-native-canonical-artifact.v1.json` and `.v2.json` for the stored artifact before and after user mutation.
- `ssi-materialized-theme.initial.json` and `.reimport.json` for block-theme materialization stubs.
- `result.json` with the artifact index and success flag.

## Rig Entry Point

```bash
homeboy rig check studio-canonical-loop-proof
```

The rig check validates only local files and the fixture. It intentionally declares no benchmark workload.

## Real vs Stubbed

Real now:

- Host request fixture schema validation.
- Website artifact creation in the expected site-artifact shape.
- Canonical artifact versioning on disk.
- User mutation against the original artifact.
- Reimport proof that the updated artifact reaches the materialized theme output.
- Progress and diagnostics artifact writing.
- In `local-wp` mode, Static Site Importer website artifact materialization through local WordPress/WP-CLI.
- In `local-wp` mode, reimport materialization through local WordPress/WP-CLI.

Stubbed now:

- Codebox/fanout execution.
- Studio Native canonical artifact persistence APIs.
- Static Site Importer execution in an ephemeral Codebox/site.
- WordPress active-theme verification.
- Reviewer-facing artifact bundle publication.

## Blockers To Make This Executable

- Host request API contract needs an executable endpoint and auth shape.
- Codebox fanout generation needs a durable artifact bundle contract for website artifacts.
- Studio Native needs a canonical website artifact store/read/update surface.
- SSI reimport needs an idempotent CLI or ability path that accepts the stored canonical artifact.
- Progress diagnostics need stable reviewer-facing artifact bundle links.
