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
import { registerPermissions } from '../permissions-extension.mjs';
import {
  buildArgv, cliToolName, describeCall, grantOps, placeholders, readRequests, revokeOps, runCommand, splitCommandLine,
} from '../cli-tools.mjs';

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
  const root = mkdtempSync(join(tmpdir(), 'forge-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const generated = generateProject(doc, {}, { piPackages: pkg.pi.packages });
  assert.deepEqual(generated.errors, []);
  for (const f of generated.files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
    if (f.executable) chmodSync(join(root, f.path), 0o755);
  }
  writeFileSync(join(root, '.pi/system.yaml'), yaml.stringify(doc));
  mkdirSync(join(root, '.forge'), { recursive: true });
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

test('argv keeps each value one argument, writes file values and refuses option-like values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-argv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = ['issue', 'create', '--title', '{title}', '--body-file', '{body:file}'];
  assert.deepEqual(placeholders(args), [{ name: 'title', file: false }, { name: 'body', file: true }]);
  const argv = buildArgv(args, { title: 'A; rm -rf / && echo $(x)', body: '# Body\n' }, dir);
  assert.equal(argv[3], 'A; rm -rf / && echo $(x)');
  assert.equal(readFileSync(argv[5], 'utf8'), '# Body\n');
  assert.throws(() => buildArgv(args, { title: '--repo=evil', body: '' }, dir), /may not start with "-"/);
  assert.throws(() => buildArgv(args, { title: 'x' }, dir), /Missing value for \{body\}/);
  assert.throws(() => buildArgv(args, { title: 'x', body: 'y', extra: 'z' }, dir), /Unknown values: extra/);
  assert.match(describeCall({ command: 'gh', args }, { title: 'Hi there', body: 'Text' }), /^gh issue create --title 'Hi there' --body-file '<body file>'\n<body file>:\nText$/);
});

test('command lines split like a shell without expanding anything', () => {
  assert.deepEqual(splitCommandLine(`gh issue create --title {title} --label "needs review" --body-file {body:file} 'a $HOME'`),
    ['gh', 'issue', 'create', '--title', '{title}', '--label', 'needs review', '--body-file', '{body:file}', 'a $HOME']);
  assert.throws(() => splitCommandLine('gh "open'), /Unclosed quote/);
});

test('commands run without a shell and report output and exit status', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forge-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ok = await runCommand(root, { command: 'node', args: [...echoArg, '{title}'] }, { title: '$(touch pwned); `id`' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /exit 0\n\$\(touch pwned\); `id`$/);
  assert.equal(existsSync(join(root, 'pwned')), false);
  const failed = await runCommand(root, { command: 'node', args: ['-e', 'process.exit(3)'] }, {});
  assert.equal(failed.ok, false);
  assert.match(failed.text, /exit 3/);
  assert.match((await runCommand(root, { command: 'no-such-program-xyz', args: [] }, {})).text, /not installed or not on PATH/);
  const slow = await runCommand(root, { command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'] }, {}, { timeoutMs: 200 });
  assert.equal(slow.ok, false);
  assert.match(slow.text, /stopped: timed out after 0s\. It had started, so it may have had effects/);
  const controller = new AbortController();
  const pending = runCommand(root, { command: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'] }, {}, { signal: controller.signal });
  controller.abort();
  assert.match((await pending).text, /stopped: cancelled/);
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
  assert.equal(checkCapabilities(model, { settings, mcpJson: JSON.parse(generated.files.find((f) => f.path === '.pi/mcp.json').content) }, { piPackages: pkg.pi.packages }).ok, true);
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

test('the orchestrator gets only its commands; a subagent process gets all, bounded by its allowlist', (t) => {
  const root = project(t);
  const lead = adapter();
  const permissions = registerPermissions(lead.pi, lead.Type, root);
  assert.deepEqual(Object.keys(lead.tools).sort(), [cliToolName('echo-title'), 'request_permission']);
  assert.equal(typeof permissions, 'function', '/faur permissions');
  assert.deepEqual(lead.commands, {}, 'no command of its own');
  process.env.PI_SUBAGENT_CHILD = '1';
  t.after(() => { delete process.env.PI_SUBAGENT_CHILD; });
  const child = adapter();
  assert.equal(registerPermissions(child.pi, child.Type, root), undefined);
  assert.deepEqual(Object.keys(child.tools).sort(), ['cli_echo_title', 'cli_show_body', 'cli_unused']);
});

test('approval: allow once, allow for session, deny, and fail closed without a UI', async (t) => {
  const root = project(t);
  const mock = adapter({ choices: [0, 1, 2] });
  registerPermissions(mock.pi, mock.Type, root);
  const run = (title, ctx = mock.ctx) => mock.tools.cli_echo_title.execute('id', { title }, undefined, undefined, ctx);
  const once = await run('first');
  assert.equal(once.isError, undefined);
  assert.match(once.content[0].text, /first$/);
  assert.match(mock.asked[0].title, /node -e .* first/);
  assert.equal((await run('second')).isError, undefined, 'allowed for the session');
  assert.equal((await run('third')).isError, undefined, 'no prompt again this session');
  assert.equal(mock.asked.length, 2);
  const denying = adapter({ choices: [2] });
  registerPermissions(denying.pi, denying.Type, root);
  assert.match((await denying.tools.cli_echo_title.execute('id', { title: 'x' }, undefined, undefined, denying.ctx)).content[0].text, /denied/);
  const headless = adapter({ hasUI: false });
  registerPermissions(headless.pi, headless.Type, root);
  const blocked = await headless.tools.cli_echo_title.execute('id', { title: 'x' }, undefined, undefined, headless.ctx);
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /needs the user's approval/);
  assert.match((await run('--flag')).content[0].text, /may not start with "-"/);
});

test('a headless permission request is saved for review; nothing runs', async (t) => {
  const root = project(t);
  const mock = adapter({ hasUI: false });
  registerPermissions(mock.pi, mock.Type, root);
  const result = await mock.tools.request_permission.execute('id', { name: 'make-file', command: 'touch', args: ['{path}'], values: { path: 'made' }, reason: 'Need a marker file' }, undefined, undefined, mock.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /pending request/);
  assert.equal(existsSync(join(root, 'made')), false);
  assert.deepEqual(readRequests(root).map((r) => [r.name, r.command, r.args, r.reason]), [['make-file', 'touch', ['{path}'], 'Need a marker file']]);
});

test('an interactive request can run once, or be saved through the preview and run', async (t) => {
  const root = project(t);
  const echoArg = ['-e', "process.stdout.write(String(process.argv[1]))"];
  const once = adapter({ choices: [0] });
  registerPermissions(once.pi, once.Type, root);
  const ran = await once.tools.request_permission.execute('id', { name: 'say', command: 'node', args: [...echoArg, '{word}'], values: { word: 'hello' }, reason: 'Say hello' }, undefined, undefined, once.ctx);
  assert.match(ran.content[0].text, /hello$/);
  assert.equal(yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8')).integrations.cli.some((c) => c.name === 'say'), false);

  const always = adapter({ choices: [1] });
  registerPermissions(always.pi, always.Type, root);
  const saved = await always.tools.request_permission.execute('id', { name: 'say', command: 'node', args: [...echoArg, '{word}'], values: { word: 'again' }, reason: 'Say hello' }, undefined, undefined, always.ctx);
  assert.match(saved.content[0].text, /again\nSaved as cli_say/);
  assert.match(always.asked[1].title, /Save the command "say"/);
  const doc = yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.deepEqual(doc.integrations.cli.find((c) => c.name === 'say'), { command: 'node', args: [...echoArg, '{word}'], description: 'Say hello', name: 'say' });
  assert.ok(doc.orchestrator.tools.includes('cli:say'));
  assert.match(JSON.parse(readFileSync(join(root, '.forge/capabilities.json'), 'utf8')).commands.map((c) => c.name).join(), /say/);

  const stale = await always.tools.request_permission.execute('id', { name: 'say2', command: 'node', args: [...echoArg, '{other}'], reason: 'x' }, undefined, undefined, always.ctx);
  assert.match(stale.content[0].text, /already declared as cli_say.*after \/reload/);

  const again = adapter();
  registerPermissions(again.pi, again.Type, root);
  assert.match((await again.tools.request_permission.execute('id', { name: 'say2', command: 'node', args: [...echoArg, '{word}'], reason: 'x' }, undefined, undefined, again.ctx)).content[0].text, /already declared as cli_say/);
});

test('reader file placeholder warning accompanies request errors', async t => {
  const root = project(t);
  const mock = adapter();
  registerPermissions(mock.pi, mock.Type, root);
  const result = await mock.tools.request_permission.execute('id', { name: 'read-report', command: 'cat', args: ['{path:file}'], reason: 'Read report' }, undefined, undefined, mock.ctx);
  assert.match(result.content[0].text, /not a path to an existing file/);
});

test('/faur permissions adds, lists, reviews and removes commands', async (t) => {
  const root = project(t);
  // Asking before each run, for a subagent: routed to the orchestrator.
  const mock = adapter({ choices: [0, 0] });
  const permissions = registerPermissions(mock.pi, mock.Type, root);
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
  await registerPermissions(quiet.pi, quiet.Type, root)('add', quiet.ctx);
  doc = yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.equal(doc.integrations.cli.find((c) => c.name === 'list-issues').approve, false);
  assert.ok(doc.agents[0].tools.includes('cli:list-issues'));
  assert.match(readFileSync(join(root, '.pi/agents/writer.md'), 'utf8'), /cli_list_issues/);

  const headless = adapter({ hasUI: false });
  registerPermissions(headless.pi, headless.Type, root);
  await headless.tools.request_permission.execute('id', { name: 'list-files', command: 'ls', args: ['-la'], reason: 'Look around' }, undefined, undefined, headless.ctx);
  // A request that can't be saved stays pending; the review keeps going.
  await headless.tools.request_permission.execute('id', { name: 'echo-title', command: 'node', args: ['-p', '1'], reason: 'Name clash' }, undefined, undefined, headless.ctx);
  const reviewer = adapter({ choices: [0, 0] });
  await registerPermissions(reviewer.pi, reviewer.Type, root)('review', reviewer.ctx);
  assert.deepEqual(readRequests(root).map((r) => r.name), ['echo-title']);
  assert.match(reviewer.notices.find((n) => n.level === 'error').m, /echo-title: .*already exists; kept for later/);
  doc = yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.ok(doc.integrations.cli.some((c) => c.name === 'list-files'));
  assert.ok(doc.orchestrator.tools.includes('cli:list-files'));

  const declining = adapter({ confirm: false });
  await registerPermissions(declining.pi, declining.Type, root)('remove create-issue', declining.ctx);
  assert.ok(yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8')).integrations.cli.some((c) => c.name === 'create-issue'), 'declined preview changes nothing');
  await command('remove create-issue');
  doc = yaml.parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
  assert.equal(doc.integrations.cli.some((c) => c.name === 'create-issue'), false);
  assert.equal(doc.orchestrator.tools.includes('cli:create-issue'), false);
});

test('workflow approvals report the exact blocked command without queuing a request', async t => {
  const root = project(t);
  const approval = join(root, 'approval');
  const previous = process.env.FORGE_APPROVAL_FILE;
  const child = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.FORGE_APPROVAL_FILE = approval;
  t.after(() => { if (previous === undefined) delete process.env.FORGE_APPROVAL_FILE; else process.env.FORGE_APPROVAL_FILE = previous; if (child !== undefined) process.env.PI_SUBAGENT_CHILD = child; });
  const mock = adapter({ hasUI: false });
  registerPermissions(mock.pi, mock.Type, root);
  await mock.tools.cli_echo_title.execute('id', { title: 'x' }, undefined, undefined, mock.ctx);
  assert.match(readFileSync(approval, 'utf8'), /echo-title/);
  await mock.tools.request_permission.execute('id', { name: 'make-file', command: 'touch', args: ['{path}'], values: { path: 'made' }, reason: 'Need a marker file' }, undefined, undefined, mock.ctx);
  assert.match(readFileSync(approval, 'utf8'), /make-file.*touch/);
  assert.deepEqual(readRequests(root), []);
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
