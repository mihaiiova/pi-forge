/**
 * The agent runtime: what a generated system's agents use while they work —
 * the orchestrator's memory, declared command tools, request_permission and
 * the /faur permissions handler, and the lead's capability section for
 * projects built before it was build output.
 *
 * It comes from the Forge package pinned in the project's .pi/settings.json,
 * so it changes only when an approved update moves that pin. Stable interface:
 * registerAgent(pi, Type, root, { maintaining }), where maintaining() is true
 * during a /faur revision turn. Returns the /faur permissions handler
 * (undefined in a subagent process).
 */
import { readText } from './maintenance-store.mjs';
import { parsedModel } from './changes.mjs';
import { memoryPrompt, updateMemory, failedTools, MEMORY_FILE } from './memory.mjs';
import { registerPermissions } from './permissions-extension.mjs';
import { capabilitySection } from './agent-context.mjs';
import { mcpApprovals } from './mcp-gen.mjs';
import { blockWorkflowApproval } from './workflow-approval.mjs';
import { leadTools } from './asking.mjs';

/** Pi's MCP tools: each server's, and the resource tools that reach every server. */
const isMcpTool = (name) => name.startsWith('mcp__') || ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name);

export function registerAgent(pi, Type, root, { maintaining = () => false, argv } = {}) {
  registerMemory(pi, Type, root, maintaining);
  registerMcpBoundary(pi, root);
  const permissions = registerPermissions(pi, Type, root);
  registerAgentContext(pi, root, argv);
  registerCredentialNotice(pi, root);
  return permissions;
}

const PROVIDER_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY' };

/** Query Pi's configured-auth status only; never resolve or display credential values. */
function registerCredentialNotice(pi, root) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  pi.on('session_start', (_event, ctx) => {
    if (!ctx?.hasUI || typeof ctx.modelRegistry?.getProviderAuthStatus !== 'function') return;
    let model;
    try { model = parsedModel(readText(root, '.pi/system.yaml')); } catch { return; }
    const providers = new Set([model.orchestrator, ...(model.agents ?? [])].map(agent => agent?.model?.split('/')[0]).filter(Boolean));
    for (const provider of providers) {
      if (ctx.modelRegistry.getProviderAuthStatus(provider).configured) continue;
      const env = PROVIDER_ENV[provider];
      ctx.ui.notify(`Provider ${provider} is unavailable or has no credentials. Check the project provider configuration and use /login ${provider}${env ? ` or set ${env} before starting ./run` : ', or see Pi provider documentation for environment setup'}.`, 'warning');
    }
  });
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
      blockWorkflowApproval(call);
      return { block: true, reason: `${call} needs the user's approval for each call, which this session can't ask for. Report the exact call you need instead.` };
    }
    const input = JSON.stringify(event.input ?? {}, null, 2);
    if (await ctx.ui.confirm(`Allow this MCP call? ${call}`, input.length > 4000 ? `${input.slice(0, 4000)}\n…` : input)) return undefined;
    return { block: true, reason: 'The user declined this call. Do not try it another way.' };
  });
}

/**
 * Orchestrator memory: notes loaded once per session, written freely by the
 * memory tool, and a nudge to record a lesson after a task with failed tool
 * calls. Subagent processes skip all of it.
 */
function registerMemory(pi, Type, root, maintaining) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  let snapshot = '';
  let failed = [];
  let maintenanceTurn = false;
  pi.registerTool({
    name: 'memory', label: 'Memory',
    description: `Keep durable notes across sessions in ${MEMORY_FILE}: add an entry, or replace/remove the one entry containing "match". Notes load at the start of the next session.`,
    promptSnippet: 'Save, update or remove a durable note for future sessions',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('add'), Type.Literal('replace'), Type.Literal('remove')]),
      text: Type.Optional(Type.String({ description: 'add/replace: the entry, one short line' })),
      match: Type.Optional(Type.String({ description: 'replace/remove: text from the existing entry' })),
    }),
    async execute(_id, params) {
      return { content: [{ type: 'text', text: updateMemory(root, params) }], details: undefined };
    },
  });
  // A snapshot keeps the prompt stable; writes take effect next session.
  pi.on('session_start', () => { try { snapshot = memoryPrompt(root); } catch { snapshot = ''; } });
  pi.on('before_agent_start', (event) => {
    if (!snapshot) return;
    // A /faur revision turn can't use the memory tool; keep any nudge for later.
    maintenanceTurn = maintaining();
    if (maintenanceTurn) return { systemPrompt: `${event.systemPrompt}\n\n${snapshot}` };
    const nudge = failed.length ? `\n\nThe previous task had failed tool calls (${failed.join(', ')}). If you learned something that will matter next time, save it with memory.` : '';
    failed = [];
    return { systemPrompt: `${event.systemPrompt}\n\n${snapshot}${nudge}` };
  });
  pi.on('agent_end', (event) => { if (!maintenanceTurn) failed = failedTools(event?.messages); });
}

/**
 * The orchestrator's "What you can use" section when Pi was not started with
 * it: a launcher from before it was build output, or plain `pi`. ./run passes
 * .pi/CAPABILITIES.md; otherwise that file is added at session start, or the
 * section is rendered from system.yaml when the project predates the file.
 */
function registerAgentContext(pi, root, argv = process.argv) {
  if (process.env.PI_SUBAGENT_CHILD === '1') return;
  let section = '';
  pi.on('session_start', () => {
    try {
      if (argv.some((a) => a.endsWith('.pi/CAPABILITIES.md'))) { section = ''; return; }
      const built = readText(root, '.pi/CAPABILITIES.md');
      if (built !== null) { section = built; return; }
      const model = parsedModel(readText(root, '.pi/system.yaml'));
      section = capabilitySection(model, model.orchestrator?.name);
    } catch { section = ''; }
  });
  pi.on('before_agent_start', (event) => (section ? { systemPrompt: `${event.systemPrompt}\n\n${section}` } : undefined));
}
