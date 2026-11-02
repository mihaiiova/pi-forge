/**
 * Updating the pinned Forge package. Three steps, each a separate decision:
 *
 *   proposeUpdate  reads release tags from the remote; runs nothing.
 *   previewUpdate  after the user agrees to run the new release, fetches the
 *                  tag (exactly the commit they saw) and runs its rebuild plan.
 *   applyUpdate    after the user approves that preview, runs the same release
 *                  to apply exactly that plan, then installs the new pin.
 *
 * The new release is reached through its stable entry
 * `skills/forge/maintenance-rebuild.mjs <project> plan|apply <digest>`.
 */
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FORGE_SOURCE } from './deps.mjs';
import { readJson } from './maintenance-store.mjs';
import { PI_NPM_DIR } from './yaml-loader.mjs';

const exec = promisify(execFile);
const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = FORGE_SOURCE.slice('git:github.com/'.length);
const ENTRY = 'skills/forge/maintenance-rebuild.mjs';

/** The project's single Forge pin and its release tag. */
export function forgePin(root) {
  const packages = readJson(root, '.pi/settings.json').packages ?? [];
  const pins = packages.map(p => typeof p === 'string' ? p : p?.source).filter(p => p?.startsWith(`${FORGE_SOURCE}@`));
  if (pins.length !== 1) throw new Error('Expected exactly one pinned Forge package in .pi/settings.json');
  const tag = pins[0].slice(FORGE_SOURCE.length + 1);
  if (!RELEASE.test(tag)) throw new Error(`The Forge pin is not a release tag: ${pins[0]}`);
  return { source: pins[0], tag };
}

const parts = tag => RELEASE.exec(tag).slice(1).map(BigInt);
function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Git without hooks, credentials, prompts or the user's configuration. */
function git(args, { cwd, run = exec } = {}) {
  const home = cwd ?? tmpdir();
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', ...args], {
    cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/** Release tags on the remote and the commit each names. */
async function releaseTags(remote) {
  const { stdout } = await git(['ls-remote', '--tags', remote]);
  const tags = new Map();
  for (const line of stdout.split('\n')) {
    const [commit, ref] = line.split('\t');
    const match = /^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(ref ?? '');
    if (!match || !COMMIT.test(commit)) continue;
    // An annotated tag lists its object and then the commit it peels to.
    if (match[2] || !tags.has(match[1])) tags.set(match[1], commit);
  }
  return tags;
}

const remoteOf = opts => opts.remote ?? `https://github.com/${REPOSITORY}.git`;

/** The newest release, compared with the project's pin. Runs nothing. */
export async function checkRelease(root, opts = {}) {
  const installed = forgePin(root).tag;
  const tags = await releaseTags(remoteOf(opts));
  const latest = [...tags.keys()].reduce((best, tag) => (!best || newer(tag, best) ? tag : best), null);
  if (!latest) throw new Error('No Forge release tags found');
  return { installed, latest, commit: tags.get(latest), newer: newer(latest, installed) };
}

/** What an update would install: the pin change and the exact commit. Runs nothing. */
export async function proposeUpdate(root, opts = {}) {
  const release = await checkRelease(root, opts);
  if (!release.newer) return { kind: 'current', installed: release.installed, latest: release.latest };
  const { source } = forgePin(root);
  return {
    kind: 'release', remote: remoteOf(opts),
    from: source, to: `${FORGE_SOURCE}@${release.latest}`, tag: release.latest, commit: release.commit,
    changes: `https://github.com/${REPOSITORY}/compare/${release.installed}...${release.latest}`,
  };
}

/** The installed yaml package directory this Forge loads, or null. */
function yamlDir() {
  for (const base of [import.meta.url, join(PI_NPM_DIR, 'package.json')]) {
    try {
      const main = createRequire(base).resolve('yaml');
      return main.slice(0, main.lastIndexOf('/node_modules/yaml/') + '/node_modules/yaml'.length);
    } catch { /* try the next location */ }
  }
  return null;
}

/** The pinned yaml this Forge runs with, reused when the release pins the same version. */
function linkDependencies(dir) {
  const wanted = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {};
  const names = Object.keys(wanted);
  if (names.some(n => n !== 'yaml')) return false;
  if (!names.length) return true;
  const own = yamlDir();
  if (!own) return false;
  if (JSON.parse(readFileSync(join(own, 'package.json'), 'utf8')).version !== wanted.yaml) return false;
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(own, join(dir, 'node_modules/yaml'), 'dir');
  return true;
}

async function runRelease(dir, root, args) {
  const home = mkdtempSync(join(tmpdir(), 'forge-release-home-'));
  try {
    const { stdout } = await exec(process.execPath, [join(dir, ENTRY), root, ...args], {
      timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'C.UTF-8', PI_OFFLINE: '1' },
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim().split('\n').pop() || error.message);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * Fetch the proposed release and run its rebuild plan on the project.
 * `approved` is the user's permission to execute that release's code.
 */
export async function previewUpdate(root, proposal, approved = false) {
  if (approved !== true) throw new Error('Running the new Forge release needs your approval');
  if (proposal?.kind !== 'release' || !COMMIT.test(proposal.commit)) throw new Error('No Forge release proposed');
  const dir = mkdtempSync(join(tmpdir(), 'forge-release-'));
  try {
    await git(['init', '--quiet'], { cwd: dir });
    await git(['fetch', '--quiet', '--depth=1', proposal.remote, `refs/tags/${proposal.tag}`], { cwd: dir });
    const { stdout } = await git(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: dir });
    if (stdout.trim() !== proposal.commit) throw new Error(`Release ${proposal.tag} changed since you approved it (now ${stdout.trim()}); nothing was run`);
    await git(['checkout', '--quiet', proposal.commit], { cwd: dir });
    if (!linkDependencies(dir)) {
      // Registry tarballs are integrity-checked; install scripts never run.
      await exec('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: dir, timeout: 120000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null', NPM_CONFIG_CACHE: join(dir, '.npm-cache') } });
    }
    const plan = await runRelease(dir, root, ['plan']);
    const settings = plan.preview?.files?.find(f => f.path === '.pi/settings.json');
    if (!settings || !settings.diff.includes(proposal.to)) throw new Error(`Release ${proposal.tag} does not pin itself; nothing was applied`);
    return { kind: 'package-update', proposal, dir, digest: plan.digest, restart: true, preview: { pin: { from: proposal.from, to: proposal.to, commit: proposal.commit }, ...plan.preview } };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Remove the fetched release without applying anything. */
export function discardUpdate(plan) {
  if (plan?.dir) rmSync(plan.dir, { recursive: true, force: true });
}

/** Install a project's pinned packages with Pi, in the project's own Pi home. */
export async function installPackages(root) {
  await exec('pi', ['update', '--extensions', '--approve'], { cwd: root, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Apply exactly the previewed plan with the new release, then install it.
 * `approved` is the user's approval of that preview.
 */
export async function applyUpdate(root, plan, approved = false, { install = installPackages } = {}) {
  if (approved !== true) throw new Error('Explicit user approval required');
  if (plan?.kind !== 'package-update') throw new Error('No Forge update previewed');
  try {
    const applied = await runRelease(plan.dir, root, ['apply', plan.digest]);
    try {
      await install(root);
    } catch (error) {
      throw new Error('The reviewed Faur-managed file plan was applied, but Pi package installation failed. Package state and external installer effects may be partial; sync is not transactional. From the project directory, retry `pi update --extensions --approve` in the same Pi environment, then restart ./run. If you instead want to revert, review the current changes and package state first; use git only after that review. Faur did not roll back the applied files.', { cause: error });
    }
    return applied;
  } finally { discardUpdate(plan); }
}
