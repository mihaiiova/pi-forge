import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '../../..');
const sdkModule = async () => {
  const binary = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  return import(pathToFileURL(resolve(dirname(realpathSync(binary)), '../index.js')).href);
};

test('the minimal agent runs on Pi alone: its prompt and generated section load natively, without Faur', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-sdk-plain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root], { stdio: 'ignore' });
  assert.equal(JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8')).packages, undefined, 'no packages: Faur is not installed in this run');
  rmSync(join(root, '.pi/system.yaml'));
  const sdk = await sdkModule();
  // An empty agent directory: no user packages, extensions or Faur.
  const agentDir = join(root, '.forge/pi-home');
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
  try {
    await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
    const prompt = session.systemPrompt;
    assert.match(prompt, /You answer questions about the notes in this folder\. Cite file paths\./, 'the authored prompt, from .pi/APPEND_SYSTEM.md');
    assert.match(prompt, /## What you can use[\s\S]*\*\*Built-in tools:\*\* read, grep, find, ls/, 'the generated section, from the same file');
    assert.deepEqual(session.getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read'], 'defaultTools from .pi/settings.json');
    const tools = session.extensionRunner.getAllRegisteredTools().map(t => t.definition.name);
    assert.ok(!tools.includes('request_permission') && !tools.includes('memory'), 'no Faur runtime');
    assert.ok(!session.extensionRunner.getRegisteredCommands().some(c => c.name === 'faur'));
  } finally { session.dispose(); }
});

test('Faur installed in the developer\'s Pi maintains a generated project and adds no tool to its agent', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root], { stdio: 'ignore' });
  const sdk = await sdkModule();
  // Faur is a user-level package, as in the developer's own Pi; the project pins nothing.
  const agentDir = join(root, 'home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [repo] }));
  assert.equal(JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8')).packages, undefined);
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
  const oldCwd = process.cwd();
  const child = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  process.chdir(root);
  t.after(() => { process.chdir(oldCwd); if (child !== undefined) process.env.PI_SUBAGENT_CHILD = child; });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
  try {
    await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
    const commands = session.extensionRunner.getRegisteredCommands().map(c => c.name);
    assert.equal(commands.filter(name => name === 'faur').length, 1);
    assert.deepEqual(commands.filter(name => /factory/.test(name)), [], 'no old command names');
    const tools = session.extensionRunner.getAllRegisteredTools().map(t => t.definition.name);
    assert.ok(!tools.includes('request_permission') && !tools.includes('memory') && !tools.some(n => n.startsWith('cli_')), 'Faur adds nothing the agent runs');
    assert.deepEqual(session.getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read']);
    const notices = [];
    const command = session.extensionRunner.getCommand('faur');
    assert.match(command.description, /check \| status \| sync/);
    await command.handler('check', { hasUI: true, ui: { notify: message => notices.push(message) } });
    assert.match(notices.join('\n'), /All checks passed|No missing capabilities/, 'inside a project /faur checks this agent');
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
