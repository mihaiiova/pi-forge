import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const repo = resolve(import.meta.dirname, '..');

test('plain Pi installs the pinned package and registers its commands', {
  skip: process.env.FAUR_CLEAN_MACHINE_TEST !== '1' && 'set FAUR_CLEAN_MACHINE_TEST=1 after publishing the pinned release; requires network and Pi',
  timeout: 180000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'faur-clean-machine-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(join(project, '.pi'), { recursive: true });
  copyFileSync(join(import.meta.dirname, 'fixtures/generate/minimal/.pi/system.yaml'), join(project, '.pi/system.yaml'));
  execFileSync(process.execPath, [join(repo, 'src/faur.mjs'), 'generate', project]);

  // A clean HOME prevents inheriting the
  // caller's Pi home, credentials, npm cache or Git configuration.
  // npm, which Pi runs to install packages, otherwise writes a debug log and
  // an update check from detached processes after Pi exits, racing the cleanup.
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), npm_config_logs_max: '0', npm_config_update_notifier: 'false' };
  const child = spawn('pi', ['--mode', 'rpc', '--no-session'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Stop Pi and wait for it before removing the files it may still write.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(done => child.once('exit', done));
      child.stdin.end();
      child.kill();
      await Promise.race([exited, new Promise(done => setTimeout(done, 10000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // npm processes Pi started can still write into the home for a few seconds.
    for (let tries = 0; ; tries++) {
      try { rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (error.code !== 'ENOTEMPTY' || tries >= 30) throw error; await new Promise(done => setTimeout(done, 500)); }
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  const lines = createInterface({ input: child.stdout });
  const response = await new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Pi startup: ${stderr}`)), 165000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Pi exited ${code} before responding: ${stderr}`)); });
    lines.on('line', line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (value.id !== 'commands') return;
      clearTimeout(timer);
      lines.close();
      resolveResponse(value);
    });
    child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
  });
  assert.equal(response.success, true, stderr);
  const names = response.data.commands.map(command => command.name);
  assert.equal(names.filter(name => name === 'faur').length, 1, stderr);
  assert.deepEqual(names.filter(name => /factory/.test(name)), [], stderr);
  // Installed from the pinned tag into the project, where git ignores it.
  const source = response.data.commands.find(command => command.name === 'faur').sourceInfo;
  assert.match(source.source, /^git:github\.com\/mihaiiova\/faur@v\d+\.\d+\.\d+$/);
  assert.equal(source.baseDir, join(project, '.pi/git/github.com/mihaiiova/faur'));
});
