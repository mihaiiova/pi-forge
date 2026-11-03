/**
 * Command permissions at runtime: declared command tools, the orchestrator's
 * request_permission tool, and the handler for /faur permissions.
 *
 * Declared commands (integrations.cli) register when the extension loads. In
 * the orchestrator process only the ones it may run are registered (all of
 * them when its tools are omitted); in a subagent process every one is
 * registered and the agent's own tool allowlist keeps the rest out. A command
 * with approve (the default) asks the user before each run; without a UI
 * (headless, or a background subagent) it fails closed. Anything else runs
 * only through request_permission: the user allows it once, saves it as a
 * declared command through the normal preview, or denies it. Changes to
 * system.yaml always go through planChange/applyChange and a confirmation.
 */
import { parsedModel } from './changes.mjs';
import { readText } from './maintenance-store.mjs';
import { planChange, applyChange } from './maintenance.mjs';
import {
  cliEntries, cliToolName, cliAgents, placeholders, describeCall, checkShape, buildArgv,
  formatCommand, runCommand, splitCommandLine, grantOps, revokeOps, readRequests, writeRequests, commandShape, readerFileWarning,
} from './cli-tools.mjs';
import { enforcedAgentTools } from './policy.mjs';

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], details: undefined, ...(isError ? { isError: true } : {}) });
const shape = (entry) => formatCommand(entry.command, entry.args ?? []);

function loadModel(root) {
  try { return parsedModel(readText(root, '.pi/system.yaml')); } catch { return null; }
}

/** Throws unless the values fit the command shape. */
const checkValues = (args, values) => buildArgv(args, values, null);

/** Preview a system.yaml change, ask, and apply it. Returns a message, or null when declined. */
async function confirmChange(root, ctx, title, ops) {
  const plan = planChange(root, ops);
  const stale = plan.preview.staleMentions?.mentions ?? [];
  const warning = stale.length ? `\n\nStill mentioned after this change (edit with /faur):\n${stale.map((m) => `- ${m.removed} in ${m.where}: ${m.lines[0]}${m.lines.length > 1 || m.more ? ` (+${m.lines.length - 1 + (m.more ?? 0)} more lines)` : ''}`).join('\n')}` : '';
  const summary = `${plan.preview.modelDiff}\n\nFiles: ${plan.preview.files.map((f) => `${f.action} ${f.path}`).join(', ') || 'none'}${warning}`;
  if (!await ctx.ui.confirm(title, summary)) return null;
  return applyChange(root, plan, true);
}

/** `runtime: false` returns only the /faur permissions handler: the design
 * declares no commands, so no command tools or request_permission load. */
export function registerPermissions(pi, Type, root, { runtime = true } = {}) {
  const child = process.env.PI_SUBAGENT_CHILD === '1';
  const model = loadModel(root);
  const allowedForSession = new Set();
  pi.on('session_start', () => allowedForSession.clear());

  const mayRun = (entry) => child || cliAgents(model, entry.name).includes(model.orchestrator?.name);
  for (const entry of runtime && model ? cliEntries(model).filter(mayRun) : []) {
    const params = placeholders(entry.args);
    pi.registerTool({
      name: cliToolName(entry.name),
      label: `Command: ${entry.name}`,
      description: `${entry.description ? `${entry.description}. ` : ''}Runs exactly: ${shape(entry)} (no shell; you supply only the {placeholders}).${entry.approve === false ? '' : ' The user approves each run.'}`,
      promptSnippet: entry.description ?? `Run ${shape(entry)}`,
      parameters: Type.Object(Object.fromEntries(params.map((p) => [p.name, Type.String({
        description: p.file ? `{${p.name}:file}: the text is written to a temporary file and its path is passed` : `{${p.name}}: one argument; may not start with "-"`,
      })]))),
      async execute(_id, values, signal, _onUpdate, ctx) {
        try { checkValues(entry.args, values); } catch (error) { return text(error.message, true); }
        if (entry.approve !== false && !allowedForSession.has(entry.name)) {
          if (!ctx?.hasUI) {
            return text(`${entry.name} needs the user's approval for each run, which this session can't ask for${child ? '. Report back what you need run, so the orchestrator can run it' : '. Run it from an interactive session'}.`, true);
          }
          const choice = await ctx.ui.select(`Run this command?\n\n${describeCall(entry, values)}`, ['Allow once', `Allow ${entry.name} for this session`, 'Deny']);
          if (!choice || choice === 'Deny') return text('The user denied this run.', true);
          if (choice !== 'Allow once') allowedForSession.add(entry.name);
        }
        const result = await runCommand(root, entry, values, { signal });
        return text(result.text, !result.ok);
      },
    });
  }

  if (child) return;
  if (runtime) pi.registerTool({
    name: 'request_permission',
    label: 'Request permission',
    description: 'Ask the user to let you run a command you have no tool for. Propose a reusable shape: fixed words in args, and "{name}" for a value you supply (including an existing path), or "{name:file}" to write your text to a temporary file and pass its path for the parts that change, with their values for this call. The user can allow it once, save it as a permanent command tool, or deny it. Runs without a shell.',
    promptSnippet: 'Ask the user to allow a command you have no tool for',
    promptGuidelines: ['When you are blocked because you have no tool for a command-line task, use request_permission with the narrowest command shape that does the job, and say why. Never work around a missing permission another way.'],
    parameters: Type.Object({
      name: Type.String({ description: 'kebab-case name for the command if saved, e.g. create-issue' }),
      command: Type.String({ description: 'the program, e.g. gh' }),
      args: Type.Array(Type.String(), { description: 'arguments; "{name}" is a value you supply (e.g. an existing path); "{name:file}" writes your supplied text to a temporary file and passes that path' }),
      values: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'values for the placeholders in this call' })),
      reason: Type.String({ description: 'why you need it, in one sentence' }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const entry = { name: params.name, command: params.command, args: params.args, description: params.reason };
      try { checkShape(entry); } catch (error) { return text(error.message, true); }
      const current = loadModel(root);
      if (!current) return text('.pi/system.yaml is invalid; nothing ran.', true);
      const equivalents = cliEntries(current).filter((c) => commandShape(c) === commandShape(entry));
      const declared = equivalents.find(c => cliAgents(current, c.name).includes(current.orchestrator?.name) && model && cliEntries(model).some(m => m.name === c.name && commandShape(m) === commandShape(c)) && cliAgents(model, c.name).includes(model.orchestrator?.name)) ?? equivalents.find(c => cliAgents(current, c.name).includes(current.orchestrator?.name)) ?? equivalents[0];
      if (declared) {
        const permitted = cliAgents(current, declared.name).includes(current.orchestrator?.name);
        const loaded = model && cliEntries(model).some(c => c.name === declared.name && commandShape(c) === commandShape(declared)) && cliAgents(model, declared.name).includes(model.orchestrator?.name);
        return text(`This command is already declared as ${cliToolName(declared.name)}${!permitted ? ', but not for you; ask the user to grant access with /faur permissions' : loaded ? '; call that tool' : '; it will be available after /reload'}.`, true);
      }
      const warning = readerFileWarning(entry);
      try { checkValues(entry.args, params.values); } catch (error) { return text(`${error.message}${warning ? `\n${warning}` : ''}`, true); }
      if (!ctx?.hasUI) {
        const requests = readRequests(root).filter((r) => !(r.command === entry.command && JSON.stringify(r.args) === JSON.stringify(entry.args)));
        writeRequests(root, [...requests, { name: entry.name, command: entry.command, args: entry.args, reason: params.reason, requestedAt: new Date().toISOString() }]);
        return text(`Saved as a pending request; nothing ran. Tell the user what is blocked. They can approve it with /faur permissions review.${warning ? `\n${warning}` : ''}`, true);
      }
      const choice = await ctx.ui.select(`${warning ? `${warning}\n\n` : ''}The agent asks to run a command:\n\n${describeCall(entry, params.values)}\n\nWhy: ${params.reason}\nAs a saved command: ${shape(entry)}`, ['Allow once', `Always allow (save "${entry.name}" to system.yaml)`, 'Deny']);
      if (!choice || choice === 'Deny') return text(`The user denied this command. Do not try to run it another way.${warning ? `\n${warning}` : ''}`, true);
      let saved = '';
      if (choice !== 'Allow once') {
        try {
          const applied = await confirmChange(root, ctx, `Save the command "${entry.name}" for ${current.orchestrator.name}?`, grantOps(current, { ...entry, approve: true }, [current.orchestrator.name]));
          saved = applied === null ? '\nNot saved (declined); it ran once.' : `\nSaved as ${cliToolName(entry.name)}. ${applied}`;
        } catch (error) { saved = `\nNot saved: ${error.message}. It ran once.`; }
      }
      const result = await runCommand(root, entry, params.values ?? {}, { signal });
      return text(result.text + saved + (warning ? `\n${warning}` : ''), !result.ok);
    },
  });

  /** /faur permissions: list | add | remove <name> | review */
  return async (args, ctx) => {
    const tell = (message, level = 'info') => (ctx.hasUI ? ctx.ui.notify(message, level) : process.stderr.write(`Forge (${level}): ${message}\n`));
    try {
      const [action = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const current = parsedModel(readText(root, '.pi/system.yaml'));
      if (action === 'list') {
        const enforced = (agent) => enforcedAgentTools(agent.name, current.policies, agent.tools);
        const lines = cliEntries(current).map((c) => `${c.name}: ${shape(c)}\n  agents: ${cliAgents(current, c.name, enforced).join(', ') || 'none'}; ${c.approve === false ? 'runs without asking' : 'asks before each run'}`);
        const pending = readRequests(root).length;
        tell(`${lines.join('\n') || 'No commands declared.'}${pending ? `\n\n${pending} pending request(s): /faur permissions review` : ''}\n\nadd | remove <name> | review`);
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
          const route = await ctx.ui.select(`${subagents.join(', ')} run in the background, where nobody can answer the approval prompt, so every run would be refused.`, [lead, 'Run without asking', 'Cancel']);
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
      if (action === 'review') {
        const requests = readRequests(root);
        if (!requests.length) return tell('No pending requests.');
        const left = [];
        let seen = 0;
        try {
          for (const request of requests) {
            const choice = await ctx.ui.select(`Pending request (${request.requestedAt}):\n\n${shape(request)}\n\nWhy: ${request.reason}`, [`Save as "${request.name}" for ${current.orchestrator.name}`, 'Discard', 'Keep for later', 'Stop reviewing']);
            if (!choice || choice === 'Stop reviewing') break;
            seen++;
            if (choice.startsWith('Save')) {
              try {
                const model = parsedModel(readText(root, '.pi/system.yaml'));
                const applied = await confirmChange(root, ctx, `Save the command "${request.name}"?`, grantOps(model, { ...request, description: request.reason, approve: true }, [model.orchestrator.name]));
                if (applied === null) left.push(request); else tell(applied);
              } catch (error) { left.push(request); tell(`${request.name}: ${error.message}; kept for later`, 'error'); }
            } else if (choice !== 'Discard') left.push(request);
          }
        } finally { writeRequests(root, [...left, ...requests.slice(seen)]); }
        return tell(`${seen - left.length} handled, ${requests.length - seen + left.length} pending.`);
      }
      throw new Error('Use: /faur permissions [list | add | remove <name> | review]');
    } catch (error) { tell(error.message, 'error'); }
  };
}
