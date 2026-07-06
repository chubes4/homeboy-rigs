## Studio MySQL POC Fuzz Lab

This rig packages the lab-only Studio MySQL POC fuzz workload owned by `homeboy-rigs`.

Run policy:

- Execute the fuzz runner only through approved Homeboy lab/offload isolation.
- Do not run the destructive workload on a local user Studio profile.
- Local validation is limited to static checks such as `node --check`, JSON parsing, and Homeboy contract/package linting.

Diagnostics added by the runner:

- Per-case invariants describing what must remain true after success or expected failure.
- Structured failure classification: `unsupported_platform`, `product_bug`, `rig_setup_failure`, `rig_induced_fault`, and `product_guardrail`.
- Data parity checks for the large SQLite-to-MySQL conversion and WP-CLI export/import round trip.
- Post-case health probes recorded separately from primary results so cleanup diagnostics do not mask the case outcome.
- Replay metadata covering command shape, run id, selected operation strata, git head/branch, Node/platform/arch, runtime root, artifacts, and execution request file.
- Expected skip handling for synthetic unsupported-platform coverage when provider artifacts are unavailable.

Primary files:

- `../../fuzz/mysql-poc-lifecycle-fuzz.json`
- `../../fuzz/mysql-fuzz-runner.mjs`
- `../../manifests/mysql-poc-inventory.json`
- `../../proofs/mysql-poc-isolation-proof.json`
