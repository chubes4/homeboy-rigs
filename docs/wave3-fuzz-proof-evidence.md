# Wave 3 Fuzz Proof Evidence Recipes

This is the Wave 3 proof recipe for turning a fuzz campaign declaration into
reviewer-facing evidence without using local-only proof. It covers the complete
chain:

1. Campaign manifest.
2. Core fuzz plan.
3. Lab handoff.
4. Resources indexed.
5. Artifacts and result envelope.
6. Cleanup inspection.

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

homeboy rig show wordpress-core-fuzz-coverage \
  --output "$WAVE3_OUT/resources-index.json"

homeboy fuzz plan \
  --rig wordpress-core-fuzz-coverage \
  --workload rest-api \
  --run-id wave3-core-rest-api-plan \
  --request-id wave3-core-rest-api-plan \
  --strategy read-only \
  --case-budget 25 \
  --duration-budget-seconds 300 \
  --max-duration 5m \
  --seed 3 \
  --tracker-ref "$WAVE3_TRACKER_REF" \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --output "$WAVE3_OUT/core-fuzz-plan.json"

homeboy fuzz run \
  --rig wordpress-core-fuzz-coverage \
  --workload rest-api \
  --run-id wave3-core-rest-api \
  --seed 3 \
  --max-duration 5m \
  --require-result-envelope \
  --require-coverage-summary \
  --tracker-ref "$WAVE3_TRACKER_REF" \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --detach-after-handoff \
  --output "$WAVE3_OUT/lab-handoff.json"

homeboy runs evidence wave3-core-rest-api \
  --output "$WAVE3_OUT/evidence.json"

homeboy runs artifacts wave3-core-rest-api \
  --output "$WAVE3_OUT/artifacts.json"

homeboy runs refs \
  --rig wordpress-core-fuzz-coverage \
  --kind fuzz \
  --tracker-ref "$WAVE3_TRACKER_REF" \
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

homeboy rig show woocommerce-performance \
  --output "$WC_OUT/resources-index.json"

homeboy fuzz plan \
  --rig woocommerce-performance \
  --workload generated-rest-request-cases \
  --run-id wave3-woo-generated-rest-plan \
  --request-id wave3-woo-generated-rest-plan \
  --strategy read-only \
  --case-budget 80 \
  --duration-budget-seconds 1200 \
  --max-duration 20m \
  --seed 3 \
  --tracker-ref "$WC_TRACKER_REF" \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --output "$WC_OUT/core-fuzz-plan.json"

homeboy fuzz run \
  --rig woocommerce-performance \
  --workload generated-rest-request-cases \
  --run-id wave3-woo-generated-rest \
  --seed 3 \
  --max-duration 20m \
  --require-case-log \
  --require-result-envelope \
  --require-coverage-summary \
  --tracker-ref "$WC_TRACKER_REF" \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --detach-after-handoff \
  --output "$WC_OUT/lab-handoff.json"

homeboy runs evidence wave3-woo-generated-rest \
  --output "$WC_OUT/evidence.json"

homeboy runs artifacts wave3-woo-generated-rest \
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

For the broader Woo DB/API campaign, repeat the same `fuzz plan` and `fuzz run`
shape for every workload named in
`woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json`, then collect the
postprocess `coverage_gap_report` and `performance_hotspots_summary` refs listed
by that manifest before promoting the campaign to proven.

## Blocker Matrix

| Requirement | Current status | Promotion blocker |
|---|---|---|
| Campaign manifest | Present for Core and WooCommerce. | None for planning. |
| Core fuzz plan | `homeboy fuzz plan` is available and accepts deterministic seed, strategy, budgets, tracker ref, Lab runner, and JSON output. | Plan output is intent only; it is not execution proof. |
| Lab handoff | `homeboy fuzz run --lab-only --detach-after-handoff` is available. | Requires an approved connected runner and accepted job id. |
| Resources indexed | `homeboy rig show --output` records rig-declared resources before execution. | Any runtime-created resources must also appear in persisted run evidence or cleanup inspection. |
| Artifacts/result envelope | `homeboy runs evidence`, `homeboy runs artifacts`, and `homeboy runs refs` are available. | Proven status requires durable refs for `canonical_fuzz_envelope`, coverage summary, and required product artifacts. |
| Cleanup inspection | `homeboy cleanup worktrees` can preview cleanup across configured providers without `--apply`. | Reviewer proof must include the inspection output; destructive cleanup is a separate approved action. |
| Woo postprocess reports | Woo campaign manifest declares `coverage_gap_report` and `performance_hotspots_summary`. | The campaign remains unproven until those report artifacts have reviewer-facing refs from the offloaded run set. |
