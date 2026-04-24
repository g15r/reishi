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

import { basename, dirname, join, resolve } from '@std/path';
import { copy, exists } from '@std/fs';
import { dim, green, italic, magenta, red, yellow } from '@std/fmt/colors';
import { expandHome, loadConfig, type SyncMethod } from './config.ts';
import { getRulesSourceDir } from './paths.ts';
import { resolveMethod } from './sync.ts';

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

// Add / Remove / Validate retired in Phase 7: users manage rule files
// directly with their editor. reishi only lists them and distributes them.

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

