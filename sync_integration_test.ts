/**
 * Integration tests for sync wired into add/activate/deactivate/init.
 *
 * These exercise the top-level command functions with isolated configs and
 * pre-created target parent dirs so sync actually runs end-to-end.
 */

import { assert, assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';
import { exists } from '@std/fs';
import { addSkill } from './reishi.ts';
import { resetPathCache } from './paths.ts';
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

/** Pre-create every target's parent dir so sync isn't skipped. */
async function ensureTargetParents(home: string): Promise<string> {
  const claudeTargetParent = join(home, '.claude');
  await Deno.mkdir(claudeTargetParent, { recursive: true });
  return join(claudeTargetParent, 'skills');
}

Deno.test('add: installs to source AND syncs to target', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      const claudeTarget = await ensureTargetParents(env.home);
      const url = 'https://github.com/fakeuser/single-skill-repo/tree/main';
      const ok = await addSkill(url, env.sourceDir, {
        fetcher: fakeFetchGithub(tarball),
      });
      assertEquals(ok, true);

      // Present in source of truth.
      assert(await exists(join(env.sourceDir, 'single-skill-repo', 'SKILL.md')));
      // AND present in the target.
      assert(
        await exists(join(claudeTarget, 'single-skill-repo', 'SKILL.md')),
        'skill missing from claude target',
      );
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('add: --path outside source does NOT trigger sync', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      const claudeTarget = await ensureTargetParents(env.home);
      const elsewhere = await Deno.makeTempDir({ prefix: 'reishi-elsewhere-' });
      try {
        const url = 'https://github.com/fakeuser/single-skill-repo/tree/main';
        const ok = await addSkill(url, elsewhere, {
          fetcher: fakeFetchGithub(tarball),
        });
        assertEquals(ok, true);
        // Installed to the custom path.
        assert(await exists(join(elsewhere, 'single-skill-repo', 'SKILL.md')));
        // NOT synced to the target because the install didn't land in source.
        assert(
          !(await exists(join(claudeTarget, 'single-skill-repo'))),
          'unexpected sync to target when --path was outside source',
        );
      } finally {
        await Deno.remove(elsewhere, { recursive: true });
      }
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('add: silently skips sync when target parent is missing', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('single-skill-repo');
  try {
    await withEnv(env.env, async () => {
      // No ensureTargetParents call — target parent doesn't exist.
      const url = 'https://github.com/fakeuser/single-skill-repo/tree/main';
      const ok = await addSkill(url, env.sourceDir, {
        fetcher: fakeFetchGithub(tarball),
      });
      assertEquals(ok, true);
      assert(await exists(join(env.sourceDir, 'single-skill-repo', 'SKILL.md')));
      // Sync was skipped — target did not get the skill.
      assert(!(await exists(join(env.home, '.claude', 'skills', 'single-skill-repo'))));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

Deno.test('add (multi-skill): every installed skill lands in target', async () => {
  const env = await setupIsolatedEnv();
  const tarball = await makeFixtureTarball('multi-skill-repo');
  try {
    await withEnv(env.env, async () => {
      const claudeTarget = await ensureTargetParents(env.home);
      const url = 'https://github.com/fakeorg/multi-skill-repo/tree/main/skills';
      const ok = await addSkill(url, env.sourceDir, {
        fetcher: fakeFetchGithub(tarball),
      });
      assertEquals(ok, true);

      assert(await exists(join(claudeTarget, 'book-review', 'SKILL.md')));
      assert(await exists(join(claudeTarget, 'readwise-cli', 'SKILL.md')));
    });
  } finally {
    try {
      await Deno.remove(tarball);
    } catch { /* ignore */ }
    await env.cleanup();
  }
});

// The activate/deactivate flow is driven by `move` against the real source
// dirs, so we exercise it via the CLI at the compiled-binary level in the
// end-to-end harness. Here we verify the sync-wire helpers directly.

Deno.test('deactivate flow: unsyncSkill removes from target', async () => {
  // This test simulates: add → deactivate (move to _deactivated) → unsyncSkill.
  const { syncSkill, unsyncSkill } = await import('./sync.ts');
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const claudeTarget = await ensureTargetParents(env.home);
      // Seed a skill and sync it.
      const skillDir = join(env.sourceDir, 'alpha');
      await Deno.mkdir(join(skillDir, 'scripts'), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: alpha\ndescription: test\n---\n',
      );
      await syncSkill('alpha');
      assert(await exists(join(claudeTarget, 'alpha')));

      // Deactivate: the CLI would `move` to _deactivated, but the relevant
      // sync-level operation is unsyncSkill.
      const results = await unsyncSkill('alpha');
      assertEquals(results.length, 1);
      assertEquals(results[0].reason, 'removed');
      assert(!(await exists(join(claudeTarget, 'alpha'))));
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('activate flow: syncSkill re-adds to target after reactivation', async () => {
  const { syncSkill, unsyncSkill } = await import('./sync.ts');
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const claudeTarget = await ensureTargetParents(env.home);
      const skillDir = join(env.sourceDir, 'alpha');
      await Deno.mkdir(join(skillDir, 'scripts'), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: alpha\ndescription: test\n---\n',
      );
      await syncSkill('alpha');
      await unsyncSkill('alpha');
      assert(!(await exists(join(claudeTarget, 'alpha'))));

      // Activate: skill returns to source (simulated — it never left), then sync.
      const results = await syncSkill('alpha');
      assertEquals(results[0].action, 'copied');
      assert(await exists(join(claudeTarget, 'alpha', 'SKILL.md')));
    });
  } finally {
    await env.cleanup();
  }
});

/**
 * Invoke the CLI via `deno run reishi.ts` with env overrides. The integration
 * tests above drive exported functions directly; these exercise CLI flag
 * wiring end-to-end.
 */
async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scriptPath = new URL('./reishi.ts', import.meta.url).pathname;
  // Inherit PATH + DENO_DIR so the subprocess can find `deno` and reuse caches.
  const childEnv: Record<string, string> = { ...env };
  for (const key of ['PATH', 'DENO_DIR', 'XDG_CACHE_HOME', 'USER']) {
    const v = Deno.env.get(key);
    if (v !== undefined) childEnv[key] = v;
  }
  const cmd = new Deno.Command('deno', {
    args: [
      'run',
      '--allow-read',
      '--allow-write',
      '--allow-env=HOME,TMPDIR,EDITOR,REISHI_CONFIG,REISHI_LOCKFILE',
      '--allow-net',
      '--allow-run',
      scriptPath,
      ...args,
    ],
    env: childEnv,
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function seedSkillAndRule(env: Awaited<ReturnType<typeof setupIsolatedEnv>>): Promise<void> {
  await ensureTargetParents(env.home);
  // Skill
  const skillDir = join(env.sourceDir, 'alpha');
  await Deno.mkdir(join(skillDir, 'scripts'), { recursive: true });
  await Deno.writeTextFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: alpha\ndescription: test\n---\n',
  );
  // Rule
  const rulesDir = join(env.home, '.config', 'reishi', 'rules');
  await Deno.mkdir(rulesDir, { recursive: true });
  await Deno.writeTextFile(join(rulesDir, 'no-deletes.md'), '# No Deletes\n');
}

Deno.test('rei sync (no args): syncs both skills and rules', async () => {
  const env = await setupIsolatedEnv();
  try {
    await seedSkillAndRule(env);
    const { code, stdout, stderr } = await runCli(['sync', '--no-fetch'], env.env);
    assertEquals(code, 0, `stderr: ${stderr}`);
    assert(
      stdout.includes('skill') && stdout.includes('rule'),
      `expected unified summary to mention skills and rules: ${stdout}`,
    );
    assert(await exists(join(env.home, '.claude', 'skills', 'alpha', 'SKILL.md')));
    assert(await exists(join(env.home, '.claude', 'rules', 'no-deletes.md')));
  } finally {
    await env.cleanup();
  }
});

Deno.test('rei sync --skills-only: rules are untouched', async () => {
  const env = await setupIsolatedEnv();
  try {
    await seedSkillAndRule(env);
    const { code, stderr } = await runCli(['sync', '--skills-only', '--no-fetch'], env.env);
    assertEquals(code, 0, `stderr: ${stderr}`);
    assert(await exists(join(env.home, '.claude', 'skills', 'alpha')));
    assert(!(await exists(join(env.home, '.claude', 'rules'))));
  } finally {
    await env.cleanup();
  }
});

Deno.test('rei sync --rules-only: skills are untouched', async () => {
  const env = await setupIsolatedEnv();
  try {
    await seedSkillAndRule(env);
    const { code, stderr } = await runCli(['sync', '--rules-only'], env.env);
    assertEquals(code, 0, `stderr: ${stderr}`);
    assert(!(await exists(join(env.home, '.claude', 'skills', 'alpha'))));
    assert(await exists(join(env.home, '.claude', 'rules', 'no-deletes.md')));
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncAll + syncRules: both content types land at their respective targets', async () => {
  const { syncAll } = await import('./sync.ts');
  const { addRule, syncRules } = await import('./rules.ts');
  const { fixturesPath } = await import('./test-helpers.ts');
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      // Skills target parent
      await ensureTargetParents(env.home);
      // Rules target parent — config's default puts it at <home>/.claude/rules
      // so .claude already exists from ensureTargetParents.

      // Seed a skill directly.
      const skillDir = join(env.sourceDir, 'alpha');
      await Deno.mkdir(join(skillDir, 'scripts'), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: alpha\ndescription: test\n---\n',
      );

      // Seed a rule from the repo fixtures.
      await addRule(fixturesPath('rules', 'no-deletes.md'));

      const skillResults = await syncAll();
      const ruleResults = await syncRules();

      assert(skillResults.some((r) => r.action === 'copied'));
      assert(ruleResults.some((r) => r.action === 'copied'));
      assert(await exists(join(env.home, '.claude', 'skills', 'alpha', 'SKILL.md')));
      assert(await exists(join(env.home, '.claude', 'rules', 'no-deletes.md')));
    });
  } finally {
    await env.cleanup();
  }
});

// Avoid unused-import warning for dirname.
void dirname;
