<!-- forge:generated v1 sha256=5c12e0a599b808239a6efc10c46001ae7af721dacabd7dc01a91adaad4e56846 -->
# notes-helper

Answers questions about the notes in this folder

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
```

Authenticate inside `./run` with `/login`, or export
the provider-specific key (for example `DEEPSEEK_API_KEY`). See the policy
section below for which
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
