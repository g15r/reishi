# dc — Docs

## Goals

`dc-` covers the docs surface: project-scoped markdown docs organized under `docs.source/<project>/`, compiled into a token-efficient index per project, and synced to real project directories. Each subdirectory of `docs.source` is one project; each `.md` inside is a doc. Unlike rules and skills, docs targets are project roots — the compiled index lands at `<target>/<index_filename>` (default `AGENTS.md`) and the doc files go under `<target>/<docs.default_target>/` (default `.agents/docs/`).

**Non-goals.** No file-level remote fetching; no per-file activation; no cross-project doc sharing.

## Requirements

### Source layout

- **dc-R001** — Each subdirectory of `docs.source` is a project; the directory name is the project name. Each `.md` file directly inside the project dir is a doc.
- **dc-R002** — Doc names are the filename stem (no `.md`); commands accept either `<name>` or `<name>.md` and strip the optional trailing `.md`.

### `rei docs list`

- **dc-R010** — `rei docs list` (alias `ls`) lists every project under `docs.source`.
- **dc-R011** — `rei docs list <project>` lists every doc in that project.

### `rei docs add` (deprecated alias of `rei config link project`)

- **dc-R020** — `rei docs add <project> --target <path>` creates the project source dir under `docs.source` and writes a `[projects.<name>]` entry with the normalized path.
- **dc-R021** — Path normalization expands `~` for filesystem ops, then condenses `~/` for storage in the config.
- **dc-R022** — Help text and stderr direct users to the canonical command, `rei config link project` (see `cf-R046`).

### `rei docs remove` (project-level)

- **dc-R030** — `rei docs remove <project>` (alias `rm`) is a two-step confirmation: first removes the `[projects.<name>]` config entry, then optionally offers to delete the project's docs directory.
- **dc-R031** — Config removal is the default action; filesystem deletion is opt-in.
- **dc-R032** — Doc-level removal lives at `rei docs remove <project> <doc>` (see dc-R070).

### Index compilation

- **dc-R040** — Compilation produces a single markdown file: one heading per doc, a one-line description, and a relative link to the doc file.
- **dc-R041** — Description source order: frontmatter `description` > first non-heading paragraph > first heading.
- **dc-R042** — Docs are ordered by frontmatter `priority` descending, then alphabetically by name.
- **dc-R043** — The index respects a configurable `token_budget`; docs past the budget are omitted with a clear notice line at the end of the index.
- **dc-R044** — The compiled index goes to `<target>/<index_filename>` (default `AGENTS.md`); the doc files are placed under `<target>/<docs.default_target>/` (default `.agents/docs/`).

### `rei docs sync`

- **dc-R050** — `rei docs sync` compiles and syncs every mapped project; `rei docs sync <project>` operates on one.
- **dc-R051** — Honors sync method resolution (`sy-`): CLI `--method` > `[docs].sync_method` > global `sync_method`.
- **dc-R052** — `rei docs sync --target <path>` overrides the project's configured target for the duration of the call.
- **dc-R053** — `rei docs sync --dry-run` previews writes without changing them.
- **dc-R054** — `rei docs sync [project] --stdout` writes the compiled index to stdout instead of disk; replaces the retired `rei docs compile --stdout`.
- **dc-R055** — A project's `[projects.<name>].files` array, when present, restricts which doc files participate in compilation; otherwise every doc in the project dir is included.

### Source-side CRUD — `move` and `remove` (doc-level)

- **dc-R070** — `rei docs move <project> <old> <new>` (alias `mv`) renames `<docs.source>/<project>/<old>.md` → `<new>.md`. If the project's `[projects.<name>].files` array references `<old>.md`, it is updated in place.
- **dc-R071** — `rei docs remove <project> <doc>` (alias `rm`) deletes the `.md` under the project; project-level removal is the separate command in dc-R030.
- **dc-R072** — Both commands accept doc names with or without the trailing `.md`.
- **dc-R073** — Source-only operations; target cleanup is handled by `clean_on_sync` on the next sync.

### Compile (Phase 14)

- **dc-R080** — `rei docs compile [project]` writes the existing index *into source* (so it is git-trackable and visible) instead of straight to the target. With no project arg, compiles every mapped project.
- **dc-R081** — The compiled-in-source index is the artifact `sync` ships when an agent target opts in to compilation (see `sy-R060+`).

### Compiled index core (Phase 16)

- **dc-R090** — When a project's source dir contains a doc whose filename matches `[docs].index_filename` (case-insensitive, default `AGENTS.md`), that file is the **index core** of the compiled output: its content (frontmatter stripped) is emitted at the top, followed by the references section.
- **dc-R091** — The index core is excluded from the references list — it never appears as both inline content and a link in the same compiled output.
- **dc-R092** — If multiple files in the project source match the index filename (case-collision on a case-sensitive filesystem), compilation aborts with a clear error naming the conflicting files.
- **dc-R093** — The references section follows the index-core inline content under a stable heading (`## References`) so the boundary between user-authored core and machine-generated index is visible to human readers.
- **dc-R094** — Token-budget trimming (`dc-R043`) applies only to the references section; the index core is always emitted in full regardless of `token_budget`.
- **dc-R095** — Compilation emits a soft warning (does not fail) when the index core's token count exceeds `[docs].core_warn_tokens` (default `4000`). The warning text invites the user to consider modularizing and links to reishi's progressive-disclosure docs (placeholder URL until reishi-docs lands).
- **dc-R096** — When no index core exists, the compiled output is the link-only index — existing pre-Phase-16 behavior, fully preserved.

### Target overwrite protection (Phase 17)

- **dc-R100** — The compiled index emitted to a project target ends with a stable trailing HTML-comment marker: `<!-- managed by reishi · source: <docs.source>/<project>/ -->`. The marker is the on-disk signal that reishi authored the file.
- **dc-R101** — On `rei docs sync`, if the target index file exists and does not contain the reishi marker, sync copies the existing file to `<target>/<index_filename>.reishi-backup` before overwriting. If `<index_filename>.reishi-backup` already exists, the new backup is suffixed (`<name>.reishi-backup_2`, `_3`, ...) — never clobber a previous backup.
- **dc-R102** — If the target index file contains the reishi marker, sync overwrites it directly (no backup — reishi authored it).
- **dc-R103** — When a backup is written, sync prints a clear notice: `📦 backed up <path> → <path>.reishi-backup`.
- **dc-R104** — There is no flag to disable the backup. The operation is cheap and idempotent; the backup file is easy for the user to delete manually if unwanted.

### Heterogeneous doc import on project link (Phase 18)

- **dc-R110** — When `rei config link project <name> --target <path>` runs, reishi runs **discovery** over the target — a read-only scan for existing context files. If any are found and the project source dir is empty, an interactive prompt offers: `Found N context files at <target>. Import as starting docs? (Y/n)`. The flags `--import` and `--no-import` skip the prompt.
- **dc-R111** — Default discovery patterns:
  - Top-level files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CODEX.md`, `.cursorrules`, `CONVENTIONS.md`, `.github/copilot-instructions.md`.
  - Recursive `.md` files under: `.claude/`, `.cursor/`, `.agents/`, `.docs/`, `docs/`.
- **dc-R112** — Files matching `[docs].index_filename` (case-insensitive) at the target root are imported into the project source dir under that exact filename, so they become the index core per `dc-R090`.
- **dc-R113** — Other imports are renamed by path-flattening: top-level files keep their stem (`CLAUDE.md` → `CLAUDE.md`); nested files use `<dir>-<stem>.md` (e.g. `.claude/rules/foo.md` → `claude-rules-foo.md`, `docs/architecture/db.md` → `docs-architecture-db.md`).
- **dc-R114** — On naming collisions among imported files, the second-and-later collisions get numeric suffixes (`<name>_2.md`, `_3`, ...). Never overwrite a previously imported file mid-import.
- **dc-R115** — Import is non-destructive at the target — files are read, never moved or deleted by the import step itself.
- **dc-R116** — If the target index file (e.g. `<target>/AGENTS.md`) is among the imports, reishi also copies the original to `<target>/<index_filename>.reishi-backup` before the link command completes — providing a pre-reishi snapshot regardless of when first sync runs.
- **dc-R117** — On import, reishi prints a per-file summary listing source path → imported doc name (e.g. `✓ imported 7 files: AGENTS.md → AGENTS.md, .claude/rules/foo.md → claude-rules-foo.md, ...`).
- **dc-R118** — If `--import` is set but the project source dir already contains docs, the link command exits with a clear error (no overwrite, no merge in v1) and points the user at manual `rei docs` commands. Re-import tooling lives in the cross-domain external-source-adoption backlog item.
