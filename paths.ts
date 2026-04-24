/**
 * Path resolvers for reishi's central source-of-truth.
 *
 * These read from the loaded config and expand `~` into absolute paths. A
 * session-scoped cache avoids repeated config reads within a single CLI
 * invocation; call `resetPathCache()` in tests that swap configs mid-run.
 */

import { join } from '@std/path';
import { expandHome, loadConfig } from './config.ts';

interface CachedPaths {
  source: string;
  deactivated: string;
  rules: string;
  docs: string;
}

let cached: CachedPaths | null = null;

async function resolve(): Promise<CachedPaths> {
  if (cached) return cached;
  const config = await loadConfig();
  const source = expandHome(config.skills.source);
  const rules = expandHome(config.rules.source);
  const docs = expandHome(config.docs.source);
  cached = { source, deactivated: join(source, '_deactivated'), rules, docs };
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

/** Absolute path to the configured rules source dir. */
export async function getRulesSourceDir(): Promise<string> {
  return (await resolve()).rules;
}

/** Absolute path to the configured docs source dir. */
export async function getDocsSourceDir(): Promise<string> {
  return (await resolve()).docs;
}

/** Clear the cached paths — tests that swap REISHI_CONFIG mid-run need this. */
export function resetPathCache(): void {
  cached = null;
}
