/**
 * reishi sync engine — distributes skills from the source-of-truth to named
 * targets by copy or symlink.
 *
 * Resolution order for the sync method, highest wins:
 *   CLI override  >  per-skill `sync_method`  >  global `sync_method`
 *
 * Per-skill `targets` (from `[skills.<name>].targets`) filters which named
 * targets from `[paths.targets]` this skill is distributed to.
 */

import { dirname, join, resolve } from '@std/path';
import { copy, exists } from '@std/fs';
import { dim, green, italic, magenta, red, yellow } from '@std/fmt/colors';
import { expandHome, loadConfig, type SyncMethod } from './config.ts';
import { getSourceDir } from './paths.ts';

export interface SyncOptions {
  /** Restrict to this subset of target names (from [paths.targets]). */
  targets?: string[];
  /** Override the resolved sync method entirely. */
  method?: SyncMethod;
  /** Plan only — no writes. */
  dryRun?: boolean;
}

export type SyncAction = 'copied' | 'symlinked' | 'skipped' | 'failed';

export interface SyncResult {
  skillName: string;
  /** Named target from config (e.g. "claude"). */
  target: string;
  /** Absolute path the skill was (or would be) written to. */
  targetPath: string;
  action: SyncAction;
  reason?: string;
}

interface ResolvedTarget {
  name: string;
  path: string;
}

/**
 * Resolve the list of targets to sync to, applying:
 *   - per-skill targets allow-list
 *   - CLI --targets filter
 *   - non-existent parent dir = skip with warning
 */
async function resolveTargets(
  skillEntry: { targets?: string[] } | undefined,
  filterTargets: string[] | undefined,
  allTargets: Record<string, string>,
): Promise<ResolvedTarget[]> {
  const allowed = skillEntry?.targets;
  const out: ResolvedTarget[] = [];
  for (const [name, rawPath] of Object.entries(allTargets)) {
    if (allowed && !allowed.includes(name)) continue;
    if (filterTargets && !filterTargets.includes(name)) continue;
    out.push({ name, path: expandHome(rawPath) });
  }
  return out;
}

/** Decide the sync method using the configured precedence. */
function resolveMethod(
  globalMethod: SyncMethod,
  skillMethod: SyncMethod | undefined,
  override: SyncMethod | undefined,
): SyncMethod {
  return override ?? skillMethod ?? globalMethod;
}

/**
 * Sync a single skill to the appropriate targets. Returns one result per
 * target attempted.
 */
export async function syncSkill(
  skillName: string,
  options: SyncOptions = {},
): Promise<SyncResult[]> {
  const config = await loadConfig();
  const sourceDir = await getSourceDir();
  const skillSource = join(sourceDir, skillName);

  if (!(await exists(skillSource))) {
    return [{
      skillName,
      target: '(none)',
      targetPath: skillSource,
      action: 'failed',
      reason: 'source skill not found',
    }];
  }

  const entry = config.skills?.[skillName];
  if (options.targets) {
    // Validate filter names against config — reject typos early.
    const unknown = options.targets.filter((t) => !(t in config.paths.targets));
    if (unknown.length > 0) {
      return [{
        skillName,
        target: unknown.join(','),
        targetPath: '',
        action: 'failed',
        reason: `unknown target(s): ${unknown.join(', ')}`,
      }];
    }
  }

  const targets = await resolveTargets(entry, options.targets, config.paths.targets);
  if (targets.length === 0) return [];

  const method = resolveMethod(config.sync_method, entry?.sync_method, options.method);
  const results: SyncResult[] = [];

  for (const target of targets) {
    const targetPath = join(target.path, skillName);
    const targetParent = dirname(target.path);
    if (!(await exists(targetParent))) {
      results.push({
        skillName,
        target: target.name,
        targetPath,
        action: 'skipped',
        reason: `parent dir missing: ${targetParent}`,
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        skillName,
        target: target.name,
        targetPath,
        action: method === 'symlink' ? 'symlinked' : 'copied',
        reason: 'dry run',
      });
      continue;
    }

    try {
      await Deno.mkdir(target.path, { recursive: true });
      // Remove any prior entry (dir, file, or symlink) before writing.
      if (await exists(targetPath)) {
        await Deno.remove(targetPath, { recursive: true });
      } else {
        // `exists` follows symlinks — a dangling link won't be caught above.
        try {
          await Deno.lstat(targetPath);
          await Deno.remove(targetPath);
        } catch { /* nothing there */ }
      }

      if (method === 'symlink') {
        // Use absolute path so the link works regardless of CWD.
        await Deno.symlink(resolve(skillSource), targetPath);
        results.push({ skillName, target: target.name, targetPath, action: 'symlinked' });
      } else {
        await copy(skillSource, targetPath, { overwrite: true });
        results.push({ skillName, target: target.name, targetPath, action: 'copied' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        skillName,
        target: target.name,
        targetPath,
        action: 'failed',
        reason: message,
      });
    }
  }

  return results;
}

/**
 * Sync every active skill (top-level dirs in source, excluding `_`-prefixed
 * internal dirs) to configured targets.
 */
export async function syncAll(options: SyncOptions = {}): Promise<SyncResult[]> {
  const sourceDir = await getSourceDir();
  if (!(await exists(sourceDir))) return [];

  const skillNames: string[] = [];
  for await (const entry of Deno.readDir(sourceDir)) {
    if (entry.isDirectory && !entry.name.startsWith('_')) {
      skillNames.push(entry.name);
    }
  }
  skillNames.sort();

  const results: SyncResult[] = [];
  for (const name of skillNames) {
    results.push(...(await syncSkill(name, options)));
  }
  return results;
}

/**
 * Remove a skill from all configured targets. Used by `deactivate` so the
 * skill stops appearing in downstream agents.
 */
export async function unsyncSkill(
  skillName: string,
  options: { targets?: string[] } = {},
): Promise<SyncResult[]> {
  const config = await loadConfig();
  const entry = config.skills?.[skillName];
  const targets = await resolveTargets(entry, options.targets, config.paths.targets);
  const results: SyncResult[] = [];

  for (const target of targets) {
    const targetPath = join(target.path, skillName);
    // Use lstat so symlinks (even dangling) are detected.
    let present = false;
    try {
      await Deno.lstat(targetPath);
      present = true;
    } catch { /* missing */ }

    if (!present) {
      results.push({
        skillName,
        target: target.name,
        targetPath,
        action: 'skipped',
        reason: 'not present at target',
      });
      continue;
    }

    try {
      await Deno.remove(targetPath, { recursive: true });
      results.push({
        skillName,
        target: target.name,
        targetPath,
        action: 'copied', // reusing the tag; semantically "removed"
        reason: 'removed',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        skillName,
        target: target.name,
        targetPath,
        action: 'failed',
        reason: message,
      });
    }
  }

  return results;
}

// ============================================================================
// Status / staleness detection
// ============================================================================

export interface SkillStatus {
  skillName: string;
  target: string;
  targetPath: string;
  present: boolean;
  stale: boolean;
  isSymlink: boolean;
}

async function maxMtime(path: string): Promise<number> {
  let max = 0;
  try {
    const stat = await Deno.stat(path);
    if (stat.mtime) max = stat.mtime.getTime();
  } catch {
    return 0;
  }

  const walk = async (p: string): Promise<void> => {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(p);
    } catch {
      return;
    }
    if (info.mtime && info.mtime.getTime() > max) max = info.mtime.getTime();
    if (info.isDirectory) {
      try {
        for await (const entry of Deno.readDir(p)) {
          await walk(join(p, entry.name));
        }
      } catch { /* ignore */ }
    }
  };
  await walk(path);
  return max;
}

/**
 * For each active skill × configured target, report whether it's present and
 * whether the target copy is stale relative to the source (by max mtime).
 * Symlinks are never stale — they point at the live source.
 */
export async function syncStatus(): Promise<SkillStatus[]> {
  const config = await loadConfig();
  const sourceDir = await getSourceDir();
  const results: SkillStatus[] = [];

  if (!(await exists(sourceDir))) return results;

  const skillNames: string[] = [];
  for await (const entry of Deno.readDir(sourceDir)) {
    if (entry.isDirectory && !entry.name.startsWith('_')) {
      skillNames.push(entry.name);
    }
  }
  skillNames.sort();

  for (const name of skillNames) {
    const skillSource = join(sourceDir, name);
    const sourceMtime = await maxMtime(skillSource);
    const entry = config.skills?.[name];
    const targets = await resolveTargets(entry, undefined, config.paths.targets);

    for (const target of targets) {
      const targetPath = join(target.path, name);
      let present = false;
      let isSymlink = false;
      try {
        const lst = await Deno.lstat(targetPath);
        present = true;
        isSymlink = lst.isSymlink;
      } catch {
        // absent
      }

      let stale = false;
      if (present && !isSymlink) {
        const targetMtime = await maxMtime(targetPath);
        stale = targetMtime < sourceMtime;
      }

      results.push({
        skillName: name,
        target: target.name,
        targetPath,
        present,
        stale,
        isSymlink,
      });
    }
  }

  return results;
}

// ============================================================================
// CLI output helpers
// ============================================================================

/** Print a compact, delightful summary for a batch of sync operations. */
export function printSummary(results: SyncResult[]): void {
  if (results.length === 0) return;
  const operations = results.length;
  const skills = new Set(results.map((r) => r.skillName));
  const targets = new Set(results.map((r) => r.target));
  const failed = results.filter((r) => r.action === 'failed');
  const skipped = results.filter((r) => r.action === 'skipped');

  if (failed.length === 0 && skipped.length === 0) {
    console.log(
      `${green('✨ Synced')} ${skills.size} skill${skills.size === 1 ? '' : 's'} to ${targets.size} target${
        targets.size === 1 ? '' : 's'
      } ${dim(italic(`(${operations} operations)`))}`,
    );
    return;
  }

  const okCount = operations - failed.length - skipped.length;
  console.log(
    `${green('✨ Synced')} ${okCount}/${operations} operation${operations === 1 ? '' : 's'} across ${skills.size} skill${
      skills.size === 1 ? '' : 's'
    }`,
  );
  for (const s of skipped) {
    console.log(`  ${yellow('⚠ skipped')} ${magenta(s.skillName)} → ${s.target} ${dim(italic(`(${s.reason ?? ''})`))}`);
  }
  for (const f of failed) {
    console.log(`  ${red('❌ failed')} ${magenta(f.skillName)} → ${f.target} ${dim(italic(`(${f.reason ?? ''})`))}`);
  }
}

/** Print a tabular status view. */
export function printStatus(statuses: SkillStatus[]): void {
  if (statuses.length === 0) {
    console.log('No active skills to report.');
    return;
  }
  for (const s of statuses) {
    let mark: string;
    if (!s.present) mark = red('missing');
    else if (s.isSymlink) mark = green('symlink');
    else if (s.stale) mark = yellow('stale');
    else mark = green('fresh');
    console.log(`  ${magenta(s.skillName)} → ${s.target} ${dim(italic(`[${mark}]`))}`);
  }
}
