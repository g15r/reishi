# reishi Lightweight CLI Utility for Agent Skills

CLI tool for managing cross-agent Skills. Skills live in `<chezmoi home>/dot_agents/skills/`, which chezmoi's symlinks out to `~/.agents/skills/` + any agent-specific locations (e.g. `~/.claude/skills/`).

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
| `add <github-url>` | Install a skill or directory of skills from GitHub (alias: `a`, track with `-t`) |
| `list <skill-name>` | List all active skills (alias: `ls`, include deactivated with `-a/--all`) |
| `config <subcommand>` | Inspect and manage the reishi config (`init`, `show`, `path`, `edit`) |

## Command Details

### init

Create a new skill with proper structure:

```bash
# Create in default location (~/.local/share/chezmoi/dot_agents/skills/)
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

- Active: `~/.local/share/chezmoi/dot_agents/skills/`, applied by chezmoi to `~/.agents/skills/` + agent-specific paths
- Deactivated: `~/.local/share/chezmoi/dot_agents/skills/_deactivated/`

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
