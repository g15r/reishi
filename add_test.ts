/**
 * Integration tests for `rei add` using offline fixtures.
 *
 * These drive `addSkill` directly with an injected fetcher built from a
 * tarball of a local fixture dir. No network, no GitHub.
 *
 * Run: deno task test:add
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { addSkill } from './reishi.ts';
import {
  fakeFetchGithub,
  type IsolatedEnv,
  makeFixtureTarball,
  setupIsolatedEnv,
} from './test-helpers.ts';

/** Pin env vars for the duration of fn; restore afterwards. */
async function withEnv(
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/**
 * Wrap a test body with an isolated env + injected fetcher for a named
 * fixture. Handles setup, env pinning, and cleanup.
 */
async function withFixture(
  fixtureRepoName: string,
  envOverrides: Parameters<typeof setupIsolatedEnv>[0],
  fn: (ctx: {
    env: IsolatedEnv;
    fetcher: (url: string) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const env = await setupIsolatedEnv(envOverrides);
  const tarballPath = await makeFixtureTarball(fixtureRepoName);
  const fetcher = fakeFetchGithub(tarballPath);
  try {
    await withEnv(env.env, () => fn({ env, fetcher }));
  } finally {
    try {
      await Deno.remove(tarballPath);
    } catch { /* ignore */ }
    await env.cleanup();
  }
}

// ---------- Objective 1: fixture wiring smoke tests ----------

Deno.test('add installs a single-skill fixture into the isolated source dir', async () => {
  await withFixture('single-skill-repo', {}, async ({ env, fetcher }) => {
    const url =
      'https://github.com/fakeuser/single-skill-repo/tree/main';
    const ok = await addSkill(url, env.sourceDir, { fetcher });
    assertEquals(ok, true);
    assert(
      await exists(join(env.sourceDir, 'single-skill-repo', 'SKILL.md')),
      'SKILL.md missing from installed skill',
    );
    assert(
      await exists(join(env.sourceDir, 'single-skill-repo', 'scripts', 'hello.sh')),
      'scripts/hello.sh missing from installed skill',
    );
  });
});

Deno.test('add installs all skills from a multi-skill fixture', async () => {
  await withFixture('multi-skill-repo', {}, async ({ env, fetcher }) => {
    const url =
      'https://github.com/fakeorg/multi-skill-repo/tree/main/skills';
    const ok = await addSkill(url, env.sourceDir, { fetcher });
    assertEquals(ok, true);
    assert(await exists(join(env.sourceDir, 'book-review', 'SKILL.md')));
    assert(await exists(join(env.sourceDir, 'readwise-cli', 'SKILL.md')));
  });
});
