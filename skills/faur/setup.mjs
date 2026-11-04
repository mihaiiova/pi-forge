import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Declared setup steps in project, MCP and CLI order. */
export function setupSteps(model) {
  return [
    ...(model.setup ?? []).map(step => ({ ...step, owner: 'project' })),
    ...(model.integrations?.mcp ?? []).flatMap(server => (server.setup ?? []).map(step => ({ ...step, owner: `MCP ${server.name}` }))),
    ...(model.integrations?.cli ?? []).flatMap(command => (command.setup ?? []).map(step => ({ ...step, owner: `CLI ${command.name}` }))),
  ];
}

/** Checks execute declared shell commands with the user's privileges; use trusted projects only. */
export function unmetSetup(root, model, platform = process.platform) {
  return setupSteps(model).filter(step => {
    if (step.platforms && !step.platforms.includes(platform)) return false;
    if (step.check.file) return !existsSync(resolve(root, step.check.file));
    const result = spawnSync('/bin/sh', ['-c', step.check.command], { cwd: root, stdio: 'ignore', timeout: 30000 });
    return result.status !== 0;
  });
}

/** Run only previously approved, still unmet installs; root steps are never run. */
export function installSetup(root, model, approvedSteps) {
  if (!Array.isArray(approvedSteps)) throw new Error('Setup installation requires explicit confirmation');
  const approved = new Set(approvedSteps.map(step => JSON.stringify(step)));
  const results = [];
  for (const step of unmetSetup(root, model).filter(step => approved.has(JSON.stringify(step)))) {
    if (step.needsRoot) { results.push({ ...step, status: 'needsRoot' }); continue; }
    const result = spawnSync('/bin/sh', ['-c', step.install], { cwd: root, stdio: 'inherit' });
    results.push({ ...step, status: result.status === 0 ? 'installed' : 'failed' });
    if (result.status !== 0) break;
  }
  return results;
}
