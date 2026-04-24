/**
 * Tests for the upstream-fetch arm of `rei sync`. Covers tracked-skill fetch,
 * untracked-skill fallback to target sync, --no-fetch bypass, --force / local
 * modification handling, dry-run preview, and multi-skill repo isolation.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import type { LockfileSchema, SkillLockEntry } from './config.ts';
import { resetPathCache } from './paths.ts';
import { fetchUpstream, syncSkill } from './sync.ts';
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

async function readLockfile(path: string): Promise<LockfileSchema> {
  if (!(await exists(path))) return { skills: {} };
  const text = await Deno.readTextFile(path);
  const parsed = parseTOML(text) as unknown as { skills?: LockfileSchema['skills'] };
  return { skills: parsed.skills ?? {} };
}

async function writeLockfile(
  path: string,
  patch: { skills: Record<string, SkillLockEntry> },
): Promise<void> {
  await Deno.writeTextFile(path, stringifyTOML(patch as unknown as Record<string, unknown>));
}

async function seedSkill(sourceDir: string, name: string): Promise<string> {
  const dir = join(sourceDir, name);
  await Deno.mkdir(join(dir, 'scripts'), { recursive: true });
  await Deno.writeTextFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: stale\n---\n`,
  );
  await Deno.writeTextFile(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho old\n');
  return dir;
}

Deno.test('sync (tracked): pulls upstream, overwrites source, updates synced_at', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      // Seed a stale "local" copy that the fetch will overwrite.
      await seedSkill(env.sourceDir, 'single-skill-repo');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      // Use a past synced_at and back-date the seed files so they look in
      // sync (mtime <= synced_at) — the fetch then proceeds without prompting.
      const initialSynced = new Date(Date.now() - 5_000).toISOString();
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: initialSynced,
          },
        },
      });
      const oldMtime = new Date(Date.now() - 60_000);
      await Deno.utime(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
        oldMtime,
        oldMtime,
      );
      await Deno.utime(
        join(env.sourceDir, 'single-skill-repo', 'scripts', 'run.sh'),
        oldMtime,
        oldMtime,
      );

      const before = (await readLockfile(env.lockfilePath)).skills['single-skill-repo'].synced_at!;
      await new Promise((r) => setTimeout(r, 20));

      const results = await syncSkill('single-skill-repo', {
        fetcher: fakeFetchGithub(tarball),
      });

      // Fetch overwrote the stale SKILL.md with the fixture's real one.
      const updated = await Deno.readTextFile(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
      );
      assert(updated.includes('A test fixture skill'));

      // synced_at advanced.
      const after = (await readLockfile(env.lockfilePath)).skills['single-skill-repo'].synced_at!;
      assert(after > before, `expected synced_at to advance: before=${before} after=${after}`);

      // And target sync ran.
      const targetCopy = join(env.home, '.claude', 'skills', 'single-skill-repo', 'SKILL.md');
      assert(await exists(targetCopy), 'target was not synced');
      assert(results.some((r) => r.action === 'copied' || r.action === 'symlinked'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('sync (untracked): no upstream fetch, only target sync', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'plain');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      // Note: no fetcher injected — if fetchUpstream tried to run, it'd hit fetch().
      const results = await syncSkill('plain');
      assertEquals(results.length, 1);
      assertEquals(results[0].action, 'copied');

      // Source SKILL.md unchanged (still says "stale" from seedSkill).
      const src = await Deno.readTextFile(join(env.sourceDir, 'plain', 'SKILL.md'));
      assert(src.includes('description: stale'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('sync (--no-fetch): skips upstream pull even for tracked skills', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'single-skill-repo');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: new Date(Date.now() - 5_000).toISOString(),
          },
        },
      });

      // Pass a fetcher that throws if invoked — proves we never called it.
      const failingFetcher = () => {
        throw new Error('fetcher should not have been called');
      };
      const results = await syncSkill('single-skill-repo', {
        fetchUpstream: false,
        fetcher: failingFetcher as unknown as typeof fetch,
      });

      // Source SKILL.md still says "stale" — fetch was suppressed.
      const src = await Deno.readTextFile(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
      );
      assert(src.includes('description: stale'));

      // But target sync still ran.
      assert(results.some((r) => r.action === 'copied'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('sync (--dry-run): no source write, no synced_at advance', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'single-skill-repo');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });
      const initialSynced = new Date(Date.now() + 60_000).toISOString();
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: initialSynced,
          },
        },
      });

      await syncSkill('single-skill-repo', {
        dryRun: true,
        fetcher: fakeFetchGithub(tarball),
      });

      // Source unchanged.
      const src = await Deno.readTextFile(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
      );
      assert(src.includes('description: stale'));
      // synced_at unchanged.
      const after = (await readLockfile(env.lockfilePath)).skills['single-skill-repo'].synced_at!;
      assertEquals(after, initialSynced);
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('sync (local mods, no force): aborts with informative reason', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'single-skill-repo');
      // synced_at is OLDER than mtime — the source files look "locally modified".
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: new Date(Date.now() - 300_000).toISOString(),
          },
        },
      });

      // Inject a declining prompt to avoid hanging when stdin is a terminal
      // (e.g. running `deno task test` from an interactive shell).
      const results = await syncSkill('single-skill-repo', {
        fetcher: fakeFetchGithub(tarball),
        promptYesNo: async () => false,
      });
      // Declined => failed result with the local-mod reason.
      assert(results.some((r) => r.action === 'failed' && (r.reason ?? '').includes('declined')));
      // Source untouched — still has the old "stale" description.
      const src = await Deno.readTextFile(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
      );
      assert(src.includes('description: stale'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('sync (local mods, --force): proceeds and overwrites source', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'single-skill-repo');
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: new Date(Date.now() - 300_000).toISOString(),
          },
        },
      });
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      await syncSkill('single-skill-repo', {
        force: true,
        fetcher: fakeFetchGithub(tarball),
      });
      const src = await Deno.readTextFile(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
      );
      assert(src.includes('A test fixture skill'), 'source should now contain upstream content');
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('sync (multi-skill repo): only the requested skill is synced from the same repo', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('multi-skill-repo');
  try {
    await withEnv(env.env, async () => {
      // Seed two siblings from the same upstream repo.
      await seedSkill(env.sourceDir, 'book-review');
      await seedSkill(env.sourceDir, 'readwise-cli');
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      const sharedUrl = 'https://github.com/fakeorg/multi-skill-repo';
      const farFuture = new Date(Date.now() + 60_000).toISOString();
      await writeLockfile(env.lockfilePath, {
        skills: {
          'book-review': {
            source_url: sharedUrl,
            subpath: 'skills/book-review',
            ref: 'main',
            synced_at: farFuture,
          },
          'readwise-cli': {
            source_url: sharedUrl,
            subpath: 'skills/readwise-cli',
            ref: 'main',
            synced_at: farFuture,
          },
        },
      });

      await syncSkill('book-review', { fetcher: fakeFetchGithub(tarball) });

      // book-review SKILL.md was overwritten with the fixture content.
      const br = await Deno.readTextFile(join(env.sourceDir, 'book-review', 'SKILL.md'));
      assert(br.includes('A test fixture skill'));
      // readwise-cli was untouched — still says "stale".
      const rc = await Deno.readTextFile(join(env.sourceDir, 'readwise-cli', 'SKILL.md'));
      assert(rc.includes('description: stale'), 'sibling skill should not have been touched');
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('sync (local mods, prompt accepts): proceeds like --force', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'single-skill-repo');
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: new Date(Date.now() - 300_000).toISOString(),
          },
        },
      });
      await Deno.mkdir(join(env.home, '.claude', 'skills'), { recursive: true });

      const results = await syncSkill('single-skill-repo', {
        fetcher: fakeFetchGithub(tarball),
        promptYesNo: async () => true,
      });
      // Prompt accepted → fetch proceeded → source overwritten.
      const src = await Deno.readTextFile(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
      );
      assert(src.includes('A test fixture skill'), 'source should contain upstream content');
      assert(results.some((r) => r.action === 'copied' || r.action === 'symlinked'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('sync (local mods, prompt declines): aborts with declined reason', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'single-skill-repo');
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: new Date(Date.now() - 300_000).toISOString(),
          },
        },
      });

      const results = await syncSkill('single-skill-repo', {
        fetcher: fakeFetchGithub(tarball),
        promptYesNo: async () => false,
      });
      // Prompt declined → abort with "declined" wording (not the non-interactive hint).
      assert(results.some((r) => r.action === 'failed' && (r.reason ?? '').includes('declined')));
      // Source untouched.
      const src = await Deno.readTextFile(
        join(env.sourceDir, 'single-skill-repo', 'SKILL.md'),
      );
      assert(src.includes('description: stale'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('fetchUpstream (direct): exposes structured diff for tracked skill', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env.sourceDir, 'single-skill-repo');
      await writeLockfile(env.lockfilePath, {
        skills: {
          'single-skill-repo': {
            source_url: 'https://github.com/fakeuser/single-skill-repo',
            subpath: '',
            ref: 'main',
            synced_at: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });

      const result = await fetchUpstream('single-skill-repo', {
        fetcher: fakeFetchGithub(tarball),
      });
      assertEquals(result.fetched, true);
      assertEquals(result.changed, true);
      // Fixture has SKILL.md + scripts/hello.sh; seed had SKILL.md + scripts/run.sh.
      assert(result.diff.added.includes('scripts/hello.sh'));
      assert(result.diff.removed.includes('scripts/run.sh'));
      assert(result.diff.modified.includes('SKILL.md'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});
