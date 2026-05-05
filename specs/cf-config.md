# cf — Config and Lockfile

## Goals

`cf-` covers the configuration surface: the TOML file users edit, the lockfile reishi manages, and the `rei config` subcommand group used to bootstrap and reshape both. Config holds preferences (paths, sync method, targets, prefix behavior, update polling). The lockfile holds machine-managed tracking state for skills (`source_url`, `subpath`, `ref`, `sha`, `synced_at`, `prefix`). The two are deliberately separated so users can edit config freely without touching machine state.

**Non-goals.** No config-edit subcommand (users open files directly); no migration tooling for legacy chezmoi paths; no schema versioning beyond append-only field additions.

## Requirements

### File format and locations

- **cf-R001** — Config lives at `~/.config/reishi/config.toml` by default; `REISHI_CONFIG` overrides the path.
- **cf-R002** — Lockfile lives at `~/.config/reishi/reishi-lock.toml` by default; `REISHI_LOCKFILE` overrides the path with parallel semantics to `REISHI_CONFIG`.
- **cf-R003** — Both files are TOML, parsed via `@std/toml`.
- **cf-R004** — `loadConfig()` must merge a partial user config with hardcoded defaults so missing keys never crash callers.
- **cf-R005** — `saveConfig()` must round-trip: a load-then-save with no edits produces a byte-identical file (modulo formatting allowed by `@std/toml`).
- **cf-R006** — If the config file is missing, `loadConfig()` returns defaults without writing anything; only `initConfig()` creates files.
- **cf-R007** — If a config file exists but is invalid TOML, loading must fail with a clear error pointing at the file path.

### Schema — config

- **cf-R010** — Top-level keys: `sync_method` (`"copy"` | `"symlink"`), `default_prefix` (`"infer"` | `"none"`), `prefix_separator` (string, default `"_"`), `include_shared_agent` (bool, default `false` in defaults but `true` in `init` output).
- **cf-R011** — `[skills]` table holds `source` (path); `[rules]` table holds `source` and optional `sync_method` override; `[docs]` table holds `source`, `default_target`, `index_filename`, optional `sync_method`, optional `token_budget`.
- **cf-R012** — `[updates]` table holds `enabled` (bool) and `interval_hours` (number).
- **cf-R013** — `[agents.<name>]` tables each hold `skills` and `rules` path keys; the name `shared` is reserved and rejected on write (use `include_shared_agent`).
- **cf-R014** — `[projects.<name>]` tables hold `path` (project root) and optional `fragments` array; paths are normalized on write (expand `~`, condense back to `~/` for storage).
- **cf-R015** — `[skill_overrides.<name>]` tables hold per-skill preference overrides: `sync_method`, `agents` (list of agent names to limit sync), `updates` (bool to disable polling for that skill).

### Schema — lockfile

- **cf-R020** — Each tracked skill is a `[skills.<name>]` table with `source_url`, `subpath`, `ref`, `sha`, `synced_at` (ISO 8601), and optional `prefix`.
- **cf-R021** — Lockfile is machine-managed: written by `skills add -t` and `skills pull`; never edited by user-facing config commands. (Manual edits are tolerated but unsupported.)
- **cf-R022** — `sha` advances only on a successful pull that downloaded new content; `checkForUpdates` is a pure read and never writes.

### `rei config` subcommands

- **cf-R030** — `rei config init` creates the config file, lockfile, and source dirs (`skills`, `rules`, `docs`, `_deactivated/`); idempotent — only creates what's missing on re-run.
- **cf-R031** — `rei config init` writes a friendly, well-commented config template by default, written for a new user reading it for the first time, using canonical vocabulary throughout.
- **cf-R032** — `rei config init -c` / `--no-comment` writes a minimal, comment-free config instead.
- **cf-R033** — `rei config init` sets `include_shared_agent = true` explicitly in the output so the shared agent target is opt-in but visible.
- **cf-R034** — `rei config show` prints the effective config (user merged with defaults).
- **cf-R035** — `rei config path` prints the resolved config file path.

### `rei config link` and `unlink`

- **cf-R040** — `rei config link agent <name> --skills <path> --rules <path>` writes an `[agents.<name>]` entry with both path keys.
- **cf-R041** — `rei config link agent` rejects the reserved name `shared` with a clear error directing the user to `include_shared_agent`.
- **cf-R042** — `rei config link agent` refuses to overwrite an existing entry without `--force`.
- **cf-R043** — `rei config link project <name> --target <path>` writes a `[projects.<name>]` entry, normalizing the path the same way `docs add` does (expand `~`, create source dir, condense `~/` for storage).
- **cf-R044** — `rei config unlink agent <name>` removes the matching `[agents.<name>]` entry.
- **cf-R045** — `rei config unlink project <name>` removes the matching `[projects.<name>]` entry.
- **cf-R046** — `rei docs add` is preserved as a deprecated alias of `rei config link project`: still functional, but help text and runtime stderr point to the new home.
