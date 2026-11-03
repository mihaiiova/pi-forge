<!-- forge:generated v1 sha256=750a5a66ddec27b3c3728cf086f42851751985223b346a5747760d530790b1b4 -->
# seo-agent-system

SEO analysis + article drafting with specialist subagents

## Run

The generated `./run` launcher is the entry point. It starts Pi with the
project's own Pi configuration and logins, without your global Pi settings,
MCP servers or extensions. Your environment, including any credentials in
it, is inherited, and it is not an OS sandbox. Skills in the shared Agent
Skills folder (`~/.agents/skills/`) and `AGENTS.md` files in parent folders
do load, for the orchestrator. Plain `pi` in this folder runs the same
project with your global Pi configuration added.

```sh
./run             # interactive
./run -p "..."   # headless one-shot
./run --workflow analyze-and-draft
```

Named workflow runs accept `--input key=value` (repeatable), `--timeout 30m`
(default 30m; units s, m or h), and `--allow-concurrent` to bypass the
default per-workflow lock. They require Node.js, and run the workflow runner
from the Forge package pinned in `.pi/settings.json`.
Run interactive `./run` once to install project packages before the first
named workflow; its installed Forge package validates system.yaml before Pi starts.
Regenerate after changing declarations so derived files stay current.
The final stdout line is JSON with workflow, runId, status, answer and
an optional message. Exit codes: 0 success, 1 agent/tool failure,
2 configuration/lock failure, 3 approval required, 4 timeout.
When available, Forge starts a private systemd user scope and stops it on
exit. The fallback is process-group termination plus stop requests for
pi-subagents runs in this invocation's isolated temporary state. The result
reports `cleanup: incomplete` and retains `stateDir` if cleanup is unconfirmed.
Independently detached processes can survive the fallback cleanup.
Approval is never granted unattended. Entry delegation and boundary
instructions are model-directed, not a hard guarantee of execution.

On the first interactive run, Pi may start npm package installation processes
that continue briefly after Pi exits and may keep output pipes open. Callers
should allow extra time before assuming the output stream has closed.

Authenticate inside `./run` with `/login`, or export
the provider-specific key (for example `DEEPSEEK_API_KEY`). See the policy
section below for which
capabilities are enforced vs advisory.

## Maintain

`/faur <request>` proposes a change; when the turn ends, Forge asks you
to discuss, apply or discard it. Replies continue the conversation until
then; `/faur exit` leaves. `/faur review` is read-only.
`/faur check` verifies the agent, `/faur status` summarizes it, and
`/faur sync` moves to the newest Forge release after two confirmations.
Roll back with git. `/faur permissions` lists the commands agents may run
and adds, removes or reviews them; agents ask for a command they need with
`request_permission`. Restart `./run` when the launcher or packages change.

## Policy

### Enforced by Pi's tool layer

None declared.

### Advisory (guidance — not enforced)

None declared.
