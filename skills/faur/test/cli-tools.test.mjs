import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../yaml-loader.mjs';
import { validateSystem } from '../validate.mjs';
import { generateProject } from '../generate.mjs';
import { changeModel } from '../changes.mjs';
import { effectiveCapabilities, checkCapabilities } from '../capabilities.mjs';
import { launchCheck } from '../launch-check.mjs';
import { permissionsCommand } from '../permissions-command.mjs';
import { cliToolName, grantOps, placeholders, revokeOps, splitCommandLine } from '../cli-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../../../package.json'), 'utf8'));
const yaml = loadYaml();
const echoArg = ['-e', 'process.stdout.write(process.argv[1])'];
const model = {
  schema: 1, name: 'cli-test',
  orchestrator: { name: 'lead', model: 'fixture/large', tools: ['read', 'cli:echo-title'] },
  agents: [{ name: 'writer', model: 'fixture/small', tools: ['read', 'cli:show-body'] }],
  integrations: {
    cli: [
      { name: 'echo-title', description: 'Echo a title', command: 'node', args: [...echoArg, '{title}'] },
      { name: 'show-body', command: 'node', args: ['-e', "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))", '{body:file}'], approve: false },
      { name: 'unused', command: 'node', args: ['--version'] },
    ],
  },
};

function project(t, doc = model) {
  const root = mkdtempSync(join(tmpdir(), 'faur-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const generated = generateProject(doc, {}, { piPackages: pkg.pi.packages });
  assert.deepEqual(generated.errors, []);
  for (const f of generated.files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
    if (f.executable) chmodSync(join(root, f.path), 0o755);
  }
  writeFileSync(join(root, '.pi/system.yaml'), yaml.stringify(doc));
  mkdirSync(join(root, '.faur'), { recursive: true });
  return root;
}

function adapter({ hasUI = true, choices = [], confirm = true } = {}) {
  const tools = {}, commands = {}, notices = [], asked = [];
  const pi = { registerTool: (t) => { tools[t.name] = t; }, registerCommand: (n, c) => { commands[n] = c; }, on: () => {} };
  const Type = Object.fromEntries(['Object', 'Union', 'Literal', 'Optional', 'String', 'Number', 'Array', 'Record'].map((k) => [k, (v) => v]));
  const inputs = [];
  const ctx = {
    hasUI, waitForIdle: async () => {},
    ui: {
      select: async (title, options) => { asked.push({ title, options }); const c = choices.shift(); return typeof c === 'number' ? options[c] : c; },
      confirm: async (title, message) => { asked.push({ title, message }); return confirm; },
      input: async () => inputs.shift(),
      notify: (m, level) => notices.push({ m, level }),
    },
  };
  return { pi, Type, tools, commands, notices, asked, ctx, inputs };
}

test('integrations.cli validates shapes and cli: references', () => {
  assert.equal(validateSystem(model).ok, true);
  const errors = (cli, tools = ['cli:x']) => validateSystem({ ...model, orchestrator: { ...model.orchestrator, tools }, agents: [], integrations: { cli } }).errors;
  assert.ok(errors([{ name: 'x', command: 'gh issue' }]).some((e) => e.includes('one program name')));
  assert.ok(errors([{ name: 'x', command: 'gh', args: ['--title={title}'] }]).some((e) => e.includes("looks like a placeholder")));
  assert.ok(errors([{ name: 'x', command: 'gh', args: ['{Title}'] }]).some((e) => e.includes("looks like a placeholder")));
  assert.deepEqual(errors([{ name: 'x', command: 'gh', args: ['pr', 'list', '--jq', '.[] | {number}', '--template', '{{.title}}'] }]), [], 'other braces are literal');
  assert.ok(errors([{ name: 'x', command: 'gh', approve: 'yes' }]).some((e) => e.includes('approve must be a boolean')));
  assert.ok(errors([{ name: 'x', command: 'gh', shell: true }]).some((e) => e.includes('unknown key "shell"')));
  assert.ok(errors([{ name: 'x', command: 'gh' }, { name: 'x', command: 'gh' }]).some((e) => e.includes('duplicates name "x"')));
  assert.ok(errors([{ name: 'y', command: 'gh' }]).some((e) => e.includes('references "cli:x" but integrations.cli declares no "x"')));
});

test('command lines split like a shell without expanding anything', () => {
  assert.deepEqual(splitCommandLine(`gh issue create --title {title} --label "needs review" --body-file {body:file} 'a $HOME'`),
    ['gh', 'issue', 'create', '--title', '{title}', '--label', 'needs review', '--body-file', '{body:file}', 'a $HOME']);
  assert.throws(() => splitCommandLine('gh "open'), /Unclosed quote/);
});

test('generated agents get cli_ tools and run in the background; defaultTools keeps Pi tools only', () => {
  const generated = generateProject(model, {}, { piPackages: pkg.pi.packages });
  const agent = generated.files.find((f) => f.path === '.pi/agents/writer.md').content;
  assert.match(agent, /\ntools:\n  - read\n  - cli_show_body\n/);
  assert.match(agent, /\ndescription: "?writer"?\n/, 'pi-subagents skips agents without a description');
  const empty = generateProject({ ...model, agents: [{ name: 'quiet', model: 'fixture/small', tools: [] }] }, {}, { piPackages: pkg.pi.packages });
  assert.match(empty.files.find((f) => f.path === '.pi/agents/quiet.md').content, /\ntools:\nmodel: /, 'an empty allowlist is a bare key, never "[]"');
  assert.match(agent, /\nasync: true\n/);
  const settings = JSON.parse(generated.files.find((f) => f.path === '.pi/settings.json').content);
  assert.deepEqual(settings.defaultTools, ['read']);
  const caps = effectiveCapabilities(model, { piPackages: pkg.pi.packages });
  assert.deepEqual(caps.commands.map((c) => [c.name, c.approve, c.agents]), [['echo-title', true, ['lead']], ['show-body', false, ['writer']], ['unused', true, []]]);
  assert.equal(checkCapabilities(model, { settings, mcpJson: JSON.parse(generated.files.find((f) => f.path === '.pi/mcp.json')?.content ?? '{}') }, { piPackages: pkg.pi.packages }).ok, true);
});

test('a grant to a subagent with no tools list starts one', () => {
  const doc = { ...model, agents: [{ name: 'bare', model: 'fixture/small' }] };
  const granted = changeModel(yaml.stringify(doc), grantOps(doc, { name: 'echo-two', command: 'node', args: ['--version'], approve: false }, ['bare'])).model;
  assert.deepEqual(granted.agents[0].tools, ['cli:echo-two']);
  assert.throws(() => changeModel(yaml.stringify(doc), grantOps(doc, { name: 'echo-two', command: 'node', args: ['--version'] }, ['bare'])), /"bare" runs in the background, .*command echo-two/, 'a command that asks cannot go to a subagent');
});

test('grant and revoke edit the declaration, agent tools and enforced policies', () => {
  const text = yaml.stringify({ ...model, policies: { enforced: [{ agent: 'writer', tools: ['read', 'cli:show-body'] }] } });
  const base = changeModel(text, [{ op: 'set', target: 'packages', value: [] }]).model;
  const granted = changeModel(text, grantOps(base, { name: 'create-issue', command: 'gh', args: ['issue', 'create', '--title', '{title}'], approve: false }, ['lead', 'writer'])).model;
  assert.deepEqual(granted.integrations.cli.at(-1), { command: 'gh', args: ['issue', 'create', '--title', '{title}'], approve: false, name: 'create-issue' });
  assert.ok(granted.orchestrator.tools.includes('cli:create-issue'));
  assert.ok(granted.policies.enforced[0].tools.includes('cli:create-issue'), 'the policy ceiling is extended');
  assert.ok(granted.agents[0].tools.includes('cli:create-issue'), 'the agent list stays consistent');
  const revoked = changeModel(yaml.stringify(granted), revokeOps(granted, 'create-issue')).model;
  assert.equal(revoked.integrations.cli.some((c) => c.name === 'create-issue'), false);
  assert.equal(revoked.orchestrator.tools.includes('cli:create-issue'), false);
  assert.equal(revoked.policies.enforced[0].tools.includes('cli:create-issue'), false);
  assert.equal(revoked.agents[0].tools.includes('cli:create-issue'), false);
});

test('launch check reports a missing command once per agent, and approval a subagent cannot give', (t) => {
  const root = project(t);
  let probes = 0;
  const check = launchCheck(root, model, { probe: (cli) => { probes++; return cli !== 'node'; } });
  assert.deepEqual(check.problems.filter((p) => /not installed/.test(p.problem)).map((p) => p.agent).sort(), ['lead', 'writer']);
  assert.equal(probes, 1, 'each command is probed once');
  const asking = { ...model, agents: [{ name: 'writer', model: 'fixture/small', tools: ['cli:echo-title'] }] };
  assert.ok(launchCheck(root, asking, { probe: () => true }).problems.some((p) => p.agent === 'writer' && /"writer" runs in the background, .*command echo-title.*suggested fix: tools \[\]/.test(p.problem)));
  writeFileSync(join(root, '.pi/agents/writer.md'), '---\nname: writer\ntools: [read, cli_show_body]\nasync: true\n---\n');
  assert.ok(launchCheck(root, model, { probe: () => true }).problems.some((p) => p.agent === 'writer' && /misreads/.test(p.problem)));
});

test('/faur permissions adds, lists and removes commands as previewed design changes', async (t) => {
  const root = project(t);
  // Asking before each run, for a subagent: routed to the orchestrator.
  const mock = adapter({ choices: [0, 0] });
  const permissions = permissionsCommand(root);
  const command = (args) => permissions(args, mock.ctx);
  mock.inputs.push('create-issue', 'gh issue create --repo o/r --title {title} --body-file {body:file}', 'writer');
  await command('add');
  assert.match(mock.asked[1].title, /writer run in the background, where nobody can answer/);
  let doc = yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.deepEqual(doc.integrations.cli.find((c) => c.name === 'create-issue').args, ['issue', 'create', '--repo', 'o/r', '--title', '{title}', '--body-file', '{body:file}']);
  assert.ok(doc.orchestrator.tools.includes('cli:create-issue'));
  assert.equal(doc.agents[0].tools.includes('cli:create-issue'), false);

  await command('list');
  assert.match(mock.notices.at(-1).m, /create-issue: gh issue create --repo o\/r --title \{title\} --body-file \{body:file\}\n  agents: lead; asks before each run/);

  // Or kept for the subagent, without asking.
  const quiet = adapter({ choices: [0, 1] });
  quiet.inputs.push('list-issues', 'gh issue list --repo o/r', 'writer');
  await permissionsCommand(root)('add', quiet.ctx);
  doc = yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.equal(doc.integrations.cli.find((c) => c.name === 'list-issues').approve, false);
  assert.ok(doc.agents[0].tools.includes('cli:list-issues'));
  assert.match(readFileSync(join(root, '.pi/agents/writer.md'), 'utf8'), /cli_list_issues/);

  // pi-commands gets the change through the regenerated .pi/commands.json.
  const config = JSON.parse(readFileSync(join(root, '.pi/commands.json'), 'utf8'));
  assert.deepEqual(config.commands.find((c) => c.name === 'list-issues'), { name: 'list-issues', command: 'gh', args: ['issue', 'list', '--repo', 'o/r'], approve: false, lead: false });
  assert.equal(config.commands.find((c) => c.name === 'create-issue').lead, true);

  const declining = adapter({ confirm: false });
  await permissionsCommand(root)('remove create-issue', declining.ctx);
  assert.ok(yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8')).integrations.cli.some((c) => c.name === 'create-issue'), 'declined preview changes nothing');
  await command('remove create-issue');
  doc = yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.equal(doc.integrations.cli.some((c) => c.name === 'create-issue'), false);
  assert.equal(doc.orchestrator.tools.includes('cli:create-issue'), false);
});

test('capability check reports CLI presence without executing commands', async t => {
  const { checkAgent } = await import('../check.mjs');
  const root = project(t);
  const report = checkAgent(root);
  assert.ok(report.capabilities.some(c => c.name === 'cli:echo-title' && c.status === 'verified now' && /authentication.*not checked/i.test(c.fix)));
  assert.ok(report.capabilities.some(c => c.name === 'cli:unused' && c.status === 'verified now'));
});

test('capability check finds an absolute executable path', async t => {
  const { checkAgent } = await import('../check.mjs');
  const absolute = { ...model, orchestrator: { ...model.orchestrator, tools: ['cli:echo-title'] }, integrations: { cli: [{ name: 'echo-title', command: process.execPath, args: [] }] }, agents: [] };
  const root = project(t, absolute);
  const report = checkAgent(root);
  assert.ok(report.capabilities.some(c => c.name === 'cli:echo-title' && c.status === 'verified now'));
});
