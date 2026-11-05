import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = resolve(import.meta.dirname, '..');
const sdkModule = async () => {
  const binary = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  return import(pathToFileURL(resolve(dirname(realpathSync(binary)), '../index.js')).href);
};

test('plain Pi launches a generated MCP project without Faur or a launcher', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-renamed-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  const { loadYaml } = await import('../src/yaml-loader.mjs');
  const yaml = loadYaml();
  const model = yaml.parse(readFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), 'utf8'));
  model.orchestrator.prompt += '\nPROJECT-APPEND';
  model.integrations = { mcp: [{ name: 'demo', config: { command: 'node', args: [join(import.meta.dirname, 'pi-lab/mcp-stub.mjs')] } }] };
  writeFileSync(join(root, '.pi/system.yaml'), yaml.stringify(model));
  const host = join(root, 'host-home');
  mkdirSync(host);
  writeFileSync(join(host, 'APPEND_SYSTEM.md'), 'HOST-APPEND');
  const env = { ...process.env, PI_CODING_AGENT_DIR: host, PI_OFFLINE: '1', PROBE_WAIT: '0', PROBE_OUT: join(root, 'probe.json') };
  const generated = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { encoding: 'utf8', env });
  assert.equal(generated.status, 0, generated.stderr);
  const launched = spawnSync('pi', ['-p', '--no-session', '--approve', '-e', join(import.meta.dirname, 'pi-lab/probe.ts'), '--model', 'probe/m', 'hi'], { cwd: root, env, input: '', encoding: 'utf8', timeout: 60000 });
  assert.equal(launched.status, 0, launched.stderr);
  const probe = JSON.parse(readFileSync(env.PROBE_OUT, 'utf8'));
  assert.ok(probe.markers.includes('PROJECT-APPEND'));
  // Project APPEND_SYSTEM.md replaces the host append prompt in Pi.
  assert.ok(!probe.commands.some(name => /^faur /.test(name)));
  assert.ok(!probe.tools.some(name => /^faur_plan /.test(name)));
  assert.equal(existsSync(join(root, 'run')), false);
});

test('real Pi loads a generated project in RPC mode without Faur or a run script', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-plain-pi-rpc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  const home = join(root, 'home');
  mkdirSync(home);
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  const env = { ...process.env, PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1' };
  const generated = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { encoding: 'utf8', env });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(existsSync(join(root, 'run')), false);
  const result = spawnSync('pi', ['--mode', 'rpc', '--no-session', '--approve'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ id: 'state', type: 'get_state' }) + '\n',
  });
  assert.equal(result.status, 0, result.stderr);
  const state = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.id === 'state');
  assert.equal(state?.success, true, result.stdout);
});

test('a v0.30 project is freshly regenerated and manual edits are reconciled in real Pi', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-v030-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, 'old'), next = join(root, 'new'), home = join(root, 'home');
  for (const dir of [join(old, '.pi'), join(next, '.pi'), home]) mkdirSync(dir, { recursive: true });
  const fixture = join(import.meta.dirname, 'fixtures/v030-minimal/.pi');
  for (const name of ['system.yaml', 'APPEND_SYSTEM.md', 'settings.json']) copyFileSync(join(fixture, name), join(old, '.pi', name));
  const oldPromptPath = join(old, '.pi/APPEND_SYSTEM.md');
  const edited = readFileSync(oldPromptPath, 'utf8').replace('Cite file paths.', 'Cite absolute file paths and keep my manual edit.');
  writeFileSync(oldPromptPath, edited);
  copyFileSync(join(old, '.pi/system.yaml'), join(next, '.pi/system.yaml'));
  const cli = join(repo, 'src/faur.mjs');
  const env = { ...process.env, PI_CODING_AGENT_DIR: home };
  const preview = spawnSync(process.execPath, [cli, 'generate', next, '--dry-run'], { encoding: 'utf8', env });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /dry run/);
  assert.equal(readFileSync(oldPromptPath, 'utf8'), edited, 'preview does not modify the old project');
  const generated = spawnSync(process.execPath, [cli, 'generate', next, '--yes'], { encoding: 'utf8', env });
  assert.equal(generated.status, 0, generated.stderr);
  const promptPath = join(next, '.pi/APPEND_SYSTEM.md');
  const reconciled = readFileSync(promptPath, 'utf8').replace('Cite file paths.', 'Cite absolute file paths and keep my manual edit.');
  writeFileSync(promptPath, reconciled);
  assert.equal(readFileSync(oldPromptPath, 'utf8'), edited, 'fresh generation and reconciliation leave the old project intact');
  assert.match(reconciled, /<!-- faur:derived v1 begin/);
  assert.doesNotMatch(reconciled, /<!-- forge:derived/);
  assert.equal(JSON.parse(readFileSync(join(next, '.pi/settings.json'), 'utf8')).packages, undefined);
  const sdk = await sdkModule();
  const settingsManager = sdk.SettingsManager.create(next, home, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd: next, agentDir: home, settingsManager, noContextFiles: true });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: next, agentDir: home, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(next) });
  try {
    await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
    assert.match(session.systemPrompt, /Cite absolute file paths and keep my manual edit/);
    assert.deepEqual(session.getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read']);
    assert.ok(!session.extensionRunner.getRegisteredCommands().some(c => c.name === 'faur'));
  } finally { session.dispose(); }
});

test('deleting the design record leaves real Pi unchanged and import reports preserved native settings', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-plain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const settingsPath = join(root, '.pi/settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.packages, undefined, 'no packages: Faur is not installed in this run');
  settings.theme = 'dark';
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const settingsBefore = readFileSync(settingsPath, 'utf8');
  const promptPath = join(root, '.pi/APPEND_SYSTEM.md');
  writeFileSync(promptPath, readFileSync(promptPath, 'utf8').replace('Cite file paths.', 'Cite full file paths and keep this manual instruction.'));
  const promptBefore = readFileSync(promptPath, 'utf8');
  const sdk = await sdkModule();
  // An empty agent directory: no user packages, extensions or Faur.
  const agentDir = join(root, '.faur/pi-home');
  mkdirSync(agentDir, { recursive: true });
  async function launch() {
    const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
    try {
      await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
      const prompt = session.systemPrompt;
      assert.match(prompt, /You answer questions about the notes in this folder\. Cite full file paths and keep this manual instruction\./);
      assert.match(prompt, /## What you can use[\s\S]*\*\*Built-in tools:\*\* read, grep, find, ls/);
      const active = session.getActiveToolNames().sort();
      assert.deepEqual(active, ['find', 'grep', 'ls', 'read']);
      const tools = session.extensionRunner.getAllRegisteredTools().map(t => t.definition.name);
      assert.ok(!tools.includes('request_permission') && !tools.includes('memory'));
      assert.ok(!session.extensionRunner.getRegisteredCommands().some(c => c.name === 'faur'));
      return { prompt, active };
    } finally { session.dispose(); }
  }
  const before = await launch();
  rmSync(join(root, '.pi/system.yaml'));
  assert.deepEqual(await launch(), before, 'real Pi sees the same prompt and active tools without system.yaml');
  const imported = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'import', root], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stderr, /flagged - theme: theme is a settings-only cosmetic key/);
  const { loadYaml } = await import('../src/yaml-loader.mjs');
  const record = loadYaml().parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.match(record.orchestrator.prompt, /Cite full file paths and keep this manual instruction/);
  assert.match(imported.stderr, /marked authored prompt was imported/);
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBefore, 'import preserves native-only settings byte-for-byte');
  assert.equal(readFileSync(join(root, '.pi/APPEND_SYSTEM.md'), 'utf8'), promptBefore, 'import preserves the native prompt');
  assert.deepEqual(await launch(), before, 'import does not alter real Pi behavior');
  const { planChange, applyChange } = await import('../src/maintenance.mjs');
  applyChange(root, planChange(root, [{ op: 'set', target: 'policies', value: {} }]), true);
  const revised = await launch();
  assert.match(revised.prompt, /Cite full file paths and keep this manual instruction/, 'later revision retains the imported manual prompt');
});

test('import and revision never expand an empty native tool allowlist in real Pi', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-import-empty-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const settingsPath = join(root, '.pi/settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.defaultTools = [];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  rmSync(join(root, '.pi/system.yaml'));
  const agentDir = join(root, 'home');
  mkdirSync(agentDir);
  const sdk = await sdkModule();
  async function activeTools() {
    const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
    try { return session.getActiveToolNames(); } finally { session.dispose(); }
  }
  const before = await activeTools();
  assert.deepEqual(before, [], 'Pi starts without active tools for an empty allowlist');
  const imported = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'import', root], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(imported.status, 0, imported.stderr);
  const { loadYaml } = await import('../src/yaml-loader.mjs');
  assert.deepEqual(loadYaml().parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8')).orchestrator.tools, []);
  const { planChange, applyChange } = await import('../src/maintenance.mjs');
  applyChange(root, planChange(root, [{ op: 'set', target: 'policies', value: {} }]), true);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).defaultTools, []);
  assert.deepEqual(await activeTools(), before, 'revision does not expand real Pi tools');
});

test('imported specialist guidance is regenerated, not retained as stale authored prompt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-import-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  const { loadYaml } = await import('../src/yaml-loader.mjs');
  const model = { schema: 1, name: 'import-agent', orchestrator: { name: 'orchestrator', model: 'fixture/model', tools: ['read'], prompt: 'Coordinate.' }, agents: [{ name: 'scout', description: 'Scout', model: 'fixture/model', tools: ['read'], prompt: 'Inspect the project.' }] };
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const agentPath = join(root, '.pi/agents/scout.md');
  const before = readFileSync(agentPath, 'utf8');
  assert.match(before, /\*\*Built-in tools:\*\* read/);
  rmSync(join(root, '.pi/system.yaml'));
  const agentDir = join(root, 'home');
  mkdirSync(agentDir);
  const imported = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'import', root], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stderr, /generated capability and document guidance was not imported/);
  const record = loadYaml().parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.equal(record.agents[0].prompt, 'Inspect the project.');
  const { planChange, applyChange } = await import('../src/maintenance.mjs');
  applyChange(root, planChange(root, [{ op: 'update', target: 'agent', name: 'scout', value: { tools: ['read', 'grep'] } }]), true);
  const after = readFileSync(agentPath, 'utf8');
  assert.equal((after.match(/## What you can use/g) ?? []).length, 1);
  assert.match(after, /\*\*Built-in tools:\*\* read, grep/);
  assert.doesNotMatch(after, /\*\*Built-in tools:\*\* read\n/);
  const sdk = await sdkModule();
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true, noExtensions: true });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
  try { assert.deepEqual(session.getActiveToolNames(), ['read', 'ls', 'find', 'grep'], 'real Pi starts the lead with the browsing baseline'); } finally { session.dispose(); }
});

test('import refuses a modified generated specialist before writing a design record', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-import-edited-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  const { loadYaml } = await import('../src/yaml-loader.mjs');
  const model = { schema: 1, name: 'import-agent', orchestrator: { name: 'orchestrator', model: 'fixture/model', tools: ['read'] }, agents: [{ name: 'scout', description: 'Scout', model: 'fixture/model', tools: ['read'], prompt: 'Inspect.' }] };
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const path = join(root, '.pi/agents/scout.md');
  const edited = readFileSync(path, 'utf8').replace('Inspect.', 'Hand-edited instructions.');
  writeFileSync(path, edited);
  rmSync(join(root, '.pi/system.yaml'));
  const result = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'import', root], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'home') } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated specialist instructions cannot be safely separated/);
  assert.equal(readFileSync(path, 'utf8'), edited);
  assert.throws(() => readFileSync(join(root, '.pi/system.yaml'), 'utf8'), /ENOENT/);
});

test('import reports an unmarked native prompt and refuses to reapply over it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-import-unmarked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const promptPath = join(root, '.pi/APPEND_SYSTEM.md');
  const nativePrompt = 'An independently authored native prompt.\n';
  writeFileSync(promptPath, nativePrompt);
  rmSync(join(root, '.pi/system.yaml'));
  const result = spawnSync(process.execPath, [join(repo, 'src/faur.mjs'), 'import', root], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'home') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /native prompt could not be safely separated and was not imported/);
  assert.equal(readFileSync(promptPath, 'utf8'), nativePrompt);
  const { planNativeReapply } = await import('../src/maintenance.mjs');
  assert.throws(() => planNativeReapply(root, '.pi/APPEND_SYSTEM.md'), /Cannot safely separate/);
  assert.equal(readFileSync(promptPath, 'utf8'), nativePrompt);
});

test('native prompt and settings edits survive adoption and revision in real Pi', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const { inspectProject, planSettingsAdoption, planSettingsReconciliation, planPromptAdoption, planNativeReapply, planChange, applyChange } = await import('../src/maintenance.mjs');
  const promptPath = join(root, '.pi/APPEND_SYSTEM.md');
  writeFileSync(promptPath, readFileSync(promptPath, 'utf8').replace('Cite file paths.', 'Cite full file paths and include a summary.'));
  applyChange(root, planPromptAdoption(root), true);
  const settingsPath = join(root, '.pi/settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.defaultTools = ['read'];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  assert.throws(() => planSettingsAdoption(root), /without ls, find, grep/, 'dropping the browsing baseline cannot be adopted');
  settings.defaultTools = ['read', 'ls', 'find', 'grep', 'bash'];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  assert.ok(inspectProject(root).nativeDrift.some(item => item.path === '.pi/settings.json'));
  const sdk = await sdkModule();
  const agentDir = join(root, 'home');
  mkdirSync(agentDir);
  const settingsManager = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(root) });
  try { assert.deepEqual(session.getActiveToolNames(), ['read', 'ls', 'find', 'grep', 'bash']); }
  finally { session.dispose(); }
  applyChange(root, planSettingsAdoption(root), true);
  applyChange(root, planChange(root, [{ op: 'set', target: 'policies', value: {} }]), true);
  const newSettings = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const newLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: newSettings, noContextFiles: true });
  await newLoader.reload();
  const { session: revised } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: newLoader, settingsManager: newSettings, sessionManager: sdk.SessionManager.inMemory(root) });
  try {
    assert.deepEqual(revised.getActiveToolNames(), ['read', 'ls', 'find', 'grep', 'bash'], 'the adopted edit survives a revision');
    assert.match(revised.systemPrompt, /Cite full file paths and include a summary/);
  } finally { revised.dispose(); }
  const drifted = JSON.parse(readFileSync(settingsPath, 'utf8'));
  drifted.defaultTools = ['read', 'bash'];
  writeFileSync(settingsPath, JSON.stringify(drifted, null, 2) + '\n');
  applyChange(root, planNativeReapply(root, '.pi/settings.json'), true);
  const reappliedSettings = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const reappliedLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: reappliedSettings, noContextFiles: true });
  await reappliedLoader.reload();
  const { session: reapplied } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: reappliedLoader, settingsManager: reappliedSettings, sessionManager: sdk.SessionManager.inMemory(root) });
  try { assert.deepEqual(reapplied.getActiveToolNames(), ['read', 'ls', 'find', 'grep', 'bash'], 'reapply restores the adopted design'); }
  finally { reapplied.dispose(); }
  writeFileSync(promptPath, readFileSync(promptPath, 'utf8').replace('include a summary', 'include a different summary'));
  applyChange(root, planNativeReapply(root, '.pi/APPEND_SYSTEM.md'), true);
  const promptSettings = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const promptLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: promptSettings, noContextFiles: true });
  await promptLoader.reload();
  const { session: promptReapplied } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: promptLoader, settingsManager: promptSettings, sessionManager: sdk.SessionManager.inMemory(root) });
  try { assert.match(promptReapplied.systemPrompt, /include a summary/); assert.doesNotMatch(promptReapplied.systemPrompt, /include a different summary/); }
  finally { promptReapplied.dispose(); }
  const mixed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  mixed.defaultModel = 'manual-model';
  mixed.defaultTools = ['read', 'grep'];
  writeFileSync(settingsPath, JSON.stringify(mixed, null, 2) + '\n');
  assert.throws(() => planSettingsReconciliation(root, ['tools']), /without ls, find/);
  mixed.defaultTools = ['read', 'grep', 'ls', 'find'];
  writeFileSync(settingsPath, JSON.stringify(mixed, null, 2) + '\n');
  applyChange(root, planSettingsReconciliation(root, ['tools']), true);
  assert.notEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).defaultModel, 'manual-model');
  applyChange(root, planChange(root, [{ op: 'set', target: 'policies', value: {} }]), true);
  const mergedSettings = sdk.SettingsManager.create(root, agentDir, { projectTrusted: true });
  const mergedLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: mergedSettings, noContextFiles: true });
  await mergedLoader.reload();
  const { session: merged } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: mergedLoader, settingsManager: mergedSettings, sessionManager: sdk.SessionManager.inMemory(root) });
  try { assert.deepEqual(merged.getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read']); }
  finally { merged.dispose(); }
});

test('an adopted MCP connection edit survives revision and loads in real Pi', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-mcp-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  const { loadYaml } = await import('../src/yaml-loader.mjs');
  const yaml = loadYaml();
  const model = yaml.parse(readFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), 'utf8'));
  model.integrations = { mcp: [{ name: 'seo', config: { command: process.execPath, args: [join(import.meta.dirname, 'fixtures/mcp/server.mjs')], env: { MCP_TOOLS: '${ORIGINAL_MCP_TOOLS}' } } }] };
  writeFileSync(join(root, '.pi/system.yaml'), yaml.stringify(model));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const mcpPath = join(root, '.pi/mcp.json');
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
  mcp.mcpServers.seo.args = ['-e', `process.env.MCP_TOOLS='after'; import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'fixtures/mcp/server.mjs')).href)})`];
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  const { planIntegrationAdoption, planChange, applyChange } = await import('../src/maintenance.mjs');
  applyChange(root, planIntegrationAdoption(root, '.pi/mcp.json'), true);
  applyChange(root, planChange(root, [{ op: 'assign', name: 'helper', model: 'fixture/revised' }]), true);
  const home = join(root, 'home');
  mkdirSync(home);
  const out = join(root, 'probe.json');
  execFileSync('pi', ['-p', '--no-session', '--approve', '-e', join(import.meta.dirname, 'pi-lab/probe.ts'), '--model', 'probe/m', 'hi'], {
    cwd: root, input: '', timeout: 30000, env: { ...process.env, ORIGINAL_MCP_TOOLS: 'original', PI_CODING_AGENT_DIR: home, PROBE_OUT: out }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const probe = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(probe.tools.some(tool => tool.startsWith('mcp__seo__after ')), JSON.stringify(probe.tools));
  assert.ok(!probe.tools.some(tool => tool.startsWith('mcp__seo__before ')));
});

test('selected MCP reconciliation applies in real Pi without adopting unselected edits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-mcp-reconcile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  const { loadYaml } = await import('../src/yaml-loader.mjs');
  const yaml = loadYaml();
  const model = yaml.parse(readFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), 'utf8'));
  model.integrations = { mcp: [{ name: 'seo', config: { command: process.execPath, args: [join(import.meta.dirname, 'fixtures/mcp/server.mjs')], env: { MCP_TOOLS: '${ORIGINAL_MCP_TOOLS}' } } }] };
  writeFileSync(join(root, '.pi/system.yaml'), yaml.stringify(model));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
  const path = join(root, '.pi/mcp.json');
  const native = JSON.parse(readFileSync(path, 'utf8'));
  native.mcpServers.seo.args = ['-e', `process.env.MCP_TOOLS='reconciled'; import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'fixtures/mcp/server.mjs')).href)})`];
  native.mcpServers.seo.env.MCP_TOOLS = '${OTHER_MCP_TOOLS}';
  writeFileSync(path, JSON.stringify(native, null, 2) + '\n');
  const { planIntegrationReconciliation, applyChange } = await import('../src/maintenance.mjs');
  applyChange(root, planIntegrationReconciliation(root, '.pi/mcp.json', ['seo.args']), true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).mcpServers.seo.env.MCP_TOOLS, '${ORIGINAL_MCP_TOOLS}');
  const extra = JSON.parse(readFileSync(path, 'utf8'));
  extra.mcpServers.seo.futureOption = { keep: true };
  writeFileSync(path, JSON.stringify(extra, null, 2) + '\n');
  const { inspectProject, planChange } = await import('../src/maintenance.mjs');
  assert.ok(inspectProject(root).nativeUnrepresented.some(item => item.setting === 'mcpServers.seo.futureOption'));
  assert.throws(() => planChange(root, [{ op: 'assign', name: 'helper', model: 'fixture/revised' }]), /Native MCP field seo\.futureOption would be lost/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).mcpServers.seo.futureOption, { keep: true });
  const home = join(root, 'home');
  mkdirSync(home);
  const out = join(root, 'probe.json');
  execFileSync('pi', ['-p', '--no-session', '--approve', '-e', join(import.meta.dirname, 'pi-lab/probe.ts'), '--model', 'probe/m', 'hi'], {
    cwd: root, input: '', timeout: 30000, env: { ...process.env, ORIGINAL_MCP_TOOLS: 'original', PI_CODING_AGENT_DIR: home, PROBE_OUT: out }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const probe = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(probe.tools.some(tool => tool.startsWith('mcp__seo__reconciled ')), JSON.stringify(probe.tools));
});

test('Faur installed in the developer\'s Pi maintains a generated project and adds no tool to its agent', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', root], { stdio: 'ignore' });
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

test('outside a Faur project, /faur designs a new agent and has nothing to check', async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-outside-'));
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
    assert.match(notices.join('\n'), /not a Faur project/i);
  } finally { session.dispose(); }
});
