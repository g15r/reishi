# test-fixtures

Three buckets, one job each. If a fixture doesn't fit a bucket, ask before adding it — fixtures are
only worth keeping when at least one `*_test.ts` references them. Dead fixtures get deleted
(dev-R003).

## Buckets

### `remote-repos/`

GitHub-tarball sources for `skills add` / `skills pull` flows. Every dir here gets staged inside a
`<name>-main/` wrapper and tarred by `makeFixtureTarball()` so it round-trips through reishi's
normal install path without hitting the live API.

### `project-targets/`

Heterogeneous **project-root** layouts that simulate real user repos — `claude-only/`,
`cursor-only/`, `mixed/`, `agents-only/`, `deeply-nested/`, `none-detected/`. Used by docs-import
and project-link tests as the read-only "what we found in the user's repo" input. Tests should not
mutate these in place; copy via `copyFixtureToTemp()` first.

### `project-sources/`

Curated reishi-**source** dirs — skills, rules, and docs together — used as compile/sync inputs.
Reach for one of these when you need a realistic source shape with multiple fragment kinds;
otherwise build inline with `seedSourceDir()`.

## Builders

Test scaffolding lives in `../test-helpers.ts`:

- `setupIsolatedEnv()` — isolated HOME + config, the foundation for the rest.
- `copyFixtureToTemp(env, name)` — mutable copy of any on-disk fixture.
- `seedProject` / `seedAgentTarget` / `seedSourceDir` / `seedRemoteRepo` — structured-input builders
  that write under the env's temp tree and clean up with `env.cleanup()`.

Prefer the builders over inline `makeTempDir` + `writeTextFile` (dev-R020).
