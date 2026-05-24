# ru — Rules

## Goals

`ru-` covers the rules surface: a flat folder of markdown rules at `rules.source` that the
activation engine (`ac-`) gates and sync (`sy-`) ships to agent targets. Rules carry no
frontmatter and no tracking — users manage the files directly with their editor or filesystem
tools; reishi handles listing, activation, distribution, and CRUD bookkeeping. Activation
parity with skills means a rule's default behavior (no conditions = always active) ships every
rule to every agent unless overrides narrow that scope.

**Non-goals.** No remote fetching for rules; no per-rule frontmatter; no rule-level
divergence protection (rules aren't tracked, so there's no `synced_at` to compare against);
no compile step.

## Requirements

### Source layout

- **ru-R001** — Rules live as flat `.md` files directly under `rules.source` (default
  `~/.config/reishi/rules/`); subdirectories are not part of the rules namespace.
- **ru-R002** — Rule names are the filename stem (no `.md`); commands accept either `<name>`
  or `<name>.md` and strip the optional trailing `.md`.

### `rei rules list`

- **ru-R010** — `rei rules list` (alias `ls`) lists every rule under `rules.source` with
  columns: name, description (first non-heading paragraph, truncated), current active state,
  and the activation driver for active rules.
- **ru-R011** — `rei rules list --active` shows only currently-active rules; `--inactive`
  shows only currently-inactive rules. The two flags are mutually exclusive.
- **ru-R012** — `rei rules list --agent=<name>` evaluates activation as if the named agent
  were being addressed (mirrors `lb-R013`).

### `rei rules sync`

- **ru-R020** — `rei rules sync` materializes the active rule set to every configured agent's
  `rules` path (per `sy-R020`).
- **ru-R021** — Honors the sync method resolution defined in `sy-` (CLI `--method` >
  `[rules].sync_method` > `[rule_overrides.<name>].sync_method` > global `sync_method`).
- **ru-R022** — Honors the agents filter defined in `sy-` (`--agents=<name,...>`).
- **ru-R023** — `rei rules sync --dry-run` previews target writes without changing them.
- **ru-R024** — `rei rules sync --check` reports per-rule × per-agent freshness (per `sy-R050`).

### Activation aliases

- **ru-R030** — `rei rules activate <name>` is a thin alias for `rei use <name>` scoped to a
  rule — sets the manual condition (`ac-R040`) for that rule.
- **ru-R031** — `rei rules deactivate <name>` is the inverse alias for `rei unuse <name>`
  scoped to a rule.

### Source-side CRUD — `move` and `remove`

- **ru-R040** — `rei rules move <old> <new>` (alias `mv`) renames `<rules.source>/<old>.md` →
  `<new>.md`. Rewrites any matching `[rule_overrides.<name>]` entry in config and updates any
  `members.rules` reference in any profile.toml that mentioned the old name.
- **ru-R041** — `rei rules remove <name>` (alias `rm`) deletes `<rules.source>/<name>.md`,
  drops any matching `[rule_overrides.<name>]` entry, and removes the name from any
  `members.rules` list in any profile.toml that referenced it.
- **ru-R042** — Both commands accept names with or without the trailing `.md`.
- **ru-R043** — Source-only operations; agent target cleanup is handled by the next sync
  (active-set materialization removes the now-missing item) or by `clean_on_sync` for any
  straggler that escaped the active-set walk.
