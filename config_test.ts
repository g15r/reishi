/**
 * Unit tests for config.ts
 *
 * Run: deno task test:unit
 *
 * Uses REISHI_CONFIG to redirect to a tempdir per test so we never touch
 * the user's real config.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { exists } from '@std/fs';
import {
  defaultConfig,
  expandHome,
  getConfigPath,
  initConfig,
  loadConfig,
  saveConfig,
} from './config.ts';

async function withTempConfig(
  fn: (ctx: { tmp: string; configPath: string }) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: 'reishi-config-test-' });
  const configPath = join(tmp, 'config.toml');
  const prevConfig = Deno.env.get('REISHI_CONFIG');
  const prevHome = Deno.env.get('HOME');
  Deno.env.set('REISHI_CONFIG', configPath);
  // Point HOME into the tempdir so ~-expansion writes into isolated dirs.
  Deno.env.set('HOME', tmp);
  try {
    await fn({ tmp, configPath });
  } finally {
    if (prevConfig === undefined) Deno.env.delete('REISHI_CONFIG');
    else Deno.env.set('REISHI_CONFIG', prevConfig);
    if (prevHome === undefined) Deno.env.delete('HOME');
    else Deno.env.set('HOME', prevHome);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test('expandHome expands ~ to home dir', () => {
  const prev = Deno.env.get('HOME');
  Deno.env.set('HOME', '/tmp/fake-home');
  try {
    assertEquals(expandHome('~'), '/tmp/fake-home');
    assertEquals(expandHome('~/foo/bar'), '/tmp/fake-home/foo/bar');
    assertEquals(expandHome('/absolute/path'), '/absolute/path');
    assertEquals(expandHome('relative/path'), 'relative/path');
  } finally {
    if (prev === undefined) Deno.env.delete('HOME');
    else Deno.env.set('HOME', prev);
  }
});

Deno.test('getConfigPath honors REISHI_CONFIG override', () => {
  const prev = Deno.env.get('REISHI_CONFIG');
  Deno.env.set('REISHI_CONFIG', '/tmp/custom/config.toml');
  try {
    assertEquals(getConfigPath(), '/tmp/custom/config.toml');
  } finally {
    if (prev === undefined) Deno.env.delete('REISHI_CONFIG');
    else Deno.env.set('REISHI_CONFIG', prev);
  }
});

Deno.test('loadConfig returns defaults when file missing', async () => {
  await withTempConfig(async () => {
    const cfg = await loadConfig();
    assertEquals(cfg, defaultConfig());
  });
});

Deno.test('loadConfig merges partial config over defaults', async () => {
  await withTempConfig(async ({ configPath }) => {
    await Deno.writeTextFile(
      configPath,
      `sync_method = "symlink"\n\n[updates]\ninterval_hours = 6\n`,
    );
    const cfg = await loadConfig();
    assertEquals(cfg.sync_method, 'symlink');
    assertEquals(cfg.updates.interval_hours, 6);
    // Other fields stay at defaults
    assertEquals(cfg.updates.enabled, true);
    assertEquals(cfg.default_prefix, 'infer');
    assertEquals(cfg.prefix_separator, '_');
    assertEquals(cfg.paths.source, '~/.config/reishi/skills');
    assertEquals(cfg.paths.targets.claude, '~/.claude/skills');
  });
});

Deno.test('loadConfig throws clear error on invalid TOML', async () => {
  await withTempConfig(async ({ configPath }) => {
    await Deno.writeTextFile(configPath, 'this is = = not valid toml [[[');
    await assertRejects(
      () => loadConfig(),
      Error,
      'Invalid TOML',
    );
  });
});

Deno.test('saveConfig then loadConfig round-trips fidelity', async () => {
  await withTempConfig(async () => {
    const cfg = defaultConfig();
    cfg.sync_method = 'symlink';
    cfg.updates.interval_hours = 12;
    cfg.paths.targets = { claude: '~/.claude/skills', agents: '~/.agents/skills' };
    await saveConfig(cfg);
    const loaded = await loadConfig();
    assertEquals(loaded.sync_method, 'symlink');
    assertEquals(loaded.updates.interval_hours, 12);
    assertEquals(loaded.paths.targets.claude, '~/.claude/skills');
    assertEquals(loaded.paths.targets.agents, '~/.agents/skills');
  });
});

Deno.test('initConfig creates config file and directories', async () => {
  await withTempConfig(async ({ tmp, configPath }) => {
    const result = await initConfig();
    assertEquals(result.alreadyExisted, false);
    assertEquals(result.configPath, configPath);
    assert(await exists(configPath), 'config file should exist');
    // Starter template keeps its helpful comments.
    const contents = await Deno.readTextFile(configPath);
    assertStringIncludes(contents, 'sync_method = "copy"');
    assertStringIncludes(contents, '[paths]');
    // Source directories created at HOME-relative paths.
    assert(await exists(join(tmp, '.config/reishi/skills')), 'skills dir should exist');
    assert(await exists(join(tmp, '.config/reishi/rules')), 'rules dir should exist');
    assert(await exists(join(tmp, '.config/reishi/docs')), 'docs dir should exist');
    assertEquals(result.createdDirs.length, 3);
  });
});

Deno.test('initConfig does not overwrite existing config', async () => {
  await withTempConfig(async ({ configPath }) => {
    await Deno.mkdir(join(configPath, '..'), { recursive: true });
    const existing = '# pre-existing config\nsync_method = "symlink"\n';
    await Deno.writeTextFile(configPath, existing);
    const result = await initConfig();
    assertEquals(result.alreadyExisted, true);
    const contents = await Deno.readTextFile(configPath);
    assertEquals(contents, existing);
  });
});
