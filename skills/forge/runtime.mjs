/**
 * runtime — the runtime launcher plan for a generated system.
 *
 * Pure seam: `buildRuntimePlan(model, opts) -> { agentDir, packages,
 * launcherScript, warnings, errors }`. A generated system runs with its own Pi config
 * directory (set via `PI_CODING_AGENT_DIR`) so it does not load the host's
 * global Pi skills, MCP servers, extensions, instructions, settings, or
 * login files; the caller's environment, including credentials, is
 * inherited. Pi still reads the shared Agent Skills folders
 * (`~/.agents/skills/`, project `.agents/skills/`) and `AGENTS.md` files in
 * parent directories. No filesystem or CLI work happens here; `generate.mjs` composes
 * the launcher content into the generated `run` file.
 */
import { runtimePackages, runtimeNeeds, FORGE_SOURCE } from "./deps.mjs";
import { declaredPackages } from "./skill-sources.mjs";

/** Project-relative isolated Pi config directory. */
export const AGENT_DIR = ".forge/pi-home";

/**
 * Load only the declared `integrations.env` names from the gitignored `.env`.
 * Lines are parsed, never sourced, so `.env` cannot run commands; variables
 * already set in the caller's environment take precedence.
 */
function envLoader(names) {
  if (!names.length) return [];
  return [
    "# Declared integration variables (integrations.env) from the gitignored .env.",
    "# Lines are parsed, never executed; values already exported take precedence.",
    `FORGE_ENV_NAMES=" ${names.join(" ")} "`,
    "forge_dq='^\"(.*)\"$'",
    "forge_sq=\"^'(.*)'\\$\"",
    'if [[ -f .env ]]; then',
    '  while IFS= read -r forge_line || [[ -n "$forge_line" ]]; do',
    "    forge_line=\"${forge_line%$'\\r'}\"",
    '    [[ "$forge_line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue',
    '    forge_name="${BASH_REMATCH[2]}"',
    '    forge_value="${BASH_REMATCH[3]}"',
    '    [[ "$FORGE_ENV_NAMES" == *" $forge_name "* ]] || continue',
    '    [[ -z "${!forge_name+x}" ]] || continue',
    '    if [[ "$forge_value" =~ $forge_dq || "$forge_value" =~ $forge_sq ]]; then forge_value="${BASH_REMATCH[1]}"; fi',
    '    export "$forge_name=$forge_value"',
    '  done < .env',
    'fi',
    'unset FORGE_ENV_NAMES forge_dq forge_sq forge_line forge_name forge_value',
    "",
  ];
}

/** Declared env names, in declaration order. */
export function envNames(model) {
  const env = model?.integrations?.env;
  return Array.isArray(env) ? [...new Set(env.map(e => e?.name).filter(n => typeof n === "string"))] : [];
}

/** The headless workflow runner, from the Forge package Pi installs into the project. */
const RUNNER = `.pi/git/${FORGE_SOURCE.slice("git:".length)}/skills/forge/workflow-runner.mjs`;
const NO_RUNNER = '{"workflow":null,"runId":null,"status":"configuration_error","answer":"","message":"The Forge package is not installed in this project yet. Run ./run once, then retry."}';

/**
 * The generated `run` launcher. Pi finds the project's prompt
 * (`.pi/APPEND_SYSTEM.md`) and context files (`AGENTS.md`) itself, so the
 * launcher only selects the isolated Pi home, loads declared env names and,
 * when workflows exist, hands `--workflow` to the runner (before the
 * system.yaml check, so a caller always gets the runner's JSON line).
 */
export function launcherScript(names = [], workflows = [], lead = '') {
  const manifest = Buffer.from(JSON.stringify(workflows.map(w => ({ ...w, lead })))).toString('base64');
  return [
    "#!/usr/bin/env bash",
    "# Runtime launcher for a generated Pi agent system.",
    "# Resolves the project root from this script's own location, then cd's into",
    "# it so project .pi/ resources are discovered regardless of the caller's",
    "# working directory. Gives the system its own Pi config dir (settings,",
    "# logins, packages, MCP servers, extensions, instructions). The caller's",
    "# environment, including credentials, is inherited. Not an OS sandbox.",
    "set -euo pipefail",
    "",
    'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    "",
    'if ! command -v pi >/dev/null 2>&1; then',
    '  echo "run: pi is not installed or not on PATH" >&2',
    "  exit 1",
    "fi",
    "",
    'cd "$ROOT"',
    'export PI_CODING_AGENT_DIR="$ROOT/.forge/pi-home"',
    'mkdir -p "$PI_CODING_AGENT_DIR"',
    "",
    ...envLoader(names),
    ...(workflows.length ? [
      'if [[ "${1:-}" == "--workflow" ]]; then',
      `  if [[ ! -f "$ROOT/${RUNNER}" ]]; then echo '${NO_RUNNER}'; exit 2; fi`,
      `  exec node "$ROOT/${RUNNER}" '${manifest}' -- "$@"`,
      "fi",
      "",
    ] : []),
    'if [[ ! -f ".pi/system.yaml" ]]; then',
    '  echo "run: .pi/system.yaml not found in $ROOT" >&2',
    "  exit 1",
    "fi",
    "",
    "# The Pi config is separate; the caller's environment is still inherited.",
    "# Log in for this context (`./run`, then `/login`), or export a provider key.",
    'exec pi --approve "$@"',
    "",
  ].join("\n");
}

/**
 * @param {object} model the validated `system.yaml` document.
 * @param {object} [opts] `{ piPackages?: string[], firstBuild?: boolean, contextFiles?: string[] }`:
 *   the forge's `pi.packages`; whether the project has no launcher yet (warn
 *   about logins once); context files Pi loads here, relative to the project.
 * @returns {{ agentDir: string, packages: string[], launcherScript: string, warnings: string[], errors: string[] }}
 */
export function buildRuntimePlan(model, opts = {}) {
  const piPackages = opts?.piPackages;
  const contextFiles = Array.isArray(opts?.contextFiles) ? opts.contextFiles : [];
  const outside = contextFiles.filter(path => path.startsWith('..'));
  const { packages, errors } = runtimePackages(piPackages, declaredPackages(model), runtimeNeeds(model));

  return {
    agentDir: AGENT_DIR,
    packages,
    launcherScript: launcherScript(envNames(model), model.workflows ?? [], model.orchestrator?.name ?? ''),
    warnings: [
      ...(opts?.firstBuild ? ["Pi login files are not inherited from the host; use /login or export a provider key. The caller's environment is inherited by the run and its tools."] : []),
      ...(outside.length ? [`Pi also loads ${outside.join(", ")} from outside this project into the orchestrator's prompt, with or without ./run. Move what the agent needs into the project, or accept those instructions.`] : []),
    ],
    errors,
  };
}
