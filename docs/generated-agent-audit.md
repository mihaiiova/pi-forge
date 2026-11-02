# Generated-agent audit (v0.26.0)

What Faur actually generates, judged against the minimal agent. Three
systems were generated with `node skills/forge/forge.mjs generate` at
`79d1b6a` (v0.26.0):

- **A. Minimal:** one orchestrator, one model, `tools: [read, grep, find, ls]`.
  No specialists, workflows, integrations or documents.
- **B. Marketing:** Owlie-shaped. Two remote MCP servers (one with
  `approveTools`, one with `includeTools`), two secret env vars, one approved
  `gh` command, `pi-web-access`, one specialist, one headless workflow with an
  authored skill, one document, one advisory policy.
- **C. QA:** Revisor's real `system.yaml` (`~/projects/revisor/agent`, built
  with v0.25.0): Playwright MCP via a project script, four declared commands
  backed by Revisor's own Bubblewrap recorder (`tools/revisor-exec.mjs`,
  `tools/revisor-sandbox.mjs`), two background specialists, a headless
  workflow, a document with a machine-read first line.

The `system.yaml` inputs for A and B are reproduced at the end. No feature was
implemented to make them work; gaps are recorded below.

## 1. Files generated

`✓` generated, `—` not generated. Lines in parentheses.

| File | Owner | A minimal | B marketing | C QA |
|---|---|---|---|---|
| `.pi/system.yaml` | developer (desired state) | input (9) | input (64) | input (219) |
| `.pi/settings.json` | derived | ✓ (14) | ✓ (17) | ✓ (15) |
| `.pi/mcp.json` | derived | ✓ empty (4) | ✓ (25) | ✓ (28) |
| `.pi/APPEND_SYSTEM.md` | authored, scaffold-once | ✓ (2) | ✓ (27) | ✓ (55) |
| `.pi/CAPABILITIES.md` | derived (build output) | ✓ (7) | ✓ (19) | ✓ (16) |
| `.pi/agents/*.md` | frontmatter derived, prompt authored | — | ✓ 1 (29) | ✓ 2 (64) |
| `.pi/skills/*/SKILL.md` | authored | — | ✓ 1 (9) | ✓ 2 (64) |
| `run` | derived | ✓ (41) | ✓ (60) | ✓ (41) |
| `README.md` | authored, scaffold-once | ✓ (46) | ✓ (66) | ✓ (65) |
| `.gitignore` | authored + required block | ✓ (11) | ✓ (11) | ✓ (11) |
| `.env.example` | authored | ✓ empty marker (1) | ✓ (3) | ✓ empty marker (1) |
| `data/knowledge/.gitkeep` | authored | ✓ | ✓ | ✓ |
| `.forge/capabilities.json` | derived, ignored | ✓ (37) | ✓ (91) | ✓ (131) |
| `.forge/build.json` | derived, ignored | ✓ (14) | ✓ (17) | ✓ (19) |
| `.forge/pi-home/extensions/subagent/config.json` | derived, ignored | — | ✓ (3) | ✓ (3) |
| Committed total (excl. `.forge/`) | | 10 files, 135 lines | 12 files, 330 lines | 14 files, 579 lines |

Project-owned code in C that Faur does not generate: `tools/revisor-exec.mjs`
(93), `tools/revisor-sandbox.mjs` (63), `tools/playwright-mcp.sh` (5), tests
(123), and the caller-side MCP server in `../mcp` (≈645).

## 2. Runtime dependencies

| Dependency | A | B | C | Needed by A? |
|---|---|---|---|---|
| Pi (`pi` on PATH) | required | required | required | yes |
| Faur package, pinned (`git:…/pi-forge@v0.26.0`) | required | required | required | **no** — A uses none of approvals, commands, workflows. It gets `memory`, `request_permission`, the MCP gate (inactive), `/faur` |
| `npm:pi-subagents@0.83.1` | required | required | required | **no** — A has no specialists (`deps.mjs:21` always adds it) |
| `npm:pi-web-access@0.27.0` | — | declared | — | — |
| Remote MCP servers + tokens in `.env` | — | required | — | — |
| `npx @playwright/mcp@0.0.83` + Chromium | — | — | required (setup not declared) | — |
| Bubblewrap 0.12.0 | — | — | required by project tool | — |
| `gh` CLI | — | optional (approved command) | — | — |
| `systemd-run --user` | — | optional (workflow cleanup) | optional | — |
| Node (for the workflow runner) | — | required for `--workflow` | required | — |

Every agent therefore loads the builder. Even A installs two packages before
its first answer, and its first `./run` must be interactive so Pi can install
them (`docs/headless-workflows.md`).

## 3. Initialization and execution path

All three share one path:

1. `./run` resolves the project root, sets `PI_CODING_AGENT_DIR=.forge/pi-home`
   (own Pi login store; the caller's environment is inherited), loads
   declared names from `.env` (B only), and execs
   `pi --approve --no-context-files --append-system-prompt APPEND_SYSTEM.md
   --append-system-prompt CAPABILITIES.md`.
2. Pi installs the pinned packages into `.pi/git/` and `.pi/npm/` on first
   start.
3. The Faur extension, seeing a trusted `.pi/system.yaml`, parses and
   validates it and registers: `memory`, MCP boundary gate, declared command
   tools, `request_permission`, credential notice, `/faur` maintenance and
   `forge_plan`.
4. Specialists (B, C) run through `pi-subagents` in the background
   (`async: true`, `forceTopLevelAsync`), each loading the Faur runtime again
   (as `PI_SUBAGENT_CHILD`).
5. `./run --workflow <name>` (B, C) runs `workflow-runner.mjs` from the pinned
   package: validates `system.yaml` again, checks setup, takes a lock, runs
   `pi -p` under a systemd scope where available, cleans up pi-subagents runs,
   prints one JSON line.

A runs `system.yaml` validation at every start although nothing it does
depends on Faur at run time.

## 4. Ownership

| | Faur owns (regenerates) | Developer owns |
|---|---|---|
| All | `settings.json`, `mcp.json`, `CAPABILITIES.md`, `run`, agent frontmatter, `.forge/*` | `system.yaml` content, `APPEND_SYSTEM.md`, agent prompts, skills, README, `.gitignore` (except the required block), `.env` |
| C additionally | — | `tools/*`, the recorder, the sandbox, the caller MCP server |

Ownership is clear and enforced by fingerprints. Two notes:

- Authored files carry an inline `forge:generated` marker line, so the
  developer's README, prompt and `.gitignore` start with Faur metadata.
- Agent files mix both owners in one file (derived frontmatter, authored
  `systemPrompt`); this works because `changesReach` separates the two.

## 5. Mechanisms actually needed

| Mechanism | A | B | C | Comment |
|---|---|---|---|---|
| Isolated Pi home (`PI_CODING_AGENT_DIR`) | yes | yes | yes | Keeps host packages and logins out |
| `.env` loader in `run` | no (not generated) | yes | no | Already pay-per-use ✓ |
| Memory tool + `.pi/MEMORY.md` | not requested | useful | not used headless | Always on |
| `request_permission` | not requested | useful (lead) | not used headless | Always on, and every `CAPABILITIES.md` tells the agent to use it |
| MCP boundary / approval gate | no | yes (`save_report`) | yes (orchestrator without `mcp`) | Already skipped when not needed ✓ |
| Declared command tools | no | yes | yes | Registered only when declared ✓ |
| `pi-subagents` | no | yes | yes | Always pinned |
| Background subagent config | no | yes | yes | Generated only when needed ✓ |
| Workflow runner + launcher block | no | yes | yes | Launcher block always present (twice), with an empty manifest in A |
| Capability manifest (`.forge/capabilities.json`) | marginal | yes | yes | Cheap, ignored by git |
| `data/knowledge/` + 4 `.gitignore` lines | no | no | no | Always generated; no declaration refers to it |
| Empty `mcp.json`, empty `.env.example` | no | — | `.env.example` no | Always generated |

## 6. Unnecessary or misleading output

Judged against A, the baseline:

1. **`pi-subagents` and the whole Faur package are pinned** for an agent
   that uses neither (architecture audit C, D).
2. **`run` contains the workflow runner twice** and an embedded base64
   manifest (`W10=` in A). In B and C the manifest duplicates
   `system.yaml`'s workflows, which the runner also re-reads and validates.
3. **`data/knowledge/.gitkeep` and its ignore rules** exist in every project.
   Nothing declares or uses them.
4. **Empty `.pi/mcp.json` and `.env.example`** (the latter only a marker line).
5. **`request_permission` guidance in a read-only agent** (A's
   `CAPABILITIES.md`). It is an escalation path gated by the user, so an
   orchestrator's `tools` list is not the ceiling of what it can run; that
   should be stated, or the tool should be opt-in.
6. **Memory on by default.** A read-only agent writes `.pi/MEMORY.md`.
7. **README overstates isolation:** "credentials are not inherited", and
   "Enforced (cannot be bypassed)". The caller environment is inherited, and
   a `bash`-capable agent bypasses tool-level restrictions.
8. **B's `CAPABILITIES.md` says `posthog` offers "all tools"** while
   `mcp.json` exposes only `query` and `list_insights`.
9. **Generation warnings repeat on every project** ("launcher disables
   AGENTS.md…", "Pi login files are not inherited…") even when irrelevant,
   which trains users to ignore warnings.

None of these is a security hole; 7 and 8 are correctness problems in what
the agent and the developer are told.

## 7. Demonstrated gaps (recorded, not implemented)

From C (Revisor) and #42, still open:

- **Run result and artifacts.** The verdict is parsed from prose (`Verdict:`
  first line, a document rule); receipts go to `data/receipts` via an input.
  Covered by #43 and #44.
- **Integration setup.** Playwright's browser install and the secrets file are
  not declared in Revisor's `system.yaml`, although v0.26.0 supports both
  (`setup`, `secretsFile`). Revisor predates them; no Faur gap remains
  (#49 done).
- **Sandboxed command execution.** Revisor solved it in project code with
  Bubblewrap, behind declared `cli:` commands, with no Faur changes. This is
  evidence that the declared-command mechanism composes; it is the input to
  #47 and #48.
- **Junk saved permissions.** C's `system.yaml` contains `herdr-pane-rename`,
  saved through "always allow" from an unrelated session, with a description
  that records a past failure. Saving from `request_permission` should be
  rarer and reviewed (relates to #54 and architecture finding B).
- **Specialist `cwd`.** The lead's prompt must say "never set its `cwd`"
  (#45).
- **No name/description operation** in `forge_plan` (#42, last comment).

## 8. Recommendations for generated output

1. Pin `pi-subagents` only when `agents[]` is non-empty.
2. Emit the workflow block and manifest in `run` only when workflows are
   declared, once.
3. Generate `mcp.json`, `.env.example` and `data/knowledge/` only when
   declared; keep the `.gitignore` required block.
4. Make memory and `request_permission` declared choices, and omit their
   text when absent.
5. Fix the README and `CAPABILITIES.md` wording (architecture finding H).
6. Stop pinning Faur and stop requiring `./run` (decided 2026-11-02; staged
   in [architecture-audit.md §5](architecture-audit.md#5-runtime-dependencies-and-the-migration)).

Target for A after the migration: `.pi/settings.json` (model and tools, no
packages), `.pi/APPEND_SYSTEM.md` (prompt and capability section),
`README.md`, `.gitignore`, plus Faur's design record. It runs with `pi` in
its directory, and keeps working with Faur uninstalled or the design record
deleted.

## Appendix: inputs

A:

```yaml
schema: 1
name: notes-helper
description: Answers questions about the notes in this folder
orchestrator:
  name: helper
  prompt: |
    You answer questions about the notes in this folder. Cite file paths.
  model: anthropic/claude-sonnet-5-5
  tools: [read, grep, find, ls]
```

B (abridged; the two MCP servers use placeholder `example` hosts):

```yaml
orchestrator: { name: marketing-lead, tools: [read, write, edit, subagent, mcp, web_search, fetch_content, "cli:create-issue"] }
agents: [{ name: seo-researcher, tools: [read, "mcp:openseo/get_report", "mcp:openseo/list_reports", web_search, fetch_content] }]
integrations:
  env: [OPENSEO_TOKEN (secret), POSTHOG_TOKEN (secret)]
  mcp: [openseo (approveTools: [save_report]), posthog (includeTools: [query, list_insights])]
  cli: [create-issue: gh issue create --repo … --title {title} --body-file {body:file}]
packages: ["npm:pi-web-access@0.27.0"]
workflows: [{ name: baseline, skill: baseline, entry: marketing-lead, agents: [seo-researcher], trigger: headless }]
documents: [{ name: baseline-report, path: reports/baseline.md, writer: marketing-lead }]
policies: { advisory: ["Never publish without the owner's approval"] }
```

C: `~/projects/revisor/agent/.pi/system.yaml` at Revisor commit `8f42336`.
