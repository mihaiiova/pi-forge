import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml } from '../src/yaml-loader.mjs';
import { generateProject } from '../src/generate.mjs';
import { planChange } from '../src/maintenance.mjs';
import { capabilitySection, staleMentions } from '../src/agent-context.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));
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
      { name: 'openseo', config: { url: 'http://localhost:3002/mcp', description: 'SEO data' } },
      { name: 'github-issues', config: { url: 'https://api.githubcopilot.com/mcp/x/issues', includeTools: ['list_issues', 'issue_write'] } },
    ],
    cli: [{ name: 'create-issue', description: 'Open an issue', command: 'gh', args: ['issue', 'create', '--title', '{title}'] }],
  },
  workflows: [{ name: 'handoff', entry: 'lead', approval: 'Create the issue with issue_write only after approval.' }],
};

function project(t, doc = model) {
  const root = mkdtempSync(join(tmpdir(), 'faur-ctx-'));
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

test("each agent's section lists exactly what it has", () => {
  const lead = capabilitySection(model, 'lead');
  assert.match(lead, /- \*\*Built-in tools:\*\* read\n/);
  assert.match(lead, /`openseo` \(all tools; tools named `mcp__openseo__<tool>`, found with tool_search\) — SEO data/);
  assert.match(lead, /`github-issues` \(only `mcp__github_issues__list_issues`, `mcp__github_issues__issue_write`\)/, 'includeTools are declared directly');
  assert.match(lead, /`cli_create_issue` — Open an issue: `gh issue create --title \{title\}`; the user approves each run/);
  assert.match(lead, /\*\*Specialists\*\* \(delegate with the subagent tool\):\n  - `seo` — Finds search opportunities\n  - `quiet`/);
  assert.doesNotMatch(lead, /request_permission/);
  const seo = capabilitySection(model, 'seo');
  assert.match(seo, /`openseo` \(only `mcp__openseo__get_report`\) — SEO data\n/, 'approval shown only for the selected tool');
  assert.doesNotMatch(seo, /github-issues|cli_create_issue|Specialists/);
  assert.match(seo, /- \*\*Other tools:\*\* web_search/);
  assert.match(seo, /- \*\*Skills:\*\*\n  - `audit` — Audit a site/);
  assert.match(seo, /report what is missing to the orchestrator/);
  const several = { ...model, agents: [{ name: 'seo', model: 'fixture/small', tools: ['mcp:openseo/get_report', 'mcp:openseo/run_audit', 'mcp:github-issues/list_issues'] }] };
  assert.match(capabilitySection(several, 'seo'), /  - `openseo` \(only `mcp__openseo__get_report`, `mcp__openseo__run_audit`\) — SEO data\n  - `github-issues` \(only `mcp__github_issues__list_issues`\)\n/, 'one line per server');
  assert.match(capabilitySection({ ...several, agents: [{ ...several.agents[0], tools: ['mcp:openseo/get_report', 'mcp:openseo'] }] }, 'seo'), /`openseo` \(all tools; /);
  assert.match(capabilitySection(model, 'quiet'), /- \*\*Built-in tools:\*\* none\n\nIf a task/);
  assert.equal(capabilitySection(model, 'nobody'), '');
});

test("the lead's generated section lists exactly the MCP tools .pi/mcp.json exposes", () => {
  const doc = { ...model, integrations: { ...model.integrations, mcp: [
    { name: 'posthog', config: { url: 'https://mcp.posthog.com/mcp', includeTools: ['query', 'list_insights', 'delete_*'], excludeTools: ['delete_*'] } },
    { name: 'openseo', config: { url: 'http://localhost:3002/mcp', excludeTools: ['drop_site'] } },
    { name: 'plain', config: { url: 'http://localhost:3003/mcp' } },
  ] } };
  const { files } = generateProject(doc, {}, { piPackages: pkg.pi.packages });
  const read = (path) => files.find((f) => f.path === path).content;
  const servers = JSON.parse(read('.pi/mcp.json')).mcpServers;
  const capabilities = read('.pi/APPEND_SYSTEM.md');
  const line = (name) => capabilities.split('\n').find((l) => l.startsWith(`  - \`${name}\` (`));
  const tools = (name, exposure) => Object.entries(servers[name].toolExposure ?? {}).filter(([, e]) => e === exposure).map(([t]) => `\`mcp__${name}__${t}\``);

  // includeTools: the direct tools, and nothing called "all tools".
  assert.equal(servers.posthog.exposure, 'hidden');
  assert.deepEqual(tools('posthog', 'direct'), ['`mcp__posthog__query`', '`mcp__posthog__list_insights`']);
  assert.match(line('posthog'), new RegExp(`\\(only ${tools('posthog', 'direct').join(', ')}\\)$`));
  assert.doesNotMatch(line('posthog'), /all tools|delete_/);
  // excludeTools: every tool except the hidden ones.
  assert.deepEqual(tools('openseo', 'hidden'), ['`mcp__openseo__drop_site`']);
  assert.match(line('openseo'), /\(all tools except `mcp__openseo__drop_site`; tools named `mcp__openseo__<tool>`, found with tool_search\)$/);
  // No filters: the whole server, deferred.
  assert.equal(servers.plain.exposure, 'deferred');
  assert.match(line('plain'), /\(all tools; tools named `mcp__plain__<tool>`, found with tool_search\)$/);
});

test('every agent file carries its own section: specialists in frontmatter, the lead after its prompt', () => {
  const { files } = generateProject(model, {}, { piPackages: pkg.pi.packages });
  const seo = files.find((f) => f.path === '.pi/agents/seo.md').content;
  assert.match(seo, /systemPrompt: \|\n  Research\.\n  \n  ## What you can use\n/);
  const append = files.find((f) => f.path === '.pi/APPEND_SYSTEM.md').content;
  assert.ok(append.includes(`${model.orchestrator.prompt}\n<!-- faur:derived v1 begin`), 'authored prompt first');
  assert.ok(append.includes(capabilitySection(model, 'lead')), 'then the generated section');
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

test('no agent is told about request_permission: a missing capability is reported, then added through Faur', () => {
  assert.doesNotMatch(capabilitySection(model, 'lead'), /request_permission/);
  assert.match(capabilitySection(model, 'lead'), /If a task needs something not listed, say what is missing\. Don't work around a missing capability\./);
});

test("settings keep Pi's built-in MCP on and the user's other extension entries", () => {
  const first = JSON.parse(generateProject(model, {}, { piPackages: pkg.pi.packages }).files.find((f) => f.path === '.pi/settings.json').content);
  assert.equal(first.extensions, undefined);
  assert.ok(!first.packages.some((p) => p.includes('pi-mcp-adapter')));
  const existing = { '.pi/settings.json': JSON.stringify({ extensions: ['-builtin:mcp', './my-ext.ts'] }) };
  const merged = JSON.parse(generateProject(model, existing, { piPackages: pkg.pi.packages }).files.find((f) => f.path === '.pi/settings.json').content);
  assert.deepEqual(merged.extensions, ['./my-ext.ts']);
});
