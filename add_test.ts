/**
 * Integration tests for `rei add` using offline fixtures.
 *
 * These drive `addSkill` directly with an injected fetcher built from a
 * tarball of a local fixture dir. No network, no GitHub.
 *
 * Run: deno task test:add
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { parse as parseTOML } from '@std/toml';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { addSkill } from './reishi.ts';
import type { ConfigSchema, LockfileSchema } from './config.ts';
import {
  fakeFetchGithub,
  type IsolatedEnv,
  makeFixtureTarball,
  setupIsolatedEnv,
} from './test-helpers.ts';

async function readConfig(path: string): Promise<ConfigSchema> {
  const text = await Deno.readTextFile(path);
  return parseTOML(text) as unknown as ConfigSchema;
}

async function readLockfile(path: string): Promise<LockfileSchema> {
  if (!(await exists(path))) return { skills: {} };
  const text = await Deno.readTextFile(path);
  const parsed = parseTOML(text) as unknown as { skills?: LockfileSchema['skills'] };
  return { skills: parsed.skills ?? {} };
}

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

// ---------- Objective 2: --track flag ----------

Deno.test('track: tracked add writes a lockfile entry', async () => {
  await withFixture('single-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/fakeuser/single-skill-repo/tree/main';
    const ok = await addSkill(url, env.sourceDir, { fetcher, track: true });
    assertEquals(ok, true);

    const lock = await readLockfile(env.lockfilePath);
    const entry = lock.skills['single-skill-repo'];
    assert(entry, 'lockfile entry for single-skill-repo missing');
    assertEquals(entry.source_url, 'https://github.com/fakeuser/single-skill-repo');
    assertEquals(entry.ref, 'main');
    assertEquals(entry.subpath, '');
    assert(entry.synced_at, 'synced_at missing');
    assert(
      !Number.isNaN(Date.parse(entry.synced_at!)),
      `synced_at not ISO-parsable: ${entry.synced_at}`,
    );
  });
});

Deno.test('track: multi-skill tracked add writes one lockfile entry per skill', async () => {
  await withFixture('multi-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/fakeorg/multi-skill-repo/tree/main/skills';
    const ok = await addSkill(url, env.sourceDir, { fetcher, track: true });
    assertEquals(ok, true);

    const lock = await readLockfile(env.lockfilePath);
    const br = lock.skills['book-review'];
    const rc = lock.skills['readwise-cli'];
    assert(br && rc, 'expected both skills tracked');
    assertEquals(br.source_url, 'https://github.com/fakeorg/multi-skill-repo');
    assertEquals(rc.source_url, 'https://github.com/fakeorg/multi-skill-repo');
    assertEquals(br.subpath, 'skills/book-review');
    assertEquals(rc.subpath, 'skills/readwise-cli');
  });
});

Deno.test('track: untracked add writes nothing to the lockfile', async () => {
  await withFixture('single-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/fakeuser/single-skill-repo/tree/main';
    const ok = await addSkill(url, env.sourceDir, { fetcher });
    assertEquals(ok, true);

    const lock = await readLockfile(env.lockfilePath);
    assertEquals(Object.keys(lock.skills).length, 0);
  });
});

Deno.test('track: re-adding a tracked skill updates synced_at', async () => {
  await withFixture('single-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/fakeuser/single-skill-repo/tree/main';
    const ok1 = await addSkill(url, env.sourceDir, { fetcher, track: true });
    assertEquals(ok1, true);
    const first = (await readLockfile(env.lockfilePath)).skills['single-skill-repo'].synced_at!;

    // Ensure clock ticks between runs so ISO strings differ.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Re-add with --track: dir exists + tracked → re-track path updates timestamp.
    const ok2 = await addSkill(url, env.sourceDir, { fetcher, track: true });
    assertEquals(ok2, true);
    const lock2 = await readLockfile(env.lockfilePath);
    const second = lock2.skills['single-skill-repo'].synced_at!;
    assert(
      second > first,
      `expected synced_at to increase: first=${first} second=${second}`,
    );
    // Still just one entry, not a duplicate.
    assertEquals(Object.keys(lock2.skills).length, 1);
  });
});

// ---------- Objective 3: --prefix flag ----------

Deno.test('prefix: inferred from URL org when empty-string prefix passed', async () => {
  await withFixture('multi-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/readwiseio/multi-skill-repo/tree/main/skills';
    const ok = await addSkill(url, env.sourceDir, { fetcher, prefix: '' });
    assertEquals(ok, true);
    assert(await exists(join(env.sourceDir, 'readwiseio_book-review', 'SKILL.md')));
    assert(await exists(join(env.sourceDir, 'readwiseio_readwise-cli', 'SKILL.md')));
  });
});

Deno.test('prefix: explicit value overrides inference', async () => {
  await withFixture('multi-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/readwiseio/multi-skill-repo/tree/main/skills';
    const ok = await addSkill(url, env.sourceDir, { fetcher, prefix: 'custom' });
    assertEquals(ok, true);
    assert(await exists(join(env.sourceDir, 'custom_book-review', 'SKILL.md')));
    assert(await exists(join(env.sourceDir, 'custom_readwise-cli', 'SKILL.md')));
  });
});

Deno.test('prefix: custom prefix_separator from config is respected', async () => {
  await withFixture(
    'multi-skill-repo',
    { prefix_separator: '-' },
    async ({ env, fetcher }) => {
      const url = 'https://github.com/readwiseio/multi-skill-repo/tree/main/skills';
      const ok = await addSkill(url, env.sourceDir, { fetcher, prefix: 'org' });
      assertEquals(ok, true);
      assert(await exists(join(env.sourceDir, 'org-book-review', 'SKILL.md')));
      assert(await exists(join(env.sourceDir, 'org-readwise-cli', 'SKILL.md')));
    },
  );
});

Deno.test('prefix: default_prefix = "infer" applies prefix even without -p flag', async () => {
  await withFixture(
    'multi-skill-repo',
    { default_prefix: 'infer' },
    async ({ env, fetcher }) => {
      const url = 'https://github.com/readwiseio/multi-skill-repo/tree/main/skills';
      // No `prefix` option — config's default_prefix=infer should kick in.
      const ok = await addSkill(url, env.sourceDir, { fetcher });
      assertEquals(ok, true);
      assert(await exists(join(env.sourceDir, 'readwiseio_book-review', 'SKILL.md')));
    },
  );
});

Deno.test('prefix: default_prefix = "none" (default) applies no prefix', async () => {
  await withFixture('multi-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/readwiseio/multi-skill-repo/tree/main/skills';
    const ok = await addSkill(url, env.sourceDir, { fetcher });
    assertEquals(ok, true);
    assert(await exists(join(env.sourceDir, 'book-review', 'SKILL.md')));
    assert(!(await exists(join(env.sourceDir, 'readwiseio_book-review'))));
  });
});

Deno.test('prefix + track: prefix recorded in lockfile entry', async () => {
  await withFixture('multi-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/readwiseio/multi-skill-repo/tree/main/skills';
    const ok = await addSkill(url, env.sourceDir, {
      fetcher,
      track: true,
      prefix: '',
    });
    assertEquals(ok, true);

    const lock = await readLockfile(env.lockfilePath);
    const br = lock.skills['readwiseio_book-review'];
    const rc = lock.skills['readwiseio_readwise-cli'];
    assert(br && rc, 'expected both prefixed skills tracked');
    assertEquals(br.prefix, 'readwiseio');
    assertEquals(rc.prefix, 'readwiseio');
  });
});

Deno.test('prefix: prefixed name with underscore separator installs successfully', async () => {
  await withFixture('single-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/acme/single-skill-repo/tree/main';
    const ok = await addSkill(url, env.sourceDir, { fetcher, prefix: '' });
    assertEquals(ok, true);
    assert(await exists(join(env.sourceDir, 'acme_single-skill-repo', 'SKILL.md')));
  });
});

Deno.test('track: TOML round-trips hyphenated skill names in lockfile entries', async () => {
  await withFixture('multi-skill-repo', {}, async ({ env, fetcher }) => {
    const url = 'https://github.com/readwiseio/multi-skill-repo/tree/main/skills';
    const ok = await addSkill(url, env.sourceDir, {
      fetcher,
      track: true,
      prefix: '',
    });
    assertEquals(ok, true);

    const raw = await Deno.readTextFile(env.lockfilePath);
    // Hyphen + underscore in the key should serialize safely (quoted or dotted).
    assertStringIncludes(raw, 'readwiseio_book-review');
    assertStringIncludes(raw, 'readwiseio_readwise-cli');

    // Round-trip still yields valid entries.
    const lock = await readLockfile(env.lockfilePath);
    assert(lock.skills['readwiseio_book-review']);
    assert(lock.skills['readwiseio_readwise-cli']);
  });
});
