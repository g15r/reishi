/**
 * Tests for docs.ts — list/add/remove against isolated envs, index
 * compilation with frontmatter/priority/token budget handling, and target
 * distribution of fragments. Full CLI sync wiring lives alongside its
 * objective's commit.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { resetPathCache } from './paths.ts';
import {
  addFragment,
  compileIndex,
  compileToTarget,
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

async function patchConfig(
  configPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const raw = await Deno.readTextFile(configPath);
  const current = parseTOML(raw) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      current[k] && typeof current[k] === 'object' && !Array.isArray(current[k])
    ) {
      next[k] = { ...(current[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      next[k] = v;
    }
  }
  await Deno.writeTextFile(configPath, stringifyTOML(next));
}

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

// ============================================================================
// compileIndex
// ============================================================================

Deno.test('compileIndex: includes all fragments with descriptions', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const index = await compileIndex('myproject-a', env.projectDir);
      assertStringIncludes(index, '# myproject-a — docs index');
      assertStringIncludes(index, '## api-conventions.md');
      assertStringIncludes(index, 'API conventions for myproject-a.');
      assertStringIncludes(index, '## testing.md');
      // Testing.md's description should come from the first non-heading line.
      assertStringIncludes(index, 'Run tests in isolated temp dirs.');
      assertStringIncludes(index, '`.agents/docs/api-conventions.md`');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileIndex: priority orders sections', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.docsDir, 'proj'), { recursive: true });
      // Alphabetically 'a' beats 'b', but priority pushes b first.
      await Deno.writeTextFile(
        join(env.docsDir, 'proj', 'a.md'),
        '---\ndescription: Low.\npriority: 1\n---\n\nbody\n',
      );
      await Deno.writeTextFile(
        join(env.docsDir, 'proj', 'b.md'),
        '---\ndescription: High.\npriority: 10\n---\n\nbody\n',
      );
      const index = await compileIndex('proj', env.projectDir);
      const bIdx = index.indexOf('## b.md');
      const aIdx = index.indexOf('## a.md');
      assert(bIdx > -1 && aIdx > -1 && bIdx < aIdx, 'expected b before a');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileIndex: falls back to first non-heading paragraph, then heading', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.docsDir, 'proj'), { recursive: true });
      await Deno.writeTextFile(
        join(env.docsDir, 'proj', 'paragraph.md'),
        '# Heading\n\nFirst paragraph line wins.\n',
      );
      await Deno.writeTextFile(
        join(env.docsDir, 'proj', 'headingonly.md'),
        '# Just A Heading\n',
      );
      const index = await compileIndex('proj', env.projectDir);
      assertStringIncludes(index, 'First paragraph line wins.');
      assertStringIncludes(index, 'Just A Heading');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileIndex: token budget truncates and appends omitted line', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Tight budget — smaller than one fragment section costs.
      await patchConfig(env.configPath, {
        docs: {
          source: env.docsDir,
          default_target: '.agents/docs',
          index_filename: 'AGENTS.md',
          token_budget: 40,
        },
      });
      resetPathCache();

      await Deno.mkdir(join(env.docsDir, 'proj'), { recursive: true });
      for (const name of ['a.md', 'b.md', 'c.md']) {
        await Deno.writeTextFile(
          join(env.docsDir, 'proj', name),
          `---\ndescription: ${name} description with enough text to cost tokens.\n---\n\nbody\n`,
        );
      }
      const index = await compileIndex('proj', env.projectDir);
      assertStringIncludes(index, 'more fragment');
      assertStringIncludes(index, 'omitted');
      // At least one section must still appear — we always include one fragment
      // even if it alone exceeds the budget.
      assertStringIncludes(index, '## a.md');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileIndex: respects fragments filter', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const index = await compileIndex('myproject-a', env.projectDir, {
        fragments: ['api-conventions.md'],
      });
      assertStringIncludes(index, '## api-conventions.md');
      assert(!index.includes('## testing.md'));
    });
  } finally {
    await env.cleanup();
  }
});

// ============================================================================
// compileToTarget
// ============================================================================

Deno.test('compileToTarget: writes index + fragments to target dir', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const result = await compileToTarget('myproject-a', env.projectDir);
      assertEquals(result.action, 'copied');
      assertEquals(result.fragmentsWritten, 2);

      const indexPath = join(env.projectDir, 'AGENTS.md');
      assert(await exists(indexPath));
      const indexText = await Deno.readTextFile(indexPath);
      assertStringIncludes(indexText, '# myproject-a — docs index');

      const apiCopy = join(env.projectDir, '.agents', 'docs', 'api-conventions.md');
      assert(await exists(apiCopy));
      const testingCopy = join(env.projectDir, '.agents', 'docs', 'testing.md');
      assert(await exists(testingCopy));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileToTarget: --stdout writes nothing', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const result = await compileToTarget('myproject-a', env.projectDir, {
        stdout: true,
      });
      assertEquals(result.action, 'skipped');
      assert(!(await exists(join(env.projectDir, 'AGENTS.md'))));
      assert(!(await exists(join(env.projectDir, '.agents'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileToTarget: --dry-run writes nothing', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const result = await compileToTarget('myproject-a', env.projectDir, {
        dryRun: true,
      });
      assertEquals(result.reason, 'dry run');
      assert(!(await exists(join(env.projectDir, 'AGENTS.md'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileToTarget: symlink mode links back to absolute source', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      const result = await compileToTarget('myproject-a', env.projectDir, {
        method: 'symlink',
      });
      assertEquals(result.action, 'symlinked');
      const apiTarget = join(env.projectDir, '.agents', 'docs', 'api-conventions.md');
      const lst = await Deno.lstat(apiTarget);
      assert(lst.isSymlink);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileToTarget: re-compile clears stale fragments', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedDocsSource(env.docsDir);
      await compileToTarget('myproject-a', env.projectDir);
      await removeFragment('myproject-a', 'testing.md');
      await compileToTarget('myproject-a', env.projectDir);
      const staleCopy = join(env.projectDir, '.agents', 'docs', 'testing.md');
      assert(!(await exists(staleCopy)));
    });
  } finally {
    await env.cleanup();
  }
});
