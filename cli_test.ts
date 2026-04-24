/**
 * CLI plumbing tests — exercises help, version, init, validate, completions,
 * config, and unknown-command handling via `deno run reishi.ts`.
 *
 * These replace the old custom test-runner in test-reishi.ts with standard
 * Deno.test() calls.
 *
 * Run with: `deno task test:cli`
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { exists } from '@std/fs';
import { join } from '@std/path';

// ============================================================================
// Helpers
// ============================================================================

async function runrei(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scriptPath = new URL('./reishi.ts', import.meta.url).pathname;
  const cmd = new Deno.Command('deno', {
    args: [
      'run',
      '--allow-read',
      '--allow-write',
      '--allow-env=HOME,TMPDIR,EDITOR,REISHI_CONFIG',
      '--allow-net=platform.claude.com,code.claude.com',
      '--allow-run',
      scriptPath,
      ...args,
    ],
    cwd: opts.cwd,
    env: opts.env,
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

// ============================================================================
// Help & Version
// ============================================================================

Deno.test('cli: --help exits 0 and mentions rei', async () => {
  const r = await runrei(['--help']);
  assertEquals(r.code, 0, `stderr=${r.stderr}`);
  assertStringIncludes(r.stdout, 'rei');
});

Deno.test('cli: --version exits 0 and prints a version', async () => {
  const r = await runrei(['--version']);
  assertEquals(r.code, 0, `stderr=${r.stderr}`);
  assert(/\d+\.\d+\.\d+/.test(r.stdout), `no version in: ${r.stdout}`);
});

// ============================================================================
// Init
// ============================================================================

Deno.test('init: creates skill with all expected files', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    const r = await runrei(['init', 'test-skill', '--path', tmpDir]);
    assertEquals(r.code, 0, `init failed: ${r.stderr}`);

    const skillDir = join(tmpDir, 'test-skill');
    const checks = await Promise.all([
      exists(skillDir),
      exists(join(skillDir, 'SKILL.md')),
      exists(join(skillDir, 'scripts', 'example.ts')),
      exists(join(skillDir, 'example-reference.md')),
      exists(join(skillDir, 'assets', 'example_asset.txt')),
    ]);
    assert(checks.every(Boolean), `some files missing: ${checks}`);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('init: rejects invalid skill names', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    const invalid = ['Invalid-Name', '-invalid', 'invalid-', 'invalid--name'];
    for (const name of invalid) {
      const r = await runrei(['init', name, '--path', tmpDir]);
      assert(r.code !== 0, `should have rejected: ${name}`);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('init: prevents overwriting existing skill', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    await runrei(['init', 'existing', '--path', tmpDir]);
    const r = await runrei(['init', 'existing', '--path', tmpDir]);
    assert(r.code !== 0, 'should fail on overwrite');
    assertStringIncludes(r.stderr, 'already exists');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('init: generated SKILL.md has proper frontmatter format', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    await runrei(['init', 'fmt-skill', '--path', tmpDir]);
    const skillMd = await Deno.readTextFile(join(tmpDir, 'fmt-skill', 'SKILL.md'));

    assert(skillMd.startsWith('---'), 'should start with frontmatter delimiter');
    assertStringIncludes(skillMd, 'name: fmt-skill');
    assertStringIncludes(skillMd, 'description:');
    assert(skillMd.match(/---\n(.*?)\n---/s) !== null, 'should have frontmatter block');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('init: generated script is executable', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    await runrei(['init', 'exec-skill', '--path', tmpDir]);
    const stat = await Deno.stat(join(tmpDir, 'exec-skill', 'scripts', 'example.ts'));
    assert((stat.mode! & 0o111) !== 0, 'script should be executable');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('init: template interpolation creates correct names', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    await runrei(['init', 'my-tool', '--path', tmpDir]);
    const skillMd = await Deno.readTextFile(join(tmpDir, 'my-tool', 'SKILL.md'));
    const scriptTs = await Deno.readTextFile(
      join(tmpDir, 'my-tool', 'scripts', 'example.ts'),
    );

    assertStringIncludes(skillMd, 'name: my-tool');
    assertStringIncludes(scriptTs, 'My Tool'); // Title case
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('init: works from an unrelated CWD', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  const altCwd = await Deno.makeTempDir({ prefix: 'reishi-altcwd-' });
  try {
    const r = await runrei(['init', 'cwd-skill', '--path', tmpDir], { cwd: altCwd });
    assertEquals(r.code, 0, `init failed: ${r.stderr}`);
    assert(await exists(join(tmpDir, 'cwd-skill', 'SKILL.md')));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    await Deno.remove(altCwd, { recursive: true });
  }
});

// ============================================================================
// Validate
// ============================================================================

Deno.test('validate: accepts a valid skill', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    await runrei(['init', 'valid-skill', '--path', tmpDir]);
    const r = await runrei(['validate', join(tmpDir, 'valid-skill')]);
    assertEquals(r.code, 0, `validate failed: ${r.stderr}`);
    assertStringIncludes(r.stdout, '✅');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('validate: rejects skill without frontmatter', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    const dir = join(tmpDir, 'no-fm');
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, 'SKILL.md'), 'No frontmatter here!');

    const r = await runrei(['validate', dir]);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, 'frontmatter');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('validate: rejects missing required fields', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    const dir = join(tmpDir, 'no-name');
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, 'SKILL.md'),
      '---\ndescription: Missing name\n---\n# Skill\n',
    );

    const r = await runrei(['validate', dir]);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, 'name');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test('validate: rejects unexpected frontmatter keys', async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: 'reishi-cli-test-' });
  try {
    const dir = join(tmpDir, 'extra-keys');
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, 'SKILL.md'),
      '---\nname: extra-keys\ndescription: Test\nunexpected: value\n---\n# Skill\n',
    );

    const r = await runrei(['validate', dir]);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stdout, 'Unexpected');
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Unknown command
// ============================================================================

Deno.test('cli: unknown command fails with helpful message', async () => {
  const r = await runrei(['unknown-command']);
  // Cliffy exits with code 2 for unknown commands
  assertEquals(r.code, 2);
  assertStringIncludes(r.stderr, 'Unknown command');
});

// ============================================================================
// Completions
// ============================================================================

Deno.test('completions: fish outputs valid fish completion script', async () => {
  const r = await runrei(['completions', 'fish']);
  assertEquals(r.code, 0, `stderr=${r.stderr}`);
  assertStringIncludes(r.stdout, 'complete -c rei');
  // All subcommands present
  for (const cmd of ['init', 'validate', 'activate', 'deactivate', 'list', 'add', 'refresh-docs']) {
    assertStringIncludes(r.stdout, cmd);
  }
});

Deno.test('completions: fish writes nothing to stderr', async () => {
  const r = await runrei(['completions', 'fish']);
  assertEquals(r.code, 0);
  assertEquals(r.stderr, '');
});

Deno.test('completions: bash outputs bash completion script', async () => {
  const r = await runrei(['completions', 'bash']);
  assertEquals(r.code, 0, `stderr=${r.stderr}`);
  assertStringIncludes(r.stdout, 'rei');
  assertStringIncludes(r.stdout, 'complete');
});

Deno.test('completions: zsh outputs zsh completion script', async () => {
  const r = await runrei(['completions', 'zsh']);
  assertEquals(r.code, 0, `stderr=${r.stderr}`);
  assertStringIncludes(r.stdout, 'rei');
  assertStringIncludes(r.stdout, 'compdef');
});

Deno.test('completions: no shell arg shows help', async () => {
  const r = await runrei(['completions']);
  assertEquals(r.code, 0);
  assertStringIncludes(r.stdout, 'completions');
});

Deno.test('completions: invalid shell name fails', async () => {
  const r = await runrei(['completions', 'powershell']);
  assert(r.code !== 0, 'should fail for unsupported shell');
});

// ============================================================================
// Config
// ============================================================================

Deno.test('config: path prints path ending in config.toml', async () => {
  const configHome = await Deno.makeTempDir({ prefix: 'reishi-config-' });
  try {
    const configPath = join(configHome, 'config.toml');
    const r = await runrei(['config', 'path'], {
      env: { HOME: configHome, REISHI_CONFIG: configPath },
    });
    assertEquals(r.code, 0, `stderr=${r.stderr}`);
    const line = r.stdout.trim();
    assert(line.length > 0, 'should print a path');
    assert(line.endsWith('config.toml'), `expected config.toml, got: ${line}`);
  } finally {
    await Deno.remove(configHome, { recursive: true });
  }
});

Deno.test('config: init creates the config file', async () => {
  const configHome = await Deno.makeTempDir({ prefix: 'reishi-config-' });
  try {
    const configPath = join(configHome, 'config.toml');
    const r = await runrei(['config', 'init'], {
      env: { HOME: configHome, REISHI_CONFIG: configPath },
    });
    assertEquals(r.code, 0, `stderr=${r.stderr}`);
    assert(await exists(configPath), 'config file should exist');
  } finally {
    await Deno.remove(configHome, { recursive: true });
  }
});

Deno.test('config: show prints TOML with expected keys', async () => {
  const configHome = await Deno.makeTempDir({ prefix: 'reishi-config-' });
  try {
    const configPath = join(configHome, 'config.toml');
    await runrei(['config', 'init'], {
      env: { HOME: configHome, REISHI_CONFIG: configPath },
    });
    const r = await runrei(['config', 'show'], {
      env: { HOME: configHome, REISHI_CONFIG: configPath },
    });
    assertEquals(r.code, 0, `stderr=${r.stderr}`);
    assertStringIncludes(r.stdout, 'sync_method');
    assertStringIncludes(r.stdout, '[paths]');
    assertStringIncludes(r.stdout, '[updates]');
  } finally {
    await Deno.remove(configHome, { recursive: true });
  }
});

Deno.test('config: init is idempotent with friendly message', async () => {
  const configHome = await Deno.makeTempDir({ prefix: 'reishi-config-' });
  try {
    const configPath = join(configHome, 'config.toml');
    const env = { HOME: configHome, REISHI_CONFIG: configPath };
    await runrei(['config', 'init'], { env });
    const r = await runrei(['config', 'init'], { env });
    assertEquals(r.code, 0);
    assert(
      r.stdout.includes('already exists') || r.stdout.includes('already'),
      `expected friendly message, got: ${r.stdout}`,
    );
  } finally {
    await Deno.remove(configHome, { recursive: true });
  }
});
