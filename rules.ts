/**
 * reishi rules module — manages global markdown rules files that get
 * distributed (copied or symlinked) to agent rule paths.
 *
 * Rules are a second content-type that shares the sync-method resolution model
 * with skills:
 *   CLI override > rules.sync_method > global sync_method
 *
 * Unlike skills, rules are NOT tracked per-item. They are just files/dirs in
 * `rules.source` that get distributed to every entry in `rules.targets`.
 * Individual `.md` files AND directories of files are both supported.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from '@std/path';
import { copy, exists } from '@std/fs';
import { dim, green, italic, magenta, red, yellow } from '@std/fmt/colors';
import { expandHome, loadConfig, type SyncMethod } from './config.ts';
import { getRulesSourceDir } from './paths.ts';
import { resolveMethod, resolveRuleTargets, type SyncAction } from './sync.ts';

/** Default basename for the rules-compile source artifact. */
export const COMPILED_RULES_FILENAME = 'AGENTS.md';

// ============================================================================
// Types
// ============================================================================

export type RuleKind = 'file' | 'directory';

export interface RuleEntry {
  name: string;
  /** Absolute path to the rule source (file or dir). */
  path: string;
  kind: RuleKind;
}

export interface RulesSyncOptions {
  agents?: string[];
  method?: SyncMethod;
  dryRun?: boolean;
}

/** Re-exported alias for rules-domain consumers. Same shape as `SyncAction`. */
export type RulesSyncAction = SyncAction;

export interface RulesSyncResult {
  ruleName: string;
  target: string;
  targetPath: string;
  action: SyncAction;
  reason?: string;
}

// ============================================================================
// List
// ============================================================================

/**
 * Enumerate rules in the rules.source dir. Files are named by their basename
 * minus `.md`; directories by their basename. Dotfiles are skipped.
 */
export async function listRules(): Promise<RuleEntry[]> {
  const rulesDir = await getRulesSourceDir();
  const out: RuleEntry[] = [];
  if (!(await exists(rulesDir))) return out;

  for await (const entry of Deno.readDir(rulesDir)) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(rulesDir, entry.name);
    if (entry.isDirectory) {
      out.push({ name: entry.name, path: abs, kind: 'directory' });
    } else if (entry.isFile) {
      const base = entry.name.endsWith('.md')
        ? entry.name.slice(0, -3)
        : entry.name;
      out.push({ name: base, path: abs, kind: 'file' });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Return just the rule names — used for tab completion. */
export async function getRuleNames(): Promise<string[]> {
  const rules = await listRules();
  return rules.map((r) => r.name);
}

// ============================================================================
// Source-side CRUD: move and remove
// ============================================================================

/** Strip an optional trailing `.md` so callers may pass `foo` or `foo.md`. */
export function stripMdSuffix(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Validate a fragment-style basename: non-empty, no path separators, no leading
 * dot. Returns an error message string or null if valid.
 */
function validateFragmentBasename(name: string, kind: string): string | null {
  if (!name || name.length === 0) return `${kind} name cannot be empty`;
  if (name.includes('/') || name.includes('\\')) {
    return `${kind} name cannot contain path separators`;
  }
  if (name.startsWith('.')) return `${kind} name cannot start with a dot`;
  return null;
}

export interface MoveRuleResult {
  fromPath: string;
  toPath: string;
}

/**
 * Rename a rule fragment in source. Source-only — target cleanup is handled by
 * `clean_on_sync` on the next sync. Accepts either `foo` or `foo.md`.
 */
export async function moveRule(
  oldName: string,
  newName: string,
): Promise<MoveRuleResult> {
  const oldStem = stripMdSuffix(oldName);
  const newStem = stripMdSuffix(newName);
  const err = validateFragmentBasename(newStem, 'rule');
  if (err) throw new Error(err);
  if (oldStem === newStem) {
    throw new Error(`old and new name are the same: ${oldStem}`);
  }
  const rulesDir = await getRulesSourceDir();
  const fromPath = join(rulesDir, `${oldStem}.md`);
  const toPath = join(rulesDir, `${newStem}.md`);
  if (!(await exists(fromPath))) {
    throw new Error(`rule not found: ${oldStem}.md`);
  }
  if (await exists(toPath)) {
    throw new Error(`destination already exists: ${newStem}.md`);
  }
  await Deno.rename(fromPath, toPath);
  return { fromPath, toPath };
}

export interface RemoveRuleResult {
  removedPath: string;
}

/**
 * Delete a rule fragment from source. Source-only — target cleanup is handled
 * by `clean_on_sync` on the next sync. Accepts either `foo` or `foo.md`.
 */
export async function removeRule(name: string): Promise<RemoveRuleResult> {
  const stem = stripMdSuffix(name);
  const rulesDir = await getRulesSourceDir();
  const path = join(rulesDir, `${stem}.md`);
  if (!(await exists(path))) {
    throw new Error(`rule not found: ${stem}.md`);
  }
  await Deno.remove(path);
  return { removedPath: path };
}

// ============================================================================
// Compile — concatenate every rule into a single source artifact
// ============================================================================

/**
 * Resolve `compile_file` relative to `compile_root`, rejecting paths that
 * escape the root via `..`. Both inputs may use `~/`. Returns the absolute
 * destination path.
 */
export function resolveCompileTarget(
  compileRoot: string,
  compileFile: string,
): string {
  const root = expandHome(compileRoot);
  const absRoot = isAbsolute(root) ? resolve(root) : resolve(root);
  const candidate = expandHome(compileFile);
  const dest = isAbsolute(candidate) ? resolve(candidate) : resolve(absRoot, candidate);
  const rel = relative(absRoot, dest);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new Error(
      `compile_file escapes compile_root: '${compileFile}' (root: ${absRoot})`,
    );
  }
  return dest;
}

export interface CompileRulesResult {
  /** Absolute path to the source artifact written. */
  outputPath: string;
  fragmentCount: number;
}

/**
 * Concatenate every fragment in `rules.source` into a single markdown file
 * in source. The artifact lives at `<rules.source>/AGENTS.md` by default —
 * git-trackable, user-visible, ready for sync to ship to compile-opt-in
 * agents.
 *
 * Format: a top-level `# Agent rules` header, then one `## <name>` section
 * per fragment with the fragment body inlined (frontmatter preserved as-is).
 * The compile artifact itself is excluded from the input set so re-running
 * doesn't double-nest.
 */
export async function compileRules(
  options: { outputPath?: string } = {},
): Promise<CompileRulesResult> {
  const rulesDir = await getRulesSourceDir();
  const outputPath = options.outputPath ?? join(rulesDir, COMPILED_RULES_FILENAME);
  const rules = await listRules();
  const filtered = rules.filter((r) =>
    !(r.kind === 'file' && resolve(r.path) === resolve(outputPath))
  );

  // Read each fragment's body in parallel, preserving the source-listing order
  // so the compiled artifact is stable across runs.
  const sectionsPerRule = await Promise.all(filtered.map(async (r) => {
    if (r.kind === 'directory') {
      const dirEntries: string[] = [];
      for await (const entry of Deno.readDir(r.path)) {
        if (!entry.isFile || !entry.name.endsWith('.md')) continue;
        dirEntries.push(entry.name);
      }
      dirEntries.sort();
      const bodies = await Promise.all(
        dirEntries.map((name) => Deno.readTextFile(join(r.path, name))),
      );
      return dirEntries.map((name, i) =>
        `\n## ${r.name}/${name.slice(0, -3)}\n\n${bodies[i].trimEnd()}\n`
      );
    }
    const body = await Deno.readTextFile(r.path);
    return [`\n## ${r.name}\n\n${body.trimEnd()}\n`];
  }));
  const sections = sectionsPerRule.flat();
  const parts = ['# Agent rules\n', ...sections];
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  await Deno.writeTextFile(outputPath, parts.join(''));
  return { outputPath, fragmentCount: sections.length };
}

// ============================================================================
// Sync
// ============================================================================

/**
 * Copy or symlink every rule in rules.source to every (filtered) target in
 * rules.targets. Resolution order for method: CLI > rules.sync_method > global.
 */
export async function syncRules(
  options: RulesSyncOptions = {},
): Promise<RulesSyncResult[]> {
  const config = await loadConfig();
  const rules = await listRules();
  const results: RulesSyncResult[] = [];

  if (options.agents) {
    const unknown = options.agents.filter((t) => !(t in config.agents));
    if (unknown.length > 0) {
      return [{
        ruleName: '(filter)',
        target: unknown.join(','),
        targetPath: '',
        action: 'failed',
        reason: `unknown agent(s): ${unknown.join(', ')}`,
      }];
    }
  }

  const method = resolveMethod(
    config.sync_method,
    config.rules.sync_method,
    options.method,
  );

  // sy-R060/sy-R063: if any participating agent opts in to compile, run the
  // rules-compile step now so its source artifact is ready to ship below.
  const participatingAgents = Object.entries(config.agents).filter(([name]) =>
    !options.agents || options.agents.includes(name)
  );
  const wantsCompile = participatingAgents.some(([, a]) => a.compile === true);
  let compiledSourcePath: string | null = null;
  if (wantsCompile && !options.dryRun) {
    const result = await compileRules();
    compiledSourcePath = result.outputPath;
  }

  const targets = resolveRuleTargets(options.agents, config.agents);
  for (const { name: targetName, path: targetRoot } of targets) {
    const targetParent = dirname(targetRoot);
    if (!(await exists(targetParent))) {
      for (const rule of rules) {
        results.push({
          ruleName: rule.name,
          target: targetName,
          targetPath: join(targetRoot, basename(rule.path)),
          action: 'skipped',
          reason: `parent dir missing: ${targetParent}`,
        });
      }
      continue;
    }

    if (!options.dryRun) {
      await Deno.mkdir(targetRoot, { recursive: true });
    }

    for (const rule of rules) {
      const writeName = basename(rule.path);
      const targetPath = join(targetRoot, writeName);

      if (options.dryRun) {
        results.push({
          ruleName: rule.name,
          target: targetName,
          targetPath,
          action: method === 'symlink' ? 'symlinked' : 'copied',
          reason: 'dry run',
        });
        continue;
      }

      try {
        // Clear any prior entry (dir, file, symlink, or dangling symlink).
        if (await exists(targetPath)) {
          await Deno.remove(targetPath, { recursive: true });
        } else {
          try {
            await Deno.lstat(targetPath);
            await Deno.remove(targetPath);
          } catch { /* nothing there */ }
        }

        if (method === 'symlink') {
          await Deno.symlink(resolve(rule.path), targetPath);
          results.push({
            ruleName: rule.name,
            target: targetName,
            targetPath,
            action: 'symlinked',
          });
        } else if (rule.kind === 'directory') {
          await copy(rule.path, targetPath, { overwrite: true });
          results.push({
            ruleName: rule.name,
            target: targetName,
            targetPath,
            action: 'copied',
          });
        } else {
          await Deno.copyFile(rule.path, targetPath);
          results.push({
            ruleName: rule.name,
            target: targetName,
            targetPath,
            action: 'copied',
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          ruleName: rule.name,
          target: targetName,
          targetPath,
          action: 'failed',
          reason: message,
        });
      }
    }
  }

  // Ship the rules-compile artifact to every opt-in agent. Independent of the
  // per-fragment loop above so target-parent or per-rule failures don't block
  // the compile artifact (and vice versa).
  for (const [agentName, agent] of participatingAgents) {
    if (agent.compile !== true) continue;
    const compileFile = agent.compile_file ?? COMPILED_RULES_FILENAME;
    const compileRoot = agent.compile_root ?? dirname(expandHome(agent.rules));
    let dest: string;
    try {
      dest = resolveCompileTarget(compileRoot, compileFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ruleName: '(compile)',
        target: agentName,
        targetPath: '',
        action: 'failed',
        reason: message,
      });
      continue;
    }
    if (options.dryRun) {
      results.push({
        ruleName: '(compile)',
        target: agentName,
        targetPath: dest,
        action: method === 'symlink' ? 'symlinked' : 'copied',
        reason: 'dry run',
      });
      continue;
    }
    if (!compiledSourcePath) continue;
    const destParent = dirname(dest);
    try {
      await Deno.mkdir(destParent, { recursive: true });
      try {
        await Deno.lstat(dest);
        await Deno.remove(dest);
      } catch { /* nothing there */ }
      if (method === 'symlink') {
        await Deno.symlink(resolve(compiledSourcePath), dest);
        results.push({
          ruleName: '(compile)',
          target: agentName,
          targetPath: dest,
          action: 'symlinked',
        });
      } else {
        await Deno.copyFile(compiledSourcePath, dest);
        results.push({
          ruleName: '(compile)',
          target: agentName,
          targetPath: dest,
          action: 'copied',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ruleName: '(compile)',
        target: agentName,
        targetPath: dest,
        action: 'failed',
        reason: message,
      });
    }
  }

  return results;
}

// ============================================================================
// CLI output helpers
// ============================================================================

/** Compact one-liner for a rules sync batch. */
export function printRulesSummary(results: RulesSyncResult[]): void {
  if (results.length === 0) return;
  const operations = results.length;
  const rules = new Set(results.map((r) => r.ruleName));
  const targets = new Set(results.map((r) => r.target));
  const failed = results.filter((r) => r.action === 'failed');
  const skipped = results.filter((r) => r.action === 'skipped');

  if (failed.length === 0 && skipped.length === 0) {
    console.log(
      `${green('✨ Synced')} ${rules.size} rule${rules.size === 1 ? '' : 's'} to ${targets.size} target${
        targets.size === 1 ? '' : 's'
      } ${dim(italic(`(${operations} operations)`))}`,
    );
    return;
  }

  const okCount = operations - failed.length - skipped.length;
  console.log(
    `${green('✨ Synced')} ${okCount}/${operations} rule operation${operations === 1 ? '' : 's'}`,
  );
  for (const s of skipped) {
    console.log(
      `  ${yellow('⚠ skipped')} ${magenta(s.ruleName)} → ${s.target} ${
        dim(italic(`(${s.reason ?? ''})`))
      }`,
    );
  }
  for (const f of failed) {
    console.log(
      `  ${red('❌ failed')} ${magenta(f.ruleName)} → ${f.target} ${
        dim(italic(`(${f.reason ?? ''})`))
      }`,
    );
  }
}

