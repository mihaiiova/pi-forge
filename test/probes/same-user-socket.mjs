#!/usr/bin/env node
// Negative control: mode 0600 does not authenticate a same-UID Unix client.
// Uses a random sentinel, not a credential; does not start Pi or a real broker.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

if (process.platform === 'win32') {
  console.log(JSON.stringify({ status: 'skip', reason: 'Unix-domain socket probe requires a Unix platform' }));
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), 'faur-socket-probe-'));
const path = join(root, 'broker.sock');
const sentinel = 'FAUR_PROBE_' + randomBytes(24).toString('hex');
const server = createServer(socket => socket.end(sentinel));
let child;
try {
  server.listen(path);
  await once(server, 'listening');
  chmodSync(path, 0o600);
  const observer = `
    const net = require('node:net');
    const expected = require('node:fs').readFileSync(0, 'utf8');
    const socket = net.connect(process.argv[1]);
    let received = '';
    socket.on('data', chunk => { received += chunk; });
    socket.on('end', () => { console.log(JSON.stringify({sameUserReceivedSentinel: received === expected})); });
    socket.on('error', error => { console.error(error.code); process.exitCode = 1; });
  `;
  child = spawn(process.execPath, ['-e', observer, path], { stdio: ['pipe', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const ended = once(child, 'close');
  child.stdin.end(sentinel);
  const [code] = await ended;
  if (code !== 0) throw new Error(`observer exited ${code}`);
  const result = JSON.parse(output);
  console.log(JSON.stringify({ platform: process.platform, uid: process.getuid?.(), socketMode: '0600', ...result, note: 'Negative control, not a protected broker or peer-authentication test.' }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
