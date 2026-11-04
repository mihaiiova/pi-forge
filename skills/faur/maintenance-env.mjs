/** Status of declared environment variables, without returning their values. */
import { readText, safePath } from './maintenance-store.mjs';
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { integrationSecrets, secretFileProblem } from './integration-secrets.mjs';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function declaredEnv(model) {
  return (model?.integrations?.env ?? []).filter(e => typeof e?.name === 'string');
}

/** Names that have a non-empty value in `.env` (values are not returned). */
export function envFileNames(text) {
  const names = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(LINE);
    if (match && match[2].replace(/^(["'])(.*)\1$/, '$2') !== '') names.add(match[1]);
  }
  return names;
}

/** Which declared variables are set, without exposing any value. */
export function envStatus(root, model, environment = process.env) {
  const fromFile = envFileNames(readText(root, '.env'));
  const secretNames = [];
  for (const path of new Set(integrationSecrets(model))) {
    if (secretFileProblem(root, path)) continue;
    let fd;
    try {
      fd = openSync(safePath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (info.isFile() && info.nlink === 1 && !(info.mode & 0o077)) secretNames.push([path, envFileNames(readFileSync(fd, 'utf8'))]);
    } catch { /* An unsafe or inaccessible file is reported separately by check. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return declaredEnv(model).map(e => ({
    name: e.name,
    secret: e.secret === true,
    set: fromFile.has(e.name) ? '.env' : environment[e.name] ? 'shell environment' : secretNames.find(([, names]) => names.has(e.name))?.[0] ?? 'not set',
  }));
}
