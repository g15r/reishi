# reishi TODO

## Phase 12: `config link` parity with `unlink`

Move `agent` and `project` adds out of their current homes and under `config link`, mirroring the recently-shipped `config unlink`. Reuse the path-normalization helper from `docs add` (already extracted in `f7cb4e0`).

### `config link` subcommand

- [ ] `rei config link agent <name> --skills <path> --rules <path>` — write `[agents.<name>]` with the two path keys
- [ ] `rei config link project <name> --target <path>` — normalize the path the same way `docs add` does, write `[projects.<name>]`
- [ ] Update or alias the existing `rei docs add` to point at the new home; deprecation message if aliasing

## Phase 13: Source-side CRUD — `move` and `remove`

Fill the CRUD gap on source fragments. Both commands operate on source only — target cleanup is handled by `clean_on_sync` (Phase 15) on the next sync. Add a small helper that strips an optional trailing `.md` from name args so callers may pass `foo` or `foo.md`.

### `move` / `mv`

Rename a skill, doc, or rule. Positional args (no flags). `mv` is an alias of `move`.

- [ ] `rei rules move <old> <new>` — flat namespace: rename `<rules.source>/<old>.md` → `<new>.md`
- [ ] `rei docs move <project> <old> <new>` — rename `<docs.source>/<project>/<old>.md` → `<new>.md`; if the project's `[projects.<name>].fragments` array references `<old>.md`, update it
- [ ] `rei skills move <old> <new>` — rename the source dir; rewrite the skill key in the lockfile and `skill_overrides` if present

### `remove` / `rm`

`rm` is an alias of `remove`.

- [ ] `rei rules remove <name>` — delete `<rules.source>/<name>.md`
- [ ] `rei docs remove <project> <fragment>` — fragment-level: delete the `.md` under the project; project-level removal lives at `rei config unlink project`
- [ ] `rei skills remove <name>` — delete the source dir, drop any matching `[skills.<name>]` entry from the lockfile, drop any `[skill_overrides.<name>]` entry from config

## Phase 14: Two-step compile (rules + docs)

Today `sync` quietly compiles + writes the index to the target. Move compile out: it generates a file *in source* (so it's git-trackable and visible to the user), then sync just ships that file. Affects both rules and docs.

### Per-target compile config

- [ ] Per-agent-target opt-in: `compile = true` plus `compile_file = "AGENTS.md"` (single field, relative to target root, default `AGENTS.md`; subpaths like `"sub/foo.md"` allowed, paths that escape the target root are rejected)

### Compile commands

- [ ] `rei rules compile` — concatenate every fragment in `<rules.source>/` into a single compiled markdown file in source (no index, just well-formatted concatenation)
- [ ] `rei docs compile [project]` — write the existing index to source instead of straight to the target

### Sync integration

- [ ] `rei sync` runs compile first, then ships the source artifact to every target whose `compile = true`

## Phase 15: `clean_on_sync` orphan cleanup

Opt-in cleanup of orphan files in copy targets (files present in target but not in source). Only relevant for `copy` syncs; symlinks self-resolve.

### Config and prompt

- [ ] Add global `clean_on_sync` boolean (default false)
- [ ] During sync, collect orphans across the whole run; present a single batched prompt at the end: `clean up 🧼: remove A, B, and C? (Y/n)` with default Y
- [ ] Skip the prompt under `--dry-run`; report what would be cleaned instead

## Backlog

Future requirements, open questions, and big ideas. Not active work — promote into a Phase or delete; lingering items are noise.

### Skills linting

- [ ] Update `skills validate` to use linter/formatter semantics — `skills lint`, `skills lint --fix`. Combine deeper validation of skill spec rules with markdownlint-style markdown checks, and auto-fix where possible (table formatting, etc.). Consider extracting a `skillint` library that wraps markdownlint and adds agent-context-engineering rules. Lower-priority extension to rules and docs (pure markdown linting).

### LLM-powered features

- [ ] `refine` commands across skills, docs, and rules — configurable, template-based LLM prompt to improve sources for more effective language and structure in fewer tokens.
- [ ] `validate --audit` — semantic conflict detection: warn when two skills have overlapping tool permissions or trigger conditions.

### `checkpoint` command

- [ ] Create a git commit by funneling a diff into a template, piping that through a configurable LLM, then pushing to GH and fetching remote changes. Default template collates additions/deletions/changes in conventional-commit format with light LLM commentary on themes.

### Browsing and management UIs

These are larger investments and probably wait until the tool migrates to Go or Rust — Deno isn't the right fit for any of them.

- [ ] **TUI** — terminal UI for browsing and managing your library, launching `$EDITOR` and dropping back, doing bulk file operations.
- [ ] **fzf integration** — fuzzy search across skills, rules, and docs; preview content or open in editor.
- [ ] **Web UI** — local server for visual browsing and management; should mirror the TUI experience closely.
