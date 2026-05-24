# ac — Activation and profiles

## Goals

`ac-` owns the activation mechanism — the load-bearing redesign that turns reishi from a
distribution tool into a library manager with surgical control over what's in front of an agent.
Every library item (rule, skill, profile) carries zero or more **conditions**; activation
evaluates conditions at command-time and reports which items are currently active. Sync
materializes the active set to agent targets.

This domain owns both the **profile artifact** (the grouping mechanism that lets the user share
conditions across multiple rules and skills) and the **activation engine** (condition types,
evaluation, manual state, status reporting). They are tightly entangled — profiles exist as a
shape because activation needs a grouping primitive — so one spec is clearer than two.

**Non-goals.** No condition DSL or expression language — v1 conditions are typed and composed
with OR semantics, nothing more. No daemon or shell-resident hooks; activation evaluates when a
reishi command runs (or when an integration the user wires up — e.g. an agent-launch hook —
invokes a reishi entry point). No content scanning for project detection; path conditions check
file/dir presence only (R012). No conditional sub-content within an item (a rule is either
active or not — never half-active).

## Requirements

### Profile artifact

- **ac-R001** — Profiles live as `.toml` files directly under `profiles.source` (default
  `~/.config/reishi/profiles/`). Each `.toml` file is one profile; the filename stem is the
  profile name.
- **ac-R002** — Profile names follow the rule/skill naming convention: lowercase letters, digits,
  and hyphens; no leading/trailing/consecutive hyphens; max 64 chars.
- **ac-R003** — Profile schema:

  ```toml
  description = "Rust development"   # optional, surfaced in list/status
  members.rules = ["rust-style", "cargo-conventions"]
  members.skills = ["rust-deep-dive", "cargo-audit"]
  [[conditions]]
  type = "path"
  pattern = "~/code/rust/**"
  [[conditions]]
  type = "manual"
  ```

- **ac-R004** — `members.rules` and `members.skills` reference items by name (no path). Missing
  members are warned (`rei profiles list` and `rei status` surface them) but do not fail the
  profile load.
- **ac-R005** — A single rule or skill may appear in multiple profiles; membership is not
  exclusive.

### `rei profiles` CRUD

- **ac-R010** — `rei profiles list` (alias `ls`) lists every profile with: name, description,
  member counts, current active state, and the condition driving activation (if active).
- **ac-R011** — `rei profiles new <name>` creates an empty profile.toml under `profiles.source`
  with the schema scaffolded as commented examples.
- **ac-R012** — `rei profiles show <name>` prints the parsed profile (members + conditions +
  current active state).
- **ac-R013** — `rei profiles edit <name>` opens the profile.toml in `$EDITOR` (or
  `$VISUAL`/`vi` fallback).
- **ac-R014** — `rei profiles move <old> <new>` (alias `mv`) renames the profile.toml; rewrites
  any matching `[profile_overrides.<name>]` config entry.
- **ac-R015** — `rei profiles remove <name>` (alias `rm`) deletes the profile.toml and drops any
  matching `[profile_overrides.<name>]` config entry.
- **ac-R016** — Profile CRUD operations are source-only; target cleanup of items that were active
  via this profile is handled by the next sync (see sy-).

### Condition types

- **ac-R020** — Condition type `manual` — true when `rei use <name>` has set it, false when
  `rei unuse <name>` clears it. Manual state persists across reishi invocations (see ac-R070).
- **ac-R021** — Condition type `path` — accepts a `pattern` field (glob). True when the current
  working directory matches the pattern. Globs honor `~` expansion and standard `**` recursion.
- **ac-R022** — Condition type `agent` — accepts a `name` field or `names` list. True when reishi
  is currently addressing one of the named agent targets (e.g. when `rei sync --agents=claude` is
  running, or when an agent-launch hook invokes reishi on behalf of `claude`).
- **ac-R023** — Conditions attach to: profiles (in profile.toml under `[[conditions]]`), rules
  (via `[rule_overrides.<name>].conditions` in config), skills (via
  `[skill_overrides.<name>].conditions` in config). Schema for the inline override is the same as
  the profile.toml conditions table.
- **ac-R024** — Items with **no conditions** are active by default. Conditions narrow activation;
  absence of conditions means "always available."
- **ac-R025** — Items with one or more conditions are active when **any** condition evaluates
  true (OR semantics). v1 has no AND composition; if a user needs intersection, they use a
  profile to express the intent.

### Evaluation

- **ac-R030** — Activation evaluates at well-defined moments: on every `rei sync` invocation, on
  every `rei status` invocation, on every list/show command that surfaces active state, and
  whenever an external integration invokes a reishi entry point that needs the active set.
- **ac-R031** — Evaluation is pure: it reads config, profile.toml files, manual state, and
  current-context inputs (cwd for `path`, agent name for `agent`); it writes nothing.
- **ac-R032** — Profile-driven activation cascades: when a profile is active, every member rule
  and skill is active for the duration of that evaluation pass, regardless of the member's own
  conditions.
- **ac-R033** — An item is active if **any** of the following hold: it has no conditions
  (ac-R024), or any of its direct conditions evaluates true, or any profile it belongs to is
  active.

### `rei use / unuse`

- **ac-R040** — `rei use <name>` sets the `manual` condition for the named library item (rule,
  skill, or profile). The name is resolved across all three artifact types; ambiguity prompts the
  user to disambiguate (`rei use rule:<name>` etc.).
- **ac-R041** — `rei unuse <name>` clears the `manual` condition for the named item. No-op if not
  currently set.
- **ac-R042** — `rei use --reset` clears every manual activation in one shot.
- **ac-R043** — `rei use` and `rei unuse` auto-trigger a sync after mutating state, so agent
  targets reflect the new active set immediately. `--no-sync` skips the auto-sync.

### `rei status`

- **ac-R050** — `rei status` reports current active state across the whole library, grouped by
  artifact type. Each item shows: name, active/inactive, and (when active) the condition that
  drove activation (e.g. `active via profile rust`, `active via path match`, `active manually`,
  `active (no conditions)`).
- **ac-R051** — `rei status --profile <name>` reports the active state for one profile's members.
- **ac-R052** — `rei status --json` emits the report as structured JSON for machine consumption.
- **ac-R053** — `rei status` runs no network and writes nothing.

### Agent default profiles

- **ac-R060** — `[agents.<name>].default_profiles = ["<profile>", ...]` lists profiles that
  auto-activate when reishi is addressing that agent target. Equivalent in semantics to those
  profiles carrying an `agent` condition matching the named agent, expressed inline on the agent
  side for readability.
- **ac-R061** — Default-profile activation is additive across `default_profiles` lists when more
  than one agent is addressed in the same sync run.

### State persistence

- **ac-R070** — Manual activation state lives in the lockfile under `[state.manual]`, with one
  entry per currently-set item: `[state.manual."<name>"]` `kind = "profile" | "rule" | "skill"`,
  `set_at = "<ISO 8601>"`. The lockfile is already machine-managed; extending it avoids
  introducing a third config file.
- **ac-R071** — Manual state is the only activation state persisted; `path` and `agent`
  conditions evaluate fresh on every pass and store nothing.
- **ac-R072** — Lockfile reads/writes for state.manual use the same atomic-write discipline as
  the existing tracked-skill entries.

### Errors and guardrails

- **ac-R080** — A condition table with an unknown `type` fails parse with a clear error naming
  the offending profile or override and listing the supported types.
- **ac-R081** — A profile member that doesn't resolve to an existing rule or skill is warned at
  load time (in list/status/sync output) but does not abort the operation; the missing member is
  simply skipped during cascade.
- **ac-R082** — Circular profile membership is not a concern because profiles do not contain
  other profiles in v1. If introduced later, cycle detection is a separate requirement.
