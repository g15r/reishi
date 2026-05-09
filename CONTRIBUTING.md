# Contributing to reishi

Thanks for considering a contribution. This document covers what we expect from changes, how the PR flow works, and a few principles that shape what we say yes and no to.

## Getting started

Reishi is a Deno project. You'll need [Deno 2+](https://deno.com/).

```bash
git clone https://github.com/supermodellabs/reishi
cd reishi
deno task check         # type check everything
deno task test          # run the full suite (unit + integration + CLI + compiled binary)
deno task cli <command> # run reishi against your live source from the repo
```

Create a feature branch off `main`:

```bash
git switch -c fix/some-thing
```

## Pre-commit hooks

We use [prek](https://prek.j178.dev/) — a fast, Rust-native, drop-in replacement for `pre-commit`. The config lives at [`prek.toml`](./prek.toml). Hooks cover whitespace and EOF hygiene, config-file syntax (YAML/TOML/JSON), `deno fmt` + `deno lint`, [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2), and [actionlint](https://github.com/rhysd/actionlint) for GitHub Actions workflows.

```bash
brew install prek          # or see https://prek.j178.dev/installation/
prek install               # wire up .git/hooks/pre-commit
prek run --all-files       # one-time run across the whole repo
prek auto-update           # bump pinned external `rev`s
```

Hooks aren't enforced in CI today — the same checks run as separate steps in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — but installing them locally catches issues before they hit a PR.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/), enforced in CI. Common types we use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. Scopes are optional; when present they map to the construct (`skills`, `rules`, `docs`, `config`, `cli`, `sync`).

Examples:

```text
feat(skills): add --check flag to sync command
fix(sync): preserve symlinks across prefix renames
docs: clarify divergence protection in AGENTS.md
```

Keep the subject under 72 characters. Use the body to explain *why*, not *what* — the diff already tells the reader what.

## History

We require **linear history** on `main`. Rebase onto `main` rather than merging; CI rejects merge commits. If your branch falls behind:

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease
```

Avoid `git push --force` (without `--with-lease`) — `--force-with-lease` prevents you from clobbering changes you didn't pull.

## PR process

1. **Push your branch and open a PR.** The PR title doubles as the
eventual squash-commit message, so it must follow Conventional Commits style (see [PR titles](#pr-titles) below).
2. **CI runs automatically** for repository contributors. For new
contributors, GHA workflows require manual approval before they run — this is a spam-control measure, not a judgment of you. Expect a short wait while a maintainer triages and either approves or declines the run. We try to do this within a few days.
3. **Address review feedback** by pushing additional commits to the
branch. Don't squash mid-review; we want to see the iteration history during review and squash at merge time.
4. **Once approved**, a maintainer merges. We use `rebase` for small,
focused PRs (each commit is meaningful and worth keeping) and `squash` for larger PRs where the intermediate commits are process-noise. For squash merges we use the PR title as the squash commit subject and edit the auto-generated commit list down to a tight summary in the body.

## PR titles

The title is the merged commit subject (for squash merges) or the top-of-branch subject (for rebase merges), so it must be:

- **Conventional Commits style** — `type(scope): subject`.
- **Under ~70 characters** — long titles get truncated in lists.
- **Imperative mood** — "add X", not "added X" or "adds X".

Use the PR description for the long-form: motivation, design choices, testing notes, screenshots. Don't pack it into the title.

## Issues and Discussions

Mirroring the [README guidance](./README.md#issues-vs-discussions):

- **Discussions** for ideas, questions, "what if reishi did X?" — the
conversational, exploratory work. If you're not sure whether your thought is a concrete issue, start in Discussions.
- **Issues** for concrete, reproducible change requests: a bug with a
repro, a missing flag with a clear shape, a doc inaccuracy. An issue should describe the change well enough that a contributor could pick it up cold.

We auto-close issues and PRs that don't engage with these guidelines. That's care for the OSS ecosystem, not gatekeeping — please reopen after addressing the feedback. The bot will point you at the section that needs work.

## Writing tests

Tests run offline against `REISHI_CONFIG`-redirected temp dirs. Two layers do the work:

- **`setupIsolatedEnv()`** in `test-helpers.ts` builds an isolated `HOME` + config + source dirs and returns an `IsolatedEnv` with a `cleanup()` that wipes everything when the test finishes.
- **The `seed*` builders** populate that env with structured input — no inline `Deno.makeTempDir` + `writeTextFile` chains. Reach for one of these before hand-rolling scaffolding:
  - `seedSourceDir(env, { skills, rules, docs })` — populate the source side.
  - `seedAgentTarget(env, { name?, skills, rules })` — populate an agent target dir.
  - `seedProject(env, { name?, files, dirs })` — build a project-root layout under `env.home`.
  - `seedRemoteRepo(env, { fixtureName? | files, skills })` — produce a GitHub-shaped tarball you feed to `fakeFetchGithub()`.
  - `copyFixtureToTemp(env, ...parts)` — mutable copy of any on-disk fixture.

Skeleton:

```ts
import { seedSourceDir, setupIsolatedEnv } from './test-helpers.ts';

Deno.test('listRules: returns top-level entries', async () => {
  const env = await setupIsolatedEnv();
  try {
    await withEnv(env.env, async () => {
      await seedSourceDir(env, { rules: { 'no-deletes.md': '# rule\n' } });
      const names = await getRuleNames();
      assertEquals(names, ['no-deletes']);
    });
  } finally {
    await env.cleanup();
  }
});
```

### Fixtures

`test-fixtures/` is split into three buckets — see [`test-fixtures/README.md`](./test-fixtures/README.md) for the contract:

- `remote-repos/` — GitHub-tarball sources for `add` / `pull` tests.
- `project-targets/` — heterogeneous project-root layouts simulating real user repos.
- `project-sources/` — curated reishi-source dirs (skills + rules + docs).

A fixture file that no `*_test.ts` references gets deleted (dev-R003). Don't add fixtures speculatively; add them when a test needs them.

### Assertions

For compile/sync output, prefer `assertCompiledIndexMatches(actual, expectations)` over chained `assertStringIncludes` — keeps the intent in one place.

## Design principles and anti-goals

Reishi's design is opinionated. A few load-bearing principles to know before you propose a feature:

- **Six-word vocabulary** (fragment, source, target, sync, pull,
remote). New features should fit the existing vocabulary, not introduce a seventh.
- **Source is authoritative.** Features that write to source without
an explicit user action are non-starters.
- **Local-first.** Only `rei skills pull` hits the network. New
commands that quietly fetch are non-starters.
- **No registry.** Skills are GitHub repos. We won't add a centralized
index, search backend, or marketplace integration.
- **Markdown-only context.** Reishi manages markdown. Features that
introduce other formats (JSON skill manifests, YAML rules, proprietary bundle formats) are non-starters.

For more on the philosophy, see the [Philosophy section in the README](./README.md#philosophy).

If you're unsure whether your idea fits, start a Discussion before writing code. We'd rather talk shape with you than decline a finished PR for fundamental reasons.
