# Faur — engineering instructions

Faur (formerly Pi Forge) designs, generates, checks and revises
specialized Pi agents. These instructions apply to every coding session in this
repository, whatever agent runs it. They are the one copy of the engineering
principles; other entry points (`CLAUDE.md`) only point here.

The command is `/faur`. The code, package, CLI and folders still use the
Forge names (`skills/forge/`, `forge`, `forge_plan`, `.forge/`) until the rest
of the rename (#67) lands. Use the existing names in code.

## Where the decisions live

| Question | Source of truth |
|---|---|
| What Faur is, its boundaries and non-goals | [docs/product-direction.md](docs/product-direction.md) |
| What is planned, in what order | GitHub issues (epic #24), indexed in [docs/roadmap.md](docs/roadmap.md) — the only roadmap |
| Current architecture, known complexity and cleanup plan | [docs/architecture-audit.md](docs/architecture-audit.md) |
| What generated agents contain and why | [docs/generated-agent-audit.md](docs/generated-agent-audit.md) |
| `system.yaml` and file ownership | [skills/forge/schema.md](skills/forge/schema.md) |
| Conversational builder behavior | [skills/forge/SKILL.md](skills/forge/SKILL.md), [docs/forge-conversation.md](docs/forge-conversation.md) |
| Headless workflow contract | [docs/headless-workflows.md](docs/headless-workflows.md) |

Where these disagree with this file on engineering practice, this file wins;
fix the other document in the same change. Product scope is decided in the
product direction.

## Principles

Apply them in proportion to the change. A typo fix needs none of this; a new
schema field, runtime hook or dependency needs all of it.

1. **Compose before implementing.** Prefer a Pi built-in, then a maintained
   package, extension, skill or MCP server, then Faur code. Build only for a
   demonstrated gap, and say which options you rejected.
2. **Keep Faur's core small.** Its job is discovery, validation, generation,
   diffing, application and verification. The LLM designs; deterministic code
   validates, enforces and writes files.
3. **One source of truth per concern.** Native Pi files are authoritative for
   execution. `system.yaml` records the last architecture agreed with Faur;
   files Faur derives from it are reproducible. Developers may edit any
   native file: Faur detects the drift when invoked and offers to adopt,
   reapply or reconcile, never silently. Authored files belong to the
   developer.
4. **One lifecycle.** Creating and revising an agent go through the same
   validation, generation, diff and apply code. Do not add a second write path.
5. **Every abstraction pays for itself.** Remove duplication before adding
   layers. Do not split a module only because it is long; split when
   responsibilities, dependencies or side effects differ.
6. **Do not build another runtime.** Pi owns the model loop, tools, sessions,
   delegation (via `pi-subagents`) and headless execution. Runtime code in this
   repo is a thin adapter around those, and needs a reason Pi cannot do it.
7. **Simplest capable agent wins.** Start from one agent. Specialists,
   workflows, tools, packages and runtime hooks are added only when the
   requirement needs them.
8. **Generated agents are independent Pi projects.** They are readable,
   editable, version-controlled, and run with `pi` from their directory with
   Faur uninstalled and without `system.yaml`. Every package they depend on
   is explicit, minimal and pinned. Faur is the maker, not a dependency.
9. **Separate reasoning from execution.** Agents reason; tools execute
   deterministic operations; skills describe procedures; configuration grants
   capabilities.
10. **Security is enforced, or it is called advisory.** Prompts are never a
    security boundary. Every security statement in code, docs, generated files
    or issues says whether it is enforced (and by what) or advisory.
11. **Behavior is observable and verifiable.** Distinguish configured,
    available and functionally verified capabilities, and run success from task
    success.
12. **Preserve developer ownership.** Changes are previewed, approved,
    idempotent and reversible with git. Never silently overwrite an authored
    file.
13. **Simplify before extending.** Read the existing implementation first,
    reuse it, and delete what a change makes redundant. Before 1.0 there is no
    backward-compatibility machinery: older projects are regenerated.
14. **Test architectural boundaries.** Prove behavior on real generated
    projects (golden fixtures, the `./run` contract, SDK tests with real Pi),
    not only on helpers.
15. **Fail explicitly.** Never silently weaken permissions, isolation or
    execution guarantees. Refuse and say why.
16. **Optimize for comprehension.** Ordinary files, clear owners, few moving
    parts. Fewer files is not the goal; fewer concepts is.

**Complexity is paid for by the use case that needs it.** A minimal
single-agent project must not inherit files, packages, schema or runtime hooks
that only advanced systems need. The minimal agent in
[docs/generated-agent-audit.md](docs/generated-agent-audit.md) is the baseline.

## Boundaries

Decided 2026-11-02: **Faur is a Pi extension that creates and maintains
ordinary Pi projects. The generated project is the product, Pi is its runtime,
Faur is only the maker.** Since #63 nothing of Faur runs inside a generated
agent: projects never pin Faur, declared commands come from
[pi-commands](https://github.com/mihaiiova/pi-commands) and MCP approvals from
`@gotgenes/pi-permission-system`, each pinned by need and configured natively.
Do not add run-time code to Faur.

- **Faur** (`skills/forge/`, `extensions/forge/`): discover, validate,
  generate, diff, apply, reconcile, check. Pure functions where possible
  (`validateSystem`, `generateProject`, `effectiveCapabilities`); file I/O in
  one apply path. It runs in the developer's Pi, never inside a generated
  agent's run.
- **Generated project**: native Pi configuration plus the developer's prompts,
  skills and scripts. Launched with `pi`. An optional `run` script may set
  `PI_CODING_AGENT_DIR` for Pi-configuration isolation and nothing else.
  Project-specific tools live in the project until a second project needs
  them.
- **Pi and its packages**: everything at run time. If Pi lacks something small
  and general, prefer an existing package, then an upstream change, then one
  small generic package with native configuration. Such a package never reads
  `system.yaml`.
- **Isolation wording**: plain `pi` inherits the user's global Pi
  configuration and is not hermetic. `run` isolates the Pi agent directory
  (settings, packages, MCP servers, instructions, logins), not the OS: skills
  in `~/.agents/skills` and `AGENTS.md` files in parent directories still
  load (architecture audit §5, stage 0). Trusted runs share credentials with
  every tool in the run; they are not protected integrations.
- **MCP**: generated projects use Pi's built-in MCP and never pin an MCP
  extension. A global extension that registers `/mcp` (such as
  `pi-mcp-adapter`) replaces it for plain `pi`; Faur's check reports that,
  and MCP exposure settings are then not enforced.

## Before writing a spec or a feature

A spec answers these where they apply; skip what is obviously irrelevant.

- **Problem:** what demonstrated requirement (issue, run, user report)?
- **Reuse:** which Pi-native or existing solutions were considered, and why
  they do or don't fit?
- **Ownership:** why does this belong in Faur core, the agent runtime, a
  separate package, or the generated project?
- **Complexity:** what new code, schema fields, files or runtime hooks?
- **Simplification:** what existing code does it remove or reuse?
- **Generated output:** what changes for the minimal agent? (Ideally
  nothing.) Does the project still run with plain `pi`, Faur uninstalled?
- **Security:** what is enforced, by which mechanism, and what is advisory?
- **Verification:** which test proves it on a real generated project?

If an answer is "a new runtime mechanism" or "a new schema field", say why
configuration, a skill or an existing package cannot do it.

## Working in this repository

- Node ESM (`.mjs`), no build step, no dependencies beyond pinned `yaml`.
  Match the surrounding style: short modules, pure seams, comments that explain
  why.
- Run the suite: `bash skills/forge/test/test.sh`. Live tests are opt-in
  (`RUN_FORGE_LIVE_TESTS=1`, `RUN_FACTORY_LIVE_TESTS=1`) and cost tokens.
- Generated output is pinned by golden fixtures in
  `skills/forge/test/fixtures/generate/*/golden`. A golden change is a product
  change: review the diff and say why each generated file changed.
- Schema changes update `schema.md`, `validate.mjs` and its tests together.
  The validator rejects unknown keys; keep it that way.
- Security-relevant wording (README templates, `schema.md`, the generated
  "What you can use" sections) must match what tests prove.
- Version bumps and releases happen only when the user asks.
- Backlog: GitHub issues are authoritative; record decisions as dated
  amendments on the issue and update `docs/roadmap.md` when order or scope
  changes.

## Instruction files

This file is the only copy. How each coding agent reaches it (checked
2026-11-02):

- **Pi** (1.4.0) loads one context file per directory, from the working
  directory up to the filesystem root, plus its agent directory. In each
  directory the first of `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` wins,
  so Pi reads `AGENTS.md` and ignores `CLAUDE.md` here. No project setting is
  needed. `--no-context-files` disables it.
- **Claude Code** reads `CLAUDE.md`, which imports this file with
  `@AGENTS.md`.
- **Codex** reads `AGENTS.md` natively, from the repository root down to the
  working directory.

Do not copy principles into `CLAUDE.md` or tool-specific files; edit this one.
