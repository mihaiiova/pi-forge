import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { generateProject } from '../generate.mjs';

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
const env = () => {
  const result = { ...process.env };
  delete result.PI_SUBAGENT_CHILD;
  delete result.PI_SUBAGENT_PARENT_SESSION;
  return result;
};
test('tracked generated project delegates MCP calls and enforces specialist selection in both launch modes', { timeout: 240000 }, async t => {
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
  if (install.status !== 0) { t.skip(`cannot install pinned pi-subagents: ${install.stderr}`); return; }
  for (const async of [false, true]) for (const tool of ['projsrv_ping', 'projsrv_secret']) {
    const log = join(base, `${async}-${tool}.jsonl`);
    const vars = { ...env(), PI_CODING_AGENT_DIR: home, FAKE_PORT: String(port), FAUR_DELEGATION_LOG: log, FAUR_DELEGATION_ASYNC: String(async), FAUR_DELEGATION_TOOL: `mcp__projsrv__${tool}` };
    const server = spawn(process.execPath, [asset('delegation-model.mjs')], { env: vars, stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const run = spawnSync('pi', ['--no-session', '-e', asset('fake-provider.ts'), '--model', 'fake/m', '-p', '--approve', '/skill:test delegate'], { cwd: root, env: vars, input: '', encoding: 'utf8', timeout: 60000 });
      assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
      const events = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.child);
      assert.ok(events.length >= 2, `no child model calls for async=${async}: ${run.stdout} ${readFileSync(log, "utf8")}`);
      assert.ok(events[0].tools.includes('mcp__projsrv__projsrv_ping'));
      assert.ok(!events[0].tools.includes('mcp__projsrv__projsrv_secret'));
      assert.match(JSON.stringify(events.at(-1).result), tool.endsWith('ping') ? /CALLED projsrv_ping/ : /Tool mcp__projsrv__projsrv_secret not found/);
    } finally { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
  }
});
