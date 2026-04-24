# reishi TODO

## Phase 7: Command Restructure, Sync/Pull Split, and Lockfile 🌀

Overhaul of the first-pass v1 work: introduce a lockfile to separate config from tracking state, restructure commands under domain subgroups, split network (`pull`) from local (`sync`), replace mtime-based upstream staleness with SHA comparison, and protect locally modified files during pulls. Nothing has shipped, so we make the breaking changes we want.

The objectives below are mostly sequential — later work reads state written by earlier work, so treat this as a single-agent pass rather than a parallelizable phase. Conceptual model lives in `AGENTS.md`; implementation needs to catch up to it.

### Split `sync` and `pull`

`sync` is local-only (source → targets). `pull` is the network operation (GitHub → source), then auto-syncs to targets.

- [ ] Extract upstream fetch logic from `syncSkill` into a public `pullSkill` function (the work in `fetchUpstreamForSkill` moves into this)
- [ ] `rei skills pull [skill-name]` — with no arg, pulls all tracked skills; with an arg, just that one
- [ ] `rei skills pull --dry-run` previews upstream changes and the subsequent sync without writing — this is how users preview "what would update"
- [ ] Remove upstream-fetch path from `rei sync` entirely
- [ ] Remove `--no-fetch` and `--force` flags from `sync` (no longer applicable)
- [ ] `rei skills updates --pull` replaces the old `rei updates --sync`
- [ ] Auto-sync triggers (`skills add`, `skills activate`, `skills deactivate`, `skills new`) remain sync-only — never pull
- [ ] `pull` auto-syncs to targets after a successful fetch
- [ ] Tests: pull fetches then syncs, sync never hits network, auto-sync triggers don't pull, `pull --dry-run` writes nothing

### SHA-based upstream freshness

Replace mtime-based upstream staleness with SHA comparison against GitHub.

- [ ] On `rei skills pull`: `GET /repos/{owner}/{repo}/commits/{ref}` (single lightweight call per skill) to get HEAD SHA
- [ ] Compare against lockfile `sha` — skip download if unchanged
- [ ] On successful pull: update `sha` and `synced_at` in lockfile
- [ ] `checkForUpdates` uses the same SHA comparison, wired to lockfile (dirty-bit write — only save lockfile when state actually changed)
- [ ] Tests: SHA match skips fetch, SHA mismatch triggers fetch, lockfile updated only after real pull

### Divergence protection

When pulling upstream content, protect locally modified files automatically. No prompts; pull is always safe.

- [ ] Per-file divergence check: compare file mtime against lockfile `synced_at`
- [ ] Unchanged files (mtime <= `synced_at`): overwrite with upstream version
- [ ] Diverged files (mtime > `synced_at`): keep user's version in place, write upstream version as `<name>_1.md` (or `_2`, `_3`, ...)
- [ ] Suffix incrementing: scan for existing `_N` files and pick the next available number
- [ ] Print a summary of protected files after pull so user knows what to review
- [ ] Remove the `--force` flag and the local-modification `promptYesNo` path entirely
- [ ] Remove `promptYesNo` / `promptChoice` from `SyncOptions` (no longer needed there)
- [ ] Keep injectable prompts for the prefix-change flow only (still interactive)
- [ ] Tests: unchanged files overwritten, diverged files preserved with suffix, suffix increments correctly, summary printed

### Simplify status

`rei skills status` becomes purely local — no network. Upstream-change reporting lives in `rei skills pull --dry-run` and `rei skills updates`.

- [ ] `syncStatus` / `printStatus` report from lockfile + filesystem state only (no HTTP calls)
- [ ] Categories: `fresh` (target matches source), `stale` (source newer than target — needs sync), `missing` (source or target absent), `symlink` (target is a symlink), `diverged` (source files newer than lockfile `synced_at` — informational, means local edits since last pull)
- [ ] Remove the upstream SHA-comparison path from `status` — it belongs in `pull --dry-run`
- [ ] Remove `maxMtime` and leftover mtime-vs-config-synced_at code
- [ ] Tests: status reports purely from lockfile + filesystem, no network calls made, diverged detection from source mtimes

### Dead code cleanup

Landing pad for code made dead by the above. Do this pass last so we don't delete things we end up needing.

- [ ] Drop `void rulesDir` reservation in `rules.ts`
- [ ] Drop unused `printDocsSyncSummary` in `docs.ts`
- [ ] Drop unused `getRulesSourceDir` import in `reishi.ts`
- [ ] Remove `addRule`, `removeRule`, `validateRules` functions from `rules.ts`
- [ ] Remove `addFragment`, `removeFragment` (fragment-level) from `docs.ts`
- [ ] Verify `--allow-run` is no longer needed anywhere after `config edit` is gone; remove from `deno.json`

## Backlog

- [ ] `rei upgrade` — self-update mechanism
- [ ] `rei export` — export current config + tracked skills as a shareable bundle
- [ ] `rei import` — import a shared bundle to bootstrap a new machine
- [ ] Skill dependency graph — skills that reference other skills
- [ ] Conflict detection — warn when two skills have overlapping tool permissions or trigger conditions
- [ ] Web UI — local server for browsing and managing skills visually
