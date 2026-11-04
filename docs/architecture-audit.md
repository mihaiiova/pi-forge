# Architecture audit (v0.26.0)

Audit of the implementation at `79d1b6a` (v0.26.0, 2026-11-02) against the
principles in [AGENTS.md](../AGENTS.md). It covers the code, not only the
documents. `bash skills/faur/test/test.sh` passed (45 suites; live and
gated tests skipped). The generated output is audited separately in
[generated-agent-audit.md](generated-agent-audit.md); backlog dispositions are
in [backlog-review.md](backlog-review.md).

> **2026-11-02 update (#66):** Sections A, E and F below record the v0.26.0
> findings, not the current implementation. `generate`, `modify`, and `change`
> now use `planChange`/`applyChange`; the per-file modify loop and
> `modify.mjs` are removed. Scaffold markers determine ownership; build
> metadata records declaration identities rather than ownership fingerprints.
> `checkProject` lives in `check.mjs`, and the validation tolerance path is gone.
> Apply rollback is best-effort for synchronous failures, not crash-safe.
> Release sync applies the reviewed managed-file plan before Pi package update;
> package installation and external effects are outside that rollback. If it
> fails, the applied files remain and package state may be partial. Retry
> `pi update --extensions --approve` from the project in the same Pi environment,
> or review changes and package state before using git to revert.

Line counts are for orientation only. Size is not a finding.

## 1. Current architecture

Everything ships as one Pi package (`pi-forge`, pinned by every generated
project). One extension entry, `extensions/faur/index.ts`, registers `/faur`
and, inside a trusted generated project, the agent runtime and the
maintenance half of `/faur`.

| Area | Modules (`skills/faur/`) | ≈Lines | Responsibility | Side effects |
|---|---|---|---|---|
| Conversational builder | `SKILL.md`, `extensions/faur/index.ts` | 460 + 30 | Design conversation; drives the CLI | none (LLM) |
| Discovery | `discover.mjs`, `registry-skills.mjs`, `maintenance-fetch.mjs`, `forge.mjs` `runDiscover` | 460 | Models, local skills/MCP/agents, named CLIs, skills.sh, public docs | network (consented), `pi --list-models` |
| Schema and validation | `schema.md`, `parse.mjs`, `validate.mjs`, `models.mjs`, `changes.mjs`, `yaml-loader.mjs` | 890 | `system.yaml` v1, strict validation, structured change operations | none |
| Generation | `generate.mjs`, `runtime.mjs`, `mcp-gen.mjs`, `policy.mjs`, `agent-context.mjs`, `documents.mjs`, `workflow-skill.mjs`, `deps.mjs`, `skill-sources.mjs`, `asking.mjs`, `advisories.mjs`, `project-context.mjs` | 1,500 | Pure `generateProject(model, existing)` → file plan | none (pure) |
| Modification and maintenance | `modify.mjs`, `diff.mjs`, `maintenance.mjs`, `maintenance-extension.mjs`, `maintenance-store.mjs`, `maintenance-secrets.mjs`, `maintenance-env.mjs`, `package-update.mjs`, `maintenance-rebuild.mjs`, `import.mjs` | 1,260 | Plan/apply changes, `/faur` tool `forge_plan`, env, sync to new release, import | writes project files, git fetch, npm |
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
- `forge change` and `/faur` use `planChange`/`applyChange`
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
package brings `/faur` design and maintenance, `forge_plan`, release sync,
the skills.sh client, the docs fetcher and the agent runtime. The product
direction chose this deliberately ("one version for runtime and tooling",
roadmap §6). It conflicts with "runtime dependency minimal" and with "the
minimal agent pays for nothing it doesn't use".

**Decision (2026-11-02), superseding roadmap §6 "Distribution":** Faur is
only the maker. Generated projects are ordinary Pi projects that run with
`pi` from their directory, with no Faur package, `/faur` maintenance
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
- `/faur` revision cannot write except through a confirmed proposal.

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
that does not exist yet. Stage 0 (2026-11-03) verified or corrected the rows
that rested on unconfirmed Pi or package behavior; the results follow the table.

| # | Today (where) | Who uses it | Class | Replacement |
|---|---|---|---|---|
| R1 | `./run` sets `PI_CODING_AGENT_DIR=.forge/pi-home` (`runtime.mjs`) | every agent | 3, verified | Optional project-owned `run` that only sets the config dir and execs `pi`. Default launch is `pi`. Isolation removes agent-dir settings, packages, MCP servers, `AGENTS.md` and `APPEND_SYSTEM.md` (stage 0, D), but **not** `~/.agents/skills` or parent-directory `AGENTS.md` files (D). Upstream proposal drafted below |
| R2 | `--no-context-files` | every agent | 1, corrected | Pi loads the project `AGENTS.md` natively, without trust. It also loads every parent directory's `AGENTS.md` in plain and isolated mode (A, D), so a project inside another repository inherits that repository's coding instructions. `--no-context-files` drops the project's own file too (G) and has no settings equivalent. Faur's check reports parent context files; `orchestrator.projectContext` (#33) becomes unnecessary |
| R3 | `--append-system-prompt .pi/CAPABILITIES.md` | every agent | 1, verified | `.pi/APPEND_SYSTEM.md` loads natively once the project is trusted, in plain and isolated mode, and replaces the user's `APPEND_SYSTEM.md` instead of combining with it (A vs E). It reaches the lead only: foreground and background specialists receive only their own agent prompt (S1, S4), so specialists keep their capability section in `.pi/agents/<name>.md`. Ownership choice for stage 1 below |
| R4 | `.env` loader for declared names in `run` | agents with `integrations.env` | 1 | The caller's environment (shell, direnv), Pi's `${VAR}`/`!command` in MCP config, Pi `/login` for providers. Document; Faur check reports missing names |
| R5 | `pi --approve` (trust per run) | every agent | 1, verified | Pi's project trust prompt, once. In print, JSON and RPC mode an undecided trust skips every project resource without an error (E, F): a headless caller needs a saved decision or `--approve` |
| R6 | Faur package pin | every agent | — | Removed |
| R7 | `pi-subagents` pin | every agent | 2, verified | Kept, only when `agents[]` is non-empty. A project pin replaces a user-level install of the same package, whatever its version (A: host 0.65.0, project 0.83.1 loaded) |
| R8 | `forceTopLevelAsync` in `.faur/pi-home/extensions/subagent/config.json` | specialists using MCP or extension tools | removed (#72) | pi-subagents 0.83.1 reads this setting only from the Pi agent directory; plain `pi` and tracked files do not include it. Faur no longer forces a launch mode. Real-Pi tests verify selected MCP calls and denied non-selected calls in foreground and background. Foreground extension tools require their native extension path; Faur reports that it cannot verify the mapping. |
| R9 | `memory` tool and `.pi/MEMORY.md` injection (`agent-extension.mjs`) | every orchestrator | 3 | Packages exist (`@henryqw/pi-memory` 10.2.0, `pi-hermes-memory` 0.10.0, both MIT, active) but add stores, search and policy the agents do not need. A project convention: a notes file the lead may edit, referenced from its prompt. Not verified by a run |
| R10 | MCP `approveTools` per-call approval, blocked without UI (`registerMcpBoundary`) | agents with approvals | 2, candidates | Two maintained MIT packages with project-level native config, loaded only after trust, that gate built-in MCP tools and block an `ask` with no UI: `@gotgenes/pi-permission-system` 42.0.0 (`.pi/extensions/pi-permission-system/config.json`, server/tool rules, `confirmation_unavailable`) and `pi-allowlist-plugin` 1.3.4 (`.pi/allowlist-gate.json`, `mcp:<server>:<tool>` rules). Read from their documentation only. **Chosen (2026-11-03): `@gotgenes/pi-permission-system`**: 48,130 downloads in the last month, 262 releases since 2026-05, 22 contributors, against 1,013 downloads and one author for `pi-allowlist-plugin`. It churns (major 42), so projects pin an exact version. A real-Pi run against the stub server is the first task of stage 3 |
| R11 | Orchestrator without `mcp` cannot call MCP tools (`registerMcpBoundary`) | agents whose lead has no `mcp` | 2 or 4, corrected | No native setting scopes MCP to subagents: project `defaultTools` does not remove MCP tools (R11a), server `exposure` applies to every process, and only the CLI `--tools` allowlist does (R11b), which a plain `pi` launch cannot carry. A deny rule in the R10 package, or an advisory statement |
| R12 | Declared `cli:` command tools: no shell, placeholders, approval (`permissions-extension.mjs`, `cli-tools.mjs`) | agents with `integrations.cli` (B, C) | 4, confirmed | No package or Pi built-in defines named, no-shell command tools; the gates above match `bash` command lines, which still run in a shell. One small generic package configured natively, or a project-owned extension when only one project needs it |
| R13 | `request_permission`, pending requests, "always allow" saves to `system.yaml` | every orchestrator | remove | Asking once comes from the R10 package. Saving a command is a design change: the developer asks Faur. Drop the runtime write path |
| R14 | Credential notice at session start | every orchestrator | 1 | Pi reports missing provider auth; Faur's check reports it before a run |
| R15 | Agent-context fallback for pre-`CAPABILITIES.md` projects | none current | — | Delete |
| R16 | `./run --workflow`: validation, setup preflight, lock, timeout, systemd scope, pi-subagents cleanup, JSON line, exit codes (`workflow-runner.mjs`) | B, C; TOaD's caller MCP server | 1 + 4, verified | Invocation: `pi -p "/skill:<workflow> …"` expands the skill (Q1); success exits 0 with the answer on stdout (Q2); a provider failure retries, then exits 1 with the error on stderr and empty stdout (Q3); `--mode json` ends with `agent_end` (final message, usage) then `agent_settled` (Q4). Print mode waits for stdin EOF when stdin is not a terminal, so callers close it. Left for an optional caller-side adapter (#46 re-scoped): timeout and cancellation, the task outcome (exit 0 is run success only), locks, artifacts. Setup preflight moves to Faur's check |
| R17 | Headless approval blocking signal (`workflow-approval.mjs`, exit 3) | B, C | 2 + 4 | Blocking without UI comes from the R10 package; a blocked call surfaces as a tool error, not an exit code, so the caller adapter maps it to a status |
| R18 | `/faur` maintenance, `forge_plan`, `/faur env`, `/faur permissions`, `/faur sync` inside the agent | every agent | — | Faur in the developer's Pi, operating on the project from outside. `/faur env set` is removed in favor of external configuration |
| R19 | `.forge/build.json`, `.forge/capabilities.json`, `.forge/check.json` | Faur only | — | Faur metadata; location decided with `system.yaml`'s (stage 4) |

After stage 0 (below), the class 4 work is R12 (declared commands) and the
caller adapter in R16. R10 and R17 have package candidates to verify in stage 3,
R13 is removed, and R11 needs the R10 package or an advisory statement. If no
candidate passes, the gates join R12 in **one** small generic package (configured
natively, unaware of `system.yaml`) rather than a renamed Faur runtime.

### Stage 0 results (2026-11-03, #60)

Pi 1.5.0, pi-subagents 0.83.1 (project) and 0.65.0 (host), pi-mcp-adapter
2.32.1 (host). Reproduce with `bash skills/faur/test/pi-lab/stage0.sh`. It
builds a fake host agent directory and a target-shaped project with no Faur
in it, and makes no model calls: a probe extension records what loaded, a stub
MCP server answers tool calls, and a scripted fake model drives tool calls in
lead and child processes. Case letters below and in the table above are the
script's.

**Plain `pi` with a developer's global configuration (A, B, E).** Project
settings override user settings and resource lists combine, as documented.
In practice:

- A host extension that registers `/mcp` (here `pi-mcp-adapter`) replaces
  Pi's built-in MCP for the session (A). The project's `.pi/mcp.json` is then
  read by the adapter, not by Pi: tools appear as one proxy per server
  (`mcp__projsrv`), not `mcp__<server>__<tool>`, so generated capability text
  is wrong, and the adapter 2.32.1 ignores Pi's `toolExposure`. A tool the
  project marks `hidden` is unreachable under built-in MCP (H1) and callable
  through the adapter's `mcp` proxy (H2). **`toolExposure: hidden` is
  enforced only when built-in MCP is the MCP implementation.**
- Adapter 2.32.1 also starts an untrusted project's MCP server when trust is
  undecided (U1; built-in MCP does not, U2). Fixed upstream in 3.0.0
  (2026-09-26); 5.0.0 reads Pi's `mcp.json` and `toolExposure`. Not
  re-tested on 7.0.0. Faur's check should report an adapter below 3.0.0.
- A project can switch off a known conflicting host package natively, with a
  package entry that loads none of its resources: `{ "source":
  "npm:pi-mcp-adapter@…", "extensions": [], "skills": [], "prompts": [],
  "themes": [] }` restores built-in MCP (C). This only works for packages
  Faur names in advance.
- Host MCP servers are added to the project's (B), and project trust does
  not remove them. A project can disable one only by name (`"<server>":
  { "enabled": false }`).
- Host `AGENTS.md`, host skills and every parent directory's `AGENTS.md`
  load; a project `APPEND_SYSTEM.md` replaces the host's (A).

**Isolated mode (`PI_CODING_AGENT_DIR` set to a project directory, D, F).**
None of the host's packages, extensions, MCP servers, `AGENTS.md` or
`APPEND_SYSTEM.md` load; project packages, MCP servers and skills do. Not
removed: skills in `~/.agents/skills` (read from the home directory) and
parent-directory `AGENTS.md` files. With trust undecided, the project's
resources are skipped as in plain mode (F). Where a saved trust decision
lives under a custom agent directory was not tested.

**pi-subagents (S1–S4).** See R8: foreground children get built-in MCP tools,
and extension tools when the agent lists the extension path. Children receive
only their own agent prompt: no `AGENTS.md`, no `APPEND_SYSTEM.md`, in either
mode.

**Native prompt loading, for #61.** Two native homes for the lead's
capability section: `.pi/APPEND_SYSTEM.md` (trusted projects only, lead only,
replaces the user's file) or `AGENTS.md` (loaded without trust, combined with
host and parent files, and also read by coding agents that edit the project,
which conflicts with #33). `APPEND_SYSTEM.md` fits; the open choice is
ownership, because today it mixes the authored lead prompt with generated
text. Either generate the whole file from the design record (drift reconcile
in #64 handles hand edits), or keep a marked generated block in an authored
file.

### Stage 1 results (2026-11-03, #61)

- The lead's capability section, specialist launch note and document formats
  follow its prompt in `.pi/APPEND_SYSTEM.md`, between `forge:derived`
  markers. The prompt keeps the authored-file rule; the section is rewritten
  with the declarations, and a hand edit inside it, or text after it, is a
  conflict. `.pi/CAPABILITIES.md`, the launcher's prompt flags and
  `--no-context-files` are gone (R2, R3); `orchestrator.projectContext` is
  removed from the schema. Generation warns about `AGENTS.md` files from
  outside the project.
- Memory is removed (R9, decided 2026-11-03: no package is worth its
  surface, and a notes file named in a prompt covers the need). The session
  credential notice moved to `/faur check` (R14); the pre-`CAPABILITIES.md`
  fallback is deleted (R15).
- Pins by need (`deps.mjs` `runtimeNeeds`): Forge only for declared commands,
  MCP approvals, a lead kept from MCP, or workflows; `pi-subagents` only for
  specialists or the `subagent` tool. The Forge runtime also stays unloaded
  for such a design when Faur is installed in the developer's Pi. `/faur sync`
  on an unpinned project rebuilds it with the running Faur.
- Pay-per-use files: no `mcp.json` without MCP servers, no `.env.example`
  without env names, no `data/knowledge/`, no `.pi/agents/` without
  specialists, and the workflow block in `run` once, only with workflows.
- Proof: `package-sdk.test.mjs` generates the minimal agent, deletes
  `system.yaml` and loads it in real Pi with an empty agent directory: the
  prompt holds the authored text and the generated section, the tools are
  the four declared built-ins, and no Faur tool or command loads.

### Stage 2 results (2026-11-03, #62)

- Projects start with `pi`. `run` is generated only for designs with MCP
  servers, because hiding, approvals and the generated MCP tool names depend on
  Pi's built-in MCP; it sets `PI_CODING_AGENT_DIR` and runs `exec pi "$@"`,
  nothing else (no `.env` loader, no `--approve`, no `system.yaml` check, no
  workflow logic). `launcher.test.sh` proves arguments pass unchanged, `.env`
  is not read and the design record is not needed (R1, R4, R5).
- Workflows are skills run with `pi --approve -p "/skill:<workflow> <request>"`.
  A workflow without `skill:` gets a generated skill named after it. The
  workflow runner, its lock files, systemd scope, pi-subagents cleanup, JSON
  line, exit codes and approval signal file are deleted (R16, R17's signal);
  a blocked call is a tool error in the run. `headless-workflow.test.mjs`
  runs real Pi with a scripted model: approvals are refused headless with no
  side effect, and a workflow with MCP and no commands runs with no Faur
  package. Caller concerns (timeout, cancellation, locking, structured
  results) are left to the caller adapter (#46).
- `/faur check` reports declared env names unset in the current environment,
  and, for designs with MCP servers, a user-level package that replaces
  built-in MCP (from the user's `settings.json`, or the session's `/mcp`
  owner). Workflows no longer pin Forge.
- Not done here: TOaD's caller still uses its pinned v0.29.1 runner until it
  moves to `pi -p` (next step). The isolated `run` loading no user package,
  MCP server or instruction rests on stage 0 (D) and `isolation.test.sh` (C).

**Current decision:** Faur no longer generates MCP per-call approval gates or
pins pi-permission-system. The Stage 3 trial and results below are historical;
`approveTools` is rejected. CLI command approvals remain supported.

### Stage 3 trial: `@gotgenes/pi-permission-system` 42.0.0 (2026-11-03, #63)

Real Pi 1.5.0 with the package as a project package
(`.pi/extensions/pi-permission-system/config.json`), the stub MCP server and the
scripted model (lab under the scratch directory; same helpers as stage 0).

- **Headless `ask`: blocked.** `"projsrv:projsrv_secret": "ask"` refuses the call
  without a UI with `requires approval, but no interactive UI is available`,
  naming tool, rule and server; the server never receives it.
- **Interactive `ask`: asks.** Over RPC mode the package shows a select dialog
  (`Permission Required`, tool, surface, rule); `Yes` runs the call, `No`
  refuses it.
- **Project-wide `deny` reaches the lead and background specialists** (their
  MCP tools are removed before they start), **not foreground specialists**,
  which do not load the parent's extensions.
- **Per-agent rules do not work for a project install.** pi-subagents 0.83.1
  adds the package to a child only when the agent file has `permission:`
  frontmatter, and looks for it only in the user-level agent directory
  (`child-tool-plan.js` `resolvePermissionSystemExtension`). Installed in the
  project, the first child runs ungated; once the package has written its log
  folder under the agent directory, every launch fails with `Permission-system
  package manifest is missing`. So the lead's MCP boundary (lead denied,
  specialists allowed, R11) cannot be expressed with this package as a project
  dependency.

Consequences: `approveTools` (R10, R17) maps to the package's `ask` rules.
Background specialists get the same rules, so an approved call stays the
lead's, as the validator already requires. A foreground specialist would
bypass them, so designs with approvals keep forced background launches (R8),
which only `run`'s isolated home applies. R11 needs the declared-commands
package (it knows parent from child) or becomes advisory.

### Stage 3 results (2026-11-03, #63)

- Nothing of Faur runs in a generated agent, and projects never pin Faur (most
  of #64's "no project pin"). `agent-extension.mjs`, the run-time half of
  `permissions-extension.mjs` (now `permissions-command.mjs`: list, add,
  remove) and the command runner in `cli-tools.mjs` are deleted.
- **Declared commands (R12):** [pi-commands](https://github.com/mihaiiova/pi-commands)
  v0.1.0, the one new package: named tools without a shell, `{placeholder}`
  values that cannot become options, per-run approval refused without a UI,
  configured by the generated `.pi/commands.json` (`lead` marks the commands
  the main session gets). It has no dependency on Faur and its own tests,
  including a real-Pi headless run.
- **MCP approvals (R10, R17):** `@gotgenes/pi-permission-system` 42.0.0,
  configured by the generated `.pi/extensions/pi-permission-system/config.json`
  (`"<server>:<pattern>": "ask"`).
- **Lead MCP boundary (R11):** removed, decided 2026-11-03. It was not a
  security boundary (specialists have the tools, and the lead delegates to
  them); the generated README lists it under advisory.
- **`request_permission` and pending requests (R13):** removed. An agent that
  lacks a command says so; adding one is a design change through Faur.
- `/faur sync` rebuilds with the running Faur; a pin left by v0.30.0 or
  earlier is dropped after confirmation. `maintenance-rebuild.mjs` stays, so
  those older pinned releases can still sync forward. **Superseded 2026-11-03:**
  the compatibility entry point is removed. Older pinned `/faur sync` cannot
  update directly to a release without it; use the new Faur checkout's
  `forge generate <project> --dry-run`, then `forge generate <project>` and
  approve the preview. Resolve reported drift before applying. A scratch
  project generated with the v0.30.0 CLI and a declared command was previewed
  and regenerated by the newer CLI: the Forge pin became pi-commands. A real
  Pi probe loaded `cli_hello` and no Faur command or tool.
- Proof: `headless-workflow.test.mjs` installs both packages from GitHub and
  npm into a generated project and runs real Pi headless: the gated command
  and the gated MCP call are refused with no side effect, `request_permission`
  does not exist, and a workflow with MCP runs with no Faur.

**Upstream proposal, draft (not filed).**

> **Let a project ignore user-level resources.** A trusted project often
> needs the same resources on every machine: a team agent, a CI job, a
> project that ships its own MCP servers. Today user-level packages,
> extensions, skills, MCP servers and context files merge into every project,
> and a user extension that registers `/mcp` replaces built-in MCP, so the
> project's `mcp.json` exposure settings stop applying. The only way out is
> `PI_CODING_AGENT_DIR`, which also moves logins, models and trust decisions,
> and still loads `~/.agents/skills` and parent `AGENTS.md` files.
>
> Proposal: a project setting `"userResources": false` in
> `.pi/settings.json`. When the project is trusted, Pi skips the agent
> directory's `packages`, `extensions`, `skills`, `prompts`, `themes`,
> `mcp.json`, `AGENTS.md`, `APPEND_SYSTEM.md` and `SYSTEM.md`, and the
> `~/.agents/skills` directory. Logins (`auth.json`, `mcp-auth.json`),
> `models.json`, keybindings and trust decisions still come from the user.
> Optionally `"parentContextFiles": false` stops context-file discovery above
> the project root. The setting only removes resources, so like
> `sessionDir` it can be read before user extensions load, and an untrusted
> project cannot use it to add anything.

### Stage 4 decisions (2026-11-03, #64)

**Rename migration decision (2026-11-04, #67):** Faur does not recognize
old Pi Forge ownership markers or pinned sync machinery. Regenerate into a
new directory from the old design, keep the original intact, and manually
review and reconcile authored files. Never replace old files silently. A
GitHub issue amendment is required before closing #67.

**Metadata location — approved:** keep the design
record at `.pi/system.yaml` and maker records (`build.json`,
`capabilities.json`, `check.json`) under `.forge/` until the rename. Moving
all records under `.pi/` would mix maker state with native Pi configuration;
moving the design record under `.forge/` would require a relocation without
changing runtime behavior. A later rename to `.faur/` can rename the maker
state once, subject to separate approval. `.forge/pi-home` is distinct: it is the Pi
configuration directory used by isolated projects, not just maker metadata,
and its removal or relocation requires its own runtime verification.

**Environment command — approved direction:** remove `/faur env set` and
document external environment and integration secret-file setup instead. Pi
does not load `.env`; users must export variables or use a loader such as
direnv, and integrations must themselves read their declared secret files.
This is not isolation or credential protection.

**#64 implementation under review:** `/faur drift` previews per-file adoption,
reapplication and selected-field reconciliation for supported settings, lead
and specialist prompts, MCP servers and declared commands. Changes go through
`planChange`/`applyChange`, require interactive approval, and refuse stale
plans or collateral edits to other drifted files. Native-only settings and
supported unrepresented frontmatter are preserved and reported. Comparison is
two-way: generator-version differences can appear as drift, and not every
native Pi feature is inventoried. The implementation deliberately refuses
unsafe cases rather than silently changing runtime behavior: examples include
ambiguous unmarked specialist prompts, changed specialist capability grants,
edited generated instruction sections, unsupported command configuration,
and MCP exposure changes that cannot be represented safely. Resolve those
manually; this is not general automatic reconciliation of all native features.

`package-sdk.test.mjs` exercises generated projects with real Pi: adopting a
prompt and settings followed by another revision, adopting and reconciling
MCP changes, and deleting `system.yaml` before reconstructing it with `forge
import`. The latter checks the same Pi prompt and active tools before deletion,
after deletion, and after import, and verifies that a native-only setting is
reported and retained. This is evidence for those cases, not for every Pi
feature. Import is conservative and may scaffold missing files; inspect its
report and preview further generation.

**Epic acceptance discrepancy:** #59 asks isolated mode to exclude all global
skills and instructions, but stage 0 showed `~/.agents/skills` and parent
`AGENTS.md` still load. The supported guarantee is Pi agent-directory
isolation, not that stronger criterion; do not claim it passed.

### Staged migration

Each stage leaves every reference agent working. Nothing is deleted before its
users have the replacement, and Revisor (the only external consumer of the
workflow runner) moves before the runner is removed.

| Stage | Outcome | Removes | Acceptance |
|---|---|---|---|
| 0. Verify (done 2026-11-03) | Confirm the "verify" rows: global-resource merging (including the `pi-mcp-adapter` conflict) in plain and isolated mode, pi-subagents project configuration, existing packages for R9/R10/R12, Pi structured or JSON output for R16. Draft the upstream Pi proposal for ignoring user-level resources | nothing | Stage 0 results above; `skills/faur/test/pi-lab/stage0.sh` reproduces them |
| 1. Native prompt and output (done 2026-11-03, #61) | Capability section and context load natively; output is pay-per-use (no `pi-subagents` without specialists; no empty `mcp.json`, `.env.example`, `data/knowledge/`) | R2, R3, R14, R15, `projectContext` | The minimal agent runs with plain `pi` and no Faur installed |
| 2. Launch and headless (done 2026-11-03, #62) | `run` optional and minimal; documented environment; workflows invoked with `pi -p`; Faur's check reports host-config conflicts and setup | R1 (as requirement), R4, R5, R16 runner after Revisor migrates | Marketing agent without approvals or commands runs headless with plain `pi`; isolated mode excludes global packages, proven with the `pi-mcp-adapter` conflict |
| 3. Enforcement without Faur (done 2026-11-03, #63) | Approvals, declared commands, headless blocking from an existing or one new generic package; first run the R10 candidates against the lab's stub server | R10–R13, R17 from Faur | B and C run with plain `pi`; enforcement tests (approval asks, blocks headless; commands run without a shell) pass without Faur installed |
| 4. Faur as maker | Faur runs only in the developer's Pi; projects pin no Faur; `system.yaml` is the design record with drift reconcile (reuse `import`, generate, diff); metadata location decided; rename to Faur | R6, R18, R19 relocation | Generate → edit native files by hand → reopen with Faur → adopt → revise again, with no manual edit lost |

The end-to-end acceptance test for the migration: generate a project, remove
Faur from the environment, enter the project and run `pi`. It works with
its declared capabilities.

### 2026-11-04: #72 launch-mode correction

Faur no longer generates the isolated-home subagent setting or an `async` default. The earlier stage-2 approval discussion below is historical: Faur no longer provides MCP per-call approvals. The #72 real-Pi test uses tracked generated files and verifies MCP selection in both launch modes. Foreground extension paths still require developer configuration; tool registration in the lead alone does not prove the specialist will load one.
