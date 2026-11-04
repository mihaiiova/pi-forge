import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validSecretsPath, ensureSecretFiles, secretFileProblem, gitignoreSafety } from '../integration-secrets.mjs';
import { envStatus } from '../maintenance-env.mjs';

// Git subprocesses in this suite must not inherit a developer's global excludes.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const model = { integrations: { env: [{ name: 'TEST_KEY', secret: true }], mcp: [{ name: 'demo', secretsFile: 'private/keys.env' }] } };
test('secrets paths reject traversal, absolute and git control paths', () => {
  for (const p of ['../key', '/tmp/key', 'a/../key', 'a\\key', '.git/config', 'a/*', '.env', '.faur/permission-requests.json', '.faur', '.pi', 'data', 'private/.gitignore', 'private/.gitignore/keys']) assert.equal(validSecretsPath(p), false, p);
  assert.equal(validSecretsPath('private/keys.env'), true);
});
test('reserved secret paths and git control components reject case-insensitive aliases', () => {
  const reserved = [
    '.faur', '.pi', 'data', '.env', '.env.example', 'run', 'README.md',
    'data/knowledge/.gitkeep', '.faur/build.json', '.faur/capabilities.json',
    '.faur/check.json', '.faur/permission-requests.json', '.pi/system.yaml',
    '.faur/pi-home/auth.json', '.git/config', 'private/.gitignore/keys',
  ];
  for (const path of reserved) {
    assert.equal(validSecretsPath(path), false, path);
    assert.equal(validSecretsPath(path.toUpperCase()), false, path.toUpperCase());
    const mixed = [...path].map((character, i) => i % 2 ? character.toUpperCase() : character.toLowerCase()).join('');
    assert.equal(validSecretsPath(mixed), false, mixed);
  }
  assert.equal(validSecretsPath('.FaUr/Service-Keys.env'), true);
  assert.equal(validSecretsPath('Private/Keys.env'), true);
});

test('secrets files are exclusive, private, explicitly selected and reject symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created = [];
  ensureSecretFiles(root, model, { onCreate: path => created.push(path) });
  assert.deepEqual(created, ['private/keys.env']);
  const file = join(root, 'private/keys.env');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  writeFileSync(file, 'OTHER=existing\n');
  ensureSecretFiles(root, model, { onCreate: path => created.push(path) });
  assert.deepEqual(created, ['private/keys.env'], 'existing secrets are not reported as new');
  assert.equal(readFileSync(file, 'utf8'), 'OTHER=existing\n');
  writeFileSync(file, 'OTHER=existing\nTEST_KEY=example\n');
  assert.deepEqual(envStatus(root, model, {}), [{ name: 'TEST_KEY', secret: true, set: 'private/keys.env' }]);
  assert.doesNotMatch(JSON.stringify(envStatus(root, model, {})), /example/);
  mkdirSync(join(root, 'outside')); symlinkSync(join(root, 'outside'), join(root, 'link'));
  assert.throws(() => ensureSecretFiles(root, { integrations: { mcp: [{ secretsFile: 'link/keys.env' }] } }), /symlink/);
  assert.equal(secretFileProblem(root, 'link/keys.env'), 'unsafe or inaccessible path');
});
test('tracked or unignored files are rejected in a git worktree', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-secrets-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  assert.throws(() => ensureSecretFiles(root, model), /not ignored/);
  writeFileSync(join(root, '.gitignore'), '/private/keys.env\n');
  ensureSecretFiles(root, model);
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'private/keys.env'], { cwd: root }).status, 0);
});

test('generation creates ignored private files and check reports missing files', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-secrets-generate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config:\n        command: example\n      secretsFile: private/keys.env\n');
  const cli = new URL('../faur.mjs', import.meta.url).pathname;
  const generated = spawnSync(process.execPath, [cli, 'generate', root], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(lstatSync(join(root, 'private/keys.env')).mode & 0o777, 0o600);
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'private/keys.env'], { cwd: root }).status, 0);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /Configure integration secrets in `private\/keys\.env` outside Faur/);
  assert.match(readme, /Faur does not load this file; configure the integration to read it/);
  rmSync(join(root, 'private/keys.env'));
  const checked = spawnSync(process.execPath, [cli, 'check-agent', root], { encoding: 'utf8' });
  assert.match(checked.stdout, /Integration secretsFile private\/keys.env: missing/);
});

test('modify creates declared secret files after applying ignore rules', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-secrets-modify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
  const result = spawnSync(process.execPath, [new URL('../faur.mjs', import.meta.url).pathname, 'modify', root, '--yes'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(join(root, 'private/keys.env')).mode & 0o777, 0o600);
});

test('generate and modify reject unsafe existing secrets before other writes', t => {
  for (const command of ['generate', 'modify']) {
    const root = mkdtempSync(join(tmpdir(), 'faur-secrets-preflight-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.pi')); mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private/keys.env'), 'SECRET=never-print-this\n', { mode: 0o644 });
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
    const result = spawnSync(process.execPath, [new URL('../faur.mjs', import.meta.url).pathname, command, root, ...(command === 'modify' ? ['--yes'] : [])], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /permissions must exclude/);
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-this/);
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
    assert.throws(() => lstatSync(join(root, '.gitignore')), /ENOENT/);
  }
});

test('nested gitignore negations fail before generation or modification writes', t => {
  for (const command of ['generate', 'modify']) {
    const root = mkdtempSync(join(tmpdir(), 'faur-secrets-negation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    mkdirSync(join(root, '.pi')); mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private/.gitignore'), '!keys.env\n');
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
    const result = spawnSync(process.execPath, [new URL('../faur.mjs', import.meta.url).pathname, command, root, ...(command === 'modify' ? ['--yes'] : [])], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private\/\.gitignore contains negation rules/);
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
    assert.throws(() => lstatSync(join(root, '.gitignore')), /ENOENT/);
  }
});

test("Pi's own package-directory ignore files do not block regeneration", t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-pi-package-ignore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi/git'), { recursive: true }); mkdirSync(join(root, '.pi/npm'));
  for (const dir of ['.pi/git', '.pi/npm']) writeFileSync(join(root, dir, '.gitignore'), '*\n!.gitignore\n');
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\n');
  const faur = new URL('../faur.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [faur, 'generate', root, '--yes'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(root, '.pi/git/.gitignore'), '*\n!.gitignore\n!secret\n');
  const refused = spawnSync(process.execPath, [faur, 'generate', root, '--yes'], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /\.pi\/git\/\.gitignore contains negation rules/);
});

test('root secret ignore negation fails before any writes without overriding user rules', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-secrets-root-ignore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.gitignore'), '/private/keys.env\n!private/keys.env\n');
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
  const result = spawnSync(process.execPath, [new URL('../faur.mjs', import.meta.url).pathname, 'generate', root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Root .gitignore contains a negation/);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '/private/keys.env\n!private/keys.env\n');
  assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
  assert.throws(() => lstatSync(join(root, 'private/keys.env')), /ENOENT/);
});

test('root negations cannot undo .env or .faur protections', t => {
  for (const rule of ['.env', '.faur/']) {
    const root = mkdtempSync(join(tmpdir(), 'faur-required-ignore-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.pi'));
    const original = `${rule}\n!${rule}\n`;
    writeFileSync(join(root, '.gitignore'), original);
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\n');
    const result = spawnSync(process.execPath, [new URL('../faur.mjs', import.meta.url).pathname, 'generate', root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Root .gitignore contains a negation/);
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), original);
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
  }
});

test('directory-only ignore does not protect a secret file and generation is idempotent', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-secret-dir-rule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.gitignore'), '/private/keys.env/\n');
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
  const cli = new URL('../faur.mjs', import.meta.url).pathname;
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [cli, 'generate', root, '--yes'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.equal(ignore.split('\n').filter(line => line === '/private/keys.env').length, 1);
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'private/keys.env'], { cwd: root }).status, 0);
  }
});

test('literal disjoint root negations do not conflict while ancestor and trailing-space negations do', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-ignore-semantics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  const required = '.env\n.faur/\n.pi/state.json\n.pi/sessions/\n.pi/git/\n.pi/npm/\n';
  for (const [negation, expectedIgnored, conflict] of [
    ['!.pi/system.yaml', true, false],
    ['!.pi/sessions/example.json', true, false],
    ['!.faur/example', true, false],
    ['!.pi/state.json   ', false, true],
    ['!.pi', true, true],
  ]) {
    writeFileSync(join(root, '.gitignore'), required + negation + '\n');
    const ignored = spawnSync('git', ['check-ignore', '-q', '--', '.pi/state.json'], { cwd: root }).status === 0;
    assert.equal(ignored, expectedIgnored, negation);
    assert.equal(Boolean(gitignoreSafety(required + negation + '\n', {}).conflict), conflict, negation);
  }
  assert.deepEqual(gitignoreSafety(required.replace('.pi/state.json\n', '.pi/state.json   \n'), {}).missing, []);
});

test('literal descendants cannot unignore an excluded directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-ignore-descendant-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.faur'));
  writeFileSync(join(root, '.faur', 'example'), 'test');
  const ignore = '.env\n.faur/\n.pi/state.json\n.pi/sessions/\n.pi/git/\n.pi/npm/\n!.faur/example\n';
  writeFileSync(join(root, '.gitignore'), ignore);
  assert.equal(spawnSync('git', ['check-ignore', '-q', '--', '.faur/example'], { cwd: root }).status, 0);
  assert.equal(gitignoreSafety(ignore, {}).conflict, null);
  assert.ok(gitignoreSafety(ignore + '!.faur/\n', {}).conflict);
});

test('reserved secretsFile paths are rejected before generate or modify writes', t => {
  for (const path of ['.faur', '.pi', 'data', 'private/.gitignore']) {
    for (const command of ['generate', 'modify']) {
      const root = mkdtempSync(join(tmpdir(), 'faur-secrets-reserved-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, '.pi'));
      writeFileSync(join(root, '.pi/system.yaml'), `schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: ${path}\n`);
      const result = spawnSync(process.execPath, [new URL('../faur.mjs', import.meta.url).pathname, command, root, ...(command === 'modify' ? ['--yes'] : [])], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${command} ${path}`);
      assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
      assert.throws(() => lstatSync(join(root, '.gitignore')), /ENOENT/);
    }
  }
});

test('nested .pi negations fail before generation or modification without integration secrets', t => {
  for (const command of ['generate', 'modify']) {
    const root = mkdtempSync(join(tmpdir(), 'faur-pi-negation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    mkdirSync(join(root, '.pi'));
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\n');
    writeFileSync(join(root, '.pi/.gitignore'), '!state.json   \n');
    writeFileSync(join(root, '.gitignore'), '.pi/state.json\n');
    assert.notEqual(spawnSync('git', ['check-ignore', '-q', '--', '.pi/state.json'], { cwd: root }).status, 0);
    const result = spawnSync(process.execPath, [new URL('../faur.mjs', import.meta.url).pathname, command, root, '--yes'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required ignore .pi\/state.json: .pi\/\.gitignore contains negation rules/);
    assert.equal(readFileSync(join(root, '.pi/.gitignore'), 'utf8'), '!state.json   \n');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.pi/state.json\n');
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
  }
});
