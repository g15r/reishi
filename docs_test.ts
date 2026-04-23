/**
 * Tests for docs.ts — list/add/remove against isolated envs, local + fake
 * fetchers, and GitHub tree URLs served from fixture tarballs. Compile and
 * sync coverage is added alongside those features in later commits.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { resetPathCache } from './paths.ts';
import {
  addFragment,
  getDocProjectNames,
  getFragmentNames,
  listDocProjects,
  listFragments,
  removeFragment,
} from './docs.ts';
import {
  fakeFetchGithub,
  fixturesPath,
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

function fakeFetchText(body: string): (url: string) => Promise<Response> {
  return async (_url: string) =>
    await new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    });
}

async function seedDocsSource(docsDir: string): Promise<void> {
  await Deno.mkdir(join(docsDir, 'myproject-a'), { recursive: true });
  await Deno.writeTextFile(
    join(docsDir, 'myproject-a', 'api-conventions.md'),
    '---\ndescription: API conventions for myproject-a.\npriority: 10\n---\n\n# API\n\nBody.\n',
  );
  await Deno.writeTextFile(
    join(docsDir, 'myproject-a', 'testing.md'),
    '# Testing\n\nRun tests in isolated temp dirs.\n',
  );
  await Deno.mkdir(join(docsDir, 'myproject-b'), { recursive: true });
  await Deno.writeTextFile(
    join(docsDir, 'myproject-b', 'deploy.md'),
    '# Deploy\n\nTag and ship.\n',
  );
  // Dotfile + nested dir: both must be ignored by listers.
  await Deno.writeTextFile(join(docsDir, '.hidden'), 'ignored');
  await Deno.mkdir(join(docsDir, 'myproject-a', 'nested'), { recursive: true });
  await Deno.writeTextFile(
    join(docsDir, 'myproject-a', 'nested', 'ignored.md'),
    'nested fragments are not supported in v1',
  );
}

// ============================================================================
// listDocProjects / listFragments
// ============================================================================

Deno.test('listDocProjects: empty source returns empty', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      assertEquals(await listDocProjects(), []);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('listDocProjects: returns subdirs, excludes dotfiles', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const projects = await listDocProjects();
      assertEquals(projects, ['myproject-a', 'myproject-b']);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('listFragments: flat .md only, ignores nested dirs and dotfiles', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const fragments = await listFragments('myproject-a');
      const names = fragments.map((f) => f.name).sort();
      assertEquals(names, ['api-conventions.md', 'testing.md']);
      for (const f of fragments) {
        assert(f.size > 0);
      }
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('listFragments: missing project returns empty', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      assertEquals(await listFragments('nonexistent'), []);
    });
  } finally {
    await env.cleanup();
  }
});

// ============================================================================
// addFragment
// ============================================================================

Deno.test('addFragment: local file is copied into the project dir', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const src = fixturesPath('docs', 'myproject-a', 'api-conventions.md');
      const dest = await addFragment('myproject-a', src);
      assert(await exists(dest));
      const fragments = await listFragments('myproject-a');
      assertEquals(fragments.length, 1);
      assertEquals(fragments[0].name, 'api-conventions.md');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addFragment: from https URL with fake fetcher', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const body = '# Remote Fragment\n\nFrom the wire.\n';
      const dest = await addFragment(
        'myproject-a',
        'https://example.com/docs/remote.md',
        { fetcher: fakeFetchText(body) },
      );
      assert(await exists(dest));
      assertEquals(await Deno.readTextFile(dest), body);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addFragment: from URL without .md extension saves as .md', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const dest = await addFragment(
        'myproject-a',
        'https://example.com/raw/fragment-body',
        { fetcher: fakeFetchText('hi') },
      );
      assert(dest.endsWith('fragment-body.md'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addFragment: GitHub tree URL pointing at a single file', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('docs-repo');
  try {
    await withEnv(env.env, async () => {
      const url = 'https://github.com/fakeorg/docs-repo/tree/main/fragments/api.md';
      const dest = await addFragment('myproject-a', url, {
        fetcher: fakeFetchGithub(tarball),
      });
      assert(await exists(dest));
      assert(dest.endsWith('api.md'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('addFragment: GitHub tree URL pointing at a directory is rejected', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('docs-repo');
  try {
    await withEnv(env.env, async () => {
      const url = 'https://github.com/fakeorg/docs-repo/tree/main/fragments';
      await assertRejects(
        () =>
          addFragment('myproject-a', url, { fetcher: fakeFetchGithub(tarball) }),
        Error,
        'must point at a single file',
      );
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('addFragment: refuses to overwrite without --force', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const src = fixturesPath('docs', 'myproject-a', 'api-conventions.md');
      await addFragment('myproject-a', src);
      await assertRejects(
        () => addFragment('myproject-a', src),
        Error,
        'already exists',
      );
      await addFragment('myproject-a', src, { force: true });
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addFragment: local directory is rejected', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await assertRejects(
        () => addFragment('myproject-a', fixturesPath('docs', 'myproject-a')),
        Error,
        'must be a file',
      );
    });
  } finally {
    await env.cleanup();
  }
});

// ============================================================================
// removeFragment
// ============================================================================

Deno.test('removeFragment: removes the file', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      await removeFragment('myproject-a', 'testing.md');
      const remaining = (await listFragments('myproject-a')).map((f) => f.name);
      assertEquals(remaining, ['api-conventions.md']);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeFragment: missing fragment throws', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      await assertRejects(
        () => removeFragment('myproject-a', 'nope.md'),
        Error,
        'not found',
      );
    });
  } finally {
    await env.cleanup();
  }
});

// ============================================================================
// Completion helpers
// ============================================================================

Deno.test('getDocProjectNames + getFragmentNames: return sorted names', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      assertEquals(await getDocProjectNames(), ['myproject-a', 'myproject-b']);
      assertEquals(await getFragmentNames('myproject-a'), [
        'api-conventions.md',
        'testing.md',
      ]);
    });
  } finally {
    await env.cleanup();
  }
});
