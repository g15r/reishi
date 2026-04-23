/**
 * Path resolvers for reishi's central source-of-truth.
 *
 * These read from the loaded config and expand `~` into absolute paths. A
 * session-scoped cache avoids repeated config reads within a single CLI
 * invocation; call `resetPathCache()` in tests that swap configs mid-run.
 */

import { join } from '@std/path';
import { expandHome, loadConfig } from './config.ts';

let cached: { source: string; deactivated: string } | null = null;

async function resolve(): Promise<{ source: string; deactivated: string }> {
  if (cached) return cached;
  const config = await loadConfig();
  const source = expandHome(config.paths.source);
  cached = { source, deactivated: join(source, '_deactivated') };
  return cached;
}

/** Absolute path to the configured source-of-truth skills dir. */
export async function getSourceDir(): Promise<string> {
  return (await resolve()).source;
}

/** Absolute path to the deactivated-skills subdir under source. */
export async function getDeactivatedDir(): Promise<string> {
  return (await resolve()).deactivated;
}

/** Clear the cached paths — tests that swap REISHI_CONFIG mid-run need this. */
export function resetPathCache(): void {
  cached = null;
}
