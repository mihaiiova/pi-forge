#!/usr/bin/env node
// Local-only feasibility test, NOT a security boundary. Pass the installed
// @playwright/mcp 0.0.83 cli.js path; it never downloads packages or a browser.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const cli = process.argv[2] && resolve(process.argv[2]);
if (!cli) { console.error('Usage: node playwright-secret-smoke.mjs /path/to/@playwright/mcp/cli.js'); process.exit(2); }
const pkg = JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8'));
if (pkg.name !== '@playwright/mcp' || pkg.version !== '0.0.83') throw new Error('Expected @playwright/mcp 0.0.83');
const root = mkdtempSync(join(tmpdir(), 'faur-playwright-probe-'));
const sentinel = 'FAUR_SENTINEL_' + randomBytes(24).toString('hex');
const secretFile = join(root, 'sentinels.env');
writeFileSync(secretFile, `LOGIN_VALUE=${sentinel}\n`, { mode: 0o600 });
let received = false;
const server = createServer((req, res) => {
  if (req.url === '/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received = new URLSearchParams(body).get('password') === sentinel; res.end('submitted'); });
  } else {
    res.setHeader('content-type', 'text/html');
    res.end('<form action="/submit" method="post"><label>Password <input id="password" name="password" type="password"></label><button type="submit">Submit</button></form>');
  }
});
let child;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  child = spawn(process.execPath, [cli, '--headless', '--isolated', '--browser', 'chromium', '--secrets', secretFile], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const pending = new Map();
  let next = 0, leaked = false;
  const rejectAll = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', rejectAll);
  child.on('exit', () => rejectAll(new Error('Playwright MCP exited before completing the probe')));
  createInterface({ input: child.stdout }).on('line', line => {
    if (line.includes(sentinel)) leaked = true;
    let message; try { message = JSON.parse(line); } catch { return; }
    const p = pending.get(message.id); if (!p) return;
    pending.delete(message.id);
    if (message.error || message.result?.isError) p.reject(new Error('MCP request failed (details suppressed)'));
    else p.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out')); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolveRequest(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'faur-probe', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = (name, args) => request('tools/call', { name, arguments: args });
  await call('browser_navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await call('browser_type', { target: '#password', text: 'LOGIN_VALUE', submit: true });
  for (let i = 0; i < 40 && !received; i++) await new Promise(r => setTimeout(r, 50));
  if (!received) throw new Error('Local target did not receive the selected sentinel');
  console.log(JSON.stringify({ package: pkg.name, version: pkg.version, localFormReceivedSentinel: received, sentinelObservedInMcpStdout: leaked, note: 'Feasibility only: source file is readable by the same OS user; no confinement tested.' }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  rmSync(root, { recursive: true, force: true });
}
