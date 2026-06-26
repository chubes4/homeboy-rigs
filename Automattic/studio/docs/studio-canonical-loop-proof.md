# Studio Canonical Loop Proof

This is a deterministic contract proof for the canonical website artifact loop:

1. Host request arrives with prompt, fanout targets, artifact contract, and user-change intent.
2. Codebox/fanout generation produces a website artifact.
3. Studio Native stores that artifact as the canonical site source.
4. Static Site Importer materializes the artifact into a block theme in an ephemeral Codebox/site.
5. A user change mutates the original canonical artifact.
6. Reimport materializes the updated artifact.
7. Progress and diagnostics artifacts explain what happened.

Current status: the default proof verifies the end-to-end contract and writes a portable evidence bundle. Runtime execution for Codebox browser fanout, Studio Native persistence APIs, and ephemeral Codebox/WordPress remains explicitly marked as blocked rather than faked. A stronger `local-wp` mode exercises Static Site Importer through a local WordPress install with WP-CLI when that runtime is available.

## Safe Validation

```bash
node Automattic/studio/proofs/studio-canonical-loop-proof.mjs --check
node Automattic/studio/proofs/studio-canonical-loop-proof.mjs \
  --out /tmp/studio-canonical-loop-proof
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
- `evidence-bundle.json` with portable `homeboy-artifact://` refs for reviewer-facing artifacts.
- `result.json` with the artifact index and success flag.

## Acceptance Criteria

The proof fails unless these user-facing outcomes are present:

- The host request includes prompt/delegation, fanout targets, artifact contract, source-of-truth requirement, provenance requirement, and required evidence artifacts.
- Codebox fanout output exists in the site-artifact shape and carries a fanout evidence ref.
- Studio Native canonical artifact v1 is stored as the source of truth with revision/provenance metadata.
- User edit mutates the original canonical artifact, producing revision v2 with parent provenance.
- Reimport consumes the mutated canonical artifact and the materialized theme output contains the edited text.
- SSI materialization diagnostics report zero fallback blocks in contract mode.
- Progress, diagnostics, canonical artifacts, materialized themes, and the evidence bundle are preserved with portable reviewer-facing refs.

## Rig Entry Point

```bash
homeboy rig check studio-canonical-loop-proof
```

The rig check validates the fixture and runs the deterministic contract proof. It intentionally does not claim live Codebox or Studio Native runtime execution until those interfaces are available.

## Real vs Stubbed

Contract-verified now:

- Host request fixture schema validation.
- Website artifact creation in the expected site-artifact shape.
- Codebox fanout artifact provenance and evidence ref.
- Studio Native canonical artifact source-of-truth metadata.
- Canonical artifact versioning and parent revision provenance.
- User mutation against the original canonical artifact.
- Reimport proof that the updated artifact reaches the materialized theme output.
- Progress, diagnostics, artifact, and evidence-bundle refs.
- In `local-wp` mode, Static Site Importer website artifact materialization through local WordPress/WP-CLI.
- In `local-wp` mode, reimport materialization through local WordPress/WP-CLI.

Stubbed now:

- Codebox browser execution.
- Studio Native canonical artifact persistence APIs.
- Static Site Importer runtime execution in default contract mode.
- Ephemeral Codebox browser/site runtime.
- WordPress active-theme verification.
- Reviewer-facing artifact bundle publication.

## Blockers To Make This Executable

- Host request API contract needs an executable endpoint and auth shape.
- Codebox fanout generation needs a durable artifact bundle contract for website artifacts.
- Studio Native needs a canonical website artifact store/read/update surface.
- SSI reimport needs an idempotent CLI or ability path that accepts the stored canonical artifact.
- Progress diagnostics need stable reviewer-facing artifact bundle links.
