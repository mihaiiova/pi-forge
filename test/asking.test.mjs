import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundAskingIssues, askingReach, leadTools } from '../src/asking.mjs';
import { capabilitySection } from '../src/agent-context.mjs';

const model = {
  orchestrator: { name: 'lead', tools: ['read', 'write', 'subagent', 'mcp', 'cli:file-issue'] },
  agents: [{ name: 'researcher', tools: ['read', 'mcp:seo', 'cli:file-issue', 'cli:list-issues'] }],
  integrations: {
    mcp: [{ name: 'seo', config: { url: 'http://localhost/mcp', includeTools: ['get_report'] } }],
    cli: [{ name: 'file-issue', command: 'gh', args: ['issue', 'create'] }, { name: 'list-issues', command: 'gh', args: ['issue', 'list'], approve: false }],
  },
};

test('background asking issues concern CLI approvals only and preserve MCP tools in fixes', () => {
  const [issue] = backgroundAskingIssues(model);
  assert.deepEqual(issue.cli, ['file-issue']);
  assert.deepEqual(issue.fix.value.tools, ['read', 'mcp:seo', 'cli:list-issues']);
  assert.match(issue.message, /command file-issue/);
  assert.deepEqual(askingReach(model, leadTools(model)).cli, ['file-issue']);
  assert.match(capabilitySection(model, 'lead'), /Only you can make the calls above that ask the user/);
  assert.doesNotMatch(capabilitySection(model, 'researcher'), /orchestrator makes the calls that ask/);
  const ruled = { ...model, policies: { enforced: [{ agent: 'researcher', tools: ['cli:file-issue'] }] } };
  assert.equal(backgroundAskingIssues(ruled)[0].fix, null);
});
