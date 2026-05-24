# cf — Config and Lockfile

## Goals

`cf-` covers the configuration surface: the TOML file users edit, the lockfile reishi manages,
and the `rei config` subcommand group used to bootstrap and reshape both. Config holds
preferences (paths, sync method, agent targets, prefix behavior, update polling, per-item
activation overrides). The lockfile holds machine-managed state — tracked-skill records
(`source_url`, `subpath`, `ref`, `sha`, `synced_at`, `prefix`) and persisted manual activation
state (see `ac-R070`). The two are deliberately separated so users can edit config freely
without touching machine state.

**Non-goals.** No config-edit subcommand (users open files directly); no migration tooling for
legacy chezmoi paths; no schema versioning beyond append-only field additions; no project-scope
config (no `[projects.<name>]` tables, no `[docs]` table, no per-agent compile config — those
are all retired with the docs/compile domains).

## Requirements

### File format and locations

- **cf-R001** — Config lives at `~/.config/reishi/config.toml` by default; `REISHI_CONFIG`
  overrides the path.
- **cf-R002** — Lockfile lives at `~/.config/reishi/reishi-lock.toml` by default;
  `REISHI_LOCKFILE` overrides the path with parallel semantics to `REISHI_CONFIG`.
- **cf-R003** — Both files are TOML, parsed via `@std/toml`.
- **cf-R004** — `loadConfig()` must merge a partial user config with hardcoded defaults so
  missing keys never crash callers.
- **cf-R005** — `saveConfig()` must round-trip: a load-then-save with no edits produces a
  byte-identical file (modulo formatting allowed by `@std/toml`).
- **cf-R006** — If the config file is missing, `loadConfig()` returns defaults without writing
  anything; only `initConfig()` creates files.
- **cf-R007** — If a config file exists but is invalid TOML, loading must fail with a clear
  error pointing at the file path.

### Schema — config

- **cf-R010** — Top-level keys: `sync_method` (`"copy"` | `"symlink"`), `default_prefix`
  (`"infer"` | `"none"`), `prefix_separator` (string, default `"_"`), `include_shared_agent`
  (bool, default `false` in defaults but `true` in `init` output), `clean_on_sync` (bool,
  default `false`).
- **cf-R011** — `[skills]`, `[rules]`, and `[profiles]` tables each hold a `source` path key.
  `[skills]` and `[rules]` may additionally hold an optional `sync_method` override.
- **cf-R012** — `[updates]` table holds `enabled` (bool) and `interval_hours` (number).
- **cf-R013** — `[agents.<name>]` tables each hold `skills` and `rules` path keys, plus an
  optional `default_profiles` array (see `ac-R060`). The name `shared` is reserved and rejected
  on write (use `include_shared_agent`).
- **cf-R014** — `[skill_overrides.<name>]` tables hold per-skill preference overrides:
  `sync_method`, `agents` (list of agent names to limit sync), `updates` (bool to disable
  polling for that skill), `conditions` (inline activation conditions per `ac-R023`).
- **cf-R015** — `[rule_overrides.<name>]` tables hold per-rule preference overrides:
  `sync_method`, `agents`, `conditions`. Schema mirrors `[skill_overrides.<name>]` minus the
  `updates` key (rules are never tracked).
- **cf-R016** — `[profile_overrides.<name>]` tables hold per-profile preference overrides used
  for ergonomic adjustments without editing the profile.toml: `agents` (list of agent names to
  restrict the profile's reach). Conditions themselves live in the profile.toml (`ac-R003`);
  this override surface is for distribution scope only.

### Schema — lockfile

- **cf-R020** — Each tracked skill is a `[skills.<name>]` table with `source_url`, `subpath`,
  `ref`, `sha`, `synced_at` (ISO 8601), and optional `prefix`.
- **cf-R021** — Lockfile is machine-managed: written by `skills add -t`, `skills pull`,
  `rei use`, and `rei unuse`; never edited by user-facing config commands. (Manual edits are
  tolerated but unsupported.)
- **cf-R022** — Tracked-skill `sha` advances only on a successful pull that downloaded new
  content; `checkForUpdates` is a pure read and never writes.
- **cf-R023** — Manual activation state is recorded under `[state.manual."<name>"]` with `kind`
  (`"rule" | "skill" | "profile"`) and `set_at` (ISO 8601), per `ac-R070`.

### `rei config` subcommands

- **cf-R030** — `rei config init` creates the config file, lockfile, and source dirs (`skills`,
  `rules`, `profiles`); idempotent — only creates what's missing on re-run.
- **cf-R031** — `rei config init` writes a friendly, well-commented config template by default,
  written for a new user reading it for the first time, using canonical vocabulary throughout
  (R003).
- **cf-R032** — `rei config init -c` / `--no-comment` writes a minimal, comment-free config
  instead.
- **cf-R033** — `rei config init` sets `include_shared_agent = true` explicitly in the output
  so the shared agent target is opt-in but visible.
- **cf-R034** — `rei config show` prints the effective config (user merged with defaults).
- **cf-R035** — `rei config path` prints the resolved config file path.

### `rei config link` and `unlink`

- **cf-R040** — `rei config link agent <name> --skills <path> --rules <path>` writes an
  `[agents.<name>]` entry with both path keys. `--default-profiles=<a,b,c>` is accepted to
  populate `default_profiles` at link time.
- **cf-R041** — `rei config link agent` rejects the reserved name `shared` with a clear error
  directing the user to `include_shared_agent`.
- **cf-R042** — `rei config link agent` refuses to overwrite an existing entry without
  `--force`.
- **cf-R043** — `rei config unlink agent <name>` removes the matching `[agents.<name>]` entry.
