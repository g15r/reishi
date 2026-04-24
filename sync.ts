/**
 * reishi sync engine — distributes skills from the source-of-truth to named
 * targets by copy or symlink, and (for tracked skills) re-fetches the source
 * from upstream before redistributing.
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
import {
  expandHome,
  loadConfig,
  loadLockfile,
  saveConfig,
  saveLockfile,
  type SkillLockEntry,
  type SyncMethod,
} from './config.ts';
import { getDeactivatedDir, getSourceDir } from './paths.ts';

/** Narrow fetch signature for tarball / JSON endpoints — keeps tests offline. */
export type HttpFetcher = (url: string) => Promise<Response>;

/** Yes/no prompt callback — returns true for "yes". */
export type PromptYesNo = (question: string) => Promise<boolean>;
/** Choice prompt callback — returns the chosen key or null. */
export type PromptChoice = (
  question: string,
  choices: { key: string; label: string }[],
) => Promise<string | null>;

export interface SyncOptions {
  /** Restrict to this subset of target names (from [paths.targets]). */
  targets?: string[];
  /** Override the resolved sync method entirely. */
  method?: SyncMethod;
  /** Plan only — no writes. */
  dryRun?: boolean;
  /**
   * Re-fetch from upstream for tracked skills before redistributing. Defaults
   * to `true` for the user-facing `rei sync` command and `false` for auto-sync
   * triggers (`add`, `activate`).
   */
  fetchUpstream?: boolean;
  /** Bypass local-modification confirmation prompt. */
  force?: boolean;
  /** Pre-decide prefix-change behavior in non-interactive flows. */
  prefixChange?: 'rename' | 'parallel' | 'abort';
  /** Injected fetcher for tests; defaults to global `fetch`. */
  fetcher?: HttpFetcher;
  /** Injectable yes/no prompt for tests; defaults to terminal stdin. */
  promptYesNo?: PromptYesNo;
  /** Injectable choice prompt for tests; defaults to terminal stdin. */
  promptChoice?: PromptChoice;
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

/**
 * Decide the sync method using the configured precedence.
 * Exported so rules.ts can mirror the precedence: CLI > content-type > global.
 */
export function resolveMethod(
  globalMethod: SyncMethod,
  contentTypeMethod: SyncMethod | undefined,
  override: SyncMethod | undefined,
): SyncMethod {
  return override ?? contentTypeMethod ?? globalMethod;
}

/**
 * Sync a single skill to the appropriate targets. Returns one result per
 * target attempted.
 *
 * For tracked skills, re-fetches the upstream tarball, optionally prompts the
 * user about local modifications, and may detect a prefix change in the config
 * before any redistribution. Untracked skills skip straight to target sync.
 */
export async function syncSkill(
  skillName: string,
  options: SyncOptions = {},
): Promise<SyncResult[]> {
  const config = await loadConfig();
  const lockfile = await loadLockfile();
  const sourceDir = await getSourceDir();
  let activeSkillName = skillName;
  let skillSource = join(sourceDir, activeSkillName);

  // Tracked skills can pull a renamed prefix or new upstream content. Both
  // happen before we touch targets so the redistribution sees the new state.
  const initialLockEntry = lockfile.skills[activeSkillName];
  const upstreamResults: SyncResult[] = [];

  if (initialLockEntry) {
    const renamed = await maybeApplyPrefixChange(activeSkillName, initialLockEntry, options);
    if (renamed.aborted) {
      return [{
        skillName: activeSkillName,
        target: '(none)',
        targetPath: skillSource,
        action: 'failed',
        reason: renamed.reason ?? 'prefix change aborted',
      }];
    }
    if (renamed.newName) {
      activeSkillName = renamed.newName;
      skillSource = join(sourceDir, activeSkillName);
    }

    const fetchUpstream = options.fetchUpstream ?? true;
    if (fetchUpstream) {
      const freshLock = await loadLockfile();
      const entry = freshLock.skills[activeSkillName];
      if (entry?.source_url) {
        const fetched = await fetchUpstreamForSkill(
          activeSkillName,
          entry,
          options,
        );
        if (fetched.aborted) {
          return [{
            skillName: activeSkillName,
            target: '(none)',
            targetPath: skillSource,
            action: 'failed',
            reason: fetched.reason ?? 'upstream fetch aborted',
          }];
        }
      }
    }
  }

  if (!(await exists(skillSource))) {
    return [...upstreamResults, {
      skillName: activeSkillName,
      target: '(none)',
      targetPath: skillSource,
      action: 'failed',
      reason: 'source skill not found',
    }];
  }

  // Reload config — fetch/rename may have rewritten the lockfile, though not
  // the config. Re-read anyway so we pick up any outside edits.
  const refreshed = await loadConfig();
  const configEntry = refreshed.skills?.[activeSkillName];
  if (options.targets) {
    // Validate filter names against config — reject typos early.
    const unknown = options.targets.filter((t) => !(t in refreshed.paths.targets));
    if (unknown.length > 0) {
      return [{
        skillName: activeSkillName,
        target: unknown.join(','),
        targetPath: '',
        action: 'failed',
        reason: `unknown target(s): ${unknown.join(', ')}`,
      }];
    }
  }

  const targets = await resolveTargets(configEntry, options.targets, refreshed.paths.targets);
  if (targets.length === 0) return upstreamResults;

  const method = resolveMethod(refreshed.sync_method, configEntry?.sync_method, options.method);
  const results: SyncResult[] = [...upstreamResults];

  for (const target of targets) {
    const targetPath = join(target.path, activeSkillName);
    const targetParent = dirname(target.path);
    if (!(await exists(targetParent))) {
      results.push({
        skillName: activeSkillName,
        target: target.name,
        targetPath,
        action: 'skipped',
        reason: `parent dir missing: ${targetParent}`,
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        skillName: activeSkillName,
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
        results.push({
          skillName: activeSkillName,
          target: target.name,
          targetPath,
          action: 'symlinked',
        });
      } else {
        await copy(skillSource, targetPath, { overwrite: true });
        results.push({
          skillName: activeSkillName,
          target: target.name,
          targetPath,
          action: 'copied',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        skillName: activeSkillName,
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
  /** Source has content newer than the last sync (upstream moved). */
  stale: boolean;
  /** Target has files modified after the last sync (user made local edits). */
  diverged: boolean;
  isSymlink: boolean;
}

/**
 * For each active skill × configured target, report presence, staleness, and
 * divergence — all anchored on the `synced_at` timestamp in the config.
 *
 * - **stale**: the source has files newer than `synced_at` → upstream moved.
 * - **diverged**: the target has files newer than `synced_at` → user edited.
 * - Both can be true simultaneously (upstream moved AND user edited).
 * - Symlinks are never stale or diverged — they always point at the source.
 * - Untracked skills (no config entry / no `synced_at`) are never stale; they
 *   can still be diverged if the target has been modified after the source.
 */
export async function syncStatus(): Promise<SkillStatus[]> {
  const config = await loadConfig();
  const lockfile = await loadLockfile();
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
    const configEntry = config.skills?.[name];
    const lockEntry = lockfile.skills[name];
    const syncedAt = lockEntry?.synced_at ? Date.parse(lockEntry.synced_at) : 0;
    const targets = await resolveTargets(configEntry, undefined, config.paths.targets);

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
      let diverged = false;

      if (present && !isSymlink && syncedAt > 0) {
        const sourceMtime = await newestFileMtime(skillSource);
        const targetMtime = await newestFileMtime(targetPath);
        stale = sourceMtime > syncedAt;
        diverged = targetMtime > syncedAt;
      }

      results.push({
        skillName: name,
        target: target.name,
        targetPath,
        present,
        stale,
        diverged,
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
    else if (s.stale && s.diverged) mark = yellow('stale + diverged');
    else if (s.stale) mark = yellow('stale');
    else if (s.diverged) mark = yellow('diverged');
    else mark = green('fresh');
    console.log(`  ${magenta(s.skillName)} → ${s.target} ${dim(italic(`[${mark}]`))}`);
  }
}

// ============================================================================
// Upstream fetch (for tracked skills)
// ============================================================================

export interface FileDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface FetchUpstreamResult {
  fetched: boolean;
  changed: boolean;
  diff: FileDiff;
  /** Set when the user (or automation) aborted the operation. */
  aborted?: boolean;
  reason?: string;
}

/** Stream the contents of every file under root into a hex SHA-1 per relative path. */
async function fileTreeHashes(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!(await exists(root))) return out;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(abs, rel);
      } else if (entry.isFile) {
        const bytes = await Deno.readFile(abs);
        const digest = await crypto.subtle.digest('SHA-1', bytes);
        const hex = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        out.set(rel, hex);
      }
    }
  };
  await walk(root, '');
  return out;
}

function diffTrees(current: Map<string, string>, next: Map<string, string>): FileDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [path, hash] of next) {
    const prev = current.get(path);
    if (prev === undefined) added.push(path);
    else if (prev !== hash) modified.push(path);
  }
  for (const path of current.keys()) {
    if (!next.has(path)) removed.push(path);
  }
  added.sort();
  modified.sort();
  removed.sort();
  return { added, modified, removed };
}

/** Walk the source tree returning the most recent file mtime, in epoch ms. */
async function newestFileMtime(root: string): Promise<number> {
  let max = 0;
  const walk = async (dir: string): Promise<void> => {
    try {
      for await (const entry of Deno.readDir(dir)) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory) {
          await walk(abs);
        } else if (entry.isFile) {
          try {
            const stat = await Deno.stat(abs);
            if (stat.mtime && stat.mtime.getTime() > max) max = stat.mtime.getTime();
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  };
  await walk(root);
  return max;
}

async function downloadAndExtract(
  entry: SkillLockEntry,
  fetcher: HttpFetcher,
): Promise<{ extractedRoot: string; cleanup: () => Promise<void> }> {
  const url = entry.source_url;
  const ref = entry.ref;
  const subpath = entry.subpath ?? '';
  // GitHub URLs look like https://github.com/{user}/{repo}.
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`unsupported source_url: ${url}`);
  const [, user, repo] = match;

  const tarballUrls = [
    `https://github.com/${user}/${repo}/archive/refs/heads/${ref}.tar.gz`,
    `https://github.com/${user}/${repo}/archive/refs/tags/${ref}.tar.gz`,
  ];

  let response: Response | undefined;
  for (const candidate of tarballUrls) {
    response = await fetcher(candidate);
    if (response.ok) break;
    if (response.status !== 404) break;
  }
  if (!response || !response.ok) {
    throw new Error(
      `failed to fetch upstream (HTTP ${response?.status ?? 'unknown'})`,
    );
  }

  const tmpFile = await Deno.makeTempFile({ suffix: '.tar.gz' });
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-upstream-' });
  try {
    await Deno.writeFile(tmpFile, new Uint8Array(await response.arrayBuffer()));
    const tar = new Deno.Command('tar', {
      args: ['xzf', tmpFile, '--strip-components=1', '-C', tmpDir],
      stderr: 'piped',
    });
    const result = await tar.output();
    if (!result.success) {
      throw new Error(`tar failed: ${new TextDecoder().decode(result.stderr)}`);
    }
  } finally {
    try {
      await Deno.remove(tmpFile);
    } catch { /* ignore */ }
  }

  const extractedRoot = subpath
    ? join(tmpDir, ...subpath.split('/').filter(Boolean))
    : tmpDir;
  if (!(await exists(extractedRoot))) {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore */ }
    throw new Error(`subpath not present in extracted upstream: ${subpath}`);
  }
  return {
    extractedRoot,
    cleanup: async () => {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    },
  };
}

async function promptYesNo(question: string, defaultNo = true): Promise<boolean> {
  if (!Deno.stdin.isTerminal()) return false;
  const buf = new Uint8Array(64);
  await Deno.stdout.write(new TextEncoder().encode(`${question} `));
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  if (answer === '') return !defaultNo;
  return answer.startsWith('y');
}

async function promptChoice(
  question: string,
  choices: { key: string; label: string }[],
): Promise<string | null> {
  if (!Deno.stdin.isTerminal()) return null;
  const labels = choices.map((c) => `${c.key}=${c.label}`).join(', ');
  await Deno.stdout.write(new TextEncoder().encode(`${question} (${labels}) `));
  const buf = new Uint8Array(64);
  const n = await Deno.stdin.read(buf);
  if (n === null) return null;
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  for (const c of choices) {
    if (answer.startsWith(c.key.toLowerCase())) return c.key;
  }
  return null;
}

/** Compose the file-diff summary line printed after a fetch. */
export function summarizeDiff(diff: FileDiff): string {
  const a = diff.added.length;
  const m = diff.modified.length;
  const r = diff.removed.length;
  return `${a} added, ${m} modified, ${r} removed`;
}

interface FetchUpstreamRunOptions extends SyncOptions {
  /** Pre-fetched lock entry for symmetry with sync. Internal use. */
  lockOverride?: SkillLockEntry;
}

/**
 * Public API: re-fetch a tracked skill from upstream and overwrite its source
 * dir. Honors `dryRun` (no writes), `force` (skip prompt), and `fetcher`
 * injection. Returns a structured result with the file-level diff.
 */
export async function fetchUpstream(
  skillName: string,
  options: FetchUpstreamRunOptions = {},
): Promise<FetchUpstreamResult> {
  const lockfile = await loadLockfile();
  const entry = options.lockOverride ?? lockfile.skills[skillName];
  if (!entry) {
    return {
      fetched: false,
      changed: false,
      diff: { added: [], modified: [], removed: [] },
      aborted: true,
      reason: `skill not tracked: ${skillName}`,
    };
  }
  return await fetchUpstreamForSkill(skillName, entry, options);
}

/**
 * Internal worker that actually performs the upstream fetch + overwrite. Kept
 * separate so syncSkill can reuse it without re-reading the lockfile.
 */
async function fetchUpstreamForSkill(
  skillName: string,
  entry: SkillLockEntry,
  options: SyncOptions,
): Promise<FetchUpstreamResult> {
  const fetcher = options.fetcher ?? fetch;
  const sourceDir = await getSourceDir();
  const skillDir = join(sourceDir, skillName);

  // Local-modification detection: if any file's mtime is newer than the
  // last recorded synced_at, the user has likely edited the skill in place.
  if (await exists(skillDir)) {
    const newest = await newestFileMtime(skillDir);
    const synced = entry.synced_at ? Date.parse(entry.synced_at) : 0;
    if (newest > 0 && synced > 0 && newest > synced) {
      const askYesNo = options.promptYesNo ?? promptYesNo;
      const acceptable = options.force === true ||
        await askYesNo(
          `Local modifications in ${skillName}. Overwrite? (y/N)`,
        );
      if (!acceptable) {
        const interactive = options.promptYesNo !== undefined || Deno.stdin.isTerminal();
        const reason = interactive
          ? 'declined overwrite of local modifications'
          : 'local modifications detected (rerun with --force to override)';
        console.error(`${red('❌')} ${reason} for ${magenta(skillName)}`);
        return {
          fetched: false,
          changed: false,
          diff: { added: [], modified: [], removed: [] },
          aborted: true,
          reason,
        };
      }
    }
  }

  let extracted: { extractedRoot: string; cleanup: () => Promise<void> };
  try {
    extracted = await downloadAndExtract(entry, fetcher);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('❌ upstream fetch failed:')} ${message}`);
    return {
      fetched: false,
      changed: false,
      diff: { added: [], modified: [], removed: [] },
      aborted: true,
      reason: message,
    };
  }

  try {
    const currentHashes = await fileTreeHashes(skillDir);
    const nextHashes = await fileTreeHashes(extracted.extractedRoot);
    const diff = diffTrees(currentHashes, nextHashes);
    const changed = diff.added.length + diff.modified.length + diff.removed.length > 0;

    if (options.dryRun) {
      console.log(
        `${dim(italic('would fetch'))} ${magenta(skillName)} ${dim(italic(`(${summarizeDiff(diff)})`))}`,
      );
      return { fetched: true, changed, diff };
    }

    if (changed) {
      // Replace the source dir atomically: stage the new tree alongside, then swap.
      const staging = `${skillDir}.reishi-staging-${Date.now()}`;
      await copy(extracted.extractedRoot, staging, { overwrite: true });
      if (await exists(skillDir)) {
        await Deno.remove(skillDir, { recursive: true });
      }
      await Deno.rename(staging, skillDir);
    }

    // Always update synced_at so a later mtime check doesn't see "modified".
    const freshLock = await loadLockfile();
    const current = freshLock.skills[skillName] ?? entry;
    freshLock.skills[skillName] = { ...current, synced_at: new Date().toISOString() };
    await saveLockfile(freshLock);

    if (changed) {
      console.log(
        `${green('🌐 Fetched')} ${magenta(skillName)} ${dim(italic(`(${summarizeDiff(diff)})`))}`,
      );
    } else {
      console.log(
        `${dim(italic('Up-to-date:'))} ${magenta(skillName)}`,
      );
    }
    return { fetched: true, changed, diff };
  } finally {
    await extracted.cleanup();
  }
}

// ============================================================================
// Prefix-change detection
// ============================================================================

interface PrefixChangeResult {
  /** New skill name after rename, or undefined if no change happened. */
  newName?: string;
  aborted?: boolean;
  reason?: string;
}

/**
 * Detect when the user edited `prefix` in the lockfile without renaming the
 * dir/key. Three resolution modes: rename (move dir + retarget lock entry),
 * parallel (clone under new name, leave old in place), abort (no-op error).
 */
async function maybeApplyPrefixChange(
  skillName: string,
  entry: SkillLockEntry,
  options: SyncOptions,
): Promise<PrefixChangeResult> {
  const config = await loadConfig();
  const separator = config.prefix_separator;
  const newPrefix = entry.prefix;
  // Determine the current prefix from the dir name itself.
  const sepIdx = newPrefix !== undefined && skillName.includes(separator)
    ? skillName.indexOf(separator)
    : -1;
  const currentPrefix = sepIdx >= 0 ? skillName.slice(0, sepIdx) : '';
  const baseName = sepIdx >= 0 ? skillName.slice(sepIdx + separator.length) : skillName;

  if (newPrefix === undefined) return {};
  if (newPrefix === currentPrefix) return {};
  if (newPrefix === '') return {};

  const newName = `${newPrefix}${separator}${baseName}`;
  if (newName === skillName) return {};

  let mode: 'rename' | 'parallel' | 'abort' | null = options.prefixChange ?? null;
  if (mode === null) {
    if (options.dryRun) {
      console.log(
        `${dim(italic('would rename'))} ${magenta(skillName)} → ${magenta(newName)}`,
      );
      // For dry-run with no explicit decision, treat as rename for preview.
      return { newName };
    }
    const interactive = options.promptYesNo !== undefined || Deno.stdin.isTerminal();
    if (!interactive) {
      const reason =
        `prefix changed for ${skillName} ('${currentPrefix}' → '${newPrefix}'); rerun with --prefix-change=rename|parallel|abort`;
      console.error(`${red('❌')} ${reason}`);
      return { aborted: true, reason };
    }
    const askYesNo = options.promptYesNo ?? promptYesNo;
    const askChoice = options.promptChoice ?? promptChoice;
    const confirmed = await askYesNo(
      `Prefix for ${skillName} changed from '${currentPrefix}' to '${newPrefix}'. Confirm? (y/N)`,
    );
    if (!confirmed) {
      return { aborted: true, reason: 'prefix change declined' };
    }
    const choice = await askChoice(
      'Rename existing or install in parallel?',
      [
        { key: 'r', label: 'rename' },
        { key: 'p', label: 'parallel' },
        { key: 'N', label: 'abort' },
      ],
    );
    if (choice === 'r') mode = 'rename';
    else if (choice === 'p') mode = 'parallel';
    else mode = 'abort';
  }

  if (mode === 'abort') {
    return { aborted: true, reason: 'prefix change aborted' };
  }

  if (options.dryRun) {
    if (mode === 'rename') {
      console.log(
        `${dim(italic('would rename'))} ${magenta(skillName)} → ${magenta(newName)}`,
      );
      return { newName };
    }
    console.log(
      `${dim(italic('would install in parallel as'))} ${magenta(newName)}`,
    );
    return { newName };
  }

  if (mode === 'rename') {
    await renameSkillEverywhere(skillName, newName, config.paths.targets);
    await rekeySkillEntry(skillName, newName);
    console.log(
      `${green('🪪 Renamed')} ${magenta(skillName)} → ${magenta(newName)}`,
    );
    return { newName };
  }

  // parallel: leave the old skill alone; create a new tracked entry. We only
  // create a config entry — the source dir population happens via the fetch
  // step that follows.
  await dupeSkillEntry(skillName, newName, newPrefix);
  console.log(
    `${green('🌿 Parallel')} ${magenta(skillName)} → ${magenta(newName)} (old preserved)`,
  );
  return { newName };
}

async function renameSkillEverywhere(
  oldName: string,
  newName: string,
  targets: Record<string, string>,
): Promise<void> {
  const sourceDir = await getSourceDir();
  const deactivatedDir = await getDeactivatedDir();
  const oldSource = join(sourceDir, oldName);
  const newSource = join(sourceDir, newName);
  if (await exists(oldSource)) {
    await Deno.rename(oldSource, newSource);
  }
  const oldDeactivated = join(deactivatedDir, oldName);
  if (await exists(oldDeactivated)) {
    await Deno.rename(oldDeactivated, join(deactivatedDir, newName));
  }
  for (const rawPath of Object.values(targets)) {
    const targetRoot = expandHome(rawPath);
    const oldTarget = join(targetRoot, oldName);
    const newTarget = join(targetRoot, newName);
    let present = false;
    try {
      await Deno.lstat(oldTarget);
      present = true;
    } catch { /* not present */ }
    if (present) {
      try {
        await Deno.rename(oldTarget, newTarget);
      } catch {
        // Cross-device or permissions — fall back to copy + remove.
        await copy(oldTarget, newTarget, { overwrite: true });
        await Deno.remove(oldTarget, { recursive: true });
      }
    }
  }
}

async function rekeySkillEntry(oldName: string, newName: string): Promise<void> {
  const lockfile = await loadLockfile();
  const entry = lockfile.skills[oldName];
  if (!entry) return;
  delete lockfile.skills[oldName];
  lockfile.skills[newName] = entry;
  await saveLockfile(lockfile);
}

async function dupeSkillEntry(
  oldName: string,
  newName: string,
  newPrefix: string,
): Promise<void> {
  const config = await loadConfig();
  const lockfile = await loadLockfile();
  const entry = lockfile.skills[oldName];
  if (!entry) return;
  // Reset prefix on the original entry to its dir-derived value so the next
  // sync doesn't keep retriggering this flow.
  const separator = config.prefix_separator;
  const sepIdx = oldName.indexOf(separator);
  const oldPrefix = sepIdx >= 0 ? oldName.slice(0, sepIdx) : '';
  lockfile.skills[oldName] = { ...entry, prefix: oldPrefix || undefined };
  lockfile.skills[newName] = { ...entry, prefix: newPrefix };
  await saveLockfile(lockfile);
}

// ============================================================================
// Update polling
// ============================================================================

export interface UpdateCheck {
  skillName: string;
  hasUpdate: boolean;
  remoteSha?: string;
  previousSha?: string;
  reason?: string;
  skipped?: boolean;
}

interface CheckUpdatesOptions {
  fetcher?: HttpFetcher;
}

function commitShaUrl(sourceUrl: string, ref: string): string | null {
  const match = sourceUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  const [, user, repo] = match;
  return `https://api.github.com/repos/${user}/${repo}/commits/${ref}`;
}

/**
 * For each tracked skill (or just one), fetch the upstream commit SHA at
 * `ref` and compare against the lockfile's stored `sha`. Pure read — does
 * not write the lockfile; the SHA only updates when `pull` actually pulls.
 */
export async function checkForUpdates(
  skillName?: string,
  options: CheckUpdatesOptions = {},
): Promise<UpdateCheck[]> {
  const fetcher = options.fetcher ?? fetch;
  const config = await loadConfig();
  const lockfile = await loadLockfile();
  const configSkills = config.skills ?? {};
  const names = skillName ? [skillName] : Object.keys(lockfile.skills);
  const results: UpdateCheck[] = [];

  for (const name of names) {
    const entry = lockfile.skills[name];
    if (!entry) {
      results.push({ skillName: name, hasUpdate: false, skipped: true, reason: 'not tracked' });
      continue;
    }
    if (configSkills[name]?.updates === false) {
      results.push({ skillName: name, hasUpdate: false, skipped: true, reason: 'disabled per-skill' });
      continue;
    }
    if (!entry.source_url || !entry.ref) {
      results.push({ skillName: name, hasUpdate: false, skipped: true, reason: 'missing source_url/ref' });
      continue;
    }
    const url = commitShaUrl(entry.source_url, entry.ref);
    if (!url) {
      results.push({ skillName: name, hasUpdate: false, skipped: true, reason: 'unsupported source_url' });
      continue;
    }
    let response: Response;
    try {
      response = await fetcher(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ skillName: name, hasUpdate: false, skipped: true, reason: `fetch error: ${message}` });
      continue;
    }
    if (!response.ok) {
      results.push({
        skillName: name,
        hasUpdate: false,
        skipped: true,
        reason: `HTTP ${response.status}`,
      });
      continue;
    }
    let body: { sha?: string };
    try {
      body = await response.json();
    } catch {
      results.push({ skillName: name, hasUpdate: false, skipped: true, reason: 'invalid JSON' });
      continue;
    }
    const sha = body.sha;
    if (!sha) {
      results.push({ skillName: name, hasUpdate: false, skipped: true, reason: 'no sha in response' });
      continue;
    }
    const previousSha = entry.sha;
    const hasUpdate = previousSha !== undefined && previousSha !== sha;
    results.push({ skillName: name, hasUpdate, remoteSha: sha, previousSha });
  }

  return results;
}

/**
 * Whether a background update check is due, based on the global last-check
 * timestamp stored in `[updates].last_background_check` and `interval_hours`.
 * Always false when polling is disabled.
 */
export async function isBackgroundCheckDue(): Promise<boolean> {
  const config = await loadConfig();
  if (!config.updates.enabled) return false;
  const last = config.updates.last_background_check;
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return true;
  const intervalMs = config.updates.interval_hours * 3_600_000;
  return Date.now() - lastMs >= intervalMs;
}

/** Persist the timestamp of the last fired background check. */
export async function recordBackgroundCheck(): Promise<void> {
  const config = await loadConfig();
  config.updates.last_background_check = new Date().toISOString();
  await saveConfig(config);
}

/**
 * Fire-and-forget background notification helper. Resolves when complete; the
 * caller may choose to not await it. Prints a one-liner only when updates are
 * found. Errors are swallowed — this is auxiliary, not load-bearing.
 */
export async function maybeNotifyOfUpdates(
  options: CheckUpdatesOptions = {},
): Promise<void> {
  try {
    if (!(await isBackgroundCheckDue())) return;
    await recordBackgroundCheck();
    const checks = await checkForUpdates(undefined, options);
    const updated = checks.filter((c) => c.hasUpdate).map((c) => c.skillName);
    if (updated.length === 0) return;
    const noun = updated.length === 1 ? 'skill has' : 'skills have';
    console.log(
      `${green('✨')} ${updated.length} ${noun} upstream updates — run ${
        magenta('rei updates')
      } for details`,
    );
  } catch {
    /* background-only — never fail the main command */
  }
}
