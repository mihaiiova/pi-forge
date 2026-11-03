import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rebuildPlan, planChange } from '../maintenance.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
test('CLI generation installs no copied Forge tooling', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root]);
  const settings = JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8'));
  assert.equal(settings.packages, undefined, 'the minimal agent pins no Forge package and nothing else');
  assert.deepEqual(readdirSync(join(root, '.forge')).sort(), ['build.json', 'capabilities.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.forge/build.json'), 'utf8')), { version, declarations: { scaffolds: [], vendoredSkills: [], registrySkills: [] } }, 'the build records declaration identities, not ownership fingerprints');
});

test('CLI no longer offers bootstrap or recovery commands', () => {
  const output = execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), '--help'], { encoding: 'utf8' });
  assert.doesNotMatch(output, /bootstrap-update|recover/);
  for (const command of ['bootstrap-update', 'recover']) {
    assert.throws(() => execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), command, '.'], { stdio: 'pipe' }));
  }
});

test('package project changes do not rely on legacy installation metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-package-change-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root]);
  writeFileSync(join(root, '.forge/installation.json'), JSON.stringify({ entrypoints: { '.pi/extensions/maintenance/index.ts': 'obsolete' } }));
  assert.doesNotThrow(() => planChange(root, [{ op: 'reconcile' }]));
});

test('rebuild identifies the package version used for generated files', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-package-rebuild-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root]);
  const plan = rebuildPlan(root);
  assert.equal(plan.rebuild.version, version);
  assert.equal(plan.rebuild.unchanged, true);
});

test('git ignores the packages Pi installs inside the project', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-package-ignore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(root, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root]);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  // Pi installs project packages under .pi/git/<host>/<path> and .pi/npm/.
  for (const path of ['.pi/git/github.com/mihaiiova/pi-forge/package.json', '.pi/npm/node_modules/pi-subagents/package.json']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), '{}');
  }
  const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(untracked, /\.pi\/(git|npm)\//);
  assert.match(untracked, /\.pi\/settings\.json/);
});
