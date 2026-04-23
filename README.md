# reishi

A lightweight CLI for managing **cross-agent Skills, Rules, and Docs** from a single source of truth.

One `~/.config/reishi/` directory holds everything. `rei sync` distributes it to every agent you use — Claude, `~/.agents/`, chezmoi, a project's `AGENTS.md`, wherever. Track skills back to their GitHub source and pull updates with one command.

```bash
rei add -t https://github.com/readwiseio/readwise-skills/tree/main/skills
rei sync                       # distribute to every configured target
rei updates --sync             # pull upstream for anything that's moved
```

## Install

Via the Supermodel Labs Homebrew tap:

```bash
brew install supermodellabs/tap/reishi
```

Or build from source (requires Deno ≥ 2.0):

```bash
git clone https://github.com/supermodellabs/reishi
cd reishi
deno task install    # installs `rei` into ~/.local/bin
```

## Getting started

```bash
# 1. Create the config and source directories
rei config init

# 2. Tell reishi where to sync (edit ~/.config/reishi/config.toml)
rei config edit

# 3. Add some skills
rei add https://github.com/anthropic-experimental/example-skills/tree/main/skills
rei add -t -p https://github.com/readwiseio/readwise-skills/tree/main/skills  # track + prefix

# 4. Push to every configured target
rei sync
```

## What goes in `~/.config/reishi/`

| Directory | Contents |
| --- | --- |
| `skills/` | Per-skill directories (`SKILL.md` + scripts + assets). Source of truth for all skills. |
| `skills/_deactivated/` | Skills you've turned off (`rei deactivate`) — excluded from sync. |
| `rules/` | Global markdown rules — small files agents read on every session. |
| `docs/<project>/` | Project-scoped markdown fragments, compiled into an `AGENTS.md` index per project. |
| `config.toml` | Everything reishi needs to know (paths, targets, sync method, tracked skills). |

## Command cheat sheet

### Skills

```bash
rei init my-skill               # scaffold a new skill from template
rei validate my-skill           # check SKILL.md frontmatter

rei add <github-tree-url>       # install a skill (or a whole skills directory)
rei add -t <url>                # track upstream for future syncs
rei add -p <url>                # prefix the skill name with the repo org
rei add -tp <url>               # both

rei list                        # list active skills
rei list -a                     # include deactivated
rei activate my-skill           # move from _deactivated back
rei deactivate my-skill         # move into _deactivated (removes from targets too)
```

### Sync

```bash
rei sync                        # re-fetch tracked skills + distribute skills, rules, docs to every target
rei sync my-skill               # just one skill
rei sync --no-fetch             # skip the upstream pull, just redistribute from local source
rei sync --dry-run              # preview changes without writing
rei sync --status               # staleness report across skills × targets
rei sync --method=symlink       # override the method for this run
rei sync --rules-only           # just rules (also --skills-only, --docs-only)
```

### Updates

```bash
rei updates                     # check every tracked skill for upstream changes
rei updates --sync              # check and pull any that have new commits
```

Background update checks run automatically (non-blocking) on common commands when `[updates].enabled = true` in config. Disable per skill with `[skills.<name>].updates = false`.

### Rules

```bash
rei rules list
rei rules add ./no-deletes.md              # local file
rei rules add ./security/                  # local directory
rei rules add https://example.com/rule.md  # URL
rei rules remove no-deletes
rei rules sync                              # distribute to configured rule targets
rei rules validate                          # check for broken relative links
```

### Docs

```bash
rei docs list                                   # list doc projects
rei docs list myproject                         # list fragments in a project
rei docs add myproject ./api-conventions.md
rei docs compile myproject ~/code/myproject     # generate AGENTS.md + copy fragments
rei docs sync                                   # sync every [docs.projects] entry
```

### Config

```bash
rei config init        # create ~/.config/reishi/config.toml + directories
rei config show        # print the effective config (merged with defaults)
rei config path        # print just the config file path (for scripting)
rei config edit        # open in $EDITOR
```

## Config file

`~/.config/reishi/config.toml` is TOML. A default config looks like this:

```toml
# How reishi distributes content: "copy" or "symlink"
sync_method = "copy"

# When --prefix is used without a value: "infer" (from GitHub org/user) or "none"
default_prefix = "infer"
prefix_separator = "_"

[paths]
source = "~/.config/reishi/skills"

[paths.targets]
claude = "~/.claude/skills"
# agents = "~/.agents/skills"
# chezmoi = "~/.local/share/chezmoi/dot_agents/skills"

[updates]
enabled = true
interval_hours = 24

[rules]
source = "~/.config/reishi/rules"

[rules.targets]
claude = "~/.claude/rules"

[docs]
source = "~/.config/reishi/docs"
default_target = ".agents/docs"
index_filename = "AGENTS.md"

# Optional: map a docs project to a target so `rei sync` compiles + distributes it
# [docs.projects.myproject]
# target = "~/code/myproject"
# fragments = ["api-conventions.md", "testing.md"]
```

### Per-skill overrides

`rei add -t` writes a `[skills.<name>]` table you can tune later:

```toml
[skills.readwiseio_book-review]
source_url = "https://github.com/readwiseio/readwise-skills"
subpath = "skills/book-review"
ref = "main"
prefix = "readwiseio"
synced_at = "2026-04-23T12:00:00Z"
# Optional overrides:
sync_method = "symlink"         # override the global method for just this skill
targets = ["claude"]            # restrict sync to a subset of [paths.targets]
updates = false                 # opt this skill out of update polling
```

### Changing a prefix

Edit `[skills.<name>].prefix` to a new value. The next `rei sync` will detect the mismatch and prompt you to either **rename** (move source + targets + re-key config) or install in **parallel** (new prefix alongside the old). Use `rei sync --prefix-change=rename|parallel|abort` in non-interactive environments.

## Sync method resolution

Highest wins:

1. CLI flag (`--method=copy|symlink`)
2. Per-skill override (`[skills.<name>].sync_method`)
3. Content-type override (`[rules].sync_method`, `[docs].sync_method`)
4. Global default (`sync_method` at the top of the config)

## Environment variables

| Var | Effect |
| --- | --- |
| `REISHI_CONFIG` | Override the config file path (handy for multiple profiles or tests). |
| `EDITOR` | Used by `rei config edit`. |

## Shell completion

```bash
rei completions fish | source                    # fish
rei completions bash > ~/.local/share/bash-completion/completions/rei   # bash
rei completions zsh  > ~/.zfunc/_rei             # zsh (then `autoload -U _rei && compinit`)
```

Completions include dynamic skill, rule, fragment, and doc-project names where relevant.

## Development

See [AGENTS.md](./AGENTS.md) for the full developer guide: source layout, test harness, release pipeline, and architecture notes.

## License

MIT
