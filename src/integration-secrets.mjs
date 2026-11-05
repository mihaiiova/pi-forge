/** Project-local integration secret files are never managed or previewed as generated content. */
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safePath } from './maintenance-store.mjs';

// A restricted spelling permits literal, anchored gitignore entries without glob escaping.
export function validSecretsPath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)) return false;
  const normalized = path.toLowerCase();
  return normalized.split('/').every(part => part !== '.' && part !== '..' && part !== '.git' && part !== '.gitignore')
    && !['.faur', '.pi', 'data', '.env', '.env.example', 'run', 'readme.md', 'data/knowledge/.gitkeep', '.faur/build.json', '.faur/capabilities.json', '.faur/check.json', '.faur/permission-requests.json'].includes(normalized)
    && !normalized.startsWith('.pi/') && !normalized.startsWith('.faur/pi-home/');
}

export const REQUIRED_IGNORES = ['.env', '.faur/', '.pi/state.json', '.pi/sessions/', '.pi/git/', '.pi/npm/'];

/** Git ignores unescaped trailing spaces; escaped patterns are treated conservatively. */
function ignoreLine(line) {
  return line.replace(/ +$/, '');
}

/** Treat wildcard negations conservatively; literal paths overlap only at an ancestor. */
function mayNegate(line, rule) {
  line = ignoreLine(line);
  if (!line.startsWith('!')) return false;
  const raw = line.slice(1);
  const anchored = raw.startsWith('/');
  const pattern = raw.replace(/^\//, '').replace(/\/$/, '');
  if (/[?*\[\\]/.test(pattern)) return true;
  const target = rule.replace(/^\//, '').replace(/\/$/, '').split('/');
  const parts = pattern.split('/');
  if (!anchored && parts.length === 1) return target.includes(parts[0]);
  return parts.length <= target.length && parts.every((part, i) => part === target[i]);
}

/** Exact required rules only; a trailing slash never protects a file. */
export function gitignoreSafety(existing, model) {
  const lines = existing.split(/\r?\n/).map(ignoreLine);
  const rules = [...REQUIRED_IGNORES, ...new Set(integrationSecrets(model).map(path => `/${path}`))];
  const missing = [];
  for (const rule of rules) {
    const directory = rule.endsWith('/');
    const index = lines.findLastIndex(line => directory ? line === rule || line === rule.slice(0, -1) : line === rule);
    // A later negation can override an exact rule. Without an exact rule,
    // appending after any negation could override an intentional user rule.
    if (lines.slice(index + 1).some(line => mayNegate(line, rule))) {
      return { missing, conflict: `Root .gitignore contains a negation after (or without) the required rule ${rule}; resolve it explicitly before applying` };
    }
    if (index < 0) missing.push(rule);
  }
  return { missing, conflict: null };
}

export function integrationSecrets(model) {
  return [...(model.integrations?.mcp ?? []), ...(model.integrations?.cli ?? [])]
    .map(integration => integration.secretsFile).filter(path => typeof path === 'string');
}

/** Verify a real private regular file without opening or reading its contents. */
export function secretFileProblem(root, path) {
  try {
    if (!validSecretsPath(path)) return 'invalid project-relative path';
    const info = lstatSync(safePath(root, path));
    const git = (args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status;
    const inGit = git(['rev-parse', '--is-inside-work-tree']);
    if (inGit === null) return 'git unavailable; cannot verify exclusion';
    if (inGit === 0 && git(['check-ignore', '-q', '--', path]) !== 0) return 'tracked or not ignored by git';
    if (!info.isFile() || info.nlink !== 1) return 'not a private regular file';
    if ((info.mode & 0o077) !== 0) return 'permissions must exclude group and others';
    return null;
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unsafe or inaccessible path';
  }
}

/** Reject unsafe existing files before applying other project changes. Ignore rules may be added by those changes. */
export function preflightSecretFiles(root, model) {
  try {
    const safety = gitignoreSafety(readFileSync(safePath(root, '.gitignore'), 'utf8'), model);
    if (safety.conflict) throw new Error(safety.conflict);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Nested rules can also unignore Faur's required .pi state and runtime paths,
  // even when the model declares no integration secret files.
  const paths = [...REQUIRED_IGNORES.filter(path => path.startsWith('.pi/')), ...integrationSecrets(model)];
  for (const path of new Set(paths)) {
    const required = REQUIRED_IGNORES.includes(path);
    if (!required && !validSecretsPath(path)) throw new Error(`Invalid integration secretsFile: ${path}`);
    // A nested ignore file has higher precedence than the root rule Faur adds.
    // Refuse negations conservatively before writing any project files.
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ignore = `${parts.slice(0, i).join('/')}/.gitignore`;
      try {
        // Pi writes `*` + `!.gitignore` into .pi/git/ and .pi/npm/; re-including
        // the ignore file itself cannot unignore anything else.
        const negations = readFileSync(safePath(root, ignore), 'utf8').split(/\r?\n/).filter(line => line.startsWith('!'));
        if (negations.some(line => !['!.gitignore', '!/.gitignore'].includes(line))) {
          throw new Error(`${required ? 'Required ignore' : 'Integration secretsFile'} ${path}: ${ignore} contains negation rules; verify and remove them before applying`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (required) continue;
    let info;
    try { info = lstatSync(safePath(root, path)); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Integration secretsFile ${path}: unsafe or inaccessible path`);
    }
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Integration secretsFile ${path}: not a private regular file`);
    if (info.mode & 0o077) throw new Error(`Integration secretsFile ${path}: permissions must exclude group and others`);
    const git = (args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status;
    const inGit = git(['rev-parse', '--is-inside-work-tree']);
    if (inGit === null) throw new Error(`Integration secretsFile ${path}: git unavailable; cannot verify exclusion`);
    if (inGit === 0 && git(['ls-files', '--error-unmatch', '--', path]) === 0) throw new Error(`Integration secretsFile ${path}: tracked by git`);
  }
}

/** Create absent files exclusively, without modifying existing files or following symlinks. */
export function ensureSecretFiles(root, model, { onCreate = () => {} } = {}) {
  for (const path of new Set(integrationSecrets(model))) {
    if (!validSecretsPath(path)) throw new Error(`Invalid integration secretsFile: ${path}`);
    const target = safePath(root, path);
    const git = (args) => spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status;
    const inGit = git(['rev-parse', '--is-inside-work-tree']);
    if (inGit === null) throw new Error(`Integration secretsFile ${path}: git unavailable; cannot verify exclusion`);
    if (inGit === 0 && git(['check-ignore', '-q', '--', path]) !== 0) throw new Error(`Integration secretsFile ${path} is tracked or not ignored by git`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    safePath(root, path);
    let fd;
    try { fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (fd !== undefined) {
      try { onCreate(path); } finally { closeSync(fd); }
    }
    const problem = secretFileProblem(root, path);
    if (problem) throw new Error(`Integration secretsFile ${path}: ${problem}`);
  }
}
