# `system.yaml` schema (v1) + ownership contract

This is the canonical reference for Pi Forge's declarative system
model. It is implemented and enforced by `parse.mjs` and `validate.mjs`, surfaced
through `forge validate <dir>`. The model lives at
`<dir>/.pi/system.yaml` and is the forge's source of truth for the generated
project.

> **Direction (2026-11-02):** `system.yaml` becomes Faur's design record.
> Native Pi files become authoritative for execution, may be edited directly,
> and are reconciled with this record when Faur is invoked. This document
> describes the current release; the migration is staged in
> `docs/architecture-audit.md` §5.

## 1. Schema v1

Top-level keys (all others rejected):

| Key | Required | Type | Meaning |
|---|---|---|---|
| `schema` | yes | integer `1` | schema version |
| `name` | yes | kebab-case string | system/project name |
| `description` | no | string | one-line summary |
| `orchestrator` | no | object | the primary Pi session (→ `.pi/APPEND_SYSTEM.md` + settings) |
| `agents` | no | array | specialist subagents (→ `.pi/agents/*.md`) |
| `skills` | no | array | authored, packaged or vendored skills (→ `.pi/skills/*/`) |
| `integrations` | no | object | MCP servers + env requirements |
| `workflows` | no | array | declared workflow boundaries (metadata only) |
| `documents` | no | array | agreed formats for documents agents write or return |
| `policies` | no | object | enforced + advisory policy |
| `setup` | no | array | project setup checks and installs (see Setup checks) |
| `packages` | no | array of `npm:`/`git:` specs | additional runtime extension packages (`pi-subagents` is always included; `pi-mcp-adapter` is rejected because it would replace Pi's built-in MCP; packaged skill sources are added automatically) |

The **orchestrator is a top-level block**, not an `agents[]` entry. Pi has no
"primary agent" file: the primary session is shaped by `.pi/settings.json`
(model + `defaultTools`) and `.pi/APPEND_SYSTEM.md` (instructions). `agents[]`
holds specialist *subagents* only.

### Models

There are no model tiers and no default models. Every agent — the orchestrator
and each subagent — names its own model, chosen from the machine's Pi line-up
(`pi --list-models`, also reported by `forge discover` as `models`):

```yaml
orchestrator:
  name: lead
  model: provider/model-id      # required: "provider/id"
  thinking: medium              # optional: off|minimal|low|medium|high|xhigh|max
agents:
  - name: researcher
    model: other-provider/model-id
```

Validation checks the `provider/id` shape and the thinking level, not
availability: the catalog is machine-specific. `forge validate`, `generate`
and `modify` warn about a model missing from the local line-up, without
failing. The orchestrator's model becomes `defaultProvider`/`defaultModel`/
`defaultThinkingLevel` in `.pi/settings.json`; a subagent's model and thinking
level go into its own `.pi/agents/<name>.md` frontmatter. No routing overrides
(`subagents.agentOverrides`) are emitted, and stale ones are removed.

### `orchestrator`

Allowed keys: `name` (required string), `description`, `prompt`, `model`
(required `provider/id`), `thinking`, `tools` (array of strings), and
`projectContext` (array of project-relative file paths).

`projectContext: [AGENTS.md]` explicitly appends those files, in order, after
`.pi/APPEND_SYSTEM.md` and `.pi/CAPABILITIES.md` on interactive and workflow
launches. Missing files or files resolving outside the project are skipped and
reported by the launch check. Absolute paths, `..`, and backslashes are
rejected. This opts in to file contents as instructions sent to the model:
never list credential files; untrusted project files may contain prompt injection. A non-empty list automatically enables
Pi's `edit` tool even when not listed in `tools`. **That tool can edit other
files accessible to the process**, not just listed instruction files. An
absent or empty list does not add a tool. This path check is not a filesystem
sandbox or a defense against concurrent hostile filesystem changes.

The orchestrator always has memory: notes it keeps across sessions in
`.pi/MEMORY.md`, one `- ` entry per line, up to 4000 characters. They load
into its prompt at session start. It writes them freely with the `memory` tool
(add, replace, remove), and is told to record lessons before finishing a task,
and after a task with failed tool calls. Subagents neither see nor write them.
`/faur review` reads the notes; making a lesson permanent (a prompt,
skill or tool change) is a normal previewed change. The file is the user's to
edit, and no generated file depends on it.

### Prompts and the generated "What you can use" section

`prompt` (orchestrator and agents) describes the role, goals, judgement, rules
and boundaries. It should not list tools, MCP servers, commands or skills: the
Forge renders a "What you can use" section from the declarations — built-in
tools, MCP servers (with `config.description` and which tools ask first),
commands, other tools, skills, and for the orchestrator its specialists. A
subagent's section is written into its agent file after its prompt; the
orchestrator's is generated into `.pi/CAPABILITIES.md`, which `./run` appends
after `.pi/APPEND_SYSTEM.md`, so that file stays exactly the authored prompt.
Both are build output: they change when the system is regenerated, not when
the Forge tooling is updated. A change
that removes an MCP server, command or skill reports `staleMentions`: the
prompts, workflows, documents and advisory policies that still name it.

### `agents[]`

Allowed keys: `name` (required string), `description`, `tools` (array of
strings), `model` (required `provider/id`), `thinking`, `skills` (array of
declared `skills[].name`), `prompt`, `inheritProjectContext`, `inheritSkills`.
`tools:` is the subagent allowlist (an *enforced* policy). A subagent whose
tools include anything beyond Pi's builtins (`read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`) — `mcp:` selections or extension tools such as
`web_search` — or that omits `tools`, gets `async: true`: foreground children
never load extensions, so those tools would be missing. Such systems also get
`.forge/pi-home/extensions/subagent/config.json` with
`forceTopLevelAsync: true` so a caller cannot launch them in the foreground.
Nobody can answer an approval prompt in the background, so a subagent that
can reach a call that asks the user — an MCP tool matching its server's
`approveTools` (through `mcp:<server>`, `mcp:<server>/<tool>` or `mcp`), or a
`cli:` command without `approve: false` — is rejected: give it only tools that
don't ask and let the orchestrator, which runs in the user's chat, make the
approved calls. A project that already has such a subagent stays revisable:
changes may keep the issue but not add one, and the change preview
(`askingInBackground`) and launch check list it with a ready fix.
`skills:` selects the
skills the subagent receives. Duplicate `name`s are rejected.

### `skills[]`

The forge ships no skills of its own; each agent gets the skills the user
chooses for it, including ones the forge suggests from skills.sh.
Allowed keys: `name` (required string), `description`, and at most one of:

- `body` — authored inline; materializes to `.pi/skills/<name>/SKILL.md`. A
  skill with neither `body` nor `source` that a workflow names gets a generated
  orchestration body.
- `source: npm:<name>@<version>` or `git:<repo>@<ref>` — provided by a pinned
  package, which joins the runtime `packages`. No local file is generated.
- `source: ./path`, `../path`, `/abs/path` or `~/path` — a directory containing
  `SKILL.md` whose frontmatter `name` matches. `forge generate`/`modify`
  vendor it into `.pi/skills/<name>/` once (binary-safe, symlinks refused); an
  existing project copy is never overwritten. Relative paths resolve from the
  project directory.
- `source: skills:<owner>/<repo>/<skill-dir>@<commit>` — one skill directory
  from the open Agent Skills ecosystem (skills.sh), pinned to a full 40-character
  commit. `forge generate`/`modify` and an approved `/faur` change install it
  with the `skills` CLI (`npx skills@1.7.4 add <github tree URL> --agent pi
  --copy -y`) into the project's `.agents/skills/<name>/` — never globally —
  and `skills-lock.json` records the commit. The installed `SKILL.md` must
  declare `name` and, in maintenance, match the previewed content. Removing
  the declaration removes the installed copy. `forge search-skills` and
  `forge preview-skill <owner/repo>@<name>` find and pin skills.

Duplicate `name`s are rejected.

### `integrations`

Allowed keys: `mcp` (array), `env` (array) and `cli` (array).

- `mcp[]` entries: `name` (required string) and `config` (required non-empty
  object); optional `setup` and `secretsFile` are described under Setup checks. Generated systems use Pi's built-in MCP, and the connection
  settings pass through to `.pi/mcp.json`: `{url, headers?, oauth?}` or
  `{command, args?, env?, cwd?}`, plus `description` and `timeout`. Three
  keys are Forge's and become Pi's exposure:
  - `includeTools`: the tools agents may use. They are declared directly and
    the rest of the server is hidden. Without it, the server's tools are
    `deferred`: the orchestrator finds them with `tool_search`.
  - `excludeTools`: tools nobody may use (`hidden`: registered but
    unreachable, also for specialists). An enforced `hide` policy adds to it.
  - `approveTools`: tools that ask the user before every call (`true` for
    all), direct or from a codemode script. Without a UI the call is blocked.
  `exposure` and `toolExposure` are rejected: Forge derives them. Codemode is
  not enabled automatically (`autoEnableCodemode: false`), since it would reach
  every server's tools. Pi names each tool `mcp__<server>__<tool>`. An
  orchestrator with `mcp` in its tools (or without `tools`) gets every
  server's usable tools; without it, it can call none, while its specialists
  still get their `mcp:` selections. OAuth servers need no credentials in the
  config: sign in with `/mcp` inside `./run`. Duplicate `name`s are rejected.
- `env[]` entries: `name` (required shell variable name) and `secret`
  (optional boolean). These become `.env.example` entries, and `./run` loads
  exactly these names from the gitignored `.env` (parsed, never sourced; the
  caller's environment wins). The complete caller environment also reaches Pi
  and its tools, even for undeclared names. `secret: true` does not isolate or
  reliably redact a value. Use trusted tools and restricted test credentials;
  do not pass credential values through workflow `--input`. Names that change how the shell, Node, Pi or the
  network stack run (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, proxy variables,
  `PI_CODING_AGENT_DIR`, `FORGE_*`, …) are rejected.
- `cli[]` entries declare command-line tools: `name` (required kebab-case),
  `description`, `command` (required: one program name or path, no spaces),
  `args` (array of strings), `approve` (boolean, default `true`), and optional `setup` and `secretsFile` (see Setup checks). An
  argument that is exactly `{name}` is a value the agent supplies for each
  call (it may not start with `-`); `{name:file}` writes the agent's text to
  a temporary file and passes its path. Every other argument is fixed. The
  command runs directly, without a shell, from the project directory, with
  the user's own CLI logins and the `.env` variables `./run` loaded.
  `approve: true` asks the user before each run (Allow once / Allow for this
  session / Deny); without a UI (a headless run, or a background subagent)
  such a call fails instead of running. Duplicate `name`s are rejected.

  An agent gets a command by listing `cli:<name>` in its `tools` (or an
  enforced policy rule's `tools`); every `cli:` reference must name a declared
  entry. In Pi the tool is `cli_<name>` (hyphens become underscores). The
  orchestrator gets the commands its `tools` list, or all of them when its
  `tools` is omitted; a subagent gets exactly the ones in its allowlist, and
  runs in the background. `/faur permissions` (list, add, remove, review)
  edits these declarations through the normal preview. The orchestrator can
  also ask for a command it has no tool for with `request_permission`: the
  user allows it once, saves it here, or denies it; in a headless run the
  request waits in `.forge/permission-requests.json` for
  `/faur permissions review`.

  ```yaml
  integrations:
    cli:
      - name: create-issue
        description: Open an issue in owlie-app
        command: gh
        args: [issue, create, --repo, mihaiiova/owlie-app, --title, "{title}", --body-file, "{body:file}"]
  agents:
    - name: marketing-lead
      tools: [read, write, "cli:create-issue"]
  ```

### `workflows[]`

Allowed keys: `name` (required), `description`, `skill`, `trigger`, `entry`,
`agents`, `inputs`, `outputs`, `approval`, `verify`.

- `skill` references a `skills[].name` (the orchestrating SKILL.md).
- `entry` references `orchestrator.name` or an `agents[].name`.
- `agents` is an array of strings, each referencing `orchestrator.name` or an
  `agents[].name` (the specialists available to the workflow).
- `inputs`/`outputs` are arrays of path strings.
- `trigger` is `{ kind: "manual" | "headless" }` (scheduling deferred).
- A workflow must declare at least one of `skill` or `entry`.

Workflows are **declared boundaries, not a graph of internal steps**: execution
authority stays with the named skill's own procedure. Duplicate `name`s are
rejected.

### `documents[]`

How one agent writes one document, agreed with the user. Allowed keys: `name`
(required kebab-case), `writer` (required: `orchestrator.name` or an
`agents[].name`), `path` (optional project-relative file outside `.pi/` and
`.forge/`; omit it for a report a subagent returns), `purpose`, `maxWords`
(positive integer), `sections` (required non-empty array of `{ heading,
guide? }`, in order), `rules` (array of strings) and `deliver` (array of
`{ mcp, tool, with?, note? }`: send the document with that MCP tool, e.g. to
Google Drive; `mcp` must be a declared server and the writer must have
`mcp:<server>/<tool>` or `mcp:<server>`, or `mcp` for the orchestrator). A writer with a `path`
must have `write` or `edit` when its tools are listed. The format is appended
to the writer's instructions (`APPEND_SYSTEM.md` or its agent file) under
"Document formats". Duplicate `name`s are rejected.

```yaml
documents:
  - name: decisions
    path: strategy/decisions.md
    writer: lead
    purpose: One page the owner can act on.
    maxWords: 600
    sections:
      - { heading: Decide now, guide: "Yes/no questions for the owner, at most 3" }
      - { heading: Actions, guide: "Table: action | owner | due | done when" }
      - { heading: Open questions, guide: "At most 5" }
      - { heading: Evidence and limits, guide: "At most 5 bullets linking to reports/" }
    rules: [ "Caveats only in Evidence and limits", "No run IDs or tool arguments" ]
```

### `policies`

Allowed keys: `enforced` (array) and `advisory` (array of strings).

- `enforced[]` entries carry exactly one discriminator:
  - `{ agent: <agents[].name>, tools: [string, …] }` → subagent tool allowlist.
  - `{ mcp: <integrations.mcp[].name>, hide: [string, …] }` → MCP
    hidden tools in `.pi/mcp.json` (registered but unreachable).
- `advisory[]` are behavioral guidance strings (README + skill text).

## 2. Validation rules

`validateSystem(doc)` returns `{ ok, errors[] }`. Errors name the offending
path/key and the expected value. Rejected conditions:

- non-object document;
- `schema` missing or not `1`;
- `name` missing, empty, or not kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`);
- unknown keys at any level (top level and every nested object, except the
  opaque MCP `config` object);
- wrong types / missing required fields within each block;
- a missing or non-`provider/id` model, or an unknown thinking level;
- unresolved references (agent, skill, workflow, MCP names, including
  `agents[].skills`);
- a skill declaring both `body` and `source`, or an unrecognized `source`;
- malformed workflows (missing required fields, `agents`/`inputs`/`outputs` not
  string arrays, missing `skill` and `entry`);
- incompatible configurations (a workflow or policy referencing an undeclared
  agent/skill/MCP);
- duplicate `name` within `agents[]`, `skills[]`, `integrations.mcp[]`, `documents[]`, or
  `workflows[]`.

The skill name `forge` is reserved (it is the Forge skill) and cannot be declared in
`skills[]`. Operational model edits use the structured operations of
`/faur`, which reuse this validator and reject dangling references.
The Forge version is the pinned package in `.pi/settings.json` (recorded in
`.forge/build.json`), never part of this operational model. An explicit empty orchestrator `tools: []` remains empty unless non-empty
`projectContext` enables `edit`; omitted tools use Pi defaults.

## 3. Schema versions

Only `schema: 1` is accepted. There is no migration: documents written for the
earlier tier-based layout (`models.tiers`, tier names as agent models) are
rejected and must be redefined with per-agent models.

## 4. Ownership / edit-preservation contract

Full text of `docs/agent-factory.md` §C.6:

1. **Derived files** (`settings.json` model fragment + `packages` + `defaultTools`,
   `mcp.json`, and the `run` launcher) are forge-owned and regenerated on
   every `generate`; **unknown keys the forge does not own are preserved**
   The `packages` list is a forge-owned derived key computed from the Pi
   runtime primitive (`pi-subagents`) plus any `system.yaml`
   `packages` and packaged skill sources the model declares (`deps.mjs`
   `runtimePackages`). Hand-editing a derived file is
   unsupported — change the model instead.
2. **Authored files** (agents, skills, prompts, `APPEND_SYSTEM.md`, README,
   `.gitignore`, `.env.example`) are user-owned. The forge scaffolds them
   when absent. On modification it records a content fingerprint of what it
   last wrote; if a file differs from that fingerprint *and* the model wants to
   change it, the forge treats it as a **conflict** and proposes a diff,
   surfacing it for the user to resolve; it never silently overwrites (and, in
   this MVP, never auto-applies a conflict — the user resolves it by editing the
   file or re-running after a deliberate edit).
   **Exception for `.gitignore`:** generation and change/rebuild plans append a
   marked block containing any missing `.env`, `.forge/`, `.pi/state.json`,
   `.pi/sessions/`, `.pi/git/`, and `.pi/npm/` entries, plus declared
   integration secret file paths.
   Existing lines are never rewritten or reordered. An exact directory entry
   with or without a trailing slash counts as present; file entries must not
   have a trailing slash. If a potentially matching root negation follows a
   required exact rule, or exists when that rule is absent, Forge refuses to
   apply: resolve the rules explicitly rather than letting Forge override them.
   Wildcard negations are treated conservatively and can be rejected even when
   unrelated. Forge also refuses nested negation rules along required `.pi`
   paths and declared integration secret paths, even if unrelated. The append is shown in
   dry runs and change previews, and repeating it is a no-op.
   **Vendored skill directories** (`skills[].source` paths) are user-owned
   copies: created once from the source, never overwritten or deleted by the
   forge. Delete a copy explicitly to refresh it from its source.
3. **`system.yaml`** is forge-owned but user-editable; `modify` updates only
   the keys it is changing and preserves unknown keys (best-effort on
   comments).
4. **Precedence:** the declarative model is authoritative for *derived*
   config; authored content is authoritative for *content*. On conflict the
   authored file wins until the user confirms a merge.
5. **Preview:** `generate --dry-run` and `modify --dry-run` print the full
   planned diff and write nothing; the builder always previews before applying.
6. **Idempotence:** `generate`/`modify` are pure functions of (model, disk) —
   same inputs produce the same result and never duplicate content.

The Forge package itself is the first entry of the derived `packages`
list, pinned to the release that generated the project. Maintenance
change proposals delete removed agent/skill scaffolds only when intact, reject
authored conflicts, and require separately confirmed drift reconciliation.

`system.yaml` is parsed with the **`yaml`** package (v2.8.3), pinned in
`pi.packages` and resolved from the Pi package install dir by
`yaml-loader.mjs` — never a hand-rolled YAML subset.

### Setup checks

The project and entries in `integrations.mcp` and `integrations.cli` can declare `setup` steps:

```yaml
setup:
  - description: Install the browser
    check: { command: 'test -x ./browser' }
    install: 'npm run install-browser'
    platforms: [linux, darwin]
    needsRoot: false
```

Alternatively use `check: { file: path }`. Checks run automatically during generation, checks and headless workflow startup. **Command checks execute shell code with the user's permissions and may have side effects or access secrets. Only use trusted project declarations.** Do not put literal credentials in setup commands; use environment references. Install commands run only after confirmation via `/faur setup` or `forge setup <dir> --yes`; `needsRoot` commands are printed for manual execution. Headless workflows never install.

MCP and CLI integrations may declare `secretsFile: .forge/service-secrets.env`. Paths must be project-relative, use only letters, digits, `_`, `-`, `.`, and `/`, and contain no `.` or `..` components or symlinks. To protect case-insensitive filesystems, reserved paths are rejected regardless of case: `.forge`, `.pi`, `data`, `.env`, `.env.example`, `run`, `README.md`, `data/knowledge/.gitkeep`, `.forge/build.json`, `.forge/capabilities.json`, `.forge/check.json`, and `.forge/permission-requests.json`; all paths under `.pi/` or `.forge/pi-home/`; and any `.git` or `.gitignore` path component. Forge adds an anchored gitignore entry and creates the missing file with mode 0600 without replacing existing content. Before applying, Forge conservatively refuses any negation rule in a nested `.gitignore` along the secret file's directory path, even if unrelated; resolve it explicitly. Root negations are handled as described in the `.gitignore` exception above. Existing files must be regular, private, and untracked/ignored; Forge reports problems rather than changing them. `/faur env set NAME --file .forge/service-secrets.env` writes a declared `integrations.env` variable to that explicitly selected declared file. Without `--file`, the existing `.env` behavior remains. The integration must be configured to read its secrets file; Forge does not automatically load it. Git ignore cannot undo committed secrets. Path checks are not a defense against hostile concurrent filesystem changes.
