/**
 * Test helpers for reishi integration tests.
 *
 * Two layers:
 *
 *   1. `setupIsolatedEnv()` builds an isolated HOME + config + source dirs
 *      and returns an `IsolatedEnv` with a `cleanup()` that wipes everything.
 *   2. The `seed*` builders (and `copyFixtureToTemp`) take that env and
 *      populate it with structured input — projects, agent targets, source
 *      dirs, remote-repo tarballs. Each builder writes under the env's temp
 *      tree (or registers its own cleanup) so `env.cleanup()` sweeps state
 *      regardless of where it landed.
 *
 * Prefer the builders over inline `Deno.makeTempDir` + `writeTextFile`. New
 * tests should reach for `seedProject`, `seedAgentTarget`, `seedSourceDir`,
 * or `seedRemoteRepo` before hand-rolling scaffolding (dev-R020).
 */

import { assert, assertStringIncludes } from '@std/assert';
import { dirname, fromFileUrl, join, resolve } from '@std/path';
import { stringify as stringifyTOML } from '@std/toml';

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)));
const FIXTURES_ROOT = join(REPO_ROOT, 'test-fixtures');
const REMOTE_REPOS_ROOT = join(FIXTURES_ROOT, 'remote-repos');

/**
 * Absolute path to a fixture under `test-fixtures/`.
 *
 * Pass bucket-relative parts. Buckets:
 *   - `remote-repos/`    — GitHub-tarball sources used by add/pull tests
 *   - `project-targets/` — project-root layouts (claude-only, mixed, …)
 *   - `project-sources/` — curated reishi-source dirs (skills + rules + docs)
 */
export function fixturesPath(...parts: string[]): string {
  return join(FIXTURES_ROOT, ...parts);
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
  /** Isolated rules source dir (`<configDir>/rules`). */
  rulesDir: string;
  /**
   * A temp dir under home that tests can treat as a project root for docs
   * sync — its parent (`home`) always exists.
   */
  projectDir: string;
  /** Env map suitable for Deno.Command.env (HOME + REISHI_CONFIG). */
  env: Record<string, string>;
  /**
   * Register an extra cleanup callback. Builders that allocate temp dirs
   * outside `home` use this so `env.cleanup()` still sweeps everything.
   * Callbacks run in reverse-registration order; failures are swallowed.
   */
  registerCleanup: (fn: () => Promise<void> | void) => void;
  /** Remove the temp dir and run any registered cleanups. Safe to call twice. */
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
  const rulesDir = join(configDir, 'rules');
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
      source: rulesDir,
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

  const cleanups: Array<() => Promise<void> | void> = [];

  return {
    configPath,
    lockfilePath,
    home,
    sourceDir,
    docsDir,
    rulesDir,
    projectDir,
    env: { HOME: home, REISHI_CONFIG: configPath },
    registerCleanup: (fn) => {
      cleanups.push(fn);
    },
    cleanup: async () => {
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (!fn) continue;
        try {
          await fn();
        } catch {
          /* ignore */
        }
      }
      try {
        await Deno.remove(home, { recursive: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ── seed* builders ─────────────────────────────────────────────────

/** Recursively write a `{ relative-path: content }` map under `root`. */
async function writeFileMap(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await Deno.mkdir(dirname(full), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
}

/**
 * Each skill becomes `<dir>/<name>/...` with a default `SKILL.md` if the
 * caller didn't supply one. Mirrors the on-disk shape `skills add` produces.
 */
async function writeSkillTree(
  dir: string,
  skills: Record<string, Record<string, string>>,
): Promise<void> {
  for (const [name, files] of Object.entries(skills)) {
    const skillDir = join(dir, name);
    await Deno.mkdir(skillDir, { recursive: true });
    const merged: Record<string, string> = { ...files };
    if (!('SKILL.md' in merged)) {
      merged['SKILL.md'] = `---\nname: ${name}\ndescription: test fixture skill — ${name}\n---\n`;
    }
    await writeFileMap(skillDir, merged);
  }
}

export interface SeedProjectInput {
  /** Optional name segment (becomes a stable subdir under `home`). Defaults to a random temp dir. */
  name?: string;
  /** Files keyed by path relative to the project root. */
  files?: Record<string, string>;
  /** Empty directories to ensure exist (relative to the project root). */
  dirs?: string[];
}

/**
 * Build a project-root-shaped temp dir under `env.home`.
 *
 * Returns the project root path. Cleanup is handled by `env.cleanup()` —
 * the dir lives under `home`, so it disappears when the env is torn down.
 *
 * @example
 *   const proj = await seedProject(env, {
 *     files: {
 *       'AGENTS.md': '# Hello',
 *       '.claude/skills/foo/SKILL.md': '...',
 *     },
 *   });
 */
export async function seedProject(
  env: IsolatedEnv,
  input: SeedProjectInput = {},
): Promise<string> {
  const root = input.name
    ? join(env.home, 'projects', input.name)
    : await Deno.makeTempDir({ dir: env.home, prefix: 'project-' });
  await Deno.mkdir(root, { recursive: true });
  if (input.files) await writeFileMap(root, input.files);
  for (const d of input.dirs ?? []) {
    await Deno.mkdir(join(root, d), { recursive: true });
  }
  return root;
}

export interface SeedAgentTargetInput {
  /** Optional name (`<home>/<name>/`). Defaults to a random temp dir. */
  name?: string;
  /** Skills keyed by skill name; values are extra files to drop in the skill dir. */
  skills?: Record<string, Record<string, string>>;
  /** Rule files keyed by relative path (inside the rules dir). */
  rules?: Record<string, string>;
}

export interface SeededAgentTarget {
  /** Agent root (parent of skills/ and rules/). */
  path: string;
  /** Skills target dir (`<path>/skills`). */
  skillsPath: string;
  /** Rules target dir (`<path>/rules`). */
  rulesPath: string;
}

/**
 * Build an agent-target dir under `env.home` with `skills/` and `rules/`
 * subdirs populated. Cleanup runs via `env.cleanup()` (dir lives under `home`).
 */
export async function seedAgentTarget(
  env: IsolatedEnv,
  input: SeedAgentTargetInput = {},
): Promise<SeededAgentTarget> {
  const path = input.name
    ? join(env.home, input.name)
    : await Deno.makeTempDir({ dir: env.home, prefix: 'agent-' });
  const skillsPath = join(path, 'skills');
  const rulesPath = join(path, 'rules');
  await Deno.mkdir(skillsPath, { recursive: true });
  await Deno.mkdir(rulesPath, { recursive: true });
  if (input.skills) await writeSkillTree(skillsPath, input.skills);
  if (input.rules) await writeFileMap(rulesPath, input.rules);
  return { path, skillsPath, rulesPath };
}

export interface SeedSourceDirInput {
  /** Skills keyed by name (writes under `env.sourceDir`). */
  skills?: Record<string, Record<string, string>>;
  /** Rule files keyed by relative path (writes under `env.rulesDir`). */
  rules?: Record<string, string>;
  /** Docs keyed by project name → relative path → content (writes under `env.docsDir`). */
  docs?: Record<string, Record<string, string>>;
}

export interface SeededSourceDir {
  skillsDir: string;
  rulesDir: string;
  docsDir: string;
}

/**
 * Populate the env's source dirs (skills/rules/docs). Idempotent — pass only
 * the slices you need. Cleanup is implicit via `env.cleanup()`.
 *
 * @example
 *   await seedSourceDir(env, {
 *     skills: { alpha: {} },
 *     rules: { 'no-deletes.md': '# rule\n' },
 *     docs: { 'myproject': { 'guide.md': '# guide\n' } },
 *   });
 */
export async function seedSourceDir(
  env: IsolatedEnv,
  input: SeedSourceDirInput,
): Promise<SeededSourceDir> {
  await Deno.mkdir(env.sourceDir, { recursive: true });
  await Deno.mkdir(env.rulesDir, { recursive: true });
  await Deno.mkdir(env.docsDir, { recursive: true });
  if (input.skills) await writeSkillTree(env.sourceDir, input.skills);
  if (input.rules) await writeFileMap(env.rulesDir, input.rules);
  if (input.docs) {
    for (const [project, files] of Object.entries(input.docs)) {
      const projectDir = join(env.docsDir, project);
      await Deno.mkdir(projectDir, { recursive: true });
      await writeFileMap(projectDir, files);
    }
  }
  return { skillsDir: env.sourceDir, rulesDir: env.rulesDir, docsDir: env.docsDir };
}

export interface SeedRemoteRepoInput {
  /** Either pull from an on-disk fixture name … */
  fixtureName?: string;
  /** … or build the repo contents inline. */
  files?: Record<string, string>;
  /** Optional skills under `skills/<name>/`. Merged with `files`. */
  skills?: Record<string, Record<string, string>>;
  /** Wrapper dir name (defaults to `<fixtureName>-main` or `repo-main`). */
  ref?: string;
  /** Tarball filename stem; defaults to fixture or `repo`. */
  outName?: string;
}

/**
 * Build a GitHub-shaped tarball — either from an on-disk
 * `test-fixtures/remote-repos/<name>` dir or from inline content. Cleanup is
 * registered against `env`, so the staging dirs disappear when the test
 * finishes.
 *
 * Returns the tarball path; pair with `fakeFetchGithub()` to feed it to
 * the add/pull flow.
 */
export async function seedRemoteRepo(
  env: IsolatedEnv,
  input: SeedRemoteRepoInput,
): Promise<string> {
  const stem = input.outName ?? input.fixtureName ?? 'repo';
  const wrapperName = input.ref ?? `${stem}-main`;
  const stage = await Deno.makeTempDir({ prefix: 'reishi-remote-stage-' });
  env.registerCleanup(async () => {
    await Deno.remove(stage, { recursive: true });
  });
  const stagedRepo = join(stage, wrapperName);

  if (input.fixtureName) {
    const fixturePath = join(REMOTE_REPOS_ROOT, input.fixtureName);
    try {
      await Deno.stat(fixturePath);
    } catch {
      throw new Error(`fixture not found: ${fixturePath}`);
    }
    const cp = new Deno.Command('cp', {
      args: ['-R', fixturePath, stagedRepo],
      stderr: 'piped',
    });
    const cpResult = await cp.output();
    if (!cpResult.success) {
      throw new Error(`cp failed: ${new TextDecoder().decode(cpResult.stderr)}`);
    }
  } else {
    await Deno.mkdir(stagedRepo, { recursive: true });
  }

  if (input.files) await writeFileMap(stagedRepo, input.files);
  if (input.skills) await writeSkillTree(join(stagedRepo, 'skills'), input.skills);

  const outDir = await Deno.makeTempDir({ prefix: 'reishi-remote-tar-' });
  env.registerCleanup(async () => {
    await Deno.remove(outDir, { recursive: true });
  });
  const tarballPath = join(outDir, `${stem}.tar.gz`);
  const tar = new Deno.Command('tar', {
    args: ['czf', tarballPath, '-C', stage, wrapperName],
    stderr: 'piped',
  });
  const tarResult = await tar.output();
  if (!tarResult.success) {
    throw new Error(`tar failed: ${new TextDecoder().decode(tarResult.stderr)}`);
  }
  return tarballPath;
}

/**
 * Copy an on-disk fixture to a fresh temp dir so the test can mutate it
 * freely. Cleanup is registered against `env`. Lookup is bucket-relative —
 * pass the same parts you'd pass to `fixturesPath()`.
 *
 * @example
 *   const proj = await copyFixtureToTemp(env, 'project-targets', 'mixed');
 */
export async function copyFixtureToTemp(
  env: IsolatedEnv,
  ...parts: string[]
): Promise<string> {
  const src = fixturesPath(...parts);
  try {
    await Deno.stat(src);
  } catch {
    throw new Error(`fixture not found: ${src}`);
  }
  const out = await Deno.makeTempDir({ dir: env.home, prefix: 'fixture-' });
  const dest = join(out, parts[parts.length - 1] ?? 'fixture');
  const cp = new Deno.Command('cp', { args: ['-R', src, dest], stderr: 'piped' });
  const result = await cp.output();
  if (!result.success) {
    throw new Error(`cp failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return dest;
}

// ── Assertions ─────────────────────────────────────────────────────

export interface CompiledIndexExpectations {
  /** Required `# <title>` heading. */
  title?: string;
  /** Substrings that MUST appear (in any order). */
  containsAll?: string[];
  /** Substrings that MUST NOT appear. */
  excludes?: string[];
  /** Required fragment links (matches `](./<name>)` in the linked-fragments list). */
  fragments?: string[];
}

/**
 * Assert that a compiled docs/rules index matches the expectations. Replaces
 * ad-hoc `assertStringIncludes` chains in compile/sync tests so the intent
 * is in one place.
 */
export function assertCompiledIndexMatches(
  actual: string,
  expected: CompiledIndexExpectations,
): void {
  if (expected.title !== undefined) {
    assertStringIncludes(actual, `# ${expected.title}`);
  }
  for (const s of expected.containsAll ?? []) {
    assertStringIncludes(actual, s);
  }
  for (const s of expected.excludes ?? []) {
    assert(!actual.includes(s), `compiled index unexpectedly contains: ${s}`);
  }
  for (const fragment of expected.fragments ?? []) {
    const needle = `](./${fragment})`;
    assert(
      actual.includes(needle) || actual.includes(`./${fragment}\n`),
      `compiled index missing fragment link: ${fragment}`,
    );
  }
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
