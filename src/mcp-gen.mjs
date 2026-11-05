/**
 * mcpGen — materialize `integrations.mcp[]` into Pi's built-in `.pi/mcp.json`.
 *
 * Pure module. Connection settings (stdio `command`/`args`/`env`/`cwd`, or
 * HTTP `url`/`headers`/`oauth`, plus `description`, `timeout`) are emitted
 * verbatim. `includeTools` and `excludeTools` are Faur's keys,
 * not Pi's, and become exposure:
 *   - tools nobody may use (`excludeTools`, enforced `hide` policies) are
 *     `hidden`: registered but unreachable, and not selectable by specialists;
 *   - with `includeTools`, the rest of the server is hidden and those tools are
 *     declared directly;
 *   - without it the server's tools are `deferred`: the orchestrator loads them
 *     with tool_search, so a large server does not fill its context.
 * Specialists receive exactly their `mcp:` selections from pi-subagents,
 * whatever the exposure. Secrets are always `${ENV}` references declared in the
 * model; `system.yaml` is authoritative, so an undeclared server never
 * survives regeneration.
 */
import { hiddenMcpTools } from "./policy.mjs";

const FAUR_KEYS = ["includeTools", "excludeTools"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

const strings = (value) => (Array.isArray(value) ? value.filter(isNonEmptyString) : []);
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/** The name Pi registers a server's tool under; patterns keep their wildcards. */
export function mcpToolName(server, tool) {
  const part = (s) => s.replace(/[^A-Za-z0-9_*?]/g, "_");
  return `mcp__${part(server)}__${part(tool)}`;
}

/**
 * What a server exposes: tools nobody may use, and the tools declared directly
 * (null when the whole server is deferred). Shared by `.pi/mcp.json` and the
 * capability section so the two cannot disagree.
 * @returns {{ hidden: string[], included: string[] | null }}
 */
export function mcpExposure(entry, policies) {
  const config = isPlainObject(entry?.config) ? entry.config : {};
  const hidden = [...new Set([...strings(config.excludeTools), ...hiddenMcpTools(entry?.name, policies)])];
  // Exact names win over patterns in Pi, so an included name a hidden
  // pattern covers is left out rather than listed.
  const included = config.includeTools === undefined ? null
    : strings(config.includeTools).filter((tool) => !hidden.some((h) => glob(h).test(tool)));
  return { hidden, included };
}

/**
 * @param {Array} mcpList the validated `integrations.mcp[]` entries.
 * @param {object|undefined} policies the validated `policies` block.
 * @returns {Record<string, object>} the `mcpServers` map, strictly declared.
 */
export function mcpFromIntegrations(mcpList, policies) {
  const servers = {};
  for (const entry of Array.isArray(mcpList) ? mcpList : []) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.name)) continue;
    const config = isPlainObject(entry.config) ? entry.config : {};
    const server = Object.fromEntries(Object.entries(config).filter(([key]) => !FAUR_KEYS.includes(key)));
    const { hidden, included } = mcpExposure(entry, policies);
    const toolExposure = Object.fromEntries(hidden.map((tool) => [tool, "hidden"]));
    for (const tool of included ?? []) toolExposure[tool] ??= "direct";
    server.exposure = included ? "hidden" : "deferred";
    if (Object.keys(toolExposure).length) server.toolExposure = toolExposure;
    servers[entry.name] = server;
  }
  return servers;
}
