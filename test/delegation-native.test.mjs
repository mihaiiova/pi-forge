import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { generateProject } from '../src/generate.mjs';

const asset = name => fileURLToPath(new URL(`./pi-lab/${name}`, import.meta.url));
const model = {
  schema: 1, name: 'delegation', orchestrator: { name: 'lead', model: 'fake/m', tools: ['read', 'subagent', 'mcp'] },
  agents: [{ name: 'worker', model: 'fake/m', tools: ['read', 'mcp:projsrv/projsrv_ping'], prompt: 'SPECIALIST-MARKER' }],
  integrations: { mcp: [{ name: 'projsrv', config: { command: process.execPath, args: [asset('mcp-stub.mjs'), 'projsrv'] } }] },
  workflows: [{ name: 'test', entry: 'lead' }],
};
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitForServer(port, server) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Fake model exited with code ${server.exitCode}`);
    const ready = await new Promise(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fake model did not start listening within 10 seconds');
}
const env = () => {
  const result = { ...process.env };
  delete result.PI_SUBAGENT_CHILD;
  delete result.PI_SUBAGENT_PARENT_SESSION;
  return result;
};
test('tracked generated project delegates MCP calls and enforces specialist selection in both launch modes', {
  timeout: 450000,
  skip: process.env.RUN_FAUR_DELEGATION_TEST !== '1' && 'set RUN_FAUR_DELEGATION_TEST=1 to verify real-Pi foreground and background MCP delegation (requires network)',
}, async t => {
  const base = mkdtempSync(join(tmpdir(), 'faur-delegation-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source'), root = join(base, 'clone'), home = join(base, 'home');
  mkdirSync(source);
  const generated = generateProject(model, {}, { piPackages: ['npm:pi-subagents@0.83.1'] });
  for (const f of generated.files) { mkdirSync(dirname(join(source, f.path)), { recursive: true }); writeFileSync(join(source, f.path), f.content); }
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  execFileSync('git', ['clone', '-q', source, root]);
  assert.equal(existsSync(join(root, '.faur')), false);
  mkdirSync(home);
  const port = await freePort();
  writeFileSync(join(home, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'm', name: 'fake', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000 }] } } }));
  const install = spawnSync('pi', ['update', '--extensions', '--approve'], { cwd: root, env: { ...env(), PI_CODING_AGENT_DIR: home }, input: '', encoding: 'utf8', timeout: 120000 });
  assert.equal(install.status, 0, `Cannot install pinned pi-subagents: ${install.error?.message ?? ''}\n${install.stderr}\n${install.stdout}`);
  for (const async of [false, true]) for (const tool of ['projsrv_ping', 'projsrv_secret']) {
    const log = join(base, `${async}-${tool}.jsonl`);
    const vars = { ...env(), PI_CODING_AGENT_DIR: home, FAKE_PORT: String(port), FAUR_DELEGATION_LOG: log, FAUR_DELEGATION_ASYNC: String(async), FAUR_DELEGATION_TOOL: `mcp__projsrv__${tool}` };
    const server = spawn(process.execPath, [asset('delegation-model.mjs')], { env: vars, stdio: 'ignore' });
    try {
      await waitForServer(port, server);
      const run = spawnSync('pi', ['--no-session', '-e', asset('fake-provider.ts'), '--model', 'fake/m', '-p', '--approve', '/skill:test delegate'], { cwd: root, env: vars, input: '', encoding: 'utf8', timeout: 60000 });
      assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
      const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
      const allEvents = text.split('\n').filter(Boolean).map(JSON.parse);
      const events = allEvents.filter(e => e.child);
      const leadResult = allEvents.find(e => !e.child && e.result)?.result;
      assert.ok(leadResult, `no lead delegation result for async=${async}: ${run.stdout}\n${text}`);
      assert.match(String(leadResult), async ? /Async: worker/ : /child done/, `unexpected launch mode: ${text}`);
      if (!async) assert.ok(allEvents.indexOf(allEvents.find(e => !e.child && e.result)) > allEvents.lastIndexOf(events.at(-1)), 'foreground result must follow child completion');
      assert.ok(events.length >= 2, `no child model calls for async=${async}: ${run.stdout}\n${text}`);
      assert.ok(events[0].tools.includes('mcp__projsrv__projsrv_ping'));
      assert.ok(!events[0].tools.includes('mcp__projsrv__projsrv_secret'));
      assert.match(JSON.stringify(events.at(-1).result), tool.endsWith('ping') ? /CALLED projsrv_ping/ : /Tool mcp__projsrv__projsrv_secret not found/);
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill();
        await exited;
      }
    }
  }
});
