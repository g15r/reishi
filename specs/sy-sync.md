# sy — Sync engine

## Goals

`sy-` covers the sync engine: how reishi materializes the currently-active library set into
agent targets, how those targets are addressed, how sync method (copy vs symlink) resolves, and
how inspection modes (`--check`, `--dry-run`) work. Sync is **activation-driven** — it writes
active items, removes items no longer active, and respects condition evaluation for the current
context. This domain owns the contract that `skills sync`, `rules sync`, the top-level
`rei sync`, and post-mutation auto-syncs (after `add`, `pull`, `use`, `unuse`, etc.) all
participate in.

**Non-goals.** Sync is local-only — no network. Pull (network) lives in `sk-`. The engine
never edits source. No compile step — artifacts ship as-is. No project targets — the library
distributes to agent targets only.

## Requirements

### Targets

- **sy-R001** — Targets are **agent targets**: `[agents.<name>]` entries holding `skills` and
  `rules` path keys. Skills and rules sync to the corresponding path.
- **sy-R002** — A built-in `shared` agent target points at `~/.agents/`. The path is fixed by
  convention; it is not configurable.
- **sy-R003** — `shared` participates in sync only when the user sets
  `include_shared_agent = true` in config.
- **sy-R004** — The reserved name `shared` cannot be used for a user-defined `[agents.<name>]`
  entry (see `cf-R013`).

### Sync method

- **sy-R010** — `sync_method` values are `"copy"` and `"symlink"` only.
- **sy-R011** — Resolution order (highest wins): CLI `--method` > per-domain override
  (`[skills].sync_method`, `[rules].sync_method`) > per-item override
  (`[skill_overrides.<name>].sync_method`, `[rule_overrides.<name>].sync_method`) > global
  `sync_method`.
- **sy-R012** — Copy creates an independent file; symlink creates a symlink pointing at the
  source path.
- **sy-R013** — When syncing under symlink, target files are replaced with symlinks; when
  syncing under copy, target files are overwritten with fresh copies.

### Active-set materialization

- **sy-R020** — Sync evaluates activation (per `ac-R030` – `ac-R033`) under the current
  evaluation context, then for each addressed agent target:
  1. Write every active rule and skill that's not already present in the correct shape.
  2. Remove every rule and skill previously synced by reishi that is no longer active.
  3. Leave user-authored files in the target untouched (orphan cleanup is opt-in via
     `clean_on_sync`, sy-R070+).
- **sy-R021** — An item is "previously synced by reishi" if it lives under the target's
  `skills` or `rules` path and matches a source-side name reishi knows about. Items that exist
  in the target but never had a source-side counterpart are user orphans, not deactivation
  artifacts.
- **sy-R022** — Per-item overrides (`[skill_overrides.<name>].agents`,
  `[rule_overrides.<name>].agents`, `[profile_overrides.<name>].agents`) further restrict which
  agents see that item, even when activation conditions would otherwise include it.

### Target addressing

- **sy-R030** — `--agents=<name,...>` filters sync to the named agents only. Default: every
  configured agent (plus `shared` if opted in).
- **sy-R031** — Sync evaluation context exposes each addressed agent to the activation engine
  so `agent` conditions (`ac-R022`) and `[agents.<name>].default_profiles` (`ac-R060`) fire
  appropriately.

### Missing target paths

- **sy-R040** — If a target's _immediate_ directory is missing but its _parent_ exists, sync
  creates the immediate directory and proceeds.
- **sy-R041** — If a target's parent is missing, sync skips that target with a clear warning
  rather than creating arbitrary parent paths.

### Status semantics (`--check`)

- **sy-R050** — `rei skills sync --check` and `rei rules sync --check` report per item × per
  agent: `fresh`, `stale`, `diverged`, `missing`, `removed` (active in past sync, not active
  now), or `symlink`.
  - `stale` = source mtime > target mtime.
  - `diverged` = source mtime > lockfile `synced_at` (only meaningful for tracked skills).
  - Symlinks always report `stale: false` and `diverged: false` — they _are_ the source.
  - Untracked skills (no lockfile entry) are never `diverged`.
- **sy-R051** — `--check` never writes and never hits the network.
- **sy-R052** — `rei skills pull --check` is the network counterpart — see `sk-R056`.

### Dry-run

- **sy-R060** — Every sync command supports `--dry-run`: no writes, no auto-syncs, but a clear
  preview of what would change (additions, removals, retained user files).
- **sy-R061** — Under `--dry-run`, `clean_on_sync` orphan reports are printed but no prompt is
  shown and nothing is removed.

### Top-level `rei sync`

- **sy-R070** — `rei sync` is a cross-domain convenience that runs skills and rules syncs in
  sequence — local-only, no network.
- **sy-R071** — `rei sync` accepts `--agents`, `--method`, `--dry-run`; it does not accept
  `--prefix-change` or `--no-fetch` (those belong to pull).
- **sy-R072** — Auto-sync triggers — `skills add`, `skills new`, `skills pull`, `rei use`,
  `rei unuse` — call the relevant sync entry point with no flags after completing their
  primary work. `--no-sync` on any trigger skips the auto-sync.

### `clean_on_sync`

- **sy-R080** — Global `clean_on_sync` boolean (default `false`) opts in to orphan cleanup in
  copy targets.
- **sy-R081** — An orphan is a file present in a target that has no corresponding source-side
  item (rule or skill) reishi knows about. Items removed because activation no longer covers
  them are _not_ orphans — those are handled directly by the active-set materialization step
  (sy-R020) and never prompted.
- **sy-R082** — During a sync run, orphans are collected across the whole run (every domain ×
  every target) and presented in a single batched prompt at the end:
  `clean up 🧼: remove A, B, and C? (Y/n)`, default `Y`.
- **sy-R083** — Under `--dry-run`, the prompt is skipped and orphans are reported as "would be
  cleaned" instead.
- **sy-R084** — Only relevant for `copy` syncs; symlinks self-resolve when the source moves or
  is deleted.
- **sy-R085** — `clean_on_sync` only removes files that reishi would have written; it never
  removes user files outside the relevant target subtrees.
