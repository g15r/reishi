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

import { basename, dirname, extname, join, resolve } from '@std/path';
import { copy, exists } from '@std/fs';
import { dim, green, italic, magenta, red, yellow } from '@std/fmt/colors';
import { expandHome, loadConfig, type SyncMethod } from './config.ts';
import { getRulesSourceDir } from './paths.ts';
import { type HttpFetcher, resolveMethod } from './sync.ts';

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
  targets?: string[];
  method?: SyncMethod;
  dryRun?: boolean;
}

export type RulesSyncAction = 'copied' | 'symlinked' | 'skipped' | 'failed' | 'removed';

export interface RulesSyncResult {
  ruleName: string;
  target: string;
  targetPath: string;
  action: RulesSyncAction;
  reason?: string;
}

export interface AddRuleOptions {
  force?: boolean;
  fetcher?: HttpFetcher;
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

// ============================================================================
// Add
// ============================================================================

/**
 * Add a rule from a local path or URL. Refuses to overwrite an existing entry
 * of the same basename unless force is true. Returns the destination path.
 */
export async function addRule(
  input: string,
  options: AddRuleOptions = {},
): Promise<string> {
  const rulesDir = await getRulesSourceDir();
  await Deno.mkdir(rulesDir, { recursive: true });

  if (input.startsWith('https://github.com/') && /\/tree\//.test(input)) {
    return await addRuleFromGithubTree(input, rulesDir, options);
  }
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return await addRuleFromUrl(input, rulesDir, options);
  }
  return await addRuleFromLocal(input, rulesDir, options);
}

async function refuseOverwrite(dest: string, force: boolean): Promise<void> {
  if (force) return;
  if (await exists(dest)) {
    throw new Error(`rule already exists at ${dest} (use --force to overwrite)`);
  }
}

async function addRuleFromLocal(
  input: string,
  rulesDir: string,
  options: AddRuleOptions,
): Promise<string> {
  const src = resolve(input);
  const info = await Deno.stat(src);
  const name = basename(src);
  const dest = join(rulesDir, name);
  await refuseOverwrite(dest, options.force ?? false);

  if (await exists(dest)) {
    await Deno.remove(dest, { recursive: true });
  }
  if (info.isDirectory) {
    await copy(src, dest, { overwrite: true });
  } else {
    await Deno.copyFile(src, dest);
  }
  return dest;
}

async function addRuleFromUrl(
  url: string,
  rulesDir: string,
  options: AddRuleOptions,
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`failed to fetch rule (HTTP ${response.status}): ${url}`);
  }

  // Derive a filename from the URL path; default to .md if no extension.
  const parsed = new URL(url);
  const last = parsed.pathname.split('/').filter(Boolean).pop() ?? 'rule';
  const ext = extname(last);
  const filename = ext === '.md' ? last : `${last.replace(/\.[^.]+$/, '') || 'rule'}.md`;
  const dest = join(rulesDir, filename);
  await refuseOverwrite(dest, options.force ?? false);

  const body = await response.text();
  await Deno.writeTextFile(dest, body);
  return dest;
}

async function addRuleFromGithubTree(
  url: string,
  rulesDir: string,
  options: AddRuleOptions,
): Promise<string> {
  // https://github.com/user/repo/tree/ref[/subpath]
  const match = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(\/.*)?$/,
  );
  if (!match) {
    throw new Error(`invalid GitHub tree URL: ${url}`);
  }
  const [, user, repo, ref, subpathRaw] = match;
  const subpath = subpathRaw ? subpathRaw.replace(/^\//, '') : '';
  const fetcher = options.fetcher ?? fetch;

  const candidates = [
    `https://github.com/${user}/${repo}/archive/refs/heads/${ref}.tar.gz`,
    `https://github.com/${user}/${repo}/archive/refs/tags/${ref}.tar.gz`,
  ];
  let response: Response | undefined;
  for (const candidate of candidates) {
    response = await fetcher(candidate);
    if (response.ok) break;
    if (response.status !== 404) break;
  }
  if (!response || !response.ok) {
    throw new Error(
      `failed to fetch upstream (HTTP ${response?.status ?? 'unknown'}) for ${url}`,
    );
  }

  const tmpFile = await Deno.makeTempFile({ suffix: '.tar.gz' });
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-rule-' });
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

    const extracted = subpath
      ? join(tmpDir, ...subpath.split('/').filter(Boolean))
      : tmpDir;
    if (!(await exists(extracted))) {
      throw new Error(`subpath not found in archive: ${subpath}`);
    }

    const info = await Deno.stat(extracted);
    const baseName = subpath
      ? subpath.split('/').filter(Boolean).pop()!
      : repo;
    const destName = info.isFile && !baseName.endsWith('.md')
      ? `${baseName}.md`
      : baseName;
    const dest = join(rulesDir, destName);
    await refuseOverwrite(dest, options.force ?? false);

    if (await exists(dest)) {
      await Deno.remove(dest, { recursive: true });
    }
    if (info.isDirectory) {
      await copy(extracted, dest, { overwrite: true });
    } else {
      await Deno.copyFile(extracted, dest);
    }
    return dest;
  } finally {
    try {
      await Deno.remove(tmpFile);
    } catch { /* ignore */ }
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* ignore */ }
  }
}

// ============================================================================
// Remove
// ============================================================================

/**
 * Remove a rule from rules.source AND from every configured target. Refuses if
 * the rule does not exist in source — callers should list first.
 */
export async function removeRule(name: string): Promise<RulesSyncResult[]> {
  const rulesDir = await getRulesSourceDir();
  const rules = await listRules();
  const match = rules.find((r) => r.name === name);
  if (!match) {
    throw new Error(`rule not found in source: ${name}`);
  }

  const unsyncResults = await unsyncRule(name);
  await Deno.remove(match.path, { recursive: true });
  void rulesDir; // reserved — caller may want the dir for logging later
  return unsyncResults;
}

/**
 * Remove a rule from every target (both copy and symlink variants). Does NOT
 * touch rules.source. Exposed for callers that want to re-sync without full
 * removal.
 */
export async function unsyncRule(name: string): Promise<RulesSyncResult[]> {
  const config = await loadConfig();
  const results: RulesSyncResult[] = [];
  const rules = await listRules();
  const match = rules.find((r) => r.name === name);

  for (const [targetName, rawPath] of Object.entries(config.rules.targets)) {
    const targetRoot = expandHome(rawPath);
    // Try both file (<name>.md) and directory (<name>) shapes at the target
    // since sync may have written either based on the source kind.
    const candidates = match?.kind === 'directory'
      ? [join(targetRoot, name)]
      : [join(targetRoot, `${name}.md`), join(targetRoot, name)];

    let removed = false;
    for (const candidate of candidates) {
      let present = false;
      try {
        await Deno.lstat(candidate);
        present = true;
      } catch { /* missing */ }
      if (!present) continue;
      try {
        await Deno.remove(candidate, { recursive: true });
        results.push({
          ruleName: name,
          target: targetName,
          targetPath: candidate,
          action: 'removed',
        });
        removed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          ruleName: name,
          target: targetName,
          targetPath: candidate,
          action: 'failed',
          reason: message,
        });
      }
    }
    if (!removed) {
      // Emit a single skip entry so callers see a per-target result.
      results.push({
        ruleName: name,
        target: targetName,
        targetPath: join(targetRoot, name),
        action: 'skipped',
        reason: 'not present at target',
      });
    }
  }
  return results;
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

  if (options.targets) {
    const unknown = options.targets.filter((t) => !(t in config.rules.targets));
    if (unknown.length > 0) {
      return [{
        ruleName: '(filter)',
        target: unknown.join(','),
        targetPath: '',
        action: 'failed',
        reason: `unknown target(s): ${unknown.join(', ')}`,
      }];
    }
  }

  const method = resolveMethod(
    config.sync_method,
    config.rules.sync_method,
    options.method,
  );

  for (const [targetName, rawPath] of Object.entries(config.rules.targets)) {
    if (options.targets && !options.targets.includes(targetName)) continue;
    const targetRoot = expandHome(rawPath);
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

