/**
 * agent-context — the generated "What you can use" section of each agent's
 * instructions, and stale mentions of removed capabilities.
 *
 * Pure seam. Prompts in system.yaml describe the role, judgement and rules;
 * which tools, MCP servers, commands, skills and specialists an agent has is
 * rendered here from the declarations, so it changes whenever they do.
 */
import { advisoryText, enforcedAgentTools } from "./policy.mjs";
import { cliEntries, cliRef, cliToolName, formatCommand } from "./cli-tools.mjs";
import { askingReach, leadTools } from "./asking.mjs";
import { mcpExposure, mcpToolName } from "./mcp-gen.mjs";

const BUILTIN = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

const list = (value) => (Array.isArray(value) ? value : []);
const describeServer = (entry) => isNonEmptyString(entry?.config?.description) ? entry.config.description : "";

/**
 * The section for one agent (the orchestrator or a subagent).
 * @returns {string} markdown, or "" when the agent is unknown.
 */
export function capabilitySection(model, name) {
  const orchestrator = isPlainObject(model?.orchestrator) ? model.orchestrator : null;
  const isLead = orchestrator?.name === name;
  const agent = isLead ? orchestrator : list(model?.agents).find((a) => isPlainObject(a) && a.name === name);
  if (!agent) return "";
  const declared = isLead ? (Array.isArray(agent.tools) ? agent.tools : undefined) : enforcedAgentTools(name, model.policies, agent.tools);
  const all = !Array.isArray(declared);
  const tools = list(declared);
  const servers = list(model?.integrations?.mcp).filter(isPlainObject);
  const commands = cliEntries(model);
  const lines = ["## What you can use", "", "Generated from this system's declarations; it changes when they do. Use only what is listed here.", ""];

  const builtins = tools.filter((t) => BUILTIN.has(t));
  lines.push(`- **Built-in tools:** ${all ? "Pi's defaults" : builtins.length ? builtins.join(", ") : "none"}`);

  // Server name → selected tools, or null for all of them.
  const selected = new Map();
  if (all || (isLead && tools.includes("mcp"))) for (const s of servers) selected.set(s.name, null);
  else {
    for (const t of tools.filter((t) => t.startsWith("mcp:"))) {
      const [server, tool] = t.slice(4).split("/");
      const prior = selected.get(server);
      selected.set(server, !tool || prior === null ? null : [...(prior ?? []), tool]);
    }
  }
  // A whole-server selection reaches what .pi/mcp.json exposes, not every tool.
  const mcp = [...selected].map(([name, picked]) => {
    const s = servers.find((s) => s.name === name);
    const { hidden, included } = mcpExposure(s ?? { name }, model?.policies);
    return { name, s, hidden: picked ? [] : hidden, only: picked ?? included };
  });
  if (mcp.length) {
    lines.push("- **MCP servers:**");
    for (const m of mcp) {
      const about = describeServer(m.s, m.only);
      // Without includeTools the lead's server is deferred: tool_search loads its tools.
      const search = isLead && m.s?.config?.includeTools === undefined ? ", found with tool_search" : "";
      const code = (tool) => `\`${mcpToolName(m.name, tool)}\``;
      const except = m.hidden.length ? ` except ${m.hidden.map(code).join(", ")}` : "";
      const scope = m.only ? (m.only.length ? `only ${m.only.map(code).join(", ")}` : "no tools") : `all tools${except}; tools named \`${mcpToolName(m.name, "")}<tool>\``;
      lines.push(`  - \`${m.name}\` (${scope}${search})${about ? ` — ${about}` : ""}`);
    }
  }

  const mine = commands.filter((c) => (isLead ? all || tools.includes(`cli:${c.name}`) : tools.includes(`cli:${c.name}`)));
  if (mine.length) {
    lines.push("- **Commands** (no shell): `{name}` is a value you supply, such as an existing path; `{name:file}` writes your text to a temporary file and passes its path.");
    for (const c of mine) {
      lines.push(`  - \`${cliToolName(c.name)}\`${isNonEmptyString(c.description) ? ` — ${c.description}` : ""}: \`${formatCommand(c.command, list(c.args))}\`; ${c.approve === false ? "runs without asking" : "the user approves each run"}`);
    }
  }

  const other = tools.filter((t) => !BUILTIN.has(t) && !t.startsWith("mcp") && !cliRef(t) && t !== "subagent");
  if (other.length) lines.push(`- **Other tools:** ${other.join(", ")}`);

  const skills = list(agent.skills).map((s) => list(model?.skills).find((d) => d?.name === s) ?? { name: s });
  if (skills.length) {
    lines.push("- **Skills:**");
    for (const s of skills) lines.push(`  - \`${s.name}\`${isNonEmptyString(s.description) ? ` — ${s.description}` : ""}`);
  }

  if (isLead) {
    const specialists = list(model?.agents).filter((a) => isPlainObject(a) && isNonEmptyString(a.name));
    if (specialists.length && (all || tools.includes("subagent"))) {
      lines.push("- **Specialists** (delegate with the subagent tool):");
      for (const s of specialists) lines.push(`  - \`${s.name}\`${isNonEmptyString(s.description) ? ` — ${s.description}` : ""}`);
      lines.push("", "Specialist completion notices may be truncated. When the subagent tool supports durable output binding, bind reports to project paths only when the specialist can write there and you have an authorized way to read them; otherwise request a concise return and report missing access rather than assuming a path is readable.");
    }
    const asking = askingReach(model, leadTools(model));
    if (specialists.length && (all || tools.includes("subagent")) && (asking.cli.length)) {
      const write = all || tools.includes("write");
      lines.push("", `Only you can make the calls above that ask the user: specialists run in the background, where nobody can answer the prompt. When a specialist needs one, get the user's approval, make the call and pass the result on${write ? " (save it to a project file and give the specialist its path)" : ""}.`);
    }
    lines.push("", "If a task needs something not listed, say what is missing. Don't work around a missing capability.");
  } else {
    lines.push("", "If a task needs something not listed, report what is missing to the orchestrator instead of working around it.");
  }
  return `${lines.join("\n")}\n`;
}

/** Text the user wrote that instructs agents, by where it lives in system.yaml. */
function instructionTexts(model) {
  const out = [];
  if (isNonEmptyString(model?.orchestrator?.prompt)) out.push([`orchestrator (${model.orchestrator.name}) prompt`, model.orchestrator.prompt]);
  for (const a of list(model?.agents)) if (isNonEmptyString(a?.prompt)) out.push([`agent ${a.name} prompt`, a.prompt]);
  for (const w of list(model?.workflows)) {
    const text = [w?.description, w?.approval, w?.verify].filter(isNonEmptyString).join("\n");
    if (text) out.push([`workflow ${w.name}`, text]);
  }
  for (const d of list(model?.documents)) {
    const text = [d?.purpose, ...list(d?.rules), ...list(d?.sections).map((s) => s?.guide)].filter(isNonEmptyString).join("\n");
    if (text) out.push([`document ${d.name}`, text]);
  }
  const advisory = advisoryText(model?.policies).join("\n");
  if (advisory) out.push(["advisory policies", advisory]);
  return out;
}

/** Names a removed capability may be mentioned by: the server, command or skill, and an MCP server's listed tools. */
function capabilityNames(model) {
  const names = new Map();
  for (const s of list(model?.integrations?.mcp)) {
    if (!isNonEmptyString(s?.name)) continue;
    const config = isPlainObject(s.config) ? s.config : {};
    const tools = list(config.includeTools).filter((t) => typeof t === "string" && !t.includes("*"));
    names.set(`MCP server ${s.name}`, [s.name, ...new Set(tools)]);
  }
  for (const c of cliEntries(model)) names.set(`command ${c.name}`, [c.name, cliToolName(c.name)]);
  for (const s of list(model?.skills)) if (isNonEmptyString(s?.name)) names.set(`skill ${s.name}`, [s.name]);
  return names;
}

/**
 * Capabilities removed by a change that the new model's prompts, workflows,
 * documents or advisory policies still mention, with the lines that do.
 * @returns {Array<{ removed: string, where: string, lines: string[] }>}
 */
export function staleMentions(oldModel, newModel) {
  const before = capabilityNames(oldModel);
  const after = capabilityNames(newModel);
  const out = [];
  for (const [removed, words] of before) {
    if (after.has(removed)) continue;
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_-])`);
    for (const [where, text] of instructionTexts(newModel)) {
      const lines = text.split("\n").filter((line) => pattern.test(line)).map((line) => line.trim());
      if (lines.length) out.push({ removed, where, lines: lines.slice(0, 10), ...(lines.length > 10 ? { more: lines.length - 10 } : {}) });
    }
  }
  return out;
}
