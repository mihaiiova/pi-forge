# Agent Factory — Architecture Analysis & MVP Plan

> **Superseded as the product direction.** This is the historical MVP analysis
> for what is now **Pi Forge**. Product direction, non-goals and priorities are
> in [product-direction.md](product-direction.md) and [roadmap.md](roadmap.md).
> In particular, these MVP assumptions are revised there: "scheduling deferred"
> (decision 2) is now Milestone 2, and capability discovery (§C.8) now also
> covers Pi packages and extensions. Implementation detail below remains
> accurate where the status note says so. Its security wording is not:
> `./run` is not hermetic (the caller's environment, including credentials,
> is inherited), and enforced policies are tool-layer limits that `bash` or a
> shell-like command can get around (#65).

> Status: **implemented**. The `factory` CLI (`validate | generate | discover |
> modify | import`), the `agent-factory` builder skill, and the hermetic
> `./run` launcher ship under `skills/agent-factory/`. Generated systems now pin
> the Factory as a Pi package, which provides `/factory-update` for declarative
> changes, reviews and updates (see the README), superseding this MVP plan's
> exclusions concerning maintenance extension code and external-Factory
> dependence. The launcher now disables ancestor context-file
> discovery with `--no-context-files`. Model tiers (`models.tiers`, §A.5) and
> the built-in skill recommendations are superseded: every agent now names its
> own `provider/id` model and skills come only from the user — see
> `skills/agent-factory/schema.md`. The builder no longer runs an interview
> (§C.9): it designs the system conversationally and builds on request — see
> [the conversational acceptance scenarios](agent-factory-conversation.md). This document is the
> architecture reference; sections that describe *planned* behavior are
> historical and kept for provenance where still relevant.
>
> Decisions marked **Decision (confirmed)** were resolved with the user during
> planning; the rest are auto-decided from repository evidence and are recorded
> as assumptions that any child spec may revisit.

---

## 0. TL;DR

Evolve `pi-config` into an **Agent Factory**: a conversational builder that turns
a plain-language outcome into a standalone, project-local Pi agent system, and
that can later modify that system conversationally.

The factory reuses Pi's existing primitives almost entirely:

| Concern | Reused mechanism (already in Pi) |
|---|---|
| Agent | `.pi/agents/*.md` (markdown + YAML frontmatter, pi-subagents) |
| Skill | `.pi/skills/*/SKILL.md` |
| Tool / MCP | `.pi/mcp.json` + `pi-mcp-adapter`; optional `.pi/extensions/` |
| Workflow | a skill that orchestrates subagents via `pi-subagents` |
| Trigger | interactive `pi` + headless `pi -p` (manual MVP) |
| State / Knowledge | `data/` + `.pi/state.json` convention (project-state) |
| Policy | subagent `tools:` allowlists + tool annotations + acceptance gates |

The only new artifacts are (1) a small **declarative manifest** (`system.yaml`)
that models the system and is the factory's source of truth, (2) a
**deterministic generator/validator** that materializes `system.yaml` into the
native `.pi/` files while preserving user edits, and (3) the **builder skill**
that interviews, discovers capabilities, recommends, generates, and modifies.

**Decisions (confirmed with user):**
1. **No `.pi-config/` directory.** The generated project's `.pi/` is the single
   source of truth; `system.yaml` lives inside it.
2. **Manual + headless execution only in MVP.** Scheduling is a declared
   extension point, deferred to a later milestone.
3. **Declarative + skills only.** The factory never generates TypeScript
   extension code in the MVP; custom-code slots are documented extension points.

---

## A. Current-state inventory

### A.1 What pi-config is

`pi-config` (`mihaiiova/pi-config`, package `0.3.1-dev`) is a **git-backed Pi
package** cloned per machine, installed via `pi install <path>`, and synced via
`/pi-sync`. It is a *package*, not an application: Pi discovers its resources
(extensions, skills, prompts, themes) and installs its pinned npm dependencies.

- Branches: `development` (working) → `master` (production/release). Verified:
  `.pi/settings.json` sets `spec.baseBranch=development`, `spec.releaseBranch=master`.
- Dependency pinning: `package.json` `pi.packages` lists exact
  `npm:<name>@<version>` entries (`pi-subagents@0.65.0`, `pi-mcp-adapter@2.32.1`,
  `pi-web-access@0.27.0`, plus two small helpers). `/pi-sync` reconciles the list
  against what is installed.

### A.2 Resource types (how Pi loads them)

Verified against Pi docs (`configuration.md`, `skills.md`, `packages.md`,
`settings.md`):

| Resource | User scope | Project scope | Notes |
|---|---|---|---|
| Extensions | `~/.pi/agent/extensions/` | `.pi/extensions/` | TS modules; register tools/commands/events/providers |
| Skills | `~/.pi/agent/skills/` | `.pi/skills/` | `SKILL.md` dirs, loaded on demand |
| Agents | `~/.pi/agent/agents/` | `.pi/agents/**/*.md` | pi-subagents markdown agents |
| MCP | `~/.pi/agent/mcp.json` | `.pi/mcp.json` (also `.mcp.json`) | `pi-mcp-adapter` lazy discovery |
| Prompts/themes | user dir | `.pi/prompts/`, `.pi/themes/` | |
| System prompt | `~/.pi/agent/SYSTEM.md` | `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` | project wins for same-name files |
| Settings | `~/.pi/agent/settings.json` | `.pi/settings.json` | project overrides user; resource lists combine |

Project config loads only after **project trust** is granted. All generated
projects must therefore be safe-by-default (no executable extension code in
MVP).

### A.3 Extensions (7, all reusable)

| Extension | Surface | Responsibility |
|---|---|---|
| `pi-sync` | `/pi-sync`, `pi_sync` tool | git push/pull + reconcile `pi.packages` |
| `pi-config` | `/pi-config` | model tiers → `.pi/settings.json` generation |
| `project-state` | `/session-status`, `/session-history`, `/session-cost` | local resume projection + immutable session records + shared accounting ledger |
| `skills-select` | `/skills-select` | per-project skill allowlist |
| `startup-check` | session_start | pi-config drift detection |
| `explore` | `/explore`, `explore_mode` tool | persistent exploration mode |
| `save-md` | `/save-md` | persist last response as markdown |

These are the **existing coding-agent setup** and are all reusable; none need
replacement. They exercise the full extension API surface the factory will rely
on (commands, tools, lifecycle events, TUI, settings generation).

### A.4 Skills (~75) and skill-as-agent

Three functional groups:

1. **Spec lifecycle** (the de-facto workflow system already in the repo):
   `spec-init`, `spec-draft`, `spec-backlog`, `spec-audit`, `spec-new`,
   `spec-start`, `spec-review`, `spec-close`, `spec-release`, `spec-status`,
   `spec-cost`. These orchestrate subagents (`scout`, `worker`, `reviewer`) and
   GitHub via the `gh` CLI.
2. **Composable primitives**: `tdd`, `code-review`, `codebase-design`,
   `domain-modeling`, `grilling`/`grill-me`/`grill-with-docs`, `research`,
   `diagnosing-bugs`, `improve-codebase-architecture`, `explore`.
3. **Domain/integration skills**: the large Cloudflare family, `use-railway`,
   `stripe-best-practices`, `playwright-*`, `dart-*`, `flutter-*`, `shadcn`,
   `herdr`, `owlie`, `react-best-practices`, `web-perf`, etc.

**Skill-as-agent**: several skills bundle `agents/openai.yaml` (an interface
manifest), so they also appear as subagents (`code-review`, `research`, `tdd`,
`implement`, `to-spec`, `to-tickets`, `triage`, `teach`, `grilling`, `grill-me`,
`domain-modeling`, `codebase-design`, …). This is the existing precedent for
"a skill defines both a procedure and an agent persona" — exactly the pattern
generated workflows will reuse.

### A.5 Subagents and model routing

`pi-subagents` (pinned) provides the **Agent** primitive:

- Agent definition: markdown + YAML frontmatter
  (`name`, `description`, `tools`, `model`, `thinking`, `systemPrompt`,
  `inheritProjectContext`, `inheritGlobalContext`, `inheritSkills`,
  `defaultContext`, `acceptanceRole`, `disabled`, `skills`, `output`, …).
- Discovery precedence: builtins < package agents < user agents < project agents
  (`.pi/agents/**/*.md`).
- Orchestration: `subagent` tool (direct, `workflowScript` with `runs.run`/
  `runs.all`/`runs.lanes`), async runs, missions, watchdogs, and external CLI
  adapters (`codex-exec*`, `claude-code*`, `cursor-agent*`).
- Overrides: settings `subagents.agentOverrides.<name>.*`; `modelScope`; tool
  allowlists (`tools:`); acceptance gates.

Model routing is pi-config's own: `.pi/pi-config.json` holds three named tiers
(`high`/`medium`/`small`), a `parentTier`, and a `subagentTiers` map. The
pure-function generator `extensions/pi-config/generate-settings.mjs` materializes
these into `.pi/settings.json` (`defaultProvider`/`defaultModel`/
`defaultThinkingLevel` + `subagents.agentOverrides`). Current effective routing:

| Role | Tier | Model |
|---|---|---|
| parent | high | openai-codex/gpt-5.6-terra |
| worker | medium | deepseek/deepseek-v4-pro |
| scout | small | deepseek/deepseek-v4-flash |
| reviewer | small | deepseek/deepseek-v4-flash |
| oracle | high | openai-codex/gpt-5.6-terra |

This generator is the **reference implementation** of "declarative source →
derived config, idempotent, preserving unrelated keys" — the factory
generalizes exactly this pattern.

### A.6 Spec lifecycle (the workflow mechanism already in place)

- Planning artifacts are **GitHub issues**; lifecycle state is **labels**
  (`spec:ready` → `spec:in-progress` → `spec:reviewed` → `spec:done`; `spec:epic`
  is a type marker). Git branches are authoritative for code; labels for state.
- Branch model: `spec/<n>-<slug>` from `development`, merged back by
  `/spec-close`; `/spec-release` merges `development` → `master` and tags.
- **Trusted plan applier**: `scripts/spec/apply-plan.sh` (validated by
  `scripts/spec/validate-plan.sh`) publishes specs/epics idempotently and
  convergently via opaque `plan_id` + hidden body markers. This is the
  publishing mechanism the Agent Factory specs themselves use.
- `scripts/spec/run-checks.sh` runs `spec.checks` with durable logs;
  `scripts/spec/trivial-spec.sh` routes inline-vs-`worker` implementation.
- `spec.decisionThreshold` (default 0.6) drives a **graded interview** in
  `/spec-new` — the exact interview convention the factory builder reuses.
- Cost accounting: one shared observation ledger (`spec-cost`,
  `session-cost`, `spec-close`).

### A.7 MCP, state, headless execution

- **MCP**: `pi-mcp-adapter` (lazy, ~200-token proxy). Config in
  `.pi/mcp.json` / `.mcp.json` / `~/.pi/agent/mcp.json`; `pi mcp list` connects
  and reports. Current global servers: `owlie` (HTTP) and `cloudflare` (npx).
  Extensions can also `registerMcpServer` at runtime.
- **State**: `project-state` writes a gitignored `.pi/state.json` projection and
  immutable `.pi/sessions/*.json`; GitHub labels + git branches remain
  authoritative. Exploration mode persists `.pi/explore.json` (gitignored).
- **Headless**: `pi -p "<prompt>"` (print mode) runs one prompt and exits;
  `--mode json`/`--mode rpc`; SDK. No always-on daemon exists or is needed.

### A.8 Verification seams

Each extension has a `tests/<name>/` suite (node:test + a `test.sh` wrapper);
pure logic is extracted into testable `.mjs` modules
(`generate-settings.mjs`, `git-sync.mjs`, `accounting*.mjs`, `drift-check.mjs`,
`schema.mjs`, `state.mjs`). Shell validators (`validate-settings.sh`,
`validate-plan.sh`) are tested with a `fake-gh` harness.

### A.9 Assumptions and constraints that must survive

1. GitHub labels + git branches are authoritative; local state is a
   non-authoritative projection that loses on divergence.
2. Credentials never enter committed config (env vars, `gh auth`, `.env`
   gitignored, MCP `Authorization: Bearer ${ENV}`).
3. Package versions are pinned exactly.
4. `development` → `master` branch/release model.
5. Generation is idempotent, convergent, and preserves user edits
   (marker-based convergence; reconcile-before-write).
6. Read-only roles (`scout`, `reviewer`) and approval boundaries are
   capability ceilings that must be preserved in any generated system.

---

## B. Gap analysis

| Factory requirement | Exists today? | Gap |
|---|---|---|
| Declarative system model (agents/skills/workflows/integrations/policies) | Partial — `pi-config.json` models only model tiers | Need `system.yaml` schema + validator |
| Agent primitive | ✅ `.pi/agents/*.md` | None |
| Skill primitive | ✅ `SKILL.md` + skill-as-agent | None |
| Tool/MCP primitive | ✅ `.pi/mcp.json` + adapter | Need generator that writes `.pi/mcp.json` |
| Workflow primitive | ✅ skills + `pi-subagents` orchestration | Need a *declared* workflow contract (inputs/trigger/outputs/agents) in the model |
| Trigger | Partial — interactive + `pi -p` headless | Declared `trigger` field; scheduling deferred |
| State/Knowledge | Partial — `project-state` (spec-specific) | Generalize to `data/` + shared-knowledge convention |
| Policy | Partial — `tools:` allowlists, annotations, acceptance gates | Declared policy in the model → materialized allowlists/annotations |
| Deterministic generator with edit preservation | Partial — `generate-settings.mjs` (models only) | Generalize to whole project (agents/skills/mcp/APPEND_SYSTEM/README) |
| Capability discovery (skills/MCP/subagents/CLIs) | Partial — skills are *advertised* in the system prompt, not queryable | Need `factory discover` deterministic inventory |
| Conversational builder (interview → recommend → generate → modify) | Partial — `spec-new` interview pattern | Need the `agent-factory` skill |
| Import/recreate existing pi-config setup | ❌ | Need `factory import` + round-trip test |
| Independent validation of generated systems | Partial — validators exist per concern | Need `factory validate` + headless smoke |

**Conclusion:** nothing in the current implementation needs replacing. The
factory is an *additive* layer that (a) models systems declaratively and
(b) generates/scaffolds the native files Pi already understands.

---

## C. Proposed MVP architecture

### C.1 Builder vs generated project

Two distinct, separable concerns:

- **Agent Factory (builder)** — lives *in pi-config* as a skill (`agent-factory`)
  plus a deterministic `factory` CLI (`skills/agent-factory/factory.mjs`, run
  through Node). It is a Pi agent that interviews, discovers, designs, generates,
  validates, and modifies. It does **not** need to stay running for a generated
  project to work.
- **Generated project** — a standalone directory owning its `.pi/` config,
  agents, skills, integrations, policies, and runtime state. Run with the
  generated `./run` launcher (isolated `PI_CODING_AGENT_DIR`). Fully
  independent of the factory.

### C.2 Primitives (MVP)

| Primitive | MVP | How | Extension point? |
|---|---|---|---|
| **Agent** | implement | `.pi/agents/*.md` (native) | — |
| **Skill** | implement | `.pi/skills/*/SKILL.md` (native) | — |
| **Tool / MCP** | implement | `.pi/mcp.json` (native); optional `.pi/extensions/` | custom tool code (deferred) |
| **Workflow** | implement as convention | a skill that orchestrates subagents; declared metadata in `system.yaml` | — |
| **Trigger** | manual only | `trigger: {kind: manual}` + headless `pi -p` | schedule (deferred) |
| **State / Knowledge** | implement as convention | `data/` (gitignored) + `data/knowledge/`; optional `.pi/state.json` | richer memory (deferred) |
| **Policy** | implement (advisory + least-privilege) | subagent `tools:` allowlists + MCP `excludeTools` (enforced); README/skill guidance (advisory) | `tool_call` guard extension (deferred) |

No workflow engine is built: workflows are skills that call the existing
`subagent` tool. Declared workflow metadata exists only for discoverability,
validation, and documentation — execution authority stays with the skill's own
procedure, exactly as `spec-new`/`code-review` do today.

### C.3 Declarative boundaries, dynamic decisions

Hybrid model:

- **Declared** (in `system.yaml`, validated): system name; model tiers & routing;
  the orchestrator (instructions, model, tools); the set of specialist agents
  and their tool allowlists; skills; MCP servers; env requirements; workflows
  (purpose, inputs, entry agent, available specialists, output paths, approval
  and verification requirements); enforced + advisory policies.
- **Dynamic** (left to agents at runtime): which tools an agent selects, what it
  investigates, how it delegates, and every internal reasoning step. No graph of
  internal steps is modeled.

### C.4 Project structure (Decision 1)

```text
generated-project/
├── .pi/
│   ├── system.yaml            # declarative model (factory-owned, committed)
│   ├── settings.json          # generated model/routing (factory-owned fragment)
│   ├── mcp.json               # generated MCP servers (factory-owned; authoritative)
│   ├── agents/                # *.md specialist subagents (authored; scaffold + edits)
│   │   └── <specialist>.md
│   ├── skills/                # SKILL.md dirs — incl. workflows (authored; scaffold + edits)
│   │   ├── <workflow-1>/SKILL.md
│   │   └── ...
│   ├── prompts/               # command shortcuts (authored)
│   └── APPEND_SYSTEM.md       # primary orchestrator instructions (authored)
├── .factory/                  # isolated runtime home (gitignored)
│   ├── pi-home/               # PI_CODING_AGENT_DIR (credentials, isolated config)
│   └── capabilities.json      # effective-capability manifest (derived, inspectable)
├── run                        # hermetic launcher — the canonical entry point
├── data/                      # mutable outputs + shared knowledge (gitignored)
│   └── knowledge/
├── .gitignore                 # data/, .env, .factory/, .pi/state.json, .pi/sessions/
├── .env.example               # credential template (no secrets)
└── README.md                  # how to run, workflows, approvals
```

**Three-way split (source vs generated vs mutable):**

| Kind | Files | Ownership | Persisted |
|---|---|---|---|
| Source model | `.pi/system.yaml` | factory (user-editable, reconciled) | committed |
| Derived config | `.pi/settings.json` (model fragment), `.pi/mcp.json`, `.pi/CAPABILITIES.md` | factory | committed |
| Authored content | `.pi/agents/*.md`, `.pi/skills/**`, `.pi/prompts/**`, `.pi/APPEND_SYSTEM.md`, `README.md`, `.gitignore`, `.env.example` | user (factory scaffolds + proposes edits) | committed |
| Mutable data | `data/**`, `.env`, `.pi/state.json`, `.pi/sessions/`, `.pi/artifacts/` | runtime | gitignored |

`system.yaml` is the only file the factory *owns outright*; derived config is
regenerated from it; authored content is never blindly overwritten.

The **orchestrator is the primary Pi session**, not a `.pi/agents/` file (see
§C.7): its instructions live in `.pi/APPEND_SYSTEM.md` and its model/tools in
`.pi/settings.json`. `.pi/agents/*.md` hold the specialist *subagents* it
delegates to.

### C.5 `system.yaml` schema (draft v1)

> Canonical reference: `skills/agent-factory/schema.md` is the field-by-field
> schema, validation rules, migration path, and ownership contract. It is the
> source of truth for the validator (`factory validate`); this section remains a
> narrative overview. `yaml@2.8.3` is pinned in `pi.packages`.

Small, flat, and directly mappable to native files:

```yaml
schema: 1
name: seo-agent-system                 # kebab-case, becomes project name
description: "SEO analysis + article drafting with OpenSEO"

models:                                # → .pi/settings.json (pi-config pattern)
  tiers:
    high:   { model: openai-codex/gpt-5.6-terra, thinking: medium }
    medium: { model: deepseek/deepseek-v4-pro,     thinking: high }
    small:  { model: deepseek/deepseek-v4-flash,   thinking: low }
  parentTier: high
  subagents: { worker: medium, scout: small, reviewer: small, oracle: high }

orchestrator:                          # the primary Pi session (no agent file)
  name: orchestrator
  description: "Primary interactive agent that coordinates the system"
  prompt: |                           # → .pi/APPEND_SYSTEM.md
    You coordinate the SEO system. Delegate analysis to the analyst, …
  model: high                          # → defaultProvider/defaultModel/thinking
  tools: [read, grep, find, ls, bash, edit, write, subagent]  # → defaultTools

agents:                                # → .pi/agents/*.md (specialist subagents)
  - name: seo-analyst
    description: "Analyzes SEO data and recommends opportunities"
    tools: [read, grep, find, ls]      # allowlist = policy (ENFORCED)
    model: small
    prompt: |
      You analyze SEO data via the OpenSEO MCP tools and recommend opportunities.

skills:                                # → .pi/skills/*/SKILL.md
  - name: refresh-product-knowledge
    description: "Scrape and distill product info into data/knowledge/"
    body: |
      # Refresh product knowledge
      … (procedure text; can reference bundled references/)

integrations:                          # → .pi/mcp.json + .env.example
  mcp:
    - name: openseo
      config: { url: "http://localhost:3002/mcp" }   # or {command, args}
  env:
    - { name: OPENSEO_URL, secret: false }

workflows:                             # declared boundaries; decisions inside
  - name: analyze-and-draft
    description: "Analyze SEO data, pick opportunities, draft articles"
    skill: analyze-and-draft            # the orchestrating SKILL.md
    trigger: { kind: manual }           # manual | headless (schedule deferred)
    entry: orchestrator                 # primary agent that runs it
    agents: [seo-analyst, article-writer, researcher]  # available specialists
    inputs: [data/opportunities/*.md]
    outputs: [data/analyses/, data/articles/]
    approval: publish                   # advisory boundary surfaced in instructions
    verify: "a draft exists under data/articles/"       # completion check

policies:
  enforced:                            # capability boundaries — cannot be bypassed
    - agent: seo-analyst
      tools: [read, grep, find, ls]     # → subagent allowlist (pi-subagents)
    - mcp: openseo
      hide: ["publish_*", "delete_*"]   # → excludeTools (unreachable)
  advisory:                            # behavioral guidance — README + skill text
    - "Publishing requires human confirmation: the workflow drafts to data/articles/ and the user publishes."
```

> **Illustrative, not a validating document.** This block abbreviates several
> entries (marked with `…`) and references `analyze-and-draft`, `article-writer`,
> and `researcher` that are not fully declared above. The complete,
> validator-passing example is
> `skills/agent-factory/test/fixtures/valid-seo/.pi/system.yaml`.

The generator maps this 1:1:

- `orchestrator` → `.pi/APPEND_SYSTEM.md` (prompt) + `.pi/CAPABILITIES.md`
  (its "What you can use" section; `./run` appends both) + `.pi/settings.json`
  (`defaultProvider`/`defaultModel`/`defaultThinkingLevel` from the `model` tier,
  `defaultTools` from `tools`).
- `models` → `.pi/settings.json` (reusing the `generate-settings.mjs` logic).
- `agents[]` → `.pi/agents/<name>.md` (frontmatter `tools:` = allowlist —
  enforced; prompt = body → `systemPrompt` frontmatter).
- `skills[]` → `.pi/skills/<name>/SKILL.md`.
- `integrations.mcp[]` → `.pi/mcp.json` `mcpServers`; `integrations.env[]` →
  `.env.example`.
- `workflows[]` → the named `skill` plus a `README.md` table; the skill
  orchestrates `subagent` calls but does not prescribe internal steps.
- `policies.enforced[]` → agent `tools:` allowlists (pi-subagents) + MCP
  `excludeTools` (unreachable tools). `policies.advisory[]` → `README.md`
  + skill text. A `tool_call`-guard extension is the deferred mechanism for
  enforcing a *present* tool's use.

**Orchestrator note (verified):** Pi has no "primary agent" file or swap
mechanism — `.pi/agents/*.md` define *subagents* only. The primary interactive
agent **is** the Pi session, shaped by `.pi/settings.json` (startup model +
`defaultTools`) and `.pi/APPEND_SYSTEM.md` (its instructions). `SYSTEM.md` would
*replace* the whole system prompt, so `APPEND_SYSTEM.md` is the correct surface
for the orchestrator persona.

### C.6 Generator + edit preservation

`factory` CLI commands (deterministic, unit-tested):

- `factory validate <dir>` — validate `system.yaml` (schema) and the generated
  project (agents/skills/mcp references resolve; `pi mcp list` where available).
  (Model-only in spec 1; generated-project checks arrive with the `generate` spec.)
- `factory generate <dir> [--dry-run]` — scaffold missing files and regenerate
  factory-owned files; **never overwrite** authored content.
- `factory discover` — deterministic capability inventory (see §C.8).
- `factory import <dir>` — migrate an existing pi-config project (§D).
- `factory modify <dir>` — diff current project vs model and apply confirmed
  changes (used by the builder).

Ownership and reconciliation contract (generalizing `generate-settings.mjs`):

1. **Derived files** (`settings.json` model fragment, `mcp.json`) are
   factory-owned and regenerated from `system.yaml` on every `generate`;
   **unknown keys the factory does not own are preserved** (the same merge the
   model generator already performs). Hand-editing a derived file is
   unsupported — change the model instead.
2. **Authored files** (agents, skills, prompts, `APPEND_SYSTEM.md`, README,
   `.gitignore`, `.env.example`) are user-owned. The factory scaffolds them
   when absent. On modification it records a content fingerprint of what it last
   wrote; if a file differs from that fingerprint *and* the model wants to
   change it, the factory treats it as a **conflict** and proposes a diff,
   surfacing it for the user to resolve; it never silently overwrites (and, in
   this MVP, never auto-applies a conflict — the user resolves it by editing the
   file or re-running after a deliberate edit).
3. **`system.yaml`** is factory-owned but user-editable; `modify` updates only
   the keys it is changing and preserves unknown keys (best-effort on comments).
4. **Precedence:** the declarative model is authoritative for *derived* config;
   authored content is authoritative for *content*. On conflict the authored
   file wins until the user confirms a merge.
5. **Preview:** `generate --dry-run` and `modify --dry-run` print the full
   planned diff and write nothing; the builder always previews before applying.
6. **Idempotence:** `generate`/`modify` are pure functions of (model, disk) —
   same inputs produce the same result and never duplicate content.

`system.yaml` is parsed with the established **`yaml`** package (v2.8.3 — the
parser already depended on by pinned `pi-subagents`), pinned explicitly in
`pi.packages` and resolved by `factory.mjs` from the Pi package install dir (the
same `~/.pi/agent/` convention `pi-sync` already uses). The validator rejects
unknown keys, invalid references, malformed workflows, and incompatible
configurations with actionable errors. No hand-rolled YAML subset.

### C.7 Runtime = Pi (Decision 2)

- Interactive: `./run` — the **primary session is the
  orchestrator**, configured by `.pi/settings.json` (startup model +
  `defaultTools`) and `.pi/APPEND_SYSTEM.md` (its instructions). Specialist
  agents under `.pi/agents/*.md` are subagents it delegates to.
- Headless: `./run -p "<workflow input>"` (or `--mode json`) runs a workflow
  one-shot. The "researcher refreshes knowledge regularly" requirement is met
  by a documented command the user (or a future scheduler/cron) invokes.
- **No always-on daemon.** A recurring scheduler is a documented extension
  point, not MVP.
- **Portability by declaration (not vendoring):** a generated project carries
  all project-specific content in `.pi/` and *declares and pins* its runtime
  dependencies — the Pi runtime primitives `pi-subagents` (subagent support)
  and `pi-mcp-adapter` (MCP support), plus any `system.yaml` `packages` the
  model declares — in `.pi/settings.json` `packages`. It vendors nothing and
  relies on no ambient global config; the runtime runs under an isolated
  `PI_CODING_AGENT_DIR` via the generated `run` launcher; see §D.0.

### C.8 Capability discovery

`factory discover` inventories, deterministically:

1. **Installed skills** — scan pi-config `skills/`, user `~/.pi/agent/skills/`,
   and the target project's `.pi/skills/` for `SKILL.md` (name + description).
2. **MCP servers** — parse `~/.pi/agent/mcp.json`, `~/.config/mcp/mcp.json`,
   `.mcp.json`, `.pi/mcp.json`; optionally `pi mcp list` for live status.
3. **Subagents** — project `.pi/agents/*.md` files (the factory CLI scans the
   project tree; the conversational builder additionally uses the live
   `subagent({action:"list"})` to see builtin + user agents).
4. **CLIs on PATH** — only the CLIs the user names (`discover --cli <name>`),
   probed with `command -v`. The factory has no built-in CLI list.
5. **Known integrations** — the set of pi-config integration skills
   (`use-railway`, `cloudflare`, `stripe-best-practices`, `turnstile-spin`,
   `owlie`, …), matched against (2)/(4) and the user's description.

This is read-only and local; it lets the builder recommend both installed and
**not-installed** skills/MCP servers.

### C.9 Builder behavior (the conversational factory)

`agent-factory` skill, following `spec-new`'s interview conventions:

1. **Understand** — graded interview (reuse `spec.decisionThreshold` + `grill-me`);
   the user describes the outcome, not the architecture.
2. **Discover** — run `factory discover`; resolve discoverable facts rather than
   asking.
3. **Design** — propose a system using the 7 primitives; recommend skills/MCP/
   CLIs (installed or not).
4. **Generate** — write `system.yaml`, preview with `factory generate --dry-run`,
   then apply; scaffold authored content.
5. **Configure** — help with credentials/env (`gh auth`, `.env`, MCP env vars);
   never write secrets into committed files.
6. **Validate** — `factory validate` + a headless smoke run.
7. **Modify** — later sessions reopen the project, read `system.yaml` + current
   files, preview with `--dry-run`, and apply only confirmed changes, preserving
   unrelated user edits.

---

## D. Compatibility and migration plan

### D.0 Portability model (declared dependencies)

Generated projects are **self-contained by declaration**, not by vendoring:

- Project-specific content (agents, skills, workflows, integrations) is
  generated into `.pi/`.
- Every external dependency is **declared and pinned** in `.pi/settings.json`
  `packages`: the Pi runtime primitives `pi-subagents` (subagent support) and
  `pi-mcp-adapter` (MCP support), plus any `system.yaml` `packages` the model
  explicitly declares. pi-config itself is a *development* dependency and is
  never shipped into the generated runtime.
- Each generated project carries a `run` launcher that sets
  `PI_CODING_AGENT_DIR` to the project's `.factory/pi-home`, so the generated
  runtime never inherits the host's global Pi skills, MCP servers, extensions,
  instructions, settings, or credentials. Skills in the shared Agent Skills
  folders (`~/.agents/skills/`, and `.agents/skills/` in the project and its
  parents) are read by Pi itself and do load for the orchestrator; subagents
  receive only the skills listed for them.
- Nothing is copied out of pi-config into the project (avoids a second,
  independently maintained implementation), and nothing depends on a machine's
  ambient global config.

Clean-environment acceptance test (spec 6): generate a coding-agent system →
copy to an isolated environment with no undeclared global config → install its
declared dependencies → `./run` → verify the orchestrator, agents,
skills, workflows, and integrations resolve → run a representative workflow and
verify behavior. If any capability cannot be made portable in MVP, the gap is
recorded and the acceptance criteria adjusted — never silently weakened.

### D.1 Capability matrix

| Existing capability | Disposition | How |
|---|---|---|
| Model tiers + subagent routing (`pi-config` ext) | **Adapt** | `system.yaml.models` → the same `generate-settings.mjs` logic |
| Spec lifecycle skills (new/start/review/close/…) | **Preserve** | ship unchanged; referenced (not copied) by generated coding-agent systems |
| Trusted plan applier (`apply-plan.sh`) | **Preserve** | unchanged; used by the factory's own specs |
| `run-checks.sh`, `trivial-spec.sh` | **Preserve** | unchanged; referenced by generated systems |
| `pi-sync` / package reconcile | **Preserve** | unchanged; unchanged for pi-config itself |
| `project-state` (sessions/cost) | **Adapt** | generalized `data/` + `.pi/state.json` convention; engine reused |
| `skills-select` allowlist | **Adapt** | folded into the Policy primitive (allowlists) |
| `startup-check` drift detection | **Preserve** | unchanged (pi-config-internal) |
| `explore` mode | **Preserve** | unchanged; the builder uses it for prototyping |
| MCP adapter + `.pi/mcp.json` | **Preserve** | unchanged; factory writes `.pi/mcp.json` |
| pi-subagents (agents + orchestration) | **Preserve** | unchanged; the Agent/Workflow primitives |
| Skill-as-agent (`agents/openai.yaml`) | **Preserve** | unchanged; an authoring alternative to `.pi/agents/*.md` |

**Nothing is replaced in MVP.** Adaptations wrap existing implementations behind
the `system.yaml` model without changing their behavior.

### D.2 Recreation path (coding-agent setup → generated project/template)

The existing pi-config coding-agent setup is represented as a **reference
generated project** (a template in the factory's corpus), not a rewrite:

- Orchestrator → `.pi/APPEND_SYSTEM.md` + `.pi/settings.json` (primary session).
- Specialists `worker`/`scout`/`reviewer`/`oracle` → `.pi/agents/*.md`.
- Model routing → `system.yaml.models` (materialized identically to today).
- Spec lifecycle → provided by the pinned `pi-config` package dependency
  (preserved, not duplicated), declared as `workflows[]` (`spec-new`,
  `spec-start`, `spec-review`).
- GitHub ops + checks + cost accounting → provided by the pinned pi-config
  package dependency, declared as the project's workflow set.
- Functional equivalence is the bar; internal structure may differ.

### D.3 Import path (existing project, in place)

`factory import <dir>`:

1. Read `.pi/settings.json` + `.pi/pi-config.json` (if present) — tiers, routing,
   `spec.*` block, checks.
2. Detect project skills/agents (`.pi/skills/`, `.pi/agents/`, `.pi/mcp.json`).
3. Emit `system.yaml` (models, agents, skills, workflows, integrations) and
   scaffold missing native files; **preserve** every existing file.
4. Report unsupported settings (see §D.5) without failing the import.

### D.4 Round-trip test (principal acceptance test)

1. Start from a representative existing coding-agent project.
2. Inventory its effective configuration and behavior.
3. `factory import` (or recreate) it via the factory.
4. `factory generate` the new project configuration.
5. Verify essential capabilities still work (spec lifecycle, subagent routing,
   GitHub ops, checks).
6. Apply a modification through the builder (e.g. add an agent, change a tier).
7. Verify the modification preserves unrelated configuration and behavior.

### D.5 Deferred / blocked compatibility items

- **Fine-grained runtime approval gates** (per-tool `tool_call` confirmation in
  generated projects) require a project-local extension — deferred per
  Decision 3; coarse boundaries (allowlists + annotations) are in MVP.
- **Scheduled triggers** — deferred per Decision 2.
- **Settings the model cannot express** (arbitrary `defaultTools`, exotic
  provider overrides, custom extension registrations) — `factory import` flags
  them as unsupported rather than silently dropping them.
- **Parent-directory context files** — `AGENTS.md`/`CLAUDE.md` in a parent of a
  generated project still load regardless of trust or `PI_CODING_AGENT_DIR`;
  generated projects must not be nested under a host tree that carries them.
- **Credential bootstrap** — the isolated `pi-home` has no `auth.json`; the
  generated runtime logs in once (`pi --login`) or receives explicit provider
  env credentials. The launcher never copies the host's credentials.
- **OS sandboxing** — filesystem, process, and network isolation are out of
  scope; a declared `bash`/`edit`/`write` tool is not sandboxed by config
  isolation.

---

## E. MVP boundaries

**In scope:**
- `system.yaml` model + validator + `factory` CLI (`validate`/`generate`/
  `discover`/`import`/`modify`).
- Single- and multi-agent project generation (native `.pi/` files).
- Skills + workflows (skills orchestrating subagents), manual + headless triggers.
- MCP/tool discovery + configuration + policy (advisory guidance + enforced
  least-privilege via allowlists and hidden MCP tools).
- Conversational builder (interview → recommend → generate → validate → modify).
- Import/recreate of the existing coding-agent setup + round-trip test.
- The two example systems (SEO and coding) as acceptance scenarios.

**Out of scope (deferred):**
- Visual workflow editor; hosted management platform; general-purpose
  distributed scheduler; autonomous self-improvement.
- Always-on runtime/daemon; runtime `tool_call`-guard extensions (enforcing
  use of a tool that must remain present); scheduled/webhook triggers.
- Generated TypeScript extension code (per Decision 3).
- A general workflow *engine* (Pi's skill + subagent orchestration is sufficient).

---

## F. Implementation roadmap

Six child specs, dependency-ordered, each vertically integrated and
independently deliverable. The two examples are folded into the specs that
naturally own them (SEO → specs 3 + 4; coding-agent → spec 6).

**Compatibility is continuous, not a final-spec afterthought.** Spec 1
introduces a `coding-agent` compatibility fixture (a representative
`system.yaml` + expected generated tree + capability checklist); each
subsequent spec extends what the fixture reproduces, and spec 6 runs the full
round-trip + clean-environment test.

```text
#1 model          (foundation: schema + validator + ownership contract)
   │
   ▼
#2 scaffold       (generate a single-agent runnable project)
   │
   ├──────────────┐
   ▼              ▼
#3 multi-agent    #4 integrations
(agents+workflows)(MCP discover+policy)
   │              │
   └──────┬───────┘
          ▼
#5 builder        (conversational build + modify)
          │
          ▼
#6 migration      (import/recreate coding-agent + round-trip)
```

| # | Spec | Depends on | Principal acceptance |
|---|---|---|---|
| 1 | `agent-factory-model` | — | `factory validate` accepts valid/refuses invalid `system.yaml` via the `yaml` package; schema + ownership/conflict contract documented and tested; `coding-agent` compatibility fixture introduced |
| 2 | `agent-factory-scaffold` | 1 | `factory generate` produces a project where `cd <dir> && pi -p "…"` resolves the **primary orchestrator** (settings + `APPEND_SYSTEM.md`, not an agent file); idempotent; edit-preservation/conflict + `--dry-run` tests |
| 3 | `agent-factory-multi-agent` | 2 | a 3–4 agent system (orchestrator/analyst/writer/researcher) runs a workflow headlessly and writes `data/` outputs; workflows declare boundaries but keep dynamic delegation |
| 4 | `agent-factory-integrations` | 2 | `factory discover` reports OpenSEO; generated `.pi/mcp.json` connects it; policy split — enforced (allowlists + hidden MCP tools) vs advisory |
| 5 | `agent-factory-builder` | 3, 4 | from a plain-language description the builder produces the multi-agent+MCP project (previewing diffs); a later session modifies it preserving unrelated edits |
| 6 | `agent-factory-migration` | 5 | round-trip test passes; coding-agent setup recreatable via pinned `pi-config` dependency; clean-environment portability test passes |

**Risks** (top): over-generalizing the schema (mitigate: YAGNI, two-example
coverage); edit-preservation/conflict correctness (mitigate: fingerprint +
reconcile + `--dry-run` preview + tests); headless-run flakiness in CI
(mitigate: small deterministic smoke, optional network-gated); YAML parsing
edge cases (mitigate: the established `yaml` package + strict schema
validation); portability gaps (mitigate: clean-environment test; record gaps
rather than weaken the promise).

**Testing approach:** node:test suites for the `factory` CLI's pure functions
(schema, generator, merge, conflict/fingerprint, discovery parsing); golden-file
tests for generated projects; shell harness for `factory` CLI exit codes; the
`coding-agent` compatibility fixture asserted progressively from spec 1; the
round-trip + clean-environment tests as scripted end-to-end in spec 6.
Skills/behaviors follow the existing "assert-against-extension-source +
pure-module" convention.

---

## G. GitHub specifications

Published as an epic + six child specs via `scripts/spec/apply-plan.sh`
(`plan_id: agent-factory-mvp`), each child a complete, `/spec-start`-ready spec.

| Child id | Title | Blocked by |
|---|---|---|
| `agent-factory-model` | Agent Factory MVP — declarative system model and validator | — |
| `agent-factory-scaffold` | Agent Factory MVP — generate a single-agent Pi project | model |
| `agent-factory-multi-agent` | Agent Factory MVP — multi-agent systems and workflows | scaffold |
| `agent-factory-integrations` | Agent Factory MVP — MCP/tool discovery, configuration, and policy | scaffold |
| `agent-factory-builder` | Agent Factory MVP — conversational build and modify | multi-agent, integrations |
| `agent-factory-migration` | Agent Factory MVP — import/recreate pi-config + round-trip | builder |

Each child spec body follows `/to-spec` structure: Problem Statement, Solution,
User Stories, Implementation Decisions, Testing Decisions (naming concrete
seams), Out of Scope, Further Notes.
