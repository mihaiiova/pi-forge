# Faur — product direction

> This is the authoritative statement of what Faur is and how to judge
> changes to it. Where an older document disagrees with it, this one wins.
> Engineering practice is in [AGENTS.md](../AGENTS.md).
>
> Faur is being prepared for open source under that name. It was formerly
> **Pi Forge**, and before that **Pi Agent Factory**. The rename has no
> compatibility aliases: agents built with old names are freshly regenerated
> and their authored content is reconciled manually.

## Decisions recorded on 2026-11-02

These supersede earlier text and the roadmap's 2026-10-29 "Distribution"
decision:

1. **Faur is only the maker.** It is a Pi extension that creates and
   maintains ordinary Pi projects. A generated project runs with `pi` from its
   directory, with Faur uninstalled and without `system.yaml`. It pins no
   Faur package and needs no Faur launcher or extension. It may depend on
   existing Pi packages or project-owned tools, explicitly declared and
   pinned.
2. **Native Pi files are authoritative for execution; `system.yaml` records
   the last agreed design.** Developers may edit native Pi files. When Faur
   is invoked on a project it detects differences and offers to adopt them,
   reapply the design, or reconcile item by item, always previewed, approved
   and reversible with git. There is no continuous synchronization.
3. **Two launch modes, one project.** Plain `pi` inherits the user's global
   Pi configuration and is not hermetic; Faur reports relevant conflicts. An
   optional project-owned `run` script sets an isolated Pi configuration
   directory and executes Pi, nothing else. Neither mode is OS isolation.
4. **Trusted execution is not protected integration.** Credentials in a run
   are available to Pi, every agent and every tool in it. Faur offers no
   same-user confidentiality today; that stronger boundary is deferred (see
   §7) and will not be claimed without adversarial evidence.

The current release still ships an agent runtime inside the Faur package and
requires `./run`. The staged migration is in
[architecture-audit.md §5](architecture-audit.md#5-runtime-dependencies-and-the-migration).

## 1. Product definition

Faur is a conversational development tool for designing, assembling,
checking and evolving **specialized Pi agents**. You describe the outcome you
want; Faur recommends the simplest agent that achieves it, generates it as
an ordinary Pi project, verifies that it works, and changes it safely as needs
change.

**Motto:** *Design, generate, check, and revise specialized Pi agents.*

## 2. Core principle

> **The specialized agent is the product. Pi is its runtime. Faur is the
> maker.**

Faur composes Pi's own resources: settings, agent files, skills, packages,
extensions, MCP servers, sessions. It does not add another agent runtime,
workflow engine, scheduler, plugin system or memory store, and generated
projects do not load Faur at all. What an agent needs at run time comes from
Pi and from the packages the project pins.

## 3. Target users and reference use cases

The user is a developer who wants an agent for a specific job and wants to own
it: plain files they can read, diff, commit and edit.

Three reference systems test architectural decisions. They are not separate
products. A **minimal single agent** (one model, a few tools) is the baseline
every decision is judged against.

- **A. Owlie marketing agent.** Automates marketing for owlie.io step by step,
  from analysis to drafts, approved publishing and eventually bounded
  autonomous runs. It uses OpenSEO, PostHog, Search Console and social
  publishing. A version built with the old Factory exists. It is not
  maintained forward: it is rebuilt from scratch with Faur.
- **B. Investing research agent.** Takes in processed information from Owlie,
  reads market and company data, keeps hypotheses, and proposes actions.
  Research access and trading authority are separate capabilities. Trade
  execution needs explicit authorization and enforced limits, and is out of
  scope for the current roadmap.
- **C. Project-specific coding harness.** A coding agent built inside an
  existing repository. It understands the stack and conventions, and adds
  reviewer, tester or planner specialists only where they help.

Revisor, a web and CLI testing agent (`~/projects/revisor`), is the first agent
built with Faur and the QA reference in
[generated-agent-audit.md](generated-agent-audit.md).

## 4. The specialized-agent model

A specialized agent is:

| Element | Where it lives (Pi-native) |
|---|---|
| Objective, responsibilities, rules | orchestrator prompt (`.pi/APPEND_SYSTEM.md`) |
| What it can use | a generated capability section, loaded with the prompt |
| Specialists (optional) | `.pi/agents/*.md`, run by `pi-subagents` |
| Tools and integrations | built-in tools, Pi packages and extensions, MCP servers (`.pi/mcp.json`), declared commands |
| Permissions | enforced tool allowlists and hidden MCP tools (Pi); per-call approval through a permission extension the project declares |
| Domain knowledge | ordinary project files and skills |
| Learned lessons (optional) | a notes file the orchestrator keeps |
| Triggers | `pi` (interactive), `pi -p` (headless), scheduled (planned) |
| Execution history | Pi session files |

`system.yaml` is Faur's compact **design record** for all of this. It is
deliberately smaller than Pi's full configuration surface. Faur derives the
native files from it and reconciles them with it when invoked; Pi never reads
it.

## 5. What Faur does

- **Design.** Learn the intended outcome in conversation, use what is already
  known, recommend an architecture, and avoid complexity that the outcome
  doesn't need.
- **Generate.** Build the agent from native Pi resources and existing
  capabilities. Write custom components only when nothing existing fits.
  Generation is deterministic and idempotent, previews diffs before writing,
  preserves user edits, and pins dependencies.
- **Check.** Verify configuration, capabilities, permissions and actual
  behavior, and say which of these were demonstrated and which were only
  configured. Report host configuration that conflicts with the project.
- **Revise and reconcile.** Make small, previewed, approved changes to an
  existing agent, based on requests, diagnostics and run history; adopt or
  reconcile changes the developer made to native files directly.

## 6. What Pi does

Pi runs the agent: the model loop, tools, extensions, skills, MCP, sessions and
transcripts, subagents (through `pi-subagents`), and headless execution. Faur
uses those mechanisms instead of duplicating them. Order of preference: a Pi
built-in, then an existing package, then a small generic package, then Faur
code (which never runs inside the agent). When Pi gains a built-in for
something a project gets from a package, Faur moves to the built-in.

## 7. Architecture boundaries

- **Generated agent and Faur are separate.** Faur runs in the developer's
  Pi and operates on a project from outside. Updating or uninstalling Faur
  never changes how an existing agent runs. Git is the history and the
  rollback.
- **Design record vs native files.** Faur derives `settings.json`,
  `mcp.json`, agent frontmatter and the capability section from
  `system.yaml`. Prompts, skills and README are the developer's; Faur
  creates them once and never silently overwrites them. Native files the
  developer edits are adopted or reconciled when Faur is invoked; features
  the schema can't represent are preserved and reported, not dropped.
- **Hybrid orchestration.** Declare responsibilities, capabilities, policies
  and workflow boundaries. Leave delegation, sequencing and tool choice to the
  agents at run time. No graph workflow engine.
- **Enforced vs advisory.** Tool allowlists and hidden MCP tools are enforced
  by Pi and pi-subagents at the tool layer; per-call approvals by the
  permission extension that implements them. An agent with `bash`, a shell-like
  declared command or an unrestricted MCP server can reach anything those
  reach. Prose rules are guidance, and are never presented as enforcement.
- **Isolation.** Plain `pi` uses the user's global Pi configuration as well
  as the project's. The optional `run` gives the project its own Pi
  configuration directory (own logins, no global packages, extensions, skills,
  MCP servers or instructions). Neither is an OS sandbox, and the
  documentation says so. When a declared requirement depends on isolation,
  Faur verifies it or fails explicitly.
- **Trusted execution vs protected integrations.** A trusted run gives its
  credentials (the caller's environment and declared variables) to Pi, every
  agent, every tool and their subprocesses. `secret: true`, tool approval,
  path rules and separate files or processes do not hide values from other
  same-user code; the investigation in
  [protected-integration-investigation.md](protected-integration-investigation.md)
  demonstrated this. A **protected integration** — selected secrets reachable
  only by one authorized tool, not by Pi, other agents, other tools or other
  runs — is a different, stronger guarantee. Faur does not provide it today.
  It is deferred until a reference agent needs it; then it starts by proving
  an existing isolation mechanism with adversarial tests, fails closed, and
  builds no generic supervisor without demonstrated need. Use restricted test
  accounts for trusted runs.

## 8. Design principles

Conversational (discussion before configuration) · developer-first
(inspectable, file-based, version-controlled) · Pi-native · composable (reuse
before building) · incremental (revise, never recreate) · minimal (no
abstraction without a demonstrated need) · verifiable (configured ≠ working) ·
safe (explicit permissions and approvals) · independent (agents run without
Faur). The engineering form of these is [AGENTS.md](../AGENTS.md).

Before adding anything, ask:

1. Does it make specialized agents easier to create, operate, verify or evolve?
2. Does Pi or an existing package already do it?
3. Can configuration do it instead of new code?
4. Does the generated agent still run with plain `pi`, without Faur?
5. Does it add an abstraction we could avoid?
6. Can it be built and tested on its own?
7. Does a real use case need it, and does the minimal agent avoid paying for it?

## 9. Non-goals

- An agent runtime, workflow or graph engine, scheduler, plugin API,
  marketplace or memory database of our own.
- Any run-time dependency of generated projects on Faur.
- Continuous synchronization between `system.yaml` and native files.
- A hosted management platform, visual editor or always-on daemon.
- Generated TypeScript extension code, unless no existing capability fits and
  the user agrees.
- Judging output quality automatically. Checks verify behavior, not quality.
- Autonomous consequential actions (publishing, payments, trades,
  destructive operations) without explicit, enforced authorization.
- Real external writes in automated tests.

## 10. Evolution strategy

Faur works today, but there is no installed base to protect. Until 1.0:

- Breaking changes are allowed. They come with no migrations, bridges or
  compatibility aliases. An agent built by an older version is regenerated.
- Prefer deleting code to keeping it compatible.
- Extend `system.yaml` only when a reference use case needs a field and Pi
  configuration cannot represent it. Prefer improving the discovery procedure
  and checks over adding schema types.
- When Pi gains a built-in for something a project gets elsewhere, move to it.

From 1.0, a Faur update never breaks or silently changes an existing
agent's files, and never affects how it runs.

## 11. Definition of success

- A developer gets a working specialized agent from a conversation, can read
  and commit every file it consists of, and runs it with `pi` without Faur.
- Adding a capability ("connect Search Console", "publish approved posts")
  finds and inspects existing options, proposes a minimal change, and then shows
  the capability works rather than only that it is configured.
- A developer can edit the native files by hand and later revise the agent
  with Faur without losing those edits.
- A workflow runs unattended on a schedule, and its results and failures can
  be inspected afterwards.
- A revision uses evidence from real runs, and the user can see why it is
  proposed.

## 12. Current priorities

In order (details and issues in [the roadmap](roadmap.md)):

0. **Correct what is wrong today:** security and capability wording in
   generated output; one plan/apply lifecycle.
1. **Faur as maker:** the staged migration to ordinary Pi projects
   (verify Pi behavior, native prompt and pay-per-use output, plain-`pi`
   launch and headless, enforcement from packages, design record and
   reconcile, rename).
2. **Reliable results:** structured workflow results, per-run artifacts,
   specialists that launch reliably, re-specified for plain Pi.
3. **Capability composition:** discover, inspect, select and verify existing
   Pi packages, extensions and MCP servers.
4. **Execution evidence and verification:** runs read from Pi sessions,
   scheduling through an existing provider, acceptance scenarios.
