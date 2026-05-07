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

## Backlog

Future requirements, open questions, and big ideas. Not active work — promote into a Phase or delete; lingering items are noise.

### Skills linting

- [ ] Update `skills validate` to use linter/formatter semantics — `skills lint`, `skills lint --fix`. Combine deeper validation of skill spec rules with markdownlint-style markdown checks, and auto-fix where possible (table formatting, etc.). Consider extracting a `skillint` library that wraps markdownlint and adds agent-context-engineering rules. Lower-priority extension to rules and docs (pure markdown linting).

### LLM-powered features

- [ ] `refine` commands across skills, docs, and rules — configurable, template-based LLM prompt to improve sources for more effective language and structure in fewer tokens.
- [ ] `validate --audit` — semantic conflict detection: warn when two skills have overlapping tool permissions or trigger conditions.

### `checkpoint` command

- [ ] Create a git commit by funneling a diff into a template, piping that through a configurable LLM, then pushing to GH and fetching remote changes. Default template collates additions/deletions/changes in conventional-commit format with light LLM commentary on themes.

### Cross-domain external-source adoption

- [ ] Design a consistent way to safely pull external file changes back into reishi source — across rules, docs, and skills. Not a sprint task — needs deep thought before scoping. See `SPEC.md` Backlog for the open-questions list (diffing model, conflict mode, scope, surface, relationship to `skills pull`'s divergence protection).

### Browsing and management UIs

These are larger investments and probably wait until the tool migrates to Go or Rust — Deno isn't the right fit for any of them.

- [ ] **TUI** — terminal UI for browsing and managing your library, launching `$EDITOR` and dropping back, doing bulk file operations.
- [ ] **fzf integration** — fuzzy search across skills, rules, and docs; preview content or open in editor.
- [ ] **Web UI** — local server for visual browsing and management; should mirror the TUI experience closely.
