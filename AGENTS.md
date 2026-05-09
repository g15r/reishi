# reishi — Agent Context Manager

A Deno CLI that manages markdown agent context (rules, skills, docs) from a single source and syncs
it to every configured agent target.

## Specs and project state

This project follows the **SPOT** convention (Spec, Phases, Objectives, Tasks):

- `SPEC.md` — project contract: vibe, non-goals, vocabulary, project-scope requirements (`R001+`),
  Backlog, Meta. `@`-imports the domain specs below.
- `specs/<dom>-<slug>.md` — durable per-domain specs with stable IDs (`cf-`, `sk-`, `ru-`, `dc-`,
  `sy-`). The contract for everything reishi does.
- `TODO.md` — active Phases. Each Phase header carries a `**Requirements**:` line referencing IDs
  from the specs.
- `DONE.md` — shipped Phases, with rationale and the same requirement-ID footers.

When the spec and TODO disagree, the spec wins. If you discover a missing requirement mid-work,
write it into the durable spec first (next available ID, append-only), then update the Phase's TODO
line.

## Vocabulary

Canonical glossary — keep CLI output, errors, and docs consistent with this:

- **markdown file** — the unit of content reishi manages; say _file_ in prose, _rule_/_doc_/_skill_
  when domain matters
- **rule** — a markdown file under `rules.source`; always-on agent context
- **doc** — a markdown file under `docs.source/<project>/`; project-scoped, compiled into a
  per-project index
- **skill** — a directory under `skills.source` with `SKILL.md` plus optional supporting files;
  conditionally activated
- **source** — `~/.config/reishi/` (default); always authoritative
- **target** — agents (skills + rules) and projects (docs)
- **sync** — local-only write, source → targets
- **pull** — network operation, remote → source for tracked skills
- **remote** — upstream of a tracked skill (a GitHub repo)

## Source layout

| File                     | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `reishi.ts`              | Cliffy command tree and action wiring                                      |
| `config.ts`              | TOML schema, `loadConfig`/`saveConfig`/`initConfig`, link/unlink           |
| `paths.ts`               | Source-dir resolvers, cached per session                                   |
| `sync.ts`                | Sync engine, pull, prefix-change, orphan walk, skill move/remove           |
| `rules.ts`               | Rules CRUD + sync + `compileRules`                                         |
| `docs.ts`                | Doc files + index compilation + project-level CRUD + `compileDocsToSource` |
| `test-helpers.ts`        | `setupIsolatedEnv`, `makeFixtureTarball`, `fakeFetchGithub`                |
| `assets/`                | Skill scaffold templates (embedded via `deno compile --include`)           |
| `scripts/compile-all.sh` | Cross-compile to `{os}-{arch}`                                             |
| `.github/workflows/`     | CI + release workflows                                                     |

## Command tree

```text
rei skills  [new|validate|add|list|activate|deactivate|move|remove|pull|sync]
rei rules   [list|move|remove|compile|sync]
rei docs    [list|add|move|remove|compile|sync]
rei config  [init|show|path|link {agent,project}|unlink {agent,project}]
rei sync    cross-domain convenience (skills + rules + docs)
```

Aliases: `mv` for `move`, `rm` for `remove`, `ls` for `list`, `on`/`off` for
`activate`/`deactivate`, `a` for `skills add`, `check` for `validate`.

`--check` mode (no writes, no network on sync side):

- `rei skills sync --check` — per skill × agent freshness (`fresh|stale|diverged|missing|symlink`)
- `rei skills pull --check` — remote SHA probe per tracked skill, no download

Auto-sync triggers (call `syncSkill(name)` after their primary work): `skills add`, `skills new`,
`skills activate`, `skills deactivate`, `skills pull`.

## Config schema

```toml
# ~/.config/reishi/config.toml

sync_method = "copy"            # "copy" or "symlink"
default_prefix = "infer"        # or "none"
prefix_separator = "_"
include_shared_agent = true     # opt in to ~/.agents/ as the built-in `shared` agent
clean_on_sync = false           # opt-in batched orphan prompt at end of `rei sync`

[skills]
source = "~/.config/reishi/skills"

[rules]
source = "~/.config/reishi/rules"
# sync_method = "symlink"       # inherits global if unset

[docs]
source = "~/.config/reishi/docs"
default_target = ".agents/docs"
index_filename = "AGENTS.md"
# sync_method = "symlink"
# token_budget = 4000

[updates]
enabled = true
interval_hours = 24

[agents.claude]
skills = "~/.claude/skills"
rules = "~/.claude/rules"
# compile = true                # ship a single concatenated rules artifact
# compile_root = "~/.claude"    # default: dirname(rules)
# compile_file = "AGENTS.md"    # path relative to compile_root; `..` rejected

[projects.myproject]
path = "~/code/myproject"
# files = ["api-conventions.md", "testing.md"]   # subset filter

# Per-skill overrides (optional)
[skill_overrides.book-review]
sync_method = "symlink"
agents = ["claude"]              # restrict to these named agents
# updates = false                # disable polling for this skill
```

Sync method resolution (highest wins): CLI `--method` > per-skill
`[skill_overrides.<name>].sync_method` > per-domain `[rules].sync_method` / `[docs].sync_method` >
global `sync_method`.

The `shared` agent name is reserved — set `include_shared_agent = true` instead of writing
`[agents.shared]`. The path is fixed at `~/.agents/`.

## Lockfile schema

```toml
# ~/.config/reishi/reishi-lock.toml — managed by `rei skills add -t` and `rei skills pull`

[skills.readwiseio_book-review]
source_url = "https://github.com/readwiseio/readwise-skills"
subpath = "skills/book-review"
ref = "main"
sha = "abc123..."
synced_at = "2026-04-23T12:00:00Z"
prefix = "readwiseio"
```

`REISHI_CONFIG` and `REISHI_LOCKFILE` override the default paths with parallel semantics.

## Two-step compile (rules + docs)

Compile generates a source-side artifact that sync ships as-is — git-trackable and visible to the
user.

- `rei rules compile` writes `<rules.source>/AGENTS.md` (constant `COMPILED_RULES_FILENAME`). Agents
  with `compile = true` receive a copy of this file at `<compile_root>/<compile_file>`.
  `compile_file` paths that escape `compile_root` via `..` are rejected.
- `rei docs compile [project]` writes `<docs.source>/<project>/<index_filename>`. `compileToTarget`
  writes to source first, then ships to the project root.
- `rei sync` runs the relevant compile step automatically before shipping.

## Divergence protection

`rei skills pull` merges file-by-file:

- mtime ≤ `synced_at`: overwritten with the remote version
- mtime > `synced_at`: local version preserved; remote saved as `<stem>_<N><ext>` (`SKILL.md` →
  `SKILL_1.md`, then `_2`, `_3`, …) up to 1000

`_N`-suffixed files are user-facing artifacts — never reconsidered for further suffixing or removal.
Pull never destroys user work. There is no `--force`.

## Concurrency

Independent operations fan out via `Promise.all`:

- `syncAll` per-skill, `syncSkill` per-target, `unsyncSkill` per-target
- `syncDocs` per-project, `compileToTarget` per-file write
- `compileRules` per-rule reads
- `findOrphans` per-agent
- `checkForUpdates` per-skill HEAD probe
- top-level `rei sync` runs skills/rules/docs in parallel

Pull operations stay sequential because `printPullSummary` and mid-flow `Downloading...` lines would
interleave.

## Testing

```bash
deno task test                     # full suite via scripts/test.ts
deno task test:unit                # config, paths
deno task test:cli                 # end-to-end CLI smoke
deno task test:sync                # sync engine
deno task test:sync-fetch          # upstream fetch + divergence
deno task test:sync-prefix         # prefix-change flows
deno task test:add                 # add command integration
deno task test:updates             # update polling
deno task test:rules               # rules list/sync
deno task test:docs                # docs + index compilation
deno task test:move-remove         # Phase 13 source-side CRUD
deno task test:phase14             # rules+docs compile, agent compile opt-in
deno task test:clean-on-sync       # orphan walk + cleanup
deno task test:shared-agent        # include_shared_agent semantics
deno task test:compile             # compiled-binary smoke (needs network for denort)
```

Every suite runs offline against `REISHI_CONFIG`-redirected temp dirs. `HttpFetcher`, `PromptYesNo`,
and `PromptChoice` are injectable so prompts and network calls stay hermetic.

## Dev workflow

```bash
deno task cli <command>            # run from source
deno task check                    # type check
deno task test                     # all suites
deno task compile                  # bin/rei
deno task install                  # install global rei
```

## Stack

Deno + TypeScript. Cliffy (CLI), `@std/toml` + `@std/yaml` (parsing), `@std/fs` + `@std/path`,
`@std/fmt/colors`. Single portable binary per platform via `deno compile`, distributed through
Homebrew + Linux package managers.
