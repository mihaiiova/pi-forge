import { configurationAdvisories } from './advisories.mjs';
/**
 * generate — materialize a `system.yaml` model into a single-agent Pi project.
 *
 * Pure seam: `generateProject(model, existingFiles) -> { files[] }` where each
 * file is `{ path, content, action }` and `action` is one of
 * `create | write | conflict | none`. `existingFiles` maps a project-relative
 * path to its current text content. No filesystem or CLI work happens here —
 * the CLI reads disk, calls this, and applies the result.
 *
 * Ownership (see schema.md §4 / docs §C.6):
 *   - Derived files (`.pi/settings.json`, `.pi/mcp.json`) regenerate every
 *     run, merge-preserving unknown keys.
 *   - Authored files (`README.md`, `.gitignore`, `.env.example`) scaffold once
 *     and are fingerprint-protected with a header marker; a user edit is never
 *     silently overwritten. The only exception is appending missing safety
 *     entries to an existing .gitignore.
 *   - `.pi/APPEND_SYSTEM.md` has both: the authored prompt, then a marked
 *     derived section (what the lead can use) that regenerates, and is a
 *     conflict, not an overwrite, when edited by hand.
 * Files a design does not use are not generated: `.pi/mcp.json` only with MCP
 * servers, `.env.example` only with declared env names.
 */
import { createHash } from "node:crypto";
import { splitModelRef } from "./models.mjs";
import { authoredSkills, vendoredSkills, skillSourceKind } from "./skill-sources.mjs";
import { workflowSkill } from "./workflow-skill.mjs";
import { mcpFromIntegrations } from "./mcp-gen.mjs";
import { enforcedAgentTools, advisoryText } from "./policy.mjs";
import { buildRuntimePlan, needsIsolation } from "./runtime.mjs";
import { runtimeNeeds, COMMANDS_PACKAGE } from "./deps.mjs";
import { integrationSecrets, gitignoreSafety, REQUIRED_IGNORES } from './integration-secrets.mjs';
import { cliRef, cliToolName, cliEntries, cliAgents } from "./cli-tools.mjs";
import { capabilitySection } from "./agent-context.mjs";
import { documentInstructions } from "./documents.mjs";

const MARKER = "faur:generated v1";
/** Primary-session model keys the faur owns inside `.pi/settings.json`. */
const MODEL_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];
const MARKER_HTML_RE = /^<!-- faur:generated v1 sha256=([0-9a-f]{64}) -->$/;
const MARKER_PLAIN_RE = /^# faur:generated v1 sha256=([0-9a-f]{64})$/;
const MARKER_HTML_TRAILING_RE = /\n<!-- faur:generated v1 sha256=([0-9a-f]{64}) -->[ \t]*\n?$/;

// .pi/git/ and .pi/npm/ hold the packages Pi installs for the project.
const GITIGNORE_BODY = [
  "data/",
  ...REQUIRED_IGNORES,
  "",
].join("\n");

/** Pi's built-in tools. Any other tool (`mcp:` selections, extension tools
 * such as web search) is registered by an extension. */
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
/** pi-subagents config inside the isolated Pi home (its getAgentDir()). */
export const SUBAGENT_CONFIG = ".faur/pi-home/extensions/subagent/config.json";

/**
 * Foreground subagents run inside the parent process and never load ambient
 * extensions, so a child that needs MCP or extension tools must run in the
 * background. Omitted tools inherit the ambient extensions too.
 */
export function needsBackground(tools) {
  return !Array.isArray(tools) || tools.some((tool) => !BUILTIN_TOOLS.has(tool));
}

function backgroundAgents(model) {
  return agentEntries(model).filter((agent) =>
    needsBackground(enforcedAgentTools(agent.name, model.policies, agent.tools)));
}

/** Project-relative paths every generated project has. */
export const GENERATED_PATHS = [
  ".pi/settings.json",
  ".pi/APPEND_SYSTEM.md",
  "README.md",
  ".gitignore",
];

const hasMcp = (model) => Array.isArray(model?.integrations?.mcp) && model.integrations.mcp.length > 0;
const hasEnv = (model) => Array.isArray(model?.integrations?.env) && model.integrations.env.length > 0;
/** pi-commands' configuration: the declared commands. */
export const COMMANDS_CONFIG = ".pi/commands.json";
/** `.pi/commands.json`: each declared command, and whether the lead may run it. */
function commandsConfig(model) {
  const lead = isPlainObject(model.orchestrator) ? model.orchestrator.name : undefined;
  const effective = (agent) => enforcedAgentTools(agent.name, model.policies, agent.tools);
  return `${JSON.stringify({ commands: cliEntries(model).map((c) => ({
    name: c.name,
    ...(isNonEmptyString(c.description) ? { description: c.description } : {}),
    command: c.command,
    args: Array.isArray(c.args) ? c.args : [],
    approve: c.approve !== false,
    lead: cliAgents(model, c.name, effective).includes(lead),
  })) }, null, 2)}\n`;
}

/** Markers around the derived section of `.pi/APPEND_SYSTEM.md`. The end
 * marker fingerprints the section, so a hand edit is detected. */
const DERIVED_BEGIN = "<!-- faur:derived v1 begin: generated from system.yaml; edits here are reported, not kept -->";
const DERIVED_END_RE = /^<!-- faur:derived v1 end sha256=([0-9a-f]{64}) -->$/m;
const derivedEnd = (body) => `<!-- faur:derived v1 end sha256=${sha256(body)} -->`;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function yamlString(value) {
  const s = String(value);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function markerLineText(style, hash) {
  return style === "plain" ? `# ${MARKER} sha256=${hash}` : `<!-- ${MARKER} sha256=${hash} -->`;
}

function markedContent(style, body) {
  const line = markerLineText(style, sha256(body));
  if (style === "trailing-html") return `${body}\n${line}\n`;
  return `${line}\n${body}`;
}

/** Split a marked file into `{ hash, body }`, or null when no marker is present. */
function parseMarked(content, style) {
  if (typeof content !== "string") return null;
  if (style === "trailing-html") {
    const match = content.match(MARKER_HTML_TRAILING_RE);
    if (!match) return null;
    return { hash: match[1], body: content.slice(0, match.index) };
  }
  const nl = content.indexOf("\n");
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  const body = nl === -1 ? "" : content.slice(nl + 1);
  const match = firstLine.match(style === "html" ? MARKER_HTML_RE : MARKER_PLAIN_RE);
  if (!match) return null;
  return { hash: match[1], body };
}

/** A marker proves ownership only while its original content remains intact. */
export function intactScaffold(content) {
  const marked = parseMarked(content, 'trailing-html');
  return marked !== null && sha256(marked.body) === marked.hash;
}

function derivedFile(path, desiredContent, existing) {
  if (existing === undefined) return { path, content: desiredContent, action: "create" };
  if (existing === desiredContent) return { path, content: existing, action: "none" };
  return { path, content: desiredContent, action: "write" };
}

function authoredFile(path, style, desiredBody, existing) {
  if (existing === undefined) {
    return { path, content: markedContent(style, desiredBody), action: "create" };
  }

  const parsed = parseMarked(existing, style);
  if (parsed === null) {
    // No faur marker: the user authored this file by hand. Never touch it.
    return { path, content: existing, action: "none" };
  }

  const { hash: recordedHash, body: currentBody } = parsed;
  const currentHash = sha256(currentBody);
  const desiredHash = sha256(desiredBody);

  if (currentHash === recordedHash) {
    // Faur-owned and unedited.
    if (desiredBody === currentBody) {
      return { path, content: existing, action: "none" };
    }
    return { path, content: markedContent(style, desiredBody), action: "write" };
  }

  // The user edited a faur scaffold (hash no longer matches the marker).
  if (desiredBody === currentBody) {
    // Their edit already equals what the model wants; refresh the marker.
    return { path, content: markedContent(style, desiredBody), action: "write" };
  }
  if (desiredHash === recordedHash) {
    // The model did not change since the faur last wrote: authored wins.
    return { path, content: existing, action: "none" };
  }

  // Both the user edited AND the model changed: report, never overwrite.
  return { path, content: existing, desired: desiredBody, action: "conflict" };
}

function gitignoreFile(existing, model) {
  const secretIgnores = [...new Set(integrationSecrets(model))].map(path => `/${path}`);
  if (existing === undefined) return authoredFile(".gitignore", "plain", GITIGNORE_BODY + (secretIgnores.length ? `\n# Integration secret files\n${secretIgnores.join('\n')}\n` : ''), existing);
  const { missing, conflict } = gitignoreSafety(existing, model);
  if (conflict) return { path: '.gitignore', content: existing, desired: existing, action: 'conflict', reason: conflict };
  if (!missing.length) return { path: ".gitignore", content: existing, action: "none" };
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  return { path: ".gitignore", content: `${existing}${separator}# faur: required ignores\n${missing.join("\n")}\n`, action: "write" };
}

/**
 * `.pi/APPEND_SYSTEM.md`: the authored prompt (header-marked, as other
 * authored files) followed by the derived section between markers. Each part
 * keeps its own rule: the prompt is never overwritten once edited, the
 * section is rewritten unless it was edited by hand, which is a conflict.
 */
function promptFile(path, prompt, derived, existing) {
  const section = (body) => `${DERIVED_BEGIN}\n${body}\n${derivedEnd(body)}\n`;
  const join = (head, body) => `${head.replace(/\n*$/, "\n")}\n${section(body)}`;
  if (existing === undefined) return { path, content: join(markedContent("html", prompt), derived), action: "create" };
  const begin = existing.indexOf(DERIVED_BEGIN);
  const head = begin === -1 ? existing : existing.slice(0, begin).replace(/\n$/, "");
  const authored = authoredFile(path, "html", prompt, head === "" ? undefined : head);
  if (begin === -1) {
    // A hand-written file without Faur's markers stays the developer's.
    if (authored.action === "none" && parseMarked(existing, "html") === null) return { path, content: existing, action: "none", reason: "no derived section" };
    if (authored.action === "conflict") return { ...authored, content: existing, action: "conflict" };
    return { ...authored, content: join(authored.content, derived), action: "write" };
  }
  const tail = existing.slice(begin + DERIVED_BEGIN.length + 1);
  const end = tail.match(DERIVED_END_RE);
  const current = end ? tail.slice(0, end.index).replace(/\n$/, "") : null;
  const edited = current === null || sha256(current) !== end[1];
  if (edited && current !== derived) {
    return { path, content: existing, desired: join(authored.content, derived), action: "conflict", reason: "the generated section was edited by hand" };
  }
  const content = join(authored.content, derived);
  if (authored.action === "conflict") return { ...authored, content: existing, action: "conflict" };
  // Text after the end marker is the developer's: never dropped by a rewrite.
  const after = end ? tail.slice(end.index + end[0].length).replace(/^\n/, "") : "";
  if (after.trim()) {
    if (content === existing.slice(0, existing.length - after.length)) return { path, content: existing, action: "none" };
    return { path, content: existing, desired: content, action: "conflict", reason: "text after the generated section; move it above the section" };
  }
  return { path, content, action: content === existing ? "none" : "write" };
}

function buildSettings(model, existingText, packages) {
  const orchestrator = isPlainObject(model.orchestrator) ? model.orchestrator : {};

  let existing = {};
  if (typeof existingText === "string") {
    try {
      existing = JSON.parse(existingText);
    } catch {
      existing = {};
    }
  }
  if (!isPlainObject(existing)) existing = {};

  // The orchestrator's own model drives the primary session. Subagent models
  // live in each agent's frontmatter, so no routing overrides are emitted.
  const { provider, id } = splitModelRef(orchestrator.model);
  const desired = {
    defaultProvider: provider,
    defaultModel: id,
    defaultThinkingLevel: isNonEmptyString(orchestrator.thinking) ? orchestrator.thinking : undefined,
  };
  const out = { ...existing };
  for (const key of MODEL_KEYS) {
    if (desired[key] !== undefined) out[key] = desired[key];
    else delete out[key];
  }
  if (isPlainObject(out.subagents) && "agentOverrides" in out.subagents) {
    const rest = { ...out.subagents };
    delete rest.agentOverrides;
    if (Object.keys(rest).length > 0) out.subagents = rest;
    else delete out.subagents;
  }

  // Commands reach the orchestrator through pi-commands, which registers
  // only those marked for the lead; defaultTools bounds Pi's own tools.
  // MCP reach is set by exposure, not by defaultTools.
  const tools = Array.isArray(orchestrator.tools)
    ? orchestrator.tools.filter((tool) => !cliRef(tool) && tool !== "mcp" && !tool.startsWith("mcp:"))
    : undefined;
  if (tools !== undefined) out.defaultTools = tools;
  else delete out.defaultTools;

  const runtime = Array.isArray(packages) ? packages : [];
  if (runtime.length > 0) {
    out.packages = runtime;
  } else {
    delete out.packages;
  }

  // The system's MCP runtime is Pi's built-in support, so an entry that
  // switches it off is dropped. Other extension entries the user added are kept.
  if (Array.isArray(out.extensions)) {
    out.extensions = out.extensions.filter((e) => e !== "-builtin:mcp");
    if (out.extensions.length === 0) delete out.extensions;
  }

  return `${JSON.stringify(out, null, 2)}\n`;
}

function buildMcpJson(model, existingText) {
  let existing = {};
  if (typeof existingText === "string") {
    try {
      existing = JSON.parse(existingText);
    } catch {
      existing = {};
    }
  }
  if (!isPlainObject(existing)) existing = {};

  const out = { ...existing };
  // Capability-bearing — authoritative from the model, never merged.
  delete out.mcpServers;
  delete out.autoEnableCodemode;
  const integrations = isPlainObject(model.integrations) ? model.integrations : {};
  out.mcpServers = mcpFromIntegrations(integrations.mcp, model.policies);
  // Codemode would reach every server's tools; agents get theirs directly
  // (or through tool_search for deferred servers) instead.
  out.autoEnableCodemode = false;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Force background launches so a caller cannot start an MCP specialist in
 * the foreground, where its tools would be missing. Other keys are kept. */
function buildSubagentConfig(existingText) {
  let existing = {};
  try {
    existing = JSON.parse(existingText ?? "{}");
  } catch {
    existing = {};
  }
  if (!isPlainObject(existing)) existing = {};
  return `${JSON.stringify({ ...existing, forceTopLevelAsync: true }, null, 2)}\n`;
}

/** The lead's authored prompt, as written in system.yaml. */
function orchestratorPrompt(model) {
  const orchestrator = isPlainObject(model.orchestrator) ? model.orchestrator : {};
  const prompt = typeof orchestrator.prompt === "string" ? orchestrator.prompt : "";
  // One trailing newline, so the marker fingerprint survives the section join.
  return prompt ? `${prompt.replace(/\n*$/, "")}\n` : "";
}

/** What the lead can use, how to launch its specialists and its document
 * formats: all derived from declarations. */
function orchestratorDerived(model) {
  const name = isPlainObject(model.orchestrator) ? model.orchestrator.name : undefined;
  const background = backgroundAgents(model).map((agent) => `\`${agent.name}\``);
  const parts = [capabilitySection(model, name)];
  if (background.length > 0) {
    parts.push([
      "## Running specialists",
      "",
      `${background.join(", ")} use MCP or extension tools, so they always run in the`,
      "background. Launch them, then wait for their completion notice before using",
      "their results. A foreground launch cannot give them their tools.",
    ].join("\n"));
  }
  if (isNonEmptyString(name)) parts.push(documentInstructions(model, name));
  return parts.filter(Boolean).map((part) => part.replace(/\n+$/, "")).join("\n\n");
}

function policySection(model) {
  const policies = isPlainObject(model.policies) ? model.policies : {};
  const enforced = Array.isArray(policies.enforced) ? policies.enforced : [];
  const advisory = advisoryText(policies);

  const lines = ["## Policy", "", "### Enforced by Pi's tool layer", ""];
  const enforcedLines = [];
  for (const rule of enforced) {
    if (!isPlainObject(rule)) continue;
    if (typeof rule.agent === "string" && Array.isArray(rule.tools)) {
      const tools = rule.tools.length ? rule.tools.join(", ") : "(none)";
      enforcedLines.push(`- \`${rule.agent}\` is restricted to tools: ${tools}`);
    } else if (typeof rule.mcp === "string" && Array.isArray(rule.hide) && rule.hide.length) {
      enforcedLines.push(`- MCP server \`${rule.mcp}\` hides tools: ${rule.hide.join(", ")}`);
    }
  }
  // Each enforced rule names what enforces it.
  const commands = cliEntries(model);
  if (commands.length) enforcedLines.push(`- Declared commands run without a shell, with only their {placeholders} filled in; ${commands.some((c) => c.approve !== false) ? "those that ask need your approval for each run and are refused without a UI" : "none asks before running"} (pi-commands, \`${COMMANDS_PACKAGE}\`).`);
  lines.push(...(enforcedLines.length ? enforcedLines : ["None declared."]));
  // A tool allowlist limits which tools an agent calls, not what a shell reaches.
  if (enforcedLines.length) lines.push("", "An agent with `bash` or a shell-like command can still reach anything your user account can.");
  const leadWithoutMcp = Array.isArray(model.integrations?.mcp) && model.integrations.mcp.length && Array.isArray(model.orchestrator?.tools) && !model.orchestrator.tools.includes("mcp");
  const notes = [...advisory, ...(leadWithoutMcp ? [`\`${model.orchestrator.name}\` is told it has no MCP tools; it is not prevented from calling them, and its specialists have them anyway.`] : [])];
  lines.push("", "### Advisory (guidance — not enforced)", "");
  lines.push(...(notes.length ? notes.map((line) => `- ${line}`) : ["None declared."]));
  lines.push("");
  return lines.join("\n");
}

function readmeBody(model, packages) {
  const name = typeof model.name === "string" ? model.name : "";
  const description = typeof model.description === "string" ? model.description : "";
  return [
    `# ${name}`,
    "",
    description,
    "",
    "## Run",
    "",
    ...(needsIsolation(model) ? [
      "Start it with `./run`. It runs Pi with this project's own Pi configuration",
      "and logins instead of yours, so a package you installed (such as an MCP",
      "extension that replaces Pi's built-in MCP) cannot change what this project",
      "relies on. Plain `pi` here also works, with your configuration added;",
      "`/faur check` reports what in it conflicts.",
    ] : [
      "Start it with `pi` in this folder. Your global Pi configuration (settings,",
      "packages, MCP servers, instructions) is added to the project's.",
    ]),
    "Your environment, including any credentials in it, is inherited; this is not",
    "an OS sandbox. Skills in `~/.agents/skills/` and `AGENTS.md` files in parent",
    "folders also load, for the orchestrator. Pi asks once whether to trust the",
    "project; headless runs pass `--approve` instead.",
    "",
    "```sh",
    ...(needsIsolation(model) ? [
      "./run                       # interactive",
      "./run --approve -p \"...\"    # headless one-shot",
      ...((Array.isArray(model.workflows) ? model.workflows : []).map(w => `./run --approve -p "/skill:${w.skill ?? w.name} <request>"`)),
    ] : [
      "pi                          # interactive",
      "pi --approve -p \"...\"       # headless one-shot",
      ...((Array.isArray(model.workflows) ? model.workflows : []).map(w => `pi --approve -p "/skill:${w.skill ?? w.name} <request>"`)),
    ]),
    "```",
    "",
    ...((model.workflows?.length ?? 0) ? [
      "A workflow is a skill: the text after it is the request. Print mode exits 0",
      "with the final answer on stdout, or non-zero with the error on stderr; the",
      "exit code reports the run, not whether the task succeeded. Add",
      "`--mode json` for an event stream. Pi waits for stdin to close when it is",
      "not a terminal, so callers close it. Approval is never granted unattended:",
      "a call that asks the user is refused in a headless run.",
      "",
    ] : []),
    ...(packages.length ? [
      "On the first interactive run, Pi may start npm package installation processes",
      "that continue briefly after Pi exits and may keep output pipes open. Callers",
      "should allow extra time before assuming the output stream has closed.",
      "",
    ] : []),
    `Authenticate with \`/login\`${needsIsolation(model) ? " inside `./run`" : ""}, or export the provider-specific key (for`,
    "example `DEEPSEEK_API_KEY`). See the policy section below for which",
    "capabilities are enforced vs advisory.",
    ...(model.integrations?.env?.length ? ["Integration variables (listed in `.env.example`) come from the environment you start Pi in: export them, or load `.env` with direnv (`dotenv` in `.envrc`). `/faur check` reports any that are unset."] : []),
    ...[...new Set(integrationSecrets(model))].map(path => `Configure integration secrets in \`${path}\` outside Faur. Faur does not load this file; configure the integration to read it.`),
    "",
    ...((model.setup?.length || model.integrations?.mcp?.some(x => x.setup?.length) || model.integrations?.cli?.some(x => x.setup?.length)) ? [
      '## Setup', '',
      'Checks run commands with your user permissions; use only trusted project declarations.',
      'Run `/faur setup` to review and approve unmet installs (root steps are manual).', '',
      ...[...(model.setup ?? []), ...(model.integrations?.mcp ?? []).flatMap(x => x.setup ?? []), ...(model.integrations?.cli ?? []).flatMap(x => x.setup ?? [])].map(s => `- ${s.description}: \`${s.install}\``), '',
    ] : []),
    '## Maintain',
    '',
    'This project runs on Pi alone and pins no Faur package. Maintain it from',
    'your own Pi with Faur installed: run `pi` in this folder and use',
    '`/faur <request>` to propose a change (discuss, apply or discard it when the',
    'turn ends), `/faur check` to verify the agent, `/faur status` to summarize',
    'it and `/faur permissions` to list, add or remove declared commands. Without',
    'Faur, edit the files directly; roll back with git. Restart Pi when packages change.',
    '',
    policySection(model),
  ].join("\n");
}

function envBody(model) {
  const env = isPlainObject(model.integrations) && Array.isArray(model.integrations.env)
    ? model.integrations.env
    : [];
  if (env.length === 0) return "";
  return env
    .filter((entry) => isPlainObject(entry) && typeof entry.name === "string")
    .map((entry) => `${entry.name}=`)
    .join("\n") + "\n";
}

/** A frontmatter list as YAML block items. pi-subagents splits a flow list
 * ("[a, b]") on commas and keeps the brackets, so it is never emitted; an
 * empty list is a bare key, which it reads as an empty allowlist. */
function blockList(key, items) {
  return [`${key}:`, ...items.map((item) => `  - ${item}`)];
}

function agentBody(agent, tools, model) {
  const lines = ["---"];
  lines.push(`name: ${agent.name}`);
  // pi-subagents skips an agent file without a description, so one is always written.
  const fallback = (isNonEmptyString(agent.prompt) ? agent.prompt.trim().split("\n")[0].slice(0, 120) : "") || agent.name;
  lines.push(`description: ${yamlString(isNonEmptyString(agent.description) ? agent.description : fallback)}`);
  if (Array.isArray(tools)) {
    lines.push(...blockList("tools", tools.map((t) => (cliRef(t) ? cliToolName(cliRef(t)) : t))));
  }
  if (isNonEmptyString(agent.model)) lines.push(`model: ${agent.model}`);
  if (isNonEmptyString(agent.thinking)) lines.push(`thinking: ${agent.thinking}`);
  if (Array.isArray(agent.skills) && agent.skills.length > 0) {
    lines.push(...blockList("skills", agent.skills));
  }
  if (agent.inheritProjectContext === true) lines.push("inheritProjectContext: true");
  if (agent.inheritSkills === true) lines.push("inheritSkills: true");
  if (needsBackground(tools)) lines.push("async: true");
  const prompt = [isNonEmptyString(agent.prompt) ? agent.prompt.replace(/\n$/, "") : "", capabilitySection(model, agent.name), documentInstructions(model, agent.name)]
    .filter(Boolean).map((part) => part.replace(/\n+$/, "")).join("\n\n");
  if (prompt) {
    lines.push("systemPrompt: |");
    for (const line of prompt.replace(/\n$/, "").split("\n")) lines.push(`  ${line}`);
  } else {
    lines.push('systemPrompt: ""');
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

function skillFileBody(skill, workflowBySkill) {
  const lines = ["---"];
  lines.push(`name: ${skill.name}`);
  if (isNonEmptyString(skill.description)) lines.push(`description: ${yamlString(skill.description)}`);
  lines.push("---");

  let body = "";
  if (isNonEmptyString(skill.body)) {
    body = skill.body;
  } else {
    const wf = workflowBySkill.get(skill.name);
    if (wf) body = workflowSkill(wf).body;
  }
  return lines.join("\n") + "\n\n" + body;
}

function agentEntries(model) {
  const agents = Array.isArray(model.agents) ? model.agents : [];
  return agents.filter((agent) => isPlainObject(agent) && isNonEmptyString(agent.name));
}

/** Workflows declared without a skill get one named after them, so every
 * workflow starts the same way: `/skill:<name>`, interactive or `pi -p`. */
function workflowOnlySkills(model) {
  return (Array.isArray(model.workflows) ? model.workflows : [])
    .filter((wf) => isPlainObject(wf) && isNonEmptyString(wf.name) && !isNonEmptyString(wf.skill))
    .map((wf) => ({ name: wf.name, description: isNonEmptyString(wf.description) ? wf.description : `Run the ${wf.name} workflow` }));
}

function skillEntries(model) {
  // Sourced skills come from a pinned package or a vendored user directory, so
  // they produce no generated SKILL.md and are not managed paths.
  return [...authoredSkills(model), ...workflowOnlySkills(model)].filter((skill) => isNonEmptyString(skill.name));
}

function agentPath(agent) {
  return `.pi/agents/${agent.name}.md`;
}

function skillPath(skill) {
  return `.pi/skills/${skill.name}/SKILL.md`;
}

function agentFiles(model, existing) {
  return agentEntries(model).map((agent) => {
    const path = agentPath(agent);
    const tools = enforcedAgentTools(agent.name, model.policies, agent.tools);
    return authoredFile(path, "trailing-html", agentBody(agent, tools, model), existing[path]);
  });
}

function skillFiles(model, existing) {
  const workflows = Array.isArray(model.workflows) ? model.workflows : [];
  const workflowBySkill = new Map();
  for (const wf of workflows) {
    if (isPlainObject(wf) && isNonEmptyString(wf.name)) workflowBySkill.set(isNonEmptyString(wf.skill) ? wf.skill : wf.name, wf);
  }
  return skillEntries(model).map((skill) => {
    const path = skillPath(skill);
    return authoredFile(path, "trailing-html", skillFileBody(skill, workflowBySkill), existing[path]);
  });
}

/** Identity inventory only; a listed path is not proof that it may be removed. */
export function declarationInventory(model) {
  return {
    scaffolds: [...agentEntries(model).map(agentPath), ...skillEntries(model).map(skillPath)].sort(),
    vendoredSkills: vendoredSkills(model).map(s => s.name).sort(),
    registrySkills: (model.skills ?? []).filter(s => skillSourceKind(s.source) === 'registry').map(({ name, source }) => ({ name, source })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Every project-relative path `generate` may write for a given model. */
export function managedPaths(model) {
  const paths = [...GENERATED_PATHS];
  if (hasMcp(model)) paths.push(".pi/mcp.json");
  if (hasEnv(model)) paths.push(".env.example");
  if (needsIsolation(model)) paths.push("run");
  if (cliEntries(model).length) paths.push(COMMANDS_CONFIG);
  for (const agent of agentEntries(model)) paths.push(agentPath(agent));
  for (const skill of skillEntries(model)) paths.push(skillPath(skill));
  if (backgroundAgents(model).length > 0) paths.push(SUBAGENT_CONFIG);
  return paths;
}

/**
 * Compute the planned file writes for a validated model against the current
 * project files on disk.
 *
 * @param {object} model the validated `system.yaml` document.
 * @param {Record<string, string>} [existingFiles] project-relative path → text.
 * @param {{ piPackages?: string[], contextFiles?: string[] }} [opts] extra
 *   deterministic inputs: the pinned dependency list for `.pi/settings.json`
 *   `packages`, and the AGENTS.md/CLAUDE.md files Pi loads for the project.
 * @returns {{ files: Array<{ path: string, content: string, action: string, desired?: string }>, warnings: string[], errors: string[] }}
 */
export function generateProject(model, existingFiles = {}, opts = {}) {
  const existing = isPlainObject(existingFiles) ? existingFiles : {};
  const piPackages = isPlainObject(opts) ? opts.piPackages : undefined;
  const contextFiles = isPlainObject(opts) && Array.isArray(opts.contextFiles) ? opts.contextFiles : [];
  const plan = buildRuntimePlan(model, { piPackages, contextFiles, firstBuild: existing["run"] === undefined && existing[".pi/settings.json"] === undefined });
  const subagentConfig = backgroundAgents(model).length > 0
    ? [derivedFile(SUBAGENT_CONFIG, buildSubagentConfig(existing[SUBAGENT_CONFIG]), existing[SUBAGENT_CONFIG])]
    : [];

  const files = [
    derivedFile(".pi/settings.json", buildSettings(model, existing[".pi/settings.json"], plan.packages), existing[".pi/settings.json"]),
    ...(hasMcp(model) ? [derivedFile(".pi/mcp.json", buildMcpJson(model, existing[".pi/mcp.json"]), existing[".pi/mcp.json"])] : []),
    promptFile(".pi/APPEND_SYSTEM.md", orchestratorPrompt(model), orchestratorDerived(model), existing[".pi/APPEND_SYSTEM.md"]),
    authoredFile("README.md", "html", readmeBody(model, plan.packages), existing["README.md"]),
    gitignoreFile(existing[".gitignore"], model),
    ...(hasEnv(model) ? [authoredFile(".env.example", "plain", envBody(model), existing[".env.example"])] : []),
    ...(cliEntries(model).length ? [derivedFile(COMMANDS_CONFIG, commandsConfig(model), existing[COMMANDS_CONFIG])] : []),
    ...(plan.launcherScript ? [{ ...derivedFile("run", plan.launcherScript, existing["run"]), executable: true }] : []),
    ...subagentConfig,
    ...agentFiles(model, existing),
    ...skillFiles(model, existing),
  ];

  files.sort((a, b) => a.path.localeCompare(b.path));
  const unmanagedPrompt = files.some((f) => f.path === ".pi/APPEND_SYSTEM.md" && f.reason === "no derived section")
    ? [".pi/APPEND_SYSTEM.md is hand-written without Faur's generated section, so the orchestrator is not told what it can use. Add the section by deleting the file and regenerating, or keep it as is."]
    : [];
  return { files, warnings: [...plan.warnings, ...unmanagedPrompt, ...configurationAdvisories(model)], errors: plan.errors };
}
