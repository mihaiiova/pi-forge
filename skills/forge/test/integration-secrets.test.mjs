import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validSecretsPath, ensureSecretFiles, secretFileProblem, gitignoreSafety } from '../integration-secrets.mjs';
import { setEnvValue, envStatus } from '../maintenance-env.mjs';

// Git subprocesses in this suite must not inherit a developer's global excludes.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const model = { integrations: { env: [{ name: 'TEST_KEY', secret: true }], mcp: [{ name: 'demo', secretsFile: 'private/keys.env' }] } };
test('secrets paths reject traversal, absolute and git control paths', () => {
  for (const p of ['../key', '/tmp/key', 'a/../key', 'a\\key', '.git/config', 'a/*', '.env', '.forge/permission-requests.json', '.forge', '.pi', 'data', 'private/.gitignore', 'private/.gitignore/keys']) assert.equal(validSecretsPath(p), false, p);
  assert.equal(validSecretsPath('private/keys.env'), true);
});
test('reserved secret paths and git control components reject case-insensitive aliases', () => {
  const reserved = [
    '.forge', '.pi', 'data', '.env', '.env.example', 'run', 'README.md',
    'data/knowledge/.gitkeep', '.forge/build.json', '.forge/capabilities.json',
    '.forge/check.json', '.forge/permission-requests.json', '.pi/system.yaml',
    '.forge/pi-home/auth.json', '.git/config', 'private/.gitignore/keys',
  ];
  for (const path of reserved) {
    assert.equal(validSecretsPath(path), false, path);
    assert.equal(validSecretsPath(path.toUpperCase()), false, path.toUpperCase());
    const mixed = [...path].map((character, i) => i % 2 ? character.toUpperCase() : character.toLowerCase()).join('');
    assert.equal(validSecretsPath(mixed), false, mixed);
  }
  assert.equal(validSecretsPath('.FoRgE/Service-Keys.env'), true);
  assert.equal(validSecretsPath('Private/Keys.env'), true);
});

test('secrets files are exclusive, private, explicitly selected and reject symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureSecretFiles(root, model);
  const file = join(root, 'private/keys.env');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  writeFileSync(file, 'OTHER=existing\n');
  ensureSecretFiles(root, model);
  assert.equal(readFileSync(file, 'utf8'), 'OTHER=existing\n');
  setEnvValue(root, model, 'TEST_KEY', 'example', 'private/keys.env');
  assert.equal(readFileSync(file, 'utf8'), 'OTHER=existing\nTEST_KEY=example\n');
  assert.deepEqual(envStatus(root, model, {}), [{ name: 'TEST_KEY', secret: true, set: 'private/keys.env' }]);
  assert.doesNotMatch(JSON.stringify(envStatus(root, model, {})), /example/);
  assert.throws(() => setEnvValue(root, model, 'TEST_KEY', 'example', 'other.env'), /not a declared/);
  mkdirSync(join(root, 'outside')); symlinkSync(join(root, 'outside'), join(root, 'link'));
  assert.throws(() => ensureSecretFiles(root, { integrations: { mcp: [{ secretsFile: 'link/keys.env' }] } }), /symlink/);
  assert.equal(secretFileProblem(root, 'link/keys.env'), 'unsafe or inaccessible path');
});
test('tracked or unignored files are rejected in a git worktree', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-secrets-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  assert.throws(() => ensureSecretFiles(root, model), /not ignored/);
  writeFileSync(join(root, '.gitignore'), '/private/keys.env\n');
  ensureSecretFiles(root, model);
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'private/keys.env'], { cwd: root }).status, 0);
});

test('generation creates ignored private files and check reports missing files', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-secrets-generate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config:\n        command: example\n      secretsFile: private/keys.env\n');
  const cli = new URL('../forge.mjs', import.meta.url).pathname;
  const generated = spawnSync(process.execPath, [cli, 'generate', root], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(lstatSync(join(root, 'private/keys.env')).mode & 0o777, 0o600);
  assert.equal(spawnSync('git', ['check-ignore', '-q', 'private/keys.env'], { cwd: root }).status, 0);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /\/faur env set NAME --file private\/keys\.env/);
  assert.match(readme, /Forge does not load this file; configure the integration to read it/);
  rmSync(join(root, 'private/keys.env'));
  const checked = spawnSync(process.execPath, [cli, 'check-agent', root], { encoding: 'utf8' });
  assert.match(checked.stdout, /Integration secretsFile private\/keys.env: missing/);
});

test('modify creates declared secret files after applying ignore rules', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-secrets-modify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
  const result = spawnSync(process.execPath, [new URL('../forge.mjs', import.meta.url).pathname, 'modify', root, '--yes'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(join(root, 'private/keys.env')).mode & 0o777, 0o600);
});

test('generate and modify reject unsafe existing secrets before other writes', t => {
  for (const command of ['generate', 'modify']) {
    const root = mkdtempSync(join(tmpdir(), 'forge-secrets-preflight-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.pi')); mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private/keys.env'), 'SECRET=never-print-this\n', { mode: 0o644 });
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
    const result = spawnSync(process.execPath, [new URL('../forge.mjs', import.meta.url).pathname, command, root, ...(command === 'modify' ? ['--yes'] : [])], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /permissions must exclude/);
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-this/);
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
    assert.throws(() => lstatSync(join(root, '.gitignore')), /ENOENT/);
  }
});

test('nested gitignore negations fail before generation or modification writes', t => {
  for (const command of ['generate', 'modify']) {
    const root = mkdtempSync(join(tmpdir(), 'forge-secrets-negation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    mkdirSync(join(root, '.pi')); mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private/.gitignore'), '!keys.env\n');
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
    const result = spawnSync(process.execPath, [new URL('../forge.mjs', import.meta.url).pathname, command, root, ...(command === 'modify' ? ['--yes'] : [])], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private\/\.gitignore contains negation rules/);
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
    assert.throws(() => lstatSync(join(root, '.gitignore')), /ENOENT/);
  }
});

test('root secret ignore negation fails before any writes without overriding user rules', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-secrets-root-ignore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.gitignore'), '/private/keys.env\n!private/keys.env\n');
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
  const result = spawnSync(process.execPath, [new URL('../forge.mjs', import.meta.url).pathname, 'generate', root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Root .gitignore contains a negation/);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '/private/keys.env\n!private/keys.env\n');
  assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
  assert.throws(() => lstatSync(join(root, 'private/keys.env')), /ENOENT/);
});

test('root negations cannot undo .env or .forge protections', t => {
  for (const rule of ['.env', '.forge/']) {
    const root = mkdtempSync(join(tmpdir(), 'forge-required-ignore-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.pi'));
    const original = `${rule}\n!${rule}\n`;
    writeFileSync(join(root, '.gitignore'), original);
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\n');
    const result = spawnSync(process.execPath, [new URL('../forge.mjs', import.meta.url).pathname, 'generate', root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Root .gitignore contains a negation/);
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), original);
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
  }
});

test('directory-only ignore does not protect a secret file and generation is idempotent', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-secret-dir-rule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.gitignore'), '/private/keys.env/\n');
  writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: private/keys.env\n');
  const cli = new URL('../forge.mjs', import.meta.url).pathname;
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [cli, 'generate', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.equal(ignore.split('\n').filter(line => line === '/private/keys.env').length, 1);
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'private/keys.env'], { cwd: root }).status, 0);
  }
});

test('literal disjoint root negations do not conflict while ancestor and trailing-space negations do', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-ignore-semantics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.pi'));
  const required = '.env\n.forge/\n.pi/state.json\n.pi/sessions/\n.pi/git/\n.pi/npm/\n';
  for (const [negation, expectedIgnored, conflict] of [
    ['!.pi/system.yaml', true, false],
    ['!.pi/sessions/example.json', true, false],
    ['!.forge/example', true, false],
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
  const root = mkdtempSync(join(tmpdir(), 'forge-ignore-descendant-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  mkdirSync(join(root, '.forge'));
  writeFileSync(join(root, '.forge', 'example'), 'test');
  const ignore = '.env\n.forge/\n.pi/state.json\n.pi/sessions/\n.pi/git/\n.pi/npm/\n!.forge/example\n';
  writeFileSync(join(root, '.gitignore'), ignore);
  assert.equal(spawnSync('git', ['check-ignore', '-q', '--', '.forge/example'], { cwd: root }).status, 0);
  assert.equal(gitignoreSafety(ignore, {}).conflict, null);
  assert.ok(gitignoreSafety(ignore + '!.forge/\n', {}).conflict);
});

test('reserved secretsFile paths are rejected before generate or modify writes', t => {
  for (const path of ['.forge', '.pi', 'data', 'private/.gitignore']) {
    for (const command of ['generate', 'modify']) {
      const root = mkdtempSync(join(tmpdir(), 'forge-secrets-reserved-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, '.pi'));
      writeFileSync(join(root, '.pi/system.yaml'), `schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\nintegrations:\n  mcp:\n    - name: example\n      config: { command: example }\n      secretsFile: ${path}\n`);
      const result = spawnSync(process.execPath, [new URL('../forge.mjs', import.meta.url).pathname, command, root, ...(command === 'modify' ? ['--yes'] : [])], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${command} ${path}`);
      assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
      assert.throws(() => lstatSync(join(root, '.gitignore')), /ENOENT/);
    }
  }
});

test('nested .pi negations fail before generation or modification without integration secrets', t => {
  for (const command of ['generate', 'modify']) {
    const root = mkdtempSync(join(tmpdir(), 'forge-pi-negation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    mkdirSync(join(root, '.pi'));
    writeFileSync(join(root, '.pi/system.yaml'), 'schema: 1\nname: test\norchestrator:\n  name: lead\n  model: p/m\n');
    writeFileSync(join(root, '.pi/.gitignore'), '!state.json   \n');
    writeFileSync(join(root, '.gitignore'), '.pi/state.json\n');
    assert.notEqual(spawnSync('git', ['check-ignore', '-q', '--', '.pi/state.json'], { cwd: root }).status, 0);
    const result = spawnSync(process.execPath, [new URL('../forge.mjs', import.meta.url).pathname, command, root, ...(command === 'modify' ? ['--yes'] : [])], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required ignore .pi\/state.json: .pi\/\.gitignore contains negation rules/);
    assert.equal(readFileSync(join(root, '.pi/.gitignore'), 'utf8'), '!state.json   \n');
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.pi/state.json\n');
    assert.throws(() => lstatSync(join(root, 'README.md')), /ENOENT/);
  }
});
