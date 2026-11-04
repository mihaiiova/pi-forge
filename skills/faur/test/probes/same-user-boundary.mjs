#!/usr/bin/env node
// Disposable negative-control probe. Never use real credentials here.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

const root = mkdtempSync(join(tmpdir(), 'faur-boundary-probe-'));
const children = [];
const observer = `
  const fs = require('node:fs');
  const [source, link, pid] = process.argv.slice(1);
  const expected = fs.readFileSync(0, 'utf8');
  const check = path => {
    try { return fs.readFileSync(path).includes(Buffer.from(expected)) ? 'readable' : 'not-found'; }
    catch (e) { return 'error:' + e.code; }
  };
  console.log(JSON.stringify({ source: check(source), symlink: check(link), procEnviron: process.platform === 'linux' ? check('/proc/' + pid + '/environ') : 'skip:non-linux' }));
`;
try {
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const sentinel = 'FAUR_PROBE_' + randomBytes(24).toString('hex');
    const source = join(root, `source-${i}`), link = join(root, `link-${i}`);
    writeFileSync(source, sentinel, { mode: 0o600 });
    symlinkSync(source, link);
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
      env: { PATH: process.env.PATH ?? '', FAUR_PROBE_SENTINEL: sentinel }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);
    await once(child.stdout, 'data');
    runs.push({ source, link, sentinel, child });
  }
  const results = runs.map(run => JSON.parse(execFileSync(process.execPath,
    ['-e', observer, run.source, run.link, String(run.child.pid)], { encoding: 'utf8', input: run.sentinel })));
  // Observer is a separate same-UID process, including for the other live run.
  console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, uid: process.getuid?.(), concurrentRuns: results, note: 'Negative control only: readable means no confidentiality boundary.' }, null, 2));
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit').catch(() => {}) : Promise.resolve()));
  rmSync(root, { recursive: true, force: true });
}
