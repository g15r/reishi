/**
 * Smoke tests for the compiled `bin/rei` binary.
 *
 * These exercise the *compiled* artifact (not `deno run`), so they verify
 * the two things that can only break at compile time:
 *
 *   1. `--include assets/` actually embeds the templates in the binary
 *   2. The asset path resolves correctly when CWD is not the project root
 *      (see reishi.ts: TEMPLATE_DIR uses `import.meta.dirname`)
 *
 * Run with: `deno task test:compile`
 *
 * These tests shell out to `deno task compile` once on setup (~10–30s the
 * first time, near-instant on subsequent runs if bin/rei is already built
 * and newer than reishi.ts).
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { exists } from '@std/fs';
import { dirname, fromFileUrl, join, resolve } from '@std/path';

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)));
const BIN_PATH = join(REPO_ROOT, 'bin', 'rei');
const REISHI_TS = join(REPO_ROOT, 'reishi.ts');

/** Build bin/rei if it doesn't exist, or if reishi.ts is newer than it. */
async function ensureCompiled(): Promise<void> {
  let needsBuild = true;
  if (await exists(BIN_PATH)) {
    try {
      const [binStat, srcStat] = await Promise.all([
        Deno.stat(BIN_PATH),
        Deno.stat(REISHI_TS),
      ]);
      if (binStat.mtime && srcStat.mtime && binStat.mtime >= srcStat.mtime) {
        needsBuild = false;
      }
    } catch {
      needsBuild = true;
    }
  }

  if (!needsBuild) return;

  console.log('Building bin/rei via `deno task compile`...');
  const compile = new Deno.Command('deno', {
    args: ['task', 'compile'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const { success } = await compile.output();
  if (!success) throw new Error('deno task compile failed');
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the compiled binary with optional CWD. */
async function runBin(args: string[], cwd?: string): Promise<RunResult> {
  const cmd = new Deno.Command(BIN_PATH, {
    args,
    cwd,
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

// One-shot setup — Deno runs tests sequentially within a file by default, so
// this is fine as a top-level await; all tests below depend on it.
await ensureCompiled();

Deno.test('compiled: --help exits 0 and mentions rei', async () => {
  const r = await runBin(['--help']);
  assertEquals(r.code, 0, `stderr=${r.stderr}`);
  assertStringIncludes(r.stdout, 'rei');
});

Deno.test('compiled: --version exits 0 and prints a version', async () => {
  const r = await runBin(['--version']);
  assertEquals(r.code, 0, `stderr=${r.stderr}`);
  // The CLI is currently pinned at 0.1.0; assert on the leading digit so
  // this test survives a bump without immediately going red.
  assert(/\d+\.\d+\.\d+/.test(r.stdout), `no version in: ${r.stdout}`);
});

Deno.test(
  'compiled: init uses embedded templates (critical: --include + asset-path fix)',
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-compile-init-' });
    const altCwd = await Deno.makeTempDir({ prefix: 'reishi-compile-cwd-' });
    try {
      // Run from an unrelated CWD to prove the embedded templates are
      // resolved from the binary, not from wherever the user happens to be.
      const r = await runBin(
        ['init', 'smoke-skill', '--path', tmpDir],
        altCwd,
      );
      assertEquals(r.code, 0, `init failed: ${r.stderr}`);

      const skillDir = join(tmpDir, 'smoke-skill');
      assert(await exists(join(skillDir, 'SKILL.md')), 'SKILL.md missing');
      assert(
        await exists(join(skillDir, 'scripts', 'example.ts')),
        'scripts/example.ts missing',
      );
      assert(
        await exists(join(skillDir, 'example-reference.md')),
        'example-reference.md missing',
      );
      assert(
        await exists(join(skillDir, 'assets', 'example_asset.txt')),
        'assets/example_asset.txt missing',
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
      await Deno.remove(altCwd, { recursive: true });
    }
  },
);

Deno.test('compiled: validate accepts a freshly-initialized skill', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-compile-validate-' });
  try {
    const init = await runBin(['init', 'smoke-validate', '--path', tmpDir]);
    assertEquals(init.code, 0, `init failed: ${init.stderr}`);

    const skillDir = join(tmpDir, 'smoke-validate');
    const validate = await runBin(['validate', skillDir]);
    assertEquals(
      validate.code,
      0,
      `validate failed (stdout=${validate.stdout}, stderr=${validate.stderr})`,
    );
    assertStringIncludes(validate.stdout, 'valid');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
