import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../yaml-loader.mjs';
import { generateProject } from '../generate.mjs';
import { planChange } from '../maintenance.mjs';
import { registerAgent } from '../agent-extension.mjs';
import { capabilitySection, staleMentions } from '../agent-context.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../../../package.json'), 'utf8'));
const yaml = loadYaml();
const model = {
  schema: 1, name: 'ctx-test',
  orchestrator: { name: 'lead', model: 'fixture/large', tools: ['read', 'subagent', 'mcp', 'cli:create-issue'], prompt: 'Lead the growth work.\nBefore filing, check github-issues for duplicates with list_issues.\n' },
  agents: [
    { name: 'seo', description: 'Finds search opportunities', model: 'fixture/small', tools: ['read', 'mcp:openseo/get_report', 'web_search'], skills: ['audit'], prompt: 'Research.' },
    { name: 'quiet', model: 'fixture/small', tools: [] },
  ],
  skills: [{ name: 'audit', description: 'Audit a site', body: '# Audit' }],
  integrations: {
    mcp: [
      { name: 'openseo', config: { url: 'http://localhost:3002/mcp', description: 'SEO data', approveTools: ['run_*'] } },
      { name: 'github-issues', config: { url: 'https://api.githubcopilot.com/mcp/x/issues', includeTools: ['list_issues', 'issue_write'], approveTools: ['issue_write'] } },
    ],
    cli: [{ name: 'create-issue', description: 'Open an issue', command: 'gh', args: ['issue', 'create', '--title', '{title}'] }],
  },
  workflows: [{ name: 'handoff', entry: 'lead', approval: 'Create the issue with issue_write only after approval.' }],
};

function project(t, doc = model) {
  const root = mkdtempSync(join(tmpdir(), 'forge-ctx-'));
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

test("each agent's section lists exactly what it has", () => {
  const lead = capabilitySection(model, 'lead');
  assert.match(lead, /- \*\*Built-in tools:\*\* read\n/);
  assert.match(lead, /`openseo` \(all tools; tools named `mcp__openseo__<tool>`, found with tool_search\) — SEO data; asks the user before: run_\*/);
  assert.match(lead, /`github-issues` \(only `mcp__github_issues__list_issues`, `mcp__github_issues__issue_write`\) — asks the user before: issue_write/, 'includeTools are declared directly');
  assert.match(lead, /`cli_create_issue` — Open an issue: `gh issue create --title \{title\}`; the user approves each run/);
  assert.match(lead, /\*\*Specialists\*\* \(delegate with the subagent tool\):\n  - `seo` — Finds search opportunities\n  - `quiet`/);
  assert.match(lead, /ask with request_permission/);
  const seo = capabilitySection(model, 'seo');
  assert.match(seo, /`openseo` \(only `mcp__openseo__get_report`\) — SEO data\n/, 'approval shown only for the selected tool');
  assert.doesNotMatch(seo, /github-issues|cli_create_issue|Specialists/);
  assert.match(seo, /- \*\*Other tools:\*\* web_search/);
  assert.match(seo, /- \*\*Skills:\*\*\n  - `audit` — Audit a site/);
  assert.match(seo, /report what is missing to the orchestrator/);
  const several = { ...model, agents: [{ name: 'seo', model: 'fixture/small', tools: ['mcp:openseo/get_report', 'mcp:openseo/run_audit', 'mcp:github-issues/list_issues'] }] };
  assert.match(capabilitySection(several, 'seo'), /  - `openseo` \(only `mcp__openseo__get_report`, `mcp__openseo__run_audit`\) — SEO data; asks the user before: run_audit\n  - `github-issues` \(only `mcp__github_issues__list_issues`\)\n/, 'one line per server');
  assert.match(capabilitySection({ ...several, agents: [{ ...several.agents[0], tools: ['mcp:openseo/get_report', 'mcp:openseo'] }] }, 'seo'), /`openseo` \(all tools; /);
  assert.match(capabilitySection(model, 'quiet'), /- \*\*Built-in tools:\*\* none\n\nIf a task/);
  assert.equal(capabilitySection(model, 'nobody'), '');
});

test('CAPABILITIES.md lists exactly the MCP tools .pi/mcp.json exposes', () => {
  const doc = { ...model, integrations: { ...model.integrations, mcp: [
    { name: 'posthog', config: { url: 'https://mcp.posthog.com/mcp', includeTools: ['query', 'list_insights', 'delete_*'], excludeTools: ['delete_*'], approveTools: ['query'] } },
    { name: 'openseo', config: { url: 'http://localhost:3002/mcp', excludeTools: ['drop_site'], approveTools: true } },
    { name: 'plain', config: { url: 'http://localhost:3003/mcp' } },
  ] } };
  const { files } = generateProject(doc, {}, { piPackages: pkg.pi.packages });
  const read = (path) => files.find((f) => f.path === path).content;
  const servers = JSON.parse(read('.pi/mcp.json')).mcpServers;
  const capabilities = read('.pi/CAPABILITIES.md');
  const line = (name) => capabilities.split('\n').find((l) => l.startsWith(`  - \`${name}\` (`));
  const tools = (name, exposure) => Object.entries(servers[name].toolExposure ?? {}).filter(([, e]) => e === exposure).map(([t]) => `\`mcp__${name}__${t}\``);

  // includeTools: the direct tools, and nothing called "all tools".
  assert.equal(servers.posthog.exposure, 'hidden');
  assert.deepEqual(tools('posthog', 'direct'), ['`mcp__posthog__query`', '`mcp__posthog__list_insights`']);
  assert.match(line('posthog'), new RegExp(`\\(only ${tools('posthog', 'direct').join(', ')}\\) — asks the user before: query$`));
  assert.doesNotMatch(line('posthog'), /all tools|delete_/);
  // excludeTools: every tool except the hidden ones; approveTools: true asks for all.
  assert.deepEqual(tools('openseo', 'hidden'), ['`mcp__openseo__drop_site`']);
  assert.match(line('openseo'), /\(all tools except `mcp__openseo__drop_site`; tools named `mcp__openseo__<tool>`, found with tool_search\) — asks the user before every tool$/);
  // No filters: the whole server, deferred.
  assert.equal(servers.plain.exposure, 'deferred');
  assert.match(line('plain'), /\(all tools; tools named `mcp__plain__<tool>`, found with tool_search\)$/);
});

test('subagent files carry their section; the orchestrator file stays the authored prompt', () => {
  const { files } = generateProject(model, {}, { piPackages: pkg.pi.packages });
  const seo = files.find((f) => f.path === '.pi/agents/seo.md').content;
  assert.match(seo, /systemPrompt: \|\n  Research\.\n  \n  ## What you can use\n/);
  const append = files.find((f) => f.path === '.pi/APPEND_SYSTEM.md').content;
  assert.doesNotMatch(append, /What you can use/);
});

test('removing a capability lists the instructions that still mention it', () => {
  const without = { ...model, orchestrator: { ...model.orchestrator, tools: ['read', 'subagent', 'mcp'] }, integrations: { ...model.integrations, mcp: [model.integrations.mcp[0]], cli: [] } };
  const stale = staleMentions(model, without);
  assert.deepEqual(stale.map((s) => [s.removed, s.where]), [
    ['MCP server github-issues', 'orchestrator (lead) prompt'],
    ['MCP server github-issues', 'workflow handoff'],
  ]);
  assert.deepEqual(stale[0].lines, ['Before filing, check github-issues for duplicates with list_issues.']);
  assert.deepEqual(staleMentions(model, model), []);
  assert.deepEqual(staleMentions(model, { ...model, integrations: { ...model.integrations, mcp: [{ name: 'github', config: { url: 'x' } }, model.integrations.mcp[0]] } }).map((s) => s.removed), ['MCP server github-issues', 'MCP server github-issues'], 'a different name does not hide the removal');
});

test('the change preview carries stale mentions so the proposal can fix them', (t) => {
  const root = project(t);
  const plan = planChange(root, [
    { op: 'remove', target: 'mcp', name: 'github-issues' },
  ]);
  assert.equal(plan.preview.staleMentions.mentions.length, 2);
  assert.match(plan.preview.staleMentions.note, /Update them in the same proposal/);
  const fixed = planChange(root, [
    { op: 'remove', target: 'mcp', name: 'github-issues' },
    { op: 'set', target: 'orchestrator', value: { ...model.orchestrator, prompt: 'Lead the growth work.\n' } },
    { op: 'update', target: 'workflow', name: 'handoff', value: { approval: 'Create issues only after approval.' } },
  ]);
  assert.equal(fixed.preview.staleMentions, undefined);
});

test("the orchestrator's section is build output, added at session start only when Pi was not launched with it", (t) => {
  const root = project(t);
  const capabilities = readFileSync(join(root, '.pi/CAPABILITIES.md'), 'utf8');
  assert.equal(capabilities, capabilitySection(model, 'lead'));
  assert.match(readFileSync(join(root, 'run'), 'utf8'), /for f in \.pi\/APPEND_SYSTEM\.md \.pi\/CAPABILITIES\.md; do/);
  const start = (argv) => {
    const events = {};
    const pi = { registerTool: () => {}, registerCommand: () => {}, on: (n, cb) => { (events[n] ??= []).push(cb); }, getActiveTools: () => [], setActiveTools: () => {}, getAllTools: () => [], sendUserMessage: () => {} };
    const Type = Object.fromEntries(['Object', 'Union', 'Literal', 'Optional', 'String', 'Number', 'Array', 'Record'].map((k) => [k, (v) => v]));
    registerAgent(pi, Type, root, { argv });
    events.session_start.forEach((cb) => cb({}, { hasUI: false, ui: {} }));
    let prompt = 'BASE';
    for (const cb of events.before_agent_start) prompt = cb({ systemPrompt: prompt })?.systemPrompt ?? prompt;
    return prompt;
  };
  const launched = start(['node', 'pi', '--append-system-prompt', '.pi/CAPABILITIES.md']);
  assert.doesNotMatch(launched, /What you can use/, './run appends the generated file; the runtime adds nothing');
  assert.match(launched, /## Memory/);
  writeFileSync(join(root, '.pi/CAPABILITIES.md'), '## What you can use\n\nFROM THE BUILD\n');
  assert.match(start(['node', 'pi']), /FROM THE BUILD/, 'an old launcher or plain pi: the built file is added');
  rmSync(join(root, '.pi/CAPABILITIES.md'));
  assert.match(start(['node', 'pi']), /## What you can use\n[\s\S]*`cli_create_issue`/, 'a project from before the file: rendered');
});

test("settings keep Pi's built-in MCP on and the user's other extension entries", () => {
  const first = JSON.parse(generateProject(model, {}, { piPackages: pkg.pi.packages }).files.find((f) => f.path === '.pi/settings.json').content);
  assert.equal(first.extensions, undefined);
  assert.ok(!first.packages.some((p) => p.includes('pi-mcp-adapter')));
  const existing = { '.pi/settings.json': JSON.stringify({ extensions: ['-builtin:mcp', './my-ext.ts'] }) };
  const merged = JSON.parse(generateProject(model, existing, { piPackages: pkg.pi.packages }).files.find((f) => f.path === '.pi/settings.json').content);
  assert.deepEqual(merged.extensions, ['./my-ext.ts']);
});

test('session start warns once per missing provider without reading credentials', t => {
  const root = project(t, { ...model, orchestrator: { ...model.orchestrator, model: 'deepseek/chat' }, agents: [{ name: 'one', model: 'openai/a' }, { name: 'two', model: 'openai/b' }] });
  const events = {};
  const pi = { registerTool() {}, on(n, cb) { (events[n] ??= []).push(cb); }, getActiveTools: () => [], setActiveTools() {} };
  const Type = Object.fromEntries(['Object', 'Union', 'Literal', 'Optional', 'String', 'Number', 'Array', 'Record'].map(k => [k, v => v]));
  registerAgent(pi, Type, root);
  const notices = [];
  const ctx = { hasUI: true, ui: { notify: text => notices.push(text) }, modelRegistry: { getProviderAuthStatus: provider => ({ configured: provider === 'openai' }) } };
  for (const cb of events.session_start) cb({}, ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /deepseek.*\/login deepseek.*DEEPSEEK_API_KEY/);
});

test('credential notice skips headless sessions and missing models', t => {
  const root = project(t, model);
  const events = {};
  const pi = { registerTool() {}, on(n, cb) { (events[n] ??= []).push(cb); }, getActiveTools: () => [], setActiveTools() {} };
  const Type = Object.fromEntries(['Object', 'Union', 'Literal', 'Optional', 'String', 'Number', 'Array', 'Record'].map(k => [k, v => v]));
  registerAgent(pi, Type, root);
  const notices = [];
  const ctx = { hasUI: false, ui: { notify: x => notices.push(x) }, modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) } };
  for (const cb of events.session_start) cb({}, ctx);
  assert.deepEqual(notices, []);
  rmSync(join(root, '.pi/system.yaml'));
  for (const cb of events.session_start) cb({}, { ...ctx, hasUI: true });
  assert.deepEqual(notices, []);
});
