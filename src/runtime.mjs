/**
 * runtime — how a generated project starts.
 *
 * Pure seam: `buildRuntimePlan(model, opts)` selects packages and warnings.
 * Plain Pi inherits the user's configuration and environment.
 */
import { runtimePackages, runtimeNeeds } from "./deps.mjs";
import { declaredPackages } from "./skill-sources.mjs";

/** Declared env names, in declaration order. */
export function envNames(model) {
  const env = model?.integrations?.env;
  return Array.isArray(env) ? [...new Set(env.map(e => e?.name).filter(n => typeof n === "string"))] : [];
}

/**
 * @param {object} model the validated `system.yaml` document.
 * @param {object} [opts] `{ piPackages?: string[], contextFiles?: string[] }`:
 *   Faur's `pi.packages` and context files Pi loads relative to the project.
 * @returns {{ packages: string[], warnings: string[], errors: string[] }}
 */
export function buildRuntimePlan(model, opts = {}) {
  const piPackages = opts?.piPackages;
  const contextFiles = Array.isArray(opts?.contextFiles) ? opts.contextFiles : [];
  const outside = contextFiles.filter(path => path.startsWith('..'));
  const { packages, errors } = runtimePackages(piPackages, declaredPackages(model), runtimeNeeds(model));

  return {
    packages,
    warnings: [
      ...(outside.length ? [`Pi also loads ${outside.join(", ")} from outside this project into the orchestrator's prompt, when launched with plain pi. Move what the agent needs into the project, or accept those instructions.`] : []),
    ],
    errors,
  };
}
