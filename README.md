# reishi

> One source, all your agents, just what matters 😌

Reishi (霊芝[^1]) is a small CLI that manages markdown context for agents — specifically rules, skills, and project docs — from a single source of truth. It takes a modular, curator-style approach to this work — emphasizing simplicity, a clear mental model, and a delightful command line experience.

You edit fragments (tightly-scoped markdown files), which reishi then composes and syncs based on deeply configurable preferences (with opinionated defaults for folks who would rather their agents Just Work Better). Fragments can be composed into 3 constructs:

- always-on _rules_
- conditionally-activated _skills_
- project-scoped _docs_

You can target any agent — Claude Code, OpenCode, Cursor, the shared `~/.agents/` convention, or anything else that reads markdown context — and any or all of your software projects, using any conventions you'd prefer (`cool-project/docs` and `awesome-project/.claude/rules`, etc.) — reishi will keep everything in sync.

[^1]: "spirit mushroom", "divine fungus", thing that health grifters claim to put in expensive coffee but is probably sawdust

## Table of contents

- [Install](#install)
- [Core concepts](#core-concepts)
- [Quick start](#quick-start)
- [Key commands](#key-commands)
- [Blessed patterns](#blessed-patterns)
- [Philosophy](#philosophy)
- [Issues vs. Discussions](#issues-vs-discussions)
- [License](#license)

## Install

Reishi is written in Deno, but ships as a single static binary per platform; no Deno install is required to run it.

```bash
# Homebrew (macOS / Linux)
brew install supermodellabs/tap/reishi

# Download a release binary
# https://github.com/supermodellabs/reishi/releases

# From source (requires Deno 2+)
git clone https://github.com/supermodellabs/reishi
cd reishi
deno task install   # installs `rei` to ~/.local/bin
```

Verify the install:

```bash
rei --version
rei config init
```

## Core concepts

Reishi has an intentionally small vocabulary. Six words cover everything, and clarity of mental model is a top priority.

| Term | Meaning |
| ------------ | ------------------------------------------------------------------------- |
| **fragment** | A single reishi-managed markdown file. |
| **source** | The directory where you author content (`~/.config/reishi/` by default). |
| **target** | Where reishi writes — there are two types: agents (for skills + rules) or projects (for docs). |
| **sync** | Local-only write (or symlink) from source to targets. Always safe. |
| **pull** | Fetch fresh content from a remote (for externally tracked skills). |
| **remote** | The upstream of a tracked skill — currently always a GitHub repo. |

Reishi distinguishes three **constructs** by _when_ they apply:

- **Rules** — Always-on, user-level context. Loaded every session configured for agent targets. Style preferences, safety guidelines, workflow patterns.
- **Skills** — Conditionally activated context. Loaded when relevant to the task. Domain expertise, tool guides, framework patterns.
- **Docs** — Project-scoped context. Compiled into a token-efficient, empirically-effective index file per project (defaults to `AGENTS.md`). API conventions, architecture decisions, team patterns.

Reishi's config is simple, but deep, and allows a high degree of control for routing between these source constructs and your various targets. You can keep things unified, customize each target, or a bit of both.

## Quick start

```bash
# 1. Initialize: writes a documented config + creates ~/.config/reishi/{skills,rules,docs}/
rei config init

# 2. Drop a rule. Any markdown file in ~/.config/reishi/rules/ becomes a rule.
echo "# House style\n- Prefer named exports." > ~/.config/reishi/rules/house-style.md

# 3. Sync. Distributes rules + skills + docs to every configured target.
rei sync

# 4. Pull a tracked skill from GitHub.
rei skills add -t https://github.com/anthropics/skills/tree/main/skills/pdf
rei skills pull              # later: refresh from the remote
```

Reishi never writes to your source without an explicit user action. Targets are output, not input — they're overwritten on every sync.

## Key commands

```text
rei skills  [new|validate|add|list|activate|deactivate|move|remove|pull|sync]
rei rules   [list|move|remove|compile|sync]
rei docs    [list|add|move|remove|compile|sync]
rei config  [init|show|path|link|unlink]
rei sync    ← top-level convenience: sync all three constructs at once
```

A few highlights:

| Command | What it does |
| ----------------------------- | --------------------------------------------------------------------------- |
| `rei config init` | Create config + source dirs. `-c` writes a clean comment-free config. |
| `rei skills add -t <url>` | Install a skill from a GitHub tree URL; `-t` records the remote for pulls. |
| `rei skills pull` | Refresh tracked skills from their remotes, then auto-sync. |
| `rei skills sync --check` | Report per skill × target freshness without writing. |
| `rei skills mv <old> <new>` | Rename a skill; auto-rekeys the lockfile and any per-skill overrides. |
| `rei rules compile` | Concatenate every rule into a single source artifact for compile-opt-in agents. |
| `rei sync --dry-run` | Preview every write without touching the filesystem. |
| `rei sync --method=symlink` | Override sync method per-invocation (CLI > per-construct > global default). |

Run `rei <command> --help` for full flags and examples.

## Blessed patterns

A handful of patterns the tool is designed for.

### Promote freely between constructs

A skill you use every session is probably a rule. A rule that only applies to one codebase is probably a doc fragment. The constructs are deliberately parallel — every domain has `move`/`mv` and `remove`/`rm` on the source side, so promoting between roles is a rename and a re-sync.

### Track skills you didn't write

`rei skills add -t <github-url>` records the remote in the lockfile. `rei skills pull` checks the remote's HEAD SHA, downloads only when it moved, and merges with **divergence protection** — files you've edited locally are preserved; the remote version lands as `<filename>_1.md` for side-by-side review. You're never silently overwritten.

### Use the `shared` agent for cross-tool context

The built-in `shared` agent target points at `~/.agents/`. Tools that read the [AGENTS.md convention](https://agents.md) all find the same content there. Opt in via `include_shared_agent = true` in your config (the default in fresh installs).

### Per-project docs, compiled into one index

Each subdirectory of `docs.source` is a project. Each `.md` file inside is a fragment. `rei docs sync` compiles the fragments into a token-budgeted `AGENTS.md` index that lands in the project root, with the fragments themselves under `.agents/docs/`. Agents read the index, then look up the specific fragment they need.

### Symlink while authoring, copy when stable

Set `sync_method = "symlink"` while you're iterating on a skill — edits in the source propagate instantly to every target. Switch to `"copy"` for deployment so the target is a stable snapshot.

## Philosophy

Most agent tooling focuses on rigid plugin systems and skill marketplaces. Reishi takes the opposite approach: **all agent context is markdown, and the value comes from clarity about _when_ it's active, not from packaging.**

A few principles that shape the tool:

- **Source is authoritative.** Reishi never writes to your source without an explicit user action. Targets are output. If you delete a target, the next sync rebuilds it.
- **Local-first by default.** `rei sync` never hits the network. The only
network operation is `rei skills pull`, which exists exactly because remote skills evolve out-of-band.
- **No registry, no marketplace.** Skills are GitHub repos, full stop. Tracking is opt-in and reversible. There is no central index reishi can censor, throttle, or charge you for. You probably have the problem of too many skills to consider, so we're not worried about discovery.
- **Divergence protection over conflict prompts.** When local and remote
both moved, reishi keeps both — your version in place, the remote's as `<filename>_1.md` — and lets you resolve at your pace.
- **Six-word vocabulary.** Fragment, source, target, sync, pull, remote.
Every command, every error, every doc uses the same six words.

## Issues vs. Discussions

We use **Discussions** for ideas, questions, vocabulary debates, and "what if reishi did X?" — the conversational stuff that benefits from threading and isn't yet a concrete change. Start there if you're not sure.

We use **Issues** for concrete, reproducible change requests: a bug with a repro, a missing flag with a clear shape, a doc inaccuracy. An issue should describe the change well enough that a contributor could pick it up cold.

We close — warmly, with love — issues and PRs that don't engage with the [contribution guidelines](./CONTRIBUTING.md). This isn't meant as gatekeeping; it's care for the OSS ecosystem. A maintained project needs a steady signal-to-noise ratio, and we'd rather have a smaller queue we can actually serve than an ocean of unthoughtful issues that we can't (and which whoever fired them off via OpenClaw isn't even checking on). If your issue or PR gets auto-closed, the bot will point you at the relevant section of CONTRIBUTING.md — please reopen after addressing the feedback.

## License

Apache 2.0. See [LICENSE](./LICENSE).
