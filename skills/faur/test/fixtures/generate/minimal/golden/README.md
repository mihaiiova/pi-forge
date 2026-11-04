<!-- faur:generated v1 sha256=3497b08f8a452157de31f1eac8f81a153e0299fa6dc3428bb175eede6ea75f7a -->
# notes-helper

Answers questions about the notes in this folder

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
```

Authenticate with `/login`, or export the provider-specific key (for
example `DEEPSEEK_API_KEY`). See the policy section below for which
capabilities are enforced vs advisory.

## Maintain

This project runs on Pi alone and pins no Faur package. Maintain it from
your own Pi with Faur installed: run `pi` in this folder and use
`/faur <request>` to propose a change (discuss, apply or discard it when the
turn ends), `/faur check` to verify the agent, `/faur status` to summarize
it and `/faur permissions` to list, add or remove declared commands. Without
Faur, edit the files directly; roll back with git. Restart Pi when packages change.

## Policy

### Enforced by Pi's tool layer

None declared.

### Advisory (guidance — not enforced)

None declared.
