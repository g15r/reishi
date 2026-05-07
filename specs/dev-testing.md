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
