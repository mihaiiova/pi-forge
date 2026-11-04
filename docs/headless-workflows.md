# Headless workflow invocation

Changed by #62 (2026-11-03): the `./run --workflow` runner is removed. A
workflow is a skill, and Pi runs it in print or JSON mode. Generated projects
contain no workflow logic.

## Invocation

```sh
cd <project>
pi --approve -p "/skill:<workflow> <request>"     # plain pi
```

- **The skill.** A workflow declared with `skill:` runs that skill. A
  workflow declared with only `entry:` gets a generated skill named after it
  (`.pi/skills/<workflow>/SKILL.md`), which states the boundary: entry agent,
  available agents, inputs, outputs, approval and verify. Pi expands the skill
  before the agent starts (`workflow-print-mode.test.mjs`).
- **The request** is the text after the skill command: paths, URLs, names,
  scenarios. The skill tells the agent to treat it as data. There is no
  separate `--input key=value`.
- **Trust.** Print, JSON and RPC mode cannot ask the trust question; with no
  saved decision they skip every project resource without an error. Pass
  `--approve`, or save the decision once with `/trust` in an interactive run.
- **Stdin.** When stdin is not a terminal, Pi waits for it to close. Callers
  close it (or pass `</dev/null`).
- **Configuration.** Plain Pi inherits global Pi configuration; `/faur check`
  reports known conflicts. The caller owns any isolation; plain Pi is not an OS
  sandbox and inherits the caller's environment and credentials.

## Result

| Mode | Success | Failure |
|---|---|---|
| `-p` | exit 0; the final answer on stdout | exit 1; the error on stderr, stdout empty (a provider error is retried first) |
| `--mode json -p` | JSONL events ending with `agent_end` (final messages, usage) and `agent_settled` | as above |

The exit code reports the run, not the task: a workflow whose test failed
still exits 0. A caller reads the task outcome from the answer (for example a
first line `Verdict: FAIL` that a document format requires).

## Approval

Approval is never granted unattended. Without a UI, a declared command that
requires approval is refused by pi-commands; nothing runs. Faur does not add per-call approval to MCP calls. There is no separate exit code for a blocked command.

## Left to the caller

Pi does not provide these, and the project does not either. A caller that needs
them implements them around the `pi` process (the caller adapter, #46):

- a timeout and cancellation (kill the process group);
- one-at-a-time locking, if runs share state;
- a structured result beyond the answer text, and artifact collection;
- stopping background specialists a cancelled run leaves behind.

## Credentials

Pi takes declared `integrations.env` names from the environment it starts
in: the caller exports them, or loads `.env` with direnv. MCP configuration
references them as `${NAME}` (or `!command`). Model providers use `/login`
or their API key variable.
`/faur check` reports declared names that are unset in the current
environment. A trusted run shares its credentials with every tool in it; they
are not protected integrations (#70).
