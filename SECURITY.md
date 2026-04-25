# Security

## Threat model

Reishi reads and writes markdown files and a TOML config. It is not a
network service, it does not execute code from remotes, and it does not
manage credentials. The realistic risks are user-error shaped, not
attacker-shaped.

The two failure modes worth naming:

1. **Secrets in fragments.** The most common security issue we expect to
   see is users accidentally putting secrets — API keys, tokens, internal
   URLs — into rules, skills, or docs that then get synced into agent
   contexts and discussed in chat sessions. The fix is upstream: review
   what you author into your reishi source before syncing. Reishi syncs
   what you tell it to sync; it has no way to detect a credential in
   prose.

2. **Untrusted remotes.** `rei skills add -t <url>` pulls content from a
   GitHub repository. That content lands in your source, gets synced to
   every configured agent target, and then gets read by agents as part of
   their context. **Only track skill remotes you trust** — the same way
   you'd think about adding a dependency from npm or PyPI. Reishi has no
   sandbox; the markdown you pull becomes part of how an agent thinks.

Beyond those two, reishi's surface is small: file copy, file symlink, TOML
parse, GitHub tarball download. We don't claim it's bug-free, but we
don't think there's much to attack.

## Reporting a vulnerability

If you believe you've found a vulnerability in reishi itself — a way to
escape the source/target boundary, an injection in the TOML parser, an
arbitrary-file-write through the sync engine, etc. — please report it
privately through GitHub's [private vulnerability reporting][gh-pvr]
rather than opening a public issue or PR.

To file a report, navigate to the **Security** tab of this repository and
click **Report a vulnerability**, or go directly to:
<https://github.com/supermodellabs/reishi/security/advisories/new>

GitHub's docs walk through the reporter flow end-to-end:
<https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>

This keeps the discussion off the public timeline until a fix is ready,
and gives us a single place to coordinate the advisory, fix, and CVE.
Please do not email maintainers directly or post in Discussions; the
private advisory is the supported channel.

[gh-pvr]: https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configuring-private-vulnerability-reporting-for-a-repository

Please include:

- A description of the vulnerability.
- Steps to reproduce, or a proof-of-concept.
- The version of reishi affected (`rei --version`).
- Your assessment of impact.

### What to expect

- **Acknowledgement** within 5 business days.
- **Initial assessment** (severity + tentative timeline) within 14 days.
- **Fix or mitigation** for confirmed high-severity issues within 30 days,
  faster for actively-exploited issues. Lower-severity issues may be
  rolled into the next regular release.
- **Coordinated disclosure.** We'll work with you on a disclosure
  timeline; we won't publish without giving you a chance to review the
  advisory.

For non-security bugs, please use a regular GitHub issue instead.
