/**
 * The agent runtime: what a generated system's agents use while they work —
 * declared command tools, request_permission and the /faur permissions
 * handler, MCP approvals and the lead's MCP boundary. Pi itself loads the
 * prompt, capability section and context files.
 *
 * It comes from the Forge package pinned in the project's .pi/settings.json,
 * which generation adds only when the design needs it (`runtimeNeeds`), so it
 * changes only when an approved update moves that pin. Stable interface:
 * registerAgent(pi, Type, root). Returns the /faur permissions handler
 * (undefined in a subagent process).
 */
import { readText } from './maintenance-store.mjs';
import { parsedModel } from './changes.mjs';
import { registerPermissions } from './permissions-extension.mjs';
import { mcpApprovals } from './mcp-gen.mjs';
import { leadTools } from './asking.mjs';
import { runtimeNeeds } from './deps.mjs';

/** Pi's MCP tools: each server's, and the resource tools that reach every server. */
const isMcpTool = (name) => name.startsWith('mcp__') || ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name);

export function registerAgent(pi, Type, root) {
  let model = null;
  try { model = parsedModel(readText(root, '.pi/system.yaml')); } catch { /* reported by the commands that use it */ }
  // A design that needs no Forge runtime runs on Pi alone, even when Faur is
  // installed in the developer's Pi: only the /faur permissions handler loads.
  const runtime = model === null || runtimeNeeds(model).forge;
  if (runtime) registerMcpBoundary(pi, root);
  return registerPermissions(pi, Type, root, { runtime });
}

/**
 * What MCP tools an agent may call, enforced on every call (declared, loaded
 * by tool_search, or from a codemode script):
 * - an orchestrator without `mcp` may call none. The tools stay registered,
 *   because pi-subagents hands specialists their `mcp:` selections from them,
 *   but they are taken out of its active tools and blocked;
 * - approveTools: Pi's built-in MCP asks nobody, so each call to a listed tool
 *   asks the user here first. Without a UI (headless runs, background
 *   specialists) the call is blocked.
 */
function registerMcpBoundary(pi, root) {
  let model;
  try { model = parsedModel(readText(root, '.pi/system.yaml')); } catch { return; }
  const approvals = mcpApprovals(model);
  const servers = Array.isArray(model.integrations?.mcp) ? model.integrations.mcp.length : 0;
  const lead = model.orchestrator?.name ?? 'The orchestrator';
  const outside = process.env.PI_SUBAGENT_CHILD !== '1' && servers > 0 && !leadTools(model).includes('mcp');
  if (!approvals.length && !outside) return;
  if (outside) {
    pi.on('before_agent_start', () => {
      const active = pi.getActiveTools();
      if (active.some(isMcpTool)) pi.setActiveTools(active.filter((name) => !isMcpTool(name)));
    });
  }
  pi.on('tool_call', async (event, ctx) => {
    if (outside && isMcpTool(event.toolName)) return { block: true, reason: `${lead} has no MCP access in this system. Delegate to a specialist that has this tool.` };
    const rule = approvals.find((a) => a.test(event.toolName));
    if (!rule) return undefined;
    const call = `${rule.server}: ${event.toolName.slice(event.toolName.indexOf('__', 5) + 2)}`;
    if (!ctx?.hasUI) {
      return { block: true, reason: `${call} needs the user's approval for each call, which this session can't ask for. Report the exact call you need instead.` };
    }
    const input = JSON.stringify(event.input ?? {}, null, 2);
    if (await ctx.ui.confirm(`Allow this MCP call? ${call}`, input.length > 4000 ? `${input.slice(0, 4000)}\n…` : input)) return undefined;
    return { block: true, reason: 'The user declined this call. Do not try it another way.' };
  });
}
