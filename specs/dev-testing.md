# dev-testing — Test fixtures and harness

## Goals

`dev-` covers reishi's development-meta surface: tooling, harness, build/release, CI. `dev-testing` is the first slice — the test-fixture vocabulary, scaffolding helpers, and developer docs that keep red-green TDD viable as the project grows. The project has scaled past what the original ad-hoc scaffolding was designed for: 14 of 17 `*_test.ts` files build state inline via `makeTempDir` + `writeTextFile`, leading to ~6k lines of test code with heavy duplicated setup, and `test-fixtures/` has unclear naming where project-source samples and remote-repo samples sit as sibling top-level dirs.

**Non-goals.** No new test frameworks; no migration off Deno's built-in test runner; no CI changes (separate `dev-` domain when needed). Existing tests stay green throughout — this is a refactor of scaffolding, not a rewrite of coverage.

## Requirements

### Fixture layout

- **dev-R001** — `test-fixtures/` is organized into three purposeful top-level buckets: `remote-repos/` (renamed from current `repos/`, the GitHub-tarball fetch sources for `skills add` / `skills pull` tests), `project-targets/` (heterogeneous project-root layouts simulating real user repos: claude-only, cursor-only, mixed, AGENTS-only, deeply nested, none-detected), and `project-sources/` (curated reishi-source dirs — skills + rules + docs — used as compile/sync inputs).
- **dev-R002** — `test-fixtures/README.md` is the only doc-style README under `test-fixtures/`; it explains each top-level bucket in a short, future-agent-readable form.
- **dev-R003** — Any fixture file that no `*_test.ts` references after migration is deleted; dead fixtures are not preserved.

### `test-helpers.ts` builders

- **dev-R010** — `test-helpers.ts` exports a `copyFixtureToTemp(name)` helper that returns an isolated, mutable copy of an on-disk fixture under a temp dir, registered for cleanup with the existing `setupIsolatedEnv` hook.
- **dev-R011** — `test-helpers.ts` exports four `seed*` builders, each accepting a structured input object, writing to a temp dir, and registering cleanup with `setupIsolatedEnv`: `seedProject`, `seedAgentTarget`, `seedSourceDir`, `seedRemoteRepo`. Each builder ships with TSDoc that documents inputs, outputs, and the cleanup contract.
- **dev-R012** — `test-helpers.ts` exports an `assertCompiledIndexMatches` helper (or equivalent) so compile/sync tests stop hand-rolling string comparisons against compiled-index output.
- **dev-R013** — `fixturesPath` callsites and TSDoc are rewritten to match the new bucket vocabulary (`remote-repos/`, `project-targets/`, `project-sources/`) — no callsite still references the old `repos/` name.

### Test migration

- **dev-R020** — Inline `makeTempDir` + `writeTextFile` scaffolding across the affected `*_test.ts` files is migrated to the `seed*` builders. The migration is mechanical and file-by-file; the test suite stays green at every step (`deno task test` passes after each migration commit).
- **dev-R021** — Readability is the target, not a precise line-count delta — but inline scaffolding calls drop meaningfully across the migrated files (no remaining file should still hand-roll a project, agent target, source dir, or remote repo when a builder fits).

### Developer docs

- **dev-R030** — Developer docs include a "writing tests" section reachable from the repo root README or `docs/` that describes the builder pattern and fixture vocabulary, so future Phase subagents pick up the convention automatically.

### Centralized helpers

- **dev-R040** — `withEnv`, `patchConfig`, and `writeLockfile` (and any equivalent shapes reinvented across files) live in `test-helpers.ts` and are imported by every test that needs them; the per-file copies are removed.
- **dev-R041** — A single `runCli(env, args)` helper in `test-helpers.ts` replaces the per-file `runCli` reinventions; it accepts an `IsolatedEnv`, returns `{ code, stdout, stderr }`, and inherits the right pass-through env vars (`PATH`, `DENO_DIR`, `XDG_CACHE_HOME`, `USER`) automatically.

### `cli_test.ts` migration

- **dev-R050** — `cli_test.ts` is migrated off the per-test `Deno.makeTempDir` model onto `setupIsolatedEnv` + the `seed*` builders. Test suite stays green at every step (`deno task test` passes after each migration commit). Idiosyncratic per-test shapes that don't fit a builder are kept inline — the bar is "no remaining file hand-rolls a project, agent target, source dir, or remote repo when a builder fits" (mirrors dev-R021).

### Quality-of-life upgrades

- **dev-R060** — `test-helpers.ts` exports a `withFakeNow(env, fn)` (or equivalent) that lets tests advance `Date.now()` deterministically. `await new Promise((r) => setTimeout(r, …))` calls in the suite are replaced with explicit time steps. Requires `sync.ts` and any other module that calls `Date.now()` directly to consume an injectable clock.
- **dev-R061** — `fakeFetchGithub` is replaced (or extended) by a URL-aware fake that distinguishes the commits API, tarball download, and ref resolution endpoints, asserts the expected endpoints are hit, and surfaces wrong-endpoint regressions in tests rather than letting them pass silently.
- **dev-R062** — A test asserts the compiled binary is invoked with the narrow `--allow-*` set R008 specifies; permission drift fails the suite rather than slipping into a release.

### Snapshot testing

- **dev-R070** — Compile/sync output with non-trivial structure (compiled index, sync-report summaries) is verified via `@std/testing/snapshot`. Substring assertions (`assertStringIncludes`, `assertCompiledIndexMatches`) remain for one-line invariants where the structure is small and the substring captures the contract.
