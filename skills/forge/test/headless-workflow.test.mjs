import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Headless workflows are skills Pi runs in print mode: `pi --approve -p
// "/skill:<workflow> <request>"`, through the project's own `run` when the
// design has MCP servers. Real Pi, a scripted faux model, no network.
const repo = resolve(import.meta.dirname, '../../..');
const forge = join(repo, 'skills/forge/forge.mjs');
const server = join(import.meta.dirname, 'fixtures/mcp/server.mjs');
const pi = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
const ai = pathToFileURL(resolve(dirname(realpathSync(pi)), '../../node_modules/@earendil-works/pi-ai/dist/index.js')).href;

/** Generate a project from `yaml`, script the model, and point any Forge pin at this checkout. */
function project(t, yaml, responses, waitFor) {
  const root = mkdtempSync(join(tmpdir(), 'forge-headless-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), yaml);
  const generated = spawnSync(process.execPath, [forge, 'generate', root], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const provider = join(root, '.pi/provider.mjs');
  writeFileSync(provider, `import {createFauxCore,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(ai)};
import { appendFileSync } from 'node:fs';
export default pi => {
 const faux=createFauxCore({api:'faux-test',provider:'faux',models:[{id:'faux-1'}]});
 faux.setResponses([${responses}]);
 pi.registerProvider('faux',{baseUrl:'http://localhost',apiKey:'test',api:'faux-test',streamSimple:faux.streamSimple,models:[{type:'chat',id:'faux-1',name:'faux',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}]});
 pi.on('before_agent_start', async (event) => {
   appendFileSync(${JSON.stringify(join(root, 'prompt.log'))}, event.prompt + '\\n');
   ${waitFor ? `for(let i=0;i<100 && !pi.getAllTools().some(t=>t.name===${JSON.stringify(waitFor)});i++) await new Promise(r=>setTimeout(r,50));` : ''}
 });
};`);
  const settings = JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8'));
  // A pinned Forge release would need GitHub; this checkout is the same code.
  if (settings.packages?.some(p => p.startsWith('git:github.com/mihaiiova/pi-forge@'))) settings.packages = [repo, ...settings.packages.filter(p => !p.startsWith('git:'))];
  settings.extensions = [provider];
  writeFileSync(join(root, '.pi/settings.json'), JSON.stringify(settings));
  const env = { ...process.env, PI_OFFLINE: '1' };
  delete env.PI_SUBAGENT_CHILD;
  return { root, env };
}

/** Run `/skill:test` headless, through ./run when the project has one. */
function headless({ root, env }, request = 'check the login page') {
  const hasRun = existsSync(join(root, 'run'));
  const command = hasRun ? join(root, 'run') : 'pi';
  if (!hasRun) env = { ...env, PI_CODING_AGENT_DIR: join(root, '.home') };
  const args = ['--approve', '--no-session', '--mode', 'json', '-p', `/skill:test ${request}`];
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  const events = result.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const final = events.filter(e => e.type === 'agent_end').at(-1)?.messages?.filter(m => m.role === 'assistant').at(-1);
  const text = final?.content?.filter(c => c.type === 'text').map(c => c.text).join('') ?? '';
  const toolResults = events.filter(e => e.type === 'turn_end').flatMap(e => e.toolResults ?? []).map(r => r.content?.map(c => c.text).join('') ?? '');
  return { status: result.status, stderr: result.stderr, text, toolResults };
}

const approvals = (called) => `schema: 1
name: approval-workflow
orchestrator:
  name: lead
  model: faux/faux-1
  tools: [read, cli:make-file, mcp]
  prompt: Test approvals.
integrations:
  cli:
    - name: make-file
      command: touch
      args: [${JSON.stringify(called)}]
  mcp:
    - name: seo
      config:
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(server)}]
        env: { MCP_LOG: ${JSON.stringify(called)} }
        includeTools: [run_audit]
        approveTools: [run_audit]
workflows:
  - name: test
    entry: lead
`;

function blocked(t, tool, input) {
  const called = join(tmpdir(), `forge-called-${process.pid}-${Math.random().toString(36).slice(2)}`);
  t.after(() => rmSync(called, { force: true }));
  const info = project(t, approvals(called), `fauxAssistantMessage([fauxToolCall(${JSON.stringify(tool)},${JSON.stringify(input)})]), fauxAssistantMessage('done')`, tool.startsWith('mcp__') ? tool : null);
  const run = headless(info);
  assert.equal(run.status, 0, `the run itself succeeds: ${run.stderr}`);
  assert.equal(run.text, 'done');
  assert.equal(existsSync(called), false, 'the approval-gated side effect never ran');
  return { ...run, ...info };
}

test('a headless declared command that needs approval is refused, and nothing runs', t => {
  const { toolResults } = blocked(t, 'cli_make_file', {});
  assert.ok(toolResults.some(r => /make-file needs the user's approval for each run/.test(r)), toolResults.join('\n'));
});

test('a headless request_permission queues the request and runs nothing', t => {
  const { root } = blocked(t, 'request_permission', { name: 'create-directory', command: 'mkdir', args: ['created'], reason: 'Need a directory' });
  assert.equal(existsSync(join(root, 'created')), false);
  assert.match(readFileSync(join(root, '.forge/permission-requests.json'), 'utf8'), /create-directory/);
});

test('a headless MCP call that needs approval is refused, and nothing runs', t => {
  const { toolResults } = blocked(t, 'mcp__seo__run_audit', {});
  assert.ok(toolResults.some(r => /seo: run_audit needs the user's approval/.test(r)), toolResults.join('\n'));
});

test('a workflow without commands or approvals runs headless with pi -p and no Faur', t => {
  const info = project(t, `schema: 1
name: marketing
orchestrator:
  name: lead
  model: faux/faux-1
  tools: [read, mcp]
  prompt: Run marketing checks.
integrations:
  mcp:
    - name: seo
      config:
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(server)}]
workflows:
  - name: test
    description: Check a page
    entry: lead
`, "fauxAssistantMessage('Workflow complete')");
  const settings = JSON.parse(readFileSync(join(info.root, '.pi/settings.json'), 'utf8'));
  assert.deepEqual(settings.packages ?? [], [], 'no Forge package: the project runs on Pi alone');
  const run = headless(info, 'url=https://example.com');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.text, 'Workflow complete');
  const prompt = readFileSync(join(info.root, 'prompt.log'), 'utf8');
  assert.match(prompt, /<skill name="test"[\s\S]*## Boundary[\s\S]*Entry: lead/, 'the generated workflow skill is expanded');
  assert.match(prompt, /url=https:\/\/example\.com/, 'the request follows the skill');
});
