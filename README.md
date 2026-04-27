# homeboy-rigs

Personal `homeboy rig` and `homeboy stack` specs. Lives at `~/.config/homeboy/rigs/` and `~/.config/homeboy/stacks/` on every machine.

A **rig** is a declarative spec for a reproducible local dev environment — components, services, symlinks, patches, pipelines for `up` / `check` / `down`. Replaces multi-step bash runbooks with one command.

See: [homeboy rig docs](https://github.com/Extra-Chill/homeboy/tree/main/docs).

## Rigs in this repo

### `studio.json`

The Studio + Playground combined-fixes dev environment — the "use the dev copy" setup. Forks rebased onto trunk, open PRs cherry-picked, Docker-compiled PHP-WASM glue, tarball server, Studio CLI rewired to local tarballs.

Source of truth for what this rig does: wiki article `projects/studio/studio-playground-cross-repo-dev` on intelligence-chubes4.

```bash
homeboy rig check studio   # ~1s preflight
homeboy rig up studio       # ~30 min from cold (Docker compile)
homeboy rig down studio     # stop tarball server + studio daemon
```

Required components on disk:

- `~/Developer/studio` on `dev/combined-fixes` (origin = `chubes4/studio` fork)
- `~/Developer/wordpress-playground` on `dev/combined-fixes` (origin = `chubes4/wordpress-playground` fork, upstream = `WordPress/wordpress-playground`)
- `~/.local/bin/studio-dev` shell script that invokes the dev-built Studio CLI

Required tooling:

- Docker + buildx (Colima recommended)
- Node + npm
- Python 3 (for tarball http server)
- jq

### `intelligence-chubes4.json`

The intelligence-chubes4 site runtime — points the live WordPress plugin symlinks at the worktree we're testing. Edit `components.<id>.path` to switch which worktree (or primary checkout) is mounted, then `homeboy rig up intelligence-chubes4`.

Currently a placeholder shape; expand as more components join the site.

### `isolated-block-editor.json`

The Isolated Block Editor maintenance rig. Runs the checks used while shaving IBE toward modern Gutenberg APIs:

```bash
homeboy rig up isolated-block-editor      # preflight checkout + node_modules
homeboy rig check isolated-block-editor   # npm run build + npm test -- --runInBand
```

Edit `components.isolated-block-editor.path` to point at a worktree such as `/var/lib/datamachine/workspace/isolated-block-editor@feature-branch` when validating a PR branch. The rig temporarily symlinks the primary checkout's `node_modules` if the worktree does not have its own install.

## Stacks in this repo

Stack specs live under `stacks/`. Install them by copying the JSON files into `~/.config/homeboy/stacks/` until Homeboy grows a package install verb for stacks.

```bash
mkdir -p ~/.config/homeboy/stacks
cp stacks/*.json ~/.config/homeboy/stacks/
```

### `studio-combined`

The PR stack for `~/Developer/studio` on `dev/combined-fixes`. It rebuilds `fork/dev/combined-fixes` from `origin/trunk` plus Chris's active Automattic/studio local-dev PRs.

```bash
homeboy stack status studio-combined
homeboy stack sync --dry-run studio-combined
```

### `playground-combined`

The PR stack for `~/Developer/wordpress-playground` on `dev/combined-fixes`. It rebuilds `origin/dev/combined-fixes` from `upstream/trunk` plus Chris's active WordPress/wordpress-playground PHP-WASM and worker-pool PRs.

```bash
homeboy stack status playground-combined
homeboy stack sync --dry-run playground-combined
```

## Conventions

- **Component paths** use `~/Developer/<repo>` for primary checkouts and `~/Developer/<repo>@<branch-slug>` for worktrees, mirroring the data-machine-code workspace convention.
- **Branches** in `components.<id>.branch` document the expected branch — rigs don't currently enforce branch state, but the field hints to humans reading the spec.
- **Patches** carry a unique marker string (`PHP-WASM-COMBINED-FIXES TSRMLS fallback`, etc.) that identifies the patch in the file. Marker-based idempotency means re-running `up` is safe.
- **External services** (`kind: external`) are processes the rig didn't spawn — the rig only knows how to *stop* them via `discover.pattern`. Use this for stale daemons that need recycling after a build.

## What does NOT belong here

- Site state (DB, uploads) — Studio site backups handle that.
- Agent state (MEMORY.md, wiki, skills) — DMC GitSync handles that.
- Source code (plugins, themes) — already tracked in their own repos.
- Secrets — rigs reference env vars or sigillo paths; never embed.

## Per-machine state

Each rig writes runtime state (PIDs, last-up timestamps, service status) to `<id>.state/` next to `<id>.json`. Those directories are `.gitignore`d — they're not portable across machines.
