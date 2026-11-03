#!/usr/bin/env bash
# Launcher integration tests — verify the generated `run` script with a MOCKED
# `pi` executable (no model, no credentials, no network). Proves: correct
# working directory, isolated env, argument forwarding, exit-code passthrough,
# and explicit failure when the project model is missing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
forge="$here/../forge.mjs"
fixtures="$here/fixtures/generate/minimal"

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
exit "${FAKE_PI_EXIT:-0}"
EOF
chmod +x "$bin/pi"

# ── Generate a real project so we exercise the emitted `run` ────
proj="$work/project"
mkdir -p "$proj/.pi"
cp "$fixtures/.pi/system.yaml" "$proj/.pi/system.yaml"
node "$forge" generate "$proj" >/dev/null 2>&1
[[ -x "$proj/run" ]] || fail "generate did not emit an executable run launcher"

# ── Run from a DIFFERENT directory, with the fake pi on PATH ────
export LAUNCHER_LOG="$work/log"
: > "$LAUNCHER_LOG"
export PATH="$bin:$PATH"

(cd "$work" && "$proj/run" alpha "two words")
grep -Fq "cwd=$proj" "$LAUNCHER_LOG" || fail "launcher did not cd into the project root"
grep -Fq "agent_dir=$proj/.forge/pi-home" "$LAUNCHER_LOG" || fail "launcher did not set the isolated agent dir"
# Pi finds .pi/APPEND_SYSTEM.md and AGENTS.md itself; the launcher adds no prompt or context flags.
grep -Fxq 'args=--approve alpha two words' "$LAUNCHER_LOG" || fail "launcher did not forward arguments unchanged"
pass "launcher: cwd/env/args correct from an arbitrary working directory"

# ── Exit code passthrough ───────────────────────────────────────
set +e
(export FAKE_PI_EXIT=7; cd "$work" && "$proj/run") 2>/dev/null
code=$?
set -e
[[ $code -eq 7 ]] || fail "launcher did not preserve the fake pi exit code (got $code)"
pass "launcher: preserves pi exit code"

# ── Explicit failure when the project model is missing ──────────
rm "$proj/.pi/system.yaml"
: > "$LAUNCHER_LOG"
if (cd "$work" && "$proj/run" anything) 2>/dev/null; then
  fail "launcher must fail when .pi/system.yaml is missing"
fi
if grep -q 'cwd=' "$LAUNCHER_LOG"; then
  fail "launcher must not invoke pi when the project model is missing"
fi
pass "launcher: fails before invoking pi when .pi/system.yaml is missing"

# ── Declared env names load from .env; nothing in it executes ──
envproj="$work/envproj"
mkdir -p "$envproj/.pi"
cat > "$envproj/.pi/system.yaml" <<'YAML'
schema: 1
name: env-launcher
orchestrator:
  name: lead
  model: provider-a/model-large
integrations:
  env:
    - name: GITHUB_PAT
      secret: true
    - name: QUOTED
    - name: PRESET
YAML
node "$forge" generate "$envproj" >/dev/null 2>&1
marker="$work/pwned"
cat > "$envproj/.env" <<ENVFILE
# comment
GITHUB_PAT=abc=def \$(touch $marker) \`touch $marker\`
export QUOTED="hello world"
PRESET=from-file
NODE_OPTIONS=--require=/nonexistent.js
ENVFILE
cat > "$bin/pi" <<'EOF'
#!/usr/bin/env bash
env | grep -E '^(GITHUB_PAT|QUOTED|PRESET|NODE_OPTIONS|FORGE_ENV_NAMES|forge_)=' | sort > "$LAUNCHER_LOG"
EOF
PRESET=from-shell "$envproj/run"
[[ ! -e "$marker" ]] || fail "launcher executed content from .env"
expected="GITHUB_PAT=abc=def \$(touch $marker) \`touch $marker\`
PRESET=from-shell
QUOTED=hello world"
[[ "$(cat "$LAUNCHER_LOG")" == "$expected" ]] || fail "launcher .env loading wrong: $(cat "$LAUNCHER_LOG")"
pass "launcher: loads only declared .env names, never executes them, shell values win"

echo
echo "All launcher tests passed."
