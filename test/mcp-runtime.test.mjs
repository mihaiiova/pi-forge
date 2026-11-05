import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
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
  const root = mkdtempSync(join(tmpdir(), 'faur-mcp-'));
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
        args: ["-e", ${JSON.stringify(`process.env.MCP_LOG=${JSON.stringify(log)}; import(${JSON.stringify(pathToFileURL(server).href)})`)}]
        includeTools: [get_report, run_audit]
`);
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const agentDir = join(root, '.faur/pi-home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), '{}');
  // Built-in MCP alone: no Faur and no other package loads here.
  const settings = JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8'));
  writeFileSync(join(root, '.pi/settings.json'), JSON.stringify({ ...settings, packages: [] }));
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

test('session-registered MCP preserves naming and exposure without a project MCP file', async t => {
  const { root, session, run, calls, results } = await open(t, { sessionRegistration: true });
  assert.equal(existsSync(join(root, '.pi/mcp.json')), false);
  assert.deepEqual(session.getActiveToolNames().filter(n => n.startsWith('mcp__')).sort(), ['mcp__seo__get_report', 'mcp__seo__run_audit']);
  // Built-in MCP calls do not ask for per-call approval.
  await run(['mcp__seo__get_report', {}], ['mcp__seo__run_audit', {}], ['mcp__seo__delete_all', {}]);
  assert.deepEqual(calls(), ['get_report', 'run_audit']);
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
