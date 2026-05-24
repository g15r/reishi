# lb — Library

## Goals

`lb-` owns the top-level `rei library` surface — the cross-artifact view of the curated
collection. "Library" is reishi's load-bearing noun (R003), and the `library` subcommand is the
single place a user goes to ask "what's in here, what's active, what can I activate." Per-artifact
commands (`rei rules`, `rei skills`, `rei profiles`) remain the workhorses for CRUD within one
type; `rei library` is the cross-cutting browse and search surface.

**Non-goals.** No CRUD here — adding, editing, and removing items happens in the per-artifact
domains. No interactive UI (TUI/fzf live in the backlog). No remote discovery — this surface
covers the local library only; remote-source operations live in `sk-` (skills pull).

## Requirements

### `rei library` summary

- **lb-R001** — `rei library` (alias `lib`) with no subcommand prints a one-screen summary:
  total counts per artifact type, total active count, and a one-line pointer to `library list`
  and `library search`.

### `rei library list`

- **lb-R010** — `rei library list` (alias `ls`) lists every rule, skill, and profile in the
  library with columns: name, type, description (truncated), active state, and the activation
  driver for active items (e.g. `via path`, `via profile rust`, `no conditions`).
- **lb-R011** — `--type=<rule|skill|profile>` filters output to one artifact type.
- **lb-R012** — `--active` shows only currently-active items; `--inactive` shows only
  currently-inactive items. The two flags are mutually exclusive.
- **lb-R013** — `--agent=<name>` evaluates activation as if the named agent were being addressed
  (so `agent` conditions and `[agents.<name>].default_profiles` are factored in). Default
  evaluation context is "no agent addressed."
- **lb-R014** — Output is human-pretty by default with aligned columns and color cues for
  active/inactive state.
- **lb-R015** — `--json` emits the same data as a JSON array for machine consumption; no
  decoration, stable field names.
- **lb-R016** — `--profiles=<name,...>` filters output to library items that are members of at
  least one of the named profiles (via `members.rules` / `members.skills`). When `--type=profile`
  is also set, `--profiles` is a no-op for those rows — profiles themselves are not members of
  other profiles.
- **lb-R017** — `--filter <substring>` filters output by case-insensitive substring match
  against item name and description. Lighter than `search` — no match-field metadata, no
  member-name searching, just a quick pruning filter that composes with the other flags.
  `--filter work` matches `worktree` and `working-with-rust-async`; excludes `goroutines`.

### `rei library search`

- **lb-R020** — `rei library search <query>` performs case-insensitive substring matching across:
  item name, description (from frontmatter `description` for skills, profile `description`
  field, or first non-heading paragraph for rules), and member names (for profiles).
- **lb-R021** — Search respects the same `--type`, `--active`, `--inactive`, `--agent`,
  `--profiles`, and `--json` filters as `list` (lb-R011 – lb-R016). `--filter` is not accepted
  on `search` — the positional query already serves that role.
- **lb-R022** — Search results highlight the matched term in human-pretty output; `--json`
  emits a `match_field` per result indicating which field hit.

### `rei library show`

- **lb-R030** — `rei library show <name>` resolves the name across artifact types and prints the
  full item: rule body, skill frontmatter + entry-point body, or profile contents (members +
  conditions + active state).
- **lb-R031** — Ambiguity (name resolves to more than one artifact type) prompts the user to
  disambiguate with `rule:`, `skill:`, or `profile:` prefix.

### Cross-cutting behavior

- **lb-R040** — `rei library` commands are pure reads — no writes, no network, no auto-sync.
- **lb-R041** — Activation state surfaced by `list` and `search` reflects the result of running
  the activation engine (ac-R030 – ac-R033) under the current evaluation context.
