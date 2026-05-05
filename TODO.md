# reishi TODO

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
