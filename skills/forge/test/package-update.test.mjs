import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerMaintenance } from '../maintenance-extension.mjs';
import { proposeUpdate, previewUpdate } from '../package-update.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const next = version.replace(/\d+$/, n => String(Number(n) + 1));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/**
 * A local Forge remote with two release tags. The newer one generates a
 * different README heading and records each time its generator runs.
 */
function releases(t) {
  const base = mkdtempSync(join(tmpdir(), 'forge-releases-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = join(base, 'work');
  const marker = join(base, 'executed');
  mkdirSync(work);
  for (const path of execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean)) {
    if (!existsSync(join(repo, path))) continue;
    mkdirSync(dirname(join(work, path)), { recursive: true });
    copyFileSync(join(repo, path), join(work, path));
  }
  git(work, 'init', '--quiet');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'current');
  git(work, 'tag', `v${version}`);
  const manifest = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'));
  writeFileSync(join(work, 'package.json'), JSON.stringify({ ...manifest, version: next }, null, 2) + '\n');
  const generator = join(work, 'skills/forge/generate.mjs');
  writeFileSync(generator, readFileSync(generator, 'utf8').replace('"## Run",', `"## Run (${next})",`));
  const rebuild = join(work, 'skills/forge/maintenance-rebuild.mjs');
  const entry = readFileSync(rebuild, 'utf8').split('\n');
  entry.splice(1, 0, `import { appendFileSync as __mark } from 'node:fs'; __mark(${JSON.stringify(marker)}, process.argv[3] + '\\n');`);
  writeFileSync(rebuild, entry.join('\n'));
  git(work, 'commit', '--quiet', '-am', 'next');
  git(work, 'tag', `v${next}`);
  const remote = join(base, 'remote.git');
  git(base, 'clone', '--quiet', '--bare', work, remote);
  return { work, remote: `file://${remote}`, marker, executed: () => existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [] };
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.pi'));
  // One declared command: the design needs the Forge runtime, so the project pins a release to sync.
  const minimal = readFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), 'utf8');
  writeFileSync(join(root, '.pi/system.yaml'), minimal.replace('tools: [read, grep, find, ls]', 'tools: [read, grep, find, ls, "cli:hello"]') + 'integrations:\n  cli:\n    - name: hello\n      command: echo\n      args: [hi]\n      approve: false\n');
  execFileSync(process.execPath, [join(repo, 'skills/forge/forge.mjs'), 'generate', root], { stdio: 'ignore' });
  return root;
}

function adapter(answers = []) {
  const commands = {}, notices = [], dialogs = [];
  const pi = { registerTool() {}, registerCommand: (n, c) => { commands[n] = c; }, on() {}, getActiveTools: () => ['read'], setActiveTools() {}, sendUserMessage() {}, getAllTools: () => [] };
  const Type = Object.fromEntries(['Object', 'Union', 'Literal', 'Optional', 'String', 'Number', 'Array', 'Record'].map(k => [k, v => v]));
  const ctx = {
    hasUI: true, waitForIdle: async () => {},
    ui: { notify: (...v) => notices.push(v), confirm: async (title, body) => { dialogs.push({ title, body }); return answers.shift() ?? false; } },
  };
  const mock = { pi, Type, ctx, commands, notices, dialogs, run: arg => mock.forge(arg, ctx) };
  return mock;
}

const pin = root => JSON.parse(readFileSync(join(root, '.pi/settings.json'), 'utf8')).packages.find(p => p.includes('pi-forge'));
const files = root => ['.pi/settings.json', 'README.md', '.forge/build.json', 'run'].map(p => readFileSync(join(root, p), 'utf8'));

test('status reports the pinned and the newest release without running either', async t => {
  const { remote, executed } = releases(t);
  const root = project(t);
  const mock = adapter();
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote } });
  await mock.run('status');
  const text = mock.notices.map(([m]) => m).join('\n');
  assert.match(text, new RegExp(`v${version}`));
  assert.match(text, new RegExp(`v${next}`));
  assert.deepEqual(mock.dialogs, []);
  assert.deepEqual(executed(), []);
});

test('headless sync fails closed before contacting the remote', async t => {
  const root = project(t);
  const before = files(root);
  const mock = adapter([true, true]);
  mock.ctx.hasUI = false;
  const installs = [];
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote: 'file:///nonexistent/forge.git', install: async r => installs.push(r) } });
  const stderr = process.stderr.write;
  const lines = [];
  process.stderr.write = text => { lines.push(String(text)); return true; };
  try { await mock.run('sync'); } finally { process.stderr.write = stderr; }
  assert.match(lines.join(''), /interactive/i);
  assert.doesNotMatch(lines.join(''), /nonexistent/);
  assert.deepEqual(files(root), before);
  assert.deepEqual(installs, []);
});

test('declining to run the new release leaves it unexecuted and the project unchanged', async t => {
  const { remote, executed, work } = releases(t);
  const root = project(t);
  const before = files(root);
  const mock = adapter([false]);
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote, install: async () => assert.fail('installed') } });
  await mock.run('sync');
  assert.equal(mock.dialogs.length, 1);
  assert.match(mock.dialogs[0].title, new RegExp(`v${next}`));
  assert.match(mock.dialogs[0].body, new RegExp(`v${version}`));
  assert.match(mock.dialogs[0].body, new RegExp(git(work, 'rev-parse', `v${next}^{commit}`)));
  assert.deepEqual(executed(), []);
  assert.deepEqual(files(root), before);
});

test('the preview comes from the new release, and declining it writes nothing', async t => {
  const { remote, executed } = releases(t);
  const root = project(t);
  const before = files(root);
  const mock = adapter([true, false]);
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote, install: async () => assert.fail('installed') } });
  await mock.run('sync');
  assert.equal(mock.dialogs.length, 2, JSON.stringify(mock.notices));
  assert.deepEqual(executed(), ['plan']);
  const preview = mock.dialogs[1].body;
  assert.match(preview, new RegExp(`pi-forge@v${next}`), 'the pin change is previewed');
  assert.match(preview, new RegExp(`## Run \\(${next.replace(/\./g, '\\.')}\\)`), 'files generated by the new release are previewed');
  assert.match(preview, /file plan.*then run pi update --extensions --approve/i);
  assert.match(preview, /not transactional/i);
  assert.deepEqual(files(root), before);
});

test('an approved sync moves the pin, rebuilds with the new release and installs it', async t => {
  const { remote, executed } = releases(t);
  const root = project(t);
  const mock = adapter([true, true]);
  const installs = [];
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote, install: async r => installs.push(r) } });
  await mock.run('sync');
  assert.deepEqual(executed(), ['plan', 'apply']);
  assert.equal(pin(root), `git:github.com/mihaiiova/pi-forge@v${next}`);
  assert.equal(JSON.parse(readFileSync(join(root, '.forge/build.json'), 'utf8')).version, next);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), new RegExp(`## Run \\(${next.replace(/\./g, '\\.')}\\)`));
  assert.deepEqual(installs, [root]);
  assert.match(mock.notices.map(([m]) => m).join('\n'), /restart/i);
});

test('installer failure reports partial sync and preserves concurrent edits', async t => {
  const { remote, executed } = releases(t);
  const root = project(t);
  const mock = adapter([true, true]);
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote, install: async () => {
    assert.equal(pin(root), `git:github.com/mihaiiova/pi-forge@v${next}`, 'file plan is applied before package update');
    writeFileSync(join(root, 'README.md'), 'concurrent developer edit\n');
    throw new Error('installer failure');
  } } });
  await mock.run('sync');
  assert.deepEqual(executed(), ['plan', 'apply']);
  assert.equal(pin(root), `git:github.com/mihaiiova/pi-forge@v${next}`);
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'concurrent developer edit\n', 'no unconditional rollback overwrites the edit');
  const failure = mock.notices.map(([m]) => m).join('\n');
  assert.match(failure, /file plan was applied.*installation failed/i);
  assert.match(failure, /package state.*partial/i);
  assert.match(failure, /pi update --extensions --approve/);
  assert.match(failure, /review the current changes.*use git only after/i);
  assert.match(failure, /not transactional/i);
});

test('restoring the previous files with git rolls the pin back', async t => {
  const { remote } = releases(t);
  const root = project(t);
  git(root, 'init', '--quiet');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'generated');
  const mock = adapter([true, true]);
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote, install: async () => {} } });
  await mock.run('sync');
  assert.equal(pin(root), `git:github.com/mihaiiova/pi-forge@v${next}`);
  git(root, 'checkout', 'HEAD', '--', '.pi', 'run', 'README.md');
  assert.equal(pin(root), `git:github.com/mihaiiova/pi-forge@v${version}`);
  const check = adapter();
  check.forge = registerMaintenance(check.pi, check.Type, root, { updates: { remote } });
  await check.run('status');
  assert.match(check.notices.map(([m]) => m).join('\n'), new RegExp(`Forge: v${version} \\(v${next} available`));
});

test('a project already on the newest release is up to date without dialogs', async t => {
  const { remote, work } = releases(t);
  git(work, 'push', '--quiet', remote.slice('file://'.length), `:refs/tags/v${next}`);
  const root = project(t);
  const mock = adapter([true, true]);
  mock.forge = registerMaintenance(mock.pi, mock.Type, root, { updates: { remote } });
  await mock.run('sync');
  assert.deepEqual(mock.dialogs, []);
  assert.match(mock.notices.map(([m]) => m).join('\n'), new RegExp(`v${version} is the newest release[\\s\\S]*nothing to rebuild`));
});

test('a release tag that moves after approval is refused', async t => {
  const { remote, work, executed } = releases(t);
  const root = project(t);
  const proposal = await proposeUpdate(root, { remote });
  assert.equal(proposal.kind, 'release');
  writeFileSync(join(work, 'moved'), 'x');
  git(work, 'add', 'moved');
  git(work, 'commit', '--quiet', '-m', 'moved');
  git(work, 'tag', '-f', `v${next}`);
  git(work, 'push', '--quiet', '--force', remote.slice('file://'.length), `refs/tags/v${next}`);
  await assert.rejects(previewUpdate(root, proposal, true), /moved|changed/i);
  assert.deepEqual(executed(), []);
  await assert.rejects(previewUpdate(root, proposal, false), /approv/i);
});
