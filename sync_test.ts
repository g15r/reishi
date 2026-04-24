/**
 * Unit tests for sync.ts — exercise syncSkill/syncAll/unsyncSkill/syncStatus
 * directly against isolated source and target dirs.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import type { ConfigSchema } from './config.ts';
import { resetPathCache } from './paths.ts';
import {
  syncAll,
  syncSkill,
  syncStatus,
  unsyncSkill,
} from './sync.ts';
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

/** Seed a fake skill dir with a SKILL.md and a nested file. */
async function seedSkill(sourceDir: string, name: string): Promise<string> {
  const dir = join(sourceDir, name);
  await Deno.mkdir(join(dir, 'scripts'), { recursive: true });
  await Deno.writeTextFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  await Deno.writeTextFile(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
  return dir;
}

/** Rewrite an isolated env's config with the provided overrides merged in. */
async function patchConfig(
  configPath: string,
  patch: Partial<ConfigSchema> | Record<string, unknown>,
): Promise<void> {
  const raw = await Deno.readTextFile(configPath);
  const current = parseTOML(raw) as Record<string, unknown>;
  const next = { ...current, ...patch };
  await Deno.writeTextFile(configPath, stringifyTOML(next));
}

Deno.test('syncSkill copy: produces independent files at target', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      const targetBase = join(env.home, '.claude', 'skills');
      await Deno.mkdir(targetBase, { recursive: true });

      const results = await syncSkill('alpha');
      assertEquals(results.length, 1);
      assertEquals(results[0].action, 'copied');
      assertEquals(results[0].target, 'claude');

      const targetSkill = join(targetBase, 'alpha');
      assert(await exists(join(targetSkill, 'SKILL.md')));
      assert(await exists(join(targetSkill, 'scripts', 'run.sh')));

      // Mutating the target should not affect the source — proves it's a copy.
      await Deno.writeTextFile(join(targetSkill, 'SKILL.md'), 'mutated');
      const srcContent = await Deno.readTextFile(join(env.sourceDir, 'alpha', 'SKILL.md'));
      assert(srcContent.includes('description: test'), 'source was mutated');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncSkill symlink: creates a valid symlink to absolute source', async () => {
  const env = await setupIsolatedEnv({ sync_method: 'symlink' });
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'beta');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      const results = await syncSkill('beta');
      assertEquals(results[0].action, 'symlinked');

      const targetSkill = join(env.home, '.claude', 'skills', 'beta');
      const lst = await Deno.lstat(targetSkill);
      assert(lst.isSymlink, 'expected symlink');
      // Contents resolve through the link.
      const content = await Deno.readTextFile(join(targetSkill, 'SKILL.md'));
      assert(content.includes('description: test'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncAll hits every active skill and skips _deactivated', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await seedSkill(env.sourceDir, 'beta');
      // Put a dir under _deactivated — syncAll must ignore it.
      await seedSkill(join(env.sourceDir, '_deactivated'), 'legacy');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      const results = await syncAll();
      const names = new Set(results.map((r) => r.skillName));
      assertEquals(names, new Set(['alpha', 'beta']));
      assert(results.every((r) => r.action === 'copied'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('targets filter limits which named targets receive the skill', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Add a second target so filtering is meaningful.
      const otherTarget = join(env.home, '.agents', 'skills');
      await Deno.mkdir(otherTarget, { recursive: true });
      await patchConfig(env.configPath, {
        paths: {
          source: env.sourceDir,
          targets: {
            claude: join(env.home, '.claude', 'skills'),
            agents: otherTarget,
          },
        },
      });
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await seedSkill(env.sourceDir, 'alpha');

      const results = await syncSkill('alpha', { targets: ['claude'] });
      assertEquals(results.length, 1);
      assertEquals(results[0].target, 'claude');
      assert(!(await exists(join(otherTarget, 'alpha'))));
      assert(await exists(join(env.home, '.claude', 'skills', 'alpha')));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('per-skill sync_method override wins over global', async () => {
  const env = await setupIsolatedEnv(); // global = copy
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await patchConfig(env.configPath, {
        paths: { source: env.sourceDir, targets: { claude: join(env.home, '.claude', 'skills') } },
        skills: {
          alpha: { sync_method: 'symlink' },
        },
      });

      const results = await syncSkill('alpha');
      assertEquals(results[0].action, 'symlinked');
      const lst = await Deno.lstat(join(env.home, '.claude', 'skills', 'alpha'));
      assert(lst.isSymlink);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('CLI --method override beats per-skill and global', async () => {
  const env = await setupIsolatedEnv({ sync_method: 'symlink' });
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await patchConfig(env.configPath, {
        skills: { alpha: { sync_method: 'symlink' } },
      });

      const results = await syncSkill('alpha', { method: 'copy' });
      assertEquals(results[0].action, 'copied');
      const lst = await Deno.lstat(join(env.home, '.claude', 'skills', 'alpha'));
      assert(!lst.isSymlink, 'expected a real directory, not a symlink');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('dryRun makes no changes', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      const results = await syncSkill('alpha', { dryRun: true });
      assertEquals(results[0].action, 'copied');
      assertEquals(results[0].reason, 'dry run');
      assert(!(await exists(join(env.home, '.claude', 'skills', 'alpha'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('missing target parent: skip with warning', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Point a target's parent to a non-existent path; reishi must skip rather
      // than cascade-create deep trees into the user's filesystem.
      await patchConfig(env.configPath, {
        paths: {
          source: env.sourceDir,
          targets: { claude: '/nonexistent-parent-xyz/deep/skills' },
        },
      });
      await seedSkill(env.sourceDir, 'alpha');

      const results = await syncSkill('alpha');
      assertEquals(results.length, 1);
      assertEquals(results[0].action, 'skipped');
      assert(results[0].reason?.includes('parent dir missing'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncSkill on missing source returns a failed result', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const results = await syncSkill('nonexistent');
      assertEquals(results.length, 1);
      assertEquals(results[0].action, 'failed');
      assert(results[0].reason?.includes('not found'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('unsyncSkill removes the skill from every target', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await syncSkill('alpha');
      assert(await exists(join(env.home, '.claude', 'skills', 'alpha')));

      const removed = await unsyncSkill('alpha');
      assertEquals(removed.length, 1);
      assertEquals(removed[0].reason, 'removed');
      assert(!(await exists(join(env.home, '.claude', 'skills', 'alpha'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('--targets validates against known names', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      const results = await syncSkill('alpha', { targets: ['bogus'] });
      assertEquals(results.length, 1);
      assertEquals(results[0].action, 'failed');
      assert(results[0].reason?.includes('unknown target'));
    });
  } finally {
    await env.cleanup();
  }
});

// ── Status tests ────────────────────────────────────────────────────────────
// Status is anchored on synced_at from the config:
//   stale    = source mtime > synced_at  (upstream moved)
//   diverged = target mtime > synced_at  (user edited locally)

Deno.test('status fresh: synced_at is current, no edits on either side', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await syncSkill('alpha');

      // Back-date source and target to before synced_at.
      const past = new Date(Date.now() - 120_000);
      const backdateTree = async (p: string): Promise<void> => {
        for await (const entry of Deno.readDir(p)) {
          const full = join(p, entry.name);
          if (entry.isDirectory) await backdateTree(full);
          await Deno.utime(full, past, past);
        }
        await Deno.utime(p, past, past);
      };
      await backdateTree(join(env.sourceDir, 'alpha'));
      await backdateTree(join(env.home, '.claude', 'skills', 'alpha'));

      // synced_at is "now" — both sides are older → fresh, not diverged.
      await patchConfig(env.configPath, {
        skills: {
          alpha: { synced_at: new Date().toISOString() },
        },
      });

      const statuses = await syncStatus();
      const alpha = statuses.find((s) => s.skillName === 'alpha' && s.target === 'claude');
      assert(alpha?.present);
      assertEquals(alpha?.stale, false);
      assertEquals(alpha?.diverged, false);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('status stale: source updated after synced_at, target untouched', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await syncSkill('alpha');

      // Set synced_at to the past.
      const syncedAt = new Date(Date.now() - 60_000);
      await patchConfig(env.configPath, {
        skills: {
          alpha: { synced_at: syncedAt.toISOString() },
        },
      });

      // Back-date target to before synced_at (no local edits).
      const oldTarget = new Date(syncedAt.getTime() - 60_000);
      const backdateTree = async (p: string): Promise<void> => {
        for await (const entry of Deno.readDir(p)) {
          const full = join(p, entry.name);
          if (entry.isDirectory) await backdateTree(full);
          await Deno.utime(full, oldTarget, oldTarget);
        }
        await Deno.utime(p, oldTarget, oldTarget);
      };
      await backdateTree(join(env.home, '.claude', 'skills', 'alpha'));

      // Bump source to after synced_at (upstream moved).
      const future = new Date();
      await Deno.writeTextFile(
        join(env.sourceDir, 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: updated upstream\n---\n',
      );
      await Deno.utime(join(env.sourceDir, 'alpha', 'SKILL.md'), future, future);

      const statuses = await syncStatus();
      const alpha = statuses.find((s) => s.skillName === 'alpha' && s.target === 'claude');
      assert(alpha?.present);
      assertEquals(alpha?.stale, true);
      assertEquals(alpha?.diverged, false);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('status diverged: target modified after synced_at, source untouched', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await syncSkill('alpha');

      // Set synced_at to the past.
      const syncedAt = new Date(Date.now() - 60_000);
      await patchConfig(env.configPath, {
        skills: {
          alpha: { synced_at: syncedAt.toISOString() },
        },
      });

      // Back-date source to before synced_at (no upstream changes).
      const oldSource = new Date(syncedAt.getTime() - 60_000);
      const backdateTree = async (p: string): Promise<void> => {
        for await (const entry of Deno.readDir(p)) {
          const full = join(p, entry.name);
          if (entry.isDirectory) await backdateTree(full);
          await Deno.utime(full, oldSource, oldSource);
        }
        await Deno.utime(p, oldSource, oldSource);
      };
      await backdateTree(join(env.sourceDir, 'alpha'));

      // Bump target to after synced_at (user edited locally).
      const future = new Date();
      await Deno.writeTextFile(
        join(env.home, '.claude', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: user tweaked\n---\n',
      );
      await Deno.utime(
        join(env.home, '.claude', 'skills', 'alpha', 'SKILL.md'),
        future,
        future,
      );

      const statuses = await syncStatus();
      const alpha = statuses.find((s) => s.skillName === 'alpha' && s.target === 'claude');
      assert(alpha?.present);
      assertEquals(alpha?.stale, false);
      assertEquals(alpha?.diverged, true);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('status stale + diverged: both source and target newer than synced_at', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await syncSkill('alpha');

      // synced_at well in the past.
      const syncedAt = new Date(Date.now() - 120_000);
      await patchConfig(env.configPath, {
        skills: {
          alpha: { synced_at: syncedAt.toISOString() },
        },
      });

      // Both source and target are newer than synced_at.
      const future = new Date();
      await Deno.writeTextFile(
        join(env.sourceDir, 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: upstream update\n---\n',
      );
      await Deno.utime(join(env.sourceDir, 'alpha', 'SKILL.md'), future, future);

      await Deno.writeTextFile(
        join(env.home, '.claude', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: user edit\n---\n',
      );
      await Deno.utime(
        join(env.home, '.claude', 'skills', 'alpha', 'SKILL.md'),
        future,
        future,
      );

      const statuses = await syncStatus();
      const alpha = statuses.find((s) => s.skillName === 'alpha' && s.target === 'claude');
      assert(alpha?.present);
      assertEquals(alpha?.stale, true);
      assertEquals(alpha?.diverged, true);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('status untracked: no synced_at means never stale or diverged', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await syncSkill('alpha');

      // No skills entry in config → untracked.
      const statuses = await syncStatus();
      const alpha = statuses.find((s) => s.skillName === 'alpha' && s.target === 'claude');
      assert(alpha?.present);
      assertEquals(alpha?.stale, false);
      assertEquals(alpha?.diverged, false);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('status symlink: never stale or diverged', async () => {
  const env = await setupIsolatedEnv({ sync_method: 'symlink' });
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'alpha');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await syncSkill('alpha');

      // Even with a stale synced_at, symlinks are always fresh.
      await patchConfig(env.configPath, {
        skills: {
          alpha: { synced_at: new Date(Date.now() - 300_000).toISOString() },
        },
      });

      const statuses = await syncStatus();
      const alpha = statuses.find((s) => s.skillName === 'alpha' && s.target === 'claude');
      assert(alpha?.present);
      assertEquals(alpha?.isSymlink, true);
      assertEquals(alpha?.stale, false);
      assertEquals(alpha?.diverged, false);
    });
  } finally {
    await env.cleanup();
  }
});
