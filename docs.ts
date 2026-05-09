/**
 * reishi docs module — project-scoped docs compiled into a token-efficient
 * index and distributed to project roots on disk.
 *
 * Layout:
 *   <docs.source>/
 *     <project-name>/
 *       doc-a.md
 *       doc-b.md
 *
 * Differences from skills/rules:
 *   - Docs are flat-per-project: only direct `.md` children count for v1.
 *   - Targets are real project dirs on disk, not a shared user-level path.
 *   - Doc files are copied/symlinked to `<target>/<docs.default_target>/`,
 *     and the compiled index is written to `<target>/<index_filename>`.
 *
 * Sync method resolution mirrors the skills/rules precedence:
 *   CLI --method > docs.sync_method > global sync_method.
 */

import { parse as parseYAML } from '@std/yaml';
import { dirname, extname, join, relative, resolve } from '@std/path';
import { exists } from '@std/fs';
import { dim, green, italic, magenta, red, yellow } from '@std/fmt/colors';
import { isAbsolute, resolve as resolvePath } from '@std/path';
import {
  type DocsProjectEntry,
  expandHome,
  loadConfig,
  saveConfig,
  type SyncMethod,
} from './config.ts';
import { getDocsSourceDir } from './paths.ts';
import { resolveMethod, type SyncAction } from './sync.ts';

// ============================================================================
// Types
// ============================================================================

export interface DocEntry {
  name: string;
  path: string;
  size: number;
}

/** Re-exported alias for docs-domain consumers. Same shape as `SyncAction`. */
export type DocsSyncAction = SyncAction;

export interface CompileOptions {
  /** When true, return the index text without writing/distributing anything. */
  stdout?: boolean;
  dryRun?: boolean;
  method?: SyncMethod;
  /**
   * Restrict compiled output to these doc basenames (e.g. `api.md`).
   * Undefined = every doc under the project.
   */
  files?: string[];
}

export interface CompileResult {
  project: string;
  targetRoot: string;
  indexPath: string;
  index: string;
  docsWritten: number;
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
export async function listDocs(project: string): Promise<DocEntry[]> {
  const dir = join(await getDocsSourceDir(), project);
  const out: DocEntry[] = [];
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

/**
 * Normalize a user-supplied project root path:
 *   1. `~`-prefixed paths pass through unchanged.
 *   2. Relative paths are resolved against `cwd` to absolute.
 *   3. Absolute paths under `home` are condensed to `~/rest/of/path`.
 *   4. Anything else stays absolute.
 *
 * Pure function — exported for unit tests. Real usage reads `home` from $HOME
 * and `cwd` from `Deno.cwd()`.
 */
export function normalizeProjectPath(
  input: string,
  home: string,
  cwd: string,
): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (trimmed === '~' || trimmed.startsWith('~/')) return trimmed;

  const abs = isAbsolute(trimmed) ? trimmed : resolvePath(cwd, trimmed);
  if (abs === home) return '~';
  if (abs.startsWith(home + '/')) return '~/' + abs.slice(home.length + 1);
  return abs;
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
    let path = '';
    if (options.target) {
      const home = Deno.env.get('HOME') ?? '';
      path = normalizeProjectPath(options.target, home, Deno.cwd());
    }
    projects[name] = { path };
    config.projects = projects;
    await saveConfig(config);
  }
  return { sourceDir: dir, configWritten: !alreadyInConfig };
}

export interface UnlinkProjectOptions {
  /** Delete the source dir too; when false, only the config entry is removed. */
  deleteSourceDir?: boolean;
}

export interface UnlinkProjectResult {
  sourceDir: string;
  removedFromConfig: boolean;
  sourceDirRemoved: boolean;
}

/**
 * Remove a doc project. Always drops the `[docs.projects.<name>]` config
 * entry. Deletes the `<docs.source>/<name>/` directory only when explicitly
 * requested — the CLI handles the two-step confirmation prompt.
 */
export async function unlinkProject(
  name: string,
  options: UnlinkProjectOptions = {},
): Promise<UnlinkProjectResult> {
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
 * Return doc filenames for a given project — used for tab completion
 * once a project argument is already known.
 */
export async function getDocNames(project: string): Promise<string[]> {
  const docs = await listDocs(project);
  return docs.map((f) => f.name);
}

// ============================================================================
// Doc-level move and remove
// ============================================================================

/** Strip an optional trailing `.md` so callers may pass `foo` or `foo.md`. */
export function stripMdSuffix(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function validateDocBasename(name: string): string | null {
  if (!name || name.length === 0) return 'doc name cannot be empty';
  if (name.includes('/') || name.includes('\\')) {
    return 'doc name cannot contain path separators';
  }
  if (name.startsWith('.')) return 'doc name cannot start with a dot';
  return null;
}

export interface MoveDocResult {
  fromPath: string;
  toPath: string;
  /** True when the project's [projects.<name>].files array was rewritten. */
  rewroteFilesArray: boolean;
}

/**
 * Rename a doc under `<docs.source>/<project>/`. Source-only — target
 * cleanup happens on next sync. If the project's
 * `[projects.<name>].files` array references the old basename, the entry
 * is rewritten in-place (preserving order).
 */
export async function moveDoc(
  project: string,
  oldName: string,
  newName: string,
): Promise<MoveDocResult> {
  const oldStem = stripMdSuffix(oldName);
  const newStem = stripMdSuffix(newName);
  const err = validateDocBasename(newStem);
  if (err) throw new Error(err);
  if (oldStem === newStem) {
    throw new Error(`old and new name are the same: ${oldStem}`);
  }

  const projectDir = join(await getDocsSourceDir(), project);
  if (!(await exists(projectDir))) {
    throw new Error(`docs project not found: ${project}`);
  }
  const fromPath = join(projectDir, `${oldStem}.md`);
  const toPath = join(projectDir, `${newStem}.md`);
  if (!(await exists(fromPath))) {
    throw new Error(`doc not found: ${oldStem}.md`);
  }
  if (await exists(toPath)) {
    throw new Error(`destination already exists: ${newStem}.md`);
  }
  await Deno.rename(fromPath, toPath);

  let rewroteFilesArray = false;
  const config = await loadConfig();
  const entry = config.projects?.[project];
  if (entry?.files) {
    const oldFile = `${oldStem}.md`;
    const newFile = `${newStem}.md`;
    if (entry.files.includes(oldFile)) {
      const next = entry.files.map((f) => f === oldFile ? newFile : f);
      config.projects![project] = { ...entry, files: next };
      await saveConfig(config);
      rewroteFilesArray = true;
    }
  }
  return { fromPath, toPath, rewroteFilesArray };
}

export interface RemoveDocResult {
  removedPath: string;
  rewroteFilesArray: boolean;
}

/**
 * Delete a doc under `<docs.source>/<project>/`. Source-only. If the
 * project's `[projects.<name>].files` array references the basename, the
 * entry is dropped from the array.
 */
export async function removeDoc(
  project: string,
  name: string,
): Promise<RemoveDocResult> {
  const stem = stripMdSuffix(name);
  const projectDir = join(await getDocsSourceDir(), project);
  if (!(await exists(projectDir))) {
    throw new Error(`docs project not found: ${project}`);
  }
  const path = join(projectDir, `${stem}.md`);
  if (!(await exists(path))) {
    throw new Error(`doc not found: ${stem}.md`);
  }
  await Deno.remove(path);

  let rewroteFilesArray = false;
  const config = await loadConfig();
  const entry = config.projects?.[project];
  const file = `${stem}.md`;
  if (entry?.files && entry.files.includes(file)) {
    const next = entry.files.filter((f) => f !== file);
    config.projects![project] = { ...entry, files: next };
    await saveConfig(config);
    rewroteFilesArray = true;
  }
  return { removedPath: path, rewroteFilesArray };
}

// ============================================================================
// Index compilation
// ============================================================================

interface ParsedDoc {
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

async function parseDoc(entry: DocEntry): Promise<ParsedDoc> {
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
 * index includes as many docs (priority then alphabetical) as fit under
 * `token_budget`; truncated docs are reported in a trailing one-liner.
 *
 * `targetDir` is the project root; doc links are emitted relative to it
 * via the configured `docs.default_target` subdir.
 */
export async function compileIndex(
  project: string,
  _targetDir: string,
  options: { files?: string[] } = {},
): Promise<string> {
  const config = await loadConfig();
  const all = await listDocs(project);
  const filtered = options.files ? all.filter((f) => options.files!.includes(f.name)) : all;
  const parsed = await Promise.all(filtered.map(parseDoc));
  // Priority descending, then alphabetical by filename.
  parsed.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });

  const targetSubdir = config.docs.default_target;
  const budget = config.docs.token_budget ?? 4000;

  let header = `# ${project} — docs index\n\n`;
  header += `Docs for this project. Files live in \`${targetSubdir}/\`.\n\n`;

  const parts: string[] = [header];
  let tokens = approxTokens(header);
  let included = 0;

  for (const f of parsed) {
    const desc = f.description ? f.description : '(no description)';
    // Relative link from index file (at targetDir) to the doc copy.
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
    parts.push(`(... ${omitted} more doc${omitted === 1 ? '' : 's'} omitted)\n`);
  }
  // `relative` reserved for future "link to source" mode; suppress unused warn.
  void relative;

  return parts.join('');
}

// ============================================================================
// Compile to source — write the index file under <docs.source>/<project>/
// ============================================================================

export interface CompileToSourceResult {
  /** Absolute path to the compiled index in source. */
  outputPath: string;
  index: string;
}

/**
 * Build the per-project index and write it to source as
 * `<docs.source>/<project>/<index_filename>`. The artifact is git-trackable,
 * user-visible, and shipped as-is by `rei docs sync` (no in-memory rebuild
 * during sync). Re-running is idempotent.
 */
export async function compileDocsToSource(
  project: string,
  options: { files?: string[] } = {},
): Promise<CompileToSourceResult> {
  const config = await loadConfig();
  const projectDir = join(await getDocsSourceDir(), project);
  if (!(await exists(projectDir))) {
    throw new Error(`docs project not found: ${project}`);
  }
  // The index path lives in the project source dir under the configured
  // index filename so it is ready to ship one-for-one to <target>/<index_filename>.
  const outputPath = join(projectDir, config.docs.index_filename);
  const index = await compileIndex(project, projectDir, {
    files: options.files,
  });
  await Deno.writeTextFile(outputPath, index);
  return { outputPath, index };
}

// ============================================================================
// Compile command — writes index + distributes docs to a target dir
// ============================================================================

/**
 * Compile and distribute a project's docs to `targetDir` (a real project root
 * on disk). The compiled index is written to `<targetDir>/<index_filename>`
 * and every doc is copied/symlinked into `<targetDir>/<docs.default_target>/`.
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
    files: options.files,
  });

  if (options.stdout) {
    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      docsWritten: 0,
      action: 'skipped',
      reason: 'stdout',
    };
  }

  const method = resolveMethod(
    config.sync_method,
    config.docs.sync_method,
    options.method,
  );
  const docsDir = join(targetRoot, config.docs.default_target);

  const allDocs = await listDocs(project);
  const selected = options.files ? allDocs.filter((f) => options.files!.includes(f.name)) : allDocs;

  if (options.dryRun) {
    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      docsWritten: selected.length,
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
      docsWritten: 0,
      action: 'skipped',
      reason: `parent dir missing: ${parent}`,
    };
  }

  try {
    // dc-R080/dc-R081: write the index to source first (git-trackable,
    // visible), then ship that source artifact to the target.
    const sourceIndexPath = join(
      await getDocsSourceDir(),
      project,
      config.docs.index_filename,
    );
    await Deno.writeTextFile(sourceIndexPath, indexText);

    await Deno.mkdir(targetRoot, { recursive: true });
    await Deno.mkdir(docsDir, { recursive: true });
    if (method === 'symlink') {
      // Replace any stale entry first.
      try {
        await Deno.lstat(indexPath);
        await Deno.remove(indexPath);
      } catch { /* nothing there */ }
      await Deno.symlink(resolve(sourceIndexPath), indexPath);
    } else {
      await Deno.copyFile(sourceIndexPath, indexPath);
    }

    // Clear any stale doc files in the target dir first — keeps rename/remove
    // propagation correct without tracking per-file state.
    for await (const entry of Deno.readDir(docsDir)) {
      if (entry.name.startsWith('.')) continue;
      await Deno.remove(join(docsDir, entry.name), { recursive: true });
    }

    // Each doc is independent — write them in parallel.
    await Promise.all(selected.map(async (f) => {
      const dest = join(docsDir, f.name);
      if (method === 'symlink') {
        await Deno.symlink(resolve(f.path), dest);
      } else {
        await Deno.copyFile(f.path, dest);
      }
    }));

    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      docsWritten: selected.length,
      action: method === 'symlink' ? 'symlinked' : 'copied',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      project,
      targetRoot,
      indexPath,
      index: indexText,
      docsWritten: 0,
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

  // Each project compile + ship is independent — fan out across the plan.
  return await Promise.all(
    plan.map(async ({ project, target, entry }) => ({
      project,
      target,
      result: await compileToTarget(project, target, {
        method: options.method,
        dryRun: options.dryRun,
        stdout: options.stdout,
        files: entry.files,
      }),
    })),
  );
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
    return `${red('❌ Compile failed')} ${magenta(project)} ${
      dim(italic(`(${result.reason ?? ''})`))
    }`;
  }
  if (result.action === 'skipped') {
    return `${yellow('⚠ Skipped')} ${magenta(project)} ${dim(italic(`(${result.reason ?? ''})`))}`;
  }
  const verb = result.action === 'symlinked' ? 'symlinked' : 'copied';
  return `${green('✨ Compiled')} ${
    magenta(project)
  } → ${indexFilename} + ${result.docsWritten} doc${result.docsWritten === 1 ? '' : 's'} ${
    dim(italic(`(${verb} to ${targetSubdir})`))
  }`;
}
