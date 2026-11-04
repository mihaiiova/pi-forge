import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateProject } from '../generate.mjs';
import { launchCheck } from '../launch-check.mjs';

const SHA = '17772c7a80b7b8c7a47af30f648374cd8bd8adc5';
const model = {
  schema: 1, name: 'launch', orchestrator: { name: 'lead', model: 'p/m' },
  agents: [
    { name: 'seo', model: 'p/m', tools: ['read', 'mcp:seo/audit', 'web_search'], skills: ['audit'] },
    { name: 'all', model: 'p/m', tools: ['mcp:seo'] },
    { name: 'gh', model: 'p/m', tools: ['mcp:github'] },
    { name: 'plain', model: 'p/m', tools: ['read'] },
  ],
  skills: [{ name: 'audit', source: `skills:acme/skills/audit@${SHA}` }],
  integrations: { mcp: [{ name: 'seo', config: { url: 'http://x', excludeTools: ['delete_*'] } }, { name: 'github', config: { url: 'https://y' } }] },
};

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const f of generateProject(model, {}).files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
  }
  return root;
}
const problems = (root, opts) => launchCheck(root, model, opts).problems.map((p) => `${p.agent}: ${p.problem}`);

test('launch check reports missing MCP tools, extension tools, skills and unverified foreground extension loading', (t) => {
  const root = project(t);
  const mcpTools = [{ name: 'mcp__seo__delete_all', exposure: 'hidden' }, { name: 'mcp__seo__list', exposure: 'deferred' }];
  const found = problems(root, { registeredTools: ['read'], mcpTools });
  assert.ok(found.includes('seo: mcp:seo/audit: "seo" does not offer "audit"'));
  assert.ok(found.includes('seo: web_search: no loaded extension registers this tool'));
  assert.ok(found.includes('seo: skill "audit" is not installed at .agents/skills/audit/'));
  assert.ok(found.includes('gh: mcp:github: "github" has not connected or offers no tools; /mcp shows why'));
  assert.ok(!found.some((p) => p.startsWith('all:')), 'list is exposed');
  assert.ok(!found.some((p) => p.startsWith('plain:')));
  assert.ok(found.some((p) => p.includes('foreground extension loading is not verified')));
  assert.ok(!problems(root, { registeredTools: ['read'] }).some((p) => p.includes('"github"')), 'servers connect after session start; without mcpTools they are not checked');

  // A hidden tool can't be selected.
  const hidden = launchCheck(root, { ...model, agents: [{ name: 'del', model: 'p/m', tools: ['mcp:seo/delete_all'] }] }, { mcpTools }).problems;
  assert.ok(hidden.some((p) => p.problem === 'mcp:seo/delete_all: "delete_all" is hidden by includeTools, excludeTools or a hide policy'));

  // Everything present: no problems.
  mkdirSync(join(root, '.agents/skills/audit'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/audit/SKILL.md'), '---\nname: audit\n---\n');
  assert.deepEqual(problems(root, { registeredTools: ['web_search'], mcpTools: [{ name: 'mcp__seo__audit', exposure: 'deferred' }, { name: 'mcp__github__issue_read', exposure: 'deferred' }] }), ['seo: web_search: foreground extension loading is not verified; the native agent tools list must include the providing extension path']);


});

test('launch check warns about unignored secrets in a git work tree', t => {
  const root = project(t);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  const found = problems(root, {});
  assert.ok(found.some(p => p.includes('.env') && p.includes('not ignored')));
  assert.ok(found.some(p => p.includes('.faur/') && p.includes('not ignored')));
  writeFileSync(join(root, '.gitignore'), '.env\n.faur/\n');
  assert.ok(!problems(root, {}).some(p => p.includes('not ignored')));
});

test('launch check respects git negation and skips unavailable git', t => {
  const root = project(t);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), '.env\n.faur/\n!.env\n!.faur/\n');
  assert.equal(problems(root, {}).filter(p => p.includes('not ignored')).length, 2);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.ok(!problems(root, {}).some(p => p.includes('not ignored')));
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test('launch check reports missing orchestrator extension tools', t => {
  const root = project(t);
  const configured = { ...model, orchestrator: { ...model.orchestrator, tools: ['read', 'missing_extension'] }, agents: [] };
  assert.ok(launchCheck(root, configured, { registeredTools: ['read'] }).problems.some(p => p.agent === 'lead' && p.problem.includes('missing_extension')));
});

test('capability report distinguishes connected and cached MCP evidence', async t => {
  const { checkAgent } = await import('../check.mjs');
  const { loadYaml } = await import('../yaml-loader.mjs');
  const root = project(t);
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  const connected = [{ name: 'seo', state: 'connected', tools: ['audit'] }, { name: 'github', state: 'connected', tools: ['issue_read'] }];
  const live = checkAgent(root, { mcpServers: connected });
  assert.ok(live.capabilities.some(c => c.agent === 'seo' && c.name === 'mcp:seo/audit' && c.status === 'verified now'));
  const cached = checkAgent(root);
  assert.ok(cached.capabilities.some(c => c.agent === 'seo' && c.name === 'mcp:seo/audit' && c.status.startsWith('last seen ')));
});

test('check-agent --connect verifies a local MCP server without a model call', async t => {
  const { loadYaml } = await import('../yaml-loader.mjs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = project(t);
  const server = fileURLToPath(new URL('./fixtures/mcp/server.mjs', import.meta.url));
  const faur = fileURLToPath(new URL('../faur.mjs', import.meta.url));
  const doc = { ...model, agents: [{ name: 'seo', model: 'p/m', tools: ['mcp:seo/audit'] }], skills: [], integrations: { mcp: [{ name: 'seo', config: { command: process.execPath, args: [server], env: { MCP_TOOLS: 'audit' } } }] } };
  for (const f of generateProject(doc, {}).files) { mkdirSync(dirname(join(root, f.path)), { recursive: true }); writeFileSync(join(root, f.path), f.content); }
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(doc));
  // Like a project ./run has started: trusted per run, never saved. Pi's shell
  // commands read only saved trust, so --connect saves it in this project's home.
  const run = spawnSync(process.execPath, [faur, 'check-agent', root, '--connect'], { encoding: 'utf8', timeout: 30000 });
  const connected = JSON.parse(run.stdout);
  assert.ok(connected.capabilities.some(c => c.name === 'mcp:seo/audit' && c.status === 'verified now'), run.stderr);
  assert.match(connected.trustSaved, /\.faur\/pi-home\/trust\.json$/);
  assert.equal(JSON.parse(readFileSync(join(root, '.faur/pi-home/trust.json'), 'utf8'))[realpathSync(root)], true);
  const mcp = JSON.parse(readFileSync(join(root, '.pi/mcp.json'), 'utf8'));
  mcp.mcpServers.seo.args = ['-e', "console.error('fixture connection failed'); process.exit(1)"];
  writeFileSync(join(root, '.pi/mcp.json'), JSON.stringify(mcp));
  const broken = spawnSync(process.execPath, [faur, 'check-agent', root, '--connect'], { encoding: 'utf8', timeout: 30000 });
  const report = JSON.parse(broken.stdout);
  assert.equal(broken.status, 1);
  assert.ok(report.capabilities.some(c => c.name === 'mcp:seo/audit' && c.status === 'missing' && c.fix.includes('fixture connection failed')));
});

test('a session with no registered MCP tools does not claim a live connection', async t => {
  const { checkAgent } = await import('../check.mjs');
  const { loadYaml } = await import('../yaml-loader.mjs');
  const root = project(t);
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  const report = checkAgent(root, { mcpTools: [] });
  assert.ok(report.capabilities.some(c => c.name === 'mcp:seo/audit' && c.status === 'not verifiable'));
});

test('capability report includes orchestrator skills and their provider', async t => {
  const { checkAgent } = await import('../check.mjs');
  const { loadYaml } = await import('../yaml-loader.mjs');
  const root = project(t);
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  const report = checkAgent(root);
  assert.ok(report.capabilities.some(c => c.agent === 'lead' && c.name === 'skill:audit' && c.status === 'missing' && c.provider.includes('.agents/skills/audit')));
});

test('live launch check does not assume a missing extension is an uninstalled package', t => {
  const root = project(t);
  const declared = { ...model, orchestrator: { ...model.orchestrator, tools: ['subagent'] } };
  const result = launchCheck(root, declared, { registeredTools: [] });
  assert.ok(result.problems.some(p => p.problem.includes('subagent: no loaded extension')));
  assert.ok(result.problems.every(p => !p.problem.includes("run ./run once")));
});

test('the check reports a user-level package that replaces built-in MCP, and declared env names that are unset', async t => {
  const { checkProject, hostConflicts } = await import('../check.mjs');
  const { generateProject } = await import('../generate.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const yaml = (await import('../yaml-loader.mjs')).loadYaml();
  const root = mkdtempSync(join(tmpdir(), 'faur-host-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = { schema: 1, name: 'host-check', orchestrator: { name: 'lead', model: 'p/m', tools: ['read', 'mcp'] }, integrations: { env: [{ name: 'DOCS_TOKEN', secret: true }], mcp: [{ name: 'docs', config: { url: 'http://localhost:3002/mcp' } }] } };
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), yaml.stringify(model));
  for (const f of generateProject(model, {}).files) { mkdirSync(dirname(join(root, f.path)), { recursive: true }); writeFileSync(join(root, f.path), f.content); }
  const host = join(root, 'host');
  mkdirSync(host);
  writeFileSync(join(host, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter@2.32.1', 'npm:pi-subagents@0.65.0'] }));
  const launch = checkProject(root, { env: {}, hostAgentDir: host }).launch;
  assert.ok(launch.some(p => /plain pi: pi-mcp-adapter .* replaces Pi's built-in MCP support.*disable the conflicting extension/.test(p)), launch.join('\n'));
  assert.ok(launch.some(p => /integrations\.env DOCS_TOKEN: not set in this environment/.test(p)));
  assert.ok(!checkProject(root, { env: { DOCS_TOKEN: 'x' }, hostAgentDir: host }).launch.some(p => /DOCS_TOKEN/.test(p)), 'a set name is not reported');
  mkdirSync(join(root, '.faur/pi-home'), { recursive: true });
  assert.deepEqual(hostConflicts(root, model, { agentDir: join(root, '.faur/pi-home') }), [], 'a caller-selected clean configuration has no conflict');
  assert.match(hostConflicts(root, model, { agentDir: join(root, 'none'), mcpCommand: 'npm:other-mcp@1.0.0' })[0], /\/mcp comes from npm:other-mcp@1\.0\.0/, 'the session reports who owns /mcp');
  assert.deepEqual(hostConflicts(root, model, { agentDir: join(root, 'none'), mcpCommand: 'builtin' }), []);
  assert.deepEqual(hostConflicts(root, { ...model, integrations: {} }, { agentDir: host }), [], 'a design without MCP does not depend on it');
});
