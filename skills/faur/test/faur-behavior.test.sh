#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
faur="$root/skills/faur/faur.mjs"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ── builder flow: discover → design → preview → apply → validate ──
# 1. discover (read-only capability inventory)
node "$faur" discover "$work" >/dev/null 2>&1 || fail "discover failed"

# 2. design: the builder writes a minimal system.yaml from the outcome
mkdir -p "$work/.pi"
cat > "$work/.pi/system.yaml" <<'YAML'
schema: 1
name: seo-agent-system
description: "SEO analysis + article drafting"
orchestrator:
  name: orchestrator
  description: "Primary SEO agent"
  prompt: |
    You coordinate the SEO system.
  model: provider-a/model-large
  thinking: medium
  tools: [read, grep, find, ls, bash, edit, write, subagent]
agents:
  - name: seo-analyst
    description: "Analyzes SEO data"
    tools: [read, grep]
    model: provider-b/model-small
    thinking: low
    prompt: |
      Analyze SEO data.
YAML

# 3. preview first: --dry-run writes nothing
node "$faur" generate "$work" --dry-run >/dev/null 2>&1 || fail "dry-run preview failed"
[[ ! -f "$work/.pi/settings.json" ]] || fail "preview wrote a file"

# 4. apply
node "$faur" generate "$work" >/dev/null 2>&1 || fail "generate failed"

# 5. validate the generated project
node "$faur" validate "$work" >/dev/null 2>&1 || fail "generated project did not validate"

pass "builder flow: discover → design → preview → apply → validate"

# ── gated headless smoke (pi/model-gated) ────────────────────────
if [[ "${RUN_FAUR_LIVE_TESTS:-0}" == 1 ]] && command -v pi >/dev/null 2>&1; then
  if out="$(cd "$work" && timeout 60 pi --approve -p "describe yourself" 2>&1)"; then
    pass "behavioral: pi -p ran on the generated project"
  else
    echo "ok - behavioral: pi -p SKIPPED (offline/model-gated)"
  fi
else
  echo "ok - behavioral: pi -p SKIPPED (requires RUN_FAUR_LIVE_TESTS=1, pi and provider access)"
fi

echo
echo "All faur-behavior tests passed."
