import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSystem } from '../src/validate.mjs';
import { generateProject } from '../src/generate.mjs';
import { planChange, applyChange, approvalSummary, inspectProject } from '../src/maintenance.mjs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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

// Faur drafts an agent's procedures as skills and writes them through the
// one approved change path (#75 amendment, 2026-11-06).
const reportSkill = (name = 'weekly-report', extra = '') => `---\nname: ${name}\ndescription: Use when asked for the weekly report.\n---\n\n# Weekly report\n\nWrite reports/weekly.md with Summary and Next steps.${extra}\n`;
function generated(t, design = model, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'faur-skill-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of generateProject(design, {}).files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  writeFileSync(join(root, '.pi/system.yaml'), extra.systemYaml ?? loadYaml().stringify(design));
  return root;
}
const base = { ...model, skills: [] };

test('a skill proposal carries its SKILL.md; system.yaml records only the declaration', t => {
  const root = generated(t, base);
  const op = { op: 'add', target: 'skill', name: 'weekly-report', value: { description: 'Use when asked for the weekly report.' }, content: reportSkill() };
  const plan = planChange(root, [op]);
  const path = '.pi/skills/weekly-report/SKILL.md';
  assert.equal(plan.writes[path], reportSkill());
  assert.ok(!plan.writes['.pi/system.yaml'].includes('Next steps'), 'the procedure is not copied into the design');
  assert.deepEqual(plan.preview.files.find(file => file.path === path)?.action, 'create');
  assert.ok(approvalSummary(root, plan).some(line => /Creates skill weekly-report/.test(line)));
  applyChange(root, plan, true);
  assert.equal(readFileSync(join(root, path), 'utf8'), reportSkill());
  // Afterwards the file is the developer's: an unrelated change leaves an edit alone.
  writeFileSync(join(root, path), reportSkill('weekly-report', '\nOwner tweak.'));
  applyChange(root, planChange(root, [{ op: 'assign', name: 'lead', model: 'openai/gpt-4o' }]), true);
  assert.match(readFileSync(join(root, path), 'utf8'), /Owner tweak/);
});

test('updating a skill replaces the whole file after preview, and a later edit makes the preview stale', t => {
  const root = generated(t, { ...model, skills: [{ name: 'weekly-report' }] });
  const path = '.pi/skills/weekly-report/SKILL.md';
  mkdirSync(join(root, '.pi/skills/weekly-report'), { recursive: true });
  writeFileSync(join(root, path), reportSkill());
  const next = reportSkill('weekly-report', '\nAt most 300 words.');
  const plan = planChange(root, [{ op: 'update', target: 'skill', name: 'weekly-report', content: next }]);
  assert.match(plan.preview.files.find(file => file.path === path).diff, /\+ At most 300 words/);
  writeFileSync(join(root, path), reportSkill('weekly-report', '\nEdited meanwhile.'));
  assert.throws(() => applyChange(root, plan, true), /changed since preview/);
  assert.match(readFileSync(join(root, path), 'utf8'), /Edited meanwhile/);
});

test('skill content must name the skill, say when to use it, and belong to a local skill', t => {
  const root = generated(t, base);
  const add = (content, value = {}) => planChange(root, [{ op: 'add', target: 'skill', name: 'weekly-report', value, content }]);
  assert.throws(() => add('# no frontmatter\n'), /frontmatter must start with name: weekly-report/);
  assert.throws(() => add(reportSkill('other')), /frontmatter must start with name: weekly-report/);
  assert.throws(() => add('---\nname: weekly-report\n---\nBody\n'), /needs a description/);
  assert.throws(() => add(reportSkill(), { source: 'skills:o/r/d@' + 'a'.repeat(40) }), /only for a local skill/);
  assert.throws(() => planChange(root, [{ op: 'add', target: 'env', name: 'X', value: {}, content: 'x' }]), /only for adding or updating a local skill/);
});

test('a design with documents or workflows migrates in one approved change', t => {
  const placeholder = readFileSync(new URL('./fixtures/legacy-workflow/analyze-and-draft.SKILL.md', import.meta.url), 'utf8');
  const legacyYaml = loadYaml().stringify({ ...base,
    workflows: [{ name: 'analyze-and-draft', entry: 'lead', trigger: { kind: 'manual' } }],
    documents: [{ name: 'brief', writer: 'lead', path: 'reports/brief.md', sections: [{ heading: 'Summary' }] }] });
  for (const edited of [false, true]) {
    const root = generated(t, base, { systemYaml: legacyYaml });
    const old = '.pi/skills/analyze-and-draft/SKILL.md';
    mkdirSync(join(root, '.pi/skills/analyze-and-draft'), { recursive: true });
    writeFileSync(join(root, old), edited ? placeholder.replace('# analyze-and-draft', '# analyze-and-draft (mine)') : placeholder);
    mkdirSync(join(root, '.faur'), { recursive: true });
    writeFileSync(join(root, '.faur/build.json'), JSON.stringify({ declarations: { scaffolds: [old], vendoredSkills: [], registrySkills: [] } }));
    const inspection = inspectProject(root);
    assert.deepEqual(Object.keys(inspection.legacy.declarations).sort(), ['documents', 'workflows']);
    const plan = planChange(root, [{ op: 'add', target: 'skill', name: 'brief', value: { description: 'Use when asked for a brief.' }, content: reportSkill('brief') }]);
    const design = loadYaml().parse(plan.writes['.pi/system.yaml']);
    assert.equal(Object.hasOwn(design, 'documents') || Object.hasOwn(design, 'workflows'), false);
    assert.deepEqual(plan.preview.legacy.removed.sort(), ['documents', 'workflows']);
    assert.ok(approvalSummary(root, plan).some(line => /Removes the unsupported/.test(line)));
    applyChange(root, plan, true);
    assert.equal(existsSync(join(root, old)), edited, edited ? 'an edited placeholder is kept' : 'an untouched placeholder is removed');
    if (edited) assert.ok(plan.preview.warnings.some(w => w.includes(old)));
    assert.equal(validateSystem(loadYaml().parse(readFileSync(join(root, '.pi/system.yaml'), 'utf8'))).ok, true);
  }
});
