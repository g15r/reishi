/**
 * Tests for rules.ts — add/list/remove/sync against isolated envs and local
 * + fixture-tarball fake-fetch sources.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { resetPathCache } from './paths.ts';
import {
  addRule,
  getRuleNames,
  listRules,
  removeRule,
  syncRules,
  validateRules,
} from './rules.ts';
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

async function patchConfig(
  configPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const raw = await Deno.readTextFile(configPath);
  const current = parseTOML(raw) as Record<string, unknown>;
  const next = { ...current, ...patch };
  await Deno.writeTextFile(configPath, stringifyTOML(next));
}

/** Build a fake fetch that serves text for any URL. */
function fakeFetchText(body: string): (url: string) => Promise<Response> {
  return async (_url: string) =>
    await new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    });
}

async function seedRulesSource(rulesDir: string): Promise<void> {
  await Deno.mkdir(rulesDir, { recursive: true });
  await Deno.writeTextFile(join(rulesDir, 'no-deletes.md'), '# No Deletes\n');
  await Deno.mkdir(join(rulesDir, 'security'), { recursive: true });
  await Deno.writeTextFile(
    join(rulesDir, 'security', 'policies.md'),
    '# Security\n',
  );
  // A dotfile that listRules must ignore.
  await Deno.writeTextFile(join(rulesDir, '.hidden'), 'ignored');
}

Deno.test('listRules: handles files, directories, ignores dotfiles', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);

      const rules = await listRules();
      assertEquals(rules.length, 2);
      const byName = new Map(rules.map((r) => [r.name, r.kind]));
      assertEquals(byName.get('no-deletes'), 'file');
      assertEquals(byName.get('security'), 'directory');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addRule: local file is copied into rules.source', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const src = fixturesPath('rules', 'no-deletes.md');
      const dest = await addRule(src);
      assert(await exists(dest));
      const rules = await listRules();
      assertEquals(rules.length, 1);
      assertEquals(rules[0].name, 'no-deletes');
      assertEquals(rules[0].kind, 'file');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addRule: local directory is copied recursively', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const src = fixturesPath('rules', 'security');
      await addRule(src);
      const rules = await listRules();
      assertEquals(rules.length, 1);
      assertEquals(rules[0].kind, 'directory');
      assertEquals(rules[0].name, 'security');
      assert(
        await exists(join(
          env.home,
          '.config',
          'reishi',
          'rules',
          'security',
          'policies.md',
        )),
      );
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addRule: from https URL with fake fetcher', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const body = '# Remote Rule\n\nFrom the wire.\n';
      const dest = await addRule('https://example.com/rules/my-rule.md', {
        fetcher: fakeFetchText(body),
      });
      assert(await exists(dest));
      const content = await Deno.readTextFile(dest);
      assertEquals(content, body);
      assertEquals((await listRules())[0].name, 'my-rule');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addRule: from URL without .md extension saves as .md', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const dest = await addRule('https://example.com/raw/rule-body', {
        fetcher: fakeFetchText('hi'),
      });
      assert(dest.endsWith('rule-body.md'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('addRule: GitHub tree URL pointing at a directory', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('rules-repo');
  try {
    await withEnv(env.env, async () => {
      const url = 'https://github.com/fakeorg/rules-repo/tree/main/security';
      const dest = await addRule(url, { fetcher: fakeFetchGithub(tarball) });
      assert(await exists(dest));
      const rules = await listRules();
      assertEquals(rules.length, 1);
      assertEquals(rules[0].kind, 'directory');
      assertEquals(rules[0].name, 'security');
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('addRule: GitHub tree URL pointing at a single file', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('rules-repo');
  try {
    await withEnv(env.env, async () => {
      const url = 'https://github.com/fakeorg/rules-repo/tree/main/top-level.md';
      const dest = await addRule(url, { fetcher: fakeFetchGithub(tarball) });
      assert(await exists(dest));
      assert(dest.endsWith('top-level.md'));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('addRule: refuses to overwrite without --force', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const src = fixturesPath('rules', 'no-deletes.md');
      await addRule(src);
      await assertRejects(
        () => addRule(src),
        Error,
        'already exists',
      );
      // --force overwrites successfully.
      await addRule(src, { force: true });
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeRule: removes from source and targets', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Pre-create target parent so sync writes into it.
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      const src = fixturesPath('rules', 'no-deletes.md');
      await addRule(src);
      await syncRules();

      const targetFile = join(env.home, '.claude', 'rules', 'no-deletes.md');
      assert(await exists(targetFile), 'expected target file after sync');

      await removeRule('no-deletes');
      assert(!(await exists(targetFile)));
      assertEquals((await listRules()).length, 0);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: copy mode creates independent files', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);

      const results = await syncRules();
      assert(results.length > 0);
      assert(results.every((r) => r.action === 'copied'));

      const targetFile = join(env.home, '.claude', 'rules', 'no-deletes.md');
      assert(await exists(targetFile));
      // Mutate target; source stays untouched.
      await Deno.writeTextFile(targetFile, 'mutated');
      const srcContent = await Deno.readTextFile(join(rulesDir, 'no-deletes.md'));
      assertEquals(srcContent, '# No Deletes\n');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: symlink mode links back to absolute source', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);
      await patchConfig(env.configPath, { sync_method: 'symlink' });
      resetPathCache();

      const results = await syncRules();
      assert(results.every((r) => r.action === 'symlinked'));

      const targetFile = join(env.home, '.claude', 'rules', 'no-deletes.md');
      const lst = await Deno.lstat(targetFile);
      assert(lst.isSymlink);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: rules.sync_method override wins over global', async () => {
  const env = await setupIsolatedEnv(); // global copy
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);
      await patchConfig(env.configPath, {
        rules: {
          source: rulesDir,
          sync_method: 'symlink',
          targets: { claude: join(env.home, '.claude', 'rules') },
        },
      });
      resetPathCache();

      const results = await syncRules();
      assert(results.every((r) => r.action === 'symlinked'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: CLI --method override beats rules.sync_method', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);
      await patchConfig(env.configPath, {
        rules: {
          source: rulesDir,
          sync_method: 'symlink',
          targets: { claude: join(env.home, '.claude', 'rules') },
        },
      });
      resetPathCache();

      const results = await syncRules({ method: 'copy' });
      assert(results.every((r) => r.action === 'copied'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: targets filter restricts to named targets', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      await Deno.mkdir(join(env.home, '.agents'), { recursive: true });
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);
      await patchConfig(env.configPath, {
        rules: {
          source: rulesDir,
          targets: {
            claude: join(env.home, '.claude', 'rules'),
            agents: join(env.home, '.agents', 'rules'),
          },
        },
      });
      resetPathCache();

      const results = await syncRules({ targets: ['claude'] });
      const targetNames = new Set(results.map((r) => r.target));
      assertEquals(targetNames, new Set(['claude']));
      assert(await exists(join(env.home, '.claude', 'rules', 'no-deletes.md')));
      assert(!(await exists(join(env.home, '.agents', 'rules'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: dry-run makes no writes', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);

      const results = await syncRules({ dryRun: true });
      assert(results.every((r) => r.reason === 'dry run'));
      assert(!(await exists(join(env.home, '.claude', 'rules'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: missing target parent warns and skips', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Do NOT create .claude/ — its parent is env.home (which exists) but
      // the target is .claude/rules, whose parent is .claude — missing.
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);

      const results = await syncRules();
      assert(results.every((r) => r.action === 'skipped'));
      assert(results[0].reason?.includes('parent dir missing'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('validateRules: clean fixture passes', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await Deno.mkdir(rulesDir, { recursive: true });
      await Deno.writeTextFile(
        join(rulesDir, 'rule.md'),
        '# OK\n\nExternal: [link](https://example.com)\n',
      );

      const result = await validateRules();
      assertEquals(result.valid, true);
      assertEquals(result.issues.length, 0);
      assertEquals(result.checked, 1);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('validateRules: passes the seeded fixture directory with a cross-file link', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Copy the repo fixture into the isolated rules source — security/policies.md
      // links to ../no-deletes.md which resolves inside rules.source.
      await addRule(fixturesPath('rules', 'no-deletes.md'));
      await addRule(fixturesPath('rules', 'security'));
      const result = await validateRules();
      assertEquals(result.valid, true, JSON.stringify(result.issues));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('validateRules: broken relative link is reported', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await Deno.mkdir(rulesDir, { recursive: true });
      await Deno.writeTextFile(
        join(rulesDir, 'rule.md'),
        '# Broken\n\n[missing](./nope.md)\n',
      );

      const result = await validateRules();
      assertEquals(result.valid, false);
      assertEquals(result.issues.length, 1);
      assert(result.issues[0].message.includes('broken relative link'));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('getRuleNames: returns basename list for tab completion', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const rulesDir = join(env.home, '.config', 'reishi', 'rules');
      await seedRulesSource(rulesDir);
      const names = await getRuleNames();
      assertEquals(names.sort(), ['no-deletes', 'security']);
    });
  } finally {
    await env.cleanup();
  }
});

