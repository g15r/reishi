# reishi TODO

## Phase 16: Compiled index core fragment
**Requirements**: dc-R090, dc-R091, dc-R092, dc-R093, dc-R094, dc-R095, dc-R096, cf-R011

### Compiler core-fragment detection and emission
- [ ] Detect filename match against `[docs].index_filename` (case-insensitive) when reading project fragments
- [ ] Strip frontmatter from core content before emission
- [ ] Exclude core fragment from the linked-fragments list
- [ ] Fail with a clear error on case-collision matches

### Compiled-output formatting
- [ ] Emit core content first, then `## Modular docs` heading, then linked-fragments list
- [ ] Apply token-budget trimming only to the linked-fragments section
- [ ] Preserve link-only output when no core fragment exists

### Core-size warning
- [ ] Add `[docs].core_warn_tokens` to `ConfigSchema` (default `4000`)
- [ ] Token-count the core fragment during compile and emit a soft warning above threshold
- [ ] Warning text invites modularization and includes the reishi progressive-disclosure docs link (placeholder until reishi-docs lands)

### Tests
- [ ] Unit: case-insensitive match, collision error, no-core fallback, frontmatter stripped
- [ ] Unit: token-budget trims links only, core always full
- [ ] Unit: warn fires above threshold, silent at and below

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

### Scoop scanner
- [ ] Implement default-pattern matcher across top-level files and recursive scoop dirs
- [ ] Read-only target traversal — never modify target during scan
- [ ] Return a structured list of `(source path → proposed fragment name)`

### Name flattening and collision handling
- [ ] Top-level: keep stem; nested: `<dir>-<stem>.md`
- [ ] Index-filename match preserved as-is so it lands as the core fragment
- [ ] Numeric suffixes for in-import name collisions

### Link-command integration
- [ ] Add `--import` and `--no-import` flags to `rei config link project`
- [ ] Mirror flags on the deprecated `rei docs add` alias
- [ ] Interactive prompt when files detected and source dir empty (use the existing injectable-callback pattern, R007)
- [ ] Print per-file summary on completion
- [ ] Backup target index file (delegate to the Phase 17 backup helper)
- [ ] Refuse import with a clear error when source dir already has fragments

### Tests
- [ ] Fixtures: heterogeneous source layouts (claude-only, cursor-only, mixed, AGENTS-only, none)
- [ ] Empty target → no prompt, link completes cleanly
- [ ] Non-empty source dir → import refuses with the right error
- [ ] Index-filename match → core fragment placed in source under exact filename
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

## Phase 20: Test-fixture reorg and `seed*` builders
**Requirements**: dev-R001, dev-R002, dev-R003, dev-R010, dev-R011, dev-R012, dev-R013, dev-R020, dev-R021, dev-R030

### Fixture bucket reorg
- [ ] Rename `test-fixtures/repos/` → `test-fixtures/remote-repos/` and update every callsite
- [ ] Create `test-fixtures/project-targets/` and seed it with the heterogeneous project-root layouts (claude-only, cursor-only, mixed, AGENTS-only, deeply nested, none-detected)
- [ ] Create `test-fixtures/project-sources/` with curated source dirs (skills + rules + docs) for compile/sync inputs
- [ ] Add `test-fixtures/README.md` explaining the three buckets — short, future-agent-readable

### `test-helpers.ts` builders
- [ ] Implement `copyFixtureToTemp(name)` returning an isolated mutable copy with `setupIsolatedEnv` cleanup
- [ ] Implement `seedProject`, `seedAgentTarget`, `seedSourceDir`, `seedRemoteRepo` — each takes a structured input object, writes to a temp dir, registers cleanup
- [ ] Implement `assertCompiledIndexMatches` (or equivalent) for compile/sync output assertions
- [ ] TSDoc each builder: inputs, outputs, cleanup contract
- [ ] Rewrite `fixturesPath` callsites and TSDoc to match the new vocabulary

### Test migration
- [ ] Migrate inline `makeTempDir` + `writeTextFile` scaffolding across the affected `*_test.ts` files to the `seed*` builders, file-by-file, keeping `deno task test` green at each step
- [ ] Audit and delete fixtures no `*_test.ts` references after migration

### Developer docs
- [ ] Add a "writing tests" section reachable from the repo root README or `docs/` covering the builder pattern and fixture vocabulary
