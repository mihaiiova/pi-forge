/**
 * asking — tools that ask the user before each call, and who may hold them.
 *
 * Pure seam. An MCP tool matching its server's `approveTools`, or a declared
 * command without `approve: false`, waits for the user's answer. Subagents
 * with such tools run in the background (generate.mjs needsBackground), where
 * nobody can answer, so every call fails closed. Those calls belong to the
 * orchestrator, which runs in the user's chat; specialists ask it for them.
 */
import { enforcedAgentTools, hiddenMcpTools } from "./policy.mjs";
import { cliEntries, cliRef } from "./cli-tools.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const list = (value) => (Array.isArray(value) ? value : []);
const globRe = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

function serverConfigs(model) {
  const mcp = isPlainObject(model?.integrations) ? list(model.integrations.mcp) : [];
  return new Map(mcp.filter((m) => isPlainObject(m) && isNonEmptyString(m.name) && isPlainObject(m.config)).map((m) => [m.name, m.config]));
}

/**
 * A server's visible tools that ask, and those that don't. `listed` is false
 * when the server declares no `includeTools`: `asking` then holds the
 * approve patterns and `quiet` is unknown (empty).
 * @returns {{ asking: string[], quiet: string[], listed: boolean }}
 */
export function serverAsking(model, name) {
  const config = serverConfigs(model).get(name);
  if (!config) return { asking: [], quiet: [], listed: false };
  const approve = config.approveTools === true ? ["*"] : list(config.approveTools).filter(isNonEmptyString);
  const hidden = [...list(config.excludeTools), ...hiddenMcpTools(name, model.policies)].filter(isNonEmptyString).map(globRe);
  if (!Array.isArray(config.includeTools)) {
    return { asking: approve.filter((p) => !hidden.some((h) => h.test(p))), quiet: [], listed: false };
  }
  const visible = config.includeTools.filter((t) => isNonEmptyString(t) && !hidden.some((h) => h.test(t)));
  const asks = (t) => approve.some((p) => globRe(p).test(t));
  return { asking: visible.filter(asks), quiet: visible.filter((t) => !asks(t)), listed: true };
}

/**
 * What an agent's tools reach that asks the user.
 * @returns {{ mcp: Map<string, string[]>, cli: string[] }} server → asking tools; command names
 */
export function askingReach(model, tools) {
  const servers = serverConfigs(model);
  const mcp = new Map();
  const add = (name, found) => { if (found.length) mcp.set(name, [...new Set([...(mcp.get(name) ?? []), ...found])]); };
  for (const tool of list(tools)) {
    if (tool === "mcp") for (const name of servers.keys()) add(name, serverAsking(model, name).asking);
    if (typeof tool !== "string" || !tool.startsWith("mcp:")) continue;
    const [name, only] = tool.slice(4).split("/");
    if (!servers.has(name)) continue;
    const { asking } = serverAsking(model, name);
    add(name, only ? asking.filter((t) => globRe(t).test(only)) : asking);
  }
  const commands = new Map(cliEntries(model).map((c) => [c.name, c]));
  const cli = list(tools).map(cliRef).filter((name) => name && commands.has(name) && commands.get(name).approve !== false);
  return { mcp, cli };
}

/** The orchestrator's tools; an omitted list means everything. */
export function leadTools(model) {
  const lead = model?.orchestrator;
  if (!isPlainObject(lead)) return [];
  return Array.isArray(lead.tools) ? lead.tools : ["mcp", ...cliEntries(model).map((c) => `cli:${c.name}`)];
}

/** One selection that replaces `tool` without the asking part, or null when that can't be known. */
function quietReplacement(model, tool) {
  if (tool.startsWith("mcp:") && tool.includes("/")) {
    const [name, only] = tool.slice(4).split("/");
    return serverAsking(model, name).asking.some((t) => globRe(t).test(only)) ? [] : [tool];
  }
  const names = tool === "mcp" ? [...serverConfigs(model).keys()] : [tool.slice(4)];
  const out = [];
  for (const name of names) {
    const { asking, quiet, listed } = serverAsking(model, name);
    if (!asking.length) out.push(`mcp:${name}`);
    else if (!listed) return null;
    else out.push(...quiet.map((t) => `mcp:${name}/${t}`));
  }
  return out;
}

/**
 * Subagents that can reach a tool that asks, with a ready fix where one is
 * unambiguous: the same agent's tools without the asking part. An agent whose
 * tools come from an enforced policy rule gets no ready fix (edit the rule).
 * @returns {Array<{ agent: string, index: number, mcp: Record<string, string[]>, cli: string[], message: string, fix: object | null }>}
 */
export function backgroundAskingIssues(model) {
  const out = [];
  list(model?.agents).forEach((agent, index) => {
    if (!isPlainObject(agent) || !isNonEmptyString(agent.name)) return;
    const tools = enforcedAgentTools(agent.name, model.policies, agent.tools);
    const { mcp, cli } = askingReach(model, tools);
    if (!mcp.size && !cli.length) return;
    const reached = [
      ...[...mcp].map(([name, found]) => `${name} tools ${found.join(", ")}`),
      ...cli.map((name) => `command ${name}`),
    ];
    let fix = null;
    const ruled = list(model.policies?.enforced).some((r) => isPlainObject(r) && r.agent === agent.name);
    if (!ruled && Array.isArray(agent.tools)) {
      let next = [];
      for (const tool of agent.tools) {
        const replaced = tool === "mcp" || (typeof tool === "string" && tool.startsWith("mcp:") && mcp.has(tool.slice(4).split("/")[0]))
          ? quietReplacement(model, tool)
          : cli.includes(cliRef(tool)) ? [] : [tool];
        if (replaced === null) { next = null; break; }
        next.push(...replaced);
      }
      if (next) fix = { op: "update", target: "agent", name: agent.name, value: { tools: [...new Set(next)] } };
    }
    out.push({
      agent: agent.name, index, mcp: Object.fromEntries(mcp), cli,
      message: `"${agent.name}" runs in the background, where nobody can answer an approval prompt, so these calls that ask the user would always fail: ${reached.join("; ")}. ` +
        "Give the subagent only tools that don't ask; the orchestrator makes the approved calls for it" +
        (fix ? "" : ruled ? " (edit its enforced tools rule)" : "") + ".",
      fix,
    });
  });
  return out;
}
