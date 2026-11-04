/**
 * deps — compute the declared runtime `packages` for a generated project.
 *
 * Pure seam: `runtimePackages(piPackages, declared) -> string[]`.
 *
 * A generated system is self-contained by declaration, not by wholesale
 * package inheritance. It pins only what its declarations use (`runtimeNeeds`):
 * `pi-commands` for declared commands, `@gotgenes/pi-permission-system` for
 * MCP tools that ask before each call, `pi-subagents` for specialists (MCP is
 * Pi's built-in), and whatever the model explicitly declares. It never pins
 * Faur. A minimal agent pins nothing. The faur's own dev-only
 * packages (web access, the YAML parser, question helpers) and any git pin are
 * never emitted; local-path and secret-shaped entries are rejected.
 */

import { readFileSync } from 'node:fs';
import { cliEntries } from './cli-tools.mjs';
import { mcpApprovals } from './mcp-gen.mjs';
import { leadTools } from './asking.mjs';

const PACKAGE = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
/** This Faur release's own pins, used for a primitive the caller does not pin. */
const OWN_PACKAGES = Array.isArray(PACKAGE.pi?.packages) ? PACKAGE.pi.packages : [];
/** Declared commands: named tools without a shell, per-run approval (`.pi/commands.json`). */
export const COMMANDS_PACKAGE = 'git:github.com/mihaiiova/pi-commands@v0.1.0';
/** MCP tools that ask before each call, refused without a UI (`.pi/extensions/pi-permission-system/config.json`). */
export const PERMISSIONS_PACKAGE = 'npm:@gotgenes/pi-permission-system@42.0.0';
const LOCAL_PATH_RE = /^(file:|link:|\/|\.\.?\/)/;
const RUNTIME_PRIMITIVES = ["pi-subagents"];
/** Packages that replace a Pi built-in the generated system relies on. */
export const REPLACES_BUILTIN = { "pi-mcp-adapter": "Pi's built-in MCP support" };

function isString(value) {
  return typeof value === "string";
}

/** Parse `npm:name@version` into `{ name, version }` (scoped-name aware). */
function parseNpmSpec(entry) {
  if (!isString(entry) || !entry.startsWith("npm:")) return null;
  const rest = entry.slice(4);
  const at = rest.lastIndexOf("@");
  if (at <= 0) return null;
  const name = rest.slice(0, at);
  const version = rest.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

/** A declared package must be an `npm:`/`git:` spec, pinned, never a local path. */
function declaredSpecError(spec) {
  if (!isString(spec) || spec === "") return "declared package must be a non-empty string";
  if (LOCAL_PATH_RE.test(spec)) {
    return `declared package "${spec}" must not be a local path (file:/link:/abs/./../)`;
  }
  if (spec.startsWith("npm:")) {
    const parsed = parseNpmSpec(spec);
    if (!parsed || !parsed.version) {
      return `declared package "${spec}" must be a pinned npm:<name>@<version>`;
    }
    return null;
  }
  if (spec.startsWith("git:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    if (at <= 0 || at === rest.length - 1) {
      return `declared package "${spec}" must be a pinned git:<repo>@<ref>`;
    }
    return null;
  }
  return `declared package "${spec}" must be an npm: or git: spec`;
}

/**
 * Which runtime packages a design uses: pi-commands for declared commands,
 * the permission system for MCP `approveTools`, pi-subagents for declared
 * specialists or a lead that lists the `subagent` tool. Everything else,
 * workflows included, runs on Pi alone.
 */
export function runtimeNeeds(model) {
  const lead = leadTools(model);
  const agents = Array.isArray(model?.agents) ? model.agents.length : 0;
  return {
    commands: cliEntries(model).length > 0,
    approvals: mcpApprovals(model).length > 0,
    subagents: agents > 0 || lead.includes('subagent'),
  };
}

/**
 * @param {string[]} [piPackages] the faur's own `pi.packages` (`npm:<name>@<version>`).
 * @param {string[]} [declared] the model's declared `packages` (npm:/git: specs).
 * @param {{ commands?: boolean, approvals?: boolean, subagents?: boolean }} [needs]
 *   from `runtimeNeeds`; `subagents` defaults to true, the others to false.
 * @returns {{ packages: string[], errors: string[] }} primitives first, then declared;
 *   `errors` is non-empty when a required primitive is missing/unpinned or a
 *   declared spec is invalid/conflicting (never silently incomplete).
 */
export function runtimePackages(piPackages, declared = [], { commands = false, approvals = false, subagents = true } = {}) {
  const errors = [];
  const pins = [...(commands ? [COMMANDS_PACKAGE] : []), ...(approvals ? [PERMISSIONS_PACKAGE] : [])];

  // The caller's pins (a project's current ones) win; a primitive the project
  // does not pin yet, such as pi-subagents for a first specialist, takes this
  // release's version.
  const byName = new Map();
  for (const entry of [...OWN_PACKAGES, ...(Array.isArray(piPackages) ? piPackages : [])]) {
    const parsed = parseNpmSpec(entry);
    if (parsed) byName.set(parsed.name, entry);
  }

  for (const name of subagents ? RUNTIME_PRIMITIVES : []) {
    const entry = byName.get(name);
    if (!entry) {
      errors.push(`required runtime dependency "${name}" is not present in the faur's pi.packages`);
      continue;
    }
    const parsed = parseNpmSpec(entry);
    if (!parsed || !parsed.version) {
      errors.push(`required runtime dependency "${name}" must be a pinned npm:<name>@<version> (got "${entry}")`);
      continue;
    }
    pins.push(entry);
  }

  for (const spec of Array.isArray(declared) ? declared : []) {
    const parsed = parseNpmSpec(spec);
    if (parsed && RUNTIME_PRIMITIVES.includes(parsed.name) && subagents) {
      const pinned = byName.get(parsed.name);
      if (pinned && pinned !== spec) {
        errors.push(`declared package "${spec}" conflicts with the pinned runtime primitive "${pinned}"`);
      }
      continue; // primitive already pinned above; never re-emit
    }
    if (parsed && REPLACES_BUILTIN[parsed.name]) {
      errors.push(`declared package "${spec}" would replace ${REPLACES_BUILTIN[parsed.name]}, which generated systems use`);
      continue;
    }
    const err = declaredSpecError(spec);
    if (err) errors.push(err);
    else if (!pins.includes(spec)) pins.push(spec);
  }

  return { packages: pins, errors };
}
