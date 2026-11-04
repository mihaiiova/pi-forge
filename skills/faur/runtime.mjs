/**
 * runtime — how a generated project starts.
 *
 * Pure seam: `buildRuntimePlan(model, opts) -> { agentDir, packages,
 * launcherScript, warnings, errors }`. A project starts with `pi` in its
 * folder, which adds the user's Pi configuration. A design that depends on
 * Pi's built-in MCP also gets `run`, which sets an isolated Pi configuration
 * directory (`PI_CODING_AGENT_DIR`) and executes Pi; the caller's environment,
 * including credentials, `~/.agents/skills/` and `AGENTS.md` files in parent
 * directories still apply. No filesystem or CLI work happens here.
 */
import { runtimePackages, runtimeNeeds } from "./deps.mjs";
import { declaredPackages } from "./skill-sources.mjs";

/** Project-relative isolated Pi config directory. */
export const AGENT_DIR = ".faur/pi-home";

/** Declared env names, in declaration order. */
export function envNames(model) {
  const env = model?.integrations?.env;
  return Array.isArray(env) ? [...new Set(env.map(e => e?.name).filter(n => typeof n === "string"))] : [];
}

/**
 * Whether the design depends on Pi's built-in MCP: exposure and tool hiding in
 * `.pi/mcp.json`, approvals and the generated MCP tool names all assume it,
 * and a user-level extension that registers `/mcp` replaces it for plain `pi`.
 * Such a design gets `run`, which keeps the user's packages out.
 */
export function needsIsolation(model) {
  return Array.isArray(model?.integrations?.mcp) && model.integrations.mcp.length > 0;
}

/**
 * The optional `run` launcher: an isolated Pi configuration directory, then
 * Pi. No Faur code, no environment parsing, no workflow logic; Pi finds the
 * project's prompt, context files, packages and MCP servers itself.
 */
export function launcherScript() {
  return [
    "#!/usr/bin/env bash",
    "# Starts Pi in this project with the project's own Pi configuration",
    "# directory (settings, logins, packages, MCP servers, extensions,",
    "# instructions), so a user-level package cannot replace what the project",
    "# relies on. The caller's environment, including credentials, is",
    "# inherited, as are ~/.agents/skills and AGENTS.md files in parent folders.",
    "# This isolates Pi configuration only; it is not an OS sandbox.",
    "set -euo pipefail",
    'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$ROOT"',
    'export PI_CODING_AGENT_DIR="$ROOT/.faur/pi-home"',
    'mkdir -p "$PI_CODING_AGENT_DIR"',
    'exec pi "$@"',
    "",
  ].join("\n");
}

/**
 * @param {object} model the validated `system.yaml` document.
 * @param {object} [opts] `{ piPackages?: string[], firstBuild?: boolean, contextFiles?: string[] }`:
 *   the faur's `pi.packages`; whether the project has no launcher yet (warn
 *   about logins once); context files Pi loads here, relative to the project.
 * @returns {{ agentDir: string, packages: string[], launcherScript: string | null, warnings: string[], errors: string[] }}
 */
export function buildRuntimePlan(model, opts = {}) {
  const piPackages = opts?.piPackages;
  const contextFiles = Array.isArray(opts?.contextFiles) ? opts.contextFiles : [];
  const outside = contextFiles.filter(path => path.startsWith('..'));
  const { packages, errors } = runtimePackages(piPackages, declaredPackages(model), runtimeNeeds(model));

  return {
    agentDir: AGENT_DIR,
    packages,
    launcherScript: needsIsolation(model) ? launcherScript() : null,
    warnings: [
      ...(opts?.firstBuild && needsIsolation(model) ? ["./run uses the project's own Pi logins, not yours; log in once inside it with /login, or export a provider key. The caller's environment is inherited by the run and its tools."] : []),
      ...(outside.length ? [`Pi also loads ${outside.join(", ")} from outside this project into the orchestrator's prompt, with or without ./run. Move what the agent needs into the project, or accept those instructions.`] : []),
    ],
    errors,
  };
}
