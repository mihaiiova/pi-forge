/**
 * launch-check — will each subagent actually get what it is declared to have?
 *
 * Deterministic and model-free: compares each agent's tools and skills with
 * what this project provides (the MCP tools Pi registered for connected
 * servers, tools registered by loaded extensions, installed skill
 * directories, background launch setup). Run at session start and by
 * /faur check so a broken specialist is reported before a workflow depends
 * on it. MCP servers connect after session start, so their tools are checked
 * only when `mcpTools` is given.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { enforcedAgentTools } from './policy.mjs';
import { needsBackground, SUBAGENT_CONFIG } from './generate.mjs';
import { skillSourceKind } from './skill-sources.mjs';
import { cliEntries, cliRef } from './cli-tools.mjs';
import { probeClis } from './discover.mjs';
import { backgroundAskingIssues } from './asking.mjs';
import { mcpToolName } from './mcp-gen.mjs';

const BUILTIN = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

function readJson(root, rel) {
  try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return null; }
}


/**
 * @param {string} root project directory
 * @param {object} model validated system.yaml
 * @param {{ registeredTools?: string[], mcpTools?: Array<{ name: string, exposure?: string }>, probe?: (cli: string) => boolean }} [opts]
 *   tool names registered in this session (from pi.getAllTools()); extension
 *   tools are checked only when given. `mcpTools` are the registered MCP tools
 *   with their exposure; MCP selections are checked only when given. `probe`
 *   checks a command is on PATH.
 * @returns {{ ok: boolean, problems: Array<{ agent: string, problem: string }> }}
 */
export function launchCheck(root, model, { registeredTools, mcpTools, probe } = {}) {
  const problems = [];
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const workTree = git(['rev-parse', '--is-inside-work-tree']);
  if (workTree.status === 0 && workTree.stdout.trim() === 'true') {
    for (const path of ['.env', '.forge/']) {
      const ignored = git(['check-ignore', '--no-index', '-q', '--', path]);
      if (ignored.status === 1) problems.push({ agent: model?.orchestrator?.name ?? 'project', problem: `${path} is not ignored by git; credentials or state may be committed` });
    }
  }
  const mcpServers = readJson(root, '.pi/mcp.json')?.mcpServers ?? {};
  const registered = Array.isArray(registeredTools) ? new Set(registeredTools) : null;
  const forced = readJson(root, SUBAGENT_CONFIG)?.forceTopLevelAsync === true;
  const skills = new Map((Array.isArray(model?.skills) ? model.skills : []).map((s) => [s.name, s]));
  const commands = new Map(cliEntries(model).map((c) => [c.name, c]));
  const probed = new Map();
  const installed = (command) => {
    if (!probed.has(command)) probed.set(command, command.includes('/') ? existsSync(resolve(root, command)) : probeClis([command], probe ? { probe } : {})[command] === true);
    return probed.get(command);
  };
  const checkCommands = (agentName, tools) => {
    for (const name of (Array.isArray(tools) ? tools : []).map(cliRef).filter(Boolean)) {
      const entry = commands.get(name);
      if (entry && !installed(entry.command)) problems.push({ agent: agentName, problem: `cli:${name}: "${entry.command}" is not installed or not on PATH` });
    }
  };
  if (model?.orchestrator) {
    const tools = Array.isArray(model.orchestrator.tools) ? model.orchestrator.tools : cliEntries(model).map((c) => `cli:${c.name}`);
    checkCommands(model.orchestrator.name, tools);
    for (const tool of tools) {
      if (!BUILTIN.has(tool) && !cliRef(tool) && tool !== 'mcp' && !tool.startsWith('mcp:') && registered && !registered.has(tool)) {
        problems.push({ agent: model.orchestrator.name, problem: `${tool}: no loaded extension registers this tool` });
      }
    }
  }
  for (const agent of Array.isArray(model?.agents) ? model.agents : []) {
    const report = (problem) => problems.push({ agent: agent.name, problem });
    const tools = enforcedAgentTools(agent.name, model.policies, agent.tools);
    checkCommands(agent.name, tools);
    for (const tool of Array.isArray(tools) ? tools : []) {
      if (BUILTIN.has(tool) || cliRef(tool)) continue;
      if (tool.startsWith('mcp:')) {
        const [server, name] = tool.slice(4).split('/');
        if (!mcpServers[server]) { report(`${tool}: MCP server "${server}" is not configured in .pi/mcp.json`); continue; }
        if (!Array.isArray(mcpTools)) continue;
        const prefix = mcpToolName(server, '');
        const offered = mcpTools.filter((t) => t?.name?.startsWith(prefix));
        const usable = offered.filter((t) => t.exposure !== 'hidden');
        const wanted = name && offered.find((t) => t.name === mcpToolName(server, name));
        if (!offered.length) report(`${tool}: "${server}" has not connected or offers no tools; /mcp shows why`);
        else if (name && !wanted) report(`${tool}: "${server}" does not offer "${name}"`);
        else if (name && wanted.exposure === 'hidden') report(`${tool}: "${name}" is hidden by includeTools, excludeTools or a hide policy`);
        else if (!name && !usable.length) report(`${tool}: every tool of "${server}" is hidden by includeTools, excludeTools or a hide policy`);
        continue;
      }
      if (registered && !registered.has(tool)) report(`${tool}: no loaded extension registers this tool`);
    }
    const file = existsSync(join(root, `.pi/agents/${agent.name}.md`)) ? readFileSync(join(root, `.pi/agents/${agent.name}.md`), 'utf8') : '';
    // Files generated before v0.11 used "[a, b]" lists, which pi-subagents reads
    // as the names "[a" and "b]", so none of those tools or skills resolve.
    if (/^(tools|skills): \[/m.test(file.split('\n---')[0])) report('its agent file lists tools or skills as "[a, b]", which pi-subagents misreads (so they are missing); run /faur sync');
    if (needsBackground(tools)) {
      if (!/\nasync: true\n/.test(file) || !forced) report('uses MCP or extension tools but is not set to run in the background, so they would be missing; run /faur sync');
    }
    for (const name of Array.isArray(agent.skills) ? agent.skills : []) {
      const kind = skillSourceKind(skills.get(name)?.source);
      const dir = kind === 'registry' ? `.agents/skills/${name}` : kind === 'package' ? null : `.pi/skills/${name}`;
      if (dir && !existsSync(join(root, dir, 'SKILL.md'))) report(`skill "${name}" is not installed at ${dir}/`);
    }
  }
  for (const issue of backgroundAskingIssues(model)) {
    problems.push({ agent: issue.agent, problem: `${issue.message}${issue.fix ? ` Ask /faur to apply the suggested fix: tools ${JSON.stringify(issue.fix.value.tools)}.` : ''}` });
  }
  return { ok: problems.length === 0, problems };
}
