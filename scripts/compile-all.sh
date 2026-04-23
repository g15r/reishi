#!/usr/bin/env bash
# Cross-compile `rei` for all supported release targets.
#
# Maps Deno's Rust-style target triples onto Homebrew-releaser's
# `{os}-{arch}` naming so the CI workflow (and local smoke tests) can
# reference each output by a single stable name.
#
# Output layout:
#   bin/rei-darwin-arm64
#   bin/rei-darwin-amd64
#   bin/rei-linux-arm64
#   bin/rei-linux-amd64

set -euo pipefail

# Resolve repo root so this script works from any CWD (and so deno task,
# which runs with the project dir as CWD, behaves identically).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p bin

# Permission flags must match reishi.ts shebang so the compiled binary
# behaves identically to `deno run`.
PERMS=(
  --allow-read
  --allow-write
  --allow-env=HOME,EDITOR,REISHI_CONFIG
  --allow-net=platform.claude.com,code.claude.com,github.com,codeload.github.com
  --allow-run
)

# target-triple : output-suffix
TARGETS=(
  "aarch64-apple-darwin:darwin-arm64"
  "x86_64-apple-darwin:darwin-amd64"
  "aarch64-unknown-linux-gnu:linux-arm64"
  "x86_64-unknown-linux-gnu:linux-amd64"
)

for entry in "${TARGETS[@]}"; do
  triple="${entry%%:*}"
  suffix="${entry##*:}"
  output="bin/rei-${suffix}"

  echo "==> compiling ${triple} -> ${output}"
  deno compile \
    "${PERMS[@]}" \
    --include assets/ \
    --target "$triple" \
    --output "$output" \
    reishi.ts
done

echo
echo "✅ Built all targets:"
ls -la bin/rei-*
