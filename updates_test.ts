/**
 * Tests for the update-polling layer: `checkForUpdates`,
 * `isBackgroundCheckDue`, and the per-skill / global disable knobs.
 */

import { assert, assertEquals } from '@std/assert';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import type { ConfigSchema, LockfileSchema, SkillLockEntry } from './config.ts';
import { resetPathCache } from './paths.ts';
import {
  checkForUpdates,
  isBackgroundCheckDue,
  recordBackgroundCheck,
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

async function writeLockfile(
  path: string,
  skills: Record<string, Partial<SkillLockEntry>>,
): Promise<void> {
  await Deno.writeTextFile(
    path,
    stringifyTOML({ skills } as unknown as Record<string, unknown>),
  );
}

// Helper retained for symmetry with other test files, though this file's
// assertions no longer probe the lockfile directly.
async function _readLockfile(path: string): Promise<LockfileSchema> {
  if (!(await exists(path))) return { skills: {} };
  const text = await Deno.readTextFile(path);
  const parsed = parseTOML(text) as unknown as { skills?: LockfileSchema['skills'] };
  return { skills: parsed.skills ?? {} };
}

/** Build a fetcher that returns `{sha}` JSON for the GitHub commits endpoint. */
function fakeShaFetcher(sha: string): (url: string) => Promise<Response> {
  return (_url: string) =>
    Promise.resolve(
      new Response(JSON.stringify({ sha }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

Deno.test('checkForUpdates: detects changed SHA against lockfile sha', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await writeLockfile(env.lockfilePath, {
        alpha: {
          source_url: 'https://github.com/foo/bar',
          subpath: '',
          ref: 'main',
          synced_at: new Date().toISOString(),
          sha: 'aaaaaaa',
        },
      });
      const checks = await checkForUpdates(undefined, {
        fetcher: fakeShaFetcher('bbbbbbb'),
      });
      assertEquals(checks.length, 1);
      assertEquals(checks[0].hasUpdate, true);
      assertEquals(checks[0].remoteSha, 'bbbbbbb');
      assertEquals(checks[0].previousSha, 'aaaaaaa');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('checkForUpdates: hasUpdate=false when SHA matches', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await writeLockfile(env.lockfilePath, {
        alpha: {
          source_url: 'https://github.com/foo/bar',
          subpath: '',
          ref: 'main',
          synced_at: new Date().toISOString(),
          sha: 'cafe',
        },
      });
      const checks = await checkForUpdates(undefined, {
        fetcher: fakeShaFetcher('cafe'),
      });
      assertEquals(checks.length, 1);
      assertEquals(checks[0].hasUpdate, false);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('checkForUpdates: skips skills with updates=false in config', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Tracking state in the lockfile.
      await writeLockfile(env.lockfilePath, {
        alpha: {
          source_url: 'https://github.com/foo/bar',
          subpath: '',
          ref: 'main',
          synced_at: new Date().toISOString(),
          sha: 'old',
        },
        beta: {
          source_url: 'https://github.com/foo/bar',
          subpath: '',
          ref: 'main',
          synced_at: new Date().toISOString(),
          sha: 'old',
        },
      });
      // Per-skill updates disable lives in config, not lockfile.
      await writeConfig(env.configPath, {
        skills: { alpha: { updates: false } },
      });
      const checks = await checkForUpdates(undefined, {
        fetcher: fakeShaFetcher('new'),
      });
      const alpha = checks.find((c) => c.skillName === 'alpha');
      const beta = checks.find((c) => c.skillName === 'beta');
      assert(alpha?.skipped);
      assertEquals(alpha?.reason, 'disabled per-skill');
      assertEquals(beta?.hasUpdate, true);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('isBackgroundCheckDue: respects interval_hours gate', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Enable polling with a very short interval (sub-hour by using fractional).
      await writeConfig(env.configPath, {
        updates: { enabled: true, interval_hours: 24 },
      });

      // No prior check → due.
      assertEquals(await isBackgroundCheckDue(), true);

      await recordBackgroundCheck();
      // Just recorded → not due (24h gate).
      assertEquals(await isBackgroundCheckDue(), false);

      // Backdate the check by 25h → due again.
      const cfg = await readConfig(env.configPath);
      const past = new Date(Date.now() - 25 * 3_600_000).toISOString();
      cfg.updates.last_background_check = past;
      await Deno.writeTextFile(
        env.configPath,
        stringifyTOML(cfg as unknown as Record<string, unknown>),
      );
      assertEquals(await isBackgroundCheckDue(), true);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('isBackgroundCheckDue: false when [updates].enabled = false', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await writeConfig(env.configPath, {
        updates: { enabled: false, interval_hours: 24 },
      });
      assertEquals(await isBackgroundCheckDue(), false);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('checkForUpdates: skips untracked or malformed lockfile entries with reasons', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await writeLockfile(env.lockfilePath, {
        incomplete: {
          // No source_url + no ref → skipped.
          prefix: 'foo',
        },
      });
      const checks = await checkForUpdates(undefined, {
        fetcher: fakeShaFetcher('whatever'),
      });
      assertEquals(checks.length, 1);
      assert(checks[0].skipped);
      assert(checks[0].reason?.includes('source_url'));
    });
  } finally {
    await env.cleanup();
  }
});
