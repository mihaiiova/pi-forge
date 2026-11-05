/**
 * registry-skills — skills from the open Agent Skills ecosystem (skills.sh).
 *
 * Built on the ecosystem's own primitives instead of reimplementing them:
 * search uses the skills.sh API (the backend of `npx skills find`), and
 * installation runs the pinned `skills` CLI with `--agent pi`, which copies the
 * skill into the project's `.agents/skills/<name>/` and records it in
 * `skills-lock.json`. Installs are always project-local, never global (`-g`).
 *
 * A declaration pins one skill directory to a commit:
 *   source: skills:<owner>/<repo>/<path-to-skill-dir>@<40-hex commit>
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, lstatSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { safePath } from './maintenance-store.mjs';
import { fetchDocument } from './maintenance-fetch.mjs';
import { REGISTRY_SOURCE_RE } from './skill-sources.mjs';

/** The `skills` CLI release the Faur installs with. */
export const SKILLS_CLI = 'skills@1.7.4';
const INSTALL_TIMEOUT = 180000;

export function parseRegistrySource(source) {
  const match = typeof source === 'string' ? source.match(REGISTRY_SOURCE_RE) : null;
  if (!match || match[3].split('/').some((seg) => seg === '..' || seg === '.')) return null;
  const [, owner, repo, path, ref] = match;
  return { owner, repo, path, ref, url: `https://github.com/${owner}/${repo}/tree/${ref}/${path}` };
}

export function registrySkills(model) {
  return (Array.isArray(model?.skills) ? model.skills : [])
    .filter((skill) => skill && typeof skill.name === 'string' && parseRegistrySource(skill.source));
}

export const installedDir = (name) => `.agents/skills/${name}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Search skills.sh. Results are untrusted discovery data, sorted by installs. */
export async function searchSkills(query, { fetcher = fetchDocument, limit = 10 } = {}) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const doc = await fetcher(`https://skills.sh/api/search?${params}`);
  const data = JSON.parse(doc.text);
  return (Array.isArray(data?.skills) ? data.skills : [])
    .filter((s) => typeof s?.id === 'string')
    .map((s) => ({ name: String(s.name ?? s.skillId ?? ''), source: String(s.source ?? ''), installs: Number(s.installs) || 0, page: `https://skills.sh/${s.id}` }))
    .sort((a, b) => b.installs - a.installs);
}

/**
 * Read what a pinned skill would install, from GitHub at that exact commit:
 * its file list and SKILL.md text (plus its hash, checked after install).
 */
export async function previewRegistrySkill(source, { fetcher = fetchDocument } = {}) {
  const parsed = parseRegistrySource(source);
  if (!parsed) throw new Error(`Not a pinned skills: source: ${source}`);
  const { owner, repo, path, ref } = parsed;
  const skillMd = (await fetcher(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}/SKILL.md`)).text;
  let files = [];
  let fileListComplete = false;
  try {
    const tree = JSON.parse((await fetcher(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`)).text);
    files = (tree.tree ?? []).filter((e) => e.type === 'blob' && e.path.startsWith(`${path}/`)).map((e) => e.path.slice(path.length + 1));
    fileListComplete = tree.truncated !== true;
  } catch { /* the file list is informational; SKILL.md is what gets verified */ }
  return { source, page: parsed.url, ref, files, fileListComplete, skillMd, skillMdSha256: sha256(skillMd) };
}

/**
 * Pin a search result ("owner/repo" plus skill name, or "owner/repo@name") to
 * a declaration: the repository's current commit and the directory whose
 * SKILL.md declares that name. Returns the `skills:` source and its preview.
 */
export async function resolveRegistrySkill(spec, { fetcher = fetchDocument } = {}) {
  const match = String(spec).match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.: -]+)$/);
  if (!match) throw new Error('Expected owner/repo@skill-name (as listed by skills.sh)');
  const [, owner, repo, name] = match;
  const commit = JSON.parse((await fetcher(`https://api.github.com/repos/${owner}/${repo}/commits/HEAD`)).text);
  const ref = commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(ref ?? '')) throw new Error(`Could not read the current commit of ${owner}/${repo}`);
  const tree = JSON.parse((await fetcher(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`)).text);
  const dirs = (tree.tree ?? []).filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path)).map((e) => e.path.replace(/\/?SKILL\.md$/, ''));
  const byBasename = dirs.filter((d) => d.split('/').pop() === name);
  // Directories named after the skill first; a few others in case the
  // directory name differs from the skill's declared name.
  const candidates = [...byBasename, ...dirs.filter((d) => d && !byBasename.includes(d)).slice(0, 10)];
  for (const dir of candidates) {
    const source = `skills:${owner}/${repo}/${dir}@${ref}`;
    const preview = await previewRegistrySkill(source, { fetcher });
    if (preview.skillMd.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1] === name) return { name, source, preview };
  }
  throw new Error(`No SKILL.md named "${name}" found in ${owner}/${repo} at ${ref.slice(0, 12)}`);
}

function runCli(root, args, run) {
  return run('npx', ['-y', SKILLS_CLI, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: INSTALL_TIMEOUT, env: process.env });
}

function lockEntry(root, name) {
  const file = safePath(root, 'skills-lock.json');
  try { return JSON.parse(readFileSync(file, 'utf8'))?.skills?.[name] ?? null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Install one pinned skill into the project with the skills CLI, then verify
 * the result: the expected directory, the pinned commit in skills-lock.json,
 * and (when previewed) the exact SKILL.md the user saw. A failed check removes
 * the installed copy again.
 */
export function installRegistrySkill(root, skill, { expectedSha256, run = execFileSync } = {}) {
  const parsed = parseRegistrySource(skill.source);
  if (!parsed) throw new Error(`skill "${skill.name}": not a pinned skills: source`);
  try {
    runCli(root, ['add', parsed.url, '--agent', 'pi', '--copy', '-y'], run);
  } catch (error) {
    throw new Error(`skills CLI could not install "${skill.name}" from ${parsed.url}: ${String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ')}`);
  }
  const file = safePath(root, `${installedDir(skill.name)}/SKILL.md`);
  const problem = !existsSync(file) ? `nothing was installed at ${installedDir(skill.name)}/ (the skill's own name may differ; declare it under that name)`
    : lockEntry(root, skill.name)?.ref !== parsed.ref ? `skills-lock.json does not record commit ${parsed.ref}`
    : expectedSha256 && sha256(readFileSync(file, 'utf8')) !== expectedSha256 ? 'the installed SKILL.md differs from the previewed one'
    : null;
  if (problem) {
    if (existsSync(file)) removeRegistrySkill(root, skill.name, { run });
    throw new Error(`skill "${skill.name}": ${problem}; nothing kept`);
  }
}

export function removeRegistrySkill(root, name, { run = execFileSync } = {}) {
  try {
    runCli(root, ['remove', name, '--agent', 'pi', '-y'], run);
  } catch { /* fall back to removing the copy directly */ }
  rmSync(join(root, installedDir(name)), { recursive: true, force: true });
}

/** Capture only affected skill trees and the shared lock; reject symlinks and
 * special files instead of following them outside the project. */
export function registrySnapshot(root, names) {
  const entries = {};
  const visit = (rel) => {
    const path = safePath(root, rel);
    let info;
    try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isDirectory()) {
      entries[rel] = { directory: true, mode: info.mode & 0o7777 };
      for (const name of readdirSync(path).sort()) visit(`${rel}/${name}`);
    } else if (info.isFile()) {
      entries[rel] = { content: readFileSync(path), mode: info.mode & 0o7777 };
    } else throw new Error(`Unsupported registry skill path: ${rel}`);
  };
  for (const name of [...new Set(names)].sort()) visit(installedDir(name));
  visit('skills-lock.json');
  return entries;
}

/** Stable structural signature catches added files and permission changes too. */
export function registrySignature(snapshot) {
  return JSON.stringify(Object.entries(snapshot).map(([path, entry]) => [path, entry.mode, entry.directory ? 'directory' : sha256(entry.content)]));
}

/** Run the skills CLI in a temporary project; return only checked file changes.
 * The CLI is not OS-sandboxed: staging prevents normal project-local writes,
 * not arbitrary behavior by the CLI or downloaded code. */
export function stageRegistrySkills(root, skills, expected, previews, { run } = {}) {
  const names = [...new Set([...skills.install.map(s => s.name), ...skills.remove])].sort();
  const before = registrySnapshot(root, names);
  if (registrySignature(before) !== expected) throw new Error('Registry skills changed since preview; preview again');
  const stage = mkdtempSync(join(tmpdir(), 'faur-registry-'));
  try {
    for (const [path, entry] of Object.entries(before)) {
      const target = join(stage, path);
      if (entry.directory) { mkdirSync(target, { recursive: true, mode: entry.mode }); chmodSync(target, entry.mode); }
      else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, entry.content, { mode: entry.mode }); chmodSync(target, entry.mode); }
    }
    // Reinstall the old pinned source in a clean project. Only an exact tree
    // match authorizes deleting or replacing the existing developer-owned copy.
    for (const skill of skills.verify ?? []) {
      const verification = mkdtempSync(join(tmpdir(), 'faur-registry-verify-'));
      try {
        installRegistrySkill(verification, skill, run ? { run } : {});
        const parsed = parseRegistrySource(skill.source);
        const lock = lockEntry(verification, skill.name);
        if (lock?.source !== `${parsed.owner}/${parsed.repo}`) throw new Error(`Registry verification source mismatch: ${skill.name}`);
        const original = Object.fromEntries(Object.entries(before).filter(([path]) => path === installedDir(skill.name) || path.startsWith(`${installedDir(skill.name)}/`)));
        const pristine = Object.fromEntries(Object.entries(registrySnapshot(verification, [skill.name])).filter(([path]) => path !== 'skills-lock.json'));
        if (registrySignature(original) !== registrySignature(pristine)) throw new Error(`Registry skill ${skill.name} differs from its pinned source; preserve or remove it explicitly`);
      } finally { rmSync(verification, { recursive: true, force: true }); }
    }
    const replaced = new Set((skills.verify ?? []).map(s => s.name));
    for (const skill of skills.install.filter(s => replaced.has(s.name))) {
      removeRegistrySkill(stage, skill.name, run ? { run } : {});
      if (lockEntry(stage, skill.name) !== null) throw new Error(`skills CLI did not remove ${skill.name} from skills-lock.json`);
    }
    for (const skill of skills.install) {
      const hash = previews?.[skill.name]?.skillMdSha256;
      if (!hash) throw new Error(`Registry skill ${skill.name} has not been previewed`);
      installRegistrySkill(stage, skill, { expectedSha256: hash, ...(run ? { run } : {}) });
    }
    for (const name of skills.remove) {
      if (existsSync(safePath(stage, installedDir(name)))) {
        removeRegistrySkill(stage, name, run ? { run } : {});
        if (lockEntry(stage, name) !== null) throw new Error(`skills CLI did not remove ${name} from skills-lock.json`);
      } else {
        // The developer already removed the copy; the CLI may not recognize a
        // lock-only entry. Remove only this previously declared skill's entry.
        const path = safePath(stage, 'skills-lock.json');
        if (existsSync(path)) {
          const lock = JSON.parse(readFileSync(path, 'utf8'));
          if (lock.skills && Object.hasOwn(lock.skills, name)) {
            delete lock.skills[name];
            writeFileSync(path, JSON.stringify(lock, null, 2) + '\n');
          }
        }
      }
    }
    const after = registrySnapshot(stage, names);
    const lock = snapshot => {
      const data = snapshot['skills-lock.json']?.content;
      return data ? JSON.parse(data.toString('utf8')) : { skills: {} };
    };
    const { skills: originalLock = {}, ...originalMetadata } = lock(before);
    const { skills: updatedLock = {}, ...updatedMetadata } = lock(after);
    if (before['skills-lock.json'] && JSON.stringify(originalMetadata) !== JSON.stringify(updatedMetadata)) throw new Error('skills CLI changed unrelated lock metadata');
    for (const name of new Set([...Object.keys(originalLock), ...Object.keys(updatedLock)])) {
      if (!names.includes(name) && JSON.stringify(originalLock[name]) !== JSON.stringify(updatedLock[name])) throw new Error(`skills CLI changed unrelated lock entry: ${name}`);
    }
    const writes = {}, modes = {};
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const old = before[path], next = after[path];
      if (old && next && !!old.directory !== !!next.directory) throw new Error(`skills CLI changed path type: ${path}`);
      if (old?.directory && next?.directory && old.mode !== next.mode) throw new Error(`skills CLI changed existing directory mode: ${path}`);
      if (old?.directory || next?.directory) continue;
      if (!next) writes[path] = null;
      else if (!old || old.mode !== next.mode || !old.content.equals(next.content)) { writes[path] = next.content; modes[path] = next.mode; }
    }
    const removeDirs = Object.keys(before).filter(path => before[path].directory && !after[path]).sort((a, b) => b.length - a.length);
    const createDirs = Object.keys(after).filter(path => after[path].directory && !before[path]).sort((a, b) => a.length - b.length).map(path => ({ path, mode: after[path].mode }));
    return { writes, modes, removeDirs, createDirs };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
