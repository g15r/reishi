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

export interface PathsConfig {
  source: string;
  targets: Record<string, string>;
}

export interface UpdatesConfig {
  enabled: boolean;
  interval_hours: number;
}

export interface RulesConfig {
  source: string;
  sync_method?: SyncMethod;
  targets: Record<string, string>;
}

export interface DocsConfig {
  source: string;
  default_target: string;
  index_filename: string;
  sync_method?: SyncMethod;
}

// Populated in Phase 2 — interface shape only; no behavior wired yet.
export interface SkillEntry {
  source_url?: string;
  subpath?: string;
  ref?: string;
  prefix?: string;
  synced_at?: string;
  sync_method?: SyncMethod;
  targets?: string[];
  updates?: boolean;
  last_check?: string;
  remote_hash?: string;
}

export interface ConfigSchema {
  sync_method: SyncMethod;
  default_prefix: DefaultPrefix;
  prefix_separator: string;
  paths: PathsConfig;
  updates: UpdatesConfig;
  rules: RulesConfig;
  docs: DocsConfig;
  skills?: Record<string, SkillEntry>;
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

// ============================================================================
// Defaults
// ============================================================================

export function defaultConfig(): ConfigSchema {
  return {
    sync_method: 'copy',
    default_prefix: 'infer',
    prefix_separator: '_',
    paths: {
      source: '~/.config/reishi/skills',
      targets: {
        claude: '~/.claude/skills',
      },
    },
    updates: {
      enabled: true,
      interval_hours: 24,
    },
    rules: {
      source: '~/.config/reishi/rules',
      targets: {
        claude: '~/.claude/rules',
      },
    },
    docs: {
      source: '~/.config/reishi/docs',
      default_target: '.agents/docs',
      index_filename: 'AGENTS.md',
    },
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
# Paths
# ----------------------------------------------------------

[paths]
# Central source of truth — single canonical location for all managed content.
# All synced skills, rules, and docs land here first.
source = "~/.config/reishi/skills"

# Named sync targets — reishi copies/symlinks from source to these.
# Keys are arbitrary names; values are paths.
[paths.targets]
claude = "~/.claude/skills"
# agents = "~/.agents/skills"
# chezmoi = "~/.local/share/chezmoi/dot_agents/skills"

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

[rules.targets]
claude = "~/.claude/rules"
# opencode = "~/.opencode/rules"

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

# Sync method override for docs
# sync_method = "symlink"
`;

/**
 * Create the config file at the default path with a commented starter
 * template, and create the source directories for skills/rules/docs.
 * Does NOT overwrite an existing config file.
 */
export async function initConfig(): Promise<InitConfigResult> {
  const configPath = getConfigPath();
  const alreadyExisted = await exists(configPath);

  if (!alreadyExisted) {
    await Deno.mkdir(dirname(configPath), { recursive: true });
    await Deno.writeTextFile(configPath, STARTER_TEMPLATE);
  }

  // Create the source directories from the (effective) config.
  const config = await loadConfig();
  const dirs = [
    expandHome(config.paths.source),
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
