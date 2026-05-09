# ru — Rules

## Goals

`ru-` covers the rules surface: a flat folder of always-on markdown rules at `rules.source` that
gets synced to every configured agent's rules path. Rules are the simplest construct — no tracking,
no frontmatter, no conditional activation, no remote source. Users manage the files directly with
their editor or filesystem tools; reishi just lists, syncs, and (in upcoming work) compiles and
renames them.

**Non-goals.** No remote fetching for rules; no per-rule frontmatter or activation rules; no
per-rule overrides. Rules apply globally.

## Requirements

### Source layout

- **ru-R001** — Rules live as flat `.md` files directly under `rules.source` (default
  `~/.config/reishi/rules/`); subdirectories are not part of the rules namespace.
- **ru-R002** — Rule names are the filename stem (no `.md`); commands accept either `<name>` or
  `<name>.md` and strip the optional trailing `.md`.

### `rei rules list`

- **ru-R010** — `rei rules list` (alias `ls`) lists every rule under `rules.source`.

### `rei rules sync`

- **ru-R020** — `rei rules sync` syncs all rules from source to every configured agent's `rules`
  path.
- **ru-R021** — Honors the sync method resolution defined in `sy-` (CLI `--method` >
  `[rules].sync_method` > global `sync_method`).
- **ru-R022** — Honors the agents filter defined in `sy-` (`--agents=<name,...>`).
- **ru-R023** — `rei rules sync --dry-run` previews target writes without changing them.
- **ru-R024** — `rei rules sync --check` reports per-rule × per-agent freshness without writing.

### Source-side CRUD — `move` and `remove`

- **ru-R030** — `rei rules move <old> <new>` (alias `mv`) renames `<rules.source>/<old>.md` →
  `<new>.md`. Flat namespace — no project or directory dimension.
- **ru-R031** — `rei rules remove <name>` (alias `rm`) deletes `<rules.source>/<name>.md`.
- **ru-R032** — Both commands accept names with or without the trailing `.md`.
- **ru-R033** — Source-only operations; target cleanup is handled by `clean_on_sync` on the next
  sync.

### Compile (Phase 14)

- **ru-R040** — `rei rules compile` concatenates every rule in `<rules.source>/` into a single
  compiled markdown file written _into source_ (so it is git-trackable and visible to the user). No
  index — well-formatted concatenation.
- **ru-R041** — The compiled file is the artifact `sync` ships when an agent target opts in to
  compilation (see `sy-R060+`).
