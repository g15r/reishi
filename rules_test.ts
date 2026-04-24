/**
 * Tests for rules.ts — add/list/remove/sync against isolated envs and local
 * + fixture-tarball fake-fetch sources.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { resetPathCache } from './paths.ts';
import { getRuleNames, listRules, syncRules } from './rules.ts';
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

