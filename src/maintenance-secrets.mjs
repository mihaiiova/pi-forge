/** Best-effort credential redaction at the model boundary; never reads auth/env files. */
import { loadYaml } from './yaml-loader.mjs';
import { readText } from './maintenance-store.mjs';
const sensitive = /(token|secret|password|authorization|cookie|credential|api[-_]?key|private[-_]?key|auth$|^key$)/i;
const reference = /^(?:Bearer )?\$\{[A-Z_][A-Z0-9_]*\}$/;
const knownToken = /(?:sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|AIza)[A-Za-z0-9_-]{12,}/;
function walk(value, path, visit) {
  if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, i], visit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, walk(v, [...path, k], visit)]));
  return visit(value, path);
}
function isCredential(value, path) {
  if (typeof value !== 'string' || !value.length || reference.test(value)) return false;
  if (path.length === 4 && path[0] === 'integrations' && ['mcp', 'cli'].includes(path[1]) && Number.isInteger(path[2]) && path[3] === 'secretsFile') return false;
  const plain = value.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, '');
  const embedded = /https?:\/\/[^/@\s:]+(?::[^/@\s]+)?@|\b[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@|[?&](?:token|api_key|key|secret|password)=[^&#\s]+/i.test(plain);
  // An `env` value is a credential when its name or shape says so, not merely
  // because it is in `env`: non-secret settings (OAuth scopes, regions, ports)
  // belong in the reviewed config as literals. Best effort, not DLP: a secret
  // under an innocuous name with no recognizable shape is not detected.
  const tokenShaped = path.at(-2) === 'env' && (knownToken.test(plain) || (/^[A-Za-z0-9_\-+=]{32,}$/.test(plain) && /\d/.test(plain)));
  return sensitive.test(String(path.at(-1))) || tokenShaped || embedded;
}
export function redacted(value) {
  return walk(value, [], (v, path) => isCredential(v, path) ? '[redacted]' : v);
}

/** Redact paired values while preserving whether a secret was added, removed,
 * or changed. Labels are independent of the secret (no guessable hashes). */
export function redactedDiffPair(before, after) {
  const changes = [];
  const pair = (a, b, path, hasA = true, hasB = true) => {
    if ((hasA && isCredential(a, path)) || (hasB && isCredential(b, path))) {
      const action = !hasA ? 'added' : !hasB ? 'removed' : Object.is(a, b) ? null : 'changed';
      if (action) changes.push({ path: path.map(String), action });
      return [hasA ? `[redacted${action ? `: ${action} before` : ''}]` : undefined,
        hasB ? `[redacted${action ? `: ${action} after` : ''}]` : undefined];
    }
    const objectA = hasA && a !== null && typeof a === 'object';
    const objectB = hasB && b !== null && typeof b === 'object';
    if ((objectA || objectB) && (!objectA || !objectB || Array.isArray(a) === Array.isArray(b))) {
      const array = objectA ? Array.isArray(a) : Array.isArray(b);
      const left = array ? [] : {}, right = array ? [] : {};
      const keys = new Set([...Object.keys(objectA ? a : {}), ...Object.keys(objectB ? b : {})]);
      for (const key of keys) {
        const inA = objectA && Object.hasOwn(a, key), inB = objectB && Object.hasOwn(b, key);
        const [av, bv] = pair(inA ? a[key] : undefined, inB ? b[key] : undefined,
          [...path, array ? Number(key) : key], inA, inB);
        if (inA) left[key] = av;
        if (inB) right[key] = bv;
      }
      return [objectA ? left : a, objectB ? right : b];
    }
    if (objectA && objectB) {
      const [left] = pair(a, undefined, path, true, false);
      const [, right] = pair(undefined, b, path, false, true);
      return [left, right];
    }
    return [a, b];
  };
  const [left, right] = pair(before, after, []);
  return { before: left, after: right, changes };
}
function secretsAt(root) {
  const secrets = new Set();
  for (const p of ['.pi/system.yaml', '.pi/settings.json', '.pi/mcp.json']) {
    try {
      const text = readText(root, p);
      const value = p.endsWith('.yaml') ? loadYaml().parse(text) : JSON.parse(text);
      walk(value, [], (v, path) => { if (isCredential(v, path)) secrets.add(v); return v; });
    } catch { /* inspection separately reports unreadable configuration */ }
  }
  return [...secrets].sort((a,b) => b.length - a.length);
}
export function redactForModel(root, value) {
  let text = JSON.stringify(redacted(value));
  for (const secret of secretsAt(root)) {
    // Cover both ordinary strings and JSON-escaped strings inside diff text.
    const encoded = JSON.stringify(secret).slice(1, -1);
    text = text.split(encoded).join('[redacted]');
  }
  // Known credential formats in authored prose/CLI arguments. This is not DLP:
  // custom credentials embedded in arbitrary free text cannot be identified.
  text = text.replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, '[redacted]');
  return JSON.parse(text);
}
export function assertNoNewSecrets(before, after) {
  walk(after, [], (value, path) => {
    // Named schema entities can move when a sibling is removed. Compare their
    // unchanged credential fields by name, not by the old array index.
    let old = before, next = after;
    for (const key of path) {
      old = Array.isArray(next) && next[key]?.name && Array.isArray(old)
        ? old.find(item => item?.name === next[key].name) : old?.[key];
      next = next?.[key];
    }
    if ((typeof value === 'string' && value.includes('[redacted]') && old !== value) || (isCredential(value, path) && old !== value)) throw new Error(`Use an environment reference, not a literal credential at ${path.join('.')}`);
    return value;
  });
}
