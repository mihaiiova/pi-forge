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
 *   - Derived files (`.pi/settings.json`, `.pi/mcp.json`, `.pi/CAPABILITIES.md`)
 *     regenerate every run, merge-preserving unknown keys.
 *   - Authored files (`.pi/APPEND_SYSTEM.md`, `README.md`, `.gitignore`,
 *     `.env.example`) scaffold once and are fingerprint-protected with a
 *     header marker; a user edit is never silently overwritten. The only
 *     exception is appending missing safety entries to an existing .gitignore.
 */
import { createHash } from "node:crypto";
import { splitModelRef } from "./models.mjs";
import { authoredSkills } from "./skill-sources.mjs";
import { workflowSkill } from "./workflow-skill.mjs";
import { mcpFromIntegrations } from "./mcp-gen.mjs";
import { enforcedAgentTools, advisoryText } from "./policy.mjs";
import { buildRuntimePlan } from "./runtime.mjs";
import { orchestratorTools } from './project-context.mjs';
import { integrationSecrets, gitignoreSafety, REQUIRED_IGNORES } from './integration-secrets.mjs';
import { cliRef, cliToolName } from "./cli-tools.mjs";
import { capabilitySection } from "./agent-context.mjs";
import { documentInstructions } from "./documents.mjs";

const MARKER = "forge:generated v1";
/** Primary-session model keys the forge owns inside `.pi/settings.json`. */
const MODEL_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];
const MARKER_HTML_RE = /^<!-- forge:generated v1 sha256=([0-9a-f]{64}) -->$/;
const MARKER_PLAIN_RE = /^# forge:generated v1 sha256=([0-9a-f]{64})$/;
const MARKER_HTML_TRAILING_RE = /\n<!-- forge:generated v1 sha256=([0-9a-f]{64}) -->[ \t]*\n?$/;

// .pi/git/ and .pi/npm/ hold the packages Pi installs for the project.
const GITIGNORE_BODY = [
  "data/*",
  "!data/knowledge/",
  "data/knowledge/*",
  "!data/knowledge/.gitkeep",
  ...REQUIRED_IGNORES,
  "",
].join("\n");

/** Pi's built-in tools. Any other tool (`mcp:` selections, extension tools
 * such as web search) is registered by an extension. */
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
/** pi-subagents config inside the isolated Pi home (its getAgentDir()). */
export const SUBAGENT_CONFIG = ".forge/pi-home/extensions/subagent/config.json";

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

/** Project-relative paths the single-agent generator materializes. */
export const GENERATED_PATHS = [
  ".pi/settings.json",
  ".pi/mcp.json",
  ".pi/APPEND_SYSTEM.md",
  ".pi/CAPABILITIES.md",
  "README.md",
  ".gitignore",
  ".env.example",
  "data/knowledge/.gitkeep",
  "run",
];

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
    // No forge marker: the user authored this file by hand. Never touch it.
    return { path, content: existing, action: "none" };
  }

  const { hash: recordedHash, body: currentBody } = parsed;
  const currentHash = sha256(currentBody);
  const desiredHash = sha256(desiredBody);

  if (currentHash === recordedHash) {
    // Forge-owned and unedited.
    if (desiredBody === currentBody) {
      return { path, content: existing, action: "none" };
    }
    return { path, content: markedContent(style, desiredBody), action: "write" };
  }

  // The user edited a forge scaffold (hash no longer matches the marker).
  if (desiredBody === currentBody) {
    // Their edit already equals what the model wants; refresh the marker.
    return { path, content: markedContent(style, desiredBody), action: "write" };
  }
  if (desiredHash === recordedHash) {
    // The model did not change since the forge last wrote: authored wins.
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
  return { path: ".gitignore", content: `${existing}${separator}# forge: required ignores\n${missing.join("\n")}\n`, action: "write" };
}

function sentinelFile(path, existing) {
  if (existing === undefined) return { path, content: "", action: "create" };
  return { path, content: existing, action: "none" };
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

  // Commands reach the orchestrator through the Forge extension, which
  // registers only the ones it lists; defaultTools bounds Pi's own tools.
  // MCP reach is set by exposure and the launcher, not by defaultTools.
  const tools = Array.isArray(orchestrator.tools)
    ? orchestratorTools(orchestrator).filter((tool) => !cliRef(tool) && tool !== "mcp" && !tool.startsWith("mcp:"))
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

function orchestratorBody(model) {
  const orchestrator = isPlainObject(model.orchestrator) ? model.orchestrator : {};
  const prompt = typeof orchestrator.prompt === "string" ? orchestrator.prompt : "";
  const background = backgroundAgents(model).map((agent) => `\`${agent.name}\``);
  // The orchestrator's "What you can use" section is its own derived file
  // (.pi/CAPABILITIES.md), so capability changes never rewrite this one.
  const parts = [prompt.replace(/\n$/, "")];
  if (background.length > 0) {
    parts.push([
      "## Running specialists",
      "",
      `${background.join(", ")} use MCP or extension tools, so they always run in the`,
      "background. Launch them, then wait for their completion notice before using",
      "their results. A foreground launch cannot give them their tools.",
      "",
    ].join("\n"));
  }
  if (isNonEmptyString(orchestrator.name)) parts.push(documentInstructions(model, orchestrator.name));
  const body = parts.filter(Boolean).join("\n\n");
  // Unchanged prompt text stays byte-identical for systems without additions.
  return body === prompt.replace(/\n$/, "") ? prompt : body;
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
  lines.push(...(enforcedLines.length ? enforcedLines : ["None declared."]));
  // A tool allowlist limits which tools an agent calls, not what a shell reaches.
  if (enforcedLines.length) lines.push("", "An agent with `bash` or a shell-like command can still reach anything your user account can.");
  lines.push("", "### Advisory (guidance — not enforced)", "");
  lines.push(...(advisory.length ? advisory.map((line) => `- ${line}`) : ["None declared."]));
  lines.push("");
  return lines.join("\n");
}

function readmeBody(model) {
  const name = typeof model.name === "string" ? model.name : "";
  const description = typeof model.description === "string" ? model.description : "";
  return [
    `# ${name}`,
    "",
    description,
    "",
    "## Run",
    "",
    "The generated `./run` launcher is the entry point. It starts Pi with the",
    "project's own Pi configuration and logins, without your global Pi settings,",
    "MCP servers or extensions. Your environment, including any credentials in",
    "it, is inherited, and it is not an OS sandbox. Skills in the shared Agent",
    "Skills folder (`~/.agents/skills/`) do load, for the orchestrator.",
    "",
    "```sh",
    "./run             # interactive",
    "./run -p \"...\"   # headless one-shot",
    ...((Array.isArray(model.workflows) ? model.workflows : []).map(w => `./run --workflow ${w.name}`)),
    "```",
    "",
    ...((model.workflows?.length ?? 0) ? [
      "Named workflow runs accept `--input key=value` (repeatable), `--timeout 30m`",
      "(default 30m; units s, m or h), and `--allow-concurrent` to bypass the",
      "default per-workflow lock. They require Node.js, and run the workflow runner",
      "from the Forge package pinned in `.pi/settings.json`.",
      "Run interactive `./run` once to install project packages before the first",
      "named workflow; its installed Forge package validates system.yaml before Pi starts.",
      "Regenerate after changing declarations so derived files stay current.",
      "The final stdout line is JSON with workflow, runId, status, answer and",
      "an optional message. Exit codes: 0 success, 1 agent/tool failure,",
      "2 configuration/lock failure, 3 approval required, 4 timeout.",
      "When available, Forge starts a private systemd user scope and stops it on",
      "exit. The fallback is process-group termination plus stop requests for",
      "pi-subagents runs in this invocation's isolated temporary state. The result",
      "reports `cleanup: incomplete` and retains `stateDir` if cleanup is unconfirmed.",
      "Independently detached processes can survive the fallback cleanup.",
      "Approval is never granted unattended. Entry delegation and boundary",
      "instructions are model-directed, not a hard guarantee of execution.",
      "",
    ] : []),
    "On the first interactive run, Pi may start npm package installation processes",
    "that continue briefly after Pi exits and may keep output pipes open. Callers",
    "should allow extra time before assuming the output stream has closed.",
    "",
    "Authenticate inside `./run` with `/login`, or export",
    "the provider-specific key (for example `DEEPSEEK_API_KEY`). See the policy",
    "section below for which",
    "capabilities are enforced vs advisory.",
    ...(model.integrations?.env?.length ? ["For integration variables, see `.env.example` and use `/faur env set NAME`."] : []),
    ...[...new Set(integrationSecrets(model))].map(path => `For integration secrets in \`${path}\`, use \`/faur env set NAME --file ${path}\`; declare NAME in integrations.env first. Forge does not load this file; configure the integration to read it.`),
    "",
    ...((model.setup?.length || model.integrations?.mcp?.some(x => x.setup?.length) || model.integrations?.cli?.some(x => x.setup?.length)) ? [
      '## Setup', '',
      'Checks run commands with your user permissions; use only trusted project declarations.',
      'Run `/faur setup` to review and approve unmet installs (root steps are manual).', '',
      ...[...(model.setup ?? []), ...(model.integrations?.mcp ?? []).flatMap(x => x.setup ?? []), ...(model.integrations?.cli ?? []).flatMap(x => x.setup ?? [])].map(s => `- ${s.description}: \`${s.install}\``), '',
    ] : []),
    '## Maintain',
    '',
    '`/faur <request>` proposes a change; when the turn ends, Forge asks you',
    'to discuss, apply or discard it. Replies continue the conversation until',
    'then; `/faur exit` leaves. `/faur review` is read-only.',
    '`/faur check` verifies the agent, `/faur status` summarizes it, and',
    '`/faur sync` moves to the newest Forge release after two confirmations.',
    'Roll back with git. `/faur permissions` lists the commands agents may run',
    'and adds, removes or reviews them; agents ask for a command they need with',
    '`request_permission`. Restart `./run` when the launcher or packages change.',
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

function skillEntries(model) {
  // Sourced skills come from a pinned package or a vendored user directory, so
  // they produce no generated SKILL.md and are not managed paths.
  return authoredSkills(model).filter((skill) => isNonEmptyString(skill.name));
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
    if (isPlainObject(wf) && isNonEmptyString(wf.skill)) workflowBySkill.set(wf.skill, wf);
  }
  return skillEntries(model).map((skill) => {
    const path = skillPath(skill);
    return authoredFile(path, "trailing-html", skillFileBody(skill, workflowBySkill), existing[path]);
  });
}

/** Every project-relative path `generate` may write for a given model. */
export function managedPaths(model) {
  const paths = [...GENERATED_PATHS];
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
 *   `packages`, and the AGENTS.md/CLAUDE.md files the launcher would skip.
 * @returns {{ files: Array<{ path: string, content: string, action: string, desired?: string }>, warnings: string[], errors: string[] }}
 */
export function generateProject(model, existingFiles = {}, opts = {}) {
  const existing = isPlainObject(existingFiles) ? existingFiles : {};
  const piPackages = isPlainObject(opts) ? opts.piPackages : undefined;
  const contextFiles = isPlainObject(opts) && Array.isArray(opts.contextFiles) ? opts.contextFiles : [];
  const plan = buildRuntimePlan(model, { piPackages, contextFiles, firstBuild: existing["run"] === undefined });
  const prompt = orchestratorBody(model);
  const subagentConfig = backgroundAgents(model).length > 0
    ? [derivedFile(SUBAGENT_CONFIG, buildSubagentConfig(existing[SUBAGENT_CONFIG]), existing[SUBAGENT_CONFIG])]
    : [];

  const files = [
    derivedFile(".pi/settings.json", buildSettings(model, existing[".pi/settings.json"], plan.packages), existing[".pi/settings.json"]),
    derivedFile(".pi/mcp.json", buildMcpJson(model, existing[".pi/mcp.json"]), existing[".pi/mcp.json"]),
    authoredFile(".pi/APPEND_SYSTEM.md", "html", prompt, existing[".pi/APPEND_SYSTEM.md"]),
    derivedFile(".pi/CAPABILITIES.md", capabilitySection(model, model.orchestrator?.name), existing[".pi/CAPABILITIES.md"]),
    authoredFile("README.md", "html", readmeBody(model), existing["README.md"]),
    gitignoreFile(existing[".gitignore"], model),
    authoredFile(".env.example", "plain", envBody(model), existing[".env.example"]),
    sentinelFile("data/knowledge/.gitkeep", existing["data/knowledge/.gitkeep"]),
    { ...derivedFile("run", plan.launcherScript, existing["run"]), executable: true },
    ...subagentConfig,
    ...agentFiles(model, existing),
    ...skillFiles(model, existing),
  ];

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, warnings: [...plan.warnings, ...configurationAdvisories(model)], errors: plan.errors };
}
