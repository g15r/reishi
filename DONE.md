# Completed Work Log

## Phase 15: `clean_on_sync` orphan cleanup ✅
**Requirements**: sy-R070, sy-R071, sy-R072, sy-R073, sy-R074

Opt-in orphan cleanup for skills and rules targets. New `clean_on_sync_test.ts` suite (7 tests) covers both kinds, symlink-skipping, compile-artifact exclusion, agent filtering, and `cleanOrphans` deletion semantics.

- [x] `clean_on_sync` boolean added to `ConfigSchema` (default false). Lives top-level alongside `sync_method`.
- [x] `findOrphans(filterAgents?)` walks every configured agent's `skills` and `rules` paths and reports entries that exist in the target but not in source. Symlinks are skipped — they self-resolve when source moves or is deleted, so they're never orphans. Deactivated skills count as orphans (the active source set is the contract).
- [x] The compile artifact (`<compile_root>/<compile_file>`) is excluded from the rules orphan walk so opt-in agents don't see it flagged.
- [x] `rei sync` calls a new `runOrphanCleanup` after the per-domain syncs when `clean_on_sync = true`. Single batched Y/N prompt: `clean up 🧼: remove A, B, and C? (Y/n)`. `--dry-run` skips the prompt and prints `would remove ...` instead. Default `Y` so the common case is one keystroke.
- [x] `cleanOrphans` is best-effort: failures are returned as `{ ok: false, reason }` rows rather than thrown, so one stuck path doesn't abort the rest.

Scope notes:

- Docs orphan cleanup was intentionally left out — `compileToTarget` already wipes the fragments dir before each write, so docs never accumulate orphans the way skills and rules can.
- Source-side `move`/`remove` (Phase 13) deliberately leave target dirs in place; `clean_on_sync = true` is the supported propagation path on the next sync.

## Phase 14: Two-step compile (rules + docs) ✅
**Requirements**: ru-R040, ru-R041, dc-R080, dc-R081, sy-R060, sy-R061, sy-R062, sy-R063, sy-R064

Compile now writes a source-side artifact that sync ships as-is — git-trackable, user-visible, and decoupled from the network-free sync engine. New `compile_phase14_test.ts` suite (12 tests) covers source artifact format, path-traversal rejection, source-then-ship semantics, and the compile-opt-in flow.

### Per-agent compile config

- [x] `[agents.<name>].compile`, `compile_root`, `compile_file` keys added to `AgentConfig`. Defaults: `compile = false`; when true, `compile_root` defaults to `dirname(rules)` and `compile_file` defaults to `AGENTS.md`. `compile_file` is resolved relative to `compile_root` and rejected (with a clear error) if it escapes the root via `..` or absolute paths outside it.

### Compile commands

- [x] `rei rules compile` — concatenates every rule fragment under `<rules.source>` into `<rules.source>/AGENTS.md` (constant `COMPILED_RULES_FILENAME`). The artifact itself is excluded from the input set so re-running is idempotent. Format: `# Agent rules` header, one `## <name>` section per fragment with body inlined; directories of `.md` files are flattened to `## <dir>/<file>` sections.
- [x] `rei docs compile [project]` — writes `<docs.source>/<project>/<index_filename>` from the existing `compileIndex` output. With no project arg, compiles every project under `<docs.source>`.

### Sync integration

- [x] `syncRules` now runs `compileRules()` automatically when any participating agent has `compile = true`, then ships the source artifact (copy or symlink, per resolved method) to each opt-in agent's `<compile_root>/<compile_file>`. Failures (path traversal, missing parent) are returned as `(compile)` rows in the sync result instead of aborting the whole run.
- [x] `compileToTarget` (docs sync path) refactored to write the index to source first, then copy or symlink that source artifact to `<target>/<index_filename>`. Behavior change is invisible to existing tests — the target still ends up with the same content — but the source is now the durable home of the artifact.

## Phase 13: Source-side CRUD — `move` and `remove` ✅
**Requirements**: sk-R090, sk-R091, sk-R093, ru-R030, ru-R031, ru-R032, ru-R033, dc-R070, dc-R071, dc-R072, dc-R073

Filled the CRUD gap on source fragments across all three domains. Source-only — target cleanup deferred to Phase 15 (`clean_on_sync`). New `stripMdSuffix` helper exported from both `rules.ts` and `docs.ts` so callers may pass `foo` or `foo.md`. New `move_remove_test.ts` suite (18 tests) covers happy paths, suffix flexibility, refusal to clobber, and lockfile/skill_overrides side-effects.

### `move` / `mv`

- [x] `rei rules move <old> <new>` — flat namespace: rename `<rules.source>/<old>.md` → `<new>.md`
- [x] `rei docs move <project> <old> <new>` — rename `<docs.source>/<project>/<old>.md` → `<new>.md`; rewrites `[projects.<name>].fragments` in place when the array references the old basename
- [x] `rei skills move <old> <new>` — rename source dir, rekey lockfile entry, rekey `[skill_overrides.<name>]` if present
  - Source-only: deactivated dirs and target dirs are intentionally left alone — Phase 15's `clean_on_sync` propagates the rename to copy targets on next sync; symlinks self-resolve

### `remove` / `rm`

- [x] `rei rules remove <name>` — delete `<rules.source>/<name>.md`
- [x] `rei docs remove <project> <fragment>` — fragment-level delete; prunes any matching entry from `[projects.<name>].fragments`
- [x] `rei skills remove <name>` — delete source dir, drop lockfile entry, drop `[skill_overrides.<name>]`

## Phase 12: `config link` parity with `unlink` ✅

Moved agent and project adds under `config link`, mirroring the existing `config unlink` namespace. New `linkAgent` lives next to `unlinkAgent` in `config.ts`; `linkProject` reuses `addDocProject` (path normalization stays in `docs.ts`). `rei docs add` is kept as a deprecated alias that still writes the `[projects.*]` entry but prints a pointer to `rei config link project` on stderr.

### `config link` subcommand

- [x] `rei config link agent <name> --skills <path> --rules <path>` — write `[agents.<name>]` with the two path keys
  - Rejects the reserved `shared` name (use `include_shared_agent`)
  - Refuses to overwrite an existing entry without `--force`
- [x] `rei config link project <name> --target <path>` — normalize the path the same way `docs add` does, write `[projects.<name>]`
  - Wraps `addDocProject` so source-dir creation + `~/`-condensing carry over unchanged
- [x] Update or alias the existing `rei docs add` to point at the new home; deprecation message if aliasing
  - Aliased: still functional, but help text and runtime stderr now point at `rei config link project`

## Phase 11: Open Source Documentation ✅

Three parallel deliverables — README, SECURITY, CONTRIBUTING + LICENSE — written for the public-facing OSS launch. All use Phase 9 canonical vocabulary.

### README

- [x] Audit the existing README: identify what's accurate, what's stale, and what's missing (no prior README existed; created from scratch)
- [x] Draft a structure with ToC: install, core concepts, quick start, key commands, blessed patterns, philosophy
- [x] Write the README — concise prose, tables for reference material, callouts for important notes
- [x] Add an Issues vs. Discussions section: prefer Discussions for ideas and questions; Issues only when a concrete, reproducible change can be clearly described; note that poorly-formed Issues and PRs ignoring contribution guidelines will be auto-closed — frame this warmly as care for a healthy OSS ecosystem, not gatekeeping
- [x] Secondary pass focused on information order: most important first, reference material last; verify all anchor links

### SECURITY.md

Formal but minimal — reishi reads and writes markdown files and a TOML config; the main risk is users accidentally putting secrets in agent context files. Belt-and-suspenders coverage for an OSS project.

- [x] Write a brief threat model: the real risk is user error (secrets in fragments), not attack surface in the tool itself
- [x] Note the one meaningful vector: remote skill sources (users should only pull from remotes they trust)
- [x] Add vulnerability reporting instructions (GitHub private advisory or email) and expected response timeline

### CONTRIBUTING.md and LICENSE

- [x] Add Apache 2.0 `LICENSE` file
- [x] Write `CONTRIBUTING.md` with sections: getting started, commit style (conventional commits enforced by CI), linear-history requirement, PR process and triage for new contributors, PR title style for squash/rebase merges, Issues vs. Discussions guidance, design principles and anti-goals

## Phase 10: Config UX ✅

Shipped a friendly, well-commented default config plus an escape hatch for users who want it clean.

### Documented default config

- [x] Draft a commented config template written for a brand-new user reading it for the first time
- [x] Update `config init` to output the commented template by default
- [x] Use canonical vocabulary from Phase 9 throughout all comments

### `--no-comment` flag for `config init`

- [x] Write failing tests for `-c`/`--no-comment` flag behavior
- [x] Implement `-c`/`--no-comment` flag that outputs a clean, comment-free config

## Phase 9: Vocabulary and Shared Agent ✅

Two parallel foundations for the v1 release: locking down canonical terminology before writing any docs, and adding the `shared` built-in target.

### Establish canonical vocabulary

Defined and propagated consistent language across all CLI output and docs. Core glossary: **fragments** (any individual markdown file reishi manages), **targets** (agents and projects collectively), **source** (`~/.config/reishi/` — where users work), **remotes** (where tracked skills are pulled from), **sync** (writing fragments from source to targets), **pull** (fetching from a remote).

- [x] Write a terminology reference doc at `~/.agents/docs/reishi-vocabulary.md` for use in future sessions
- [x] Audit existing CLI help text and agent-facing docs for non-canonical terms
- [x] Update help text, error messages, and agent docs to use canonical terms throughout

### Implement `shared` agent target

`shared` is a built-in, non-configurable agent target that always points to `~/.agents/`. Users opt in via `include_shared_agent: true` in their config. Set to `true` by default in `config init` output.

- [x] Write failing tests for `shared` as a built-in target at `~/.agents/` with no configurable path
- [x] Add `include_shared_agent` boolean to the config schema
- [x] Update sync logic to include `~/.agents/` when `include_shared_agent` is `true`
- [x] Set `include_shared_agent = true` explicitly in the `config init` default output

## Phase 8: Naming Clarity, Cross-Domain Consistency, and Cleanup ✅

Unified the CLI vocabulary across all three domains (skills, rules, docs). Introduced **agents** (named destinations grouping skills + rules paths) and **projects** (named destinations for docs) as first-class config concepts. Folded standalone inspection commands into `--check` flags. Removed dead code and vestigial permissions.

### Config restructure and shared types

- [x] Replaced `PathsConfig` with `SkillsConfig { source }` — skills source now at `[skills].source`
- [x] Replaced `[paths.targets]` and `[rules.targets]` with `[agents.<name>]` tables, each containing `skills` and `rules` path keys
- [x] Renamed `DocsProjectEntry.target` to `DocsProjectEntry.path`
- [x] Promoted `[docs.projects.*]` to top-level `[projects.*]` tables
- [x] Per-skill `SkillEntry.targets` became `SkillEntry.agents`; per-skill overrides moved to `[skill_overrides.<name>]`
- [x] Defined base types: `SyncTarget`, `AgentTarget`, `ProjectTarget`, `BaseSyncOptions`
- [x] Updated all config consumers: `syncSkill`, `syncAll`, `syncRules`, `syncDocs`, `pullSkill`, `pullAll`, `checkForUpdates`, `syncStatus`, `renameSkillEverywhere`
- [x] Updated `defaultConfig()`, `STARTER_TEMPLATE`, `initConfig()` for new structure
- [x] Updated `paths.ts` to read `config.skills.source`
- [x] Added `resolveSkillTargets` and `resolveRuleTargets` (replacing the unified `resolveTargets`) to extract per-domain paths from agent configs
- [x] Rules sync now uses `buildSyncOptions` instead of inline flag parsing (DRY)

### CLI flag rename

- [x] `--targets` → `--agents` on `rei skills sync`, `rei skills pull`, `rei rules sync`, `rei sync`
- [x] `buildSyncOptions` parses `--agents` instead of `--targets`

### Fold status and updates into --check

- [x] Added `--check` flag to `rei skills sync` — runs `syncStatus()` without writing
- [x] Added `--check` flag to `rei skills pull` — runs `checkForUpdates()` without fetching
- [x] Removed `rei skills status` and `rei skills updates` subcommands
- [x] Removed `maybeNotifyOfUpdates` fire-and-forget calls from `list`, `config show`, `validate`

### Remove --prefix-change from sync

- [x] Removed `--prefix-change` from `rei skills sync` and `rei sync` (kept on `pull`)
- [x] Sync handlers strip `prefixChange` before forwarding to sync functions

### Remove refresh-docs and dead permissions

- [x] Removed `refreshDocs()`, `DOC_SOURCES`, and the `refresh-docs` CLI command
- [x] Removed `code.claude.com`, `platform.claude.com` from `--allow-net` (shebang, deno.json, compile-all.sh)
- [x] Removed `EDITOR` from `--allow-env` (shebang, deno.json, compile-all.sh, test env strings)

### AGENTS.md and tests

- [x] Updated AGENTS.md: command structure, config schema, core concepts, examples
- [x] Updated all 11 test files for new config structure and flag names

## Phase 7: Command Restructure, Sync/Pull Split, and Lockfile ✅

### Dead code cleanup

Removed functions, types, and helpers that the rest of Phase 7 made dead. Also narrowed `--allow-run` now that `config edit` is gone.

- [x] Removed `addRule`, `addRuleFromLocal`, `addRuleFromUrl`, `addRuleFromGithubTree`, `refuseOverwrite`, `removeRule`, `unsyncRule`, `validateRules` from `rules.ts`; dropped `AddRuleOptions`, `RuleValidationIssue`, `RuleValidationResult` types; dropped the `void rulesDir` reservation (it lived inside `removeRule`); trimmed unused imports (`basename`, `extname`, `HttpFetcher`)
- [x] Removed `addFragment`, `addFragmentFromLocal`, `addFragmentFromUrl`, `addFragmentFromGithubTree`, `refuseOverwrite`, `removeFragment`, `printDocsSyncSummary` from `docs.ts`; dropped `AddFragmentOptions` type; trimmed unused imports (`basename`, `HttpFetcher`)
- [x] Dropped unused `getRulesSourceDir` import in `reishi.ts` (dropped during the command restructure; verified no other consumer)
- [x] Narrowed `--allow-run` to `--allow-run=tar` in `deno.json` (every subcommand) and the `reishi.ts` shebang — only `tar` is spawned at runtime now (`config edit` was the only other subprocess caller and it's gone)
- [x] Trimmed test files: removed add/remove/validate tests from `rules_test.ts`; removed add/remove fragment tests from `docs_test.ts`; inlined the rule-fixture setup in `sync_integration_test.ts` to a direct `Deno.copyFile` (no dependency on the deleted `addRule`); swapped the `removeFragment` call in the `compileToTarget: re-compile clears stale fragments` test for a direct `Deno.remove`

### Simplify status

`rei skills status` stays purely local — no network, no SHA comparisons. The mental model shifted: `stale` now means the target is out of date relative to the source (not "upstream moved"), and `diverged` means the user edited the source since the last pull. Upstream-change reporting lives in `rei skills pull --dry-run` and `rei skills updates`.

- [x] `syncStatus` re-written: `stale = sourceMtime > targetMtime`, `diverged = sourceMtime > synced_at`; still no network calls
- [x] Symlinks always report `stale: false` and `diverged: false` (they *are* the source)
- [x] Untracked skills (no lockfile entry / no `synced_at`) are never diverged
- [x] Doc comments on `SkillStatus` and `syncStatus` rewritten to describe the new semantics
- [x] Status tests in `sync_test.ts` rewritten for the new mental model: `status fresh`, `status stale: source newer than target`, `status diverged: source edited since last pull`, `status stale + diverged`; the old "target edited directly" scenario is gone — targets are output in this model
- [x] Factored out a shared `backdateTree(root, when)` helper inside `sync_test.ts` to DRY up the mtime-manipulation setup across status tests

### Divergence protection

Replaced the prompt-driven local-modification check with an automatic per-file merge. Pull is now always safe: locally-edited files are preserved in place, and the upstream version is saved under a `_N` suffix so the user can diff and resolve at their leisure.

- [x] Added `mergeUpstreamIntoSource(skillDir, upstreamDir, syncedAtMs)` in `sync.ts` that walks both trees and merges file-by-file
- [x] Unchanged files (`mtime <= synced_at`) are overwritten with upstream; diverged files (`mtime > synced_at`) are preserved and the upstream version is saved as `<stem>_<N><ext>` (e.g. `SKILL.md` → `SKILL_1.md`, then `_2`, `_3`, ...)
- [x] Upstream-deleted files are removed locally when the user hasn't touched them since `synced_at`; kept otherwise
- [x] `_N`-suffixed files themselves are not reconsidered for removal — they're user-facing artifacts, not user-created content
- [x] Added `nextSuffixedName(root, rel)` helper that scans for the next free `_N` number (up to 1000) before writing
- [x] Removed the local-modification prompt + `--force` flag; `force` dropped from `SyncOptions`; `--force` dropped from the CLI `skills pull` command and from `buildSyncOptions`
- [x] `promptYesNo` / `promptChoice` stay on `SyncOptions` — they're still used by the prefix-change flow, which keeps its interactive semantics
- [x] Pull prints a `🛡  Protected N locally-modified files:` summary with `original → upstream saved as savedAs` lines
- [x] `FetchUpstreamResult` gained an optional `protected: ProtectedFile[]` field so callers (and tests) can inspect what was preserved
- [x] Replaced the old `staging dir + atomic rename over skillDir` approach with the per-file merge (no more staging artifacts left on failure)
- [x] Tests: added `pull (diverged file): protects local, saves upstream as _1`, `pull (unchanged files): overwrites cleanly with upstream`, and `pull (multiple pulls over diverged files): suffix increments _1, _2, _3`; removed the four obsolete local-mod prompt/force tests

### SHA-based upstream freshness

`pullSkill` now probes the GitHub commits API for the remote HEAD SHA before downloading. When the lockfile's `sha` matches, the tarball fetch is skipped entirely. When it doesn't (or lockfile has no sha yet), the download runs and both `sha` and `synced_at` get written back on success.

- [x] Added `fetchRemoteSha(entry, fetcher)` helper in `sync.ts` that calls `GET /repos/{owner}/{repo}/commits/{ref}` and returns the SHA string (or null on any failure)
- [x] `fetchUpstreamForSkill` probes the remote SHA up front and short-circuits when it matches the lockfile's `sha` — no download, no tempfile, no tree hash. Honors dry-run.
- [x] On successful download, the lockfile gets updated with both the new `sha` and a fresh `synced_at`. The write only happens when state actually changed (content diff OR the SHA moved relative to what's stored) — dirty-bit semantics.
- [x] `checkForUpdates` already compares against lockfile `sha` from the earlier lockfile foundation commit; no change needed here.
- [x] Added `shaAwareFetcher(tarballPath, sha)` helper to `sync_fetch_test.ts` that dispatches commits-API URLs to a JSON `{sha}` response and archive URLs to the fixture tarball
- [x] Tests: SHA match skips fetch and leaves lockfile untouched; SHA mismatch downloads, overwrites source, and writes the new sha + synced_at

### Split `sync` and `pull`

`sync` is now strictly local (source → targets). `pull` is the network operation (GitHub → source) that auto-syncs afterward. Upstream fetching was previously entangled with `syncSkill` and exposed via a `fetchUpstream: boolean` option; the new model has two separate entry points.

- [x] Added `pullSkill(name, options)` and `pullAll(options)` in `sync.ts`; both compose prefix-change + fetch + auto-sync. Also added `PullOptions` (extends `SyncOptions` with an injectable `fetcher`) and `PullSkillResult` ({ fetch, sync }).
- [x] Removed `fetchUpstream` (and `fetcher`) from `SyncOptions`; `syncSkill` no longer hits the network under any option
- [x] Prefix-change detection moved to run *before* the fetch in `pullSkill`, so `parallel` mode actually populates the new-name dir instead of fetching into the stale old-name dir and leaving the new-name empty
- [x] `rei skills pull [name]` — with no arg, pulls all tracked skills; with an arg, just that one
- [x] `rei skills pull --dry-run` previews upstream diff (fetch side) without writing; auto-sync is skipped on dry-run
- [x] Removed `--no-fetch` and `--force` from the top-level `rei sync`; `--prefix-change` also removed from top-level (pull is the right place for that)
- [x] `rei skills updates --pull` replaced the old `rei updates --sync`; uses `pullSkill` directly
- [x] Auto-sync triggers (`skills add`, `skills activate`, `skills new`, etc.) call `syncSkill(name)` with no options; `syncAndReport` no longer passes `fetchUpstream: false` (trivially true now)
- [x] Added `printPullSummary()` helper in `reishi.ts` for the compound fetch+sync output
- [x] Tests: fetch-related cases moved from `syncSkill` to `pullSkill` in `sync_fetch_test.ts` and `sync_prefix_test.ts`; the old `--no-fetch` test became a simpler "sync never hits network" invariant check; integration tests dropped `--no-fetch`

### Command restructure

Moved skill commands under `rei skills`, renamed the skill scaffold from `init` to `new`, simplified rules and docs to match the filesystem-first design, and dropped `config edit`. Hard break — no top-level aliases for moved skill commands.

- [x] Created `rei skills` parent with subcommands: `new`, `validate`, `add`, `list`, `activate`, `deactivate`, `sync`, `pull`, `status`, `updates` (pull currently wraps syncSkill with fetch on; split into a dedicated `pullSkill` happens in the next objective)
- [x] Renamed the skill scaffold command from `init` to `new` (config init stays)
- [x] Moved existing top-level skill commands under `rei skills`; top-level aliases removed
- [x] `rei sync` is now strictly top-level cross-domain convenience (skills + rules + docs); no more positional `[skill-name]` arg, no `--*-only` flags, no `--status`
- [x] `rei skills sync` / `rei rules sync` / `rei docs sync` each sync their own domain only
- [x] Simplified `rei rules` to `list` and `sync`; retired `add`, `remove`, `validate` subcommands (users manage files directly)
- [x] Simplified `rei docs` to `list`, `add` (project-level: creates dir + config entry), `remove` (project-level with two-step confirmation — config entry first, then optionally the source dir), and `sync`; dropped fragment-level `add`/`remove` and the standalone `compile` subcommand
- [x] `rei docs sync [project] --stdout` replaces `rei docs compile --stdout` for index preview; added `stdout` flag to `syncDocs` / `DocsSyncOptions`
- [x] Added project-level helpers `addDocProject(name, options)` and `removeDocProject(name, options)` in `docs.ts`
- [x] Removed `rei config edit` subcommand and `configEdit` helper; added a tiny `promptYesNoCli` in `reishi.ts` for the docs-remove two-step confirmation
- [x] Short aliases preserved where useful (`skills ls`, `skills on`/`off`, `skills a`, `docs ls`/`rm`, `rules ls`)
- [x] Updated completions (implicit — Cliffy regenerates from the command tree) and verified via `cli_test.ts`
- [x] Reconciled `AGENTS.md` with actual commands (`skills new`, `skills deactivate` in auto-sync list)
- [x] Updated CLI tests: `cli_test.ts` now drives `skills new` / `skills validate`, `sync_integration_test.ts` calls `skills sync` / `rules sync`, `compile_test.ts` uses the compiled-binary `skills new` path
- [x] Factored out a `buildSyncOptions(options)` helper so `skills sync`, `skills pull`, and top-level `sync` share flag parsing for `--targets` / `--method` / `--dry-run` / `--no-fetch` / `--force` / `--prefix-change`

### Lockfile foundation

Extracted tracking state from `config.toml` into `reishi-lock.toml` alongside the config file. Config now holds only user preferences; the lockfile holds machine-managed upstream state.

- [x] Defined `SkillLockEntry` + `LockfileSchema` types in `config.ts` (per-skill: `source_url`, `subpath`, `ref`, `sha`, `synced_at`, `prefix`)
- [x] Added `loadLockfile()` / `saveLockfile()` alongside existing config functions; default path `~/.config/reishi/reishi-lock.toml`, override via `REISHI_LOCKFILE` mirroring `REISHI_CONFIG` semantics
- [x] Slimmed `SkillEntry` in `config.ts` down to user overrides only (`sync_method`, `targets`, `updates`); tracking fields (`source_url`, `subpath`, `ref`, `synced_at`, `prefix`, `remote_hash`, `last_check`) dropped
- [x] Updated every caller (`syncSkill`, `syncStatus`, `fetchUpstream`, `fetchUpstreamForSkill`, `maybeApplyPrefixChange`, `rekeySkillEntry`, `dupeSkillEntry`, `checkForUpdates`) to read/write the lockfile instead of `config.skills[name]`
- [x] `rei skills add -t` (via `trackSkill`) writes to the lockfile, not the config
- [x] `initConfig` creates an empty lockfile alongside config and pre-creates `_deactivated/` under `paths.source`. Idempotent: creates only what's missing on re-run.
- [x] Added `REISHI_LOCKFILE` to every `--allow-env` list (deno.json, reishi.ts shebang, subprocess spawns in integration/cli tests)
- [x] Tests: lockfile round-trip, `REISHI_LOCKFILE` override honored, `initConfig` idempotency, and every pre-existing test that referenced tracking fields on the config now reads from the lockfile (`test-helpers.ts` exposes `lockfilePath`, each test file got a local `readLockfile`/`writeLockfile` helper where needed)
- [x] `checkForUpdates` is now a pure read — reports hasUpdate/remoteSha/previousSha from lockfile + remote, no longer writes. `sha` in the lockfile only advances on a real pull.

Note: renaming `SkillEntry` remained in place for the config type rather than introducing `SkillConfigEntry`, to keep the diff narrow. The field semantics changed; the name stayed.

## Phase 6: Docs Management ✅

### Project-scoped doc fragments

Docs are organized by project subdirectory under `docs.source` and compiled into a token-efficient index for each project.

- [x] Define docs directory structure: `~/.config/reishi/docs/<project-name>/<fragment>.md`
- [x] `rei docs list [project]` — list all doc projects, or fragments within a project
- [x] `rei docs add <project> <path-or-url>` — add a doc fragment to a project's collection
- [x] `rei docs remove <project> <fragment>` — remove a fragment
- [x] Tests: directory structure creation, add/remove/list operations

### Index compilation

Compile doc fragments into a single token-efficient AGENTS.md index file for a project.

- [x] Write `compileIndex(projectName, targetDir)` — reads all fragments, generates a markdown index with relative links to the fragments
- [x] Index format: heading per fragment, one-line description (from frontmatter or first paragraph), and link to the full fragment
- [x] Keep index under a configurable token budget — prioritize by fragment ordering or explicit priority frontmatter
- [x] `rei docs compile <project> <target-dir>` — compile index and copy/symlink fragments to target (`--dry-run`, `--stdout`, `--method`)
- [x] The compiled index goes to `<target-dir>/<index_filename>` (default `AGENTS.md`)
- [x] Fragments go to `<target-dir>/<docs.default_target>/` (default `.agents/docs/`)
- [x] Tests: index contains all fragments, links resolve correctly, respects token budget, frontmatter priority ordering

### Docs sync and project mapping

- [x] Config mapping: `[docs.projects.<name>]` table with `target` path override and `fragments` list
- [x] `rei docs sync [project]` — compile and sync docs for one or all mapped projects (`--target`, `--method`, `--dry-run`)
- [x] Wire into `rei sync` for full-system sync (skills + rules + docs, with `--docs-only`)
- [x] Respect `sync_method` hierarchy (global > docs > CLI)
- [x] Tests: project mapping resolves correctly, sync compiles and distributes, sync_method overrides work

## Phase 5: Rules Management ✅

### Rules directory structure and sync

Rules are global, always-on markdown files that get symlinked/copied to agent rule paths at session start.

- [x] `rei rules list` — list all rules in `rules.source` directory
- [x] `rei rules add <path-or-url>` — add a rule file to the rules source directory
- [x] `rei rules remove <name>` — remove a rule from source and all targets
- [x] `rei rules sync` — sync all rules from source to configured `rules.targets`
- [x] Respect global `sync_method` with `rules.sync_method` override
- [x] Support both individual `.md` files and directories of rules
- [x] Tests: add/remove/list operations, sync to multiple targets, sync_method override, file vs directory handling

### Rules integration with existing workflow

- [x] Wire rules sync into `rei sync` (sync everything: skills + rules, with `--rules-only` / `--skills-only` to narrow)
- [x] `rei rules validate` — check rules files are valid markdown with no broken relative links
- [x] Tab completion for rule names via `globalComplete('rule-name', …)` consumed by `rei rules remove`
- [x] Tests: rules included in full sync, CLI flags wired, validation catches issues

## Phase 4: Sync Updates and Prefix Changes ✅

### `rei sync` for tracked skills

Pull latest from upstream for tracked skills and update the source of truth.

- [x] `rei sync [skill-name]` — re-fetch from `source_url` + `ref` + `subpath`, overwrite source, update `synced_at`
- [x] For multi-skill repos, sync pulls just the requested skill's subpath from the shared tarball
- [x] Dry-run mode: `rei sync --dry-run` previews upstream + target changes without writing
- [x] Diff preview: file-level summary (added, modified, removed) printed after fetch
- [x] Local-modification detection via mtime vs `synced_at`; `--force` bypasses the prompt
- [x] After source update, re-sync to all configured targets
- [x] `--no-fetch` bypass keeps Phase 3's pure target-sync behavior available
- [x] Auto-sync triggers (`add`, `activate`, `init`) opt out of the upstream fetch
- [x] Tests: sync updates source files, synced_at timestamp updates, dry-run makes no changes, local modification detection works (`sync_fetch_test.ts`)

### Prefix change detection

When a user changes the `prefix` in a skill's config entry, the next sync must handle the rename.

- [x] On sync, compare current directory name prefix against config `prefix` — detect mismatches
- [x] Prompt 1: "Prefix for X changed from 'readwiseio' to 'readwise'. Confirm?" (y/N)
- [x] Prompt 2 (on confirm): "Rename existing or install in parallel?" (r/p/N)
  - **Rename**: rename source dir + deactivated dir + every target dir, re-key the config table
  - **Parallel**: leave the old skill in place; new entry created and populated by the upstream fetch
- [x] Non-interactive `--prefix-change rename|parallel|abort` flag pre-decides the resolution
- [x] Dry-run preview shows the would-be rename without writing
- [x] Tests: rename + parallel + abort + dry-run + no-op (`sync_prefix_test.ts`)

### Update polling

Background check for upstream changes on tracked skills.

- [x] `checkForUpdates(skillName?)` — fetches the GitHub commits-API SHA for each tracked skill's `ref` and compares against stored `remote_hash`
- [x] `SkillEntry` extended with optional `last_check` (ISO) and `remote_hash` (SHA)
- [x] `rei updates [skill-name]` — manually trigger check, report which skills have upstream changes
- [x] `rei updates --sync` — check and immediately sync any that have changes (with upstream fetch enabled)
- [x] Configurable via `[updates]` table: `enabled`, `interval_hours`, `last_background_check`
- [x] Background check fires fire-and-forget on `rei list`, `rei sync`, `rei config show`, and `rei validate`; prints a one-liner if updates are available, never blocks
- [x] Per-skill override: `[skills.<name>] updates = false` disables polling for that skill
- [x] Tests: update check detects new upstream commits, respects interval, per-skill disable works, `[updates].enabled = false` disables all polling (`updates_test.ts`)

## Phase 3: Central Source of Truth and Target Sync ✅

### Source of truth migration

Move the canonical skill storage from the current hardcoded chezmoi path to the configurable `paths.source` (default `~/.config/reishi/skills/`). All other locations become sync targets.

- [x] Update `SKILLS_DIR` resolution to read from config `paths.source` instead of hardcoded path (new `paths.ts` module with `getSourceDir()` / `getDeactivatedDir()` resolvers)
- [x] Update `DEACTIVATED_SKILLS` to live under the new source path
- [x] `rei config init` creates the source directory
- [x] Tests: commands use config-driven source path via REISHI_CONFIG override
- ~~Backward-compat one-time chezmoi migration prompt~~ — deferred. Low value without a migration tool; users with existing chezmoi setups can keep chezmoi as a target. Revisit if needed.

### Target sync engine

Core engine for distributing skills from source to named targets.

- [x] Write `syncSkill(skillName, options)` — copies or symlinks a single skill from source to specified (or all) targets
- [x] Write `syncAll(options)` — syncs all active skills to targets (new module `sync.ts`)
- [x] Respect global `sync_method` with per-skill `sync_method` overrides winning (CLI `--method` beats both)
- [x] Respect per-skill `targets` list — if set, only sync to those named targets
- [x] Handle missing target directories: create the immediate target if parent exists; skip + warn if parent is missing
- [x] `rei sync [skill-name]` command with `--targets`, `--method`, `--dry-run`, `--status` flags
- [x] `rei sync --status` — show sync state (present / stale / symlink / missing) per skill × target
- [x] Helper `unsyncSkill(name)` for removing a skill from all targets (used by deactivate)
- [x] Tests: copy sync creates independent files, symlink sync creates valid symlinks, per-skill target filtering works, sync_method override hierarchy works, missing target handling, dry-run, status staleness

### Wire sync into existing commands

- [x] `add` command syncs to targets after installing to source (skipped when `--path` is outside source)
- [x] `activate` / `deactivate` syncs state change to targets (`deactivate` removes from every target)
- [x] `init` places new skill in source and syncs (only when `--path` resolves to source)
- [x] Tests: end-to-end add-then-verify-targets, custom `--path` does not propagate, multi-skill add syncs every skill, deactivate/activate round-trip (`sync_integration_test.ts`)

## Phase 2: Tracked Skills — `--track` and `--prefix` Flags ✅

### `--track` (`-t`) flag

When `rei add -t <url>` is used, reishi records metadata about the skill's origin so it can be synced later. Metadata is stored in the config file under `[skills.<name>]` tables.

- [x] Add `-t / --track` boolean flag to the `add` command
- [x] On tracked add: after successful install, write a `[skills.<name>]` entry to config with `source_url`, `synced_at` (ISO 8601), `ref` (branch/tag), and `prefix` (if used)
- [x] For multi-skill repos (e.g. readwise-skills), write one entry per skill, all sharing the same `source_url` but with individual `subpath` fields
- [x] Print tracking confirmation after install (source, sync time, config location)
- [x] Tests: tracked add writes correct config entries, multi-skill tracked add writes entries for each skill, untracked add does not write config entries
- [x] Tests: re-adding a tracked skill updates `synced_at` rather than duplicating the entry

### `--prefix` (`-p`) flag

Prefixes the GitHub org/user (or a custom value) to each skill name on install. `rei add -tp` on `readwiseio/readwise-skills` produces `readwiseio_book-review`, etc.

- [x] Add `-p / --prefix [value:string]` optional-value flag to the `add` command
- [x] When `-p` is used without a value, infer prefix from the GitHub URL's user/org segment
- [x] When `-p` is used with a value (e.g. `--prefix='readwise'`), use that value
- [x] Update skill name validation to allow the `prefix_separator` character (default `_`) when a prefix is present — the prefix portion and skill portion each independently pass current validation rules
- [x] Rename skill directories during install to `{prefix}{separator}{original_name}`
- [x] If `--track` is also active, record the `prefix` in the skill's config entry
- [x] Respect `default_prefix` and `prefix_separator` from global config
- [x] Tests: prefix inferred from URL org, prefix from explicit value, separator config respected, prefixed names pass validation, unprefixed names still reject `_`

### Per-skill config schema

```toml
[skills.readwiseio_book-review]
source_url = "https://github.com/readwiseio/readwise-skills"
subpath = "skills/book-review"
ref = "master"
prefix = "readwiseio"
synced_at = "2026-04-23T12:00:00Z"
# Per-skill overrides
sync_method = "symlink"
targets = ["claude"]  # only sync to these named targets (from [paths.targets])

[skills.readwiseio_readwise-cli]
source_url = "https://github.com/readwiseio/readwise-skills"
subpath = "skills/readwise-cli"
ref = "master"
prefix = "readwiseio"
synced_at = "2026-04-23T12:00:00Z"
```

### Test fixture setup

Build a fixture project that the full test suite can use across Phases 2-4. This is foundational scaffolding for test-driven development of all tracking, syncing, and update features.

- [x] Create a `test-fixtures/` directory with mock skill repos (single-skill and multi-skill layouts)
- [x] Create a mock GitHub tarball or local directory structure that `add` can consume without network calls
- [x] Write a test helper that sets up an isolated config dir, source dir, and target dirs in `$TMPDIR`
- [x] Ensure the fixture supports: tracked adds, prefixed adds, multi-skill repos, prefix changes, and sync operations
- [x] Integration tests: `rei add -tp <fixture-url>` produces correctly named and tracked skills in the temp config

## Phase 1: Config Foundation ✅

### Config file format and schema

TOML is the recommendation here. The project already uses `@std/yaml` for skill frontmatter, but TOML is purpose-built for configuration: it handles nested tables cleanly, has first-class comment support, avoids YAML's indentation pitfalls, and is the de facto standard for tool config (`Cargo.toml`, `pyproject.toml`, `ruff.toml`, etc.). Deno has `@std/toml` available on JSR.

Config lives at `~/.config/reishi/config.toml`.

- [x] Add `@std/toml` to imports
- [x] Define TypeScript types for the full config schema (see spec below)
- [x] Write `loadConfig()` — reads and parses `~/.config/reishi/config.toml`, returns typed config merged with defaults
- [x] Write `saveConfig()` — serializes and writes config back to disk
- [x] Write `initConfig()` — creates default config file and directories (`~/.config/reishi/skills/`, `rules/`) if they don't exist
- [x] Tests: config loading with defaults, partial config merging, missing file handling, invalid TOML errors, round-trip save/load fidelity

### Config CLI command

A `rei config` command for inspecting and modifying config from the terminal.

- [x] `rei config init` — runs `initConfig()`, creates default config and directories
- [x] `rei config show` — prints current effective config (merged with defaults)
- [x] `rei config path` — prints config file path
- [x] `rei config edit` — opens config in `$EDITOR`
- [x] Tests: each subcommand against a temp config dir

### Compile and Homebrew release

Establish `deno compile` as the build pipeline for producing single portable binaries, and wire it into a GitHub Actions release workflow for the Supermodel Labs Homebrew tap.

- [x] Add `deno task compile` to `deno.json` — compiles for the current platform with `--include assets/` to embed templates, output binary named `rei`
- [x] Add `deno task compile:all` — cross-compiles for all four targets via `scripts/compile-all.sh`, renames outputs to Homebrew-releaser's `{os}-{arch}` convention (`darwin-arm64`, `darwin-amd64`, `linux-arm64`, `linux-amd64`). Deno uses different target names (`aarch64-apple-darwin` = `darwin-arm64`, `x86_64-apple-darwin` = `darwin-amd64`, etc.); the script maps between them.
- [x] Verify embedded `assets/` templates resolve correctly at runtime from the compiled binary (fixed the underlying CWD-based asset path bug — templates now resolve relative to the script via `import.meta.dirname`)
- [x] Verify baked-in permission flags work as expected in the compiled binary (smoke tests exercise the binary's embedded shebang perms)
- [x] GitHub Actions release workflow (`.github/workflows/release.yml`): triggered on release publish, uses `denoland/setup-deno@v2`, runs `compile:all`, packages each binary as `reishi-{tag}-{os}-{arch}.tar.gz` with the binary renamed to `rei` inside the tarball, uploads via `gh release upload`.
- [x] Homebrew-releaser step (`Justintime50/homebrew-releaser@v3`): `homebrew_owner: supermodellabs`, `homebrew_tap: homebrew-tap`, `install: 'bin.install "rei"'`, all four `target_*` flags enabled, `update_readme_table: true`.
- [x] Tests: `compile_test.ts` runs `--help`, `--version`, `init`, and `validate` against the compiled `bin/rei` artifact (not `deno run`). Wired into `deno task test` via `deno task test:compile`. `add` is not covered because it requires live network to GitHub; that path is already exercised by the `deno run` suite.

### Config schema spec

```toml
# ~/.config/reishi/config.toml

# ----------------------------------------------------------
# Global defaults
# ----------------------------------------------------------

# How reishi distributes content to targets: "copy" or "symlink"
sync_method = "copy"

# Default prefix behavior when --prefix is used without a value
# "infer" = derive from GitHub org/user, "none" = no prefix
default_prefix = "infer"

# Separator between prefix and skill name
prefix_separator = "_"

# ----------------------------------------------------------
# Paths
# ----------------------------------------------------------

[paths]
# Central source of truth — single canonical location for all managed content.
# All synced skills, rules, and docs land here first.
source = "~/.config/reishi/skills"

# Named sync targets — reishi copies/symlinks from source to these.
# Keys are arbitrary names; values are paths.
[paths.targets]
claude = "~/.claude/skills"
# agents = "~/.agents/skills"
# chezmoi = "~/.local/share/chezmoi/dot_agents/skills"

# ----------------------------------------------------------
# Update polling
# ----------------------------------------------------------

[updates]
# Check tracked skills for upstream changes: true / false
enabled = true

# How often to check, in hours
interval_hours = 24

# ----------------------------------------------------------
# Rules
# ----------------------------------------------------------

[rules]
# Where reishi-managed rules live
source = "~/.config/reishi/rules"

# Sync method override for rules (inherits global sync_method if unset)
# sync_method = "symlink"

[rules.targets]
claude = "~/.claude/rules"
# opencode = "~/.opencode/rules"

# ----------------------------------------------------------
# Docs
# ----------------------------------------------------------

[docs]
# Where reishi-managed doc fragments live, organized by project subdirs
source = "~/.config/reishi/docs"

# Default target path relative to project root
default_target = ".agents/docs"

# Name of the compiled index file placed in the project root
index_filename = "AGENTS.md"

# Sync method override for docs
# sync_method = "symlink"
```

Per-skill overrides are stored in the `[skills.<name>]` table and documented in Phase 2.
