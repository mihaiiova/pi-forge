# Headless workflow invocation

> **Direction (2026-11-02):** this `./run --workflow` contract belongs to the
> current release. Generated projects are moving to plain `pi -p` invocation;
> caller concerns (timeouts, cancellation, structured results, artifacts) move
> to an optional caller-side adapter outside generated projects, and the runner
> is removed only after its consumers (Revisor's MCP server) have moved. See
> `docs/architecture-audit.md` §5 (R16).

Generated projects run declared workflows with `./run --workflow <name>`.
Repeat `--input key=value` to pass input data. `--timeout` accepts integer
seconds, minutes or hours (`30m` by default); `--allow-concurrent` bypasses
the default per-workflow lock. The last stdout line is JSON with `workflow`,
`runId`, `status` (`ok`, `error`, `blocked`, `timeout`, `cancelled` or
`configuration_error`), `answer`, `toolErrors`, and, when applicable,
`message`. Exit codes are 0 (success), 1 (agent failure, or cancelled),
2 (configuration or lock failure), 3 (approval required), and 4 (timeout).

A run fails when Pi exits with an error, its final message ended in an error
or was aborted, or there is no answer. Tool errors the agent recovered from
do not fail the run; `toolErrors` counts them. Stopping `./run` (SIGTERM,
SIGINT or SIGHUP), as a caller cancelling does, stops the workflow and
reports `cancelled`.

The runner is `skills/forge/workflow-runner.mjs` in the Forge package pinned
in `.pi/settings.json`, which Pi installs under `.pi/git/`; nothing is copied
into the project, and the runner changes only when the pin moves. It
validates `.pi/system.yaml` with that same package, tolerating what Forge
itself tolerates, before starting Pi. Run interactive `./run` once to install
the project packages before the first headless run; until then, and when the
configuration is invalid, a run fails closed with exit 2 and no model turn.
After changing declarations, regenerate the project so its launcher reflects
them.

The per-workflow lock is a file in `.forge/workflow-locks/` holding the
runner's pid, so it works on Linux and macOS alike. A lock whose holder has
died is taken over.

Pi print mode expands `/skill:<name> ...` before starting the agent. The
`workflow-print-mode.test.mjs` test verifies this with the installed Pi and a
scripted provider. Pi's built-in MCP has no Forge approval gate of its own:
Forge's runtime blocks `approveTools` calls without a UI, as verified with the
stdio MCP fixture in `mcp-runtime.test.mjs`. Named invocation is handled by
the launcher to validate the workflow, inputs, timeout and concurrency and to
return a structured result. When a workflow has a skill it is invoked through
Pi's skill command; a specialist entry and the declared boundaries are passed
to the orchestrator as instructions. Delegation is model-directed, not a hard
guarantee.

The launcher exports `FORGE_WORKFLOW`, `FORGE_TRIGGER=headless`, and a unique
`FORGE_RUN_ID`. pi-subagents 0.83.1 does not consume the Forge run ID: its
`status.json` uses the Pi session file path, or the Pi session UUID when no
session file exists. Forge instead gives every invocation a private
`PI_SUBAGENTS_TEMP_ROOT`; both top-level and nested pi-subagents runs use that
root. Timeout and approval cleanup requests stop through the pinned version's
stop-request inbox and waits for recorded runs to stop. Unconfirmed cleanup is
reported as `cleanup: "incomplete"`, with the retained `stateDir` for diagnosis.
The inbox protocol and status layout are version-specific and must be rechecked
when the pi-subagents pin changes.

On Linux, when a test invocation of `systemd-run --user --scope` succeeds,
Forge runs Pi in its own uniquely named user scope and stops that scope on
exit. Otherwise it terminates the process group and stops the invocation-owned
pi-subagents runs. Independently detached processes outside pi-subagents can
survive the fallback. Neither a scope nor the cleanup protocol can guarantee
termination of work moved to another machine or outside its ownership boundary.

To exercise the actual pinned pi-subagents runner without a model call, point
`FORGE_SUBAGENTS_PACKAGE` at an installed or extracted pi-subagents 0.83.1
package, with its dependencies available, and run:

```sh
FORGE_SUBAGENTS_PACKAGE=/path/to/pi-subagents node --test \
  --test-name-pattern='timeout stops a real' skills/forge/test/workflow-launcher.test.mjs
FORGE_TEST_SCOPE=1 FORGE_SUBAGENTS_PACKAGE=/path/to/pi-subagents node --test \
  --test-name-pattern='timeout stops a real' skills/forge/test/workflow-launcher.test.mjs
```

The first command forces the fallback; the second requires a usable user
systemd scope and verifies the actual Pi process's cgroup contains the Forge
scope. The ordinary launcher tests also exercise fallback isolation,
process-group termination, and scope cleanup when a user scope is available.

The live-model workflow fixture is opt-in; it uses the configured model and
provider key from the environment, so it can incur API cost:

```sh
RUN_FACTORY_LIVE_TESTS=1 FORGE_LIVE_MODEL=provider/model node --test \
  skills/forge/test/workflow-live.test.mjs
```

Export the provider's API key as well. The generated project's Pi home is
isolated, so credentials stored only in the host Pi home are not inherited.
