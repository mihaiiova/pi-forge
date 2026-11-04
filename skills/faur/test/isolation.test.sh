#!/usr/bin/env bash
# Runtime isolation harness.
#
# Three distinct categories, named to state exactly what each proves:
#   A. Deterministic generation  — file-level checks; no Pi, network, or model.
#   B. Launcher integration       — mocked `pi`; covered by launcher.test.sh.
#   C. Real Pi integration        — pi-gated; SKIP-with-reason, never passed.
#
# Generation inspection proves generated-configuration correctness only.
# A mocked pi proves launcher behavior. A real pi process establishes actual
# resource loading. These are deliberately not conflated.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
faur="$here/../faur.mjs"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }
skip() { echo "ok - $1 SKIPPED ($2)"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/.pi"
cat > "$work/.pi/system.yaml" <<'YAML'
schema: 1
name: iso-seo-demo
description: "Isolation test system"
orchestrator:
  name: orchestrator
  description: "Primary SEO coordinator"
  prompt: "Coordinate the SEO system. Delegate analysis to the analyst.\n"
  model: provider-a/model-medium
  thinking: high
  tools: [read, grep, find, ls, bash, edit, write, subagent]
agents:
  - name: analyst
    description: "Read-only analyst"
    tools: [read, grep, find, ls]
    model: provider-b/model-small
    thinking: high
    prompt: "Analyze and report. You are read-only.\n"
skills:
  - name: draft
    description: "Draft an article"
    body: |
      # Draft
      Draft an article.
integrations:
  mcp:
    - name: openseo
      config: { url: "http://localhost:3002/mcp" }
YAML

node "$faur" generate "$work" >/dev/null 2>&1

# ── A. Deterministic generation (no Pi / network / model) ────────

# A1: generation produces the declared project tree.
[[ -f "$work/run" ]] || fail "A: run launcher not generated"
[[ -f "$work/.pi/settings.json" ]] || fail "A: settings.json not generated"
[[ -f "$work/.pi/agents/analyst.md" ]] || fail "A: analyst agent not generated"
[[ -f "$work/.pi/skills/draft/SKILL.md" ]] || fail "A: draft skill not generated"
pass "A: deterministic generation produces the declared project tree"

# A2: undeclared host capabilities are excluded from generated config, and
# the project never pins Faur.
node -e 'const s=require(process.argv[1]); if((s.packages||[]).some(p=>/pi-config|faur|pi-web-access|yaml/.test(p))) process.exit(1)' "$work/.pi/settings.json" \
  || fail "A: runtime packages carry Faur, the host faur, pi-web-access or yaml"
node -e 'const m=require(process.argv[1]); const n=Object.keys(m.mcpServers||{}); if(n.some(x=>x==="owlie"||x==="cloudflare")) process.exit(1)' "$work/.pi/mcp.json" \
  || fail "A: global MCP servers leaked into .pi/mcp.json"
node -e 'const s=require(process.argv[1]); const t=s.defaultTools||[]; if(t.includes("web_search")||t.includes("fetch_content")) process.exit(1)' "$work/.pi/settings.json" \
  || fail "A: orchestrator defaultTools leaks web tools"
pass "A: undeclared skills/MCP/web/packages are excluded from generated config"

# A3: dependency selection emits only the runtime packages the design uses.
node -e 'const s=require(process.argv[1]); const e=["npm:pi-subagents@0.83.1"]; if(JSON.stringify(s.packages)!==JSON.stringify(e)) process.exit(1)' "$work/.pi/settings.json" \
  || fail "A: runtime primitives missing or extra packages present"
pass "A: dependency selection emits only the declared runtime primitives"

# A4: regeneration is idempotent (this proves idempotency, NOT session resume).
first="$(node -e 'const s=require(process.argv[1]); process.stdout.write(JSON.stringify(s.packages))' "$work/.pi/settings.json")"
node "$faur" generate "$work" --yes >/dev/null 2>&1
second="$(node -e 'const s=require(process.argv[1]); process.stdout.write(JSON.stringify(s.packages))' "$work/.pi/settings.json")"
[[ "$first" == "$second" ]] || fail "A: regeneration drifted the packages list"
pass "A: regeneration is idempotent (no config drift)"

# A5: subagent allowlists enforce declared tool boundaries.
grep -Pzq 'tools:\n  - read\n  - grep\n  - find\n  - ls\n' "$work/.pi/agents/analyst.md" || fail "A: analyst allowlist wrong"
if grep -q 'tools: .*write' "$work/.pi/agents/analyst.md"; then fail "A: analyst allowlist grants write"; fi
pass "A: subagent allowlists enforce declared tool boundaries"

# A6: the effective-capability manifest is written and reflects the model.
[[ -f "$work/.faur/capabilities.json" ]] || fail "A: capabilities manifest not written"
node -e '
const fs = require("fs");
const caps = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(caps.orchestratorTools)) process.exit(1);
if (!Array.isArray(caps.agents) || caps.agents.length !== 1) process.exit(1);
if (!Array.isArray(caps.mcpServers) || caps.mcpServers[0].name !== "openseo") process.exit(1);
if (!caps.packages.includes("npm:pi-subagents@0.83.1")) process.exit(1);
' "$work/.faur/capabilities.json" \
  || fail "A: capabilities manifest missing or does not reflect the model"
pass "A: effective-capability manifest is written and reflects the model"

# ── B. Launcher integration (mocked pi — no model/credentials) ──
# The launcher itself is asserted by test/launcher.test.sh; run it here so the
# B category fails loudly if that harness regresses.
if bash "$here/launcher.test.sh"; then
  pass "B: launcher startup behavior (cwd/env/args/exit) verified with a mocked pi"
else
  fail "B: launcher.test.sh failed"
fi

# ── C. Real Pi integration (pi-gated; SKIP-with-reason, never pass) ──
if command -v pi >/dev/null 2>&1; then
  if out="$(cd "$work" && PI_OFFLINE=1 PI_CODING_AGENT_DIR="$work/.faur/pi-home" timeout 60 pi mcp list 2>&1)"; then
    if grep -qi 'owlie\|cloudflare' <<<"$out"; then
      fail "C: real pi under isolation still reports host MCP servers"
    fi
    pass "C: real pi under isolation omits host MCP servers"
  else
    fail "C: real pi mcp list failed under isolation ($out)"
  fi
else
  skip "C: real pi under isolation omits host MCP servers" "pi not on PATH"
fi

echo
echo "All isolation tests passed."
