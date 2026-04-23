# reishi Lightweight CLI Utility for Agent Skills

CLI tool for managing cross-agent Skills. Skills live in a single source-of-truth directory — configurable via `paths.source` in the reishi config (default `~/.config/reishi/skills/`) — and reishi syncs them to named targets (e.g. `~/.claude/skills/`) on each change.

## Quick Start

### Development Workflow

Deno tasks let you run commands against live source during development. Once an update is complete, install globally with `deno task install`.

```bash
# Run any command based on current source code
deno task cli <command> [args]

# Examples
deno task cli init my-skill
deno task cli validate ../my-skill
deno task cli --help

# Type check the code
deno task check

# Run test suite (test-reishi.ts)
deno task test

# Install into ~/.local/bin for global usage (after development)
deno task install
# Now use anywhere
rei init my-skill
rei validate my-skill
```

## Available Commands

| Command | Description |
| --- | --- |
| `init <skill-name>` | Initialize new skill from template (alias: `new`) |
| `validate <skill-path>` | Validate skill structure and frontmatter (alias: `check`) |
| `refresh-docs` | Fetch latest Anthropic skill documentation |
| `activate <skill-name>` | Move skill from deactivated to active (alias: `on`) |
| `deactivate <skill-name>` | Move skill from active to deactivated (alias: `off`) |
| `add <github-url>` | Install a skill or directory of skills from GitHub (alias: `a`, track with `-t`, prefix with `-p`) |
| `list <skill-name>` | List all active skills (alias: `ls`, include deactivated with `-a/--all`) |
| `config <subcommand>` | Inspect and manage the reishi config (`init`, `show`, `path`, `edit`) |
| `sync [skill-name]` | Pull upstream for tracked skills, then distribute skills and rules to configured targets (`--targets`, `--method`, `--dry-run`, `--status`, `--no-fetch`, `--force`, `--prefix-change`, `--rules-only`, `--skills-only`) |
| `updates [skill-name]` | Check tracked skills for upstream changes (`--sync` to also pull) |
| `rules <subcommand>` | Manage global markdown rules (`list`, `add`, `remove`, `sync`, `validate`) |
| `docs <subcommand>` | Manage project-scoped doc fragments and compile a token-efficient AGENTS.md index (`list`, `add`, `remove`, `compile`, `sync`) |

## Command Details

### init

Create a new skill with proper structure:

```bash
# Create in default location (config's paths.source, default ~/.config/reishi/skills/)
deno task cli init my-awesome-skill

# Create in custom location
deno task cli init my-skill --path ~/projects/skills

# Generated structure:
# my-skill/
# ├── SKILL.md              # Frontmatter + instructions
# ├── api_reference.md      # Optionally-accessed, modular deeper documentation
# ├── scripts/              # Executable code + workflows
# │   └── example.ts
# └── assets/               # Templates/files for workflows
#     └── example_asset.txt
```

**Validation rules**:

- Lowercase letters, digits, and hyphens only
- Cannot start/end with hyphen
- No consecutive hyphens
- Max 64 characters

### validate

Check skill structure and SKILL.md frontmatter:

```bash
deno task cli validate agents/skills/my-skill
```

Validates:

- SKILL.md exists and has proper frontmatter
- Required fields: `name`, `description`
- Name follows naming rules
- No unexpected frontmatter keys
- Description under 1024 chars, no angle brackets

### add

Install one or more skills from a GitHub tree URL:

```bash
# Single skill
deno task cli add https://github.com/user/repo/tree/main/skills/my-skill

# All skills from a directory
deno task cli add https://github.com/user/repo/tree/main/skills
```

**Flags**:

- `-t, --track`: Record the skill's origin (`source_url`, `ref`, `subpath`, `synced_at`) in `~/.config/reishi/config.toml` under `[skills.<name>]` so `rei sync` can refresh it later. Re-adding a tracked skill updates `synced_at` in place.
- `-p, --prefix [value]`: Prefix installed skill names. `-p` alone infers the prefix from the GitHub URL's user/org (e.g. `readwiseio` → `readwiseio_book-review`); `--prefix=foo` uses a literal value. Separator comes from `prefix_separator` in config (default `_`). Respects `default_prefix = "infer"` in config as an opt-in default when the flag is absent.

### refresh-docs

Fetch latest Anthropic documentation about agent skills:

```bash
deno task cli refresh-docs
```

Downloads to: `agents/skills/develop-agent-skills/` (the overview.md and related reference docs)

### config

Manage the reishi config file (TOML, at `~/.config/reishi/config.toml` by default):

```bash
# Create the config file and source directories
deno task cli config init

# Print the effective config (merged with defaults)
deno task cli config show

# Print the config file path (useful for shell piping)
deno task cli config path

# Open the config in $EDITOR
deno task cli config edit
```

Set `REISHI_CONFIG=/path/to/config.toml` to override the config location (handy for tests or multiple profiles).

### activate / deactivate

Temporarily disable/enable skills:

```bash
# Disable a skill (moves to _deactivated_skills)
deno task cli deactivate old-skill

# Re-enable it later
deno task cli activate old-skill
```

**Paths**:

- Source of truth (active): `paths.source` from the reishi config — default `~/.config/reishi/skills/`
- Deactivated: `<paths.source>/_deactivated/`
- Targets: configured under `[paths.targets]`, synced from the source of truth on every change

### sync

Sync runs in two phases: (1) for tracked skills, re-fetch from upstream and overwrite the source; (2) distribute the source to every configured target by copy or symlink. Untracked skills skip phase 1 and just do target sync.

```bash
# Sync everything (re-fetch tracked, redistribute everything to all targets)
deno task cli sync

# Sync a single skill
deno task cli sync book-review

# Limit to specific targets
deno task cli sync --targets=claude,agents

# Override sync method (config default is "copy")
deno task cli sync --method=symlink

# Plan only — show what would happen without writing (includes upstream preview)
deno task cli sync --dry-run

# Skip the upstream fetch entirely (Phase 3 target-only behavior)
deno task cli sync --no-fetch

# Bypass the local-modification confirmation prompt
deno task cli sync --force

# Pre-decide a prefix change non-interactively
deno task cli sync --prefix-change=rename   # or =parallel, =abort

# Staleness report (present / fresh / stale / missing / symlink, per skill × target)
deno task cli sync --status
```

**Resolution order for sync method** (highest wins): CLI `--method` > per-skill `[skills.<name>].sync_method` > global `sync_method` in config.

**Per-skill target filter**: `[skills.<name>].targets = ["claude"]` restricts a skill to those named targets from `[paths.targets]`.

**Auto-sync**: `add`, `activate`, `deactivate`, and `init` (when scaffolding inside the source dir) trigger sync automatically with `--no-fetch` semantics — they never pull upstream. Only the user-facing `rei sync` command pulls. If no targets are configured or the target parent dir is missing, the sync is a silent no-op. `deactivate` removes the skill from every target.

**Prefix changes**: editing `[skills.<name>].prefix` to a new value triggers a two-stage prompt on the next sync (confirm → rename / parallel / abort). Rename moves the source dir, the deactivated dir, and every target dir, then re-keys the config table. Parallel preserves the old skill in place and the upstream fetch populates the new dir under the new name. Use `--prefix-change` for non-interactive resolution.

### updates

Poll tracked skills for upstream changes without pulling:

```bash
# Check every tracked skill
deno task cli updates

# Check one
deno task cli updates book-review

# Check, then sync any that have new upstream commits
deno task cli updates --sync
```

Reishi stores the latest seen upstream SHA in `[skills.<name>].remote_hash` and the time of last check in `last_check`. Disable polling for a single skill with `[skills.<name>].updates = false`.

**Background notifications**: when `[updates].enabled = true` and `interval_hours` has elapsed since `[updates].last_background_check`, `rei list`, `rei sync`, `rei validate`, and `rei config show` fire a non-blocking background check and print a one-liner if any tracked skills have upstream updates: `✨ N skills have upstream updates — run rei updates for details`. The check is fire-and-forget — it never delays the main command.

### rules

Rules are global, always-on markdown files distributed to agent rule paths on sync. Unlike skills, rules are NOT tracked per-item — they are just files or directories in `rules.source` that get copied or symlinked to every entry in `[rules.targets]`. Both single `.md` files and directories of rules are supported.

```bash
# List rules present in rules.source
deno task cli rules list

# Add a rule from a local file, a directory, or a URL
deno task cli rules add ./no-deletes.md
deno task cli rules add ./security
deno task cli rules add https://example.com/rule.md
deno task cli rules add https://github.com/org/repo/tree/main/rules/security

# Re-adding requires --force to overwrite an existing rule
deno task cli rules add ./no-deletes.md --force

# Remove a rule from rules.source AND every target
deno task cli rules remove no-deletes

# Sync rules from source to configured targets
deno task cli rules sync
deno task cli rules sync --targets=claude
deno task cli rules sync --method=symlink --dry-run

# Validate rules (reads every file, flags broken relative links)
deno task cli rules validate
```

**Config**: rules live under the `[rules]` table:

```toml
[rules]
source = "~/.config/reishi/rules"
# sync_method = "symlink"     # optional override; inherits global sync_method

[rules.targets]
claude = "~/.claude/rules"
# opencode = "~/.opencode/rules"
```

**Method resolution** (highest wins): CLI `--method` > `[rules].sync_method` > global `sync_method`.

**Integration with `rei sync`**: `rei sync` (no arg) syncs skills, rules, and every configured doc project. `rei sync <skill-name>` narrows to that skill and skips rules and docs. `rei sync --rules-only`, `rei sync --skills-only`, and `rei sync --docs-only` each restrict to one content type (mutually exclusive). On full success the summary collapses to `✨ Synced N skills, M rules, and K doc projects across T targets`.

### docs

Docs are **project-scoped** markdown fragments. Each subdirectory of `docs.source` represents a doc project, and each `.md` file inside is a fragment. Unlike skills and rules, docs are distributed to real project directories on disk (not to shared user-level agent paths): the compiled index lands at `<target>/<index_filename>` (default `AGENTS.md`), and fragments land under `<target>/<docs.default_target>/` (default `.agents/docs/`).

```bash
# List doc projects (and their fragment counts)
deno task cli docs list

# List fragments in a project
deno task cli docs list myproject

# Add a fragment from a local file, a URL, or a GitHub tree URL pointing at a single file
deno task cli docs add myproject ./api-conventions.md
deno task cli docs add myproject https://example.com/docs/api.md
deno task cli docs add myproject https://github.com/org/repo/tree/main/docs/api.md

# Re-adding requires --force
deno task cli docs add myproject ./api-conventions.md --force

# Remove a fragment from docs.source (does NOT cascade to targets — re-sync to propagate)
deno task cli docs remove myproject api-conventions.md

# Compile an AGENTS.md index + distribute fragments to an arbitrary target dir
deno task cli docs compile myproject ~/code/myproject
deno task cli docs compile myproject ~/code/myproject --stdout   # preview the index
deno task cli docs compile myproject ~/code/myproject --dry-run

# Sync every configured [docs.projects] entry
deno task cli docs sync

# Sync a single configured project (or ad-hoc with --target)
deno task cli docs sync myproject
deno task cli docs sync myproject --target ~/code/myproject
```

**Config**:

```toml
[docs]
source = "~/.config/reishi/docs"     # where fragments live, organized by project subdir
default_target = ".agents/docs"      # per-project subdir for distributed fragments
index_filename = "AGENTS.md"         # name of the compiled index file at the project root
# sync_method = "symlink"            # optional override; inherits global sync_method
# token_budget = 4000                # soft cap on the index size (chars/4 approximation)

[docs.projects.myproject]
target = "~/code/myproject"
# fragments = ["api-conventions.md", "testing.md"]   # optional subset
```

**Index format**: one heading per fragment, a one-line description (frontmatter `description` field > first non-heading paragraph > first heading), and a single relative link to the fragment under the target's `<docs.default_target>/` subdir. Fragments are ordered by frontmatter `priority` descending, then alphabetically. When the token budget would be exceeded, remaining fragments are replaced with a terse `(... N more fragments omitted)` line.

**Method resolution** (highest wins): CLI `--method` > `[docs].sync_method` > global `sync_method`.

**Auto-sync on `rei sync`**: any project listed under `[docs.projects]` is compiled and distributed as part of `rei sync` (no argument). Use `--docs-only` to run just the docs pass.

## Testing

Run the comprehensive test suite:

```bash
deno task test
```

Tests include:

- Help/version commands
- Skill creation with all files
- Validation rules (name format, required fields, unexpected keys)
- Template interpolation
- Error handling
- File permissions

All tests run in isolated temporary directories.

## Development Tips

1. **Make changes**: Edit `reishi.ts`
2. **Type check**: `deno task check`
3. **Test**: `deno task test`
4. **Try it**: `deno task cli <command>`
5. **Deploy**: `deno task install` (updates global binary)

No need to reinstall the binary during development - just use the task commands!

## Architecture

Built with:

- **Deno** - Secure by default, TypeScript native
- **Deno Standard Library** - File ops, path handling, YAML parsing
- **Cliffy** - The most popular Deno CLI framework (now with cross-runtime support for Bun and Node) with great help text and validation

Key features:

- Declarative command structure
- Comprehensive validation
- Helpful error messages
- Dry-run friendly
- Permission-scoped (no unnecessary access)
- Built-in generation of shell completions and aliases
