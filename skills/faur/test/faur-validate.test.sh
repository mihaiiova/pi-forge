#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
faur="$root/skills/faur/faur.mjs"
fixtures="$root/skills/faur/test/fixtures"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

run_validate() {
  node "$faur" validate "$1" >/dev/null 2>&1
}

# ── Valid fixtures exit 0 ────────────────────────────────────────
for name in valid-seo coding-agent; do
  if run_validate "$fixtures/$name"; then
    pass "faur validate accepts $name (exit 0)"
  else
    fail "faur validate should accept $name but exited non-zero"
  fi
done

# ── Invalid fixtures exit 1 ──────────────────────────────────────
for name in invalid-unknown-key invalid-bad-reference invalid-malformed-workflow \
            invalid-incompatible invalid-malformed-yaml invalid-duplicate; do
  if run_validate "$fixtures/$name"; then
    fail "faur validate should reject $name but exited 0"
  else
    pass "faur validate rejects $name (exit 1)"
  fi
done

# ── A document without schema: 1 is rejected, never migrated ────
legacy="$(mktemp -d)"
mkdir -p "$legacy/.pi"
grep -v '^schema:' "$fixtures/valid-seo/.pi/system.yaml" > "$legacy/.pi/system.yaml"
if node "$faur" validate "$legacy" >/dev/null 2>&1; then
  rm -rf "$legacy"
  fail "faur validate should reject a document without schema: 1"
fi
rm -rf "$legacy"
pass "faur validate rejects a document without schema: 1 (exit 1)"

# ── Missing directory exits 1 ────────────────────────────────────
if run_validate "$fixtures/does-not-exist"; then
  fail "faur validate should reject a missing directory but exited 0"
else
  pass "faur validate rejects a missing directory (exit 1)"
fi

echo
echo "All faur-validate tests passed."
