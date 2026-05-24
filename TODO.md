# reishi TODO

## Phase 19: Streamline `skills new` scaffold

**Requirements**: sk-R010, sk-R012, sk-R013

Scaffold today drops four files into a new skill (`SKILL.md`, `example-reference.md`,
`scripts/example.ts`, `assets/example_asset.txt`). In practice the bottom three are deleted as
step 1 ~90% of the time. Replace them with thorough in-template guidance so users add structure
only when they actually need it. Also retire the `references/` subdirectory pattern — modular
reference docs are now flat alongside `SKILL.md`.

### Template surface

- [ ] Delete `assets/example_asset.txt.tmpl`, `assets/example_script.ts.tmpl`,
      `assets/example_reference.md.tmpl` from the repo
- [ ] Rewrite `assets/SKILL.md.tmpl` so its layout guidance covers: flat modular reference
      markdown alongside `SKILL.md` (e.g. `cool-skill/api-design.md`), `scripts/` for
      executables, `assets/` for output artifacts — concrete examples from real skills, no
      "delete this section when done" boilerplate
- [ ] Purge every `references/` mention from `SKILL.md.tmpl` — the subdirectory pattern is
      retired
- [ ] Drop the embed entries for the removed templates from the template loader

### `rei skills new` scaffolder

- [ ] Stop creating `scripts/`, `assets/`, `example-reference.md`; only write `SKILL.md`
- [ ] Trim the post-scaffold "Next steps" output to match (no reference to deleted example
      files)
- [ ] Verify the binary build path: `deno task compile` followed by `rei skills new` produces
      the same single-file scaffold

### Tests

- [ ] Update `cli_test.ts` and `compile_test.ts` cases that assert the four-file layout to
      assert single-file `SKILL.md` only
- [ ] Add a case asserting no `scripts/` or `assets/` dir is created
- [ ] Confirm `rei skills validate` still passes against the new minimal scaffold

## Phase 23: Retire docs and compile

**Requirements**: R003, R012, cf-R011, cf-R013, cf-R014, cf-R015, cf-R016, cf-R040, cf-R043

Clearing exercise before the activation redesign. The docs domain and every compile pathway
are removed end-to-end: source files, CLI subcommands, config schema, sync orchestration,
tests, fixtures. Single big sweep — keeps the diff coherent and stops half-retired code from
poisoning subsequent Phases.

### Source files and tests

- [ ] Delete `docs.ts`, `docs_test.ts`, `compile_test.ts`, `compile_phase14_test.ts`
- [ ] Delete docs-related entries from `assets/` (if any) and `test-fixtures/`
      (`project-targets/`, `project-sources/`)
- [ ] Drop `deno task test:docs`, `test:phase14`, `test:compile` (or any rules-compile task)
      from `deno.json`

### CLI surface

- [ ] Remove the `rei docs` subcommand tree from `reishi.ts`
- [ ] Remove the `rei rules compile` subcommand
- [ ] Remove the `rei config link project` / `unlink project` subcommands
- [ ] Update the top-level `rei` help text and README to drop docs references

### Config schema

- [ ] Remove the `[docs]` table, `[projects.<name>]` tables, and any docs-related top-level
      keys from `ConfigSchema` in `config.ts`
- [ ] Remove `compile`, `compile_root`, `compile_file` from `AgentConfig`
- [ ] Remove the `include_shared_agent`-adjacent docs scaffolding from `rei config init`
      output
- [ ] Update `loadConfig` / `saveConfig` round-trip tests to cover the new shape only

### Sync orchestration

- [ ] Remove `compileToTarget` and `compileRules` from `sync.ts` and `rules.ts`
- [ ] Drop the pre-sync compile step from `rei sync`
- [ ] Strip the compile-artifact exclusion from `findOrphans`

### Suite + docs

- [ ] Full test suite green (`deno task test`) after the sweep — every doc/compile reference
      replaced, removed, or guarded
- [ ] Strip retired vocabulary (`doc`, `project`, `compile`, `fragment`) from comments,
      strings, and remaining test names

## Phase 24: Activation core and profile artifact

**Requirements**: ac-R001, ac-R002, ac-R003, ac-R004, ac-R005, ac-R010, ac-R011, ac-R012,
ac-R013, ac-R014, ac-R015, ac-R016, ac-R020, ac-R021, ac-R022, ac-R023, ac-R024, ac-R025,
ac-R030, ac-R031, ac-R032, ac-R033, ac-R060, ac-R070, ac-R071, ac-R080, ac-R081, cf-R011,
cf-R013, cf-R014, cf-R015, cf-R016, cf-R023, cf-R030

Foundation for everything that follows. Lands the profile artifact, the condition schemas, the
pure evaluation engine, and the lockfile state extension. No CLI behavior change yet beyond
profile CRUD — this Phase makes the new machinery exist; later Phases plug it into use/unuse,
sync, and the library surface.

### Schema additions

- [ ] Add `[profiles]` table with `source` key to `ConfigSchema`; defaults to
      `~/.config/reishi/profiles`
- [ ] Add `[rule_overrides.<name>]` and `[profile_overrides.<name>]` tables to the schema
- [ ] Add `conditions` field to `[skill_overrides.<name>]`, `[rule_overrides.<name>]`
- [ ] Add `default_profiles` array to `[agents.<name>]`
- [ ] Extend lockfile schema with `[state.manual."<name>"]` entries (`kind`, `set_at`)
- [ ] `rei config init` creates the `profiles` source dir alongside `skills` and `rules`;
      idempotent

### Profile artifact

- [ ] Define profile.toml parser (members.rules, members.skills, description, conditions)
- [ ] Validate profile name follows ac-R002 rules; reject invalid filenames at load
- [ ] Warn (not fail) on missing members during load; surface in list/show output

### Evaluation engine

- [ ] Implement `evaluateActivation(library, context)` as a pure function returning the active
      set keyed by artifact type
- [ ] Implement the three v1 condition types: `manual`, `path`, `agent`
- [ ] Implement profile cascade: an active profile activates every member rule and skill
- [ ] Implement no-conditions-equals-active default

### `rei profiles` CRUD

- [ ] `rei profiles new <name>` writes a scaffolded profile.toml with commented examples
- [ ] `rei profiles list` (alias `ls`) reports name, description, member counts, active state
- [ ] `rei profiles show <name>` prints parsed contents + current active state
- [ ] `rei profiles edit <name>` launches `$EDITOR` / `$VISUAL` / `vi`
- [ ] `rei profiles move <old> <new>` (alias `mv`) renames + rekeys overrides
- [ ] `rei profiles remove <name>` (alias `rm`) deletes + drops overrides

### Lockfile state

- [ ] Read/write `[state.manual.*]` entries with the same atomic-write discipline as
      tracked-skill entries
- [ ] Tolerate (but don't require) manual edits — schema mismatches log a warning, don't crash

### Tests

- [ ] Unit: evaluation engine with each condition type in isolation and combination
- [ ] Unit: profile cascade (member active iff profile active)
- [ ] Unit: profile load + missing-member warning
- [ ] Unit: schema additions parse + round-trip cleanly
- [ ] Snapshot: `rei profiles list` output across {empty, one-profile, mixed-active} fixtures

## Phase 25: Use / unuse / status

**Dependencies**: 24
**Requirements**: ac-R040, ac-R041, ac-R042, ac-R043, ac-R050, ac-R051, ac-R052, ac-R053

User-facing surface for manual activation and inspection. Small Phase — three commands plus
ambiguity resolution and auto-sync wiring.

### Commands

- [ ] `rei use <name>` sets manual condition; resolves across rules/skills/profiles; prompts on
      ambiguity (`rule:`, `skill:`, `profile:` disambiguators)
- [ ] `rei unuse <name>` clears manual condition; no-op if not set
- [ ] `rei use --reset` clears every manual activation
- [ ] `rei use` and `rei unuse` auto-trigger sync; `--no-sync` opts out
- [ ] `rei status` reports active state per artifact type with the driving condition
- [ ] `rei status --profile <name>` reports one profile's member state
- [ ] `rei status --json` emits structured JSON

### Tests

- [ ] Manual state round-trips through the lockfile
- [ ] Ambiguity prompt fires only when the name resolves to >1 artifact type
- [ ] `--reset` clears all manual entries in one shot
- [ ] Status output covers each activation-driver case (no conditions, manual, path, agent,
      via profile)

## Phase 26: Activation-driven sync

**Dependencies**: 23, 24
**Requirements**: sk-R001, sk-R045, sk-R046, ru-R030, ru-R031, sy-R020, sy-R021, sy-R022,
sy-R031, sy-R050, sy-R072, sy-R081

Sync becomes active-set-driven: writes active items, removes items no longer active, leaves
user orphans to `clean_on_sync`. Retires the `_deactivated/` folder pattern. Wires the per-domain
`activate` / `deactivate` aliases through `rei use` / `rei unuse`.

### Sync engine refactor

- [ ] `syncSkills` and `syncRules` consume an active set from the evaluation engine instead of
      a flat source listing
- [ ] Removal pass: for each agent target, drop reishi-known items no longer in the active set
- [ ] Evaluation context exposes the addressed agent name(s) so `agent` conditions and
      `default_profiles` fire correctly
- [ ] Add `default_profiles` to the evaluation context construction for each agent

### Retire `_deactivated/`

- [ ] Drop the `_deactivated/` folder code path from `sync.ts` and `paths.ts`
- [ ] `rei skills list` reads from the flat source dir only
- [ ] One-shot migration: any existing `_deactivated/<skill>/` dirs on user systems are warned
      about with a clear `rei skills move` recommendation (no auto-migration — user-driven)

### Aliases

- [ ] `rei skills activate <name>` → thin alias of `rei use <name>` constrained to skill
      resolution
- [ ] `rei skills deactivate <name>` → thin alias of `rei unuse <name>` constrained to skill
      resolution
- [ ] `rei rules activate <name>` / `rei rules deactivate <name>` — parallel rule aliases

### `clean_on_sync` and `--check`

- [ ] `findOrphans` distinguishes user orphans (no source-side counterpart) from deactivation
      removals (active-set-managed) and only prompts on the former
- [ ] `--check` reports the new `removed` state (was active last sync, no longer active)
- [ ] `--dry-run` previews both additions and removals with clear labels

### Tests

- [ ] Active item appears in target; inactive item is removed from target on next sync
- [ ] User-authored target file is preserved; `clean_on_sync = true` prompts for it but not
      for deactivation removals
- [ ] `default_profiles` activate when the matching agent is addressed and do not activate
      when a different agent is addressed
- [ ] `--dry-run` preview matches the actual diff produced by a real sync
- [ ] `_deactivated/` migration warning fires once per startup when the dir exists

## Phase 27: Library surface and agent defaults

**Dependencies**: 24, 26
**Requirements**: lb-R001, lb-R010, lb-R011, lb-R012, lb-R013, lb-R014, lb-R015, lb-R016,
lb-R017, lb-R020, lb-R021, lb-R022, lb-R030, lb-R031, lb-R040, lb-R041, ac-R061, cf-R040

Top-level `rei library` surface — the cross-artifact view the user thinks in. Plus the link
flag for default_profiles so agent setup is one command.

### `rei library` commands

- [ ] `rei library` (alias `lib`, no subcommand) prints summary counts + pointer to `list` /
      `search`
- [ ] `rei library list` (alias `ls`) cross-type listing with
      name/type/description/active/driver columns
- [ ] `--type`, `--active`, `--inactive`, `--agent`, `--profiles`, `--filter`, `--json` flags
- [ ] `rei library search <query>` substring match across name, description, profile members
      (accepts `--type` / `--active` / `--inactive` / `--agent` / `--profiles` / `--json`; not
      `--filter`)
- [ ] `rei library show <name>` resolves across types, prints full item; prompts on ambiguity

### Agent link convenience

- [ ] `rei config link agent <name> ... --default-profiles=<a,b,c>` populates
      `default_profiles` at link time
- [ ] Validation: each named profile must exist in the library at link time (or `--force`
      bypasses)

### Tests

- [ ] Snapshot: `rei library list` across {empty, mixed-state, agent-scoped} fixtures
- [ ] Search hits across each searchable field with `match_field` correctness in `--json`
- [ ] `--agent` evaluation factors `agent` conditions and `default_profiles`

## Phase 21: Test harness solidification

**Dependencies**: 23
**Requirements**: dev-R001, dev-R002, dev-R003, dev-R010, dev-R011, dev-R012, dev-R013,
dev-R020, dev-R021, dev-R040, dev-R041, dev-R050, dev-R060, dev-R061, dev-R062

Finishes the harness story started in Phase 20: pulls the duplicated per-file helpers into
`test-helpers.ts`, migrates `cli_test.ts` (the largest remaining inline-scaffolding pocket),
and lands the quality-of-life pieces — fake clock, URL-aware fetch fake, permissions-drift
assertion. Re-baselines the fixture vocabulary against the new library-only shape (the
Phase 23 cleanup retires the project-target/project-source buckets).

### Centralize duplicated helpers

- [ ] Promote `withEnv`, `patchConfig`, `writeLockfile` from per-test files into
      `test-helpers.ts`; delete the per-file copies
- [ ] Add `runCli(env, args)` to `test-helpers.ts` — accepts an `IsolatedEnv`, inherits
      `PATH` / `DENO_DIR` / `XDG_CACHE_HOME` / `USER`, returns `{ code, stdout, stderr }`
- [ ] Replace per-file `runCli` reinventions (`sync_integration_test.ts`, `cli_test.ts`, etc.)
      with the shared helper

### Fixture vocabulary refresh

- [ ] Rename `seedSourceDir` → `seedLibrary`; expand to accept profiles alongside rules and
      skills
- [ ] Drop `seedProject` from the public helper surface (no project targets anymore)
- [ ] Add `assertActiveSet(env, context, expected)` for activation-engine assertions

### Migrate `cli_test.ts`

- [ ] Convert per-test `Deno.makeTempDir` shapes to `setupIsolatedEnv` + the `seed*` builders,
      file section by file section, suite green at every step
- [ ] Drop the now-unused per-file scaffolding; idiosyncratic per-test shapes that don't fit a
      builder stay inline (mirrors dev-R021)

### Quality-of-life upgrades

- [ ] Refactor `sync.ts` (and any other module that calls `Date.now()` directly) to consume an
      injectable clock so a fake-now helper has somewhere to plug in
- [ ] Add `withFakeNow(env, fn)` to `test-helpers.ts`; replace `setTimeout`-based waits in
      `sync_fetch_test.ts` and elsewhere with deterministic time steps
- [ ] Replace or extend `fakeFetchGithub` with a URL-aware fake that distinguishes commits API,
      tarball download, and ref-resolution endpoints; assert expected endpoints in tests so
      wrong-endpoint regressions surface
- [ ] Add a permissions-drift test that asserts the compiled binary is invoked with the
      narrow `--allow-*` set R008 specifies; failures block the suite

## Phase 22: CI coverage signal

**Dependencies**: 21
**Requirements**: dev-R100, dev-R101

Re-examine CI now that the test harness is in better shape. Phase 21's helpers and migrations
make the suite uniform enough that coverage numbers are meaningful — wire them into PR review.

### Coverage in CI

- [ ] Add `deno test --coverage` to the GitHub Actions workflow; emit the `coverage` profile
      as a workflow artifact
- [ ] Surface line and branch coverage on PRs (PR comment or status check) with deltas
      relative to the merge base
- [ ] Establish a baseline floor; PRs that drop below it fail the gate. Floor is bumped by
      maintainer decision, not auto-ratcheted
