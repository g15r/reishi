# dc — Docs

## Goals

`dc-` covers the docs surface: project-scoped markdown fragments organized under `docs.source/<project>/`, compiled into a token-efficient index per project, and synced to real project directories. Each subdirectory of `docs.source` is one project; each `.md` inside is a fragment. Unlike rules and skills, docs targets are project roots — the compiled index lands at `<target>/<index_filename>` (default `AGENTS.md`) and fragments go under `<target>/<docs.default_target>/` (default `.agents/docs/`).

**Non-goals.** No fragment-level remote fetching; no per-fragment activation; no cross-project fragment sharing.

## Requirements

### Source layout

- **dc-R001** — Each subdirectory of `docs.source` is a project; the directory name is the project name. Each `.md` file directly inside the project dir is a fragment.
- **dc-R002** — Fragment names are the filename stem (no `.md`); commands accept either `<name>` or `<name>.md` and strip the optional trailing `.md`.

### `rei docs list`

- **dc-R010** — `rei docs list` (alias `ls`) lists every project under `docs.source`.
- **dc-R011** — `rei docs list <project>` lists every fragment in that project.

### `rei docs add` (deprecated alias of `rei config link project`)

- **dc-R020** — `rei docs add <project> --target <path>` creates the project source dir under `docs.source` and writes a `[projects.<name>]` entry with the normalized path.
- **dc-R021** — Path normalization expands `~` for filesystem ops, then condenses `~/` for storage in the config.
- **dc-R022** — Help text and stderr direct users to the canonical command, `rei config link project` (see `cf-R046`).

### `rei docs remove` (project-level)

- **dc-R030** — `rei docs remove <project>` (alias `rm`) is a two-step confirmation: first removes the `[projects.<name>]` config entry, then optionally offers to delete the project's docs directory.
- **dc-R031** — Config removal is the default action; filesystem deletion is opt-in.
- **dc-R032** — Fragment-level removal lives at `rei docs remove <project> <fragment>` (see dc-R070).

### Index compilation

- **dc-R040** — Compilation produces a single markdown file: one heading per fragment, a one-line description, and a relative link to the fragment file.
- **dc-R041** — Description source order: frontmatter `description` > first non-heading paragraph > first heading.
- **dc-R042** — Fragments are ordered by frontmatter `priority` descending, then alphabetically by name.
- **dc-R043** — The index respects a configurable `token_budget`; fragments past the budget are omitted with a clear notice line at the end of the index.
- **dc-R044** — The compiled index goes to `<target>/<index_filename>` (default `AGENTS.md`); fragments are placed under `<target>/<docs.default_target>/` (default `.agents/docs/`).

### `rei docs sync`

- **dc-R050** — `rei docs sync` compiles and syncs every mapped project; `rei docs sync <project>` operates on one.
- **dc-R051** — Honors sync method resolution (`sy-`): CLI `--method` > `[docs].sync_method` > global `sync_method`.
- **dc-R052** — `rei docs sync --target <path>` overrides the project's configured target for the duration of the call.
- **dc-R053** — `rei docs sync --dry-run` previews writes without changing them.
- **dc-R054** — `rei docs sync [project] --stdout` writes the compiled index to stdout instead of disk; replaces the retired `rei docs compile --stdout`.
- **dc-R055** — A project's `[projects.<name>].fragments` array, when present, restricts which fragments participate in compilation; otherwise every fragment in the project dir is included.

### Source-side CRUD — `move` and `remove` (fragment-level)

- **dc-R070** — `rei docs move <project> <old> <new>` (alias `mv`) renames `<docs.source>/<project>/<old>.md` → `<new>.md`. If the project's `[projects.<name>].fragments` array references `<old>.md`, it is updated in place.
- **dc-R071** — `rei docs remove <project> <fragment>` (alias `rm`) deletes the fragment `.md` under the project; project-level removal is the separate command in dc-R030.
- **dc-R072** — Both commands accept fragment names with or without the trailing `.md`.
- **dc-R073** — Source-only operations; target cleanup is handled by `clean_on_sync` on the next sync.

### Compile (Phase 14)

- **dc-R080** — `rei docs compile [project]` writes the existing index *into source* (so it is git-trackable and visible) instead of straight to the target. With no project arg, compiles every mapped project.
- **dc-R081** — The compiled-in-source index is the artifact `sync` ships when an agent target opts in to compilation (see `sy-R060+`).
