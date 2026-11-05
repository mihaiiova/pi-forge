import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Maintenance in real Pi over RPC (the protocol a UI uses), with a scripted
// faux model and no network: the mode is visible, and agent work asked for in
// /faur is handed back to the agent only when the person chooses to leave.
const repo = resolve(import.meta.dirname, '..');
const pi = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
const ai = pathToFileURL(resolve(dirname(realpathSync(pi)), '../../node_modules/@earendil-works/pi-ai/dist/index.js')).href;

test('in /faur, agent work is handed back to the agent when the person leaves', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-maint-rpc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), `schema: 1
name: reporter
orchestrator:
  name: lead
  model: faux/faux-1
  tools: [read, ls]
  prompt: Write marketing reports.
`);
  const generated = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const log = join(root, 'prompts.log');
  const provider = join(root, 'provider.mjs');
  writeFileSync(provider, `import {createFauxCore,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(ai)};
import { appendFileSync } from 'node:fs';
export default pi => {
 const faux=createFauxCore({api:'faux-test',provider:'faux',models:[{id:'faux-1'}]});
 faux.setResponses([
  fauxAssistantMessage(fauxToolCall('faur_plan',{action:'leave'})),
  fauxAssistantMessage('Your agent can do this review.'),
  fauxAssistantMessage('AGENT-OK'),
 ]);
 pi.registerProvider('faux',{baseUrl:'http://localhost',apiKey:'test',api:'faux-test',streamSimple:faux.streamSimple,models:[{type:'chat',id:'faux-1',name:'faux',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}]});
 pi.on('turn_start', async () => { appendFileSync(${JSON.stringify(log)}, JSON.stringify(pi.getActiveTools()) + '\\n'); });
};`);
  const child = spawn('pi', ['--no-extensions', '-e', provider, '-e', join(repo, 'extensions/faur/index.ts'), '--approve', '--no-session', '--mode', 'rpc'], {
    cwd: root, env: { ...process.env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: join(root, '.home') }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const events = [];
  let buffer = '';
  let wake = () => {};
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { events.push(JSON.parse(line)); } catch { continue; }
      const e = events.at(-1);
      // The person picks "Leave" in the end-of-turn dialog.
      if (e.type === 'extension_ui_request' && e.method === 'select') child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: e.id, value: 'Leave /faur and ask my agent' }) + '\n');
      wake();
    }
  });
  const until = (predicate, ms = 30000) => new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`timed out; events: ${events.map(e => e.type + (e.method ? ':' + e.method : '')).join(' ')}`)), ms);
    const check = () => { if (predicate()) { clearTimeout(timer); wake = () => {}; ok(); } };
    wake = check; check();
  });
  child.stdin.write(JSON.stringify({ id: '1', type: 'prompt', message: '/faur do a marketing review of example.com' }) + '\n');
  await until(() => events.filter(e => e.type === 'agent_end').length >= 2);

  const ui = events.filter(e => e.type === 'extension_ui_request');
  assert.ok(ui.some(e => e.method === 'setStatus' && e.statusKey === 'faur' && /In \/faur: your agent's tools are off/.test(e.statusText ?? '')), `maintenance shows its status: ${JSON.stringify(ui.filter(e => e.method === 'setStatus'))}`);
  assert.ok(!ui.some(e => e.method === 'setWidget'), 'nothing is drawn above the input');
  const select = ui.find(e => e.method === 'select');
  assert.equal(select?.title, 'This is work for your agent, not a change to it.');
  assert.ok(ui.some(e => e.method === 'notify' && /^Left \/faur\. No changes in this session/.test(e.message)));
  assert.ok(ui.some(e => e.method === 'setStatus' && e.statusKey === 'faur' && !e.statusText), 'leaving clears the status');

  // Active tools at each model turn: /faur first, then the agent's own.
  const turns = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(turns[0], ['faur_plan'], 'in /faur only faur_plan is active');
  assert.ok(turns.at(-1).includes('read') && !turns.at(-1).includes('faur_plan'), `the agent has its own tools back: ${turns.at(-1)}`);
  const handed = events.filter(e => e.type === 'agent_end').at(-1).messages;
  assert.equal(handed.find(m => m.role === 'user')?.content?.[0]?.text, 'do a marketing review of example.com', 'the request goes to the agent');
  assert.equal(handed.filter(m => m.role === 'assistant').at(-1).content.find(p => p.type === 'text')?.text, 'AGENT-OK');
});
