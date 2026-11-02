# Architecture audit (v0.26.0)

Audit of the implementation at `79d1b6a` (v0.26.0, 2026-11-02) against the
principles in [AGENTS.md](../AGENTS.md). It covers the code, not only the
documents. `bash skills/forge/test/test.sh` passed (45 suites; live and
gated tests skipped). The generated output is audited separately in
[generated-agent-audit.md](generated-agent-audit.md); backlog dispositions are
in [backlog-review.md](backlog-review.md).

Line counts are for orientation only. Size is not a finding.

## 1. Current architecture

Everything ships as one Pi package (`pi-forge`, pinned by every generated
project). One extension entry, `extensions/forge/index.ts`, registers `/forge`
and, inside a trusted generated project, the agent runtime and the
maintenance half of `/forge`.

| Area | Modules (`skills/forge/`) | ≈Lines | Responsibility | Side effects |
|---|---|---|---|---|
| Conversational builder | `SKILL.md`, `extensions/forge/index.ts` | 460 + 30 | Design conversation; drives the CLI | none (LLM) |
| Discovery | `discover.mjs`, `registry-skills.mjs`, `maintenance-fetch.mjs`, `forge.mjs` `runDiscover` | 460 | Models, local skills/MCP/agents, named CLIs, skills.sh, public docs | network (consented), `pi --list-models` |
| Schema and validation | `schema.md`, `parse.mjs`, `validate.mjs`, `models.mjs`, `changes.mjs`, `yaml-loader.mjs` | 890 | `system.yaml` v1, strict validation, structured change operations | none |
| Generation | `generate.mjs`, `runtime.mjs`, `mcp-gen.mjs`, `policy.mjs`, `agent-context.mjs`, `documents.mjs`, `workflow-skill.mjs`, `deps.mjs`, `skill-sources.mjs`, `asking.mjs`, `advisories.mjs`, `project-context.mjs` | 1,500 | Pure `generateProject(model, existing)` → file plan | none (pure) |
| Modification and maintenance | `modify.mjs`, `diff.mjs`, `maintenance.mjs`, `maintenance-extension.mjs`, `maintenance-store.mjs`, `maintenance-secrets.mjs`, `maintenance-env.mjs`, `package-update.mjs`, `maintenance-rebuild.mjs`, `import.mjs` | 1,260 | Plan/apply changes, `/forge` tool `forge_plan`, env, sync to new release, import | writes project files, git fetch, npm |
| CLI | `forge.mjs` | 760 | `validate`, `generate`, `modify`, `change`, `discover`, `check-agent`, `setup`, `import`, skills search | writes project files |
| Agent runtime | `agent-extension.mjs`, `permissions-extension.mjs`, `cli-tools.mjs`, `memory.mjs`, `workflow-approval.mjs` | 710 | Memory tool, MCP approval/boundary gate, declared command tools, `request_permission`, credential notice | executes declared commands, writes `.pi/MEMORY.md`, `system.yaml` (via approved change) |
| Workflow execution | `workflow-runner.mjs`, launcher block in `runtime.mjs` | 220 | `./run --workflow`: validate, lock, run `pi -p`, timeout, cleanup, JSON result | processes, systemd scope, pi-subagents stop inbox |
| Integration setup | `setup.mjs`, `integration-secrets.mjs` | 170 | Declared setup checks/installs; integration secrets files and `.gitignore` safety | runs shell checks, creates 0600 files |
| Capability checking | `capabilities.mjs`, `launch-check.mjs`, `check.mjs`, `maintenance.mjs` `checkProject` | 460 | Manifest from declarations, config consistency, launch check, live tool/MCP probe | starts MCP servers (`--connect`), saves trust |

Dependency direction today (arrows mean "imports"):

```text
extension ─▶ maintenance-extension ─▶ maintenance ─▶ generate ─▶ (pure generators)
          └▶ agent-extension ─▶ permissions-extension ─▶ maintenance (planChange/applyChange)
                             └▶ changes ─▶ validate
workflow-runner ─▶ changes ─▶ validate          check ─▶ maintenance (checkProject)
capabilities ─▶ generate                        forge.mjs ─▶ almost everything
```

The pure core (`validate`, `generate`, `capabilities`, `diff`) is well
separated and well tested; that is the strongest part of the design. The
problems are around it: two write paths, a runtime that imports the builder,
and machinery that every agent carries. A decision taken during this audit
(finding C) removes the runtime from generated projects; §5 classifies what
that runtime does today and stages the migration.

## 2. Findings

Each finding cites evidence, the principle it bears on, and a disposition:
**delete**, **merge**, **move**, **fix**, **keep**, or **decide** (needs a
product decision). Issue numbers refer to [backlog-review.md](backlog-review.md).

### A. Two lifecycles for one job (principle 4) — merge

Creation and revision apply changes through different code:

- `forge generate` (`forge.mjs` `runGenerate`) writes each planned file
  directly, writes `.forge/capabilities.json` and `.forge/build.json` itself,
  never removes files of removed declarations, and has no stale-fingerprint
  check.
- `forge modify` (`forge.mjs` `runModify`) asks **per file**
  (`forge.mjs:597`), so a user can apply half a plan and leave settings, MCP
  config and agent files inconsistent. It writes neither `build.json` nor
  `capabilities.json`.
- `forge change` and `/forge` use `planChange`/`applyChange`
  (`maintenance.mjs`): one plan, fingerprinted atomic writes, removal of
  intact scaffolds, conflict refusal, consistency check, `build.json`.

`planChange(root, [{op: 'reconcile'}])` already is "regenerate from
`system.yaml`" (`rebuildPlan` uses it). Creation is the same operation on an
empty project.

**Proposal:** make `generate` and `modify` thin CLI wrappers over
`planChange` + `applyChange` (first generation = reconcile on an empty
directory, with registry/vendored skill installs moved into the plan). Delete
the per-file apply loop and `modify.mjs` (whose only addition is diffs that
`planChange` already computes). One apply path, one set of tests.

### B. The agent runtime imports the builder (principles 2, 6, 8) — move

- `permissions-extension.mjs:18` imports `planChange`/`applyChange` from
  `maintenance.mjs` so "always allow" can save a command. That pulls the
  generator, skills installer, package updater and fetcher into every agent
  process.
- `agent-extension.mjs`, `workflow-runner.mjs` and the MCP gate parse and
  validate `system.yaml` at run time (`changes.mjs` → `validate.mjs`). The
  desired-state file is therefore also runtime configuration, and an agent
  cannot run without the full validator.
- `check.mjs` imports `checkProject` from `maintenance.mjs`.

**Proposal:** resolved by decision C: generated projects stop loading Faur,
so no runtime code imports the builder. Until then, add nothing that deepens
the coupling. Move `checkProject` into `check.mjs` as part of the lifecycle
merge.

### C. Every agent loads all of Faur (principles 7, 8) — decided (2026-11-02)

Every generated project pins `git:github.com/mihaiiova/pi-forge@vX`. That one
package brings `/forge` design and maintenance, `forge_plan`, release sync,
the skills.sh client, the docs fetcher and the agent runtime. The product
direction chose this deliberately ("one version for runtime and tooling",
roadmap §6). It conflicts with "runtime dependency minimal" and with "the
minimal agent pays for nothing it doesn't use".

**Decision (2026-11-02), superseding roadmap §6 "Distribution":** Faur is
only the maker. Generated projects are ordinary Pi projects that run with
`pi` from their directory, with no Faur package, `/forge` maintenance
extension or required launcher. Advanced agents may depend on existing Pi
packages or project-owned tools, declared and pinned. Faur reopens and
revises projects from the developer's own Pi. See §5 for the classification
of today's runtime and the staged migration.

### D. Unconditional runtime pieces (principle 7) — fix

- `pi-subagents` is always pinned (`deps.mjs:21`, `RUNTIME_PRIMITIVES`), even
  for an agent without specialists.
- Memory is always on (`memory` tool, `.pi/MEMORY.md`, prompt nudge), so a
  read-only agent can always write one file.
- `request_permission` is always registered and every `CAPABILITIES.md` tells
  the agent to use it, including read-only agents.
- The launcher always contains the `--workflow` block (twice) and an
  embedded base64 workflow manifest, even with no workflows (`W10=`).

Each should appear only when the declaration needs it. See the generated-agent
audit for the full list.

### E. Compatibility machinery before 1.0 (principle 13) — delete

The product direction says there are no compatibility bridges before 1.0.
Still present:

- `registerAgentContext` renders `CAPABILITIES.md` for "a launcher from before
  it was build output" (`agent-extension.mjs:132`).
- `tolerate: askingMessages(...)` keeps projects valid that the validator now
  rejects (`changes.mjs:28`, `maintenance.mjs` `checkProject`): "A project that
  already has such a subagent stays revisable".
- `forge modify` "existing reconciliation is preserved" next to `change`.
- `docs/agent-factory.md` (759 lines) describes the pre-Forge design and is
  still cited by `schema.md` §4 as the ownership contract's source.

Consumers: none outside pre-0.21 projects, which are regenerated by policy.

### F. Two ownership fingerprints (principle 5) — merge

Authored files carry an inline `forge:generated v1 sha256=` marker
(`generate.mjs`), and `.forge/build.json` also records fingerprints of the same
files. `planChange` compares against regenerated scaffolds, `generateProject`
against inline markers. One mechanism should decide ownership. `build.json`
is the less intrusive one (it keeps authored files free of Faur markers);
the marker is the one that survives deleting `.forge/`. Decide in the
lifecycle merge (A), not separately.

### G. The workflow runner reimplements process supervision (principle 6) — keep thin

`workflow-runner.mjs` adds a lock, a systemd user scope, process-group
termination and a stop-request protocol that writes into pi-subagents'
private `stop-requests/` inbox (`workflow-runner.mjs:144`–`180`), which
`docs/headless-workflows.md` notes is version-specific. This is the closest
thing to a second runtime in the repository. It exists because `pi -p` and
`pi-subagents` don't expose cancel-and-confirm. Under decision C it leaves
generated projects (R16 in §5). Until then:

- treat the pi-subagents inbox coupling as a defect to remove upstream
  (ask pi-subagents for a supported stop API) rather than extend;
- add no new supervision features (#55–#58 superseded the supervisor).

### H. Security wording that overstates enforcement (principle 10) — fix

- `runtime.mjs:82` (written into every `run`): "the host's global
  skills/MCP/extensions/instructions/**credentials never leak in**". The caller's
  whole environment is inherited by design (trusted-run decision, #55).
- Generated README: "your global Pi settings, MCP servers, extensions and
  **credentials are not inherited**". Same issue.
- Generated README and `SKILL.md:246`: "Enforced (**cannot be bypassed**)"
  for tool allowlists. They are enforced at Pi's tool layer; an agent with
  `bash` or a declared command can reach anything the user can.
- Product direction §7 "Isolation: `./run` gives the project its own Pi home
  and credentials". It gives its own Pi *login store*; environment
  credentials are shared.
- Generated `CAPABILITIES.md` says "all tools" for an MCP server restricted by
  `includeTools` (`agent-context.mjs:74`); `mcp.json` correctly hides the
  rest. Advisory text understates the enforced restriction, which makes the
  capability report wrong in the other direction.

These are wording fixes with golden-fixture updates; no behavior changes.

### I. Discovery has two implementations (principle 4) — merge later

Builder discovery (`forge discover`) and revision discovery (`forge_plan
discover`) cover different sources (the second has npm and the MCP registry,
the first has local skills and agents). #29 already plans one shared search;
do it there rather than separately.

### J. What is already right — keep

- Pure seams: `validateSystem`, `generateProject`, `effectiveCapabilities`,
  `checkCapabilities` are deterministic and fixture-tested.
- Derived vs authored ownership, previews, and conflict refusal.
- MCP through Pi's built-in support; tool exposure derived, not hand-written.
- Declared commands run without a shell and with approval by default.
- Capability check states `verified now` / `last seen` / `not verifiable`
  (principle 11 already applied).
- `/forge` revision cannot write except through a confirmed proposal.

## 3. Target boundaries

```text
Faur (Pi extension the developer installs)     Generated project (the developer's Pi project)
  discover ─▶ validate ─▶ plan ─▶ apply            native Pi files — authoritative for execution:
    one plan/apply path, previewed, approved          .pi/settings.json, .pi/mcp.json, .pi/agents/*.md,
  reconcile: native files ⇄ design record             .pi/APPEND_SYSTEM.md, .pi/skills/, AGENTS.md
    (only when invoked; never silent)              design record (Faur metadata): system.yaml
  check: configured / available / verified;        optional ./run: sets PI_CODING_AGENT_DIR, execs pi
    host-config conflicts                          pinned packages it actually uses; project tools/
Pi + packages: model loop, tools, MCP, sessions, subagents (pi-subagents), print/JSON mode,
               permission or sandbox extensions when an agent declares them
```

Rules that follow:

- `pi` in the project directory runs the agent, with or without Faur
  installed, with or without `system.yaml`.
- Native Pi files are authoritative for execution. `system.yaml` records the
  last agreed design. Developers may edit native files; Faur detects drift
  when invoked and offers to adopt, reapply or reconcile per item, previewed
  and approved. No continuous synchronization.
- One plan/apply path for create, change, reconcile and sync.
- Plain `pi` inherits the user's global Pi configuration; that mode is not
  hermetic and nothing claims it is. The optional `./run` isolates **Pi
  configuration only** (no global packages, extensions, skills, MCP servers or
  instructions). Neither is OS-level isolation.
- A capability one project needs (Revisor's sandboxed recorder) lives in that
  project. It becomes a separate package when a second project needs it, and
  enters Faur's schema only if Pi configuration cannot represent it.
- Security text names its enforcing mechanism or says "advisory".

## 4. Cleanup before the migration

These are independent of the migration and make it smaller.

1. **Security wording** (H). Launcher comment, README template, `SKILL.md`,
   product direction, `includeTools` capability text; golden fixtures.
2. **One lifecycle** (A, F, E). `generate`/`modify` call
   `planChange`/`applyChange`; delete the per-file loop, `modify.mjs` and the
   `tolerate` path; one ownership fingerprint; move `checkProject`.

## 5. Runtime dependencies and the migration

Every piece of Faur a generated project uses at run time today, classified
as (1) replaceable by native Pi, (2) replaceable by an existing package,
(3) agent-specific, belongs in the project, or (4) needs a reusable component
that does not exist yet. "Verify" marks a classification that rests on Pi or
package behavior still to be confirmed in stage 0.

| # | Today (where) | Who uses it | Class | Replacement |
|---|---|---|---|---|
| R1 | `./run` sets `PI_CODING_AGENT_DIR=.forge/pi-home` (`runtime.mjs`) | every agent | 3 | Optional project-owned `run` that only sets the config dir and execs `pi`. Default launch is `pi`. Propose a Pi project setting to ignore user-level resources (upstream) |
| R2 | `--no-context-files` | every agent | 1 | Pi loads `AGENTS.md` natively; `orchestrator.projectContext` (#33) becomes unnecessary |
| R3 | `--append-system-prompt .pi/CAPABILITIES.md` | every agent | 1 | Put the generated capability section in a file Pi loads natively (design choice in stage 1: a generated block in `.pi/APPEND_SYSTEM.md`, or the prompt derived wholly from the design record) |
| R4 | `.env` loader for declared names in `run` | agents with `integrations.env` | 1 | The caller's environment (shell, direnv), Pi's `${VAR}`/`!command` in MCP config, Pi `/login` for providers. Document; Faur check reports missing names |
| R5 | `pi --approve` (trust per run) | every agent | 1 | Pi's project trust prompt, once |
| R6 | Faur package pin | every agent | — | Removed |
| R7 | `pi-subagents` pin | every agent | 2 | Kept, only when `agents[]` is non-empty |
| R8 | `forceTopLevelAsync` in `.forge/pi-home/extensions/subagent/config.json` | agents with background specialists | 2, verify | pi-subagents 0.83.1 reads this file only from the agent directory (`src/extension/config.js` `getConfigPath`). Per-agent `async: true` frontmatter stays. Check for a project-level setting; otherwise upstream request, or isolated mode only |
| R9 | `memory` tool and `.pi/MEMORY.md` injection (`agent-extension.mjs`) | every orchestrator | 2 or 3, verify | An existing memory package if a maintained one fits; otherwise a project convention (a notes file the agent may edit, referenced from its prompt). Not class 4 |
| R10 | MCP `approveTools` per-call approval, blocked without UI (`registerMcpBoundary`) | agents with approvals | 2 or 4 | Pi documents `tool_call` permission extensions for MCP (`docs/mcp.md`, Permissions); only examples ship (`permission-gate.ts`). Use a maintained package if one exists; otherwise one small generic package with its own native config |
| R11 | Orchestrator without `mcp` cannot call MCP tools (`registerMcpBoundary`) | agents whose lead has no `mcp` | 1 or 4, verify | Pi exposure settings if they can scope MCP to subagents; otherwise the R10 package |
| R12 | Declared `cli:` command tools: no shell, placeholders, approval (`permissions-extension.mjs`, `cli-tools.mjs`) | agents with `integrations.cli` (B, C) | 2 or 4 | A maintained package if one exists; otherwise the same small generic package as R10, configured natively. Not Faur |
| R13 | `request_permission`, pending requests, "always allow" saves to `system.yaml` | every orchestrator | 4 or remove | Asking once can live with R12. Saving a command is a design change: the developer asks Faur. Drop the runtime write path |
| R14 | Credential notice at session start | every orchestrator | 1 | Pi reports missing provider auth; Faur's check reports it before a run |
| R15 | Agent-context fallback for pre-`CAPABILITIES.md` projects | none current | — | Delete |
| R16 | `./run --workflow`: validation, setup preflight, lock, timeout, systemd scope, pi-subagents cleanup, JSON line, exit codes (`workflow-runner.mjs`) | B, C; Revisor's caller MCP server | 1 + 4 | Invocation: `pi -p "/skill:<workflow> …"` (print mode expands skills, `workflow-print-mode.test.mjs`) or `--mode json`. Caller concerns (timeout, cancel, structured result, artifacts, progress) go to an optional caller-side adapter outside generated projects (#46 re-scoped), only where print/JSON mode is not enough. Setup preflight moves to Faur's check |
| R17 | Headless approval blocking signal (`workflow-approval.mjs`, exit 3) | B, C | 4 | Part of the R10/R12 package (block without UI) plus the caller adapter's status mapping |
| R18 | `/forge` maintenance, `forge_plan`, `/forge env`, `/forge permissions`, `/forge sync` inside the agent | every agent | — | Faur in the developer's Pi, operating on the project from outside. `/forge env set` becomes documentation or a Faur command |
| R19 | `.forge/build.json`, `.forge/capabilities.json`, `.forge/check.json` | Faur only | — | Faur metadata; location decided with `system.yaml`'s (stage 4) |

Class 4 candidates are R10, R12, R13 and R17, plus the caller adapter in R16.
Stage 0 checks for maintained packages first. If none fits, they become **one**
small generic package (permission gates and declared commands, configured
natively, unaware of `system.yaml`) rather than a renamed Faur runtime.

### Staged migration

Each stage leaves every reference agent working. Nothing is deleted before its
users have the replacement, and Revisor (the only external consumer of the
workflow runner) moves before the runner is removed.

| Stage | Outcome | Removes | Acceptance |
|---|---|---|---|
| 0. Verify | Confirm the "verify" rows: global-resource merging (including the `pi-mcp-adapter` conflict) in plain and isolated mode, pi-subagents project configuration, existing packages for R9/R10/R12, Pi structured or JSON output for R16. Draft the upstream Pi proposal for ignoring user-level resources | nothing | A short decision record on the epic, with commands and results |
| 1. Native prompt and output | Capability section and context load natively; output is pay-per-use (no `pi-subagents` without specialists; no empty `mcp.json`, `.env.example`, `data/knowledge/`) | R2, R3, R14, R15, `projectContext` | The minimal agent runs with plain `pi` and no Faur installed |
| 2. Launch and headless | `run` optional and minimal; documented environment; workflows invoked with `pi -p`; Faur's check reports host-config conflicts and setup | R1 (as requirement), R4, R5, R16 runner after Revisor migrates | Marketing agent without approvals or commands runs headless with plain `pi`; isolated mode excludes global packages, proven with the `pi-mcp-adapter` conflict |
| 3. Enforcement without Faur | Approvals, declared commands, headless blocking from an existing or one new generic package | R10–R13, R17 from Faur | B and C run with plain `pi`; enforcement tests (approval asks, blocks headless; commands run without a shell) pass without Faur installed |
| 4. Faur as maker | Faur runs only in the developer's Pi; projects pin no Faur; `system.yaml` is the design record with drift reconcile (reuse `import`, generate, diff); metadata location decided; rename to Faur | R6, R18, R19 relocation | Generate → edit native files by hand → reopen with Faur → adopt → revise again, with no manual edit lost |

The end-to-end acceptance test for the migration: generate a project, remove
Faur from the environment, enter the project and run `pi`. It works with
its declared capabilities.
