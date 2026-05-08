/**
 * reishi config module
 *
 * TOML-based configuration for the reishi CLI. Config lives at
 * ~/.config/reishi/config.toml by default; the REISHI_CONFIG env var
 * overrides the path (useful for testing).
 */

import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { dirname, join } from '@std/path';
import { exists } from '@std/fs';

// ============================================================================
// Types
// ============================================================================

export type SyncMethod = 'copy' | 'symlink';
export type DefaultPrefix = 'infer' | 'none';

// --- Config sections -------------------------------------------------------

export interface SkillsConfig {
  source: string;
}

export interface UpdatesConfig {
  enabled: boolean;
  interval_hours: number;
  /** ISO timestamp of the last fired background update check. */
  last_background_check?: string;
}

export interface RulesConfig {
  source: string;
  sync_method?: SyncMethod;
}

/** Per-agent destination config — keys are agent names. */
export interface AgentConfig {
  skills: string;
  rules: string;
  /**
   * Opt in to the compiled-rules artifact: when true, sync ships the rules
   * concatenation written by `rei rules compile` to `<compile_root>/<compile_file>`.
   * Default false. Individual rule files continue to ship independently.
   */
  compile?: boolean;
  /**
   * Filesystem root for `compile_file`, relative to which subpaths are resolved.
   * Required when `compile = true`. Typically the agent's parent dir
   * (e.g. `~/.claude` for an agent whose rules path is `~/.claude/rules`).
   */
  compile_root?: string;
  /**
   * Destination filename for the compiled rules artifact, relative to
   * `compile_root`. Subpaths like `"sub/foo.md"` are allowed; paths that
   * escape `compile_root` (via `..`) are rejected at sync time. Default
   * `"AGENTS.md"`.
   */
  compile_file?: string;
}

export interface DocsProjectEntry {
  /** Absolute or `~`-prefixed path to the project root. */
  path: string;
  /**
   * Restrict compiled output to this subset of doc filenames (basenames
   * in the project's docs.source dir). Undefined = all docs in the project.
   */
  files?: string[];
}

export interface DocsConfig {
  source: string;
  default_target: string;
  index_filename: string;
  sync_method?: SyncMethod;
  /** Soft cap on the compiled index size, in approximate tokens (chars/4). */
  token_budget?: number;
}

/**
 * Per-skill *config* overrides. User-edited, never written by the tool.
 * Tracking state (source_url, ref, sha, synced_at, prefix, subpath) lives in
 * the lockfile — see `SkillLockEntry` below.
 */
export interface SkillEntry {
  sync_method?: SyncMethod;
  agents?: string[];
  updates?: boolean;
}

export interface ConfigSchema {
  sync_method: SyncMethod;
  default_prefix: DefaultPrefix;
  prefix_separator: string;
  skills: SkillsConfig;
  updates: UpdatesConfig;
  rules: RulesConfig;
  agents: Record<string, AgentConfig>;
  docs: DocsConfig;
  projects: Record<string, DocsProjectEntry>;
  /** Per-skill config overrides (optional). */
  skill_overrides?: Record<string, SkillEntry>;
  /**
   * Opt in to the built-in `shared` agent target at `~/.agents/`. Synthesized
   * by `loadConfig` — `agents.shared` is reserved and any user-defined entry
   * with that name is ignored. Defaults to false; the starter template sets
   * it to true so new users get cross-agent context out of the box.
   */
  include_shared_agent?: boolean;
  /**
   * Opt-in cleanup of orphan files in copy targets — files present in the
   * target but not in source. Symlinks self-resolve, so this only matters
   * for `copy` syncs. Default false. The CLI batches every orphan across the
   * whole sync run into a single Y/N prompt at the end.
   */
  clean_on_sync?: boolean;
}

/** Reserved name for the built-in shared-agent target. */
export const SHARED_AGENT_NAME = 'shared';

/** Built-in path for the shared-agent target. Not user-configurable. */
export const SHARED_AGENT_PATHS: AgentConfig = {
  skills: '~/.agents/skills',
  rules: '~/.agents/rules',
};

/**
 * Per-skill tracking state. Machine-managed; written by `rei skills add -t`
 * and `rei skills pull`. Lives in the lockfile alongside the config file.
 */
export interface SkillLockEntry {
  source_url: string;
  subpath: string;
  ref: string;
  sha?: string;
  synced_at: string;
  prefix?: string;
}

export interface LockfileSchema {
  skills: Record<string, SkillLockEntry>;
}

export interface InitConfigResult {
  alreadyExisted: boolean;
  configPath: string;
  examplePath: string;
  exampleWritten: boolean;
  createdDirs: string[];
}

// ============================================================================
// Path helpers
// ============================================================================

function getHome(): string {
  const home = Deno.env.get('HOME');
  if (!home) throw new Error('HOME not set');
  return home;
}

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandHome(path: string): string {
  if (path === '~') return getHome();
  if (path.startsWith('~/')) return join(getHome(), path.slice(2));
  return path;
}

/** Resolves the config file path, honoring REISHI_CONFIG if set. */
export function getConfigPath(): string {
  const override = Deno.env.get('REISHI_CONFIG');
  if (override) return expandHome(override);
  return join(getHome(), '.config/reishi/config.toml');
}

/**
 * Resolves the lockfile path, honoring REISHI_LOCKFILE if set. Defaults to
 * `reishi-lock.toml` alongside the config file (so the config-dir override
 * from REISHI_CONFIG takes the lockfile with it).
 */
export function getLockfilePath(): string {
  const override = Deno.env.get('REISHI_LOCKFILE');
  if (override) return expandHome(override);
  return join(dirname(getConfigPath()), 'reishi-lock.toml');
}

// ============================================================================
// Defaults
// ============================================================================

export function defaultConfig(): ConfigSchema {
  return {
    sync_method: 'copy',
    default_prefix: 'infer',
    prefix_separator: '_',
    skills: {
      source: '~/.config/reishi/skills',
    },
    updates: {
      enabled: true,
      interval_hours: 24,
    },
    rules: {
      source: '~/.config/reishi/rules',
    },
    agents: {
      claude: {
        skills: '~/.claude/skills',
        rules: '~/.claude/rules',
      },
    },
    docs: {
      source: '~/.config/reishi/docs',
      default_target: '.agents/docs',
      index_filename: 'AGENTS.md',
      token_budget: 4000,
    },
    projects: {},
  };
}

// ============================================================================
// Merge
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Deep-merge overrides onto base. Arrays and primitives replace; objects merge.
function deepMerge<T>(base: T, overrides: unknown): T {
  if (!isPlainObject(overrides)) return base;
  if (!isPlainObject(base)) return overrides as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ============================================================================
// Load / Save
// ============================================================================

/**
 * Read and parse the config file, deep-merged with defaults. Missing file
 * returns pure defaults (no error). Invalid TOML throws a clear error.
 */
export async function loadConfig(): Promise<ConfigSchema> {
  const path = getConfigPath();
  const defaults = defaultConfig();
  if (!(await exists(path))) return applySharedAgent(defaults);

  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config at ${path}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid TOML in config at ${path}: ${message}`);
  }

  const merged = deepMerge(defaults, parsed);
  return applySharedAgent(merged);
}

/**
 * Synthesize the built-in `shared` agent entry when opted in, and strip any
 * user-defined `agents.shared` otherwise. The reserved name always maps to
 * `~/.agents/` — users cannot redirect it.
 */
function applySharedAgent(config: ConfigSchema): ConfigSchema {
  const agents = { ...config.agents };
  if (config.include_shared_agent === true) {
    agents[SHARED_AGENT_NAME] = { ...SHARED_AGENT_PATHS };
  } else if (SHARED_AGENT_NAME in agents) {
    delete agents[SHARED_AGENT_NAME];
  }
  return { ...config, agents };
}

/** Serialize and write the config to disk, creating parent dirs as needed. */
export async function saveConfig(config: ConfigSchema): Promise<void> {
  const path = getConfigPath();
  await Deno.mkdir(dirname(path), { recursive: true });
  // `@std/toml` strips undefined values; serialize as-is.
  await Deno.writeTextFile(path, stringifyTOML(config as unknown as Record<string, unknown>));
}

// ============================================================================
// Link (write config entries)
// ============================================================================

export interface LinkAgentOptions {
  skills: string;
  rules: string;
  /** Overwrite an existing `[agents.<name>]` entry instead of erroring. */
  force?: boolean;
}

export interface LinkAgentResult {
  /** True when the entry was newly written (or overwritten with --force). */
  written: boolean;
  /** True when an entry already existed and was overwritten. */
  overwrote: boolean;
}

/**
 * Write `[agents.<name>]` with `skills` and `rules` paths. Rejects the
 * reserved `shared` name (use `include_shared_agent` instead). Refuses to
 * clobber an existing entry without `force`.
 */
export async function linkAgent(
  name: string,
  options: LinkAgentOptions,
): Promise<LinkAgentResult> {
  if (name === SHARED_AGENT_NAME) {
    throw new Error(
      `'${SHARED_AGENT_NAME}' is reserved — set include_shared_agent = true to enable it`,
    );
  }
  const config = await loadConfig();
  const agents = { ...(config.agents ?? {}) };
  const existed = name in agents;
  if (existed && !options.force) {
    throw new Error(
      `agent already linked: ${name} (use --force to overwrite)`,
    );
  }
  agents[name] = { skills: options.skills, rules: options.rules };
  config.agents = agents;
  await saveConfig(config);
  return { written: true, overwrote: existed };
}

// ============================================================================
// Unlink (drop config entries)
// ============================================================================

export interface UnlinkResult {
  /** True when the entry was present and removed. */
  removedFromConfig: boolean;
  /**
   * Set when unlinking the built-in `shared` agent: instead of a `[agents.*]`
   * mutation, the opt-in flag is flipped off.
   */
  toggledSharedAgent?: boolean;
}

/**
 * Drop `[agents.<name>]` from the config. The built-in `shared` agent has
 * no `[agents.*]` entry to drop — instead, `include_shared_agent` is set to
 * false (which makes `loadConfig` stop synthesizing it).
 */
export async function unlinkAgent(name: string): Promise<UnlinkResult> {
  const config = await loadConfig();
  if (name === SHARED_AGENT_NAME) {
    if (config.include_shared_agent !== true) {
      return { removedFromConfig: false, toggledSharedAgent: true };
    }
    config.include_shared_agent = false;
    // Strip the synthesized entry before saving so loadConfig can rebuild it
    // cleanly next time include_shared_agent flips back on.
    if (config.agents && SHARED_AGENT_NAME in config.agents) {
      const next = { ...config.agents };
      delete next[SHARED_AGENT_NAME];
      config.agents = next;
    }
    await saveConfig(config);
    return { removedFromConfig: true, toggledSharedAgent: true };
  }

  const agents = config.agents ?? {};
  if (!(name in agents)) {
    return { removedFromConfig: false };
  }
  const next = { ...agents };
  delete next[name];
  config.agents = next;
  await saveConfig(config);
  return { removedFromConfig: true };
}

// ============================================================================
// Lockfile
// ============================================================================

function defaultLockfile(): LockfileSchema {
  return { skills: {} };
}

/**
 * Read and parse the lockfile. Missing file returns an empty lockfile. Invalid
 * TOML throws a clear error (lockfile is machine-managed; bad content is a bug).
 */
export async function loadLockfile(): Promise<LockfileSchema> {
  const path = getLockfilePath();
  if (!(await exists(path))) return defaultLockfile();

  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read lockfile at ${path}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid TOML in lockfile at ${path}: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object') return defaultLockfile();
  const obj = parsed as Record<string, unknown>;
  const skills = (obj.skills && typeof obj.skills === 'object')
    ? obj.skills as Record<string, SkillLockEntry>
    : {};
  return { skills };
}

/** Serialize and write the lockfile to disk, creating parent dirs as needed. */
export async function saveLockfile(lockfile: LockfileSchema): Promise<void> {
  const path = getLockfilePath();
  await Deno.mkdir(dirname(path), { recursive: true });
  const header =
    `# reishi-lock.toml — managed by rei, do not edit manually.\n# Tracks upstream state for skills installed with \`rei skills add -t\`.\n\n`;
  const body = stringifyTOML(lockfile as unknown as Record<string, unknown>);
  await Deno.writeTextFile(path, header + body);
}

// ============================================================================
// Init
// ============================================================================

const EXAMPLE_TEMPLATE_COMMENTED = `# example_config.toml — reference template
#
# This file is a heavily-commented reference. Reishi does NOT read it; the
# live config lives next to it as \`config.toml\`. Treat this as a cheat sheet:
# copy values you want into config.toml, or delete this file once you know
# your way around. Paths in this file use \`/path/to/...\` placeholders to
# avoid being mistaken for real settings.
#
# Vocabulary cheat sheet:
#   rule      — an always-on markdown file under rules.source
#   doc       — a project-scoped markdown file under docs.source/<project>/
#   skill     — a directory under skills.source with SKILL.md + supporting files
#   source    — where you author content (this directory's siblings)
#   target    — where reishi syncs (agents and projects)
#   sync      — local-only write from source to targets
#   pull      — fetch fresh content from a remote (only for tracked skills)
#   remote    — the upstream location of a tracked skill (a GitHub repo)

# ----------------------------------------------------------
# Global defaults
# ----------------------------------------------------------

# How reishi syncs to targets: "copy" (default, simple, robust) or "symlink"
# (edits propagate instantly; better for active authoring).
sync_method = "copy"

# Prefix behavior for \`rei skills add -p\` without an explicit value.
# "infer" derives the prefix from the GitHub org/user (recommended).
# "none" disables auto-prefixing — you can still set one explicitly per add.
default_prefix = "infer"

# Separator placed between prefix and skill name (e.g. "readwiseio_book-review").
prefix_separator = "_"

# Opt in to the built-in 'shared' agent target at ~/.agents/. The shared
# target is reishi's cross-agent convention — tools that read AGENTS.md
# (Claude Code, Cursor, OpenCode, etc.) all find the same content here.
# Set to false to disable; the built-in path is fixed and not configurable.
include_shared_agent = true

# ----------------------------------------------------------
# Skills — conditionally activated agent context
# ----------------------------------------------------------

[skills]
# Where you author skills. Each subdirectory is one skill (must contain
# SKILL.md with name + description frontmatter). Reishi never writes here
# without your explicit action.
source = "~/.config/reishi/skills"

# ----------------------------------------------------------
# Update polling — background check for new remote SHAs on tracked skills
# ----------------------------------------------------------

[updates]
# Background-check tracked skills for new remote SHAs and notify in the
# next CLI invocation. Pure read — no downloads, no writes, no surprises.
enabled = true

# How long to wait between background checks, in hours.
interval_hours = 24

# ----------------------------------------------------------
# Rules — always-on agent context, loaded every session
# ----------------------------------------------------------

[rules]
# Where you author rules. Each markdown file or directory in here is a rule
# that gets synced to every agent target.
source = "~/.config/reishi/rules"

# Sync method override for rules. Inherits global \`sync_method\` if unset.
# sync_method = "symlink"

# ----------------------------------------------------------
# Agents — named targets for skills + rules
# ----------------------------------------------------------

# Each agent groups a skills path and a rules path under one name. Use
# --agents=<name> on \`rei sync\` and \`rei skills pull\` to filter.
[agents.claude]
skills = "~/.claude/skills"
rules = "~/.claude/rules"

# [agents.opencode]
# skills = "~/.opencode/skills"
# rules = "~/.opencode/rules"

# ----------------------------------------------------------
# Docs — project-scoped agent context, compiled into an index
# ----------------------------------------------------------

[docs]
# Where you author docs, organized by project subdirectory.
source = "~/.config/reishi/docs"

# Where docs land inside a project, relative to the project root.
default_target = ".agents/docs"

# Filename of the compiled index that lands in the project root.
index_filename = "AGENTS.md"

# Soft cap on the compiled index size, in approximate tokens (chars/4).
# token_budget = 4000

# Sync method override for docs. Inherits global \`sync_method\` if unset.
# sync_method = "symlink"

# ----------------------------------------------------------
# Projects — named targets for docs
# ----------------------------------------------------------

# Each project maps a name to a project root on disk. \`files\` is
# optional; when omitted, every doc under <docs.source>/<name>/ is
# included. Use \`rei docs add <name> --target <path>\` to create one.
# [projects.example]
# path = "/path/to/your/project"
# files = ["api-conventions.md", "testing.md"]
`;

/**
 * Serialize the canonical defaults (plus shared-agent opt-in) as a clean,
 * comment-free TOML document — the format used for the live `config.toml`.
 */
function minimalConfigTemplate(): string {
  const cfg = defaultConfig();
  const obj: Record<string, unknown> = {
    sync_method: cfg.sync_method,
    default_prefix: cfg.default_prefix,
    prefix_separator: cfg.prefix_separator,
    include_shared_agent: true,
    skills: cfg.skills,
    updates: { enabled: cfg.updates.enabled, interval_hours: cfg.updates.interval_hours },
    rules: { source: cfg.rules.source },
    agents: cfg.agents,
    docs: {
      source: cfg.docs.source,
      default_target: cfg.docs.default_target,
      index_filename: cfg.docs.index_filename,
    },
  };
  return stringifyTOML(obj);
}

export interface InitConfigOptions {
  /** When true, skip writing the heavily-commented `example_config.toml`. */
  noExample?: boolean;
}

/**
 * Resolve the path to `example_config.toml`, sited next to the live config.
 */
export function getExampleConfigPath(): string {
  return join(dirname(getConfigPath()), 'example_config.toml');
}

/**
 * Create the live `config.toml` (minimal, comment-free) and, alongside it,
 * a heavily-commented `example_config.toml` reference (skippable with
 * `noExample`). Also writes an empty lockfile and creates the source
 * directories for skills/rules/docs (plus `_deactivated/` under skills).
 *
 * Idempotent: existing files are left alone. In particular, the example
 * file is only written on first init — once a user deletes it, subsequent
 * inits don't recreate it.
 */
export async function initConfig(
  options: InitConfigOptions = {},
): Promise<InitConfigResult> {
  const configPath = getConfigPath();
  const examplePath = getExampleConfigPath();
  const alreadyExisted = await exists(configPath);

  if (!alreadyExisted) {
    await Deno.mkdir(dirname(configPath), { recursive: true });
    await Deno.writeTextFile(configPath, minimalConfigTemplate());
  }

  let exampleWritten = false;
  if (!alreadyExisted && !options.noExample && !(await exists(examplePath))) {
    await Deno.writeTextFile(examplePath, EXAMPLE_TEMPLATE_COMMENTED);
    exampleWritten = true;
  }

  const lockfilePath = getLockfilePath();
  if (!(await exists(lockfilePath))) {
    await saveLockfile(defaultLockfile());
  }

  // Create the source directories from the (effective) config.
  const config = await loadConfig();
  const skillsSource = expandHome(config.skills.source);
  const dirs = [
    skillsSource,
    join(skillsSource, '_deactivated'),
    expandHome(config.rules.source),
    expandHome(config.docs.source),
  ];
  // When the shared-agent target is opted in, materialize ~/.agents/ so the
  // first sync isn't blocked by the parent-dir-missing safety check.
  if (config.include_shared_agent === true) {
    dirs.push(expandHome('~/.agents'));
  }
  const createdDirs: string[] = [];
  for (const dir of dirs) {
    if (!(await exists(dir))) {
      await Deno.mkdir(dir, { recursive: true });
      createdDirs.push(dir);
    }
  }

  return { alreadyExisted, configPath, examplePath, exampleWritten, createdDirs };
}
