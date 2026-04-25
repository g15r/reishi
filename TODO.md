# reishi TODO

## Phase 9: Vocabulary and Shared Agent ✅

Two parallel foundations for the v1 release: locking down canonical terminology before writing any docs, and adding the `shared` built-in target.

### Establish canonical vocabulary

Define and propagate consistent language across all CLI output and docs. Core glossary: **fragments** (any individual markdown file reishi manages), **targets** (agents and projects collectively), **source** (`~/.config/reishi/` — where users work), **remotes** (where tracked skills are pulled from), **sync** (writing fragments from source to targets), **pull** (fetching from a remote).

- [x] Write a terminology reference doc at `~/.agents/docs/reishi-vocabulary.md` for use in future sessions
- [x] Audit existing CLI help text and agent-facing docs for non-canonical terms
- [x] Update help text, error messages, and agent docs to use canonical terms throughout

### Implement `shared` agent target

`shared` is a built-in, non-configurable agent target that always points to `~/.agents/`. Users opt in via `include_shared_agent: true` in their config. This is set to `true` by default in `config init` output.

- [x] Write failing tests for `shared` as a built-in target at `~/.agents/` with no configurable path
- [x] Add `include_shared_agent` boolean to the config schema
- [x] Update sync logic to include `~/.agents/` when `include_shared_agent` is `true`
- [x] Set `include_shared_agent = true` explicitly in the `config init` default output

## Phase 10: Config UX ✅

Ship a friendly, well-commented default config and the escape hatch for users who want it clean.

### Documented default config

- [x] Draft a commented config template written for a brand-new user reading it for the first time
- [x] Update `config init` to output the commented template by default
- [x] Use canonical vocabulary from Phase 9 throughout all comments

### `--no-comment` flag for `config init`

- [x] Write failing tests for `-c`/`--no-comment` flag behavior
- [x] Implement `-c`/`--no-comment` flag that outputs a clean, comment-free config

## Phase 11: Open Source Documentation ✅

Three parallel deliverables. All should use Phase 9 canonical vocabulary.

### README

- [x] Audit the existing README: identify what's accurate, what's stale, and what's missing (no prior README existed; created from scratch)
- [x] Draft a structure with ToC: install, core concepts, quick start, key commands, blessed patterns, philosophy
- [x] Write the README — concise prose, tables for reference material, callouts for important notes
- [x] Add an Issues vs. Discussions section: prefer Discussions for ideas and questions; Issues only when a concrete, reproducible change can be clearly described; note that poorly-formed Issues and PRs ignoring contribution guidelines will be auto-closed — frame this warmly as care for a healthy OSS ecosystem, not gatekeeping
- [x] Secondary pass focused on information order: most important first, reference material last; verify all anchor links

### SECURITY.md

Formal but minimal — reishi reads and writes markdown files and a TOML config; the main risk is users accidentally putting secrets in agent context files. Belt-and-suspenders coverage for an OSS project.

- [x] Write a brief threat model: the real risk is user error (secrets in fragments), not attack surface in the tool itself
- [x] Note the one meaningful vector: remote skill sources (users should only pull from remotes they trust)
- [x] Add vulnerability reporting instructions (GitHub private advisory or email) and expected response timeline

### CONTRIBUTING.md and LICENSE

- [x] Add Apache 2.0 `LICENSE` file
- [x] Write `CONTRIBUTING.md` with these sections:
  - Getting started: clone, install deps, run tests, create a feature branch
  - Commit style: conventional commits only (link to spec), enforced by CI
  - History: linear history required — rebase onto main, no merge commits
  - PR process: GHA checks require manual approval by a contributor for unknown contributors — new contributors should expect a short wait for triage process to approve or potentially decline
  - PR titles: conventional commit style titles to support squash merges, for small sets of meaningful commits we merge with rebase, for larger commits we use squash, with "PR title + commit"-style squash commit messages (noisy commits should be edited out of the generated commit list in the message body)
  - Issues and Discussions: mirrors the README guidance — Discussions first, Issues only for clear actionable changes
  - Design principles and anti-goals (keep it tight, reference the README philosophy section)

## Backlog

### Expansions

- [ ] TUI - terminal UI for browsing and managing your library in the terminal, probably only really viable if the tool eventually migrates to Go or Rust. The value is browsing and launching your editor and dropping back into the TUI and doing more management, or doing bulk file operations, etc. Deno is not the ideal tool for any of this.
- [ ] Web UI — local server for browsing and managing your library visually, Deno could be good for this, but it should probably mirror the TUI experience closely, so these are post-refactor features
- [ ] `move`, `mv` commands — rename a skill, doc or rule and update all references and configs, selected by name within the reishi source (`rei rules mv cool-rule awesome-rule` as rules are flat, `rei docs mv my-project/api` as projects are nested under `~/.config/reishi/docs`, NOTE: we idiomatically drop the `.md` extension as all files are markdown in reishi, but we accept the same path with an `.md` as well, we just use a helper to strip it whenever a command arg is a fragment)
- [ ] config-focused `move`, `mv` commands — rename targets: agents or
- [ ] `checkpoint` command - create a git commit by funneling a diff into a template then piping that to an LLM you define (defaults for both), then push that to GH remote and fetch any changes, new branches, etc. on the remote -- our default template basically collates a nice summary of additions, deletions, and changes in conventional commit format, with some basic commentary from an LLM reviewing for any themes. Date and time are captured by git of course.
- [ ] update `skills validate` namespace to use linter/formatter semantics, maybe using a deeper validation of both skill spec rules and markdown style (based on markdownlint), as well as the ability to auto-fix certain issues (like incorrect table formatting, maybe run markdownlint-cli2 --fix and then re-validate until no more issues are found, if we can access that as a library dependency that'd be ideal) -- `skills lint`, `skills lint --fix` -- could be useful for rules and docs too but lower priority as it's just pure markdown linting and formatting in that case really, we should consider if wrapping markdownlint is useful or not -- could potentially make a `skillint` library for this tool to import and use that wraps some markdownlint functionality but add extra rules and features for agent context engineering

#### LLM-powered features

- [ ] add `refine` commands to all our types (skills, docs, rules) that use a configurable, template-based LLM prompt to improve whatever sources are selected for more effective language + structure in less tokens
- [ ] Add `validate --audit` semantic conflict detection — warn when two skills have overlapping tool permissions or trigger conditions
