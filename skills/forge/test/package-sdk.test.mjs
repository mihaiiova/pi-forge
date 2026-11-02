import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '../../..');
test('Pi loads a generated project from the Forge package', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root], { stdio: 'ignore' });
  const binary = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  const sdk = await import(pathToFileURL(resolve(dirname(realpathSync(binary)), '../index.js')).href);
  const agentDir = join(root, '.forge/pi-home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [repo], defaultTools: ['read'] }));
  const generatedSettings = readFileSync(join(root, '.pi/settings.json'));
  writeFileSync(join(root, '.pi/settings.json'), JSON.stringify({ packages: [repo], defaultTools: ['read'] }));
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
  const oldCwd = process.cwd();
  const child = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  process.chdir(root);
  t.after(() => { process.chdir(oldCwd); if (child !== undefined) process.env.PI_SUBAGENT_CHILD = child; });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root), tools: ['read'] });
  try {
    await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
    const commands = session.extensionRunner.getRegisteredCommands().map(c => c.name);
    assert.equal(commands.filter(name => name === 'faur').length, 1);
    assert.deepEqual(commands.filter(name => /factory/.test(name)), [], 'no old command names');
    assert.ok(session.extensionRunner.getAllRegisteredTools().some(t => t.definition.name === 'memory'));
    assert.ok(session.extensionRunner.getAllRegisteredTools().some(t => t.definition.name === 'request_permission'));
    const notices = [];
    const command = session.extensionRunner.getCommand('faur');
    assert.match(command.description, /check \| status \| sync/);
    await command.handler('check', { hasUI: true, ui: { notify: message => notices.push(message) } });
    assert.match(notices.join('\n'), /Validation/, 'inside a project /faur checks this agent');
  } finally { session.dispose(); }
});

test('outside a Forge project, /faur designs a new agent and has nothing to check', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  const sdk = await import(pathToFileURL(resolve(dirname(realpathSync(binary)), '../index.js')).href);
  const agentDir = join(root, 'home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [repo], defaultTools: ['read'] }));
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root), tools: ['read'] });
  try {
    await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
    const commands = session.extensionRunner.getRegisteredCommands().map(c => c.name);
    assert.deepEqual(commands.filter(name => name === 'faur' || /factory/.test(name)), ['faur']);
    const notices = [];
    await session.extensionRunner.getCommand('faur').handler('status', { hasUI: true, cwd: root, ui: { notify: message => notices.push(message) } });
    assert.match(notices.join('\n'), /not a Forge project/i);
  } finally { session.dispose(); }
});
