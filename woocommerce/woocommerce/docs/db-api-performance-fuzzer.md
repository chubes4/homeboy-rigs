# WooCommerce DB/API Performance Fuzzer Operator Recipe

This is the reviewer-facing handoff for running the first real WooCommerce
DB/API fuzzer campaign through Homeboy's fuzz/run evidence flow. It uses the
current `woocommerce-performance` rig contracts and the
`db-api-performance-fuzzer` profile declared in
`rigs/woocommerce-performance/rig.json`.

Use an approved Homeboy runner/offloaded environment. Do not run this campaign,
benchmarks, or high-volume fuzzing locally on this Studio machine. Local command
outputs are operator scratch only; reviewer proof must be a persisted Homeboy run
or artifact ref.

## Tracker

Create or select the WooCommerce issue or PR before running the campaign. Every
proof comment should include:

- The tracker URL.
- The Homeboy rig id: `woocommerce-performance`.
- The campaign manifest: `manifests/db-api-fuzz-campaign.json`.
- The profile id: `db-api-performance-fuzzer`.
- The persisted Homeboy run ids and artifact refs.

Use shell variables only to keep the commands readable:

```bash
export HOMEBOY_RUNNER_ID=<approved-runner-id>
export WC_TRACKER_REF=<woocommerce-issue-or-pr-url>
export WC_BASELINE_REF=<baseline-git-ref-or-sha>
export WC_CANDIDATE_REF=<candidate-git-ref-or-sha>
```

## Contracts

The fuzzer campaign is not proven by a local directory, screenshot, or console
log. The reviewer-facing proof bundle must contain artifacts with these schemas:

- `wp-codebox/fuzz-suite-result/v1` for the runtime-backed Codebox fuzz-suite result.
- `wp-codebox/wordpress-hotspots/v1` for WordPress hotspot discovery from the same campaign.
- `homeboy/fuzz-coverage/v1` for Homeboy fuzz coverage.
- `homeboy/woocommerce-performance-hotspots-summary/v1` for hotspot ranking output.
- `homeboy-rigs/wordpress-coverage-gap-report/v1` for the coverage gap report.

Every proof ref must be durable and reviewer-facing, using one of the accepted
Homeboy/GitHub ref forms (`https://`, `gh:`, `homeboy-runs:`,
`homeboy://run/`, `homeboy-artifact://`, `artifact:`, or `run:`). Local paths,
`file://` URLs, localhost URLs, and placeholder refs are not proof.

The declared source contracts live in:

- `manifests/db-api-fuzz-campaign.json`.
- `manifests/codebox-fuzz-suite-smoke.json`.
- `manifests/db-api-performance-fuzzer-gap-report.json`.
- `bench/coverage-gap-report.workload.json`.
- `bench/performance-hotspots-artifact-summary.workload.json`.
- `tools/db-api-fuzzer-artifacts.mjs`.

## Inventory

Inventory commands confirm declared workloads and the generated target inventory;
they do not prove execution.

```bash
homeboy rig check woocommerce-performance

homeboy fuzz list \
  --rig woocommerce-performance \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --output ./wc-db-api-fuzz-workloads.json

homeboy fuzz discover \
  --inventory woocommerce/woocommerce/manifests/target-inventory.json \
  --inventory-id woocommerce-db-api-performance-fuzzer \
  --source-label woocommerce-performance \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --output ./wc-db-api-target-inventory.json
```

Attach the persisted run/artifact refs from the offloaded environment to the
tracker. Do not paste `./wc-db-api-*.json` paths as reviewer proof.

## Plan

Build the execution requests before the run. The plan output is reviewable for
intent, but still not proof that any case executed.

```bash
homeboy fuzz plan \
  --rig woocommerce-performance \
  --workload codebox-fuzz-suite-smoke \
  --run-id wc-db-api-codebox-suite-baseline \
  --request-id wc-db-api-codebox-suite-baseline \
  --strategy read-only \
  --case-budget 80 \
  --duration-budget-seconds 600 \
  --max-duration 10m \
  --seed 1 \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --output ./wc-db-api-codebox-suite-plan.json

homeboy fuzz plan \
  --rig woocommerce-performance \
  --workload generated-rest-request-cases \
  --run-id wc-db-api-generated-cases-baseline \
  --request-id wc-db-api-generated-cases-baseline \
  --strategy read-only \
  --case-budget 80 \
  --duration-budget-seconds 1200 \
  --max-duration 20m \
  --seed 1 \
  --lab-only \
  --runner "$HOMEBOY_RUNNER_ID" \
  --output ./wc-db-api-generated-cases-plan.json
```

For a candidate comparison, repeat the same plan commands with `candidate` in the
`--run-id` and `--request-id` values.

## Run

Run the whole campaign in the same approved offloaded environment so the
postprocess workloads can consume the same persisted artifact root. Use the
selected WooCommerce checkout through `--path` when the runner is validating a
specific baseline or candidate worktree.

Baseline:

```bash
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload codebox-fuzz-suite-smoke --run-id wc-db-api-codebox-suite-baseline --seed 1 --max-duration 10m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload woocommerce-rest-route-inventory --run-id wc-db-api-route-inventory-baseline --seed 1 --max-duration 10m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload generated-rest-request-cases --run-id wc-db-api-generated-cases-baseline --seed 1 --max-duration 20m --require-result-envelope --require-case-log --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload rest-db-query-profile --run-id wc-db-api-query-profile-baseline --seed 1 --max-duration 20m --require-result-envelope --require-case-log --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload db-inventory --run-id wc-db-api-db-inventory-baseline --seed 1 --max-duration 10m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload rest-schema-query-attribution --run-id wc-db-api-schema-query-attribution-baseline --seed 1 --max-duration 20m --require-result-envelope --require-case-log --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload coverage-gap-report --run-id wc-db-api-coverage-gap-report-baseline --seed 1 --max-duration 15m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-baseline-plugin-path> --workload performance-hotspots-artifact-summary --run-id wc-db-api-hotspots-summary-baseline --seed 1 --max-duration 15m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
```

Candidate:

```bash
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload codebox-fuzz-suite-smoke --run-id wc-db-api-codebox-suite-candidate --seed 1 --max-duration 10m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload woocommerce-rest-route-inventory --run-id wc-db-api-route-inventory-candidate --seed 1 --max-duration 10m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload generated-rest-request-cases --run-id wc-db-api-generated-cases-candidate --seed 1 --max-duration 20m --require-result-envelope --require-case-log --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload rest-db-query-profile --run-id wc-db-api-query-profile-candidate --seed 1 --max-duration 20m --require-result-envelope --require-case-log --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload db-inventory --run-id wc-db-api-db-inventory-candidate --seed 1 --max-duration 10m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload rest-schema-query-attribution --run-id wc-db-api-schema-query-attribution-candidate --seed 1 --max-duration 20m --require-result-envelope --require-case-log --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload coverage-gap-report --run-id wc-db-api-coverage-gap-report-candidate --seed 1 --max-duration 15m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
homeboy fuzz run --rig woocommerce-performance --path <runner-woocommerce-candidate-plugin-path> --workload performance-hotspots-artifact-summary --run-id wc-db-api-hotspots-summary-candidate --seed 1 --max-duration 15m --require-result-envelope --require-coverage-summary --tracker-ref "$WC_TRACKER_REF" --lab-only --runner "$HOMEBOY_RUNNER_ID" --detach-after-handoff
```

Use `homeboy runner job logs` to follow detached jobs when the selected runner
accepts the handoff. Keep the tracker updated with the accepted job ids and final
run ids.

## Evidence And Artifacts

Start from the persisted run store. For each baseline and candidate run id:

```bash
homeboy runs evidence <run-id> --output ./evidence-<run-id>.json
homeboy runs artifacts <run-id> --output ./artifacts-<run-id>.json
```

Then emit stable refs for the campaign window:

```bash
homeboy runs refs \
  --rig woocommerce-performance \
  --kind fuzz \
  --status completed \
  --tracker-ref "$WC_TRACKER_REF" \
  --since 24h \
  --artifact-kind canonical_fuzz_envelope \
  --artifact-kind codebox_fuzz_suite_result \
  --artifact-kind coverage_gap_report \
  --artifact-kind performance_hotspots_summary \
  --output ./wc-db-api-fuzz-refs.json
```

The reviewer-facing tracker comment should name artifact schemas and stable refs,
not local files. Required proof refs:

- `canonical_fuzz_envelope` for baseline and candidate result envelopes.
- `codebox_fuzz_suite_result` with schema `wp-codebox/fuzz-suite-result/v1`.
- `wordpress_hotspots` with schema `wp-codebox/wordpress-hotspots/v1`.
- `homeboy_fuzz_coverage` with schema `homeboy/fuzz-coverage/v1`.
- `coverage_gap_report` with schema `homeboy-rigs/wordpress-coverage-gap-report/v1`.
- `performance_hotspots_summary` with schema `homeboy/woocommerce-performance-hotspots-summary/v1`.

## Compare

Compare persisted result envelopes, not ad hoc JSON copied from a runner working
directory. Resolve the `canonical_fuzz_envelope` artifact ids from
`homeboy runs artifacts`, retrieve them through Homeboy, then compare:

```bash
homeboy runs artifact get wc-db-api-codebox-suite-baseline <baseline-canonical-fuzz-envelope-artifact-id> \
  --output ./baseline-canonical-fuzz-envelope.json

homeboy runs artifact get wc-db-api-codebox-suite-candidate <candidate-canonical-fuzz-envelope-artifact-id> \
  --output ./candidate-canonical-fuzz-envelope.json

homeboy fuzz compare \
  ./baseline-canonical-fuzz-envelope.json \
  ./candidate-canonical-fuzz-envelope.json \
  --hotspot-policy advisory \
  --output ./wc-db-api-fuzz-compare.json
```

Use `--hotspot-policy blocking` only when the tracker explicitly wants relative
hotspot regressions to block the candidate.

## Reviewer Comment Shape

Use this structure in the WooCommerce issue or PR:

```markdown
Tracker: <WC_TRACKER_REF>
Rig: `woocommerce-performance`
Profile: `db-api-performance-fuzzer`
Campaign manifest: `woocommerce/woocommerce/manifests/db-api-fuzz-campaign.json`
Baseline: `<WC_BASELINE_REF>`
Candidate: `<WC_CANDIDATE_REF>`

Runs:
- `wc-db-api-codebox-suite-baseline`: <stable-run-ref>
- `wc-db-api-codebox-suite-candidate`: <stable-run-ref>
- `wc-db-api-coverage-gap-report-candidate`: <stable-run-ref>
- `wc-db-api-hotspots-summary-candidate`: <stable-run-ref>

Required artifacts:
- `wp-codebox/fuzz-suite-result/v1`: durable artifact ref from `homeboy runs refs`
- `wp-codebox/wordpress-hotspots/v1`: durable artifact ref from `homeboy runs refs`
- `homeboy/fuzz-coverage/v1`: durable artifact ref from `homeboy runs refs`
- `homeboy-rigs/wordpress-coverage-gap-report/v1`: durable artifact ref from `homeboy runs refs`
- `homeboy/woocommerce-performance-hotspots-summary/v1`: durable artifact ref from `homeboy runs refs`

Compare: <compare-artifact-ref>
Result: <pass/fail/partial with the concrete gap or hotspot delta>
```

If any required schema is missing, report the campaign as partial and keep the
manifest at declared readiness. Do not replace missing fuzz proof with a local
benchmark, smoke test, or hand-built summary.
