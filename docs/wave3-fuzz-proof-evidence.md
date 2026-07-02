# Wave 3 Fuzz Proof Evidence Recipes

This is the Wave 3 proof recipe for turning a fuzz campaign declaration into
reviewer-facing evidence without using local-only proof. It covers the complete
chain:

1. Campaign manifest.
2. Campaign dispatch through Homeboy's fuzz campaign primitive.
3. Resource lifecycle index inspection.
4. Artifacts and canonical outcome envelope.
5. Cleanup inspection.

The recipe is deterministic, but this repository does not claim the campaigns
are proven until the commands produce durable Homeboy run and artifact refs from
an approved Lab runner. Local paths, localhost URLs, and console output are not
proof.

Machine-readable recipes live in
[`wave3-fuzz-proof-recipes.json`](wave3-fuzz-proof-recipes.json). Validate them
without running hot fuzz workloads:

```bash
node scripts/wave3-proof-recipe-check.mjs
```

## Generic WordPress Core Recipe

Use this recipe when the goal is to prove the generic Homeboy fuzz loop against a
Core-owned manifest before layering product-specific assertions on top.

```bash
export HOMEBOY_RUNNER_ID=<approved-runner-id>
export WAVE3_TRACKER_REF=github:owner/repo#issue-or-pr
export WAVE3_OUT=./wave3-core-proof
export WAVE3_CORE_RESOURCE_INDEX=<resource-lifecycle-index-artifact-json>

homeboy fuzz run-campaign \
  --rig wordpress-core-fuzz-coverage \
  --campaign-workload rest-api \
  --request-id wave3-core-rest-api-campaign \
  --strategy read-only \
  --case-budget 25 \
  --duration-budget-seconds 300 \
  --max-duration 5m \
  --seed 3 \
  --tracker-ref "$WAVE3_TRACKER_REF" \
  --required-artifact canonical_fuzz_envelope \
  --required-artifact homeboy_fuzz_coverage \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --detach-after-handoff \
  --output "$WAVE3_OUT/campaign-dispatch.json"

homeboy runs watch wave3-core-rest-api-campaign-rest-api \
  --output "$WAVE3_OUT/terminal-run.json"

homeboy runs resources \
  --file "$WAVE3_CORE_RESOURCE_INDEX" \
  --run-id wave3-core-rest-api-campaign-rest-api \
  --output "$WAVE3_OUT/resources-index.json"

homeboy runs evidence wave3-core-rest-api-campaign-rest-api \
  --output "$WAVE3_OUT/evidence.json"

homeboy runs artifacts wave3-core-rest-api-campaign-rest-api \
  --output "$WAVE3_OUT/artifacts.json"

homeboy runs refs \
  --rig wordpress-core-fuzz-coverage \
  --kind fuzz \
  --tracker-ref "$WAVE3_TRACKER_REF" \
  --artifact-kind canonical_fuzz_envelope \
  --artifact-kind homeboy_fuzz_coverage \
  --output "$WAVE3_OUT/reviewer-refs.json"

homeboy cleanup worktrees \
  --provider datamachine-code \
  --output "$WAVE3_OUT/cleanup-inspection.json"
```

## WooCommerce Product Recipe

Use this recipe when the goal is to prove one product campaign using the same
generic loop plus WooCommerce-owned campaign/artifact contracts.

```bash
export HOMEBOY_RUNNER_ID=<approved-runner-id>
export WC_TRACKER_REF=github:woocommerce/woocommerce#issue-or-pr
export WC_OUT=./wave3-woo-db-api-proof
export WC_RESOURCE_INDEX=<resource-lifecycle-index-artifact-json>

homeboy fuzz run-campaign \
  --rig woocommerce-performance \
  --campaign-manifest woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json \
  --request-id wave3-woo-db-api-campaign \
  --strategy read-only \
  --case-budget 80 \
  --duration-budget-seconds 1200 \
  --max-duration 20m \
  --seed 3 \
  --tracker-ref "$WC_TRACKER_REF" \
  --required-artifact canonical_fuzz_envelope \
  --required-artifact homeboy_fuzz_coverage \
  --required-artifact coverage_gap_report \
  --required-artifact performance_hotspots_summary \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --detach-after-handoff \
  --output "$WC_OUT/campaign-dispatch.json"

homeboy runs watch wave3-woo-db-api-campaign-generated-rest-request-cases \
  --output "$WC_OUT/terminal-run.json"

homeboy runs resources \
  --file "$WC_RESOURCE_INDEX" \
  --run-id wave3-woo-db-api-campaign-generated-rest-request-cases \
  --output "$WC_OUT/resources-index.json"

homeboy runs evidence wave3-woo-db-api-campaign-generated-rest-request-cases \
  --output "$WC_OUT/evidence.json"

homeboy runs artifacts wave3-woo-db-api-campaign-generated-rest-request-cases \
  --output "$WC_OUT/artifacts.json"

homeboy runs refs \
  --rig woocommerce-performance \
  --kind fuzz \
  --tracker-ref "$WC_TRACKER_REF" \
  --artifact-kind canonical_fuzz_envelope \
  --artifact-kind homeboy_fuzz_coverage \
  --output "$WC_OUT/reviewer-refs.json"

homeboy cleanup worktrees \
  --provider datamachine-code \
  --output "$WC_OUT/cleanup-inspection.json"
```

For the broader Woo DB/API campaign, `fuzz run-campaign` expands every workload
named in `woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json`. Do not
promote the campaign to proven until the resulting persisted run set includes
reviewer-facing `coverage_gap_report` and `performance_hotspots_summary` refs.

## Blocker Matrix

| Requirement | Current status | Promotion blocker |
|---|---|---|
| Campaign manifest | Present for Core and WooCommerce. | None for planning. |
| Campaign dispatch | `homeboy fuzz run-campaign` consumes `--campaign-manifest` or repeatable `--campaign-workload`, expands entry run IDs, records required artifacts, and offloads with `--lab-only --detach-after-handoff`. | Requires an approved connected runner, accepted handoff job IDs, and terminal entry runs. |
| Resources indexed | `homeboy runs resources --file <resource-lifecycle-index> --run-id <run-id>` filters the persisted resource lifecycle index from the run artifact set. | The resource lifecycle index must be a durable artifact from the approved run, not a local-only file. |
| Artifacts/outcome envelope | `homeboy runs evidence`, `homeboy runs artifacts`, and `homeboy runs refs` are available; terminal runs must expose `homeboy/run-outcome-envelope/v1`. | Proven status requires durable refs for `canonical_fuzz_envelope`, coverage summary, and required product artifacts. |
| Cleanup inspection | `homeboy cleanup worktrees` can preview cleanup across configured providers without `--apply`. | Reviewer proof must include the inspection output; destructive cleanup is a separate approved action. |
| Woo postprocess reports | Woo campaign manifest declares `coverage_gap_report` and `performance_hotspots_summary`. | The campaign remains unproven until those report artifacts have reviewer-facing refs from the offloaded run set. |
