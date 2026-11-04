/** Local maintenance IO: safe relative paths, fingerprints, checked writes. */
import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, rmSync, chmodSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const digest = data => createHash('sha256').update(data).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
export function safePath(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\\') || rel.split('/').some(p => !p || p === '.' || p === '..') || rel.startsWith('/')) throw new Error(`Unsafe maintenance path: ${rel}`);
  const target = resolve(root, rel);
  if (relative(root, target).startsWith('..')) throw new Error('Path outside project');
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${rel}`);
    // Also catches dangling symlinks.
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${rel}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
export function readText(root, rel) {
  const path = safePath(root, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
export function readJson(root, rel) {
  const text = readText(root, rel);
  if (text === null) throw new Error(`Missing ${rel}`);
  return JSON.parse(text);
}
export function atomicWrite(root, rel, content) {
  const path = safePath(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
  if (rel === 'run') chmodSync(path, 0o755);
}
export function fingerprints(root, paths) {
  return Object.fromEntries([...new Set(paths)].sort().map(p => {
    const path = safePath(root, p);
    return [p, existsSync(path) ? digest(readFileSync(path)) : null];
  }));
}
export function assertUnchanged(root, expected) {
  for (const [p, hash] of Object.entries(expected)) if (fingerprints(root, [p])[p] !== hash) throw new Error(`Project changed since preview: ${p}; preview again`);
}
/** Apply checked writes with best-effort rollback on a synchronous failure.
 * This is not crash-safe or isolated from concurrent readers. */
export function applyWrites(root, writes, expected, approved = false, { write = atomicWrite, afterWrites = () => {}, modes = {}, removeDirs = [], createDirs = [] } = {}) {
  if (approved !== true) throw new Error('Explicit user approval required');
  assertUnchanged(root, expected);
  const before = new Map();
  for (const p of Object.keys(writes)) {
    const path = safePath(root, p);
    if (!existsSync(path)) { before.set(p, null); continue; }
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${p}`);
    before.set(p, { content: readFileSync(path), mode: stat.mode & 0o7777 });
  }
  const directories = removeDirs.map(p => {
    const info = lstatSync(safePath(root, p));
    if (!info.isDirectory()) throw new Error(`Not a directory: ${p}`);
    return { path: p, mode: info.mode & 0o7777 };
  });
  // Record absent parents before any writes so rollback can remove only empty
  // directories created by this apply, without deleting existing project data.
  const absentParents = new Set();
  for (const rel of [...Object.keys(writes), ...createDirs.map(d => d.path)]) {
    for (let parent = dirname(rel); parent !== '.'; parent = dirname(parent)) {
      if (!existsSync(safePath(root, parent))) absentParents.add(parent);
    }
  }
  const touched = [], removedDirs = [], createdDirs = [];
  try {
    for (const dir of createDirs) {
      const path = safePath(root, dir.path);
      if (existsSync(path)) throw new Error(`Project changed since preview: ${dir.path}; preview again`);
      mkdirSync(path, { recursive: true, mode: dir.mode });
      createdDirs.push(dir.path);
      chmodSync(path, dir.mode);
    }
    for (const [p, content] of Object.entries(writes)) {
      // Include the current path: a write may fail after changing the file.
      touched.push(p);
      if (content === null) rmSync(safePath(root, p), { force: true });
      else {
        write(root, p, content);
        if (Object.hasOwn(modes, p)) chmodSync(safePath(root, p), modes[p]);
      }
    }
    for (const dir of directories) { rmdirSync(safePath(root, dir.path)); removedDirs.push(dir); }
    afterWrites();
  } catch (error) {
    const failures = [];
    for (const dir of removedDirs.reverse()) {
      try { mkdirSync(safePath(root, dir.path), { mode: dir.mode }); chmodSync(safePath(root, dir.path), dir.mode); }
      catch (rollbackError) { failures.push(`${dir.path}: ${rollbackError.message}`); }
    }
    for (const p of touched.reverse()) {
      try {
        const original = before.get(p);
        if (original === null) rmSync(safePath(root, p), { force: true });
        else { atomicWrite(root, p, original.content); chmodSync(safePath(root, p), original.mode); }
      } catch (rollbackError) { failures.push(`${p}: ${rollbackError.message}`); }
    }
    for (const path of [...new Set([...createdDirs, ...absentParents])].sort((a, b) => b.split('/').length - a.split('/').length)) {
      try { rmdirSync(safePath(root, path)); }
      catch (rollbackError) { if (rollbackError.code !== 'ENOENT') failures.push(`${path}: ${rollbackError.message}`); }
    }
    if (failures.length) throw new Error(`Apply failed: ${error.message}; rollback incomplete: ${failures.join('; ')}`);
    throw error;
  }
}
