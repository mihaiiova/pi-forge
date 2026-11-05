/** Declared commands that ask before each call cannot run unattended. */
import { enforcedAgentTools } from "./policy.mjs";
import { cliEntries, cliRef } from "./cli-tools.mjs";

const list = (value) => Array.isArray(value) ? value : [];
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function askingReach(model, tools) {
  const commands = new Map(cliEntries(model).map((c) => [c.name, c]));
  return { cli: list(tools).map(cliRef).filter((name) => name && commands.has(name) && commands.get(name).approve !== false) };
}

export function leadTools(model) {
  const lead = model?.orchestrator;
  if (!isPlainObject(lead)) return [];
  return Array.isArray(lead.tools) ? lead.tools : ["mcp", ...cliEntries(model).map((c) => `cli:${c.name}`)];
}

export function backgroundAskingIssues(model) {
  const out = [];
  list(model?.agents).forEach((agent, index) => {
    if (!isPlainObject(agent) || typeof agent.name !== "string" || !agent.name.trim()) return;
    const tools = enforcedAgentTools(agent.name, model.policies, agent.tools);
    const { cli } = askingReach(model, tools);
    if (!cli.length) return;
    const ruled = list(model.policies?.enforced).some((r) => isPlainObject(r) && r.agent === agent.name);
    const fix = !ruled && Array.isArray(agent.tools)
      ? { op: "update", target: "agent", name: agent.name, value: { tools: agent.tools.filter((tool) => !cli.includes(cliRef(tool))) } }
      : null;
    out.push({
      agent: agent.name, index, cli,
      message: `"${agent.name}" may run in the background, where nobody can answer an approval prompt, so these calls that ask the user would fail: ${cli.map((name) => `command ${name}`).join("; ")}. ` +
        "Give the subagent only tools that don't ask; the orchestrator makes the approved calls for it" +
        (fix ? "" : ruled ? " (edit its enforced tools rule)" : "") + ".",
      fix,
    });
  });
  return out;
}
