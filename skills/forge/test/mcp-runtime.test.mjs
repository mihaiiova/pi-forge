import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { registerAgent } from '../agent-extension.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const server = join(import.meta.dirname, 'fixtures/mcp/server.mjs');
const bin = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
const sdk = await import(pathToFileURL(resolve(bin, '../index.js')).href);
const start = process.cwd();
const ai = await import(pathToFileURL(resolve(bin, '../../node_modules/@earendil-works/pi-ai/dist/index.js')).href);

/**
 * A generated project whose MCP server is the stdio test server, opened in an
 * SDK session with Pi's built-in MCP and a scripted model. The server offers
 * get_report, run_audit and delete_all; the system includes the first two and
 * requires approval for run_audit.
 */
async function open(t, { answers, lead = 'read, mcp, codemode, subagent', sessionRegistration = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-mcp-'));
  const log = join(root, 'calls.log');
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), `schema: 1
name: mcp-runtime
description: Built-in MCP test
orchestrator:
  name: lead
  model: faux/faux-1
  tools: [${lead}]
  prompt: Test.
agents:
  - name: reader
    description: Reads reports
    model: faux/faux-1
    tools: [read, mcp:seo/get_report]
    prompt: Read reports.
integrations:
  mcp:
    - name: seo
      config:
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(server)}]
        env: { MCP_LOG: ${JSON.stringify(log)} }
        includeTools: [get_report, run_audit]
        approveTools: [run_audit]
`);
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root], { stdio: 'ignore' });
  const agentDir = join(root, '.forge/pi-home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), '{}');
  // The pinned release isn't installed here; load this checkout instead.
  const settings = JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8'));
  writeFileSync(join(root, '.pi/settings.json'), JSON.stringify({ ...settings, packages: [repo] }));
  const faux = ai.createFauxCore({ api: 'faux-test', provider: 'faux', models: [{ id: 'faux-1' }] });
  const provider = pi => pi.registerProvider('faux', {
    baseUrl: 'http://localhost', apiKey: 'test', api: 'faux-test', streamSimple: faux.streamSimple,
    models: [{ type: 'chat', id: 'faux-1', name: 'faux', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const registration = [];
  if (sessionRegistration) {
    const mcpPath = join(root, '.pi/mcp.json');
    const config = JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.seo;
    rmSync(mcpPath);
    registration.push(pi => pi.registerMcpServer('seo', config));
  }
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true, extensionFactories: [provider, ...registration, sdk.createCodemodeExtension(), sdk.createToolSearchExtension(), sdk.createMcpExtension()] });
  const child = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  process.chdir(root);
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
  t.after(async () => {
    // dispose() alone leaves the stdio MCP servers running; shutting down stops them.
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    process.chdir(start);
    if (child !== undefined) process.env.PI_SUBAGENT_CHILD = child;
    rmSync(root, { recursive: true, force: true });
  });
  const dialogs = [];
  // Only a UI context lets the approval gate ask; without one the session is headless.
  const uiContext = answers && new Proxy({ confirm: async (title, body) => { dialogs.push({ title, body }); return answers.shift() ?? false; } }, { get: (target, key) => target[key] ?? (() => undefined) });
  await session.bindExtensions({ ...(uiContext ? { uiContext } : {}), onError: error => { throw new Error(JSON.stringify(error)); } });
  await session.modelRuntime.setRuntimeApiKey('faux', 'test');
  await session.setModel(session.modelRuntime.getModel('faux', 'faux-1'));
  // Servers connect in the background after session start.
  for (let i = 0; i < 50 && !session.getActiveToolNames().includes('mcp__seo__get_report'); i++) await new Promise(r => setTimeout(r, 100));
  const results = [];
  session.subscribe(e => { if (e.type === 'tool_execution_end') results.push({ tool: e.toolName, error: e.isError, text: JSON.stringify(e.result?.content ?? e.result) }); });
  const run = async (...calls) => {
    faux.setResponses([...calls.map(([name, args]) => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)])), ai.fauxAssistantMessage('done')]);
    await session.prompt('go');
  };
  return { root, session, run, results, dialogs, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

const audit = 'return await tools.mcp__seo__run_audit({})';

test('session-registered MCP preserves naming, exposure and approval without a project MCP file', async t => {
  const { root, session, run, calls, results } = await open(t, { sessionRegistration: true });
  assert.equal(existsSync(join(root, '.pi/mcp.json')), false);
  assert.deepEqual(session.getActiveToolNames().filter(n => n.startsWith('mcp__')).sort(), ['mcp__seo__get_report', 'mcp__seo__run_audit']);
  await run(['mcp__seo__get_report', {}], ['mcp__seo__run_audit', {}], ['mcp__seo__delete_all', {}]);
  assert.deepEqual(calls(), ['get_report']);
  assert.match(results.find(r => r.tool === 'mcp__seo__run_audit').text, /needs the user's approval/);
  assert.ok(results.find(r => r.tool === 'mcp__seo__delete_all').error);
  assert.equal(existsSync(join(root, '.pi/mcp.json')), false);
});

test('the orchestrator gets its MCP tools from Pi built-in MCP, and only those', async t => {
  const { root, session, run, results, calls } = await open(t);
  const mcp = JSON.parse(readFileSync(join(root, '.pi/mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.seo.exposure, 'hidden');
  const settings = JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8'));
  assert.equal(settings.extensions, undefined, 'the built-in MCP stays on');
  assert.ok(!settings.packages.some(p => p.includes('pi-mcp-adapter')));
  assert.match(readFileSync(join(root, '.pi/agents/reader.md'), 'utf8'), /^  - mcp:seo\/get_report$/m, 'the specialist selects its tool through pi-subagents');
  const active = session.getActiveToolNames().filter(n => n.startsWith('mcp__'));
  assert.deepEqual(active.sort(), ['mcp__seo__get_report', 'mcp__seo__run_audit']);
  await run(['mcp__seo__get_report', {}], ['mcp__seo__delete_all', {}], ['codemode', { code: 'return await tools.mcp__seo__delete_all({})' }]);
  assert.deepEqual(calls(), ['get_report'], 'a tool outside includeTools is unreachable, directly or from codemode');
  assert.ok(results.filter(r => r.tool !== 'mcp__seo__get_report').every(r => r.error));
});

test('approveTools asks before every call, direct or from codemode, and blocks headless runs', async t => {
  const headless = await open(t);
  await headless.run(['mcp__seo__run_audit', {}], ['codemode', { code: audit }]);
  assert.deepEqual(headless.calls(), [], 'blocked without a UI');
  assert.match(headless.results[0].text, /needs the user's approval/);

  const asked = await open(t, { answers: [true, false, true] });
  await asked.run(['mcp__seo__run_audit', {}], ['mcp__seo__run_audit', {}], ['codemode', { code: audit }]);
  assert.equal(asked.dialogs.length, 3, 'one dialog per call');
  assert.match(asked.dialogs[0].title, /seo: run_audit/);
  assert.deepEqual(asked.calls(), ['run_audit', 'run_audit'], 'approved calls run; the declined one does not');
  await asked.run(['mcp__seo__get_report', {}]);
  assert.equal(asked.dialogs.length, 3, 'tools outside approveTools never ask');
});

test('an orchestrator without mcp cannot call MCP tools, which stay registered for its specialists', async t => {
  const { session, run, results, calls } = await open(t, { lead: 'read, codemode, subagent' });
  const registered = session.getAllTools().map(tool => tool.name);
  assert.ok(registered.includes('mcp__seo__get_report'), 'pi-subagents hands specialists their selections from these');
  await run(['mcp__seo__get_report', {}], ['codemode', { code: 'return await tools.mcp__seo__get_report({})' }]);
  assert.deepEqual(session.getActiveToolNames().filter(n => n.startsWith('mcp__')), [], 'not offered to the orchestrator');
  assert.deepEqual(calls(), [], 'blocked, directly and from codemode');
  assert.ok(results.every(r => r.error));
});

test('the boundary blocks any MCP call by an orchestrator without mcp, however it is reached', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-mcp-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: gate\ndescription: Gate\norchestrator:\n  name: lead\n  model: p/m\n  tools: [read, subagent]\nintegrations:\n  mcp:\n    - name: seo\n      config: { url: "http://x" }\n');
  const handlers = {};
  let active = ['read', 'subagent', 'mcp__seo__get_report', 'list_mcp_resources'];
  const pi = { registerTool() {}, registerCommand() {}, on: (n, h) => { (handlers[n] ??= []).push(h); }, getActiveTools: () => active, setActiveTools: a => { active = a; } };
  const Type = Object.fromEntries(['Object', 'Union', 'Literal', 'Optional', 'String', 'Number', 'Array', 'Record'].map(k => [k, v => v]));
  const child = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  t.after(() => { if (child !== undefined) process.env.PI_SUBAGENT_CHILD = child; });
  registerAgent(pi, Type, root);
  for (const h of handlers.before_agent_start) h({ systemPrompt: '' });
  assert.deepEqual(active, ['read', 'subagent']);
  const call = async (toolName, extra = {}) => { for (const h of handlers.tool_call) { const r = await h({ toolName, input: {}, ...extra }, { hasUI: true }); if (r) return r; } };
  assert.match((await call('mcp__seo__get_report', { parentToolCallId: 'codemode-1' }))?.reason ?? '', /has no MCP access/);
  assert.equal((await call('list_mcp_resources'))?.block, true);
  assert.equal(await call('read'), undefined);
});

