# Faur (Pi Forge) — roadmap

The single roadmap. Issues live in GitHub under epic
[#24](https://github.com/mihaiiova/pi-forge/issues/24); this file orders them.
Engineering principles are in [AGENTS.md](../AGENTS.md). The 2026-11-02
architecture review is recorded in
[architecture-audit.md](architecture-audit.md),
[generated-agent-audit.md](generated-agent-audit.md) and
[backlog-review.md](backlog-review.md).

## Status (2026-11-03)

- **Shipped:** #25 and #41 (v0.19.0); #27 and #28 (v0.20.0); #34 and #32
  (v0.21.0); browsing without asking (v0.22.0); the discuss/apply/discard
  prompt (v0.23.0); permission guidance (v0.24.0); trusted-run credential
  documentation (v0.25.0); #33 (v0.25.0); #49 and #50 (v0.26.0); #65
  (v0.28.0); #66 (v0.29.0); regenerating projects that installed packages
  (v0.29.1).
- **Versioning:** below 1.0. Pre-1.0 releases may break projects, which are
  regenerated.
- **Direction change (2026-11-02):** Faur is only the maker. Generated
  projects become ordinary Pi projects that run with `pi` without Faur
  (#59). The current release still pins the Forge package and requires
  `./run`; the migration is staged below.
- **Next, in order:**
  1. Migration #59: #60 (done 2026-11-03; results in
     [architecture-audit.md §5](architecture-audit.md#stage-0-results-2026-11-03-60))
     → #61 (done 2026-11-03) → #62 (done 2026-11-03; TOaD moves next) → #63 → #64, then #67 (rename to Faur).
  2. Reliability goals, re-specified for plain Pi: #43 → #44 → #46; #45; #54.
  3. #68, the public-alpha gate (harness early, criteria pass as issues land).
  4. Composition and evidence: #29, #30, #31, #35, #40.
  5. When a reference agent needs them: #37, #38, #39, #51, #52, #69.
  6. Deferred: #48 (compose an existing sandbox), #70 (protected
     integrations).
- **Known limitations (current release):**
  - A personal Forge install from a local checkout loads next to a project's
    pin, so commands appear twice inside generated projects (install from the
    git tag instead).
  - Plain `pi mcp list` in a project's isolated home ignores the project until
    trust is saved; `/mcp` inside `./run` works, and `check-agent --connect`
    saves the trust itself.
  - `./run --workflow` needs one interactive `./run` first, which installs the
    pinned Forge package that holds the runner.
  - Without a systemd user scope (always on macOS), a timeout stops the process
    group and the invocation's pi-subagents runs; a process that detaches on
    its own can survive.
  - Trusted runs share credentials with every agent and tool; there is no
    same-user confidentiality (#70).

## Public alpha: architecture criteria

Tracked as #68; each criterion is a test on the minimal, marketing and QA
reference agents.

1. **Independent:** with Faur removed from the environment, `pi` in the
   project loads the declared tools, skills, MCP servers and agents.
2. **No design record needed:** deleting `system.yaml` changes nothing at run
   time.
3. **Minimal baseline:** the minimal agent pins no packages and contains only
   what its declarations need.
4. **Developer ownership:** hand edits to native files survive reopening,
   adoption and a further revision; regenerating twice changes nothing.
5. **One lifecycle:** generating a design from scratch equals applying the
   same change to a smaller design.
6. **Enforcement is real:** every "enforced" statement in generated text has a
   passing real-Pi test; nothing claims credential protection or OS isolation.
7. **Isolation is what it says:** plain `pi` reports host conflicts (shown with
   a global `pi-mcp-adapter`); the optional isolation script loads no host
   resources.
8. **Truthful capabilities and outcomes:** capability text matches exposure;
   headless runs report task outcome separately from run status.

## 1. Audit at v0.18.0 (historical)

Kept as the record that shaped milestones 0–4. The current audit is
[architecture-audit.md](architecture-audit.md).


Facts below come from the source and from running the tests. Where something
is inferred instead, it is marked as an assumption.

- **Tests:** `bash skills/agent-factory/test/test.sh` passes: 25 node suites
  (≈215 tests) and 8 shell suites. Live inference and clean-environment network
  tests are opt-in and were skipped.
- **Size:** ≈5,900 lines of `.mjs`, of which ≈1,600 are maintenance
  (`maintenance*.mjs`).

| Capability | Status | Evidence |
|---|---|---|
| Conversational design (explore → synthesize → build) | Implemented, satisfactory | `SKILL.md`; scenarios in `docs/agent-factory-conversation.md`; skill-contract test |
| Declarative model and validator (`system.yaml` schema 1) | Implemented, satisfactory | `validate.mjs`, `schema.md`; strict unknown-key and reference checks |
| Deterministic generation, ownership, dry-run, idempotence | Implemented, satisfactory | `generate.mjs`; golden fixtures; fingerprint conflicts |
| Isolated launcher (`./run`) | Implemented, satisfactory | `runtime.mjs`; launcher and isolation suites |
| Per-agent models and thinking | Implemented, satisfactory | `models.mjs` |
| Skills from skills.sh (search, preview, pin, project-local install) | Implemented, satisfactory | `registry-skills.mjs`, `skill-sources.mjs` |
| Specialists, enforced tool allowlists, background launch for extension/MCP tools | Implemented, satisfactory | `policy.mjs`, `generate.mjs` (`needsBackground`), `asking.mjs` |
| Calls that ask the user, kept with the orchestrator | Implemented, satisfactory | `asking.mjs`; generated "What you can use" sections |
| Declared CLI commands with per-run approval, `request_permission` | Implemented, satisfactory | `cli-tools.mjs`, `permissions-extension.mjs` |
| MCP configuration, env-var credentials, hidden tools, `approveTools` | Implemented; **to be replaced** | `mcp-gen.mjs`. Depends on `pi-mcp-adapter` and disables Pi 1.4's built-in MCP (`-builtin:mcp` in `generate.mjs`). Moving to the built-in (#28) |
| Documents (agreed formats, MCP delivery) | Implemented, satisfactory | `documents.mjs` |
| Memory (`.pi/MEMORY.md`) | Implemented, satisfactory | `memory.mjs`, `agent-extension.mjs` |
| Revision via `/factory-update <request>` → preview → `apply` | Implemented, satisfactory | `maintenance-extension.mjs` (`factory_plan`), `maintenance.mjs` (`planChange`) |
| Builder-time discovery (`factory discover`) | **Partial** | Covers models, the user's skills, MCP config files, project agents and named CLIs. Pi packages and extensions are not covered (`factory.mjs` `runDiscover`) |
| Revision-time discovery (`factory_plan discover`) | **Partial** | skills.sh, npm free-text search (not filtered to `keywords:pi-package`), MCP registry, docs fetch |
| Package inspection before proposal | **Missing** | `packages[]` is only checked for a pinned spec (`deps.mjs`). Nothing reports what a package loads or registers, its install scripts, or its license |
| Selecting a subset of a package's resources | **Missing** | Pi supports `{source, extensions, skills, prompts}` filters (Pi `docs/packages.md`). `packages[]` accepts strings only |
| Effective-capability verification | **Partial** | `capabilities.json` is derived from declarations only. `launchCheck` checks subagent tools at session start against cached MCP lists and live registrations. It checks only the orchestrator's CLI commands, and there is no explicit command to run it |
| Workflows | **Partial** | Declared boundaries plus a generated orchestrating skill (`workflow-skill.mjs`). `trigger.kind` is `manual` or `headless`. There is no defined way to invoke one headlessly, and no exit-status or output contract |
| Scheduling and event triggers | **Missing** | Deferred by design in the MVP (`docs/agent-factory.md` decision 2) |
| Execution history | **Partial** | Pi sessions in `.factory/pi-home/sessions`. `subagentRuns` summarizes `pi-subagents` launches. Top-level headless runs are not recorded |
| Functional verification | **Missing** | `workflows[].verify` is free text. Live tests are opt-in and generic, not agent-specific |
| Maintenance: versioned bundles, integrity, update checks, rebuild, rollback, recovery | Implemented; **to be removed** | ≈1,600 lines plus a 478-line doc. Replaced by a pinned Pi package (#41) |
| Import of non-Forge Pi projects | Implemented, satisfactory | `import.mjs` |
| Generating into an existing repository (use case C) | **Defect** | An existing `.gitignore` is kept unchanged, so `.factory/` (including `pi-home/auth.json`) and `.env` are not ignored. Reproduced with `factory generate` on a repository that has its own `.gitignore` |
| A coding harness reading its repository's own `AGENTS.md` | **Missing** | The launcher always passes `--no-context-files`, which also drops the project's own file |

**Owlie marketing agent** (`~/projects/owlie/marketing`, read only). It is on
0.18.0 and built with 0.18.0. It has OpenSEO and PostHog MCP, six declared
`gh` commands, `pi-web-access` (added by hand as a package, with nothing
attributing `web_search` to it), one declared workflow (`baseline`) and no
schedule. Its `run-history.jsonl` holds three failed specialist launches and no
record of the top-level runs. Search Console is reached only through OpenSEO's
`get_search_console_performance`. These observations shaped Milestones 1, 2
and 4. The agent itself is not carried forward: it will be rebuilt from scratch
with Forge.

## 2. Most significant gaps

1. **Packages and extensions are opaque.** Forge can pin a package but cannot
   say what it will load, register or execute, or whether a needed tool
   actually comes from it.
2. **No unattended execution.** There is no workflow invocation contract, no
   run record and no scheduling.
3. **Configured is not shown to work.** Checks stop at structure and
   availability. Agent-specific behavior is never exercised.
4. **Revision has little evidence.** It has only specialist-launch summaries
   and tool-failure flags from the current conversation.
5. **Credential exposure when generating into an existing repository**
   (defect).
6. **Naming and commands.** Old names, plus `/factory-update update`,
   `/factory-update check` (which checks for tooling updates, not the agent),
   and `apply` as a separate command.

## 3. Considered and rejected

| Proposal | Why rejected |
|---|---|
| A separate "conversational modification" feature | `/factory-update <request>` already inspects, proposes a small change, previews it and applies on approval. The real gaps are evidence (M4), schedules (M2) and the command surface (M0) |
| Execution evidence exposed as its own feature | Folded into M4: it needs the run index (M2) first |
| A plugin API or capability marketplace | Composition uses Pi packages, npm, the MCP registry and skills.sh as they are (non-goal) |
| A Forge scheduler or daemon | M2 configures an existing provider (`agents-cron`) |
| A migration bridge, `.factory/` → `.forge/` migration, compatibility aliases | No installed base to protect. Agents built by older versions are regenerated |
| A separate in-project maintenance skill | One `forge` skill designs outside a project and revises inside one |
| Keeping `pi-mcp-adapter` | Pi has built-in MCP; built-ins are always preferred |
| A memory database or vector store | `.pi/MEMORY.md`, project files and Pi sessions cover the reference cases |
| A Faur run-time package, under any name (2026-11-02) | Generated projects run with Pi and existing packages; at most one small generic package configured natively (#63) |
| A built-in recorded-command type (#47) | Revisor's project-owned recorder works behind declared commands |
| Faur-managed sandbox VMs (#48 as first written) | Compose an existing sandbox (#48 rewritten) |
| A protected-credential supervisor (#57, #58) | No evidence it is needed yet; requirements kept in #70 |
| A general evaluation framework or LLM grading | M3 checks observable behavior only |
| Implementing several schedule backends, or a systemd fallback | One provider |
| Per-build package pins (an idea in earlier notes) | No reference use case needs it yet |
| An investigation into naming | Decided: Pi Forge, `/forge` (2026-10-29); superseded by the Faur rename (#67) |
| Trading execution for use case B | Out of scope until enforceable risk and permission boundaries exist |

## 4. Milestones

Milestones may overlap. A hard dependency is a GitHub "Blocked by" link; a
soft one is noted as *after*.

### Milestone 0: Packaging, rename, command surface, and a security fix

Goes first because everything later is written against the new names and the
smaller codebase. There is no migration: projects built by older versions are
regenerated.

- [#25](https://github.com/mihaiiova/pi-forge/issues/25) `fix-existing-repo-gitignore`: protect `.factory/` and `.env` when generating
  into an existing repository. No dependencies; small.
- [#41](https://github.com/mihaiiova/pi-forge/issues/41) `forge-package`: ship Forge as a Pi package pinned in each project's
  `.pi/settings.json`, and delete the bundle, front-door, update-check and
  recovery machinery.
- [#27](https://github.com/mihaiiova/pi-forge/issues/27) `forge-rename`: **Rename pi-agent-factory to pi-forge and consolidate
  commands under /forge.** A plain rename with no aliases. Blocked by
  `forge-package`.

#25 and #41 shipped in v0.19.0, #27 in v0.20.0.

[#26](https://github.com/mihaiiova/pi-forge/issues/26) (the migration bridge) was closed: nothing needs to be migrated.

### Milestone A: Architecture alignment and Faur as maker (2026-11-02)

Goes next. Decided in the 2026-11-02 review; staged in
[architecture-audit.md §5](architecture-audit.md#5-runtime-dependencies-and-the-migration).

- [#65](https://github.com/mihaiiova/pi-forge/issues/65): generated security and capability text matches what is enforced. First; no dependencies.
- [#66](https://github.com/mihaiiova/pi-forge/issues/66): one plan/apply path for generate, modify and change. Before #61 and #64.
- [#59](https://github.com/mihaiiova/pi-forge/issues/59) epic, in order:
  [#60](https://github.com/mihaiiova/pi-forge/issues/60) verify Pi behavior →
  [#61](https://github.com/mihaiiova/pi-forge/issues/61) native prompt and pay-per-use output →
  [#62](https://github.com/mihaiiova/pi-forge/issues/62) plain `pi` launch, optional isolation script, `pi -p` →
  [#63](https://github.com/mihaiiova/pi-forge/issues/63) approvals and commands without the Faur runtime →
  [#64](https://github.com/mihaiiova/pi-forge/issues/64) Faur as maker, design record and drift reconcile.
- [#67](https://github.com/mihaiiova/pi-forge/issues/67): rename to Faur, with or after #64. The command became `/faur` in v0.27.0; the repository, package, CLI and folders follow.
- [#68](https://github.com/mihaiiova/pi-forge/issues/68): public-alpha acceptance tests (criteria above).

### Reliability from the first agent (#42), re-specified for plain Pi

- [#43](https://github.com/mihaiiova/pi-forge/issues/43) structured result → [#44](https://github.com/mihaiiova/pi-forge/issues/44) run folder → [#46](https://github.com/mihaiiova/pi-forge/issues/46) optional caller-side adapter (MCP). After #62.
- [#45](https://github.com/mihaiiova/pi-forge/issues/45) specialists stay in their project; [#54](https://github.com/mihaiiova/pi-forge/issues/54) reading reports without prompts (narrowed).
- [#51](https://github.com/mihaiiova/pi-forge/issues/51) code changes as hand-off, [#52](https://github.com/mihaiiova/pi-forge/issues/52) skill-preview guidance, [#69](https://github.com/mihaiiova/pi-forge/issues/69) name and description.
- Deferred: [#48](https://github.com/mihaiiova/pi-forge/issues/48) compose an existing sandbox; [#70](https://github.com/mihaiiova/pi-forge/issues/70) protected integrations.

### Milestone 1: Capability composition

- [#28](https://github.com/mihaiiova/pi-forge/issues/28) `mcp-builtin`: replace `pi-mcp-adapter` with Pi's built-in MCP.
  *After* `forge-package`, since the approval gate moves into the agent
  runtime. Shipped in v0.20.0.
- [#29](https://github.com/mihaiiova/pi-forge/issues/29) `package-discovery`: find candidate Pi packages for a requested capability.
- [#30](https://github.com/mihaiiova/pi-forge/issues/30) `package-inspection`: inspect an exact package version before proposing it.
- [#31](https://github.com/mihaiiova/pi-forge/issues/31) `package-resource-selection`: load only the package resources an agent
  needs. *After* `package-inspection` (soft since 2026-11-02).
- [#32](https://github.com/mihaiiova/pi-forge/issues/32) `capability-check`: verify effective runtime capabilities (`/forge check`). Shipped in v0.21.0.
  *After* `mcp-builtin`.
- [#33](https://github.com/mihaiiova/pi-forge/issues/33) `coding-harness-context`: opt in to the repository's own `AGENTS.md` (use
  case C).

### Milestone 2: Execution and triggers

- [#34](https://github.com/mihaiiova/pi-forge/issues/34) `workflow-invocation`: a headless workflow invocation contract. Shipped in v0.21.0.
- [#35](https://github.com/mihaiiova/pi-forge/issues/35) `run-index`: re-scoped 2026-11-02 to run summaries derived from Pi sessions on read. After #62.
- [#37](https://github.com/mihaiiova/pi-forge/issues/37) `workflow-schedule`: declare a schedule and install it with `agents-cron`.
  After #62, #35 and #31.

[#36](https://github.com/mihaiiova/pi-forge/issues/36) (choosing the scheduler) was closed with the decision in §6.

### Milestone 3: Functional verification

- [#38](https://github.com/mihaiiova/pi-forge/issues/38) `acceptance-scenarios`: declare scenarios and evaluate a run against them.
  Blocked by `run-index`.
- [#39](https://github.com/mihaiiova/pi-forge/issues/39) `scenario-runner`: run scenarios safely and report diagnostics. Blocked by
  `workflow-invocation` and `acceptance-scenarios`. *After*
  `capability-check`.

### Milestone 4: Operational evolution

- [#40](https://github.com/mihaiiova/pi-forge/issues/40) `run-evidence-revision`: revisions and `/forge status` use run evidence.
  Blocked by `run-index`. *After* `scenario-runner`.

## 5. Dependency order

```text
wording(#65)   lifecycle(#66) ─▶ native-output(#61), maker(#64)
verify(#60) ─▶ native-output(#61) ─▶ plain-pi(#62) ─▶ enforcement(#63) ─▶ maker(#64) ─▶ rename(#67)
plain-pi(#62) ─▶ result(#43) ─▶ run-folder(#44) ─▶ caller-adapter(#46)
plain-pi(#62) ─▶ run-summaries(#35) ─▶ run-evidence(#40)
public-alpha(#68): harness first; criteria depend on #59, #65, #66, #43

Before 2026-11-02:
fix-existing-repo-gitignore
forge-package ─▶ forge-rename
forge-package ··▶ mcp-builtin ··▶ capability-check ··▶ scenario-runner
package-discovery
package-inspection ··▶ package-resource-selection
coding-harness-context
workflow-invocation ─▶ run-index ─▶ acceptance-scenarios ─▶ scenario-runner
       │                 ├────▶ run-evidence-revision
       └─────────────────┴────▶ workflow-schedule
```

`─▶` blocks; `··▶` should come after.

## 6. Decisions

### 2026-11-02

- **Faur is only the maker** (#59). Generated projects are ordinary Pi
  projects that run with `pi`, with Faur uninstalled and without
  `system.yaml`. Supersedes "Distribution: a pinned Pi package" below.
- **Native Pi files are authoritative for execution; `system.yaml` records the
  last agreed design.** Drift is reconciled when Faur is invoked, previewed
  and approved; never continuously.
- **Launch:** plain `pi` (not hermetic; conflicts reported) or an optional
  project-owned script that only isolates the Pi configuration. Neither is OS
  isolation. Propose upstream a Pi project setting that ignores user-level
  resources.
- **Trusted execution is not protected integration.** #55–#58 closed as
  deferred; requirements in #70.
- **Compose, don't build:** #47 closed; #48 rewritten technology-neutral.

### 2026-10-29

- **MCP: Pi's built-in.** Built-ins are always preferred over packages. The
  built-in covers what Forge used the adapter for: `hidden` exposure and
  `toolExposure` for hiding, `--tools 'mcp__<server>__*'` for per-agent
  selection, `pi mcp list --json` for checks, OAuth. It has no `approveTools`;
  per-call approval becomes a `tool_call` gate in Forge's agent runtime, which
  Pi applies to every MCP call, including calls from codemode scripts (Pi
  `docs/mcp.md`, Permissions). Implemented by #28.
- **Scheduler: `agents-cron`.** Of the two packages that run with Pi closed,
  it is the more used and more maintained one (npm, 28 Sep–27 Oct 2026: 2,893
  downloads vs 473 for `pi-tick`; 66 commits in that month and 18 releases vs 4
  commits and no release since 2 Oct). It keeps its store in the project
  (`.agents/cron/`), runs one isolated session per run, and its CLI (`add
  --cron … --agent pi`, `remove`, `list --json`) is all Forge needs, so agents
  never get scheduling tools. Risks: it is young (created Sep 2026) and
  AGPL-3.0. Forge neither bundles nor modifies it (Pi installs it from npm
  and Forge calls its CLI), so it should not affect Forge's own license;
  recheck if that changes. No fallback provider.
  Implemented by #37.
- **Distribution: a pinned Pi package** *(superseded 2026-11-02 by #59)*. Each project pins
  `git:github.com/mihaiiova/pi-forge@vX.Y.Z` in `.pi/settings.json`. Pi
  installs it, a pin cannot move, a project entry replaces a personal install
  of the same package (so `/forge` registers once), and git provides history
  and rollback. This drops the frozen front door, the bundles, the update-check
  cache and the transaction journal. What is given up: offline first install,
  bundle integrity manifests (a pinned tag stands in for them), and a separate
  version for the agent runtime and the tooling. Implemented by #41.
- **No separate maintenance skill.** One `forge` skill: design mode outside a
  Forge project, revise mode inside one.

## 7. Issue index

| Issue | Milestone | Title |
|---|---|---|
| [#24](https://github.com/mihaiiova/pi-forge/issues/24) | — | Epic: Pi Forge roadmap — design, generate, check, and revise specialized Pi agents |
| [#25](https://github.com/mihaiiova/pi-forge/issues/25) | M0 | Protect .factory/ and .env when generating into an existing repository |
| [#41](https://github.com/mihaiiova/pi-forge/issues/41) | M0 | Ship Forge as a pinned Pi package and remove the bundle machinery |
| [#27](https://github.com/mihaiiova/pi-forge/issues/27) | M0 | Rename pi-agent-factory to pi-forge and consolidate commands under /forge |
| [#28](https://github.com/mihaiiova/pi-forge/issues/28) | M1 | Use Pi's built-in MCP instead of pi-mcp-adapter |
| [#29](https://github.com/mihaiiova/pi-forge/issues/29) | M1 | Discover Pi packages for a requested capability |
| [#30](https://github.com/mihaiiova/pi-forge/issues/30) | M1 | Inspect an exact Pi package version before proposing it |
| [#31](https://github.com/mihaiiova/pi-forge/issues/31) | M1 | Load only the package resources an agent needs |
| [#32](https://github.com/mihaiiova/pi-forge/issues/32) | M1 | /forge check verifies an agent's effective capabilities |
| [#33](https://github.com/mihaiiova/pi-forge/issues/33) | M1 | Let a coding harness load its repository's own AGENTS.md |
| [#34](https://github.com/mihaiiova/pi-forge/issues/34) | M2 | A headless invocation contract for declared workflows |
| [#35](https://github.com/mihaiiova/pi-forge/issues/35) | M2 | Record each headless run in a run index |
| [#37](https://github.com/mihaiiova/pi-forge/issues/37) | M2 | Declare a schedule for a workflow and install it with agents-cron |
| [#38](https://github.com/mihaiiova/pi-forge/issues/38) | M3 | Declare acceptance scenarios and evaluate a run against them |
| [#39](https://github.com/mihaiiova/pi-forge/issues/39) | M3 | Run acceptance scenarios safely and report diagnostics |
| [#40](https://github.com/mihaiiova/pi-forge/issues/40) | M4 | Use run evidence in /forge status and in revisions |
| [#43](https://github.com/mihaiiova/pi-forge/issues/43) | First run (#42) | Declare a structured result for workflows |
| [#44](https://github.com/mihaiiova/pi-forge/issues/44) | First run (#42) | Give each workflow run its own folder |
| [#45](https://github.com/mihaiiova/pi-forge/issues/45) | First run (#42) | Keep specialists in their project when the lead launches them |
| [#46](https://github.com/mihaiiova/pi-forge/issues/46) | First run (#42) | Expose declared workflows as MCP tools |
| [#47](https://github.com/mihaiiova/pi-forge/issues/47) | First run (#42) | Recorded commands: run shell commands with a timeout, secrets by name and a receipt |
| [#48](https://github.com/mihaiiova/pi-forge/issues/48) | Deferred | Compose an existing sandbox for agents that need containment |
| [#49](https://github.com/mihaiiova/pi-forge/issues/49) | First run (#42) | Declare and run setup steps for integrations |
| [#50](https://github.com/mihaiiova/pi-forge/issues/50) | First run (#42) | Guide the first run of a generated project |
| [#51](https://github.com/mihaiiova/pi-forge/issues/51) | First run (#42) | Let /faur change a project's own code |
| [#52](https://github.com/mihaiiova/pi-forge/issues/52) | First run (#42) | Flag skills that can't work in unattended workflows |
| [#53](https://github.com/mihaiiova/pi-forge/issues/53) | First run (#42) | Choose a separate model for /forge |
| [#54](https://github.com/mihaiiova/pi-forge/issues/54) | First run (#42) | Read without asking, and keep secret files out of reach |
| [#59](https://github.com/mihaiiova/pi-forge/issues/59) | A | Epic: Generated projects run as ordinary Pi projects (Faur is only the maker) |
| [#60](https://github.com/mihaiiova/pi-forge/issues/60) | A | Verify the Pi behavior the maker migration depends on |
| [#61](https://github.com/mihaiiova/pi-forge/issues/61) | A | Native prompt loading and pay-per-use generated output |
| [#62](https://github.com/mihaiiova/pi-forge/issues/62) | A | Launch with plain pi, an optional isolation script, and native headless runs |
| [#63](https://github.com/mihaiiova/pi-forge/issues/63) | A | Approvals and declared commands without the Faur runtime |
| [#64](https://github.com/mihaiiova/pi-forge/issues/64) | A | Faur as maker: no project pin, design record and drift reconcile |
| [#65](https://github.com/mihaiiova/pi-forge/issues/65) | A | Generated security and capability text matches what is enforced |
| [#66](https://github.com/mihaiiova/pi-forge/issues/66) | A | One plan/apply path for generate, modify and change |
| [#67](https://github.com/mihaiiova/pi-forge/issues/67) | A | Rename Pi Forge to Faur |
| [#68](https://github.com/mihaiiova/pi-forge/issues/68) | A | Public-alpha architecture acceptance tests |
| [#69](https://github.com/mihaiiova/pi-forge/issues/69) | Reliability | Change the system's name and description through /faur |
| [#70](https://github.com/mihaiiova/pi-forge/issues/70) | Deferred | Protected integrations for secret-consuming tools |

Done: [#25](https://github.com/mihaiiova/pi-forge/issues/25) and [#41](https://github.com/mihaiiova/pi-forge/issues/41) (v0.19.0), [#27](https://github.com/mihaiiova/pi-forge/issues/27) and [#28](https://github.com/mihaiiova/pi-forge/issues/28) (v0.20.0), [#32](https://github.com/mihaiiova/pi-forge/issues/32) and [#34](https://github.com/mihaiiova/pi-forge/issues/34) (v0.21.0). [#33](https://github.com/mihaiiova/pi-forge/issues/33) (v0.25.0), [#49](https://github.com/mihaiiova/pi-forge/issues/49) and [#50](https://github.com/mihaiiova/pi-forge/issues/50) (v0.26.0), [#65](https://github.com/mihaiiova/pi-forge/issues/65) (v0.28.0). Closed without implementation: [#26](https://github.com/mihaiiova/pi-forge/issues/26) (migration bridge, not needed), [#36](https://github.com/mihaiiova/pi-forge/issues/36) (scheduler, decided), [#42](https://github.com/mihaiiova/pi-forge/issues/42) (findings filed), [#47](https://github.com/mihaiiova/pi-forge/issues/47) and [#53](https://github.com/mihaiiova/pi-forge/issues/53) (not planned), [#55](https://github.com/mihaiiova/pi-forge/issues/55), [#57](https://github.com/mihaiiova/pi-forge/issues/57) and [#58](https://github.com/mihaiiova/pi-forge/issues/58) (deferred to #70, not delivered), [#56](https://github.com/mihaiiova/pi-forge/issues/56) (investigation complete).

**Next:** [#66](https://github.com/mihaiiova/pi-forge/issues/66), then [#60](https://github.com/mihaiiova/pi-forge/issues/60); the full order is in Status.
