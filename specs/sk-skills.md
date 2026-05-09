# sk — Skills

## Goals

`sk-` covers the skills surface: scaffolding, installing, validating, activating, deactivating,
listing, and the network operations that pull tracked skills from their remotes. Skills are the most
complex of the three constructs — they have frontmatter, multi-file directories, optional remote
tracking, prefix-based namespacing for multi-skill repos, and divergence-protected updates.

**Non-goals.** No skill execution; no skill marketplace; no skill discovery. Pull is opt-in
per-skill via `--track`. Tracking does not surrender ownership — the user's source copy is always
authoritative.

## Requirements

### Source layout

- **sk-R001** — Active skills live as directories directly under `skills.source`; deactivated skills
  live under `<skills.source>/_deactivated/` with the same directory shape.
- **sk-R002** — Each skill directory must contain a `SKILL.md` with valid frontmatter; supporting
  files (`scripts/`, `assets/`, modular markdown) are arbitrary.
- **sk-R003** — Skill names are lowercase letters, digits, and hyphens; no
  leading/trailing/consecutive hyphens; max 64 chars. When a prefix is present the prefix portion
  and skill portion each independently pass the same rules; the `prefix_separator` (default `_`) is
  allowed only between them.

### `rei skills new`

- **sk-R010** — `rei skills new <name>` scaffolds a minimal skill from the embedded template — a
  single `SKILL.md` — into `skills.source/<name>/`. No example resource files or subdirectories are
  created; users add `scripts/`, `assets/`, or `references/` themselves when needed.
- **sk-R011** — `rei skills new <name> --path <dir>` scaffolds into the given dir; auto-sync to
  targets only fires when `--path` resolves inside `skills.source`.
- **sk-R012** — The embedded `SKILL.md` template must resolve from the compiled binary as well as
  `deno run`.
- **sk-R013** — The `SKILL.md` template body teaches the conventional skill-layout patterns
  thoroughly enough that users can add the right structure on demand without consulting external
  docs. Modular reference docs live flat alongside `SKILL.md` (e.g. `cool-skill/SKILL.md`,
  `cool-skill/api-design.md`); `scripts/` (executables) and `assets/` (output artifacts) remain as
  subdirectory conventions. The `references/` subdirectory is not a reishi convention and must not
  appear in the template. Guidance is descriptive (when to reach for each, with concrete examples)
  rather than prescriptive (no boilerplate to delete).

### `rei skills validate`

- **sk-R020** — `rei skills validate <path>` checks structure and frontmatter; reports clear errors
  for missing `SKILL.md`, invalid YAML, or missing required frontmatter keys.

### `rei skills add`

- **sk-R030** — `rei skills add <github-tree-url>` installs a single skill or every skill under a
  directory in the repo, fetching via the GitHub tarball codeload endpoint.
- **sk-R031** — `rei skills add -t` (track) writes a `[skills.<name>]` entry to the lockfile with
  `source_url`, `subpath`, `ref`, `sha`, `synced_at`, and (if used) `prefix`.
- **sk-R032** — For multi-skill repos, tracked add writes one lockfile entry per skill; all entries
  share `source_url` and `ref` but each has its own `subpath`.
- **sk-R033** — Re-adding a tracked skill updates its existing lockfile entry's `synced_at` rather
  than duplicating it.
- **sk-R034** — `rei skills add -p` (prefix) prefixes installed skill names. Without a value, the
  prefix is inferred from the GitHub org/user; with a value (`--prefix=foo`), that value is used.
  Respect global `default_prefix` and `prefix_separator`.
- **sk-R035** — Prefixed install renames each installed directory to `{prefix}{separator}{name}`.
- **sk-R036** — On successful tracked install, print a confirmation line referencing source, sync
  time, and config location.
- **sk-R037** — After install, auto-sync to targets fires unless `--path` is outside
  `skills.source`.

### `rei skills list / activate / deactivate`

- **sk-R040** — `rei skills list` lists active skills; `-a` lists active and deactivated together.
- **sk-R041** — `rei skills activate <name>` moves the skill out of `_deactivated/` back to
  `skills.source/`; auto-syncs to targets after.
- **sk-R042** — `rei skills deactivate <name>` moves the skill into `_deactivated/`; removes the
  skill from every target as part of the same operation.

### Tracking and `rei skills pull`

- **sk-R050** — `rei skills pull` is the only network operation in the skills surface. `rei sync`
  and `rei skills sync` are local-only.
- **sk-R051** — `rei skills pull` (no arg) pulls every tracked skill; `rei skills pull <name>` pulls
  just that one.
- **sk-R052** — Pull probes `GET /repos/{owner}/{repo}/commits/{ref}` for the remote HEAD SHA before
  downloading. If it matches the lockfile's `sha`, no tarball is fetched and the lockfile is left
  untouched.
- **sk-R053** — When the SHA differs (or lockfile has no SHA yet), pull downloads the tarball,
  extracts the `subpath`, and merges into source with divergence protection (see sk-R060+).
- **sk-R054** — On a successful download, the lockfile's `sha` and `synced_at` advance together; the
  write only happens when state actually changed (dirty-bit semantics).
- **sk-R055** — `rei skills pull --dry-run` previews the upstream diff and skips both write and
  auto-sync.
- **sk-R056** — `rei skills pull --check` performs the SHA probe only — reports which tracked skills
  have remote updates without downloading.
- **sk-R057** — On success, pull auto-syncs to targets; `--dry-run` skips the auto-sync.
- **sk-R058** — `rei skills pull` triggers print a `printPullSummary` block covering both fetch and
  sync outcomes.

### Divergence protection

- **sk-R060** — Pull merges source file-by-file. Files unchanged locally (`mtime <= synced_at`) are
  overwritten with the remote version.
- **sk-R061** — Files modified locally (`mtime > synced_at`) are preserved in place; the remote
  version is saved alongside as `<stem>_<N><ext>`, where `_N` is the next free integer up to 1000
  (`SKILL.md` → `SKILL_1.md`, then `_2`, `_3`, ...).
- **sk-R062** — `_N`-suffixed files are user-facing artifacts and are never themselves reconsidered
  for removal or further suffixing on subsequent pulls.
- **sk-R063** — If a file was removed upstream and the user has not touched it since `synced_at`, it
  is removed locally; otherwise it is kept.
- **sk-R064** — Pull prints a `🛡 Protected N locally-modified files:` summary listing
  `original → savedAs` pairs.
- **sk-R065** — Pull never destroys user work. There is no `--force` flag for skill pulls.

### Prefix-change resolution

- **sk-R070** — When a user edits the lockfile `prefix` for a tracked skill, the next `pull` detects
  the mismatch between the stored prefix and the current source dir prefix.
- **sk-R071** — Interactive flow: prompt 1
  `Prefix for X changed from 'old' to 'new'. Confirm? (y/N)`; on confirm, prompt 2
  `Rename existing or install in parallel? (r/p/N)`.
- **sk-R072** — Rename mode renames source dir, deactivated dir if present, every target dir, and
  re-keys the lockfile and any `[skill_overrides.<name>]` entry.
- **sk-R073** — Parallel mode leaves the old skill in place; the new prefixed entry is created and
  populated by the upstream fetch.
- **sk-R074** — `rei skills pull --prefix-change=rename|parallel|abort` pre-decides the resolution
  non-interactively.
- **sk-R075** — Prefix-change detection runs _before_ the upstream fetch in the pull flow so
  parallel mode populates the new-name dir.
- **sk-R076** — `--dry-run` previews the would-be rename without writing.

### Update polling

- **sk-R080** — `[updates].enabled` toggles all polling; `[updates].interval_hours` controls
  cadence.
- **sk-R081** — `[skill_overrides.<name>].updates = false` disables polling for an individual skill.
- **sk-R082** — `checkForUpdates` is a pure read: it fetches the remote SHA per tracked skill and
  reports `{ hasUpdate, remoteSha, previousSha }` without writing the lockfile.

### Source-side CRUD — `move` and `remove`

- **sk-R090** — `rei skills move <old> <new>` (alias `mv`) renames the source skill dir, rewrites
  the skill key in the lockfile, and rewrites any matching `[skill_overrides.<name>]` entry.
- **sk-R091** — `rei skills remove <name>` (alias `rm`) deletes the source dir, drops any matching
  lockfile entry, and drops any matching `[skill_overrides.<name>]` entry from the config.
- **sk-R092** — `move` and `remove` accept the bare name with or without a trailing `.md` is not
  relevant for skills (skills are dirs); the trailing-`.md` helper applies to `rules` and `docs`
  only.
- **sk-R093** — Source-side `move` and `remove` operate on source only; target-side cleanup is
  handled by `clean_on_sync` (see `sy-`) on the next sync.
