/**
 * Phase 14 — two-step compile (rules + docs).
 *   - `compileRules` writes a single source artifact (default <rules.source>/AGENTS.md).
 *   - `compileDocsToSource` writes the per-project index into source.
 *   - `syncRules` ships the compile artifact to opt-in agents.
 *   - `compileToTarget` (docs sync) writes via source then ships.
 *   - `resolveCompileTarget` rejects compile_file paths that escape compile_root.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import { parse as parseTOML, stringify as stringifyTOML } from '@std/toml';
import { resetPathCache } from './paths.ts';
import {
  compileRules,
  COMPILED_RULES_FILENAME,
  resolveCompileTarget,
  syncRules,
} from './rules.ts';
import { compileDocsToSource, compileToTarget } from './docs.ts';
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
  // Shallow merge with overlay-replace for nested tables in `patch`.
  const next = { ...current, ...patch };
  await Deno.writeTextFile(configPath, stringifyTOML(next));
}

// ---------------------------------------------------------------------------
// resolveCompileTarget — path-traversal validation (sy-R062)
// ---------------------------------------------------------------------------

Deno.test('resolveCompileTarget: defaults to compile_root/compile_file', () => {
  const dest = resolveCompileTarget('/tmp/agent', 'AGENTS.md');
  assertEquals(dest, '/tmp/agent/AGENTS.md');
});

Deno.test('resolveCompileTarget: subpaths are allowed', () => {
  const dest = resolveCompileTarget('/tmp/agent', 'sub/foo.md');
  assertEquals(dest, '/tmp/agent/sub/foo.md');
});

Deno.test('resolveCompileTarget: rejects .. escape', () => {
  let threw = false;
  try {
    resolveCompileTarget('/tmp/agent', '../escaped.md');
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), 'escapes compile_root');
  }
  assert(threw, 'expected throw on traversal');
});

Deno.test('resolveCompileTarget: rejects absolute path outside root', () => {
  let threw = false;
  try {
    resolveCompileTarget('/tmp/agent', '/etc/passwd');
  } catch {
    threw = true;
  }
  assert(threw);
});

// ---------------------------------------------------------------------------
// compileRules — concatenated source artifact (ru-R040)
// ---------------------------------------------------------------------------

Deno.test('compileRules: writes <rules.source>/AGENTS.md by default', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      const { rulesDir } = await seedSourceDir(env, {
        rules: { 'a.md': '# A\nbody-a\n', 'b.md': '# B\nbody-b\n' },
      });

      const result = await compileRules();
      assertEquals(result.outputPath, join(rulesDir, COMPILED_RULES_FILENAME));
      assertEquals(result.fragmentCount, 2);

      const text = await Deno.readTextFile(result.outputPath);
      assertStringIncludes(text, '# Agent rules');
      assertStringIncludes(text, '## a');
      assertStringIncludes(text, 'body-a');
      assertStringIncludes(text, '## b');
      assertStringIncludes(text, 'body-b');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileRules: excludes the artifact itself on re-run', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: { 'a.md': '# A\n' } });
      const first = await compileRules();
      assertEquals(first.fragmentCount, 1);

      const second = await compileRules();
      // Source artifact present from the first run must not double-count itself.
      assertEquals(second.fragmentCount, 1);
    });
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// compileDocsToSource — index lands in source (dc-R080)
// ---------------------------------------------------------------------------

Deno.test('compileDocsToSource: writes index into <docs.source>/<project>/', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { docs: { p: { 'one.md': '# One\nbody' } } });
      const projectDir = join(env.docsDir, 'p');

      const result = await compileDocsToSource('p');
      assertEquals(result.outputPath, join(projectDir, 'AGENTS.md'));
      assert(await exists(result.outputPath));
      const text = await Deno.readTextFile(result.outputPath);
      assertStringIncludes(text, 'one.md');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('compileDocsToSource: rejects unknown project', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await assertRejects(() => compileDocsToSource('absent'), Error, 'project not found');
    });
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// compileToTarget now ships from source (dc-R081)
// ---------------------------------------------------------------------------

Deno.test('compileToTarget: writes the index to source first, then ships', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { docs: { p: { 'one.md': '# One\n' } } });
      const projectDir = join(env.docsDir, 'p');
      const targetRoot = join(env.home, 'projects', 'sample');
      await Deno.mkdir(targetRoot, { recursive: true });

      const result = await compileToTarget('p', targetRoot);
      assertEquals(result.action, 'copied');
      // Source artifact created.
      assert(await exists(join(projectDir, 'AGENTS.md')));
      // Target shipped.
      assert(await exists(join(targetRoot, 'AGENTS.md')));
    });
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// syncRules with compile = true — ships compile artifact (sy-R060/sy-R063)
// ---------------------------------------------------------------------------

Deno.test('syncRules: compile=true ships <compile_root>/<compile_file>', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: { 'one.md': '# One\nbody-one\n' } });
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      await patchConfig(env.configPath, {
        agents: {
          claude: {
            skills: join(env.home, '.claude', 'skills'),
            rules: join(env.home, '.claude', 'rules'),
            compile: true,
            compile_root: join(env.home, '.claude'),
            compile_file: 'AGENTS.md',
          },
        },
      });
      resetPathCache();

      const results = await syncRules();
      const compileResult = results.find((r) => r.ruleName === '(compile)');
      assert(compileResult, 'expected a (compile) result');
      assertEquals(compileResult!.action, 'copied');
      assertEquals(compileResult!.targetPath, join(env.home, '.claude', 'AGENTS.md'));

      const text = await Deno.readTextFile(join(env.home, '.claude', 'AGENTS.md'));
      assertStringIncludes(text, 'body-one');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: compile=true rejects path-escaping compile_file', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: { 'one.md': '# One\n' } });
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      await patchConfig(env.configPath, {
        agents: {
          claude: {
            skills: join(env.home, '.claude', 'skills'),
            rules: join(env.home, '.claude', 'rules'),
            compile: true,
            compile_root: join(env.home, '.claude'),
            compile_file: '../escaped.md',
          },
        },
      });
      resetPathCache();

      const results = await syncRules();
      const compileResult = results.find((r) => r.ruleName === '(compile)');
      assertEquals(compileResult?.action, 'failed');
      assertStringIncludes(compileResult!.reason ?? '', 'escapes compile_root');
    });
  } finally {
    await env.cleanup();
  }
});

Deno.test('syncRules: compile=false (default) does not ship a compile artifact', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: { 'one.md': '# One\n' } });
      await Deno.mkdir(join(env.home, '.claude'), { recursive: true });
      const results = await syncRules();
      assert(!results.some((r) => r.ruleName === '(compile)'));
    });
  } finally {
    await env.cleanup();
  }
});
