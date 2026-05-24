# reishi — SPEC

## Goals

reishi is a **library manager for agent context**. The user curates a single library of rules,
skills, and profiles in one place; reishi controls what's _active_ when and where, and distributes
the active set to whichever agent tools the user runs. Library is the load-bearing noun — every
artifact is a library item; every action is a curation, activation, or distribution operation.

The brand vibe is approachable Supermodel Labs: friendly help, deep ergonomic care, splashes of
delight, agent-first verbose modes. Reishi is for dotfiles nerds and compulsive organizers — people
who want a clean, queryable global library and surgical control over what shows up in front of an
agent.

**Non-goals.** Not a plugin system; not a marketplace; not a runtime. Reishi never executes skills,
never edits source content without explicit user action, and never owns a target's filesystem
outside the paths the user wired up. No web service, no daemon — activation evaluates at
command-time, not on filesystem events. No project-scoped context: reishi has no awareness of
project roots and never scans the contents of any file outside its own source dir (file _presence_
is as granular as detection gets, via path conditions). No `compile` step: artifacts ship to agent
targets as-is.

## Vocabulary

Canonical terms — keep these consistent across CLI output, errors, docs, and tests. Non-canonical
synonyms (e.g. "destination", "store", "fragment", "doc", "project") are treated as bugs.

- **Library** — the curated collection of rules, skills, and profiles managed by reishi. The unit
  the user thinks about and operates on.
- **Source** — `~/.config/reishi/` by default. The library on disk. Always authoritative.
- **Rule** — a markdown file under `rules.source`. Agent loads rules into context every session;
  reishi controls _which_ rules land in each agent target.
- **Skill** — a directory under `skills.source` containing `SKILL.md` plus optional supporting
  files. Agent description-loads skills and body-loads on demand; reishi controls _which_ skills
  are available to each agent target.
- **Profile** — a TOML artifact under `profiles.source` that groups rules and skills under a shared
  set of activation conditions. The mechanism for "preload this bundle when I'm working in domain
  X."
- **Activation** — the mechanism that decides whether a library item is currently _active_.
  Evaluated at command-time (sync, status, agent-launch hook).
- **Conditions** — typed triggers that drive activation. v1 types: `manual` (set by `rei use`),
  `path` (cwd glob match), `agent` (named agent currently being addressed).
- **Active / inactive** — current state of a library item under the current evaluation context. An
  item with no conditions is active by default; an item with conditions is active when any of them
  evaluates true.
- **Agent target** — a `[agents.<name>]` entry that holds `skills` and `rules` paths. Reishi
  distributes active items here.
- **Shared agent** — built-in agent target fixed at `~/.agents/`, opt-in via
  `include_shared_agent`. Path is not configurable.
- **Sync** — local-only operation: materializes the current active set into agent targets. Writes
  active items, removes items no longer active.
- **Remote** — upstream source for tracked skills (a GitHub tree URL).
- **Pull** — network operation: remote → source for tracked skills, then auto-sync.
- **Tracking** — per-skill record in the lockfile (`source_url`, `subpath`, `ref`, `sha`,
  `synced_at`, `prefix`) that lets `pull` reason about updates. Tracking does not surrender
  ownership — the user's source copy is always authoritative.

## Domain specs

- @specs/cf-config.md
- @specs/lb-library.md
- @specs/ac-activation.md
- @specs/sk-skills.md
- @specs/ru-rules.md
- @specs/sy-sync.md
- @specs/dev-testing.md
- @specs/dev-ci.md

## Requirements

Project-scope requirements that don't belong to a single domain.

- **R001** — Reishi must ship as a single portable binary per platform, distributable via the
  `supermodellabs` Homebrew tap and Linux package managers; `deno task compile:all` must produce
  `darwin-arm64`, `darwin-amd64`, `linux-arm64`, `linux-amd64` artifacts and the GitHub release
  workflow must publish them to the tap on release.
- **R002** — Embedded assets (skill scaffold templates under `assets/`) must resolve correctly at
  runtime in both `deno run` and the compiled binary, by referencing `import.meta.dirname` rather
  than CWD.
- **R003** — All CLI output, help text, error messages, and agent docs must use the canonical
  vocabulary defined above; non-canonical synonyms are treated as bugs.
- **R004** — Source directories are authoritative; reishi never writes to source without an
  explicit user-initiated command (`add`, `pull`, `new`, `move`, `remove`).
- **R005** — Agent targets are output: every sync overwrites target content, and target-side edits
  are not preserved (the user's source copy is the only durable artifact).
- **R006** — All tests must run offline against `REISHI_CONFIG`-redirected temp dirs and fixture
  tarballs; no test may hit live GitHub or any other network host.
- **R007** — Interactive prompts must accept injectable callbacks so the full suite remains
  hermetic and terminal-independent.
- **R008** — Runtime permissions stay narrow: `--allow-run` is restricted to `tar`; `--allow-net`
  lists only `api.github.com` and `codeload.github.com`; `--allow-env` lists only the env vars
  reishi reads (`REISHI_CONFIG`, `REISHI_LOCKFILE`, `HOME`, `XDG_*`).
- **R009** — `REISHI_CONFIG` and `REISHI_LOCKFILE` must override the default config and lockfile
  paths respectively, with parallel semantics.
- **R010** — Options whose argument is a filesystem path (`--path`, `--skills`, `--rules`, `--out`)
  must declare it with Cliffy's built-in `file` type (e.g. `<path:file>`), so generated bash, fish,
  and zsh completion scripts emit shell-native path completion (`compgen -f/-d`,
  `__fish_complete_path`, `_files`) for those flags. Path completion is provided through Cliffy's
  completion generator only — no hand-written shell snippets injected outside it.
- **R011** — Reishi has no daemon and no shell-resident hooks of its own; activation evaluates only
  when a reishi command runs (or when an external integration — e.g. an agent-launch hook the user
  wires up — invokes a reishi entry point). The CLI is the only execution surface.
- **R012** — Reishi never reads the contents of files outside its own source dir. Detection of
  project context is path-based only (file/dir presence checks at configured paths). No parsing,
  no scanning, no introspection of arbitrary user files.

## Backlog

Future requirements, open questions, and big ideas. Not active work — promote into a Phase or
delete; lingering items are noise.

### Hint nudges for inactive matches

- When the user lists the library or runs status, surface "you have profile X whose conditions
  match here but is currently inactive — `rei use X` to activate." Low-friction discoverability
  for the magical-but-explicit activation model. Belongs in `lb-` once the library surface lands.

### Token compression of always-on rules

- A compiler pass over active rules that strips redundancy (caveman-speak templates, shared
  fragment substitution) before they ship to agent targets, so the always-on context budget stays
  small as the rules library grows. Deferred until the activation/profile redesign is in place; we
  want to see real usage patterns first.

### More condition types

- `git-state` (branch match, worktree clean/dirty, ahead/behind), `env` (env var presence /
  match), `time` (time-of-day or day-of-week). Each adds surface, so wait for concrete demand
  before scoping.

### Skills linting

- Update `skills validate` to use linter/formatter semantics — `skills lint`, `skills lint --fix`.
  Combine deeper validation of skill spec rules with markdownlint-style markdown checks, and
  auto-fix where possible (table formatting, etc.). Consider extracting a `skillint` library that
  wraps markdownlint and adds agent-context-engineering rules. Lower-priority extension to rules
  (pure markdown linting).

### LLM-powered creation and improvement

- `refine` commands across skills, rules, and profiles — configurable, template-based LLM prompt
  to improve sources for more effective language and structure in fewer tokens, audit permissions,
  etc.
- `audit` — operates across the library, looking for semantic conflict detection, overlap,
  misaligned permissions, etc. Particularly useful for spotting rules and skills that should be
  grouped into a profile, or profiles whose members no longer cohere.
- some potential techniques: using description and first paragraph to pin purpose, then evaluating
  the full item and references based on this
  - potentially configure logfile sources for agent targets, and use them to surface skills that
    are not being triggered or used (not necessarily a problem, some skills are just rarely
    triggered, but useful signal)
- `skills new -i/--interactive` and `profiles new -i/--interactive` once validation and
  improvement are working well, the same refinement loop drives an interactive create flow:
  1. distill purpose
  2. determine scope boundaries
  3. research and synthesize
  4. feedback
  5. refine
  6. validate

Full custom evals are out of scope for the tool as currently envisioned. They are truly useful,
but also present too many new surfaces and constructs to support without significantly
complicating the codebase. A complementary tool down the road might be an option.

### `checkpoint` command

- Create a git commit by funneling a diff into a template, piping that through a configurable LLM,
  then pushing to GH and fetching remote changes. Default template collates
  additions/deletions/changes in conventional-commit format with light LLM commentary on themes.

### Cross-source adoption for skills

A consistent way to safely pull external skill changes back into reishi source. Today,
`skills pull` handles remote → source with mtime/`synced_at` divergence protection. Nothing
covers "the user edited the synced skill in an agent target and wants those edits flowing back to
source." Needs deep thought before scoping — it opens up diffing, conflict UX, and the question
of whether sync becomes bidirectional. Open questions:

- Diffing model — show the user a per-file diff before merging, or batch them?
- Conflict mode — how do we surface ambiguous cases (target edited _and_ source edited since last
  sync)?
- Scope — bidirectional sync, or strictly target-to-source pull?
- Surface — `rei skills reverse-sync`? `rei adopt`? Single top-level command with `--from-target`?
- Should this subsume `skills pull`'s divergence protection mechanism, or stay parallel and
  consistent in spirit only?

### Browsing and management UIs

Library is the load-bearing concept — these are the natural surfaces once the CLI is solid.
Larger investments, probably wait until the tool migrates to Go or Rust — Deno isn't the right
fit for any of them.

- **TUI** — terminal UI for browsing and managing the library, launching `$EDITOR` and dropping
  back, doing bulk activation operations, flipping profiles on and off.
- **fzf integration** — fuzzy search across rules, skills, and profiles; preview content or open
  in editor.
- **Web UI** — local server for visual browsing and management; should mirror the TUI experience
  closely.
