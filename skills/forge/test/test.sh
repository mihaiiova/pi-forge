#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

# ── Pure-module node:test suites ────────────────────────────────
for module in setup parse validate models skill-sources generate workflow-skill multi-agent discover mcp-gen policy modify skill-contract deps runtime integration-secrets import capabilities maintenance maintenance-fetch registry-skills launch-check cli-tools agent-context package-dependencies package-generation package-sdk package-skill package-update package-clean-machine mcp-runtime headless-workflow workflow-print-mode; do
  if out="$(node --test "$here/$module.test.mjs" 2>&1)"; then
    pass "$module.test.mjs"
  else
    printf '%s\n' "$out" >&2
    fail "$module.test.mjs (run: node --test $here/$module.test.mjs)"
  fi
done

# ── round-trip + clean-env node:test suite ───────────────────────
if out="$(node --test "$here/roundtrip.mjs" 2>&1)"; then
  pass "roundtrip.mjs"
else
  printf '%s\n' "$out" >&2
  fail "roundtrip.mjs (run: node --test $here/roundtrip.mjs)"
fi

# ── forge validate CLI exit-code harness ──────────────────────
if bash "$here/forge-validate.test.sh"; then
  pass "forge-validate.test.sh"
else
  fail "forge-validate.test.sh"
fi

# ── forge generate CLI harness ────────────────────────────────
if bash "$here/forge-generate.test.sh"; then
  pass "forge-generate.test.sh"
else
  fail "forge-generate.test.sh"
fi

# ── forge discover CLI harness ────────────────────────────────
if bash "$here/forge-discover.test.sh"; then
  pass "forge-discover.test.sh"
else
  fail "forge-discover.test.sh"
fi

# ── forge modify CLI harness ──────────────────────────────────
if bash "$here/forge-modify.test.sh"; then
  pass "forge-modify.test.sh"
else
  fail "forge-modify.test.sh"
fi

# ── builder flow behavioral harness ────────────────────────────
if bash "$here/forge-behavior.test.sh"; then
  pass "forge-behavior.test.sh"
else
  fail "forge-behavior.test.sh"
fi

# ── forge import CLI + clean-env harness ─────────────────────
if bash "$here/forge-import.test.sh"; then
  pass "forge-import.test.sh"
else
  fail "forge-import.test.sh"
fi

# ── runtime isolation harness (Tests A/B/C) ────────────
if bash "$here/isolation.test.sh"; then
  pass "isolation.test.sh"
else
  fail "isolation.test.sh"
fi

# ── launcher integration (mocked pi — no model/credentials) ────
if bash "$here/launcher.test.sh"; then
  pass "launcher.test.sh"
else
  fail "launcher.test.sh"
fi

echo
echo "All forge tests passed."
