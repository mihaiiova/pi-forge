import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSystem } from '../src/validate.mjs';
import { generateProject } from '../src/generate.mjs';
import { planChange, applyChange } from '../src/maintenance.mjs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadYaml } from '../src/yaml-loader.mjs';

const model = { schema: 1, name: 'example', description: 'Example', orchestrator: { name: 'lead', model: 'openai/gpt-4o' }, skills: [{ name: 'marketing' }] };

test('document and workflow abstractions are rejected', () => {
  for (const field of ['documents', 'workflows']) {
    const result = validateSystem({ ...model, [field]: [] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), new RegExp(`unknown key "${field}"`));
  }
});

test('developer-owned skills are not generated or overwritten', () => {
  const path = '.pi/skills/marketing/SKILL.md';
  const authored = '---\nname: marketing\ndescription: Marketing\n---\n\nOwner instructions\n';
  const plan = generateProject(model, { [path]: authored });
  assert.equal(plan.files.some(file => file.path === path), false);
});

test('approved changes preserve edited skills and refuse removal while they still load', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-owned-skill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of generateProject(model, {}).files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  const path = '.pi/skills/marketing/SKILL.md';
  mkdirSync(dirname(join(root, path)), { recursive: true });
  const authored = '---\nname: marketing\ndescription: Marketing\n---\n\nDeveloper edits.\n';
  writeFileSync(join(root, path), authored);
  mkdirSync(join(root, '.faur'), { recursive: true });
  writeFileSync(join(root, '.faur/build.json'), JSON.stringify({ declarations: { scaffolds: [path], vendoredSkills: [], registrySkills: [] } }));
  assert.throws(() => planChange(root, [{ op: 'remove', target: 'skill', name: 'marketing' }]), /Removed local skill still loads/);
  const plan = planChange(root, [{ op: 'assign', name: 'lead', model: 'openai/gpt-4o' }]);
  assert.equal(plan.preview.warnings.some(w => w.includes('Declared local skill marketing is missing')), false);
  assert.equal(Object.hasOwn(plan.writes, path), false);
  applyChange(root, plan, true);
  assert.equal(readFileSync(join(root, path), 'utf8'), authored);
});

test('maintenance warns when a declared local skill is missing', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-missing-skill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of generateProject(model, {}).files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  const plan = planChange(root, [{ op: 'assign', name: 'lead', model: 'openai/gpt-4o' }]);
  assert.ok(plan.preview.warnings.some(w => w.includes('Declared local skill marketing is missing')));
});

test('Owlie reference retains marketing procedures and scoped commands in ordinary files', () => {
  const fixture = new URL('./fixtures/owlie-marketing/.pi/', import.meta.url);
  const design = loadYaml().parse(readFileSync(new URL('system.yaml', fixture), 'utf8'));
  const skill = readFileSync(new URL('skills/marketing/SKILL.md', fixture), 'utf8');
  assert.equal(validateSystem(design).ok, true);
  assert.equal(Object.hasOwn(design, 'documents'), false);
  assert.equal(Object.hasOwn(design, 'workflows'), false);
  for (const expected of ['reports/marketing-latest.md', 'reports/history.md', 'memory/marketing.md', 'Cite sources and dates', 'obtain approval', '1000 words']) assert.ok(skill.includes(expected), expected);
  const generated = generateProject(design, {});
  assert.equal(generated.files.some(file => file.path === '.pi/skills/marketing/SKILL.md'), false);
  const commands = JSON.parse(generated.files.find(file => file.path === '.pi/commands.json').content).commands;
  assert.equal(commands.length, 7);
  assert.equal(commands.find(command => command.name === 'find-issues').approve, false);
  for (const name of ['create-marketing-issue', 'edit-issue-body', 'edit-issue-title', 'create-label', 'label-marketing-issue']) assert.equal(commands.find(command => command.name === name).approve, true, name);
});
