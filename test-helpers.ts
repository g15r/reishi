/**
 * Test helpers for reishi integration tests.
 *
 * Provides an isolated env (temp config, source dir, target dirs), a way to
 * build GitHub-shaped tarballs from on-disk fixtures, and a fake `fetch` that
 * returns those tarballs in lieu of hitting github.com.
 */

import { dirname, fromFileUrl, join, resolve } from '@std/path';
import { stringify as stringifyTOML } from '@std/toml';

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)));
const FIXTURES_ROOT = join(REPO_ROOT, 'test-fixtures', 'repos');

/** Absolute path to a test-fixtures/<subdir> directory. */
export function fixturesPath(...parts: string[]): string {
  return join(REPO_ROOT, 'test-fixtures', ...parts);
}

export interface IsolatedEnv {
  /** Path to the isolated config.toml. */
  configPath: string;
  /** Path to the isolated reishi-lock.toml (alongside configPath). */
  lockfilePath: string;
  /** Root temp dir (parent of everything else). */
  home: string;
  /** Isolated source-of-truth skills dir. */
  sourceDir: string;
  /** Isolated docs source dir (`<configDir>/docs`). */
  docsDir: string;
  /**
   * A temp dir under home that tests can treat as a project root for docs
   * sync — its parent (`home`) always exists.
   */
  projectDir: string;
  /** Env map suitable for Deno.Command.env (HOME + REISHI_CONFIG). */
  env: Record<string, string>;
  /** Remove the temp dir. Safe to call twice. */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated HOME + config + source dir. Writes a minimal config
 * pointing source at the isolated dir. Does NOT touch the user's real files.
 */
export async function setupIsolatedEnv(
  overrides: Partial<{ sync_method: string; default_prefix: string; prefix_separator: string }> =
    {},
): Promise<IsolatedEnv> {
  const home = await Deno.makeTempDir({ prefix: 'reishi-isolated-' });
  const configDir = join(home, '.config', 'reishi');
  await Deno.mkdir(configDir, { recursive: true });
  const configPath = join(configDir, 'config.toml');
  const lockfilePath = join(configDir, 'reishi-lock.toml');
  const sourceDir = join(configDir, 'skills');
  await Deno.mkdir(sourceDir, { recursive: true });

  const docsDir = join(configDir, 'docs');
  const projectDir = join(home, 'projects', 'sample');
  // Pre-create the parent dir so docs sync (which refuses to mkdir when the
  // parent is missing) can write into projectDir on first run.
  await Deno.mkdir(join(home, 'projects'), { recursive: true });
  const config: Record<string, unknown> = {
    sync_method: overrides.sync_method ?? 'copy',
    default_prefix: overrides.default_prefix ?? 'none',
    prefix_separator: overrides.prefix_separator ?? '_',
    skills: {
      source: sourceDir,
    },
    updates: { enabled: false, interval_hours: 24 },
    rules: {
      source: join(configDir, 'rules'),
    },
    agents: {
      claude: {
        skills: join(home, '.claude', 'skills'),
        rules: join(home, '.claude', 'rules'),
      },
    },
    docs: {
      source: docsDir,
      default_target: '.agents/docs',
      index_filename: 'AGENTS.md',
      token_budget: 4000,
    },
  };
  await Deno.writeTextFile(configPath, stringifyTOML(config));

  return {
    configPath,
    lockfilePath,
    home,
    sourceDir,
    docsDir,
    projectDir,
    env: { HOME: home, REISHI_CONFIG: configPath },
    cleanup: async () => {
      try {
        await Deno.remove(home, { recursive: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Build a GitHub-shaped tarball from a fixture directory. GitHub's archive
 * format has a top-level `{repo}-{ref}/` directory containing all files;
 * `tar --strip-components=1` peels that back off. We stage the fixture
 * contents under that wrapper dir then tar it.
 *
 * Returns the path to the tarball on disk. Caller is responsible for cleanup
 * (usually via the enclosing temp dir).
 */
export async function makeFixtureTarball(
  fixtureRepoName: string,
  opts: { repoRef?: string } = {},
): Promise<string> {
  const fixturePath = join(FIXTURES_ROOT, fixtureRepoName);
  try {
    await Deno.stat(fixturePath);
  } catch {
    throw new Error(`fixture not found: ${fixturePath}`);
  }

  const wrapperName = opts.repoRef ?? `${fixtureRepoName}-main`;
  const stage = await Deno.makeTempDir({ prefix: 'reishi-fixture-stage-' });
  const stagedRepo = join(stage, wrapperName);

  // Copy the fixture under the wrapper dir. Deno.copyFile doesn't do trees;
  // shelling out to cp -R is fine for test helpers.
  const cp = new Deno.Command('cp', {
    args: ['-R', fixturePath, stagedRepo],
    stderr: 'piped',
  });
  const cpResult = await cp.output();
  if (!cpResult.success) {
    throw new Error(`cp failed: ${new TextDecoder().decode(cpResult.stderr)}`);
  }

  const outDir = await Deno.makeTempDir({ prefix: 'reishi-fixture-tar-' });
  const tarballPath = join(outDir, `${fixtureRepoName}.tar.gz`);
  const tar = new Deno.Command('tar', {
    args: ['czf', tarballPath, '-C', stage, wrapperName],
    stderr: 'piped',
  });
  const tarResult = await tar.output();
  if (!tarResult.success) {
    throw new Error(`tar failed: ${new TextDecoder().decode(tarResult.stderr)}`);
  }

  await Deno.remove(stage, { recursive: true });
  return tarballPath;
}

/**
 * Build a fetch-compatible function that returns the given tarball bytes for
 * any URL. The reishi add flow tries heads/{ref} then tags/{ref}; either
 * returns the same body here.
 */
export function fakeFetchGithub(tarballPath: string): (url: string) => Promise<Response> {
  return async (_url: string) => {
    const bytes = await Deno.readFile(tarballPath);
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/gzip' },
    });
  };
}
