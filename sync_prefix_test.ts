/**
 * Tests for prefix-change detection on `rei sync`. Covers the rename,
 * parallel, and abort flows non-interactively, plus dry-run preview and
 * target retargeting.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import type { ConfigSchema } from './config.ts';
import { resetPathCache } from './paths.ts';
import { syncSkill } from './sync.ts';
import {
  fakeFetchGithub,
  makeFixtureTarball,
  setupIsolatedEnv,
} from './test-helpers.ts';

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

async function readConfig(path: string): Promise<ConfigSchema> {
  const text = await Deno.readTextFile(path);
  return parseTOML(text) as unknown as ConfigSchema;
}

async function writeConfig(
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = parseTOML(await Deno.readTextFile(path)) as Record<string, unknown>;
  const next = { ...current, ...patch };
  await Deno.writeTextFile(path, stringifyTOML(next));
}

async function seedSkill(sourceDir: string, name: string): Promise<string> {
  const dir = join(sourceDir, name);
  await Deno.mkdir(join(dir, 'scripts'), { recursive: true });
  await Deno.writeTextFile(
    join(dir, 'SKILL.md'),
    `---\nname: book-review\ndescription: stale\n---\n`,
  );
  await Deno.writeTextFile(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho old\n');
  return dir;
}

Deno.test('prefix change (rename): renames source, target, and re-keys config', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('multi-skill-repo');
  try {
    await withEnv(env.env, async () => {
      const oldName = 'readwiseio_book-review';
      // Seed an existing prefixed skill in source AND a corresponding entry in
      // the claude target — emulating a previous successful sync.
      await seedSkill(env.sourceDir, oldName);
      const claudeTarget = join(env.home, '.claude', 'skills');
      await Deno.mkdir(claudeTarget, { recursive: true });
      await seedSkill(claudeTarget, oldName);

      // Past synced_at + back-dated mtimes → no local-mod prompt.
      await writeConfig(env.configPath, {
        skills: {
          [oldName]: {
            source_url: 'https://github.com/readwiseio/multi-skill-repo',
            subpath: 'skills/book-review',
            ref: 'main',
            // User edited the prefix:
            prefix: 'readwise',
            synced_at: new Date(Date.now() - 5_000).toISOString(),
          },
        },
      });
      const oldMtime = new Date(Date.now() - 60_000);
      await Deno.utime(join(env.sourceDir, oldName, 'SKILL.md'), oldMtime, oldMtime);
      await Deno.utime(
        join(env.sourceDir, oldName, 'scripts', 'run.sh'),
        oldMtime,
        oldMtime,
      );

      const results = await syncSkill(oldName, {
        prefixChange: 'rename',
        fetcher: fakeFetchGithub(tarball),
      });

      const newName = 'readwise_book-review';
      // Source dir renamed.
      assert(await exists(join(env.sourceDir, newName, 'SKILL.md')));
      assert(!(await exists(join(env.sourceDir, oldName))));
      // Target dir renamed too.
      assert(await exists(join(claudeTarget, newName)));
      assert(!(await exists(join(claudeTarget, oldName))));
      // Config re-keyed.
      const cfg = await readConfig(env.configPath);
      assert(cfg.skills?.[newName]);
      assert(!cfg.skills?.[oldName]);

      // Final target-sync result is reported under the new name.
      assert(results.some((r) => r.skillName === newName));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('prefix change (parallel): creates new-named entry alongside old', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('multi-skill-repo');
  try {
    await withEnv(env.env, async () => {
      const oldName = 'readwiseio_book-review';
      await seedSkill(env.sourceDir, oldName);
      const claudeTarget = join(env.home, '.claude', 'skills');
      await Deno.mkdir(claudeTarget, { recursive: true });

      await writeConfig(env.configPath, {
        skills: {
          [oldName]: {
            source_url: 'https://github.com/readwiseio/multi-skill-repo',
            subpath: 'skills/book-review',
            ref: 'main',
            prefix: 'readwise',
            synced_at: new Date(Date.now() - 5_000).toISOString(),
          },
        },
      });
      const oldMtime = new Date(Date.now() - 60_000);
      await Deno.utime(join(env.sourceDir, oldName, 'SKILL.md'), oldMtime, oldMtime);
      await Deno.utime(
        join(env.sourceDir, oldName, 'scripts', 'run.sh'),
        oldMtime,
        oldMtime,
      );

      await syncSkill(oldName, {
        prefixChange: 'parallel',
        fetcher: fakeFetchGithub(tarball),
      });

      const newName = 'readwise_book-review';
      // Old source still exists, new one populated by the fetch.
      assert(
        await exists(join(env.sourceDir, oldName, 'SKILL.md')),
        'old source dir should be preserved in parallel mode',
      );
      assert(
        await exists(join(env.sourceDir, newName, 'SKILL.md')),
        'new source dir should have been populated by the upstream fetch',
      );

      const cfg = await readConfig(env.configPath);
      assert(cfg.skills?.[oldName], 'old config entry should be preserved');
      assert(cfg.skills?.[newName], 'new config entry should exist');
      assertEquals(cfg.skills?.[newName].prefix, 'readwise');
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('prefix change (abort): exits with informative reason, no writes', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const oldName = 'readwiseio_book-review';
      await seedSkill(env.sourceDir, oldName);
      await writeConfig(env.configPath, {
        skills: {
          [oldName]: {
            source_url: 'https://github.com/readwiseio/multi-skill-repo',
            subpath: 'skills/book-review',
            ref: 'main',
            prefix: 'readwise',
            synced_at: new Date(Date.now() - 5_000).toISOString(),
          },
        },
      });

      const results = await syncSkill(oldName, { prefixChange: 'abort' });
      assert(results.length === 1);
      assertEquals(results[0].action, 'failed');
      assert(
        results[0].reason?.toLowerCase().includes('abort'),
        `expected abort reason, got: ${results[0].reason}`,
      );

      // Source dir untouched.
      assert(await exists(join(env.sourceDir, oldName, 'SKILL.md')));
      assert(!(await exists(join(env.sourceDir, 'readwise_book-review'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('prefix change (dry-run): previews rename without writing', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('multi-skill-repo');
  try {
    await withEnv(env.env, async () => {
      const oldName = 'readwiseio_book-review';
      await seedSkill(env.sourceDir, oldName);
      await writeConfig(env.configPath, {
        skills: {
          [oldName]: {
            source_url: 'https://github.com/readwiseio/multi-skill-repo',
            subpath: 'skills/book-review',
            ref: 'main',
            prefix: 'readwise',
            synced_at: new Date(Date.now() - 5_000).toISOString(),
          },
        },
      });

      await syncSkill(oldName, {
        dryRun: true,
        prefixChange: 'rename',
        fetcher: fakeFetchGithub(tarball),
      });

      // Source dir unchanged.
      assert(await exists(join(env.sourceDir, oldName, 'SKILL.md')));
      assert(!(await exists(join(env.sourceDir, 'readwise_book-review'))));
      // Config unchanged.
      const cfg = await readConfig(env.configPath);
      assert(cfg.skills?.[oldName]);
      assert(!cfg.skills?.['readwise_book-review']);
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('prefix change (no change): no-op when prefix matches dir name', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('multi-skill-repo');
  try {
    await withEnv(env.env, async () => {
      const name = 'readwiseio_book-review';
      await seedSkill(env.sourceDir, name);
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await writeConfig(env.configPath, {
        skills: {
          [name]: {
            source_url: 'https://github.com/readwiseio/multi-skill-repo',
            subpath: 'skills/book-review',
            ref: 'main',
            // Prefix matches the dir prefix → no change to apply.
            prefix: 'readwiseio',
            synced_at: new Date(Date.now() - 5_000).toISOString(),
          },
        },
      });
      const oldMtime = new Date(Date.now() - 60_000);
      await Deno.utime(join(env.sourceDir, name, 'SKILL.md'), oldMtime, oldMtime);
      await Deno.utime(
        join(env.sourceDir, name, 'scripts', 'run.sh'),
        oldMtime,
        oldMtime,
      );

      const results = await syncSkill(name, {
        prefixChange: 'abort', // would fire if prefix was actually changing
        fetcher: fakeFetchGithub(tarball),
      });
      // No abort — straight to fetch + target sync.
      assert(results.some((r) => r.action === 'copied' || r.action === 'symlinked'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});
