# reishi — SPEC

## Goals

reishi is an agent context manager. It treats every form of agent context — always-on rules, conditional skills, project-scoped docs — as plain markdown living in a single source of truth, and syncs that source to whichever agent tools the user runs. The user edits in one place; reishi handles distribution. The brand vibe is approachable Supermodel Labs: friendly help, deep ergonomic care, splashes of delight, agent-first verbose modes.

**Non-goals.** Not a plugin system; not a marketplace; not a runtime. Reishi never executes skills, never edits source content without explicit user action, and never owns a target's filesystem outside the paths the user wired up. No web service, no daemon. Pull is a deliberate opt-in for tracked skills only — rules and docs are local-only constructs.

## Vocabulary

Canonical terms — keep these consistent across CLI output, errors, docs, and tests:

- **Fragment** — any individual markdown file reishi manages (a rule file, a doc file, a `SKILL.md`).
- **Source** — `~/.config/reishi/` by default. Where users edit. Always authoritative.
- **Target** — anywhere reishi writes to. Two shapes: **agents** (named, group `skills` + `rules` paths) and **projects** (named, hold a project root for docs).
- **Shared agent** — built-in agent target fixed at `~/.agents/`, opt-in via `include_shared_agent`. Path is not configurable.
- **Remote** — upstream source for tracked skills (a GitHub tree URL).
- **Sync** — local-only operation: source → targets.
- **Pull** — network operation: remote → source for tracked skills, then auto-sync.
- **Tracking** — per-skill record in the lockfile (`source_url`, `subpath`, `ref`, `sha`, `synced_at`, `prefix`) that lets `pull` reason about updates. Tracking does not surrender ownership.

## Domain specs

- @specs/cf-config.md
- @specs/sk-skills.md
- @specs/ru-rules.md
- @specs/dc-docs.md
- @specs/sy-sync.md
- @specs/dev-testing.md
- @specs/dev-ci.md

## Requirements

Project-scope requirements that don't belong to a single domain.

- **R001** — Reishi must ship as a single portable binary per platform, distributable via the `supermodellabs` Homebrew tap and Linux package managers; `deno task compile:all` must produce `darwin-arm64`, `darwin-amd64`, `linux-arm64`, `linux-amd64` artifacts and the GitHub release workflow must publish them to the tap on release.
- **R002** — Embedded assets (skill scaffold templates under `assets/`) must resolve correctly at runtime in both `deno run` and the compiled binary, by referencing `import.meta.dirname` rather than CWD.
- **R003** — All CLI output, help text, error messages, and agent docs must use the canonical vocabulary defined above; non-canonical synonyms (e.g. "destination", "library", "store") are treated as bugs.
- **R004** — Source directories are authoritative; reishi never writes to source without an explicit user-initiated command (`add`, `pull`, `new`, `move`, `remove`, `compile`).
- **R005** — Targets are output: every sync overwrites target content, and target-side edits are not preserved (the user's source copy is the only durable artifact).
- **R006** — All tests must run offline against `REISHI_CONFIG`-redirected temp dirs and fixture tarballs; no test may hit live GitHub or any other network host.
- **R007** — Interactive prompts must accept injectable callbacks so the full suite remains hermetic and terminal-independent.
- **R008** — Runtime permissions stay narrow: `--allow-run` is restricted to `tar`; `--allow-net` lists only `api.github.com` and `codeload.github.com`; `--allow-env` lists only the env vars reishi reads (`REISHI_CONFIG`, `REISHI_LOCKFILE`, `HOME`, `XDG_*`).
- **R009** — `REISHI_CONFIG` and `REISHI_LOCKFILE` must override the default config and lockfile paths respectively, with parallel semantics.

## Backlog

Future requirements, open questions, and big ideas. Not active work — promote into a Phase or delete; lingering items are noise.

### Skills linting

- Update `skills validate` to use linter/formatter semantics — `skills lint`, `skills lint --fix`. Combine deeper validation of skill spec rules with markdownlint-style markdown checks, and auto-fix where possible (table formatting, etc.). Consider extracting a `skillint` library that wraps markdownlint and adds agent-context-engineering rules. Lower-priority extension to rules and docs (pure markdown linting).

### LLM-powered features

- `refine` commands across skills, docs, and rules — configurable, template-based LLM prompt to improve sources for more effective language and structure in fewer tokens.
- `validate --audit` — semantic conflict detection: warn when two skills have overlapping tool permissions or trigger conditions.

### `checkpoint` command

- Create a git commit by funneling a diff into a template, piping that through a configurable LLM, then pushing to GH and fetching remote changes. Default template collates additions/deletions/changes in conventional-commit format with light LLM commentary on themes.

### Cross-domain external-source adoption

A consistent way to safely pull external file changes back into reishi source — across rules, docs, and skills. Today, `skills pull` handles remote → source with mtime/`synced_at` divergence protection, and the Phase 18 docs import handles a one-shot scoop at project-link time. Nothing covers "the user edited the target directly and wants those edits flowing back to source," nor re-importing project context after the initial link. Needs deep thought before scoping — it opens up diffing, conflict UX, and the question of whether sync becomes bidirectional. Open questions:

- Diffing model — show the user a per-fragment diff before merging, or batch them?
- Conflict mode — how do we surface ambiguous cases (target edited *and* source edited since last sync)?
- Scope — bidirectional sync, or strictly target-to-source pull?
- Surface — `rei <domain> reverse-sync`? `rei adopt`? Single top-level command with `--from-target`?
- Should this subsume `skills pull`'s divergence protection mechanism, or stay parallel and consistent in spirit only?

### Browsing and management UIs

These are larger investments and probably wait until the tool migrates to Go or Rust — Deno isn't the right fit for any of them.

- **TUI** — terminal UI for browsing and managing your library, launching `$EDITOR` and dropping back, doing bulk file operations.
- **fzf integration** — fuzzy search across skills, rules, and docs; preview content or open in editor.
- **Web UI** — local server for visual browsing and management; should mirror the TUI experience closely.
