# reishi — Agent Context Manager

One collection, three constructs, every agent. Edit in one place, distribute everywhere.

## Philosophy

Most agent tooling focuses on rigid plugin systems and skill marketplaces. Reishi takes a different approach: all agent context is markdown, and the value comes from clarity about *when* that context is active, not from complex packaging or distribution systems.

Reishi manages three types of agent context, differentiated by scope and activation:

- **Rules** — Always-on, user-level context. Loaded at the start of every session. Style preferences, safety guidelines, workflow patterns. "Always do this."
- **Skills** — Conditionally activated context. Loaded when relevant to the task at hand. Domain expertise, tool-specific guides, framework patterns. "Load this when you need it."
- **Docs** — Project-scoped context. Compiled into a token-efficient index per project, looked up as needed. API conventions, architecture decisions, team patterns. "This is how *this project* works."

All three are markdown. All three live in a single source directory. Reishi distributes them to the right places for every configured agent. The user edits in one place and the tool handles the rest — symlinking or copying to Claude, OpenCode, or whatever comes next.

The goal is to make it easy to figure out what works for you and freely move context between these three roles as your understanding evolves. A skill you use every session should probably be a rule. A rule that only applies to certain projects should probably be a doc fragment. Reishi makes these transitions trivial.

## Core Concepts

### Source of truth

All managed content lives in a single source directory per construct:
- Skills: `skills.source` (default `~/.config/reishi/skills/`)
- Rules: `rules.source` (default `~/.config/reishi/rules/`)
- Docs: `docs.source` (default `~/.config/reishi/docs/`)

These are where users create, edit, and customize content. They are always authoritative — reishi never writes to source directories without explicit user action.

### Agents and projects

Destinations are organized into two types:

- **Agents** — Named destinations for skills and rules. Each agent groups a `skills` path and a `rules` path (e.g. `[agents.claude]` with `skills = "~/.claude/skills"` and `rules = "~/.claude/rules"`). Use `--agents=<name>` on sync/pull to filter.
- **Projects** — Named destinations for docs. Each project maps a name to a project root on disk (e.g. `[projects.myproject]` with `path = "~/code/myproject"`). Use `--projects=<name>` on docs sync to filter.

Reishi distributes from source to these destinations automatically via copy or symlink. Destination files are overwritten on every sync. Destinations are output, not input.

### Tracking (skills only)

A tracked skill records its GitHub origin in a lockfile (`reishi-lock.toml`) so reishi can check for upstream updates and pull fresh content. Tracking does not surrender ownership — the user's source copy is always authoritative. Tracking means "I want to know when upstream has updates," not "upstream owns this."

### Sync vs pull

Two distinct operations, deliberately separated:

- **`rei sync`** — Local only, no network. Distributes source → targets for all three constructs. Fast, always safe.
- **`rei skills pull`** — Network operation. Fetches upstream content for tracked skills from GitHub. Compares the remote HEAD SHA against the lockfile's recorded SHA. If upstream moved, downloads new content with divergence protection.

### Divergence protection

When `rei skills pull` fetches new upstream content, each file is handled independently:

- **Unchanged locally** (file mtime <= `synced_at`): overwritten with upstream version.
- **Modified locally** (file mtime > `synced_at`): user's version kept in place, upstream version saved as `<filename>_1.md` (incrementing `_2`, `_3` as needed).

Pull is always safe — it never destroys user work.

### Config vs lockfile

- **`config.toml`** — User-edited configuration: source paths, sync method, agent/project destinations, prefix settings, update polling. Pure preferences, no state.
- **`reishi-lock.toml`** — Machine-managed tracking state: per-skill upstream URL, ref, subpath, prefix, SHA, `synced_at`. Written by `rei skills add -t` and `rei skills pull`.

Both live in the reishi config directory (default `~/.config/reishi/`).

## Quick Start

```bash
deno task cli <command> [args]    # Run against live source during development
deno task check                   # Type check
deno task test                    # Full test suite
deno task install                 # Install globally as `rei`
```

## Command Structure

Four top-level domains, each a subcommand group:

```text
rei skills  [new|validate|add|list|activate|deactivate|pull|sync]
rei rules   [list|sync]
rei docs    [list|add|remove|sync]
rei config  [init|show|path]
rei sync    ← top-level convenience: sync all three domains at once
```

### rei skills

Manage conditionally-activated agent context.

```bash
rei skills new <name> [--path dir]        # scaffold from template
rei skills validate <path>                # check structure + frontmatter
rei skills add <github-url> [-t] [-p]     # install from GitHub
rei skills list [-a]                      # list active (or all) skills
rei skills activate <name>                # re-enable a deactivated skill
rei skills deactivate <name>              # temporarily disable
rei skills pull [name] [--dry-run] [--check]  # fetch upstream / check for updates
rei skills sync [name] [--agents] [--method] [--dry-run] [--check]  # distribute to agents
```

#### new

Scaffold a new skill:

```text
my-skill/
├── SKILL.md              # Frontmatter + instructions
├── example-reference.md  # Modular deeper documentation
├── scripts/              # Executable code + workflows
│   └── example.ts
└── assets/               # Templates/files for workflows
    └── example_asset.txt
```

**Name rules**: lowercase letters, digits, hyphens. No leading/trailing/consecutive hyphens. Max 64 chars.

#### add

Install skills from a GitHub tree URL:

```bash
rei skills add https://github.com/user/repo/tree/main/skills/my-skill   # single
rei skills add https://github.com/user/repo/tree/main/skills             # all in dir
```

- `-t, --track`: record origin in lockfile for future `rei skills pull`
- `-p, --prefix [value]`: prefix skill names (infer from GitHub org, or provide explicitly)

#### pull

Fetch upstream for tracked skills with divergence protection:

1. Fetch HEAD SHA from GitHub API (lightweight, single call per skill).
2. Compare against lockfile SHA — skip if unchanged.
3. If upstream moved: download tarball, extract, merge with divergence protection.
4. Update `sha` and `synced_at` in lockfile.
5. Auto-sync to targets.

**Prefix changes**: if `prefix` was edited in the lockfile, pull detects the mismatch and prompts for resolution (rename / parallel / abort). Use `--prefix-change=rename|parallel|abort` for non-interactive flows.

#### --check (inspection mode)

Both `sync` and `pull` accept `--check` to inspect state without writing:

- **`rei skills sync --check`** — Report per skill × agent freshness: `fresh`, `stale`, `diverged`, `missing`, `symlink`. Local only, no network.
- **`rei skills pull --check`** — Lightweight upstream check — fetches HEAD SHA per tracked skill, reports which have updates. No downloads.

### rei rules

Always-on, user-level agent context. Rules are the simplest construct — a folder of markdown files at `rules.source` (default `~/.config/reishi/rules/`). No tracking, no frontmatter, no conditional activation. Drop a `.md` file in the folder, sync, and it's active for every session across every agent.

Users manage the files directly — create, edit, delete with their editor or filesystem tools. Reishi just lists what's there and distributes it.

```bash
rei rules list                                                      # list all rules in source
rei rules sync [--agents=claude] [--method=symlink] [--dry-run]     # distribute to agent targets
```

### rei docs

Project-scoped agent context. Docs are markdown fragments organized by project, compiled into a token-efficient index that agents look up as needed.

Each subdirectory of `docs.source` is a project. Each `.md` file inside is a fragment. Unlike rules and skills, docs are distributed to real project directories — the compiled index lands at `<target>/<index_filename>` (default `AGENTS.md`), and fragments go under `<target>/<docs.default_target>/` (default `.agents/docs/`).

Users manage fragment files directly in the project subdirectory. Reishi handles project creation (which involves both a directory and a config entry) and distribution.

```bash
rei docs list [project]                                     # list projects, or fragments in a project
rei docs add <project> [--target path]                      # create project dir + config entry
rei docs remove <project>                                   # remove config entry (prompts to also delete docs dir)
rei docs sync [project] [--target path] [--dry-run]         # compile index + distribute fragments
rei docs sync [project] --stdout                            # preview the compiled index without writing
```

`rei docs remove` is a two-step confirmation: first confirms removing the project's config entry, then optionally offers to delete the project's docs directory. Config removal is the default action; filesystem deletion is opt-in.

**Index format**: one heading per fragment, a one-line description (frontmatter `description` > first non-heading paragraph > first heading), and a relative link to the fragment file. Ordered by frontmatter `priority` descending, then alphabetically. Truncated at `token_budget` with an omission notice.

### rei config

```bash
rei config init     # create config file, lockfile, and directories
rei config show     # print effective config
rei config path     # print config file path
```

Override location with `REISHI_CONFIG=/path/to/config.toml`.

### rei sync

Top-level convenience — syncs all three domains (skills, rules, docs) to targets in one operation. Local only, no network.

```bash
rei sync                          # sync everything
rei sync --agents=claude          # limit to specific agents
rei sync --method=symlink         # override sync method
rei sync --dry-run                # preview without writing
```

Individual domain syncs are also available via `rei skills sync`, `rei rules sync`, `rei docs sync`.

**Sync method resolution** (highest wins): CLI `--method` > per-content-type override > global `sync_method`.

**Auto-sync**: `skills add`, `skills activate`, `skills deactivate`, `skills new`, and `skills pull` trigger sync automatically after completing their work.

## Config Schema

```toml
# ~/.config/reishi/config.toml

sync_method = "copy"            # "copy" or "symlink"
default_prefix = "infer"        # "infer" from GitHub org, or "none"
prefix_separator = "_"

[skills]
source = "~/.config/reishi/skills"

[updates]
enabled = true
interval_hours = 24

[rules]
source = "~/.config/reishi/rules"
# sync_method = "symlink"      # inherits global if unset

[agents.claude]
skills = "~/.claude/skills"
rules = "~/.claude/rules"

# [agents.opencode]
# skills = "~/.opencode/skills"
# rules = "~/.opencode/rules"

[docs]
source = "~/.config/reishi/docs"
default_target = ".agents/docs"
index_filename = "AGENTS.md"
# sync_method = "symlink"
# token_budget = 4000

[projects.myproject]
path = "~/code/myproject"
# fragments = ["api-conventions.md", "testing.md"]

# Per-skill config overrides (optional)
[skill_overrides.book-review]
sync_method = "symlink"
agents = ["claude"]
```

## Lockfile Schema

```toml
# ~/.config/reishi/reishi-lock.toml — managed by rei, do not edit manually

[skills.readwiseio_book-review]
source_url = "https://github.com/readwiseio/readwise-skills"
subpath = "skills/book-review"
ref = "main"
sha = "abc123def456..."
synced_at = "2026-04-23T12:00:00Z"
prefix = "readwiseio"
```

## Testing

```bash
deno task test              # full suite (unit + integration + CLI + compiled binary)
deno task test:unit         # fast: config, paths
deno task test:cli          # CLI plumbing: help, init, validate, completions, config
deno task test:sync         # sync engine: copy, symlink, targets, status
deno task test:sync-fetch   # upstream fetch, local mod detection
deno task test:sync-prefix  # prefix change flows
deno task test:add          # add command integration
deno task test:updates      # update polling
deno task test:rules        # rules CRUD + sync
deno task test:docs         # docs fragments, index compilation, sync
deno task test:compile      # compiled binary smoke tests
```

All tests use `REISHI_CONFIG`-redirected temp dirs and offline fixture helpers (`test-helpers.ts`, `test-fixtures/`). Interactive prompts use injectable callbacks to avoid terminal dependency. Nothing hits live GitHub.

## Source Layout

| File | Purpose |
| --- | --- |
| `reishi.ts` | Cliffy command definitions and action wiring |
| `config.ts` | TOML schema, `loadConfig` / `saveConfig` / `initConfig`, deep-merge with defaults |
| `paths.ts` | Resolves `skills.source`, `rules.source`, `docs.source`, cached per session |
| `sync.ts` | Target sync engine, upstream fetch, prefix-change flow, `checkForUpdates` |
| `rules.ts` | Rules CRUD + sync |
| `docs.ts` | Fragment CRUD, index compilation with token budget, per-project distribution |
| `test-helpers.ts` | `setupIsolatedEnv`, `makeFixtureTarball`, `fakeFetchGithub` |
| `assets/` | Skill templates (embedded in compiled binary via `--include`) |
| `scripts/compile-all.sh` | Cross-compile to `{os}-{arch}` targets |
| `.github/workflows/` | CI + release workflows |

## Development Tips

1. Edit the relevant module (`reishi.ts` for CLI, `config.ts`/`sync.ts`/`rules.ts`/`docs.ts` for logic)
2. Type check: `deno task check`
3. Test: `deno task test` (or specific `test:*` tasks for fast feedback)
4. Try it: `deno task cli <command>`
5. Compile: `deno task compile` (builds `bin/rei`)
6. Deploy: `deno task install` (updates global `rei` at `~/.local/bin/rei`)

## Architecture

- **Deno** — TypeScript native, secure by default, cross-compile to static binaries
- **Cliffy** — declarative CLI framework with tab completion
- **`@std/toml`** (config), **`@std/yaml`** (skill frontmatter), **`@std/fs`**, **`@std/path`**, **`@std/fmt/colors`**
- **Offline-first tests** — fetch injection (`HttpFetcher`) keeps the full suite hermetic
- Single portable binary per platform, distributable via Homebrew and Linux package managers
