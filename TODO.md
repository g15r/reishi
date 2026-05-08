# reishi TODO

## Phase 16: Compiled index core
**Requirements**: dc-R090, dc-R091, dc-R092, dc-R093, dc-R094, dc-R095, dc-R096, cf-R011, dev-R070

### Compiler index-core detection and emission
- [ ] Detect filename match against `[docs].index_filename` (case-insensitive) when reading project markdown files
- [ ] Strip frontmatter from index-core content before emission
- [ ] Exclude the index core from the references list
- [ ] Fail with a clear error on case-collision matches

### Compiled-output formatting
- [ ] Emit index-core content first, then `## References` heading, then references list
- [ ] Apply token-budget trimming only to the references section
- [ ] Preserve link-only output when no index core exists

### Core-size warning
- [ ] Add `[docs].core_warn_tokens` to `ConfigSchema` (default `4000`)
- [ ] Token-count the index core during compile and emit a soft warning above threshold
- [ ] Warning text invites modularization and includes the reishi progressive-disclosure docs link (placeholder until reishi-docs lands)

### Tests
- [ ] Unit: case-insensitive match, collision error, no-core fallback, frontmatter stripped
- [ ] Unit: token-budget trims references only, index core always full
- [ ] Unit: warn fires above threshold, silent at and below
- [ ] Snapshot (`@std/testing/snapshot`): compiled-index full output for {core-only, references-only, both, token-trimmed} fixtures — substring assertions remain only for one-line invariants

## Phase 17: Target overwrite protection
**Requirements**: dc-R100, dc-R101, dc-R102, dc-R103, dc-R104

### Marker emission
- [ ] Append the trailing reishi marker to compiled index output
- [ ] Marker references the project's source path

### First-sync backup
- [ ] Detect missing marker in existing target index before writing
- [ ] Copy to `<index>.reishi-backup` (or `_2`, `_3`, ... if a previous backup exists)
- [ ] Print `📦 backed up …` notice on backup write
- [ ] Skip backup when marker present (overwrite directly)

### Tests
- [ ] Backup fires when marker absent, skipped when present
- [ ] Numeric-suffix collision behavior on repeated first-syncs against fresh user files
- [ ] Notice text correctness

## Phase 18: Heterogeneous doc import on project link
**Requirements**: dc-R110, dc-R111, dc-R112, dc-R113, dc-R114, dc-R115, dc-R116, dc-R117, dc-R118, cf-R047

### Discovery scanner
- [ ] Implement default-pattern matcher across top-level files and recursive discovery dirs
- [ ] Read-only target traversal — never modify target during scan
- [ ] Return a structured list of `(source path → proposed file name)`

### Name flattening and collision handling
- [ ] Top-level: keep stem; nested: `<dir>-<stem>.md`
- [ ] Index-filename match preserved as-is so it lands as the index core
- [ ] Numeric suffixes for in-import name collisions

### Link-command integration
- [ ] Add `--import` and `--no-import` flags to `rei config link project`
- [ ] Mirror flags on the deprecated `rei docs add` alias
- [ ] Interactive prompt when files detected and source dir empty (use the existing injectable-callback pattern, R007)
- [ ] Print per-file summary on completion
- [ ] Backup target index file (delegate to the Phase 17 backup helper)
- [ ] Refuse import with a clear error when source dir already has docs

### Tests
- [ ] Fixtures: heterogeneous source layouts (claude-only, cursor-only, mixed, AGENTS-only, none)
- [ ] Empty target → no prompt, link completes cleanly
- [ ] Non-empty source dir → import refuses with the right error
- [ ] Index-filename match → index core placed in source under exact filename
- [ ] Backup writes the original target index before link completes
- [ ] `--no-import` and `--import` both bypass the interactive prompt

## Phase 19: Streamline `skills new` scaffold
**Requirements**: sk-R010, sk-R012, sk-R013

Scaffold today drops four files into a new skill (`SKILL.md`, `example-reference.md`, `scripts/example.ts`, `assets/example_asset.txt`). In practice the bottom three are deleted as step 1 ~90% of the time. Replace them with thorough in-template guidance so users add structure only when they actually need it. Also retire the `references/` subdirectory pattern — modular reference docs are now flat alongside `SKILL.md`.

### Template surface
- [ ] Delete `assets/example_asset.txt.tmpl`, `assets/example_script.ts.tmpl`, `assets/example_reference.md.tmpl` from the repo
- [ ] Rewrite `assets/SKILL.md.tmpl` so its layout guidance covers: flat modular reference markdown alongside `SKILL.md` (e.g. `cool-skill/api-design.md`), `scripts/` for executables, `assets/` for output artifacts — concrete examples from real skills, no "delete this section when done" boilerplate
- [ ] Purge every `references/` mention from `SKILL.md.tmpl` — the subdirectory pattern is retired
- [ ] Drop the embed entries for the removed templates from the template loader

### `rei skills new` scaffolder
- [ ] Stop creating `scripts/`, `assets/`, `example-reference.md`; only write `SKILL.md`
- [ ] Trim the post-scaffold "Next steps" output to match (no reference to deleted example files)
- [ ] Verify the binary build path: `deno task compile` followed by `rei skills new` produces the same single-file scaffold

### Tests
- [ ] Update `cli_test.ts` and `compile_test.ts` cases that assert the four-file layout to assert single-file `SKILL.md` only
- [ ] Add a case asserting no `scripts/` or `assets/` dir is created
- [ ] Confirm `rei skills validate` still passes against the new minimal scaffold

## Phase 21: Test harness solidification
**Requirements**: dev-R040, dev-R041, dev-R050, dev-R060, dev-R061, dev-R062

Phase 20 reorganised fixtures and added the `seed*` builders. Phase 21 finishes the harness story: pulls the duplicated per-file helpers into `test-helpers.ts`, finally migrates `cli_test.ts` (the largest remaining inline-scaffolding pocket), and lands the quality-of-life pieces — fake clock, URL-aware fetch fake, permissions-drift assertion.

### Centralize duplicated helpers
- [ ] Promote `withEnv`, `patchConfig`, `writeLockfile` from per-test files into `test-helpers.ts`; delete the per-file copies
- [ ] Add `runCli(env, args)` to `test-helpers.ts` — accepts an `IsolatedEnv`, inherits `PATH` / `DENO_DIR` / `XDG_CACHE_HOME` / `USER`, returns `{ code, stdout, stderr }`
- [ ] Replace per-file `runCli` reinventions (`sync_integration_test.ts`, `cli_test.ts`, etc.) with the shared helper

### Migrate `cli_test.ts`
- [ ] Convert per-test `Deno.makeTempDir` shapes to `setupIsolatedEnv` + the `seed*` builders, file section by file section, suite green at every step
- [ ] Drop the now-unused per-file scaffolding; idiosyncratic per-test shapes that don't fit a builder stay inline (mirrors dev-R021)

### Quality-of-life upgrades
- [ ] Refactor `sync.ts` (and any other module that calls `Date.now()` directly) to consume an injectable clock so a fake-now helper has somewhere to plug in
- [ ] Add `withFakeNow(env, fn)` to `test-helpers.ts`; replace `setTimeout`-based waits in `sync_fetch_test.ts` and elsewhere with deterministic time steps
- [ ] Replace or extend `fakeFetchGithub` with a URL-aware fake that distinguishes commits API, tarball download, and ref-resolution endpoints; assert expected endpoints in tests so wrong-endpoint regressions surface
- [ ] Add a permissions-drift test that asserts the compiled binary is invoked with the narrow `--allow-*` set R008 specifies; failures block the suite

## Phase 22: CI coverage signal
**Dependencies**: 21
**Requirements**: dev-R100, dev-R101

Re-examine CI now that the test harness is in better shape. Phase 21's helpers and migrations make the suite uniform enough that coverage numbers are meaningful — wire them into PR review.

### Coverage in CI
- [ ] Add `deno test --coverage` to the GitHub Actions workflow; emit the `coverage` profile as a workflow artifact
- [ ] Surface line and branch coverage on PRs (PR comment or status check) with deltas relative to the merge base
- [ ] Establish a baseline floor; PRs that drop below it fail the gate. Floor is bumped by maintainer decision, not auto-ratcheted
