# reishi TODO

## Phase 7: Command Restructure, Sync/Pull Split, and Lockfile 🌀

Restructure commands under domain subgroups, separate upstream fetch from target distribution, introduce a lockfile for tracking state, and implement divergence protection. Simplify rules and docs commands to match their filesystem-first design.

### Command restructure

Move skill commands under a `skills` subcommand. Simplify rules to `list` + `sync`, docs to `list` + `add` (project-level) + `sync`. Drop `config edit`.

- [ ] Create `rei skills` parent command with subcommands: `init`, `validate`, `add`, `list`, `activate`, `deactivate`, `pull`, `sync`, `status`, `updates`
- [ ] Move existing top-level skill commands (`init`, `validate`, `add`, `list`, `activate`, `deactivate`) under `rei skills`
- [ ] Keep `rei sync` as a top-level convenience that syncs all three domains
- [ ] `rei skills sync` syncs skills only, `rei rules sync` syncs rules only, `rei docs sync` syncs docs only
- [ ] Remove `--rules-only`, `--skills-only`, `--docs-only` flags from top-level sync (replaced by domain-specific commands)
- [ ] `rei skills pull` replaces old upstream fetch behavior from `rei sync`
- [ ] `rei skills status` replaces `rei sync --status`
- [ ] `rei skills updates` replaces top-level `rei updates` (`--pull` replaces `--sync`)
- [ ] Simplify `rei rules` to just `list` and `sync` — remove `add`, `remove`, `validate` (users manage files directly)
- [ ] Simplify `rei docs` to `list`, `add` (project-level: creates dir + config entry), `remove` (project-level: two-step confirmation — remove config entry, then optionally delete docs dir), and `sync` — remove fragment-level `add`/`remove` and standalone `compile`
- [ ] `rei docs sync --stdout` replaces `rei docs compile --stdout` for index preview
- [ ] Remove `rei config edit` and its `--allow-run` permissions
- [ ] Update completions to reflect new command tree
- [ ] Update all tests for new command paths
- [ ] Maintain short aliases where helpful (`rei skills ls`, `rei skills on/off`, etc.)

### Introduce lockfile

Extract tracking state from `config.toml` into `reishi-lock.toml`. Config stays pure configuration; lockfile holds per-skill upstream state.

- [ ] Define lockfile schema type in `config.ts` (per-skill: `source_url`, `subpath`, `ref`, `sha`, `synced_at`, `prefix`)
- [ ] Write `loadLockfile()` / `saveLockfile()` alongside existing config functions
- [ ] Migrate: `rei skills add -t` writes to lockfile instead of `[skills.*]` in config
- [ ] Migrate: all code reading `config.skills[name].source_url` reads from lockfile instead
- [ ] Keep per-skill *config* overrides (`sync_method`, `targets`) in `config.toml` under `[skills.<name>]`
- [ ] `initConfig` creates empty lockfile alongside config, and pre-creates `_deactivated/` subdir under `paths.source`
- [ ] Tests: lockfile round-trip, migration from config entries, lockfile + config coexistence

### Split `sync` and `pull`

`sync` = local distribution (source → targets). `pull` = upstream fetch (GitHub → source).

- [ ] Extract upstream fetch logic from `syncSkill` into a new `pullSkill` function
- [ ] `rei skills pull [skill-name]` command: fetch upstream for tracked skills, with divergence protection, then auto-sync
- [ ] `rei skills pull --dry-run` previews without writing
- [ ] `rei sync` no longer does upstream fetch — purely local distribution
- [ ] Remove `--no-fetch` and `--force` flags from `sync` (no longer applicable)
- [ ] `rei skills updates --pull` replaces `rei updates --sync`
- [ ] Auto-sync triggers (`add`, `activate`, `deactivate`, `init`) remain sync-only (no pull)
- [ ] `pull` auto-syncs after completing upstream fetch
- [ ] Tests: pull fetches and syncs, sync never fetches, auto-sync triggers don't pull

### SHA-based upstream freshness

Replace mtime-based staleness with SHA comparison against GitHub API.

- [ ] On `rei skills pull`: `GET /repos/{owner}/{repo}/commits/{ref}` (single lightweight call) to get HEAD SHA
- [ ] Compare against `sha` in lockfile — skip download if unchanged
- [ ] On successful pull: update `sha` and `synced_at` in lockfile
- [ ] `rei skills status` uses lockfile `sha` + `synced_at` for stale/diverged reporting
- [ ] `checkForUpdates` uses the same SHA comparison, wired to lockfile (dirty-bit: only write lockfile when state actually changed)
- [ ] Tests: SHA match skips fetch, SHA mismatch triggers fetch, lockfile updated after pull

### Divergence protection

When pulling upstream content, protect locally modified files.

- [ ] Per-file divergence check: compare file mtime against `synced_at` in lockfile
- [ ] Unchanged files (mtime <= synced_at): overwrite with upstream version
- [ ] Diverged files (mtime > synced_at): keep user's version, save upstream as `<name>_1.md` (or `_2`, `_3`, etc.)
- [ ] Suffix incrementing: scan for existing `_N` files and pick the next available number
- [ ] Print a summary of protected files after pull so user knows what to review
- [ ] Remove the `--force` flag and `promptYesNo` for local modifications (no longer needed)
- [ ] Remove the injectable `promptYesNo` / `promptChoice` from `SyncOptions` (pull doesn't need interactive prompts for local mods)
- [ ] Keep injectable prompts for prefix-change flow only (still interactive)
- [ ] Tests: unchanged files overwritten, diverged files protected with suffix, suffix increments correctly, summary printed

### Clean up sync status

Align `syncStatus` and `printStatus` with the new model.

- [ ] `stale` = lockfile SHA differs from upstream HEAD SHA (requires optional network check)
- [ ] `diverged` = source files have mtimes newer than `synced_at` in lockfile
- [ ] For `--status` without network: report based on lockfile state only (last known SHA, synced_at)
- [ ] Remove `maxMtime` / old mtime-comparison code (already partially done)
- [ ] Tests: status reports from lockfile state, diverged detection from source mtimes

### Dead code cleanup

Remove dead code and commands being retired in the restructure.

- [ ] Drop `void rulesDir` reservation in `rules.ts:266`
- [ ] Drop unused `printDocsSyncSummary` in `docs.ts`
- [ ] Drop unused `getRulesSourceDir` import in `reishi.ts`
- [ ] Remove `addRule`, `removeRule`, `validateRules` functions from `rules.ts`
- [ ] Remove `addFragment`, `removeFragment` functions from `docs.ts`
- [ ] Remove `config edit` command and related `--allow-run` permissions from `reishi.ts` and `deno.json`

## Backlog

- [ ] `rei upgrade` — self-update mechanism
- [ ] `rei export` — export current config + tracked skills as a shareable bundle
- [ ] `rei import` — import a shared bundle to bootstrap a new machine
- [ ] Skill dependency graph — skills that reference other skills
- [ ] Conflict detection — warn when two skills have overlapping tool permissions or trigger conditions
- [ ] Web UI — local server for browsing and managing skills visually
