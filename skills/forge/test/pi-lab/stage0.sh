#!/usr/bin/env bash
# Reproduces the stage-0 verification (#60) against the installed `pi`, with
# no model calls: a fake host agent directory, a target-shaped project with no
# Faur in it, a stub MCP server and a scripted fake model. Results are recorded
# in docs/architecture-audit.md §5 "Stage 0 results".
#
#   bash skills/forge/test/pi-lab/stage0.sh [lab-dir]
#
# Needs network once (npm installs of pi-mcp-adapter@2.32.1 and pi-subagents).
# It never touches ~/.pi/agent: every run sets PI_CODING_AGENT_DIR.
# Skills in ~/.agents/skills are read from the real home and appear in counts.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAB=${1:-$(mktemp -d)}
mkdir -p "$LAB" && LAB=$(cd "$LAB" && pwd)
PORT=${FAKE_PORT:-28555}
echo "lab: $LAB (pi $(pi --version))"

# ---- fixture ---------------------------------------------------------------
stub() { echo "{ \"command\": \"node\", \"args\": [\"$HERE/mcp-stub.mjs\", \"$1\"], \"exposure\": \"direct\"$2 }"; }
skill() { mkdir -p "$1/$2"; printf -- '---\nname: %s\ndescription: %s\n---\n%s\n' "$2" "$3" "$3" > "$1/$2/SKILL.md"; }

host=$LAB/host; mkdir -p "$host"
echo '{ "packages": ["npm:pi-mcp-adapter@2.32.1", "npm:pi-subagents@0.65.0"] }' > "$host/settings.json"
echo "{ \"mcpServers\": { \"hostsrv\": $(stub hostsrv '') } }" > "$host/mcp.json"
echo 'HOST-AGENTS: global instruction.' > "$host/AGENTS.md"
echo 'HOST-APPEND: global appended prompt.' > "$host/APPEND_SYSTEM.md"
skill "$host/skills" host-skill 'A global skill'

echo 'PARENT-AGENTS: instruction from the directory the project sits in.' > "$LAB/AGENTS.md"
proj=$LAB/proj; mkdir -p "$proj/.pi/agents" "$proj/.pi/extensions" "$proj/.pi-home"
echo '{ "packages": ["npm:pi-subagents@0.83.1"], "defaultTools": ["read", "ls", "subagent"] }' > "$proj/.pi/settings.json"
echo "{ \"mcpServers\": { \"projsrv\": $(stub projsrv ', "toolExposure": { "projsrv_secret": "hidden" }') } }" > "$proj/.pi/mcp.json"
echo 'PROJECT-APPEND: generated capability section.' > "$proj/.pi/APPEND_SYSTEM.md"
echo 'PROJECT-AGENTS: project instructions.' > "$proj/AGENTS.md"
skill "$proj/.pi/skills" demo 'A project skill'
cat > "$proj/.pi/extensions/hello.ts" <<'EOF'
import { Type } from "typebox";
export default function (pi: any) {
  pi.registerTool({ name: "hello_tool", label: "hello", description: "project extension tool", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "hello" }], details: {} }; } });
}
EOF
worker() { printf -- '---\nname: worker\ndescription: A specialist\ntools: %s\nmodel: fake/m\n---\nYou are the worker.\n' "$1" > "$proj/.pi/agents/worker.md"; }
worker 'read, mcp:projsrv'
# The fake provider for child processes, which do not load -e extensions.
echo "{ \"providers\": { \"fake\": { \"baseUrl\": \"http://127.0.0.1:$PORT/v1\", \"apiKey\": \"fake\", \"api\": \"openai-completions\", \"models\": [{ \"id\": \"m\", \"name\": \"fake\", \"reasoning\": false, \"input\": [\"text\"], \"contextWindow\": 100000, \"maxTokens\": 1000 }] } } }" > "$proj/.pi-home/models.json"

neutral=$LAB/proj-neutral; rm -rf "$neutral"; cp -r "$proj" "$neutral"; rm -rf "$neutral/.pi-home"
echo '{ "packages": ["npm:pi-subagents@0.83.1", { "source": "npm:pi-mcp-adapter@2.32.1", "extensions": [], "skills": [], "prompts": [], "themes": [] }], "defaultTools": ["read", "ls", "subagent"] }' > "$neutral/.pi/settings.json"

untrusted=$LAB/proj-untrusted; mkdir -p "$untrusted/.pi"
echo "{ \"mcpServers\": { \"evil\": { \"command\": \"node\", \"args\": [\"-e\", \"require('fs').writeFileSync('$LAB/UNTRUSTED-SPAWNED', '1')\"] } } }" > "$untrusted/.pi/mcp.json"

echo '-- installing packages'
(cd "$proj" && PI_CODING_AGENT_DIR=$host pi update --extensions --approve >/dev/null 2>&1)
(cd "$proj" && PI_CODING_AGENT_DIR=$proj/.pi-home pi update --extensions --approve >/dev/null 2>&1)
(cd "$neutral" && PI_CODING_AGENT_DIR=$host pi update --extensions --approve >/dev/null 2>&1)

# ---- runners ---------------------------------------------------------------
# Stdin is closed: `pi -p` waits for stdin EOF when stdin is not a terminal.
probe() { # name agent-dir project-dir [pi args]
  local name=$1 home=$2 dir=$3; shift 3
  (cd "$dir" && PI_CODING_AGENT_DIR=$home PROBE_OUT=$LAB/$name.json timeout 90 \
    pi -p --no-session -e "$HERE/probe.ts" --model probe/m "$@" hi </dev/null >/dev/null 2>"$LAB/$name.err")
  echo "== $name"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const base = s => s.split("/").slice(-2).join("/");
    console.log("  context files:", j.contextFiles.map(base).join(", ") || "-");
    console.log("  prompt markers:", j.markers.join(", ") || "-");
    console.log("  skills:", j.skills.filter(s => ["demo", "host-skill"].includes(s)).join(", ") || "-", `(+${j.skills.filter(s => !["demo", "host-skill"].includes(s)).length} from packages or ~/.agents/skills)`);
    console.log("  mcp tools:", j.tools.filter(t => /^mcp/.test(t)).join(" | ") || "-");
    console.log("  subagent:", j.tools.filter(t => t.startsWith("subagent ")).join(" | ") || "-");
  ' "$LAB/$name.json" 2>/dev/null || echo "  no probe output (see $LAB/$name.err)"
  grep -q 'built-in extension `mcp` was not loaded' "$LAB/$name.err" && echo '  warning: built-in mcp not loaded (an extension registers /mcp)'
}

fake() { # name agent-dir project-dir script-json [pi args]
  local name=$1 home=$2 dir=$3 script=$4; shift 4
  echo "$script" > "$LAB/$name.script.json"; : > "$LAB/$name.log"
  FAKE_PORT=$PORT FAKE_SCRIPT=$LAB/$name.script.json FAKE_LOG=$LAB/$name.log node "$HERE/fake-model.mjs" & local srv=$!
  sleep 0.5
  (cd "$dir" && FAKE_PORT=$PORT PI_CODING_AGENT_DIR=$home timeout 120 \
    pi --no-session -e "$HERE/fake-provider.ts" --model fake/m "$@" </dev/null >"$LAB/$name.out" 2>"$LAB/$name.err")
  local rc=$?; sleep "${AFTER:-0}"; kill $srv 2>/dev/null; wait $srv 2>/dev/null
  echo "== $name (exit $rc)"
  node -e '
    for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
      const j = JSON.parse(l), who = j.tools.includes("subagent") ? "lead " : "child";
      console.log(`  req ${j.n} ${who} tools=${j.tools.filter(t => /^(mcp|hello)/.test(t)).join(",") || "-"} markers=${j.markers.join(",") || "-"}${j.lastToolResult ? ` result=${JSON.stringify(j.lastToolResult.slice(0, 110))}` : ""}`);
    }' "$LAB/$name.log"
}

# ---- 1-2. Global merging (plain) and isolation -------------------------------
probe A_plain_host_with_adapter "$host" "$proj" --approve
cp -r "$host" "$LAB/host-noadapter"; echo '{ "packages": ["npm:pi-subagents@0.65.0"] }' > "$LAB/host-noadapter/settings.json"
probe B_plain_host_without_adapter "$LAB/host-noadapter" "$proj" --approve
probe C_plain_project_neutralizes_adapter "$host" "$neutral" --approve
probe D_isolated "$proj/.pi-home" "$proj" --approve
probe E_plain_trust_undecided "$host" "$proj"
probe F_isolated_trust_undecided "$proj/.pi-home" "$proj"
probe G_isolated_no_context_files "$proj/.pi-home" "$proj" --approve --no-context-files

# ---- Enforcement under a global pi-mcp-adapter --------------------------------
fake H1_hidden_tool_builtin_mcp "$proj/.pi-home" "$proj" '[{"tool":"mcp__projsrv__projsrv_secret"},{"text":"done"}]' -p --approve go
fake H2_hidden_tool_global_adapter "$host" "$proj" '[{"tool":"mcp","args":{"tool":"projsrv_secret","server":"projsrv"}},{"text":"done"}]' -p --approve go
rm -f "$LAB/UNTRUSTED-SPAWNED"
fake U1_untrusted_project_global_adapter "$host" "$untrusted" '[{"tool":"mcp","args":{"tool":"evil_x","server":"evil"}},{"text":"done"}]' -p go
echo "  untrusted project server launched: $([ -f "$LAB/UNTRUSTED-SPAWNED" ] && echo yes || echo no)"
rm -f "$LAB/UNTRUSTED-SPAWNED"
fake U2_untrusted_project_builtin_mcp "$LAB/host-noadapter" "$untrusted" '[{"text":"done"}]' -p go
echo "  untrusted project server launched: $([ -f "$LAB/UNTRUSTED-SPAWNED" ] && echo yes || echo no)"

# ---- 3. pi-subagents children -------------------------------------------------
sub='[{"tool":"subagent","args":{"agent":"worker","task":"say hi","async":ASYNC}},{"tool":"TOOL"},{"text":"child done"},{"text":"lead done"}]'
fake S1_foreground_child_mcp "$proj/.pi-home" "$proj" "$(echo "$sub" | sed 's/ASYNC/false/; s/TOOL/mcp__projsrv__projsrv_ping/')" -p --approve go
worker 'read, hello_tool'
fake S2_foreground_child_extension_tool "$proj/.pi-home" "$proj" "$(echo "$sub" | sed 's/ASYNC/false/; s/TOOL/hello_tool/')" -p --approve go
worker 'read, ./.pi/extensions/hello.ts, hello_tool'
fake S3_foreground_child_extension_path "$proj/.pi-home" "$proj" "$(echo "$sub" | sed 's/ASYNC/false/; s/TOOL/hello_tool/')" -p --approve go
worker 'read, mcp:projsrv'
AFTER=8 fake S4_background_child_prompt "$proj/.pi-home" "$proj" "$(echo "$sub" | sed 's/ASYNC/true/; s/TOOL/mcp__projsrv__projsrv_ping/')" -p --approve go

# ---- R11. Scoping the lead's MCP tools ---------------------------------------
cp "$proj/.pi/settings.json" "$LAB/settings.bak"
echo '{ "packages": ["npm:pi-subagents@0.83.1"], "defaultTools": ["read", "ls", "subagent", "-mcp__*"] }' > "$proj/.pi/settings.json"
fake R11a_defaultTools_minus_mcp "$proj/.pi-home" "$proj" '[{"text":"done"}]' -p --approve go
cp "$LAB/settings.bak" "$proj/.pi/settings.json"
fake R11b_cli_tools_allowlist "$proj/.pi-home" "$proj" '[{"text":"done"}]' -p --approve --tools 'read,ls,subagent,mcp__projsrv__projsrv_ping' go

# ---- 5. Headless ---------------------------------------------------------------
fake Q1_print_skill_expansion "$proj/.pi-home" "$proj" '[{"text":"ok"}]' -p --approve '/skill:demo check the login page'
echo "  first user message: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").split("\n")[0]).firstUser.slice(0,40))' "$LAB/Q1_print_skill_expansion.log")"
fake Q2_print_success "$proj/.pi-home" "$proj" '[{"text":"FINAL ANSWER"}]' -p --approve go
echo "  stdout: $(cat "$LAB/Q2_print_success.out")"
fake Q3_print_provider_error "$proj/.pi-home" "$proj" '[{"status":500}]' -p --approve go
echo "  stdout: '$(cat "$LAB/Q3_print_provider_error.out")'  stderr: $(grep -v '^$' "$LAB/Q3_print_provider_error.err" | tail -1)"
fake Q4_json_success "$proj/.pi-home" "$proj" '[{"text":"FINAL ANSWER"}]' --mode json --approve go
echo "  last records: $(node -e 'console.log(require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).slice(-2).map(l => JSON.parse(l).type).join(", "))' "$LAB/Q4_json_success.out")"
