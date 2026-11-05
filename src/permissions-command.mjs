/**
 * /faur permissions: list the declared commands, and add or remove one. Each
 * is a design change to system.yaml, previewed and confirmed through the same
 * plan/apply path as every other change. The commands themselves run in the
 * project through pi-commands, configured by the generated .pi/commands.json;
 * nothing here runs at agent run time.
 */
import { parsedModel } from './changes.mjs';
import { readText } from './maintenance-store.mjs';
import { planChange, applyChange, approvalPreview } from './maintenance.mjs';
import { cliEntries, cliAgents, checkShape, formatCommand, splitCommandLine, grantOps, revokeOps, commandShape, readerFileWarning } from './cli-tools.mjs';
import { enforcedAgentTools } from './policy.mjs';
import { confirmPreview } from './preview-dialog.mjs';

const shape = (entry) => formatCommand(entry.command, entry.args ?? []);

/** Preview a system.yaml change, ask, and apply it. Returns a message, or null when declined. */
async function confirmChange(root, ctx, title, ops) {
  const plan = planChange(root, ops);
  const summary = approvalPreview(root, plan);
  if (!await confirmPreview(ctx, title, summary)) return null;
  return applyChange(root, plan, true);
}

/** The /faur permissions handler for the project at `root`. */
export function permissionsCommand(root) {
  return async (args, ctx) => {
    const tell = (message, level = 'info') => (ctx.hasUI ? ctx.ui.notify(message, level) : process.stderr.write(`Faur (${level}): ${message}\n`));
    try {
      const [action = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const current = parsedModel(readText(root, '.pi/system.yaml'));
      if (action === 'list') {
        const enforced = (agent) => enforcedAgentTools(agent.name, current.policies, agent.tools);
        const lines = cliEntries(current).map((c) => `${c.name}: ${shape(c)}\n  agents: ${cliAgents(current, c.name, enforced).join(', ') || 'none'}; ${c.approve === false ? 'runs without asking' : 'asks before each run'}`);
        tell(`${lines.join('\n') || 'No commands declared.'}\n\nadd | remove <name>`);
        return;
      }
      if (!ctx.hasUI) throw new Error('Interactive input is required');
      await ctx.waitForIdle();
      if (action === 'add') {
        const name = (await ctx.ui.input('Name for the command (kebab-case)', 'create-issue'))?.trim();
        if (!name) return tell('Cancelled.');
        const line = await ctx.ui.input('Command line. Use {name} for a value the agent fills in, {name:file} for long text passed as a file', 'gh issue create --repo owner/repo --title {title} --body-file {body:file}');
        if (!line?.trim()) return tell('Cancelled.');
        const [command, ...cmdArgs] = splitCommandLine(line);
        const names = [current.orchestrator.name, ...(current.agents ?? []).map((a) => a.name)];
        const who = await ctx.ui.input(`Agents that may run it, comma-separated (${names.join(', ')})`, current.orchestrator.name);
        if (!who?.trim()) return tell('Cancelled.');
        const agents = who.split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = agents.filter((a) => !names.includes(a));
        if (unknown.length) throw new Error(`Unknown agent(s): ${unknown.join(', ')}`);
        const ask = await ctx.ui.select('Approval', ['Ask before every run (recommended)', 'Run without asking']);
        if (!ask) return tell('Cancelled.');
        const subagents = agents.filter((a) => a !== current.orchestrator.name);
        let approve = ask.startsWith('Ask');
        if (approve && subagents.length) {
          // A command that asks can't run in a background subagent; the orchestrator runs it for them.
          const lead = `Only ${current.orchestrator.name}, which runs it when a subagent asks`;
          const route = await ctx.ui.select(`${subagents.join(', ')} may run in the background, where nobody can answer the approval prompt, so background calls would be refused.`, [lead, 'Run without asking', 'Cancel']);
          if (!route || route === 'Cancel') return tell('Cancelled.');
          if (route === lead) agents.splice(0, agents.length, current.orchestrator.name);
          else approve = false;
        }
        const entry = { name, command, args: cmdArgs, approve };
        checkShape(entry);
        const duplicate = cliEntries(current).find(c => commandShape(c) === commandShape(entry));
        if (duplicate) throw new Error(`Equivalent command already declared as ${duplicate.name}; use it or grant access instead`);
        const warning = readerFileWarning(entry);
        if (warning) tell(warning, 'warning');
        const applied = await confirmChange(root, ctx, `Add the command "${name}"?`, grantOps(current, entry, agents));
        return tell(applied === null ? 'Cancelled; nothing changed.' : applied);
      }
      if (action === 'remove') {
        const name = rest[0];
        if (!name || !cliEntries(current).some((c) => c.name === name)) throw new Error(`No declared command "${name ?? ''}"`);
        const applied = await confirmChange(root, ctx, `Remove the command "${name}" from every agent?`, revokeOps(current, name));
        return tell(applied === null ? 'Cancelled; nothing changed.' : applied);
      }
      throw new Error('Use: /faur permissions [list | add | remove <name>]');
    } catch (error) { tell(error.message, 'error'); }
  };
}
