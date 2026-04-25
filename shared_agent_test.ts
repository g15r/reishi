/**
 * Tests for the built-in `shared` agent target.
 *
 * The `shared` agent is a non-configurable target that always points at
 * `~/.agents/`. Users opt in via `include_shared_agent = true` in the config.
 * `~/.agents/skills` and `~/.agents/rules` mirror the schema of any other
 * agent, but reishi synthesizes the entry — users cannot move or rename it.
 */

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { resetPathCache } from './paths.ts';
import { syncRules } from './rules.ts';
import { syncAll } from './sync.ts';
import { loadConfig } from './config.ts';
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

async function seedRule(rulesDir: string): Promise<void> {
  await Deno.mkdir(rulesDir, { recursive: true });
  await Deno.writeTextFile(join(rulesDir, 'always-on.md'), '# Always on\n');
}

async function seedSkill(sourceDir: string): Promise<void> {
  const skillDir = join(sourceDir, 'demo');
  await Deno.mkdir(skillDir, { recursive: true });
  await Deno.writeTextFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo\n---\n\n# Demo\n',
  );
}

Deno.test('shared agent: opted in via include_shared_agent=true syncs rules to ~/.agents/rules', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Pre-create ~/.agents so the parent-dir check in sync passes.
      await Deno.mkdir(join(env.home, '.agents'), { recursive: true });
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      await seedRule(join(env.home, '.config', 'reishi', 'rules'));

      await patchConfig(env.configPath, { include_shared_agent: true });
      resetPathCache();

      const results = await syncRules();
      const targetNames = new Set(results.map((r) => r.target));
      assert(
        targetNames.has('shared'),
        `expected 'shared' in ${[...targetNames]}`,
      );
      assert(
        await exists(join(env.home, '.agents', 'rules', 'always-on.md')),
        'rule should land at ~/.agents/rules/',
      );
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('shared agent: not opted in (default) skips ~/.agents/', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      await seedRule(join(env.home, '.config', 'reishi', 'rules'));
      // No include_shared_agent in config.

      const results = await syncRules();
      const targetNames = new Set(results.map((r) => r.target));
      assert(
        !targetNames.has('shared'),
        `expected no 'shared' target; got ${[...targetNames]}`,
      );
      assert(
        !(await exists(join(env.home, '.agents', 'rules'))),
        '~/.agents/rules should not be created when shared is opted out',
      );
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('shared agent: skills sync also lands in ~/.agents/skills when opted in', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.agents'), { recursive: true });
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      await seedSkill(env.sourceDir);
      await patchConfig(env.configPath, { include_shared_agent: true });
      resetPathCache();

      const results = await syncAll();
      const sharedHits = results.filter((r) => r.target === 'shared');
      assert(
        sharedHits.length > 0,
        `expected at least one shared sync result; got ${
          results.map((r) => r.target).join(', ')
        }`,
      );
      assert(await exists(join(env.home, '.agents', 'skills', 'demo', 'SKILL.md')));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('shared agent: --agents=shared filter targets only the shared agent', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.agents'), { recursive: true });
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      await seedRule(join(env.home, '.config', 'reishi', 'rules'));
      await patchConfig(env.configPath, { include_shared_agent: true });
      resetPathCache();

      const results = await syncRules({ agents: ['shared'] });
      const targetNames = new Set(results.map((r) => r.target));
      assertEquals(targetNames, new Set(['shared']));
      assert(await exists(join(env.home, '.agents', 'rules', 'always-on.md')));
      assert(
        !(await exists(join(env.home, '.claude', 'rules', 'always-on.md'))),
        'claude target should not be written when filtering to shared',
      );
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('shared agent: user-defined [agents.shared] in config is ignored — built-in path wins', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await Deno.mkdir(join(env.home, '.agents'), { recursive: true });
      await Deno.mkdir(join(env.home, 'somewhere-else'), { recursive: true });
      await seedRule(join(env.home, '.config', 'reishi', 'rules'));

      // Try to redirect 'shared' away from ~/.agents — reishi must ignore
      // user-defined config for the reserved name.
      await patchConfig(env.configPath, {
        include_shared_agent: true,
        agents: {
          claude: {
            skills: join(env.home, '.claude', 'skills'),
            rules: join(env.home, '.claude', 'rules'),
          },
          shared: {
            skills: join(env.home, 'somewhere-else', 'skills'),
            rules: join(env.home, 'somewhere-else', 'rules'),
          },
        },
      });
      resetPathCache();

      const results = await syncRules({ agents: ['shared'] });
      assert(results.every((r) => r.action !== 'failed'), 'sync should not fail');
      assert(
        await exists(join(env.home, '.agents', 'rules', 'always-on.md')),
        'shared must land in ~/.agents/, not the user-defined override',
      );
      assert(
        !(await exists(join(env.home, 'somewhere-else', 'rules', 'always-on.md'))),
        'user override path must not receive the rule',
      );
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('shared agent: include_shared_agent default is undefined/false in defaults', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const cfg = await loadConfig();
      // The default behaviour is opt-in; an unset value must not enable shared.
      const flag = (cfg as unknown as { include_shared_agent?: boolean }).include_shared_agent;
      assert(
        flag === undefined || flag === false,
        `expected shared opt-in to default off; got ${flag}`,
      );
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('config init: starter template sets include_shared_agent = true', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Remove the test-helper's pre-written config so initConfig runs fresh.
      await Deno.remove(env.configPath);
      const { initConfig } = await import('./config.ts');
      await initConfig();

      const raw = await Deno.readTextFile(env.configPath);
      assert(
        /include_shared_agent\s*=\s*true/.test(raw),
        `expected starter template to include 'include_shared_agent = true'; got:\n${raw}`,
      );
    });
  } finally {
    await env.cleanup();
  }
});
