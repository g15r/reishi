/**
 * Tests for paths.ts — the source-of-truth resolver.
 */

import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { stringify as stringifyTOML } from '@std/toml';
import { getDeactivatedDir, getSourceDir, resetPathCache } from './paths.ts';

async function withConfig(
  configBody: Record<string, unknown>,
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: 'reishi-paths-test-' });
  const configPath = join(home, 'config.toml');
  await Deno.writeTextFile(configPath, stringifyTOML(configBody));
  const prevHome = Deno.env.get('HOME');
  const prevConfig = Deno.env.get('REISHI_CONFIG');
  Deno.env.set('HOME', home);
  Deno.env.set('REISHI_CONFIG', configPath);
  resetPathCache();
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) Deno.env.delete('HOME');
    else Deno.env.set('HOME', prevHome);
    if (prevConfig === undefined) Deno.env.delete('REISHI_CONFIG');
    else Deno.env.set('REISHI_CONFIG', prevConfig);
    resetPathCache();
    try {
      await Deno.remove(home, { recursive: true });
    } catch { /* ignore */ }
  }
}

Deno.test('getSourceDir returns the path from REISHI_CONFIG-overridden config', async () => {
  await withConfig(
    {
      paths: { source: '/tmp/custom-reishi-source', targets: {} },
    },
    async () => {
      assertEquals(await getSourceDir(), '/tmp/custom-reishi-source');
    },
  );
});

Deno.test('getDeactivatedDir is _deactivated under source', async () => {
  await withConfig(
    {
      paths: { source: '/tmp/custom-reishi-source', targets: {} },
    },
    async () => {
      assertEquals(
        await getDeactivatedDir(),
        '/tmp/custom-reishi-source/_deactivated',
      );
    },
  );
});

Deno.test('getSourceDir expands leading ~ against HOME', async () => {
  await withConfig(
    {
      paths: { source: '~/custom-skills', targets: {} },
    },
    async (home) => {
      assertEquals(await getSourceDir(), join(home, 'custom-skills'));
    },
  );
});
