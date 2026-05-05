# sy — Sync engine

## Goals

`sy-` covers the cross-domain sync engine: how reishi distributes fragments from source to targets, how targets are addressed (named agents, named projects, the built-in shared agent), how sync method (copy vs symlink) is resolved, and how inspection modes (`--check`, `--dry-run`) work. This domain owns the contract that `skills sync`, `rules sync`, `docs sync`, and the top-level `rei sync` all participate in. It also owns the upcoming two-step compile orchestration and `clean_on_sync` orphan cleanup.

**Non-goals.** Sync is local-only — no network. Pull (network) lives in `sk-`. The engine never edits source.

## Requirements

### Targets

- **sy-R001** — Target shapes: **agent targets** (named, hold `skills` + `rules` paths) and **project targets** (named, hold a project root for docs). Skills and rules sync to agents; docs sync to projects.
- **sy-R002** — `[agents.<name>]` entries each carry a `skills` and a `rules` path key; either may point at any directory.
- **sy-R003** — `[projects.<name>]` entries each carry a `path` (project root) and an optional `fragments` array.
- **sy-R004** — A built-in `shared` agent target points at `~/.agents/`. The path is fixed by convention; it is not configurable.
- **sy-R005** — `shared` participates in sync only when the user sets `include_shared_agent = true` in config.
- **sy-R006** — The reserved name `shared` cannot be used for a user-defined `[agents.<name>]` entry (see `cf-R013`).

### Sync method

- **sy-R010** — `sync_method` values are `"copy"` and `"symlink"` only.
- **sy-R011** — Resolution order (highest wins): CLI `--method` > per-domain override (`[skills].sync_method`, `[rules].sync_method`, `[docs].sync_method`) > per-skill `[skill_overrides.<name>].sync_method` > global `sync_method`. The per-skill override applies only to that skill.
- **sy-R012** — Copy creates an independent file; symlink creates a symlink pointing at the source path.
- **sy-R013** — When syncing under symlink, target files are replaced with symlinks; when syncing under copy, target files are overwritten with fresh copies.

### Target addressing

- **sy-R020** — `--agents=<name,...>` filters skills and rules sync to the named agents only. Default: every configured agent (plus `shared` if opted in).
- **sy-R021** — `--projects=<name,...>` filters docs sync to the named projects only. Default: every configured project.
- **sy-R022** — Per-skill `[skill_overrides.<name>].agents` further restricts which agents that skill is synced to.

### Missing target paths

- **sy-R030** — If a target's *immediate* directory is missing but its *parent* exists, sync creates the immediate directory and proceeds.
- **sy-R031** — If a target's parent is missing, sync skips that target with a clear warning rather than creating arbitrary parent paths.

### Status semantics (`--check`)

- **sy-R040** — `rei skills sync --check` reports per skill × per agent: `fresh`, `stale`, `diverged`, `missing`, or `symlink`.
  - `stale` = source mtime > target mtime.
  - `diverged` = source mtime > lockfile `synced_at` (only meaningful for tracked skills).
  - Symlinks always report `stale: false` and `diverged: false` — they *are* the source.
  - Untracked skills (no lockfile entry) are never `diverged`.
- **sy-R041** — `--check` never writes and never hits the network.
- **sy-R042** — `rei rules sync --check` and `rei docs sync --check` report comparable per-fragment × per-target freshness.
- **sy-R043** — `rei skills pull --check` is the network counterpart — see `sk-R056`.

### Dry-run

- **sy-R050** — Every sync command supports `--dry-run`: no writes, no auto-syncs, but a clear preview of what would change.
- **sy-R051** — Under `--dry-run`, `clean_on_sync` orphan reports are printed but no prompt is shown and nothing is removed.

### Top-level `rei sync`

- **sy-R055** — `rei sync` is a strict cross-domain convenience that runs skills, rules, and docs syncs in sequence — local-only, no network.
- **sy-R056** — `rei sync` accepts `--agents`, `--projects`, `--method`, `--dry-run`; it does not accept `--prefix-change` or `--no-fetch` (those belong to pull).
- **sy-R057** — Auto-sync triggers — `skills add`, `skills activate`, `skills deactivate`, `skills new`, `skills pull` — call the relevant sync entry point with no flags after completing their primary work.

### Two-step compile (Phase 14)

- **sy-R060** — Per-agent compile opt-in: an `[agents.<name>]` entry may set `compile = true` to participate in the compile-then-ship flow.
- **sy-R061** — Compiled file path: `[agents.<name>].compile_file` is a single field, relative to the agent target root, default `AGENTS.md`. Subpaths like `"sub/foo.md"` are allowed.
- **sy-R062** — If `compile_file` resolves outside the agent target root (e.g. via `..` segments), reishi rejects the config with a clear error.
- **sy-R063** — When `rei sync` runs (or any domain sync that participates), it first runs the relevant compile step (`rules compile` and/or `docs compile`) to update the source artifact, then ships the source artifact to every target whose `compile = true`.
- **sy-R064** — Compile generates the file *in source*, so it is git-trackable and visible. Sync ships that source file as-is.

### `clean_on_sync` (Phase 15)

- **sy-R070** — Global `clean_on_sync` boolean (default `false`) opts in to orphan cleanup in copy targets.
- **sy-R071** — An orphan is a file present in a target that has no corresponding source fragment. Only relevant for `copy` syncs; symlinks self-resolve when the source moves or is deleted.
- **sy-R072** — During a sync run, orphans are collected across the whole run (every domain × every target) and presented in a single batched prompt at the end: `clean up 🧼: remove A, B, and C? (Y/n)`, default `Y`.
- **sy-R073** — Under `--dry-run`, the prompt is skipped and orphans are reported as "would be cleaned" instead.
- **sy-R074** — `clean_on_sync` only removes files that reishi would have written; it never removes user files outside the relevant target subtrees.
