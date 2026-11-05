#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

# ── Pure-module node:test suites ────────────────────────────────
for module in setup parse asking validate models skill-sources generate workflow-skill multi-agent discover mcp-gen policy modify skill-contract deps runtime integration-secrets import capabilities maintenance maintenance-fetch registry-skills launch-check cli-tools agent-context package-dependencies package-generation package-sdk package-skill package-clean-machine mcp-runtime delegation-native headless-workflow workflow-print-mode maintenance-rpc; do
  if out="$(node --test "$here/$module.test.mjs" 2>&1)"; then
    if [[ "$module" == delegation-native && "${RUN_FAUR_DELEGATION_TEST:-}" != 1 ]]; then
      echo "ok - delegation-native.test.mjs SKIPPED (set RUN_FAUR_DELEGATION_TEST=1 to verify real-Pi MCP delegation; requires network)"
    else
      pass "$module.test.mjs"
    fi
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

# ── faur validate CLI exit-code harness ──────────────────────
if bash "$here/faur-validate.test.sh"; then
  pass "faur-validate.test.sh"
else
  fail "faur-validate.test.sh"
fi

# ── faur generate CLI harness ────────────────────────────────
if bash "$here/faur-generate.test.sh"; then
  pass "faur-generate.test.sh"
else
  fail "faur-generate.test.sh"
fi

# ── faur discover CLI harness ────────────────────────────────
if bash "$here/faur-discover.test.sh"; then
  pass "faur-discover.test.sh"
else
  fail "faur-discover.test.sh"
fi

# ── faur modify CLI harness ──────────────────────────────────
if bash "$here/faur-modify.test.sh"; then
  pass "faur-modify.test.sh"
else
  fail "faur-modify.test.sh"
fi

# ── builder flow behavioral harness ────────────────────────────
if bash "$here/faur-behavior.test.sh"; then
  pass "faur-behavior.test.sh"
else
  fail "faur-behavior.test.sh"
fi

# ── faur import CLI + clean-env harness ─────────────────────
if bash "$here/faur-import.test.sh"; then
  pass "faur-import.test.sh"
else
  fail "faur-import.test.sh"
fi

# ── runtime isolation harness (Tests A/B/C) ────────────
if bash "$here/isolation.test.sh"; then
  pass "isolation.test.sh"
else
  fail "isolation.test.sh"
fi


echo
echo "All faur tests passed."
