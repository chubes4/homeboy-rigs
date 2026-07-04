# Studio Canonical Loop Proof Guard

This file documents the intended website artifact loop contract. It is not proof that the production Studio Native loop works.

The retired harness used to synthesize Codebox fanout output, Studio Native canonical-store output, Static Site Importer materialization output, and reviewer evidence refs. That behavior was misleading because it could pass without executing the real runtime. The executable script now only validates the contract fixture with `--check`; runtime proof execution fails clearly until live mode has real runtime wiring and durable reviewer-facing artifact refs.

## Intended Loop

1. Host request arrives with prompt, fanout targets, artifact contract, and user-change intent.
2. Codebox/fanout generation produces a website artifact.
3. Studio Native stores that artifact as the canonical site source.
4. Static Site Importer materializes the artifact into a block theme in an ephemeral Codebox/site.
5. A user change mutates the original canonical artifact.
6. Reimport materializes the updated artifact.
7. Progress and diagnostics artifacts explain what happened through durable reviewer-facing refs.

## Safe Fixture Validation

```bash
node Automattic/studio/proofs/studio-canonical-loop-proof.mjs --check
export HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extensions/wordpress/lib/helper-manifest.js
node scripts/lint-rig-packages.mjs Automattic/studio
```

`--check` validates `Automattic/studio/fixtures/studio-canonical-loop/host-request.json` and does not execute a runtime proof or write proof artifacts.

## Runtime Proof Status

The runtime proof is intentionally blocked:

```bash
node Automattic/studio/proofs/studio-canonical-loop-proof.mjs
```

The script fails unless `--mode live` is used with a real Studio Native runtime URL and a durable evidence ref:

```bash
STUDIO_NATIVE_RUNTIME_URL=https://your-studio-native-runtime.example \
STUDIO_CANONICAL_LOOP_DURABLE_EVIDENCE_REF=https://durable-artifact.example/run/123 \
  node Automattic/studio/proofs/studio-canonical-loop-proof.mjs --mode live
```

Even with those values present, this harness fails until the live implementation drives real host request execution, Codebox fanout, Studio Native canonical persistence, SSI materialization, and durable artifact publication. It must not synthesize local artifacts as proof evidence.

## Rig Entry Point

```bash
homeboy rig check studio-canonical-loop-proof
```

The rig validates the fixture only. A passing rig check means the checked-in host request fixture is structurally valid; it does not claim a live Studio Native loop proof.

## Production Loop Acceptance Criteria

The production proof needs to drive the real runtime:

- Open the Studio Native runtime in a browser or through its real REST surfaces.
- Submit a real host chat/generation request through `/studio-native-agentic-ui/v1/chat` or the UI.
- Observe real progress through `/studio-native-agentic-ui/v1/runs/{run_id}/events`.
- Verify real Codebox delegation and artifact refs.
- Verify Studio Native stores the accepted artifact as project source-of-truth state.
- Verify SSI materializes the artifact into the runtime site.
- Submit a real edit request against the existing project.
- Verify the original stored artifact is mutated and reimported.
- Verify the visible site output changes.
- Produce reviewer-facing artifacts/screenshots/events that demonstrate the iteration has value.

## Core/Runtime Follow-Up For An Executable Production Proof

- Host request API contract needs an executable endpoint and auth shape.
- Codebox fanout generation needs a durable artifact bundle contract for website artifacts.
- Studio Native needs a canonical website artifact store/read/update surface.
- SSI reimport needs an idempotent CLI or ability path that accepts the stored canonical artifact.
- Progress diagnostics need stable reviewer-facing artifact bundle links.
