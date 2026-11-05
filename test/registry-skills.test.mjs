import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { skillSourceKind } from '../src/skill-sources.mjs';
import { validateSystem } from '../src/validate.mjs';
import { parseRegistrySource, searchSkills, previewRegistrySkill, resolveRegistrySkill, installRegistrySkill, removeRegistrySkill, stageRegistrySkills, SKILLS_CLI } from '../src/registry-skills.mjs';
import { generateProject } from '../src/generate.mjs';
import { planChange, applyChange, withSkillPreviews } from '../src/maintenance.mjs';
import { loadYaml } from '../src/yaml-loader.mjs';
import { applyWrites, fingerprints } from '../src/maintenance-store.mjs';

const SHA = '17772c7a80b7b8c7a47af30f648374cd8bd8adc5';
const SOURCE = `skills:acme/skills/skills/seo-audit@${SHA}`;
const SKILL_MD = '---\nname: seo-audit\ndescription: Audit SEO\n---\nAudit.\n';
const sha = (t) => createHash('sha256').update(t).digest('hex');

/** A fake GitHub + skills.sh: only the URLs the module is expected to request. */
function fakeFetcher(seen = []) {
  return async (url) => {
    seen.push(url);
    const docs = {
      [`https://skills.sh/api/search?q=seo&limit=10`]: { skills: [{ id: 'a/b/low', name: 'low', source: 'a/b', installs: 5 }, { id: 'acme/skills/seo-audit', name: 'seo-audit', source: 'acme/skills', installs: 900 }] },
      [`https://api.github.com/repos/acme/skills/commits/HEAD`]: { sha: SHA },
      [`https://api.github.com/repos/acme/skills/git/trees/${SHA}?recursive=1`]: { truncated: false, tree: [
        { type: 'blob', path: 'README.md' },
        { type: 'blob', path: 'skills/seo-audit/SKILL.md' },
        { type: 'blob', path: 'skills/seo-audit/references/checks.md' },
        { type: 'blob', path: 'skills/other/SKILL.md' },
      ] },
    };
    if (url === `https://raw.githubusercontent.com/acme/skills/${SHA}/skills/seo-audit/SKILL.md`) return { text: SKILL_MD };
    if (url === `https://raw.githubusercontent.com/acme/skills/${SHA}/skills/other/SKILL.md`) return { text: '---\nname: other\n---\n' };
    if (!(url in docs)) throw new Error(`unexpected fetch ${url}`);
    return { text: JSON.stringify(docs[url]) };
  };
}

/** A fake `npx skills` that behaves like `add --agent pi --copy` / `remove`. */
function fakeCli(calls, { content = SKILL_MD, ref = SHA } = {}) {
  return (cmd, args, opts) => {
    calls.push([cmd, ...args].join(' '));
    assert.equal(cmd, 'npx');
    assert.deepEqual(args.slice(0, 2), ['-y', SKILLS_CLI]);
    assert.ok(!args.includes('-g') && !args.includes('--global'), 'never global');
    const lockPath = join(opts.cwd, 'skills-lock.json');
    const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { version: 1, skills: {} };
    if (args[2] === 'add') {
      const name = args[3].split('/').pop();
      mkdirSync(join(opts.cwd, '.agents/skills', name), { recursive: true });
      writeFileSync(join(opts.cwd, '.agents/skills', name, 'SKILL.md'), content);
      mkdirSync(join(opts.cwd, '.agents/skills', name, 'bin'), { recursive: true });
      chmodSync(join(opts.cwd, '.agents/skills', name, 'bin'), 0o750);
      writeFileSync(join(opts.cwd, '.agents/skills', name, 'bin', 'run'), Buffer.from([0, 255, 1]));
      chmodSync(join(opts.cwd, '.agents/skills', name, 'bin', 'run'), 0o751);
      lock.skills[name] = { source: 'acme/skills', ref: ref === SHA ? args[3].split('/tree/')[1].split('/')[0] : ref, sourceType: 'github' };
    } else {
      rmSync(join(opts.cwd, '.agents/skills', args[3]), { recursive: true, force: true });
      delete lock.skills[args[3]];
    }
    writeFileSync(lockPath, JSON.stringify(lock));
  };
}

test('skills: sources must pin one skill directory to a full commit', () => {
  assert.equal(skillSourceKind(SOURCE), 'registry');
  for (const bad of ['skills:acme/skills/seo@main', 'skills:acme/skills@' + SHA, `skills:acme/skills/../x@${SHA}`, `skills:acme/skills/a b/../c@${SHA}`]) {
    assert.equal(skillSourceKind(bad), null, bad);
  }
  assert.equal(parseRegistrySource(SOURCE).url, `https://github.com/acme/skills/tree/${SHA}/skills/seo-audit`);
  const doc = { schema: 1, name: 'x', orchestrator: { name: 'lead', model: 'p/m' }, skills: [{ name: 'seo-audit', source: SOURCE }], agents: [{ name: 'a', model: 'p/m', skills: ['seo-audit'] }] };
  assert.deepEqual(validateSystem(doc).errors, []);
});

test('search, preview and resolve read skills.sh and GitHub at the pinned commit', async () => {
  const seen = [];
  const fetcher = fakeFetcher(seen);
  const results = await searchSkills('seo', { fetcher });
  assert.deepEqual(results.map((r) => [r.name, r.installs, r.page]), [['seo-audit', 900, 'https://skills.sh/acme/skills/seo-audit'], ['low', 5, 'https://skills.sh/a/b/low']]);
  const preview = await previewRegistrySkill(SOURCE, { fetcher });
  assert.deepEqual(preview.files, ['SKILL.md', 'references/checks.md']);
  assert.equal(preview.skillMdSha256, sha(SKILL_MD));
  const resolved = await resolveRegistrySkill('acme/skills@seo-audit', { fetcher });
  assert.equal(resolved.source, SOURCE);
  await assert.rejects(resolveRegistrySkill('acme/skills@missing', { fetcher }), /No SKILL.md named "missing"/);
});

test('install runs the pinned skills CLI project-locally and verifies the result', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  installRegistrySkill(root, { name: 'seo-audit', source: SOURCE }, { expectedSha256: sha(SKILL_MD), run: fakeCli(calls) });
  assert.match(calls[0], new RegExp(`^npx -y ${SKILLS_CLI.replace('.', '\\.')} add https://github.com/acme/skills/tree/${SHA}/skills/seo-audit --agent pi --copy -y$`));
  assert.ok(existsSync(join(root, '.agents/skills/seo-audit/SKILL.md')));

  // Content other than what was previewed is removed again.
  assert.throws(() => installRegistrySkill(root, { name: 'seo-audit', source: SOURCE }, { expectedSha256: sha(SKILL_MD), run: fakeCli(calls, { content: 'changed' }) }), /differs from the previewed/);
  assert.ok(!existsSync(join(root, '.agents/skills/seo-audit')));
  // A lock that does not record the pinned commit is refused too.
  assert.throws(() => installRegistrySkill(root, { name: 'seo-audit', source: SOURCE }, { run: fakeCli(calls, { ref: 'main' }) }), /does not record commit/);
  // A skill whose own name differs is reported, not silently kept.
  assert.throws(() => installRegistrySkill(root, { name: 'renamed', source: SOURCE }, { run: fakeCli(calls) }), /nothing was installed at \.agents\/skills\/renamed/);
  removeRegistrySkill(root, 'seo-audit', { run: fakeCli(calls) });
});

test('CLI generate replaces and removes intact manually edited registry declarations and refuses edits', t => {
  const root = mkdtempSync(join(tmpdir(), 'registry-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = { schema: 1, name: 'registry-test', orchestrator: { name: 'lead', model: 'p/m', tools: ['read'] }, skills: [{ name: 'seo-audit', source: SOURCE }] };
  const piPackages = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).pi.packages;
  for (const f of generateProject(model, {}, { piPackages }).files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
  }
  const yamlPath = join(root, '.pi/system.yaml');
  writeFileSync(yamlPath, loadYaml().stringify(model));
  installRegistrySkill(root, model.skills[0], { run: fakeCli([]) });
  applyChange(root, planChange(root, [{ op: 'reconcile' }]), true, { run: fakeCli([]) });
  const bin = join(root, 'test-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), `#!${process.execPath}\nconst { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } = require('node:fs');\nconst { join } = require('node:path');\nconst assert = require('node:assert/strict');\nconst SKILLS_CLI = ${JSON.stringify(SKILLS_CLI)}, SHA = ${JSON.stringify(SHA)}, SKILL_MD = ${JSON.stringify(SKILL_MD)};\n(${fakeCli.toString()})([])('npx', process.argv.slice(2), { cwd: process.cwd() });\n`, { mode: 0o755 });
  // Replace only the public-fetch module in the subprocess; npx is still
  // executed through the CLI boundary, against the fake pinned registry above.
  const loader = join(root, 'registry-loader.mjs');
  const stub = `export async function fetchDocument(url) { return { text: url.includes('raw.githubusercontent.com') ? ${JSON.stringify(SKILL_MD)} : JSON.stringify({ tree: [], truncated: false }) }; }`;
  writeFileSync(loader, `export async function resolve(specifier, context, next) { if (specifier === './maintenance-fetch.mjs' && context.parentURL.endsWith('/registry-skills.mjs')) return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true }; return next(specifier, context); }`);
  const run = (approved = true) => spawnSync(process.execPath, ['--experimental-loader', loader, new URL('../src/faur.mjs', import.meta.url).pathname, 'generate', root, ...(approved ? ['--yes'] : [])], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_SUBAGENT_CHILD: '' }, timeout: 30000 });
  const next = SOURCE.replace(SHA, 'b'.repeat(40));
  writeFileSync(yamlPath, loadYaml().stringify({ ...model, skills: [{ name: 'seo-audit', source: next }] }));
  const oldLock = readFileSync(join(root, 'skills-lock.json'));
  const unapproved = run(false);
  assert.notEqual(unapproved.status, 0);
  assert.match(unapproved.stderr, /Not approved/);
  assert.deepEqual(readFileSync(join(root, 'skills-lock.json')), oldLock);
  const replaced = run();
  assert.equal(replaced.status, 0, replaced.stderr);
  const skillDir = join(root, '.agents/skills/seo-audit');
  const lockPath = join(root, 'skills-lock.json');
  assert.equal(JSON.parse(readFileSync(lockPath)).skills['seo-audit'].ref, 'b'.repeat(40));
  writeFileSync(yamlPath, loadYaml().stringify({ ...model, skills: [] }));
  const beforeLock = readFileSync(lockPath);
  const beforeYaml = readFileSync(yamlPath);
  const settingsPath = join(root, '.pi/settings.json');
  const beforeSettings = readFileSync(settingsPath);
  const extra = join(skillDir, 'extra');
  writeFileSync(extra, 'developer edit');
  const refused = run();
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.stderr, /differs from its pinned source/);
  assert.deepEqual(readFileSync(lockPath), beforeLock);
  assert.deepEqual(readFileSync(yamlPath), beforeYaml);
  assert.deepEqual(readFileSync(settingsPath), beforeSettings);
  assert.equal(readFileSync(extra, 'utf8'), 'developer edit');
  rmSync(extra);
  const script = join(skillDir, 'bin/run');
  for (const mutation of ['modified', 'missing']) {
    if (mutation === 'modified') writeFileSync(script, 'changed');
    else rmSync(script);
    const failed = run();
    assert.notEqual(failed.status, 0, mutation);
    assert.match(failed.stderr, /differs from its pinned source/);
    assert.deepEqual(readFileSync(lockPath), beforeLock);
    assert.deepEqual(readFileSync(yamlPath), beforeYaml);
    assert.deepEqual(readFileSync(settingsPath), beforeSettings);
    writeFileSync(script, Buffer.from([0, 255, 1]));
    chmodSync(script, 0o751);
  }
  const buildPath = join(root, '.faur/build.json');
  const build = readFileSync(buildPath);
  writeFileSync(buildPath, JSON.stringify({ version: 'old' }));
  const unknown = run();
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /no verifiable previous source/);
  assert.deepEqual(readFileSync(lockPath), beforeLock);
  assert.equal(existsSync(script), true);
  writeFileSync(buildPath, build);
  const applied = run();
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(skillDir), false);
  assert.equal(JSON.parse(readFileSync(lockPath)).skills['seo-audit'], undefined);
});

test('manual registry declaration edits use the recorded old pinned source', t => {
  const root = mkdtempSync(join(tmpdir(), 'registry-manual-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = { schema: 1, name: 'registry-test', orchestrator: { name: 'lead', model: 'p/m', tools: ['read'] }, skills: [{ name: 'seo-audit', source: SOURCE }] };
  const piPackages = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).pi.packages;
  for (const f of generateProject(model, {}, { piPackages }).files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
  }
  const yamlPath = join(root, '.pi/system.yaml');
  writeFileSync(yamlPath, loadYaml().stringify(model));
  const calls = [];
  installRegistrySkill(root, model.skills[0], { run: fakeCli(calls) });
  applyChange(root, planChange(root, [{ op: 'reconcile' }]), true, { run: fakeCli(calls) });
  const buildPath = join(root, '.faur/build.json');
  const initialBuild = readFileSync(buildPath);
  assert.deepEqual(JSON.parse(initialBuild).declarations.registrySkills, [{ name: 'seo-audit', source: SOURCE }]);
  const skillDir = join(root, '.agents/skills/seo-audit');
  const lockPath = join(root, 'skills-lock.json');
  const originalLock = readFileSync(lockPath);
  const next = SOURCE.replace(SHA, 'b'.repeat(40));
  writeFileSync(yamlPath, loadYaml().stringify({ ...model, skills: [{ name: 'seo-audit', source: next }] }));
  const replacement = planChange(root, [{ op: 'reconcile' }]);
  assert.deepEqual(replacement.skills.verify, [{ name: 'seo-audit', source: SOURCE }]);
  replacement.skillPreviews = { 'seo-audit': { skillMdSha256: sha(SKILL_MD) } };
  applyChange(root, replacement, true, { run: fakeCli(calls) });
  assert.equal(JSON.parse(readFileSync(lockPath)).skills['seo-audit'].ref, 'b'.repeat(40));
  writeFileSync(yamlPath, loadYaml().stringify({ ...model, skills: [] }));
  const removed = planChange(root, [{ op: 'reconcile' }]);
  assert.deepEqual(removed.skills.verify, [{ name: 'seo-audit', source: next }]);
  applyChange(root, removed, true, { run: fakeCli(calls) });
  assert.equal(existsSync(skillDir), false);

  // Restore the original project and exercise edited, additional and missing files.
  writeFileSync(yamlPath, loadYaml().stringify(model));
  installRegistrySkill(root, model.skills[0], { run: fakeCli(calls) });
  writeFileSync(buildPath, initialBuild);
  writeFileSync(yamlPath, loadYaml().stringify({ ...model, skills: [] }));
  const script = join(skillDir, 'bin/run');
  for (const mutation of ['modified', 'extra', 'missing']) {
    if (mutation === 'modified') writeFileSync(script, 'changed');
    if (mutation === 'extra') writeFileSync(join(skillDir, 'extra'), 'mine');
    if (mutation === 'missing') rmSync(script);
    const beforeLock = readFileSync(lockPath);
    const beforeBuild = readFileSync(buildPath);
    const beforeYaml = readFileSync(yamlPath);
    assert.throws(() => applyChange(root, planChange(root, [{ op: 'reconcile' }]), true, { run: fakeCli(calls) }), /differs from its pinned source/, mutation);
    assert.deepEqual(readFileSync(lockPath), beforeLock);
    assert.deepEqual(readFileSync(buildPath), beforeBuild);
    assert.deepEqual(readFileSync(yamlPath), beforeYaml);
    rmSync(join(skillDir, 'extra'), { force: true });
    writeFileSync(script, Buffer.from([0, 255, 1]));
    chmodSync(script, 0o751);
  }
  for (const declarations of [undefined, { ...JSON.parse(initialBuild).declarations, registrySkills: ['seo-audit'] }]) {
    writeFileSync(buildPath, JSON.stringify({ version: 'test', ...(declarations ? { declarations } : {}) }));
    assert.throws(() => planChange(root, [{ op: 'reconcile' }]), /no verifiable previous source/);
    assert.deepEqual(readFileSync(lockPath), originalLock);
    assert.equal(existsSync(script), true);
  }
});

test('removing a declaration prunes only its lock entry when its installed directory is already absent', t => {
  for (const manual of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'registry-missing-copy-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const model = { schema: 1, name: 'registry-test', orchestrator: { name: 'lead', model: 'p/m', tools: ['read'] }, skills: [{ name: 'seo-audit', source: SOURCE }] };
    const piPackages = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).pi.packages;
    for (const f of generateProject(model, {}, { piPackages }).files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.content);
    }
    const yamlPath = join(root, '.pi/system.yaml');
    writeFileSync(yamlPath, loadYaml().stringify(model));
    const calls = [];
    installRegistrySkill(root, model.skills[0], { run: fakeCli(calls) });
    applyChange(root, planChange(root, [{ op: 'reconcile' }]), true, { run: fakeCli(calls) });
    const lockPath = join(root, 'skills-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.custom = { keep: true };
    lock.skills.other = { source: 'another/repo', ref: 'unrelated' };
    writeFileSync(lockPath, JSON.stringify(lock));
    rmSync(join(root, '.agents/skills/seo-audit'), { recursive: true });
    if (manual) writeFileSync(yamlPath, loadYaml().stringify({ ...model, skills: [] }));
    const plan = planChange(root, manual ? [{ op: 'reconcile' }] : [{ op: 'remove', target: 'skill', name: 'seo-audit' }]);
    assert.deepEqual(plan.skills.remove, ['seo-audit']);
    assert.deepEqual(plan.preview.skills.remove, ['seo-audit: prune skills-lock.json entry']);
    assert.deepEqual(plan.skills.verify, []);
    const callsBefore = calls.length;
    applyChange(root, plan, true, { run: fakeCli(calls) });
    assert.equal(calls.length, callsBefore, 'no installer is needed for a lock-only cleanup');
    const after = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.deepEqual(after.custom, { keep: true });
    assert.deepEqual(after.skills, { other: { source: 'another/repo', ref: 'unrelated' } });
  }
});

test('maintenance installs previewed skills and refuses unverified replacement or removal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'registry-maint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = { schema: 1, name: 'registry-test', orchestrator: { name: 'lead', model: 'p/m', tools: ['read'] }, agents: [{ name: 'auditor', model: 'p/m', tools: ['read'] }] };
  const piPackages = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).pi.packages;
  for (const f of generateProject(model, {}, { piPackages }).files) {
    mkdirSync(dirname(join(root, f.path)), { recursive: true });
    writeFileSync(join(root, f.path), f.content);
  }
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(model));
  const calls = [];
  const plan = await withSkillPreviews(planChange(root, [
    { op: 'add', target: 'skill', name: 'seo-audit', value: { source: SOURCE } },
    { op: 'update', target: 'agent', name: 'auditor', value: { skills: ['seo-audit'] } },
  ]), { fetcher: fakeFetcher() });
  assert.deepEqual(plan.preview.skills.install, [{ name: 'seo-audit', source: SOURCE, into: '.agents/skills/seo-audit/' }]);
  assert.equal(plan.preview.skills.contents[0].skillMd, SKILL_MD);
  assert.throws(() => applyChange(root, plan, false, { run: fakeCli(calls) }), /approval/);
  assert.equal(calls.length, 0);
  applyChange(root, plan, true, { run: fakeCli(calls) });
  assert.ok(existsSync(join(root, '.agents/skills/seo-audit/SKILL.md')));
  assert.deepEqual(readFileSync(join(root, '.agents/skills/seo-audit/bin/run')), Buffer.from([0, 255, 1]));
  assert.equal(statSync(join(root, '.agents/skills/seo-audit/bin/run')).mode & 0o777, 0o751);
  assert.equal(statSync(join(root, '.agents/skills/seo-audit/bin')).mode & 0o777, 0o750);
  assert.match(readFileSync(join(root, '.pi/agents/auditor.md'), 'utf8'), /skills:\n  - seo-audit\n/);
  const skillDir = join(root, '.agents/skills/seo-audit');
  const binary = Buffer.from([0, 255, 128, 13]);
  writeFileSync(join(skillDir, 'asset.bin'), binary);
  chmodSync(join(skillDir, 'asset.bin'), 0o751);
  const lockBefore = readFileSync(join(root, 'skills-lock.json'));
  const yamlBefore = readFileSync(join(root, '.pi/system.yaml'));
  const nextRef = 'b'.repeat(40);
  const updatedSource = SOURCE.replace(SHA, nextRef);
  const replacement = planChange(root, [{ op: 'update', target: 'skill', name: 'seo-audit', value: { source: updatedSource } }]);
  replacement.skillPreviews = { 'seo-audit': { skillMdSha256: sha(SKILL_MD) } };
  assert.throws(() => applyChange(root, replacement, true, { run: fakeCli(calls) }), /differs from its pinned source/);
  const removal = planChange(root, [
    { op: 'update', target: 'agent', name: 'auditor', value: { skills: [] } },
    { op: 'remove', target: 'skill', name: 'seo-audit' },
  ]);
  assert.throws(() => applyChange(root, removal, true, { run: fakeCli(calls) }), /differs from its pinned source/);
  assert.deepEqual(readFileSync(join(skillDir, 'asset.bin')), binary);
  assert.equal(statSync(join(skillDir, 'asset.bin')).mode & 0o777, 0o751);
  assert.deepEqual(readFileSync(join(root, 'skills-lock.json')), lockBefore);
  assert.deepEqual(readFileSync(join(root, '.pi/system.yaml')), yamlBefore);
  rmSync(join(skillDir, 'asset.bin'));
  const script = join(skillDir, 'bin/run');
  for (const mutation of ['modified', 'missing', 'mode']) {
    if (mutation === 'modified') writeFileSync(script, 'edited');
    if (mutation === 'missing') rmSync(script);
    if (mutation === 'mode') chmodSync(script, 0o700);
    const snapshot = readFileSync(join(root, '.pi/system.yaml'));
    const unsafe = planChange(root, [
      { op: 'update', target: 'agent', name: 'auditor', value: { skills: [] } },
      { op: 'remove', target: 'skill', name: 'seo-audit' },
    ]);
    assert.throws(() => applyChange(root, unsafe, true, { run: fakeCli(calls) }), /differs from its pinned source/, mutation);
    assert.deepEqual(readFileSync(join(root, '.pi/system.yaml')), snapshot);
    assert.deepEqual(readFileSync(join(root, 'skills-lock.json')), lockBefore);
    writeFileSync(script, Buffer.from([0, 255, 1]));
    chmodSync(script, 0o751);
  }
  const failedInstaller = planChange(root, [
    { op: 'update', target: 'agent', name: 'auditor', value: { skills: [] } },
    { op: 'remove', target: 'skill', name: 'seo-audit' },
  ]);
  assert.throws(() => applyChange(root, failedInstaller, true, { run: () => { throw new Error('installer failed'); } }), /installer failed/);
  assert.deepEqual(readFileSync(join(root, 'skills-lock.json')), lockBefore);
  assert.deepEqual(readFileSync(join(root, '.pi/system.yaml')), yamlBefore);
  const cleanReplacement = planChange(root, [{ op: 'update', target: 'skill', name: 'seo-audit', value: { source: updatedSource } }]);
  cleanReplacement.skillPreviews = { 'seo-audit': { skillMdSha256: sha(SKILL_MD) } };
  applyChange(root, cleanReplacement, true, { run: fakeCli(calls) });
  assert.equal(JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8')).skills['seo-audit'].ref, nextRef);
  const removeUpdated = planChange(root, [
    { op: 'update', target: 'agent', name: 'auditor', value: { skills: [] } },
    { op: 'remove', target: 'skill', name: 'seo-audit' },
  ]);
  applyChange(root, removeUpdated, true, { run: fakeCli(calls) });
  assert.equal(existsSync(skillDir), false);
  const edited = loadYaml().parse(yamlBefore.toString());
  edited.skills[0].source = updatedSource;
  writeFileSync(join(root, '.pi/system.yaml'), loadYaml().stringify(edited));
  assert.doesNotThrow(() => planChange(root, [{ op: 'reconcile' }]));

});
