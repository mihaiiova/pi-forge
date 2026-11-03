import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parsedModel } from './changes.mjs';
import { atomicWrite, json, readText, readJson } from './maintenance-store.mjs';
import { loadYaml } from './yaml-loader.mjs';
import { validateSystem } from './validate.mjs';
import { checkCapabilities } from './capabilities.mjs';
import { launchCheck } from './launch-check.mjs';
import { unmetSetup } from './setup.mjs';
import { integrationSecrets, secretFileProblem } from './integration-secrets.mjs';
import { configurationAdvisories } from './advisories.mjs';
import { cliEntries } from './cli-tools.mjs';
import { probeClis } from './discover.mjs';
import { skillSourceKind } from './skill-sources.mjs';
import { enforcedAgentTools } from './policy.mjs';
import { mcpToolName } from './mcp-gen.mjs';
import { leadTools } from './asking.mjs';
import { envNames, needsIsolation } from './runtime.mjs';
import { REPLACES_BUILTIN } from './deps.mjs';
import { homedir } from 'node:os';

const BUILTIN = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

/** The package name of a settings `packages` entry (`npm:name@1.2.3`, a git
 * source or an object form), for matching known conflicts. */
function packageName(entry) {
  const source = typeof entry === 'string' ? entry : entry?.source;
  if (typeof source !== 'string') return null;
  if (source.startsWith('npm:')) { const rest = source.slice(4); const at = rest.lastIndexOf('@'); return at > 0 ? rest.slice(0, at) : rest; }
  return source.split('/').pop().replace(/@.*$/, '');
}

/**
 * User-level Pi configuration that would replace what a design relies on when
 * it is started with plain `pi` (stage 0, #60). `agentDir` is the Pi
 * configuration in effect; inside the project's own `run` home nothing applies.
 * `mcpCommand` is the source of the session's `/mcp` command when known.
 */
export function hostConflicts(root, model, { agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), mcpCommand } = {}) {
  if (!needsIsolation(model)) return [];
  const own = join(root, '.forge/pi-home');
  try { if (realpathSync(agentDir) === realpathSync(own)) return []; } catch { /* the isolated home does not exist yet */ }
  const out = [];
  let packages = [];
  try { packages = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).packages ?? []; } catch { /* no user settings */ }
  for (const entry of packages) {
    const name = packageName(entry);
    if (REPLACES_BUILTIN[name]) out.push(`plain pi: ${name} in ${join(agentDir, 'settings.json')} replaces ${REPLACES_BUILTIN[name]}, so this project's MCP tool hiding, approvals and tool names do not apply; start it with ./run`);
  }
  if (!out.length && mcpCommand && mcpCommand !== 'builtin') out.push(`plain pi: /mcp comes from ${mcpCommand}, which replaces Pi's built-in MCP, so this project's MCP tool hiding, approvals and tool names do not apply; start it with ./run`);
  return out;
}

/** Check model validity, generated configuration and launch prerequisites. */
export function checkProject(root, { registeredTools, mcpTools, env = process.env, hostAgentDir, mcpCommand } = {}) {
  const doc = loadYaml().parse(readText(root, '.pi/system.yaml') ?? '');
  const validation = validateSystem(doc).errors;
  if (validation.length) return { ok: false, validation, consistency: null, launch: null, advisories: [] };
  const piPackages = readJson(root, '.pi/settings.json').packages ?? [];
  const consistency = checkCapabilities(doc, { settings: readJson(root, '.pi/settings.json'), mcpJson: readText(root, '.pi/mcp.json') === null ? {} : readJson(root, '.pi/mcp.json') }, { piPackages }).errors;
  const launch = launchCheck(root, doc, { registeredTools, mcpTools }).problems.map(p => `${p.agent}: ${p.problem}`);
  for (const step of unmetSetup(root, doc)) launch.push(`${step.owner}: setup ${step.description}; fix: ${step.install}${step.needsRoot ? ' (run manually; needs root)' : ''}`);
  for (const path of new Set(integrationSecrets(doc))) {
    const problem = secretFileProblem(root, path);
    if (problem) launch.push(`Integration secretsFile ${path}: ${problem}`);
  }
  // Pi reads no .env: declared names come from the environment Pi starts in.
  for (const name of envNames(doc)) {
    if (!env[name]) launch.push(`integrations.env ${name}: not set in this environment; export it, or load .env with direnv, before starting the agent`);
  }
  launch.push(...hostConflicts(root, doc, { ...(hostAgentDir ? { agentDir: hostAgentDir } : {}), mcpCommand }));
  return { ok: !consistency.length && !launch.length, validation, consistency, launch, advisories: configurationAdvisories(doc) };
}

/**
 * Pi's shell commands read project MCP servers only for a saved trust
 * decision, and ./run trusts the project per run without saving one. Save it
 * in the project's own isolated Pi home, which ./run already trusts on every
 * start; the user's personal Pi home is never touched.
 */
function saveProjectTrust(root) {
  const home = join(root, '.forge/pi-home');
  const file = join(home, 'trust.json');
  let decisions = {};
  try { decisions = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none saved yet */ }
  const path = realpathSync(root);
  if (decisions[path] === true) return null;
  atomicWrite(root, '.forge/pi-home/trust.json', json({ ...decisions, [path]: true }));
  return file;
}

/** Explicit opt-in: Pi connects MCP servers using this project's isolated home. */
export function connectMcp(root) {
  const trustSaved = saveProjectTrust(root);
  const result = spawnSync('pi', ['mcp', 'list', '--json'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, '.forge/pi-home') }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  let output;
  try { output = JSON.parse(result.stdout); } catch { output = null; }
  // Pi explains in `note` why it read no servers; keep it rather than report nothing.
  const diagnostic = [result.error?.message, result.stderr?.trim(), output?.note].filter(Boolean).join('\n').slice(-2000);
  const saved = trustSaved ? { trustSaved } : {};
  if (!Array.isArray(output?.servers)) return { error: diagnostic || 'Could not read pi mcp list output.', ...saved };
  return { servers: output.servers.map(s => ({ name: s.name, state: s.state, tools: s.tools ?? [], ...(s.error || (s.state !== 'connected' && diagnostic) ? { error: [s.error, diagnostic].filter(Boolean).join('\n').slice(-2000) } : {}) })), ...(diagnostic ? { diagnostic } : {}), ...saved };
}

/** Check declarations without making a model call. */
export function checkAgent(root, options = {}) {
  const checked = options.toolCheck;
  const registeredTools = options.registeredTools ?? (checked && !checked.error && !checked.missing.length ? Object.keys(checked.providers) : undefined);
  const checks = checkProject(root, { ...options, registeredTools });
  if (checks.validation.length) {
    const result = { timestamp: new Date().toISOString(), ok: false, capabilities: [], checks };
    atomicWrite(root, '.forge/check.json', json(result));
    return result;
  }
  const model = parsedModel(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  let previous;
  try { previous = JSON.parse(readFileSync(join(root, '.forge/check.json'), 'utf8')); } catch { /* no previous check */ }
  const timestamp = new Date().toISOString();
  const declaredServers = model.integrations?.mcp ?? [];
  let mcpEvidence = options.mcpServers;
  if (!mcpEvidence && Array.isArray(options.mcpTools)) {
    mcpEvidence = declaredServers.map(({ name }) => {
      const offered = options.mcpTools.filter(t => t.name.startsWith(mcpToolName(name, '')));
      return { name, state: offered.length ? 'connected' : 'unknown', tools: offered.filter(t => t.exposure !== 'hidden').map(t => t.name.slice(mcpToolName(name, '').length)) };
    });
  }
  const liveMcp = Array.isArray(mcpEvidence);
  if (!liveMcp) mcpEvidence = previous?.mcpEvidence?.servers ?? [];
  const mcpTimestamp = liveMcp ? timestamp : previous?.mcpEvidence?.timestamp;
  const capabilities = [];
  const commands = new Map(cliEntries(model).map(c => [c.name, c]));
  const skills = new Map((model.skills ?? []).map(s => [s.name, s]));
  for (const agent of [model.orchestrator, ...(model.agents ?? [])]) {
    const tools = agent === model.orchestrator ? (agent.tools ?? cliEntries(model).map(c => `cli:${c.name}`)) : enforcedAgentTools(agent.name, model.policies, agent.tools);
    for (const name of tools ?? []) {
      if (name.startsWith('mcp:')) {
        const [server, tool] = name.slice(4).split('/');
        const state = mcpEvidence.find(s => s.name === server);
        const present = state?.state === 'connected' && (!tool || state.tools?.includes(tool));
        const status = present ? (liveMcp ? 'verified now' : `last seen ${mcpTimestamp}`) : state && state.state !== 'unknown' ? 'missing' : 'not verifiable';
        capabilities.push({ agent: agent.name, name, provider: `MCP ${server}`, status, fix: present ? 'None.' : `Check ${server} with /mcp or rerun check-agent --connect.${state?.error ? ` ${state.error}` : ''}` });
      } else if (name.startsWith('cli:')) {
        const command = commands.get(name.slice(4))?.command;
        const present = command && (command.includes('/') ? existsSync(resolve(root, command)) : probeClis([command])[command]);
        capabilities.push({ agent: agent.name, name, provider: `CLI ${command ?? name.slice(4)}`, status: present ? 'verified now' : 'missing', fix: `${present ? 'Presence only' : 'Install the command or add it to PATH'}; authentication is not checked.` });
      } else if (BUILTIN.has(name)) capabilities.push({ agent: agent.name, name, provider: 'built-in', status: 'verified now', fix: 'None.' });
      else if (!name.startsWith('mcp:') && !name.startsWith('cli:') && name !== 'mcp') {
        const provider = checked?.providers[name] ?? options.toolProviders?.[name];
        const present = provider || options.registeredTools?.includes(name);
        const known = registeredTools !== undefined;
        capabilities.push({ agent: agent.name, name, provider: provider || 'extension', status: present ? 'verified now' : known ? 'missing' : 'not verifiable', fix: present ? 'None.' : checked?.missing?.length ? 'Run ./run once to install the project\'s packages, then check again.' : known ? 'Install or enable the providing extension and restart ./run if packages are not installed.' : 'Install or enable the providing extension; use /faur check to verify the live session.' });
      }
    }
    for (const name of agent === model.orchestrator ? [...skills.keys()] : (agent.skills ?? [])) {
      const kind = skillSourceKind(skills.get(name)?.source);
      const dir = kind === 'registry' ? `.agents/skills/${name}` : kind === 'package' ? null : `.pi/skills/${name}`;
      const present = dir && existsSync(join(root, dir, 'SKILL.md'));
      capabilities.push({ agent: agent.name, name: `skill:${name}`, provider: dir ?? 'Pi package', status: dir ? (present ? 'verified now' : 'missing') : 'not verifiable', fix: present ? 'None.' : 'Install the skill or verify its Pi package in a session.' });
    }
  }
  for (const { name, command } of commands.values()) {
    if (capabilities.some(c => c.name === `cli:${name}`)) continue;
    const present = command.includes('/') ? existsSync(resolve(root, command)) : probeClis([command])[command];
    capabilities.push({ agent: 'project', name: `cli:${name}`, provider: `CLI ${command}`, status: present ? 'verified now' : 'missing', fix: `${present ? 'Presence only' : 'Install the command or add it to PATH'}; authentication is not checked.` });
  }
  // Servers belong to the orchestrator only when it may use them.
  const owner = leadTools(model).includes('mcp') ? model.orchestrator.name : 'project';
  for (const { name } of declaredServers) {
    const state = mcpEvidence.find(s => s.name === name);
    const status = state?.state === 'connected' ? (liveMcp ? 'verified now' : `last seen ${mcpTimestamp}`) : state && state.state !== 'unknown' ? 'missing' : 'not verifiable';
    capabilities.push({ agent: owner, name: `mcp:${name}`, provider: `MCP ${name}`, status, fix: status === 'missing' ? `Check /mcp.${state?.error ? ` ${state.error}` : ''}` : status === 'not verifiable' ? 'Connect with check-agent --connect or check in a running session.' : 'None.' });
  }
  let build = null;
  try { build = JSON.parse(readFileSync(join(root, '.forge/build.json'), 'utf8')).version ?? null; } catch { /* no build record */ }
  const tooling = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const versions = { build, tooling, ...(build !== tooling ? { fix: 'Run /faur sync to rebuild with the installed tooling.' } : {}) };
  const result = { timestamp, versions, ok: checks.ok && !capabilities.some(c => c.status === 'missing'), capabilities, checks, ...(mcpTimestamp ? { mcpEvidence: { timestamp: mcpTimestamp, servers: mcpEvidence } } : {}), ...(checked?.error ? { extensionDiagnostic: checked.error } : {}), ...(checked?.missing.length ? { unresolvedPackages: checked.missing } : {}) };
  atomicWrite(root, '.forge/check.json', json(result));
  return result;
}

/**
 * Whether Pi would auto-load extension code from `dir`: a script file, or a
 * folder with an index script or package.json. Configuration Forge writes
 * there for pi-subagents (`subagent/config.json`) is not code.
 */
function hasExtensionCode(dir) {
  const code = /\.(ts|js|mjs|cjs)$/;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return entries.some(e => (e.isFile() && code.test(e.name))
    || (e.isDirectory() && readdirSync(join(dir, e.name)).some(f => f === 'package.json' || /^index\.(ts|js|mjs|cjs)$/.test(f))));
}

/** Use Pi's non-installing package resolver; never load ambiguous autodiscovery. */
export async function loadProjectTools(root) {
  const { existsSync, readdirSync, realpathSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  try {
    let sdk;
    try { sdk = await import('@earendil-works/pi-coding-agent'); }
    catch {
      const executable = (process.env.PATH ?? '').split(':').map(p => join(p, 'pi')).find(p => existsSync(p));
      if (!executable) throw new Error('Pi is not installed on PATH');
      let dir = dirname(realpathSync(executable));
      while (dirname(dir) !== dir && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name !== '@earendil-works/pi-coding-agent' || !pkg.main) throw new Error('Cannot locate the Pi SDK');
      sdk = await import(pathToFileURL(resolve(dir, pkg.main)).href);
    }
    const agentDir = join(root, '.forge/pi-home');
    // The SDK's public discoverAndLoadExtensions also auto-loads these paths,
    // bypassing resolver filters. Refuse ambiguity rather than execute disabled code.
    for (const dir of [join(root, '.pi/extensions'), join(agentDir, 'extensions')]) {
      if (hasExtensionCode(dir)) throw new Error(`Cannot safely verify extension autoload at ${dir}; use /faur check in a running session`);
    }
    const settings = sdk.SettingsManager.create(root, agentDir);
    settings.setProjectTrusted(true);
    await settings.reload();
    const manager = new sdk.DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
    const missing = [];
    const resolved = await manager.resolve(async source => { missing.push(source); return 'skip'; });
    const paths = resolved.extensions.filter(e => e.enabled && !e.path.startsWith('builtin:')).map(e => e.path);
    const loaded = await sdk.discoverAndLoadExtensions(paths, root, agentDir);
    if (loaded.errors.length) throw new Error(loaded.errors.map(e => `${e.path}: ${e.error}`).join('; '));
    return { providers: Object.fromEntries(loaded.extensions.flatMap(e => [...e.tools.keys()].map(name => [name, e.path]))), missing };
  } catch (error) { return { providers: {}, missing: [], error: error.message }; }
}
