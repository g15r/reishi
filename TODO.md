# reishi v1 Roadmap

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

## Phase 6: Docs Management 🌀

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

- [ ] Config mapping: `[docs.projects.<name>]` table with `target` path override and `fragments` list
- [ ] `rei docs sync [project]` — compile and sync docs for one or all mapped projects
- [ ] Wire into `rei sync` for full-system sync (skills + rules + docs)
- [ ] Respect `sync_method` hierarchy (global > docs > per-project)
- [ ] Tests: project mapping resolves correctly, sync compiles and distributes, sync_method overrides work

## Backlog

- [ ] `rei upgrade` — self-update mechanism
- [ ] `rei export` — export current config + tracked skills as a shareable bundle
- [ ] `rei import` — import a shared bundle to bootstrap a new machine
- [ ] Skill dependency graph — skills that reference other skills
- [ ] Conflict detection — warn when two skills have overlapping tool permissions or trigger conditions
- [ ] Web UI — local server for browsing and managing skills visually
