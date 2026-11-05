/**
 * policy — materialize the enforced-vs-advisory policy split.
 *
 * Pure module. `policies.enforced[]` is the capability boundary (least
 * privilege, no runtime guard needed): an agent's `tools` allowlist and an
 * MCP server's hidden tool list. `policies.advisory[]` is behavioral guidance
 * only. The two are kept visibly separate so prose is never mistaken for
 * enforcement.
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function enforcedEntries(policies) {
  if (!isPlainObject(policies)) return [];
  return Array.isArray(policies.enforced) ? policies.enforced : [];
}

/**
 * The effective tool allowlist for an agent: an enforced `{ agent, tools }`
 * rule is the authoritative capability ceiling and replaces the agent's
 * declared `tools`; otherwise the declared tools stand.
 *
 * @param {string} agentName
 * @param {object|undefined} policies the validated `policies` block.
 * @param {string[]} declaredTools the agent's `tools` from `agents[]`.
 * @returns {string[]}
 */
export function enforcedAgentTools(agentName, policies, declaredTools) {
  for (const rule of enforcedEntries(policies)) {
    if (isPlainObject(rule) && rule.agent === agentName && Array.isArray(rule.tools)) {
      return rule.tools;
    }
  }
  return Array.isArray(declaredTools) ? declaredTools : [];
}

/**
 * The list of tool-name globs to hide for an MCP server, from an enforced
 * `{ mcp, hide }` rule. Materialized as hidden tools in `.pi/mcp.json`
 * (registered but unreachable in Pi's built-in MCP).
 *
 * @param {string} serverName
 * @param {object|undefined} policies
 * @returns {string[]}
 */
export function hiddenMcpTools(serverName, policies) {
  const out = new Set();
  for (const rule of enforcedEntries(policies)) {
    if (isPlainObject(rule) && rule.mcp === serverName && Array.isArray(rule.hide)) {
      for (const pattern of rule.hide) {
        if (typeof pattern === "string") out.add(pattern);
      }
    }
  }
  return [...out];
}

/**
 * The advisory guidance strings, in order.
 *
 * @param {object|undefined} policies
 * @returns {string[]}
 */
export function advisoryText(policies) {
  if (!isPlainObject(policies) || !Array.isArray(policies.advisory)) return [];
  return policies.advisory.filter((line) => typeof line === "string");
}

/**
 * Every agent can browse and read files: an explicit, non-empty tool list
 * always includes these. They add no reach `read` lacks (it opens any file
 * the user can); they make it usable. `tools: []` stays empty, an omitted
 * list keeps Pi's defaults (which include bash), and an enforced
 * `{ agent, tools }` policy rule stays the ceiling, so a design can still
 * keep an agent away from files.
 */
export const BASELINE_TOOLS = ['read', 'ls', 'find', 'grep'];

/** `tools` with the baseline added, or unchanged when empty or omitted. */
export function withBaseline(tools) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  return [...tools, ...BASELINE_TOOLS.filter(tool => !tools.includes(tool))];
}

/** The design with the baseline in every agent's explicit tool list. */
export function withBaselineTools(model) {
  if (!isPlainObject(model)) return model;
  const agent = a => isPlainObject(a) && Array.isArray(a.tools) ? { ...a, tools: withBaseline(a.tools) } : a;
  return {
    ...model,
    ...(isPlainObject(model.orchestrator) ? { orchestrator: agent(model.orchestrator) } : {}),
    ...(Array.isArray(model.agents) ? { agents: model.agents.map(agent) } : {}),
  };
}
