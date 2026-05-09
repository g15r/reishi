# dev-ci — CI workflows

## Goals

`dev-` covers reishi's development-meta surface: tooling, harness, build/release, CI. `dev-ci` is
the CI slice — making sure the test signal we generate locally is the same signal CI gates on, and
surfacing that signal back onto PRs visibly enough to act on. Numbering picks up at `dev-R100` so
the `dev-` prefix stays unique across `dev-testing.md` and this file.

**Non-goals.** No new CI providers (GitHub Actions stays); no replacement of the existing release
workflow (R001); no auto-fix bots that mutate PR branches.

## Requirements

### Coverage signal

- **dev-R100** — `deno test --coverage` runs in CI on every PR. Line and branch coverage are
  reported back to the PR (a comment or a status check) with deltas relative to the merge base, so
  reviewers see the signal without leaving GitHub.
- **dev-R101** — A baseline coverage floor is enforced: PRs that drop coverage below the floor fail
  the gate. The floor is moved by maintainer decision, not auto-ratcheted — the goal is "noticed
  regressions," not coverage theater.
