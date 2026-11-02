/**
 * runtime — the runtime launcher plan for a generated system.
 *
 * Pure seam: `buildRuntimePlan(model, opts) -> { agentDir, packages,
 * launcherScript, warnings, errors }`. A generated system runs with its own Pi config
 * directory (set via `PI_CODING_AGENT_DIR`) so it does not load the host's
 * global Pi skills, MCP servers, extensions, instructions, settings, or
 * login files; the caller's environment, including credentials, is
 * inherited. Pi still reads the shared Agent Skills folders
 * (`~/.agents/skills/`, project `.agents/skills/`) by design. No filesystem or CLI work happens here; `generate.mjs` composes
 * the launcher content into the generated `run` file.
 */
import { runtimePackages, FORGE_SOURCE } from "./deps.mjs";
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

/** The generated `run` launcher script content. */
/** The lead's prompt files: the authored instructions, then the generated
 * "What you can use" section. Passing them explicitly (which replaces Pi's
 * APPEND_SYSTEM.md discovery) puts build output in the prompt, not runtime code. */
const PROMPT_FILES = [
  "# The orchestrator's prompt: authored instructions, then what it can use.",
  "prompts=()",
  "for f in .pi/APPEND_SYSTEM.md .pi/CAPABILITIES.md; do",
  '  if [[ -f "$f" ]]; then prompts+=(--append-system-prompt "$f"); fi',
  "done",
];
const LAUNCH = 'pi --approve --no-context-files ${prompts[@]+"${prompts[@]}"} "$@"';
/** The headless workflow runner, from the Forge package Pi installs into the project. */
const RUNNER = `.pi/git/${FORGE_SOURCE.slice("git:".length)}/skills/forge/workflow-runner.mjs`;
const NO_RUNNER = '{"workflow":null,"runId":null,"status":"configuration_error","answer":"","message":"The Forge package is not installed in this project yet. Run ./run once, then retry."}';
/** Runs a named workflow with the installed runner, or reports that it is missing (exit 2). */
const runWorkflow = (indent, args) => [
  `${indent}if [[ ! -f "$ROOT/${RUNNER}" ]]; then echo '${NO_RUNNER}'; exit 2; fi`,
  `${indent}exec node "$ROOT/${RUNNER}" ${args}`,
];
export function launcherScript(names = [], workflows = [], lead = '', projectContext = []) {
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
    "",
    'if [[ ! -f ".pi/system.yaml" ]]; then',
    '  if [[ "${1:-}" == "--workflow" ]]; then',
    ...runWorkflow('    ', `'${manifest}' -- "$@"`),
    '  fi',
    '  echo "run: .pi/system.yaml not found in $ROOT" >&2',
    "  exit 1",
    "fi",
    "",
    'export PI_CODING_AGENT_DIR="$ROOT/.forge/pi-home"',
    'mkdir -p "$PI_CODING_AGENT_DIR"',
    "",
    ...envLoader(names),
    "# The Pi config is separate; the caller's environment is still inherited.",
    "# Log in for this context (`./run`, then `/login`), or export a provider key.",
    // Pi's agent-dir does not suppress ancestor instruction discovery.
    // APPEND_SYSTEM.md still supplies the project's operational instructions.
    ...PROMPT_FILES,
    ...(projectContext.length ? [
      '# Append opted-in project files after the generated prompts; reject symlinks outside the project.',
      ...projectContext.flatMap(path => {
        const quoted = "'" + path.replaceAll("'", "'\\''") + "'";
        return [
          `f=${quoted}`,
          'if [[ -f "$f" ]] && node -e \'const fs=require("fs"),p=require("path");try{const root=fs.realpathSync(process.argv[1]),file=fs.realpathSync(process.argv[2]);process.exit(file.startsWith(root+p.sep)?0:1)}catch{process.exit(1)}\' "$ROOT" "$f"; then prompts+=(--append-system-prompt "$f"); fi',
        ];
      }),
    ] : []),
    'if [[ "${1:-}" == "--workflow" ]]; then',
    ...runWorkflow('  ', `'${manifest}' "\${prompts[@]}" -- "$@"`),
    'fi',
    `exec ${LAUNCH}`,
    "",
  ].join("\n");
}

/**
 * @param {object} model the validated `system.yaml` document.
 * @param {object} [opts] `{ piPackages?: string[], firstBuild?: boolean, contextFiles?: string[] }`:
 *   the forge's `pi.packages`; whether the project has no launcher yet (warn
 *   about logins once); context files Pi would load here but the launcher skips.
 * @returns {{ agentDir: string, packages: string[], launcherScript: string, warnings: string[], errors: string[] }}
 */
export function buildRuntimePlan(model, opts = {}) {
  const piPackages = opts?.piPackages;
  const contextFiles = Array.isArray(opts?.contextFiles) ? opts.contextFiles : [];
  const declared = declaredPackages(model);
  const { packages, errors } = runtimePackages(piPackages, declared);

  return {
    agentDir: AGENT_DIR,
    packages,
    launcherScript: launcherScript(envNames(model), model.workflows ?? [], model.orchestrator?.name ?? '', model.orchestrator?.projectContext ?? []),
    warnings: [
      ...(opts?.firstBuild ? ["Pi login files are not inherited from the host; use /login or export a provider key. The caller's environment is inherited by the run and its tools."] : []),
      ...(model.orchestrator?.projectContext?.length
        ? ["the launcher disables automatic context discovery; only explicitly listed project files are appended. They can contain untrusted instructions; projectContext enables edit for all accessible files."]
        : contextFiles.length
          ? [`the launcher disables AGENTS.md/CLAUDE.md discovery with --no-context-files, so ${contextFiles.join(", ")} will not load; list a project file in orchestrator.projectContext, or move its instructions into the prompt.`]
          : []),
    ],
    errors,
  };
}
