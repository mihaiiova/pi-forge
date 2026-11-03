#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
forge="$root/skills/forge/forge.mjs"
fixtures="$root/skills/forge/test/fixtures"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ── forge import reconstructs system.yaml and preserves files ─
mkdir -p "$work/.pi"
cat > "$work/.pi/settings.json" <<'JSON'
{
  "defaultProvider": "provider-a",
  "defaultModel": "model-large",
  "defaultThinkingLevel": "medium",
  "defaultTools": ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent"],
  "spec": { "baseBranch": "development" }
}
JSON
mkdir -p "$work/.pi/agents" "$work/.pi/skills/house-style"
cat > "$work/.pi/agents/scout.md" <<'MD'
---
name: scout
description: Read-only discovery
tools: read, grep
model: provider-b/model-small
thinking: low
skills: house-style
---
Investigate.
MD
cat > "$work/.pi/skills/house-style/SKILL.md" <<'MD'
---
name: house-style
description: Write plainly
---
Write plainly.
MD

node "$forge" import "$work" >"$work/import.log" 2>"$work/import.err" || fail "import should exit 0"
[[ -f "$work/.pi/system.yaml" ]] || fail "import did not write .pi/system.yaml"
grep -q "spec" "$work/import.err" || fail "import report did not flag the spec block"
node "$forge" validate "$work" >/dev/null || fail "imported system.yaml does not validate"
node --input-type=module -e "
  import { loadYaml } from '$root/skills/forge/yaml-loader.mjs';
  import { readFileSync } from 'node:fs';
  const doc = loadYaml().parse(readFileSync(process.argv[1], 'utf-8'));
  const scout = doc.agents.find((a) => a.name === 'scout');
  if (doc.orchestrator.model !== 'provider-a/model-large') process.exit(1);
  if (scout.model !== 'provider-b/model-small' || scout.thinking !== 'low' || scout.skills[0] !== 'house-style') process.exit(1);
  if (doc.skills[0].source !== './.pi/skills/house-style') process.exit(1);
  if ('workflows' in doc || 'models' in doc) process.exit(1);
" "$work/.pi/system.yaml" || fail "import did not carry over per-agent models and skills"
pass "forge import reconstructs a valid system.yaml and reports flags"

# ── import never overwrites an existing system.yaml ────────────
if node "$forge" import "$work" >/dev/null 2>&1; then
  fail "second import should refuse (system.yaml already exists)"
fi
pass "forge import refuses to overwrite an existing system.yaml"

# ── clean-environment (deterministic): pinned packages ─────────
gen="$(mktemp -d)"
cp -r "$fixtures/coding-agent/.pi" "$gen/.pi"
node "$forge" generate "$gen" >/dev/null
node -e '
const s = require(process.argv[1]);
const version = require(process.argv[2]).version;
const expect = ["npm:pi-subagents@0.83.1"]; // never Faur; specialists bring pi-subagents
if (JSON.stringify(s.packages) !== JSON.stringify(expect)) {
  console.error("packages = " + JSON.stringify(s.packages));
  process.exit(1);
}
' "$gen/.pi/settings.json" "$root/package.json" || fail "generated settings.json missing minimal runtime packages"
rm -rf "$gen"
pass "clean-env: generated settings.json declares only the runtime primitives"

# ── clean-environment (gated): isolated install + run ──────────
# The full isolation test (copy to a clean env → install declared deps → `pi`
# resolves orchestrator/agents/skills/workflows) requires a clean `pi` install
# and network; skip when unavailable, without weakening the deterministic
# packages assertion above.
if command -v pi >/dev/null 2>&1 && [[ -n "${RUN_CLEAN_ENV_TEST:-}" ]]; then
  iso="$(mktemp -d)"
  cp -r "$fixtures/coding-agent/.pi" "$iso/.pi"
  node "$forge" generate "$iso" >/dev/null
  if out="$(cd "$iso" && timeout 90 pi -p "describe yourself" 2>&1)"; then
    pass "clean-env: generated coding-agent runs headlessly in an isolated dir"
  else
    fail "clean-env: pi -p failed on the generated project (RUN_CLEAN_ENV_TEST=1)"
  fi
  rm -rf "$iso"
else
  echo "ok - clean-env isolated run SKIPPED (set RUN_CLEAN_ENV_TEST=1 and ensure 'pi' + network)"
fi

echo
echo "All forge-import tests passed."
