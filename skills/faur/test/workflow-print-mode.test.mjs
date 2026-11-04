import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('Pi print mode expands a skill before the agent starts', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-print-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'skill')); mkdirSync(join(root, 'home'));
  writeFileSync(join(root, 'skill/SKILL.md'), '---\nname: evidence\ndescription: Print mode evidence\n---\n\nUnique skill instruction.\n');
  const bin = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
  const ai = pathToFileURL(resolve(bin, '../../node_modules/@earendil-works/pi-ai/dist/index.js')).href;
  const capture = join(root, 'prompt');
  const ext = join(root, 'provider.mjs');
  writeFileSync(ext, `import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(ai)};
import { writeFileSync } from 'node:fs';
export default pi => {
  const faux = createFauxCore({ api: 'faux-test', provider: 'faux', models: [{ id: 'faux-1' }] });
  faux.setResponses([fauxAssistantMessage('done')]);
  pi.registerProvider('faux', { baseUrl:'http://localhost', apiKey:'test', api:'faux-test', streamSimple:faux.streamSimple, models:[{ type:'chat', id:'faux-1', name:'faux', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:100000, maxTokens:1000 }] });
  pi.on('before_agent_start', event => writeFileSync(${JSON.stringify(capture)}, event.prompt));
};`);
  const result = spawnSync('pi', ['--offline', '--no-extensions', '--no-mcp', '--no-session', '--skill', join(root, 'skill'), '-e', ext, '--model', 'faux/faux-1', '-p', '/skill:evidence topic=hello'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'home') }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(capture, 'utf8'), /Unique skill instruction\./);
  assert.match(readFileSync(capture, 'utf8'), /topic=hello/);
});
