# reishi TODO

## Phase 7: Command Restructure, Sync/Pull Split, and Lockfile 🌀

Overhaul of the first-pass v1 work: introduce a lockfile to separate config from tracking state, restructure commands under domain subgroups, split network (`pull`) from local (`sync`), replace mtime-based upstream staleness with SHA comparison, and protect locally modified files during pulls. Nothing has shipped, so we make the breaking changes we want.

The objectives below are mostly sequential — later work reads state written by earlier work, so treat this as a single-agent pass rather than a parallelizable phase. Conceptual model lives in `AGENTS.md`; implementation needs to catch up to it.

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
