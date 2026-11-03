/**
 * cli-tools — command-line tools declared in system.yaml (`integrations.cli`).
 *
 * Each entry is a fixed command shape. The agent supplies only the values of
 * its `{placeholders}`; the command runs directly (no shell), so a value can't
 * add commands, pipes or redirections. `{name:file}` writes the value to a
 * temporary file and passes its path (for options like `--body-file`).
 * Agents reach an entry through `cli:<name>` in their tools; pi-commands
 * registers it in Pi as `cli_<name>` from the generated .pi/commands.json and
 * runs it. This module is design-time only: shapes, names and grants.
 */

export const PLACEHOLDER_RE = /^\{([a-z][a-z0-9_]*)(?::(file))?\}$/;
/** Arguments that look like a placeholder but aren't one ("{Title}", "--title={title}").
 * Any other braces are literal, e.g. a --jq or --template format string. */
export const isMisplacedPlaceholder = (arg) => !PLACEHOLDER_RE.test(arg) && (/^\{[^{}\s]*\}$/.test(arg) || /=\{[a-z][a-z0-9_]*(?::file)?\}$/.test(arg));

/** The Pi tool name for a declared command. */
export const cliToolName = (name) => `cli_${String(name).replace(/-/g, '_')}`;
/** The declared command a `cli:<name>` tool reference points at, or null. */
export const cliRef = (tool) => (typeof tool === 'string' && tool.startsWith('cli:') ? tool.slice(4) : null);

export function cliEntries(model) {
  const list = model?.integrations?.cli;
  return Array.isArray(list) ? list : [];
}

/** Placeholders in order of first use: [{ name, file }]. */
export function placeholders(args) {
  const seen = new Map();
  for (const arg of Array.isArray(args) ? args : []) {
    const match = typeof arg === 'string' ? arg.match(PLACEHOLDER_RE) : null;
    if (match && !seen.has(match[1])) seen.set(match[1], { name: match[1], file: match[2] === 'file' });
  }
  return [...seen.values()];
}

/** Canonical shape preserves repeated placeholder identity and file semantics. */
export function commandShape(entry) {
  const names = new Map();
  return JSON.stringify([entry.command, ...(entry.args ?? []).map(arg => {
    const m = typeof arg === 'string' && arg.match(PLACEHOLDER_RE);
    if (!m) return ['literal', arg];
    if (!names.has(m[1])) names.set(m[1], names.size);
    return ['placeholder', names.get(m[1]), Boolean(m[2])];
  })]);
}

export function readerFileWarning(entry) {
  const program = String(entry.command ?? '').split('/').pop();
  const params = placeholders(entry.args);
  if (['cat', 'head', 'less', 'sed', 'awk'].includes(program) && params.length === 1 && params[0].file)
    return `Warning: {${params[0].name}:file} is your text written to a temporary file, not a path to an existing file. Use {${params[0].name}} to supply a path.`;
  return '';
}

/** Agents that may run a declared command: names whose tools list `cli:<name>`. */
export function cliAgents(model, name, enforcedTools) {
  const out = [];
  const orchestrator = model?.orchestrator;
  if (orchestrator && (!Array.isArray(orchestrator.tools) || orchestrator.tools.includes(`cli:${name}`))) out.push(orchestrator.name);
  for (const agent of Array.isArray(model?.agents) ? model.agents : []) {
    const tools = enforcedTools ? enforcedTools(agent) : agent.tools;
    if (Array.isArray(tools) && tools.includes(`cli:${name}`)) out.push(agent.name);
  }
  return out;
}

const quote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) || PLACEHOLDER_RE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** A command line for people to read and approve. */
export function formatCommand(command, argv) {
  return [command, ...argv].map(quote).join(' ');
}

/**
 * Split a command line typed by a person into words: whitespace separates,
 * single and double quotes group, backslash escapes inside double quotes and
 * bare words. Nothing is expanded or substituted.
 */
export function splitCommandLine(line) {
  const words = [];
  let word = null;
  let quoteChar = null;
  const text = String(line ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoteChar) {
      if (c === quoteChar) quoteChar = null;
      else if (c === '\\' && quoteChar === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') { quoteChar = c; word ??= ''; }
    else if (/\s/.test(c)) { if (word !== null) words.push(word); word = null; }
    else if (c === '\\' && i + 1 < text.length) word = (word ?? '') + text[++i];
    else word = (word ?? '') + c;
  }
  if (quoteChar) throw new Error('Unclosed quote in the command line');
  if (word !== null) words.push(word);
  return words;
}

/** Throws when a command shape is malformed (used for agent proposals). */
export function checkShape({ name, command, args }) {
  if (typeof name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error('name must be kebab-case, e.g. create-issue');
  if (typeof command !== 'string' || !command.trim() || /[\s\0]/.test(command)) throw new Error('command must be one program name or path, without spaces (put arguments in args)');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error('args must be an array of strings');
  const bad = args.find(isMisplacedPlaceholder);
  if (bad !== undefined) throw new Error(`"${bad}": a placeholder must be a whole argument, lowercase: "{name}" is a value you supply; "{name:file}" writes your text to a temporary file and passes its path`);
}

/**
 * Change operations that declare a command and give it to agents. An
 * orchestrator whose tools are omitted already has every command. A subagent's
 * tools list and any enforced policy rule for it (its capability ceiling) are
 * both updated, so they stay consistent.
 */
export function grantOps(model, entry, agentNames) {
  const ref = `cli:${entry.name}`;
  const value = { command: entry.command, args: entry.args, ...(entry.description ? { description: entry.description } : {}), ...(entry.approve === false ? { approve: false } : {}) };
  const ops = [{ op: 'add', target: 'cli', name: entry.name, value }];
  return [...ops, ...toolOps(model, agentNames, (tools) => (tools.includes(ref) ? tools : [...tools, ref]))];
}

/** Change operations that remove a declared command from the model and every agent. */
export function revokeOps(model, name) {
  const ref = `cli:${name}`;
  const holders = [model?.orchestrator?.name, ...(Array.isArray(model?.agents) ? model.agents.map((a) => a.name) : [])].filter(Boolean);
  return [{ op: 'remove', target: 'cli', name }, ...toolOps(model, holders, (tools) => tools.filter((t) => t !== ref))];
}

function toolOps(model, agentNames, edit) {
  const ops = [];
  const names = new Set(agentNames);
  const orchestrator = model?.orchestrator;
  if (orchestrator && names.has(orchestrator.name) && Array.isArray(orchestrator.tools)) {
    const tools = edit(orchestrator.tools);
    if (tools !== orchestrator.tools && JSON.stringify(tools) !== JSON.stringify(orchestrator.tools)) ops.push({ op: 'set', target: 'orchestrator', value: { ...orchestrator, tools } });
  }
  const enforced = Array.isArray(model?.policies?.enforced) ? model.policies.enforced : [];
  let policiesChanged = false;
  const rules = enforced.map((rule) => {
    if (rule && names.has(rule.agent) && Array.isArray(rule.tools)) {
      const tools = edit(rule.tools);
      if (JSON.stringify(tools) !== JSON.stringify(rule.tools)) { policiesChanged = true; return { ...rule, tools }; }
    }
    return rule;
  });
  if (policiesChanged) ops.push({ op: 'set', target: 'policies', value: { ...model.policies, enforced: rules } });
  // A subagent with no tools list has no tools at all, so a grant starts one.
  for (const agent of Array.isArray(model?.agents) ? model.agents : []) {
    if (!names.has(agent.name)) continue;
    const before = Array.isArray(agent.tools) ? agent.tools : [];
    const tools = edit(before);
    if (!Array.isArray(agent.tools) && tools.length === 0) continue;
    if (JSON.stringify(tools) !== JSON.stringify(agent.tools)) ops.push({ op: 'update', target: 'agent', name: agent.name, value: { tools } });
  }
  return ops;
}
