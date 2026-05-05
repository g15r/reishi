/**
 * Phase 15 — clean_on_sync orphan cleanup.
 *   - findOrphans walks every agent's skills/rules paths and reports entries
 *     present in target but absent from source.
 *   - Symlinks are skipped (self-resolve).
 *   - Compile artifact in the rules dir is excluded.
 *   - cleanOrphans deletes them; failures are reported, not thrown.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { resetPathCache } from './paths.ts';
import { cleanOrphans, findOrphans } from './sync.ts';
import { setupIsolatedEnv } from './test-helpers.ts';

async function withEnv(
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  resetPathCache();
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    resetPathCache();
  }
}

async function patchConfig(
  configPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const raw = await Deno.readTextFile(configPath);
  const current = parseTOML(raw) as Record<string, unknown>;
  const next = { ...current, ...patch };
  await Deno.writeTextFile(configPath, stringifyTOML(next));
}

Deno.test('findOrphans: skill dirs in target without source dirs are flagged', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // One source skill, two target skill dirs (one orphan).
      await Deno.mkdir(join(env.sourceDir, 'kept'), { recursive: true });
      const claudeSkills = join(env.home, '.claude', 'skills');
      await Deno.mkdir(join(claudeSkills, 'kept'), { recursive: true });
      await Deno.mkdir(join(claudeSkills, 'orphan'), { recursive: true });

      const orphans = await findOrphans();
      assertEquals(orphans.length, 1);
      assertEquals(orphans[0].kind, 'skill');
      assertEquals(orphans[0].name, 'orphan');
      assertEquals(orphans[0].agent, 'claude');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('findOrphans: rule files in target without source files are flagged', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const rulesSource = join(env.home, '.config', 'reishi', 'rules');
      await Deno.mkdir(rulesSource, { recursive: true });
      await Deno.writeTextFile(join(rulesSource, 'kept.md'), 'k');

      const claudeRules = join(env.home, '.claude', 'rules');
      await Deno.mkdir(claudeRules, { recursive: true });
      await Deno.writeTextFile(join(claudeRules, 'kept.md'), 'k');
      await Deno.writeTextFile(join(claudeRules, 'orphan.md'), 'o');

      const orphans = await findOrphans();
      assertEquals(orphans.length, 1);
      assertEquals(orphans[0].kind, 'rule');
      assertEquals(orphans[0].name, 'orphan.md');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('findOrphans: symlinks are skipped (self-resolve)', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const rulesSource = join(env.home, '.config', 'reishi', 'rules');
      await Deno.mkdir(rulesSource, { recursive: true });
      const claudeRules = join(env.home, '.claude', 'rules');
      await Deno.mkdir(claudeRules, { recursive: true });
      // Create a dangling symlink in the target — symlinks are not orphans
      // even when the source no longer exists.
      await Deno.symlink('/nonexistent/path.md', join(claudeRules, 'link.md'));

      const orphans = await findOrphans();
      assertEquals(orphans.length, 0);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('findOrphans: compile artifact in rules target is excluded', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const rulesSource = join(env.home, '.config', 'reishi', 'rules');
      await Deno.mkdir(rulesSource, { recursive: true });
      const claudeRules = join(env.home, '.claude', 'rules');
      await Deno.mkdir(claudeRules, { recursive: true });
      // The compile artifact lives at <rules-target>/AGENTS.md when
      // compile_root defaults to dirname(rules) ... but we configure the
      // compile_root explicitly here to be the rules dir.
      await Deno.writeTextFile(join(claudeRules, 'AGENTS.md'), 'compiled');
      await patchConfig(env.configPath, {
        agents: {
          claude: {
            skills: join(env.home, '.claude', 'skills'),
            rules: claudeRules,
            compile: true,
            compile_root: claudeRules,
            compile_file: 'AGENTS.md',
          },
        },
      });
      resetPathCache();

      const orphans = await findOrphans();
      assertEquals(orphans.length, 0);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('findOrphans: agent filter restricts the walk', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const claudeSkills = join(env.home, '.claude', 'skills');
      const otherSkills = join(env.home, '.other', 'skills');
      await Deno.mkdir(join(claudeSkills, 'a'), { recursive: true });
      await Deno.mkdir(join(otherSkills, 'b'), { recursive: true });
      await patchConfig(env.configPath, {
        agents: {
          claude: {
            skills: claudeSkills,
            rules: join(env.home, '.claude', 'rules'),
          },
          other: {
            skills: otherSkills,
            rules: join(env.home, '.other', 'rules'),
          },
        },
      });
      resetPathCache();

      const all = await findOrphans();
      assertEquals(all.length, 2);
      const filtered = await findOrphans(['claude']);
      assertEquals(filtered.length, 1);
      assertEquals(filtered[0].agent, 'claude');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('cleanOrphans: removes paths and reports successes', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const claudeSkills = join(env.home, '.claude', 'skills');
      await Deno.mkdir(join(claudeSkills, 'orphan'), { recursive: true });
      const orphans = await findOrphans();
      assertEquals(orphans.length, 1);

      const results = await cleanOrphans(orphans);
      assertEquals(results.length, 1);
      assert(results[0].ok);
      assert(!(await exists(join(claudeSkills, 'orphan'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('findOrphans: deactivated skills count as orphans (not synced)', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Source has only a deactivated skill — no active source.
      const deactivatedDir = join(env.sourceDir, '_deactivated');
      await Deno.mkdir(join(deactivatedDir, 'paused'), { recursive: true });
      // Target still has it.
      const claudeSkills = join(env.home, '.claude', 'skills');
      await Deno.mkdir(join(claudeSkills, 'paused'), { recursive: true });

      const orphans = await findOrphans();
      assertEquals(orphans.length, 1);
      assertEquals(orphans[0].name, 'paused');
    });
  } finally {
    await env.cleanup();
  }
});
