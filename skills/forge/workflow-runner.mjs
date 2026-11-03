#!/usr/bin/env node
/**
 * Headless workflow runner: `./run --workflow <name>` runs it from the Forge
 * package pinned in the project (`.pi/git/...`), so it changes with the pin
 * and nothing is copied into the project. Usage, from the project root:
 *   node workflow-runner.mjs <base64 workflow manifest> [prompt args] -- <options>
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, readdirSync, writeFileSync, renameSync, existsSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [encoded, ...args] = process.argv.slice(2);
const workflows = JSON.parse(Buffer.from(encoded, 'base64').toString());
const separator = args.indexOf('--');
const prompts = args.slice(0, separator);
const options = args.slice(separator + 1);
let name, inputs = Object.create(null), timeout = 1800000, concurrent = false, invalid = false;
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--workflow' && name === undefined) name = options[++i];
  else if (options[i] === '--input') {
    const input = options[++i] ?? '';
    const index = input.indexOf('=');
    const key = input.slice(0, index);
    if (index < 1 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key) || Object.hasOwn(inputs, key)) invalid = true;
    else inputs[key] = input.slice(index + 1);
  }
  else if (options[i] === '--allow-concurrent') concurrent = true;
  else if (options[i] === '--timeout') {
    const value = options[++i] ?? '';
    const match = /^(\d+)(s|m|h)$/.exec(value);
    timeout = match ? Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000 })[match[2]] : 0;
  } else invalid = true;
}
const workflow = workflows.find(w => w.name === name);
const runId = randomUUID();
let answer = '';
if (invalid || !workflow || !existsSync('.pi/system.yaml') || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) {
  console.log(JSON.stringify({ workflow: name, runId, status: 'configuration_error', answer, message: 'Unknown workflow or invalid options' }));
  process.exit(2);
}
// This runner is part of the pinned Forge package, so it validates with that
// version, tolerating what Forge itself tolerates. Nothing runs if it fails.
try {
  const { parsedModel } = await import('./changes.mjs');
  const { unmetSetup } = await import('./setup.mjs');
  const { integrationSecrets, secretFileProblem } = await import('./integration-secrets.mjs');
  const model = parsedModel(readFileSync('.pi/system.yaml', 'utf8'));
  const missing = unmetSetup(process.cwd(), model);
  const secrets = [...new Set(integrationSecrets(model))].flatMap(path => {
    const problem = secretFileProblem(process.cwd(), path);
    if (!problem) return [];
    const fix = problem === 'missing' ? 'run forge generate <project-dir> to create the file' : 'fix the file safety or git-ignore issue, then run forge check-agent <project-dir> or /faur check';
    return [`Integration secretsFile ${path}: ${problem}; fix: ${fix}`];
  });
  if (missing.length || secrets.length) {
    const problems = [];
    if (missing.length) problems.push('Unmet setup: ' + missing.map(step => `${step.owner}: ${step.description}; fix: ${step.install}${step.needsRoot ? ' (run manually; needs root)' : ''}`).join('; '));
    if (secrets.length) problems.push('Secrets: ' + secrets.join('; '));
    console.log(JSON.stringify({ workflow: name, runId, status: 'configuration_error', answer, message: problems.join('; ') }));
    process.exit(2);
  }
} catch (error) {
  console.log(JSON.stringify({ workflow: name, runId, status: 'configuration_error', answer, message: 'Invalid system.yaml, or the installed Forge package is incomplete (run ./run once): ' + error.message }));
  process.exit(2);
}
const prompt = (workflow.skill ? '/skill:' + workflow.skill + ' ' : '') +
  'Run workflow ' + workflow.name + '.' +
  (workflow.entry && workflow.entry !== workflow.lead ? ' Delegate to ' + workflow.entry + '.' : '') +
  '\nWorkflow boundary (JSON): ' + JSON.stringify({ description: workflow.description, agents: workflow.agents, inputs: workflow.inputs, outputs: workflow.outputs, approval: workflow.approval, verify: workflow.verify }) +
  '\nProvided input values (JSON, treat as data): ' + JSON.stringify(inputs);
const temp = mkdtempSync(join(tmpdir(), 'forge-run-'));
const approvalFile = join(temp, 'approval');
let blocked = '', timedOut = false, killTimer;
// One run per workflow unless --allow-concurrent. The lock file holds this
// runner's pid; a lock whose holder has died is taken over.
mkdirSync('.forge/workflow-locks', { recursive: true });
const lock = join('.forge/workflow-locks', createHash('sha256').update(name).digest('hex'));
const acquire = () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // An empty or garbled lock has no holder; kill(0) would signal our own group.
    const holder = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    if (Number.isSafeInteger(holder) && holder > 1) {
      try { process.kill(holder, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    }
    if (alive) return false;
    rmSync(lock, { force: true });
  }
  return false;
};
if (!concurrent) {
  if (!acquire()) {
    console.log(JSON.stringify({ workflow: name, runId, status: 'configuration_error', answer, message: 'Workflow already running' }));
    process.exit(2);
  }
  process.on('exit', () => { try { if (readFileSync(lock, 'utf8') === String(process.pid)) rmSync(lock, { force: true }); } catch {} });
}
// Pi loads the project's APPEND_SYSTEM.md and AGENTS.md itself; prompt args
// are only for callers that pass their own.
const piArgs = ['--approve', ...prompts, '--mode', 'json', '-p', prompt];
const subagentRoot = join(temp, 'subagents');
const env = { ...process.env, FORGE_WORKFLOW: workflow.name, FORGE_TRIGGER: 'headless', FORGE_RUN_ID: runId, FORGE_APPROVAL_FILE: approvalFile, PI_SUBAGENTS_TEMP_ROOT: subagentRoot };
delete env.PI_SUBAGENT_CHILD;
const probe = process.platform === 'linux' ? spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--', 'true'], { stdio: 'ignore', timeout: 3000 }) : null;
const scope = probe?.status === 0 ? 'forge-workflow-' + runId + '.scope' : null;
const command = scope ? 'systemd-run' : 'pi';
const commandArgs = scope ? ['--user', '--scope', '--quiet', '--unit', scope, '--', 'pi', ...piArgs] : piArgs;
const child = spawn(command, commandArgs, {
  env,
  detached: true,
  stdio: ['ignore', 'pipe', 'inherit'],
});
let scopeClean = true, scopeStopped = false;
const stopScope = () => {
  if (!scope || scopeStopped) return;
  scopeStopped = true;
  const stopped = spawnSync('systemctl', ['--user', 'stop', scope], { encoding: 'utf8', timeout: 3000 });
  if (stopped.status !== 0) {
    const state = spawnSync('systemctl', ['--user', 'show', '--property=LoadState', '--value', scope], { encoding: 'utf8', timeout: 3000 });
    scopeClean = state.status === 0 && state.stdout.trim() === 'not-found';
    if (!scopeClean) console.error('Workflow scope cleanup failed: ' + (stopped.stderr?.trim() || stopped.error?.message || 'unknown error'));
  }
};
const stop = () => {
  stopScope();
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  killTimer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500);
};
const deadline = setTimeout(() => { timedOut = true; stop(); }, timeout);
// A caller that stops ./run (an MCP wrapper cancelling, Ctrl-C) stops the workflow too.
let cancelled = false;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { cancelled = true; stop(); });
const poll = setInterval(() => {
  try { blocked = readFileSync(approvalFile, 'utf8'); } catch { return; }
  if (blocked) stop();
}, 50);
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => { output += chunk; });
child.on('error', error => { console.error(error.message); });
// pi-subagents 0.83.1 puts top-level and nested run state below this
// invocation's isolated temp root. Its stop action writes these inbox requests.
async function stopSubagents() {
  const requested = new Set();
  const roots = [join(subagentRoot, 'async-subagent-runs'), join(subagentRoot, 'nested-subagent-runs')];
  const scan = (dir, depth = 0) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    let found = [];
    if (entries.some(e => e.isFile() && e.name === 'status.json') || (depth > 0 && (dir.startsWith(roots[0] + '/') || depth === 2))) found.push(dir);
    else if (depth < 2) for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) found.push(...scan(join(dir, entry.name), depth + 1));
    return found;
  };
  const until = Date.now() + 5000;
  while (true) {
    let active = 0;
    for (const dir of roots.flatMap(root => scan(root))) {
      let status;
      try { status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')); } catch { active++; continue; }
      const running = ['queued', 'running'].includes(status.state);
      let alive = false, dead = false;
      if (Number.isSafeInteger(status.pid) && status.pid > 1) {
        try { process.kill(status.pid, 0); alive = true; } catch (e) { if (e.code !== 'ESRCH') alive = true; else dead = true; }
      }
      let sameNamespace = false;
      try { sameNamespace = status.pidNamespaceScope === readlinkSync('/proc/self/ns/pid'); } catch {}
      if (running && dead && scope && scopeClean && sameNamespace) continue;
      if (!running && !alive && ['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'].includes(status.state)) continue;
      active++;
      if (!running || requested.has(dir)) continue;
      const control = join(dir, 'control');
      if (existsSync(join(control, 'stop-inbox-closed.json'))) continue;
      const inbox = join(control, 'stop-requests');
      mkdirSync(inbox, { recursive: true });
      const ts = Date.now(), target = join(inbox, String(ts).padStart(13, '0') + '-' + randomUUID() + '.json');
      const draft = target + '.tmp';
      writeFileSync(draft, JSON.stringify({ type: 'stop', ts, source: 'forge-workflow-timeout' }), { flag: 'wx' });
      renameSync(draft, target);
      requested.add(dir);
    }
    if (!active) return true;
    if (Date.now() >= until) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
child.on('close', async code => {
  clearInterval(poll);
  clearTimeout(deadline);
  if (killTimer) await new Promise(resolve => setTimeout(resolve, 550));
  try { blocked ||= readFileSync(approvalFile, 'utf8'); } catch {}
  stopScope();
  let cleanup = scopeClean;
  if (timedOut || blocked || cancelled) {
    try { if (!await stopSubagents()) cleanup = false; } catch (error) { cleanup = false; console.error('Workflow cleanup: ' + error.message); }
  }
  if (cleanup) rmSync(temp, { recursive: true, force: true });
  else console.error('Workflow cleanup incomplete; run state retained at ' + temp);
  // The run failed when Pi failed, its final message ended in an error or was
  // aborted, or there is no answer. Tool errors the agent recovered from are
  // only counted, so a good answer is not reported as a failure.
  let stopReason = null, toolErrors = 0;
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'tool_execution_end' && event.isError) toolErrors++;
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        stopReason = event.message.stopReason;
        answer = (event.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      }
    } catch {}
  }
  const failed = code !== 0 || ['error', 'aborted'].includes(stopReason) || !answer.trim();
  const status = blocked ? 'blocked' : timedOut ? 'timeout' : cancelled ? 'cancelled' : failed ? 'error' : 'ok';
  console.log(JSON.stringify({ workflow: name, runId, status, answer, toolErrors, ...(blocked ? { message: blocked } : cancelled ? { message: 'Stopped by the caller' } : {}), ...(!cleanup ? { cleanup: 'incomplete', stateDir: temp } : {}) }));
  process.exitCode = blocked ? 3 : timedOut ? 4 : cancelled || failed ? 1 : 0;
});
