<!-- forge:generated v1 sha256=7d97fe8e9ad3a714e8449d2c7f4d906ed34fdb781a6a1e11030cce153b0a8fd3 -->
# seo-agent-system

SEO analysis + article drafting with specialist subagents

## Run

Start it with `pi` in this folder. Your global Pi configuration (settings,
packages, MCP servers, instructions) is added to the project's.
Your environment, including any credentials in it, is inherited; this is not
an OS sandbox. Skills in `~/.agents/skills/` and `AGENTS.md` files in parent
folders also load, for the orchestrator. Pi asks once whether to trust the
project; headless runs pass `--approve` instead.

```sh
pi                          # interactive
pi --approve -p "..."       # headless one-shot
pi --approve -p "/skill:analyze-and-draft <request>"
```

A workflow is a skill: the text after it is the request. Print mode exits 0
with the final answer on stdout, or non-zero with the error on stderr; the
exit code reports the run, not whether the task succeeded. Add
`--mode json` for an event stream. Pi waits for stdin to close when it is
not a terminal, so callers close it. Approval is never granted unattended:
a call that asks the user is refused in a headless run.

On the first interactive run, Pi may start npm package installation processes
that continue briefly after Pi exits and may keep output pipes open. Callers
should allow extra time before assuming the output stream has closed.

Authenticate with `/login`, or export the provider-specific key (for
example `DEEPSEEK_API_KEY`). See the policy section below for which
capabilities are enforced vs advisory.

## Maintain

This project runs on Pi alone and pins no Faur package. Maintain it from
your own Pi with Faur installed: run `pi` in this folder and use
`/faur <request>` to propose a change (discuss, apply or discard it when the
turn ends), `/faur check` to verify the agent and `/faur status` to
summarize it. Without Faur, edit the files directly; roll back with git.

## Policy

### Enforced by Pi's tool layer

None declared.

### Advisory (guidance — not enforced)

None declared.
