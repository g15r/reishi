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
}

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
  if (!(await exists(path))) return defaults;

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

  return deepMerge(defaults, parsed);
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

const STARTER_TEMPLATE = `# ~/.config/reishi/config.toml

# ----------------------------------------------------------
# Global defaults
# ----------------------------------------------------------

# How reishi distributes content to targets: "copy" or "symlink"
sync_method = "copy"

# Default prefix behavior when --prefix is used without a value
# "infer" = derive from GitHub org/user, "none" = no prefix
default_prefix = "infer"

# Separator between prefix and skill name
prefix_separator = "_"

# ----------------------------------------------------------
# Skills
# ----------------------------------------------------------

[skills]
# Source of truth for skills — all managed skills live here.
source = "~/.config/reishi/skills"

# ----------------------------------------------------------
# Update polling
# ----------------------------------------------------------

[updates]
# Check tracked skills for upstream changes: true / false
enabled = true

# How often to check, in hours
interval_hours = 24

# ----------------------------------------------------------
# Rules
# ----------------------------------------------------------

[rules]
# Where reishi-managed rules live
source = "~/.config/reishi/rules"

# Sync method override for rules (inherits global sync_method if unset)
# sync_method = "symlink"

# ----------------------------------------------------------
# Agents — named destinations for skills + rules
# ----------------------------------------------------------

# Each agent groups a skills path and a rules path under one name.
# Use --agents=<name> on sync/pull to filter.
[agents.claude]
skills = "~/.claude/skills"
rules = "~/.claude/rules"

# [agents.opencode]
# skills = "~/.opencode/skills"
# rules = "~/.opencode/rules"

# ----------------------------------------------------------
# Docs
# ----------------------------------------------------------

[docs]
# Where reishi-managed doc fragments live, organized by project subdirs
source = "~/.config/reishi/docs"

# Default target path relative to project root
default_target = ".agents/docs"

# Name of the compiled index file placed in the project root
index_filename = "AGENTS.md"

# Soft cap on the compiled index size, in approximate tokens (chars/4).
# token_budget = 4000

# Sync method override for docs
# sync_method = "symlink"

# ----------------------------------------------------------
# Projects — named destinations for docs
# ----------------------------------------------------------

# Each project maps a name to a project root on disk. Fragments are optional;
# omit to include every fragment in <docs.source>/<name>/.
# [projects.myproject]
# path = "~/code/myproject"
# fragments = ["api-conventions.md", "testing.md"]
`;

/**
 * Create the config file at the default path with a commented starter
 * template, write an empty lockfile alongside it, and create the source
 * directories for skills/rules/docs (plus `_deactivated/` under the skills
 * source). Idempotent: existing files and dirs are left as-is.
 */
export async function initConfig(): Promise<InitConfigResult> {
  const configPath = getConfigPath();
  const alreadyExisted = await exists(configPath);

  if (!alreadyExisted) {
    await Deno.mkdir(dirname(configPath), { recursive: true });
    await Deno.writeTextFile(configPath, STARTER_TEMPLATE);
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
  const createdDirs: string[] = [];
  for (const dir of dirs) {
    if (!(await exists(dir))) {
      await Deno.mkdir(dir, { recursive: true });
      createdDirs.push(dir);
    }
  }

  return { alreadyExisted, configPath, createdDirs };
}
