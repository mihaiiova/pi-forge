#!/usr/bin/env bash
# Launcher integration tests — verify the generated `run` script with a MOCKED
# `pi` executable (no model, no credentials, no network). Proves: correct
# working directory, isolated Pi configuration directory, arguments forwarded
# unchanged, exit-code passthrough, no design record needed, no .env loading.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
faur="$here/../faur.mjs"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ── Fake pi executable that records its invocation ──────────────
bin="$work/bin"
mkdir -p "$bin"
cat > "$bin/pi" <<'EOF'
#!/usr/bin/env bash
printf 'cwd=%s\n' "$PWD" >> "$LAUNCHER_LOG"
printf 'agent_dir=%s\n' "${PI_CODING_AGENT_DIR:-}" >> "$LAUNCHER_LOG"
printf 'args=%s\n' "$*" >> "$LAUNCHER_LOG"
printf 'token=%s\n' "${API_TOKEN:-unset}" >> "$LAUNCHER_LOG"
exit "${FAKE_PI_EXIT:-0}"
EOF
chmod +x "$bin/pi"

# ── Generate a real project whose design gets `run` (an MCP server) ──
proj="$work/project"
mkdir -p "$proj/.pi"
cat > "$proj/.pi/system.yaml" <<'YAML'
schema: 1
name: launcher-test
orchestrator:
  name: lead
  model: provider-a/model-large
  tools: [read, mcp]
integrations:
  env:
    - name: API_TOKEN
      secret: true
  mcp:
    - name: docs
      config:
        url: http://localhost:3002/mcp
YAML
node "$faur" generate "$proj" >/dev/null 2>&1
[[ -x "$proj/run" ]] || fail "generate did not emit an executable run launcher"

export LAUNCHER_LOG="$work/log"
export PATH="$bin:$PATH"

# ── Run from a DIFFERENT directory, with the fake pi on PATH ────
: > "$LAUNCHER_LOG"
(cd "$work" && "$proj/run" alpha "two words")
grep -Fxq "cwd=$proj" "$LAUNCHER_LOG" || fail "launcher did not cd into the project root"
grep -Fxq "agent_dir=$proj/.faur/pi-home" "$LAUNCHER_LOG" || fail "launcher did not set the isolated agent dir"
# Pi finds the prompt, context files and project trust itself; nothing is added.
grep -Fxq 'args=alpha two words' "$LAUNCHER_LOG" || fail "launcher did not forward arguments unchanged"
pass "launcher: cwd/env/args correct from an arbitrary working directory"

# ── Exit code passthrough ───────────────────────────────────────
set +e
(cd "$work" && FAKE_PI_EXIT=7 "$proj/run" >/dev/null 2>&1)
code=$?
set -e
[[ $code -eq 7 ]] || fail "launcher did not preserve the fake pi exit code (got $code)"
pass "launcher: preserves pi exit code"

# ── No design record needed, no .env read ───────────────────────
mv "$proj/.pi/system.yaml" "$work/system.yaml"
printf 'API_TOKEN=from-dotenv\n' > "$proj/.env"
: > "$LAUNCHER_LOG"
(cd "$work" && "$proj/run" beta)
grep -Fxq 'args=beta' "$LAUNCHER_LOG" || fail "launcher needs .pi/system.yaml"
grep -Fxq 'token=unset' "$LAUNCHER_LOG" || fail "launcher loaded .env"
: > "$LAUNCHER_LOG"
(cd "$work" && API_TOKEN=from-shell "$proj/run" beta)
grep -Fxq 'token=from-shell' "$LAUNCHER_LOG" || fail "launcher did not pass the caller's environment"
pass "launcher: runs without system.yaml; variables come from the caller's environment, never .env"

echo ""
echo "All launcher tests passed."
