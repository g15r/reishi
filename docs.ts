/**
 * reishi docs module — project-scoped doc fragments compiled into a
 * token-efficient index and distributed to project roots on disk.
 *
 * Layout:
 *   <docs.source>/
 *     <project-name>/
 *       fragment-a.md
 *       fragment-b.md
 *
 * Differences from skills/rules:
 *   - Docs are flat-per-project: only direct `.md` children count for v1.
 *   - Targets are real project dirs on disk, not a shared user-level path.
 *   - Fragments are copied/symlinked to `<target>/<docs.default_target>/`,
 *     and the compiled index is written to `<target>/<index_filename>`.
 *
 * Sync method resolution mirrors the skills/rules precedence:
 *   CLI --method > docs.sync_method > global sync_method.
 */

import { parse as parseYAML } from '@std/yaml';
import { dirname, extname, join, relative, resolve } from '@std/path';
import { copy, exists } from '@std/fs';
import { dim, green, italic, magenta, red, yellow } from '@std/fmt/colors';
import {
  type DocsProjectEntry,
  expandHome,
  loadConfig,
  saveConfig,
  type SyncMethod,
} from './config.ts';
import { getDocsSourceDir } from './paths.ts';
import { resolveMethod } from './sync.ts';

// ============================================================================
// Types
// ============================================================================

export interface FragmentEntry {
  name: string;
  path: string;
  size: number;
}

export type DocsSyncAction = 'copied' | 'symlinked' | 'skipped' | 'failed';

export interface DocsSyncResult {
  project: string;
  target: string;
  targetRoot: string;
  /** Number of fragments distributed to the target. */
  fragmentsWritten: number;
  action: DocsSyncAction;
  reason?: string;
}

export interface CompileOptions {
  /** When true, return the index text without writing/distributing anything. */
  stdout?: boolean;
  dryRun?: boolean;
  method?: SyncMethod;
  /**
   * Restrict compiled output to these fragment basenames (e.g. `api.md`).
   * Undefined = every fragment under the project.
   */
  fragments?: string[];
}

export interface CompileResult {
  project: string;
  targetRoot: string;
  indexPath: string;
  index: string;
  fragmentsWritten: number;
  action: DocsSyncAction;
  reason?: string;
}

// ============================================================================
// Listing
// ============================================================================

/** Subdirectory names under docs.source, excluding dotfiles. */
export async function listDocProjects(): Promise<string[]> {
  const dir = await getDocsSourceDir();
  const out: string[] = [];
  if (!(await exists(dir))) return out;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory) continue;
    out.push(entry.name);
  }
  out.sort();
  return out;
}

/** Direct `.md` children of a project dir. Nested dirs and dotfiles are ignored. */
export async function listFragments(project: string): Promise<FragmentEntry[]> {
  const dir = join(await getDocsSourceDir(), project);
  const out: FragmentEntry[] = [];
  if (!(await exists(dir))) return out;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isFile) continue;
    if (extname(entry.name) !== '.md') continue;
    const abs = join(dir, entry.name);
    const stat = await Deno.stat(abs);
    out.push({ name: entry.name, path: abs, size: stat.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ============================================================================
// Project-level add / remove
// ============================================================================

export interface AddDocProjectOptions {
  /** Optional project root path stored in `[docs.projects.<name>].target`. */
  target?: string;
  /** Allow the source dir to already exist without erroring. */
  force?: boolean;
}

export interface AddDocProjectResult {
  sourceDir: string;
  /** True when the `[docs.projects.<name>]` entry was newly written. */
  configWritten: boolean;
}

/**
 * Create a doc project: make the `<docs.source>/<project>/` dir and write a
 * `[docs.projects.<project>]` entry into config.toml. Idempotent enough that
 * re-running against an existing project is safe with `force: true`.
 */
export async function addDocProject(
  name: string,
  options: AddDocProjectOptions = {},
): Promise<AddDocProjectResult> {
  const dir = join(await getDocsSourceDir(), name);
  const dirExisted = await exists(dir);
  if (dirExisted && !options.force) {
    throw new Error(`docs project already exists: ${name}`);
  }
  if (!dirExisted) {
    await Deno.mkdir(dir, { recursive: true });
  }

  const config = await loadConfig();
  const projects = config.projects ?? {};
  const alreadyInConfig = Boolean(projects[name]);
  if (!alreadyInConfig) {
    projects[name] = options.target ? { path: options.target } : { path: '' };
    config.projects = projects;
    await saveConfig(config);
  }
  return { sourceDir: dir, configWritten: !alreadyInConfig };
}

export interface RemoveDocProjectOptions {
  /** Delete the source dir too; when false, only the config entry is removed. */
  deleteSourceDir?: boolean;
}

export interface RemoveDocProjectResult {
  sourceDir: string;
  removedFromConfig: boolean;
  sourceDirRemoved: boolean;
}

/**
 * Remove a doc project. Always drops the `[docs.projects.<name>]` config
 * entry. Deletes the `<docs.source>/<name>/` directory only when explicitly
 * requested — the CLI handles the two-step confirmation prompt.
 */
export async function removeDocProject(
  name: string,
  options: RemoveDocProjectOptions = {},
): Promise<RemoveDocProjectResult> {
  const config = await loadConfig();
  const projects = config.projects ?? {};
  const hadEntry = Boolean(projects[name]);
  if (hadEntry) {
    delete projects[name];
    config.projects = projects;
    await saveConfig(config);
  }

  const dir = join(await getDocsSourceDir(), name);
  let sourceDirRemoved = false;
  if (options.deleteSourceDir && (await exists(dir))) {
    await Deno.remove(dir, { recursive: true });
    sourceDirRemoved = true;
  }
  return { sourceDir: dir, removedFromConfig: hadEntry, sourceDirRemoved };
}

/** Return all doc project names — used for tab completion. */
export async function getDocProjectNames(): Promise<string[]> {
  return await listDocProjects();
}

/**
 * Return fragment filenames for a given project — used for tab completion
 * once a project argument is already known.
 */
export async function getFragmentNames(project: string): Promise<string[]> {
  const fragments = await listFragments(project);
  return fragments.map((f) => f.name);
}

// Fragment-level add/remove retired in Phase 7: users manage fragment files
// directly. `rei docs add/remove` now operates at the project level — see
// addDocProject / removeDocProject above.

// ============================================================================
// Index compilation
// ============================================================================

interface ParsedFragment {
  name: string;
  path: string;
  description: string;
  priority: number;
  body: string;
}

/** YAML frontmatter + body split. Returns null frontmatter if none present. */
function splitFrontmatter(
  text: string,
): { frontmatter: Record<string, unknown> | null; body: string } {
  if (!text.startsWith('---')) return { frontmatter: null, body: text };
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: text };
  try {
    const fm = parseYAML(match[1]);
    if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
      return { frontmatter: fm as Record<string, unknown>, body: match[2] };
    }
  } catch {
    // Bad YAML — treat as no frontmatter.
  }
  return { frontmatter: null, body: text };
}

/**
 * Pick a one-line description: frontmatter.description > first non-heading
 * paragraph line > first heading text > empty string. Body is scanned after
 * the frontmatter is stripped.
 */
function extractDescription(
  frontmatter: Record<string, unknown> | null,
  body: string,
): string {
  const fmDesc = frontmatter?.description;
  if (typeof fmDesc === 'string' && fmDesc.trim().length > 0) {
    return fmDesc.trim();
  }

  // First non-heading, non-empty line.
  const lines = body.split('\n');
  let firstHeading = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) {
      if (!firstHeading) {
        firstHeading = trimmed.replace(/^#+\s*/, '').trim();
      }
      continue;
    }
    // Strip trivial markdown decorations so the index reads cleanly.
    const cleaned = trimmed
      .replace(/^[-*]\s+/, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1');
    if (cleaned.length > 0) return cleaned;
  }
  return firstHeading;
}

async function parseFragment(entry: FragmentEntry): Promise<ParsedFragment> {
  const text = await Deno.readTextFile(entry.path);
  const { frontmatter, body } = splitFrontmatter(text);
  const description = extractDescription(frontmatter, body);
  const rawPriority = frontmatter?.priority;
  const priority = typeof rawPriority === 'number' && Number.isFinite(rawPriority)
    ? rawPriority
    : 0;
  return { name: entry.name, path: entry.path, description, priority, body };
}

/** chars/4 is the v1 token approximation — good enough, fast, no dep. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compile the markdown index for a project, relative to a target dir. The
 * index includes as many fragments (priority then alphabetical) as fit under
 * `token_budget`; truncated fragments are reported in a trailing one-liner.
 *
 * `targetDir` is the project root; fragment links are emitted relative to it
 * via the configured `docs.default_target` subdir.
 */
export async function compileIndex(
  project: string,
  targetDir: string,
  options: { fragments?: string[] } = {},
): Promise<string> {
  const config = await loadConfig();
  const all = await listFragments(project);
  const filtered = options.fragments
    ? all.filter((f) => options.fragments!.includes(f.name))
    : all;
  const parsed = await Promise.all(filtered.map(parseFragment));
  // Priority descending, then alphabetical by filename.
  parsed.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });

  const targetSubdir = config.docs.default_target;
  const budget = config.docs.token_budget ?? 4000;

  let header = `# ${project} — docs index\n\n`;
  header += `Docs for this project. Fragments live in \`${targetSubdir}/\`.\n\n`;

  const parts: string[] = [header];
  let tokens = approxTokens(header);
  let included = 0;

  for (const f of parsed) {
    const desc = f.description ? f.description : '(no description)';
    // Relative link from index file (at targetDir) to the fragment copy.
    const relPath = join(targetSubdir, f.name);
    const section = `## ${f.name}\n${desc}\n\nSee: \`${relPath}\`\n\n`;
    const cost = approxTokens(section);
    if (tokens + cost > budget && included > 0) break;
    parts.push(section);
    tokens += cost;
    included += 1;
  }

  const omitted = parsed.length - included;
  if (omitted > 0) {
    parts.push(`(... ${omitted} more fragment${omitted === 1 ? '' : 's'} omitted)\n`);
  }
  // `relative` reserved for future "link to source" mode; suppress unused warn.
  void relative;

  return parts.join('');
}

// ============================================================================
// Compile command — writes index + distributes fragments to a target dir
// ============================================================================

/**
 * Compile and distribute a project's docs to `targetDir` (a real project root
 * on disk). The compiled index is written to `<targetDir>/<index_filename>`
 * and every fragment is copied/symlinked into `<targetDir>/<docs.default_target>/`.
 *
 * Honors `options.stdout` (emit index to stdout, write nothing) and
 * `options.dryRun` (plan only).
 */
export async function compileToTarget(
  project: string,
  targetDir: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const config = await loadConfig();
  const targetRoot = expandHome(targetDir);
  const indexPath = join(targetRoot, config.docs.index_filename);
  const indexText = await compileIndex(project, targetRoot, {
    fragments: options.fragments,
  });

  if (options.stdout) {
    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      fragmentsWritten: 0,
      action: 'skipped',
      reason: 'stdout',
    };
  }

  const method = resolveMethod(
    config.sync_method,
    config.docs.sync_method,
    options.method,
  );
  const fragmentsDir = join(targetRoot, config.docs.default_target);

  const allFragments = await listFragments(project);
  const selected = options.fragments
    ? allFragments.filter((f) => options.fragments!.includes(f.name))
    : allFragments;

  if (options.dryRun) {
    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      fragmentsWritten: selected.length,
      action: method === 'symlink' ? 'symlinked' : 'copied',
      reason: 'dry run',
    };
  }

  const parent = dirname(targetRoot);
  if (!(await exists(parent))) {
    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      fragmentsWritten: 0,
      action: 'skipped',
      reason: `parent dir missing: ${parent}`,
    };
  }

  try {
    await Deno.mkdir(targetRoot, { recursive: true });
    await Deno.mkdir(fragmentsDir, { recursive: true });
    await Deno.writeTextFile(indexPath, indexText);

    // Clear any stale fragments in the target dir first — keeps rename/remove
    // propagation correct without tracking per-file state.
    for await (const entry of Deno.readDir(fragmentsDir)) {
      if (entry.name.startsWith('.')) continue;
      await Deno.remove(join(fragmentsDir, entry.name), { recursive: true });
    }

    for (const f of selected) {
      const dest = join(fragmentsDir, f.name);
      if (method === 'symlink') {
        await Deno.symlink(resolve(f.path), dest);
      } else {
        await Deno.copyFile(f.path, dest);
      }
    }

    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      fragmentsWritten: selected.length,
      action: method === 'symlink' ? 'symlinked' : 'copied',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      fragmentsWritten: 0,
      action: 'failed',
      reason: message,
    };
  }
}

// ============================================================================
// Sync — iterate [docs.projects] and compile each
// ============================================================================

export interface DocsSyncOptions {
  /** Restrict to a single project by name. */
  project?: string;
  /** Override the target root (only valid when `project` is provided). */
  targetOverride?: string;
  method?: SyncMethod;
  dryRun?: boolean;
  /** Build the index only; return it in `result.index` without writing. */
  stdout?: boolean;
}

export interface DocsSyncRun {
  project: string;
  target: string;
  result: CompileResult;
}

/**
 * Sync every configured docs project (or just one). Returns one run per
 * project. When `project` is specified but not in config, `targetOverride`
 * must be supplied.
 */
export async function syncDocs(
  options: DocsSyncOptions = {},
): Promise<DocsSyncRun[]> {
  const config = await loadConfig();
  const projects = config.projects ?? {};

  type Plan = { project: string; target: string; entry: DocsProjectEntry };
  const plan: Plan[] = [];

  if (options.project) {
    const entry = projects[options.project];
    if (entry) {
      const target = options.targetOverride ?? entry.path;
      plan.push({ project: options.project, target, entry });
    } else if (options.targetOverride) {
      plan.push({
        project: options.project,
        target: options.targetOverride,
        entry: { path: options.targetOverride },
      });
    } else {
      throw new Error(
        `project '${options.project}' has no [projects] entry — pass --target to override`,
      );
    }
  } else {
    for (const [name, entry] of Object.entries(projects)) {
      plan.push({ project: name, target: entry.path, entry });
    }
  }

  const runs: DocsSyncRun[] = [];
  for (const { project, target, entry } of plan) {
    const result = await compileToTarget(project, target, {
      method: options.method,
      dryRun: options.dryRun,
      stdout: options.stdout,
      fragments: entry.fragments,
    });
    runs.push({ project, target, result });
  }
  return runs;
}

// ============================================================================
// CLI output helpers
// ============================================================================

/** One-liner summary for a single compile run. */
export function formatCompileSummary(
  project: string,
  result: CompileResult,
  indexFilename: string,
  targetSubdir: string,
): string {
  if (result.action === 'failed') {
    return `${red('❌ Compile failed')} ${magenta(project)} ${dim(italic(`(${result.reason ?? ''})`))}`;
  }
  if (result.action === 'skipped') {
    return `${yellow('⚠ Skipped')} ${magenta(project)} ${dim(italic(`(${result.reason ?? ''})`))}`;
  }
  const verb = result.action === 'symlinked' ? 'symlinked' : 'copied';
  return `${green('✨ Compiled')} ${magenta(project)} → ${indexFilename} + ${result.fragmentsWritten} fragment${
    result.fragmentsWritten === 1 ? '' : 's'
  } ${dim(italic(`(${verb} to ${targetSubdir})`))}`;
}

