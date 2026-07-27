## Studio db.php Fuzz

This rig owns adversarial filesystem state-machine coverage for Studio's SQLite
drop-in classification and installation code. Studio is a target component and
does not carry Homeboy-specific files.

The runner mutates only a fresh temporary directory and covers:

- All destination combinations of `wp-config.php`, `db.php`, `.ht.sqlite`, and
  the SQLite mu-plugin.
- Foreign, stock, and compatible custom drop-ins.
- Comments, strings, and identifiers that spoof `SQLITE_DB_DROPIN_VERSION`.
- Filesystem blockers and external `db.php` symlinks.
- Intentional-MySQL non-mutation.

Run against a specific Studio checkout:

```bash
HOMEBOY_RIG_COMPONENT_PATH__STUDIO_DB_DROPIN_FUZZ__STUDIO=/path/to/studio \
  homeboy fuzz run --rig studio-db-dropin-fuzz --profile provider \
  --tracker-ref 'github-issue:Automattic/studio#4355' \
  --seed 3692 --gate-profile strict --isolation isolated
```

The workload emits a replay file, JSONL case log, coverage summary, and Homeboy
fuzz campaign envelope. Open findings are deduplicated by semantic root cause;
generated cases remain individually replayable.

PR-specific import-boundary coverage is intentionally separate from provider
hardening. Build the Studio CLI first, then run only the `pr-4356` profile:

```bash
HOMEBOY_RIG_COMPONENT_PATH__STUDIO_DB_DROPIN_FUZZ__STUDIO=/path/to/studio-pr-4356 \
  homeboy fuzz run --rig studio-db-dropin-fuzz --profile pr-4356 \
  --tracker-ref 'github-pr:Automattic/studio#4356' \
  --seed 4356 --gate-profile strict --isolation isolated
```

That profile exercises the real built CLI and repository Jetpack fixture. It
reports only foreign-drop-in recovery and intentional-MySQL pre-mutation
rejection, the two contracts changed by Studio PR #4356.
