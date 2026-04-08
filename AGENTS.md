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
| `add <skill-name>` | Install a skill or directory of skills from GitHub (alias: `a`) |
| `list <skill-name>` | List all active skills (alias: `ls`, include deactivated with `-a/--all`) |

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

### refresh-docs

Fetch latest Anthropic documentation about agent skills:

```bash
deno task cli refresh-docs
```

Downloads to: `agents/skills/develop-agent-skills/` (the overview.md and related reference docs)

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
