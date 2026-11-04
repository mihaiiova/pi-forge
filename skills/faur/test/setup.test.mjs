import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unmetSetup, installSetup } from '../setup.mjs';
import { validateSystem } from '../validate.mjs';

const step = { description: 'Create marker', check: { file: 'marker' }, install: 'touch marker' };
const model = { schema: 1, name: 'demo', orchestrator: { name: 'lead', model: 'p/m' }, setup: [step] };

test('validate setup declarations', () => {
  assert.equal(validateSystem(model).ok, true);
  assert.equal(validateSystem({ ...model, setup: [{ ...step, check: { file: 'x', command: 'true' } }] }).ok, false);
});

test('checks and approved installs; never runs needsRoot', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rootStep = { description: 'root step', check: { command: 'false' }, install: 'touch root-marker', needsRoot: true };
  const doc = { ...model, setup: [step, rootStep] };
  const missing = unmetSetup(root, doc);
  assert.equal(missing.length, 2);
  assert.throws(() => installSetup(root, doc));
  assert.deepEqual(installSetup(root, doc, missing).map(x => x.status), ['installed', 'needsRoot']);
  assert.ok(existsSync(join(root, 'marker')));
  assert.ok(!existsSync(join(root, 'root-marker')));
  assert.equal(unmetSetup(root, doc).length, 1);
});

test('newly unmet installs are not included in prior approval', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(installSetup(root, model, []), []);
  assert.ok(!existsSync(join(root, 'marker')));
});

test('platform filtering and failed install stop later installs', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const doc = { ...model, setup: [
    { ...step, platforms: ['darwin'] },
    { description: 'Fail', check: { command: 'false' }, install: 'exit 1' },
    { description: 'Later', check: { file: 'later' }, install: 'touch later' },
  ] };
  assert.equal(unmetSetup(root, doc, 'linux').length, 2);
  const applicable = { ...doc, setup: doc.setup.slice(1) };
  assert.deepEqual(installSetup(root, applicable, unmetSetup(root, applicable)).map(s => s.status), ['failed']);
  assert.equal(existsSync(join(root, 'later')), false);
});

test('faur setup requires --yes and prints root commands without running them', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-setup-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: demo\norchestrator: { name: lead, model: p/m }\nsetup:\n  - description: marker\n    check: { file: marker }\n    install: touch marker\n  - description: root\n    check: { file: root-marker }\n    install: touch root-marker\n    needsRoot: true\n');
  const cli = new URL('../faur.mjs', import.meta.url).pathname;
  const denied = spawnSync(process.execPath, [cli, 'setup', root], { encoding: 'utf8' });
  assert.notEqual(denied.status, 0); assert.match(denied.stdout, /touch marker/); assert.equal(existsSync(join(root, 'marker')), false);
  const approved = spawnSync(process.execPath, [cli, 'setup', root, '--yes'], { encoding: 'utf8' });
  assert.equal(approved.status, 0, approved.stderr); assert.match(approved.stdout, /run manually; needs root/);
  assert.equal(existsSync(join(root, 'marker')), true); assert.equal(existsSync(join(root, 'root-marker')), false);
});
