import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundAskingIssues, askingReach, leadTools } from '../asking.mjs';
import { capabilitySection } from '../agent-context.mjs';
import { changeModel, parsedModel } from '../changes.mjs';
import { loadYaml } from '../yaml-loader.mjs';

const yaml = loadYaml();
const model = {
  schema: 1, name: 'asking-test',
  orchestrator: { name: 'lead', model: 'fixture/large', tools: ['read', 'write', 'subagent', 'mcp', 'cli:file-issue'] },
  agents: [
    { name: 'researcher', model: 'fixture/small', tools: ['read', 'mcp:seo', 'mcp:docs'] },
    { name: 'writer', model: 'fixture/small', tools: ['read', 'write'] },
  ],
  integrations: {
    mcp: [
      { name: 'seo', config: { url: 'http://localhost:3002/mcp', includeTools: ['get_report', 'research_keywords', 'get_serp'], approveTools: ['research_keywords', 'get_serp'] } },
      { name: 'docs', config: { url: 'http://localhost:3003/mcp' } },
    ],
    cli: [{ name: 'file-issue', description: 'File an issue', command: 'gh', args: ['issue', 'create', '--title', '{title}'] }],
  },
};

test('issues carry a ready fix: the same tools without the asking part', () => {
  const [issue, ...rest] = backgroundAskingIssues(model);
  assert.equal(rest.length, 0);
  assert.equal(issue.agent, 'researcher');
  assert.deepEqual(issue.mcp, { seo: ['research_keywords', 'get_serp'] });
  assert.deepEqual(issue.fix, { op: 'update', target: 'agent', name: 'researcher', value: { tools: ['read', 'mcp:seo/get_report', 'mcp:docs'] } });
  const unlisted = { ...model, integrations: { ...model.integrations, mcp: [{ name: 'seo', config: { url: 'x', approveTools: ['run_*'] } }, model.integrations.mcp[1]] } };
  assert.equal(backgroundAskingIssues(unlisted)[0].fix, null, "unknown tool lists can't be split");
  const ruled = { ...model, policies: { enforced: [{ agent: 'researcher', tools: ['read', 'mcp:seo'] }] } };
  assert.match(backgroundAskingIssues(ruled)[0].message, /edit its enforced tools rule/);
  assert.equal(backgroundAskingIssues(ruled)[0].fix, null);
});

test('a project that already has the issue stays revisable; changes may fix it but not add one', () => {
  const text = yaml.stringify(model);
  assert.equal(parsedModel(text).name, 'asking-test');
  assert.equal(changeModel(text, [{ op: 'assign', name: 'writer', model: 'fixture/large' }]).model.agents[1].model, 'fixture/large', 'an unrelated change still goes through');
  const fixed = changeModel(text, [backgroundAskingIssues(model)[0].fix]).model;
  assert.deepEqual(backgroundAskingIssues(fixed), []);
  assert.throws(() => changeModel(text, [{ op: 'update', target: 'agent', name: 'writer', value: { tools: ['read', 'mcp:seo/get_serp'] } }]), /"writer" runs in the background/);
});

test("generated sections route calls that ask to the orchestrator", () => {
  const fixed = changeModel(yaml.stringify(model), [backgroundAskingIssues(model)[0].fix]).model;
  assert.deepEqual([...askingReach(fixed, leadTools(fixed)).mcp], [['seo', ['research_keywords', 'get_serp']]]);
  assert.deepEqual(askingReach(fixed, leadTools(fixed)).cli, ['file-issue']);
  assert.match(capabilitySection(fixed, 'lead'), /Only you can make the calls above that ask the user: specialists run in the background.*\(save it to a project file and give the specialist its path\)\./);
  const researcher = capabilitySection(fixed, 'researcher');
  assert.match(researcher, /`seo` \(only `mcp__seo__get_report`\)/);
  assert.match(researcher, /The orchestrator makes the calls that ask the user, which you can't: seo research_keywords, get_serp\. When you need one, report the exact call/);
  assert.doesNotMatch(capabilitySection(fixed, 'writer'), /calls that ask/, 'only agents that use that server');
  const noWrite = { ...fixed, orchestrator: { ...fixed.orchestrator, tools: ['subagent', 'mcp'] } };
  assert.doesNotMatch(capabilitySection(noWrite, 'lead'), /project file/);
  const solo = { ...fixed, agents: [] };
  assert.doesNotMatch(capabilitySection(solo, 'lead'), /Only you can/, 'no specialists, nothing to route');
});

test('check-agent reports existing background approval problems instead of aborting validation', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'faur-asking-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'), { recursive: true });
  writeFileSync(join(root, '.pi/system.yaml'), yaml.stringify(model));
  writeFileSync(join(root, '.pi/settings.json'), '{}');
  writeFileSync(join(root, '.pi/mcp.json'), '{}');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../faur.mjs', import.meta.url)), 'check-agent', root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.ok(JSON.parse(run.stdout).checks.launch.some(s => s.includes('background')));
});
