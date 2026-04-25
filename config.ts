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

// --- Sync target base types ------------------------------------------------

/** Base shape for all sync destinations. */
export interface SyncTarget {
  name: string;
  path: string;
}

/** Agent destinations group skills + rules paths under one name. */
export interface AgentTarget extends SyncTarget {
  skills: string;
  rules: string;
}

/** Project destinations point at a project root for docs distribution. */
export interface ProjectTarget extends SyncTarget {
  fragments?: string[];
  token_budget?: number;
}

/** Base sync options shared across all three domains. */
export interface BaseSyncOptions {
  method?: SyncMethod;
  dryRun?: boolean;
  check?: boolean;
}

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
}

export interface DocsProjectEntry {
  /** Absolute or `~`-prefixed path to the project root. */
  path: string;
  /**
   * Restrict compiled output to this subset of fragment filenames (basenames
   * in the project's docs.source dir). Undefined = all fragments.
   */
  fragments?: string[];
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

const STARTER_TEMPLATE_COMMENTED = `# ~/.config/reishi/config.toml
#
# Welcome to reishi. This config maps your authoring source (where you edit
# rules, skills, and docs) to the targets reishi syncs to (your agents and
# projects). Edit values inline; comments are for orientation, not parsing.
#
# Vocabulary cheat sheet:
#   fragment  — any single markdown file reishi manages
#   source    — where you author content (this directory's siblings)
#   target    — where reishi syncs fragments (agents and projects)
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
# Where you author doc fragments, organized by project subdirectory.
source = "~/.config/reishi/docs"

# Where fragments land inside a project, relative to the project root.
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

# Each project maps a name to a project root on disk. \`fragments\` is
# optional; when omitted, every fragment under <docs.source>/<name>/ is
# included. Use \`rei docs add <name> --target <path>\` to create one.
# [projects.myproject]
# path = "~/code/myproject"
# fragments = ["api-conventions.md", "testing.md"]
`;

/**
 * Build the comment-free starter template by serializing the canonical
 * defaults plus the opt-ins the commented template ships with. Keeps the
 * two outputs in lockstep so toggling `--no-comment` only strips comments.
 */
function starterTemplateNoComment(): string {
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
  /** When true, write a clean comment-free template instead of the documented one. */
  noComment?: boolean;
}

/**
 * Create the config file at the default path with a commented starter
 * template, write an empty lockfile alongside it, and create the source
 * directories for skills/rules/docs (plus `_deactivated/` under the skills
 * source). Idempotent: existing files and dirs are left as-is.
 */
export async function initConfig(
  options: InitConfigOptions = {},
): Promise<InitConfigResult> {
  const configPath = getConfigPath();
  const alreadyExisted = await exists(configPath);

  if (!alreadyExisted) {
    await Deno.mkdir(dirname(configPath), { recursive: true });
    const template = options.noComment
      ? starterTemplateNoComment()
      : STARTER_TEMPLATE_COMMENTED;
    await Deno.writeTextFile(configPath, template);
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

  return { alreadyExisted, configPath, createdDirs };
}
