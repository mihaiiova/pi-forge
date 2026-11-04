# Pi Forge

**Design, generate, check, and revise specialized Pi agents.**

Pi Forge (formerly **Pi Agent Factory**) is a conversational development tool
for specialized agents. You describe the outcome you want. Forge recommends the
simplest agent that achieves it and generates it as an ordinary, project-local
Pi project: an orchestrator, optional specialists, skills, packages, MCP
integrations, commands, workflows and permissions. It then keeps that agent
working as your needs change.

**The specialized agent is the product. Pi is its runtime.** Forge composes
Pi's own resources and adds no workflow engine or scheduler of its own. In
this release a generated agent runs on Pi alone, plus the Forge package only
when its design needs one (declared commands or MCP approval gates). It starts
with `pi` in its folder, or with its `./run` when it uses MCP servers.

> **Direction (2026-11-02).** Forge is becoming **Faur**, and generated
> projects are becoming ordinary Pi projects that run with plain `pi`, with
> Faur uninstalled. This README describes the current release.
> See the [product direction](docs/product-direction.md) and the
> [migration plan](docs/architecture-audit.md#5-runtime-dependencies-and-the-migration).

- [Product direction](docs/product-direction.md): what Forge is, how to judge
  changes, and its non-goals. This is the authoritative document.
- [Roadmap](docs/roadmap.md): the current audit, gaps, milestones and issues.
- [AGENTS.md](AGENTS.md): engineering principles for anyone changing this
  repository.

> **Renamed in v0.20.0.** The repository is `mihaiiova/pi-forge`, the package
> `pi-forge`, and `/forge` replaced `/agent-factory`, `/factory-update` and
> `/factory-permission`. There is no migration: regenerate projects built with
> the old names from their `.pi/system.yaml`.
>
> **Command renamed in v0.27.0:** `/faur` replaces `/forge`, with no alias.
> Projects pick it up with their next sync (`/faur sync`); until then they
> keep the pinned release and its `/forge`.

### Architecture in brief

```text
you ──▶ /faur (builder, conversational)
          │  forge CLI: discover · validate · generate --dry-run · generate
          ▼
   <project>/.pi/system.yaml   compact desired state (schema 1)
   <project>/.pi/…             native Pi files: settings, agents, skills, mcp.json, prompts
   <project>/run               optional: its own Pi home and logins (MCP designs)
   <project>/.forge/           build record, capability manifest, isolated Pi home
          │
          ▼
   pi, pi -p "/skill:…"   Pi runs the agent (or ./run); /faur revises it
```

- **Design and generate:** `/faur` holds a design conversation, writes
  `system.yaml`, previews the generated files and writes them only after you
  confirm. Generation is deterministic and idempotent, and never silently
  overwrites your edits.
- **Check:** `/faur check` validates `system.yaml`, compares generated files,
  and reports capability evidence for every agent. A configured capability is
  not necessarily verified; results distinguish live, last seen, missing and
  not verifiable. Checking actual behavior is on the [roadmap](docs/roadmap.md).
- **Revise:** inside a project, `/faur <request>` proposes a small structured
  change. When the turn ends, Forge shows the diff and applies it only if you
  approve.

The former personal Pi setup (spec lifecycle, domain skills, sync/state
extensions) now lives in the private
[`pi-personal`](https://github.com/mihaiiova/pi-personal) repository; see
[Personal Pi setup](#personal-pi-setup).

## Using Forge today

Start it from any Pi session outside a Forge project with `/faur <outcome>`
(or `/skill:forge`). The builder works as a design conversation, not an
interview: it uses what you've already said, recommends the simplest system
that fits, and asks only questions that change the design. When you say
"build it", it runs `forge discover`, writes a `.pi/system.yaml`, previews
the generated files and applies them only after you confirm. See the
[conversational acceptance scenarios](docs/forge-conversation.md). The deterministic CLI behind it:

```sh
node skills/forge/forge.mjs discover [dir]          # models, your skills, MCP, CLIs
node skills/forge/forge.mjs validate <dir>
node skills/forge/forge.mjs generate <dir> --dry-run  # then without --dry-run
node skills/forge/forge.mjs modify <dir> --dry-run
```

### Models: chosen per agent

Nothing is hardcoded. Every agent — the orchestrator and each subagent — names
its own model from the machine's Pi line-up (`pi --list-models`, also reported by
`forge discover`), with an optional thinking level. Agents may share a model or
each use a different one, and any model can be changed later.

### Skills: chosen per agent, suggested from skills.sh

The forge ships no skills of its own. When you set up a system, or add or
change an agent, it searches the open skills registry ([skills.sh](https://skills.sh))
for that agent's role and suggests a few candidates, with source, install count
and page. It shows each skill's actual `SKILL.md` and files before you decide.
Your picks are pinned to a commit and installed with the open `skills` CLI into
the project's own `.agents/skills/` (never globally), recorded in
`skills-lock.json`:

```sh
node skills/forge/forge.mjs search-skills seo audit
node skills/forge/forge.mjs preview-skill coreyhaines31/marketingskills@seo-audit
```

A skill can also be authored inline, come from a pinned package, or be vendored
from a directory you point at. Each agent lists the skills it receives:

```yaml
schema: 1
name: research-desk
orchestrator:
  name: lead
  model: openai-codex/gpt-6-sol
  thinking: medium
  tools: [read, grep, subagent]
agents:
  - name: researcher
    model: deepseek/deepseek-flash
    thinking: high
    tools: [read, grep]
    skills: [notes, house-style]
skills:
  - name: notes
    source: ../my-skills/notes            # vendored into .pi/skills/notes/ once
  - name: house-style
    source: npm:@acme/house-style@1.2.0   # pinned package, added to runtime packages
  - name: seo-audit                       # from skills.sh, pinned to a commit
    source: skills:coreyhaines31/marketingskills/skills/seo-audit@17772c7a80b7b8c7a47af30f648374cd8bd8adc5
```

Skills in the shared Agent Skills folder `~/.agents/skills/` also load for the
orchestrator; subagents get only the skills listed for them.

### Documents: formats you agree on

For each document an agent writes (or a report a subagent returns), the
forge proposes a structure — purpose, sections in order, a word limit and a
few rules — and you add, remove or change sections before it is recorded in
`documents[]`. The agreed format goes into that agent's instructions, so each
run produces the same shape. Any agent can have any number of documents, and a
document can be delivered anywhere an MCP tool reaches — Google Drive, Notion,
Slack — with `deliver: [{ mcp, tool, with }]`. Change formats later with
`/faur`.

Subagents that use MCP or extension tools (web search, for example) always
run in the background, where those tools load; the forge sets this up. On
every start with Faur loaded (pinned, or in your own Pi), it checks that each agent will get the tools and skills it is
declared to have, and names any that are missing. MCP servers connect after
start, so `/faur check` also checks their tools. The last result is saved in
`.forge/check.json` and shown by `/faur status`.

Outside a session, run `node /path/to/pi-forge/skills/forge/forge.mjs check-agent <project>`.
It makes no model calls and does not connect MCP by default; `--connect` runs
`pi mcp list --json` using the project's isolated Pi home and may connect to
networks and use configured credentials. Pi's shell commands read project MCP
servers only for a saved trust decision, so `--connect` saves one in the
project's own isolated Pi home and
reports `trustSaved`; your personal Pi home is not touched. CLI
checks test command presence only, not authentication or functionality. The
CLI inspects installed Pi extensions using Pi's SDK without installing missing
packages. If the project has auto-discovered extension code that Pi's SDK
could load even when disabled, CLI extension results are `not verifiable`
(configuration such as Forge's `subagent/config.json` doesn't count); use `/faur check` in
a running session. Extension loading runs the installed extensions' registration
code. Results reflect observations, not a functional or credential test.

### MCP: Pi's built-in support

Generated systems use Pi's built-in MCP; there is no MCP package to install.
Declare each server in `integrations.mcp` and choose per agent which tools it
gets: `mcp:<server>` or `mcp:<server>/<tool>` for a specialist, `mcp` for the
orchestrator. In the server's config, `includeTools` lists the tools agents may
use, `excludeTools` hides tools from everyone, and `approveTools` makes a tool
ask you before every call; without a UI, such a call is blocked. These rules
rely on Pi's built-in MCP, so such a project starts with `./run`. Use `/mcp`
to see the servers, their tools and errors, and to sign in to
servers that use OAuth.

See [`schema.md`](skills/forge/schema.md) for every field, validation
rule and the file-ownership contract, and [docs/agent-factory.md](docs/agent-factory.md)
for the original architecture and MVP plan (kept as history).

### Prompts: roles, not tool manuals

Each agent's prompt describes its role, goals and rules. What it can use —
tools, MCP servers, commands, skills, and for the orchestrator its specialists —
is generated from `system.yaml` into a "What you can use" section, so removing
an integration also removes it from what agents are told. The section is part of
the generated project (each agent file, and after the orchestrator's prompt in
`.pi/APPEND_SYSTEM.md`, between markers), so it changes when the system is
regenerated, never because the Forge tooling was updated. What agents use at
run time comes from Pi and the packages the project pins, never from Faur:
[pi-commands](https://github.com/mihaiiova/pi-commands) for declared commands
and `@gotgenes/pi-permission-system` for MCP tools that ask, each only when
declared. The Faur version that last built the project is recorded in
`.forge/build.json`. A change that removes
a capability lists any prompt, workflow or policy that still mentions it, and
`/faur review` flags prompts that describe specific tools.

### Commands: CLI permissions per agent

Agents can run command-line tools you already use (`gh`, `wrangler`, your own
scripts) through declared commands instead of a full shell. Each is a fixed
shape in `system.yaml` where the agent fills in only the `{placeholders}`:

```yaml
integrations:
  cli:
    - name: create-issue
      command: gh
      args: [issue, create, --repo, mihaiiova/owlie-app, --title, "{title}", --body-file, "{body:file}"]
      approve: true   # the default: you approve each run
```

Give it to an agent with `cli:create-issue` in its `tools`. Commands run
without a shell, with your own CLI logins. In a running system:

- `/faur permissions` lists commands and who may run them; `add` and `remove
  <name>` change them through a preview you confirm.
- An agent that needs a command it has no tool for says so; you add it with
  `/faur permissions add` or a `/faur` request.
- The project pins [pi-commands](https://github.com/mihaiiova/pi-commands),
  which runs them from the generated `.pi/commands.json`.

### Running and maintaining a generated system

A generated project starts with `pi` in its folder, which adds your global Pi
configuration to the project's. A project with MCP servers also gets `./run`,
which uses the project's own config dir and Pi logins (`/login` once per
project) so a package you installed cannot replace Pi's built-in MCP; `/faur
check` reports such a package for plain `pi`. Either way your shell
environment, including any credentials in it, is inherited, and neither is an
OS sandbox. Workflows run headless as skills: `pi --approve -p
"/skill:<workflow> <request>"` (see [headless workflows](docs/headless-workflows.md)).
`/faur check` reports declared model providers without configured
credentials and declared environment variables that are unset. For example,
use `/login deepseek` or set `DEEPSEEK_API_KEY` before starting it. Start the
project once interactively to install pinned packages before checking
extension-provided tools.
On first installation Pi may leave npm output pipes open briefly after exit.

Pi loads the project's `AGENTS.md`, and any in parent folders, into the
orchestrator's prompt, with or without `./run`; generation warns about files
from outside the project. Their contents are sent to the model, so review
untrusted instructions for prompt injection. Specialists do not receive them.

Inside it, `/faur` is the one command:

| Command | What it does |
|---|---|
| `/faur [request]` | Revise the agent, for example `/faur add a research specialist` or `/faur use a cheaper model for the writer`. When the turn ends with a proposal, Forge prompts you to **discuss** (the default), **apply** or **discard** it. Plain replies continue the conversation until you apply or discard, or leave with `/faur exit`. Without a request, or with `review`, the first answer is a read-only review. |
| `/faur check` | Validate `system.yaml`, compare the generated files with it, and run the launch check. |
| `/faur status` | Agents and models, capabilities, and whether the project still pins Forge from an earlier release. |
| `/faur sync` | Preview rebuilding the project with this Faur and apply only after confirmation. |

Lower-level: `/faur env` and `/faur permissions [add | remove
<name>]`. Headless sessions never apply a change.
While preparing a change, the maintainer can read public documentation (for
example an MCP server's README and releases) to verify versions, tools and
auth, and can declare the environment variables an integration needs. You set
their values in the environment Pi starts in: export them, or load the
project's gitignored `.env` with direnv. Configure values outside Faur. Generation and change previews also add missing
secret and state paths to an existing `.gitignore` without rewriting your rules.
Ignoring files does not remove credentials already committed to git: rotate any
credentials that were committed, including those in `.env` or `.forge/`.

#### Credentials in trusted runs

For a trusted run, declare the variable names under `integrations.env` and
have the caller supply them in the process environment (directly, or from
`.env` through direnv). Pi reads no `.env` itself. The run inherits the
**entire caller environment**, including undeclared variables. Do not put
credential values in a workflow request: it becomes prompt text.

The Pi configuration directory is separate, but this is **not an OS security
boundary**. Pi, agents, tools and their subprocesses can access inherited
credentials; same-user processes may also access the environment or source
files. Tool approval and `secret: true` do not isolate values, and Forge does
not guarantee redaction of tool output, screenshots, logs or artifacts. Use only
trusted agents and tools, and prefer a restricted test account. For Playwright,
its `--secrets` option expects a dotenv file; environment inheritance alone
does not automatically create that file or change its MCP configuration.

A trusted run is not a **protected integration**, where selected secrets
reach only one authorized tool and not Pi, other agents, other tools or other
runs. Forge does not provide protected integrations: separate files, file
modes, processes or path rules do not hide values from same-user code (see the
[investigation](docs/protected-integration-investigation.md)). That boundary
is deferred until an agent needs it, and will be claimed only with
adversarial evidence.

#### No Faur in the project

A generated project pins no Faur package. Install Faur in your own Pi to
design and maintain projects; the projects run with Pi and the packages they
declare, with Faur uninstalled. Updating Faur changes nothing in a project
until you run `/faur sync` in it, which rebuilds the generated files with the
installed Faur and shows any change to what agents can run or reach before
writing it. Roll back with git.

Projects built with v0.30.0 or earlier pin
`git:github.com/mihaiiova/pi-forge@vX.Y.Z`. `/faur status` says so, and
`/faur sync` from a newer Faur drops the pin after confirmation. The old
pinned `/faur sync` cannot update directly to releases without
`maintenance-rebuild.mjs`. Instead, use a separate checkout of the new Faur:

```sh
node /path/to/faur/skills/forge/forge.mjs generate /path/to/project --dry-run
node /path/to/faur/skills/forge/forge.mjs generate /path/to/project
```

Review the preview before approval. Resolve any reported authored-file or drift
conflicts first; regeneration is not a silent overwrite.

Projects generated before 1.0.0 pin `pi-agent-factory`. They are not
migrated: regenerate them from their `.pi/system.yaml`.

### Tests

```sh
bash skills/forge/test/test.sh
```

### Releasing

Generated projects update from release tags. To publish one, merge
`development` into `master`, set `package.json` `version` to `X.Y.Z`, tag the
commit `vX.Y.Z` and push the tag.

## Install

```sh
git clone https://github.com/mihaiiova/pi-forge.git /path/to/pi-forge
pi install /path/to/pi-forge
```

`/faur` is then available in any Pi session. Pi treats a local checkout and a
project's git pin as different packages, so inside a generated project both
load and each command appears twice. Install from the tag instead
(`pi install git:github.com/mihaiiova/pi-forge@vX.Y.Z`) to let the project pin
replace it. Forge pins only what
generated systems need (`pi-subagents`, and `yaml` for its own
parser) in `package.json` under `pi.packages`.

## Personal Pi setup

The spec lifecycle, domain skills and the `explore`, `pi-config`, `pi-sync`,
`project-state`, `save-md`, `skills-select` and `startup-check` extensions moved,
with their history, to [`mihaiiova/pi-personal`](https://github.com/mihaiiova/pi-personal).
It is the reference for a new development-workflow integration that will be
built from scratch with Pi Forge.

To move a machine over, install it next to this repository, then pull this one:

```sh
git clone https://github.com/mihaiiova/pi-personal.git /path/to/pi-personal
pi install /path/to/pi-personal
ln -sfn /path/to/pi-personal/AGENTS.md ~/.pi/agent/AGENTS.md   # global instructions moved too
cd /path/to/pi-forge && git remote set-url origin https://github.com/mihaiiova/pi-forge.git && git pull
```

Then `/reload`. `/pi-sync` now syncs `pi-personal`; update this repository with
`git pull`.

### Project setup checks

A trusted project's `system.yaml` can declare setup checks at project level or on MCP and CLI integrations:

```yaml
setup:
  - description: Install the browser
    check: { file: ./browser }
    install: npm run install-browser
```

`/faur check` reports unmet steps; `/faur setup` previews installs and asks for confirmation. For non-interactive administration use `forge setup <dir> --yes`. Steps marked `needsRoot` are printed, not run. Workflow launches never install. **Command checks execute shell code with your permissions automatically**, including during checks and workflow startup; use only trusted declarations.

An MCP or CLI integration may also declare `secretsFile: .forge/service-secrets.env`. Forge creates a missing file privately, does not overwrite an existing file, and adds an ignore entry. Declare the variable in `integrations.env` and configure its value in that file outside Faur; do not send secrets to the model. Integrations must be configured to read their chosen file themselves; Forge does not load it into the launcher environment. Existing tracked files, unsafe permissions, and symlinks must be corrected by the user. Git ignore does not remove a previously committed secret.

## License

[MIT](LICENSE)
