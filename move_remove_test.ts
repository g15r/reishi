/**
 * Phase 13 — source-side CRUD: `move`/`remove` for skills, rules, docs.
 * All ops are source-only; target cleanup is Phase 15's job (clean_on_sync).
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { resetPathCache } from './paths.ts';
import { loadConfig, loadLockfile, saveConfig, saveLockfile } from './config.ts';
import { moveSkill, removeSkill } from './sync.ts';
import { moveRule, removeRule, stripMdSuffix } from './rules.ts';
import { moveDoc, removeDoc } from './docs.ts';
import { seedSourceDir, setupIsolatedEnv } from './test-helpers.ts';

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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

Deno.test('stripMdSuffix: strips trailing .md, leaves bare names alone', () => {
  assertEquals(stripMdSuffix('foo.md'), 'foo');
  assertEquals(stripMdSuffix('foo'), 'foo');
  assertEquals(stripMdSuffix('foo.bar.md'), 'foo.bar');
  assertEquals(stripMdSuffix(''), '');
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

Deno.test('moveRule: renames .md file in source', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const { rulesDir } = await seedSourceDir(env, { rules: { 'old.md': '# old\n' } });

      const result = await moveRule('old', 'new');
      assertEquals(result.fromPath, join(rulesDir, 'old.md'));
      assertEquals(result.toPath, join(rulesDir, 'new.md'));
      assert(!(await exists(join(rulesDir, 'old.md'))));
      assert(await exists(join(rulesDir, 'new.md')));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveRule: accepts .md suffix on either argument', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const { rulesDir } = await seedSourceDir(env, { rules: { 'foo.md': 'x' } });

      await moveRule('foo.md', 'bar.md');
      assert(await exists(join(rulesDir, 'bar.md')));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveRule: refuses missing source', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: {} });
      await assertRejects(() => moveRule('absent', 'new'), Error, 'rule not found');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveRule: refuses to overwrite existing destination', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: { 'a.md': 'a', 'b.md': 'b' } });
      await assertRejects(() => moveRule('a', 'b'), Error, 'destination already exists');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeRule: deletes source .md', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const { rulesDir } = await seedSourceDir(env, { rules: { 'gone.md': 'x' } });

      const result = await removeRule('gone.md');
      assertEquals(result.removedPath, join(rulesDir, 'gone.md'));
      assert(!(await exists(join(rulesDir, 'gone.md'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeRule: refuses missing source', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: {} });
      await assertRejects(() => removeRule('absent'), Error, 'rule not found');
    });
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Docs (doc-level)
// ---------------------------------------------------------------------------

Deno.test('moveDoc: renames file under project dir', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { docs: { p: { 'old.md': '# old' } } });
      const projDir = join(env.docsDir, 'p');

      const result = await moveDoc('p', 'old', 'new');
      assertEquals(result.toPath, join(projDir, 'new.md'));
      assert(!(await exists(join(projDir, 'old.md'))));
      assert(await exists(join(projDir, 'new.md')));
      assertEquals(result.rewroteFilesArray, false);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveDoc: rewrites [projects.*].files when present', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { docs: { p: { 'old.md': 'x', 'keep.md': 'y' } } });
      await patchConfig(env.configPath, {
        projects: {
          p: { path: '~/code/p', files: ['old.md', 'keep.md'] },
        },
      });

      const result = await moveDoc('p', 'old', 'new');
      assertEquals(result.rewroteFilesArray, true);
      const cfg = await loadConfig();
      assertEquals(cfg.projects?.p?.files, ['new.md', 'keep.md']);
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveDoc: missing project errors', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await assertRejects(
        () => moveDoc('nope', 'a', 'b'),
        Error,
        'docs project not found',
      );
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeDoc: deletes file and prunes files array', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { docs: { p: { 'gone.md': 'x' } } });
      const projDir = join(env.docsDir, 'p');
      await Deno.writeTextFile(join(projDir, 'keep.md'), 'y');
      await patchConfig(env.configPath, {
        projects: {
          p: { path: '~/code/p', files: ['gone.md', 'keep.md'] },
        },
      });

      const result = await removeDoc('p', 'gone');
      assertEquals(result.rewroteFilesArray, true);
      assert(!(await exists(join(projDir, 'gone.md'))));
      const cfg = await loadConfig();
      assertEquals(cfg.projects?.p?.files, ['keep.md']);
    });
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

async function seedSkill(
  env: Awaited<ReturnType<typeof setupIsolatedEnv>>,
  name: string,
): Promise<void> {
  await seedSourceDir(env, {
    skills: { [name]: { 'SKILL.md': `---\nname: ${name}\ndescription: x\n---\n` } },
  });
}

Deno.test('moveSkill: renames source dir', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env, 'foo');
      const result = await moveSkill('foo', 'bar');
      assertEquals(result.fromPath, join(env.sourceDir, 'foo'));
      assertEquals(result.toPath, join(env.sourceDir, 'bar'));
      assert(!(await exists(join(env.sourceDir, 'foo'))));
      assert(await exists(join(env.sourceDir, 'bar', 'SKILL.md')));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveSkill: rekeys lockfile entry', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env, 'foo');
      await saveLockfile({
        skills: {
          foo: {
            source_url: 'https://github.com/u/r',
            subpath: 'skills/foo',
            ref: 'main',
            synced_at: '2026-01-01T00:00:00Z',
          },
        },
      });

      const result = await moveSkill('foo', 'bar');
      assertEquals(result.rekeyedLockfile, true);
      const lock = await loadLockfile();
      assert(!('foo' in lock.skills));
      assert('bar' in lock.skills);
      assertEquals(lock.skills.bar.subpath, 'skills/foo');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveSkill: rekeys [skill_overrides.<name>] when present', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env, 'foo');
      const cfg = await loadConfig();
      cfg.skill_overrides = { foo: { sync_method: 'symlink' } };
      await saveConfig(cfg);

      const result = await moveSkill('foo', 'bar');
      assertEquals(result.rekeyedSkillOverrides, true);
      const next = await loadConfig();
      assert(!('foo' in (next.skill_overrides ?? {})));
      assertEquals(next.skill_overrides?.bar?.sync_method, 'symlink');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('moveSkill: refuses missing source and existing destination', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await assertRejects(() => moveSkill('absent', 'new'), Error, 'skill not found');
      await seedSkill(env, 'a');
      await seedSkill(env, 'b');
      await assertRejects(() => moveSkill('a', 'b'), Error, 'destination already exists');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeSkill: deletes source dir, lockfile entry, skill_overrides', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env, 'foo');
      await saveLockfile({
        skills: {
          foo: {
            source_url: 'https://github.com/u/r',
            subpath: 'skills/foo',
            ref: 'main',
            synced_at: '2026-01-01T00:00:00Z',
          },
        },
      });
      const cfg = await loadConfig();
      cfg.skill_overrides = { foo: { agents: ['claude'] } };
      await saveConfig(cfg);

      const result = await removeSkill('foo');
      assertEquals(result.removedFromLockfile, true);
      assertEquals(result.removedFromSkillOverrides, true);
      assert(!(await exists(join(env.sourceDir, 'foo'))));
      const lock = await loadLockfile();
      assert(!('foo' in lock.skills));
      const next = await loadConfig();
      assert(!('foo' in (next.skill_overrides ?? {})));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeSkill: untracked skill removes only the dir', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSkill(env, 'foo');
      const result = await removeSkill('foo');
      assertEquals(result.removedFromLockfile, false);
      assertEquals(result.removedFromSkillOverrides, false);
      assert(!(await exists(join(env.sourceDir, 'foo'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('removeSkill: refuses missing source', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await assertRejects(() => removeSkill('absent'), Error, 'skill not found');
    });
  } finally {
    await env.cleanup();
  }
});
