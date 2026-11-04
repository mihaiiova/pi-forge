/**
 * models — per-agent model references and the Pi model catalog.
 *
 * Pure module. Every agent (orchestrator and subagents) names its own model as
 * a `provider/id` reference chosen from the machine's Pi line-up; nothing here
 * hardcodes a model. `parseModelList` reads `pi --list-models` output so the
 * builder can offer the full catalog and flag references it does not contain.
 */

/** Pi's thinking levels (`pi --thinking`). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MODEL_REF_RE = /^[^\s/]+\/\S+$/;

/** A model reference is `provider/id` with no whitespace. */
export function isModelRef(value) {
  return typeof value === "string" && MODEL_REF_RE.test(value);
}

/** Split `provider/id` on the FIRST slash (ids may contain slashes). */
export function splitModelRef(ref) {
  if (!isModelRef(ref)) return { provider: undefined, id: undefined };
  const idx = ref.indexOf("/");
  return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

/**
 * Parse `pi --list-models` table output into sorted `provider/id` references.
 * The first row is the column header; malformed rows are skipped.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseModelList(text) {
  if (typeof text !== "string") return [];
  const refs = new Set();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(1)) {
    const [provider, id] = line.split(/\s+/);
    if (provider && id && isModelRef(`${provider}/${id}`)) refs.add(`${provider}/${id}`);
  }
  return [...refs].sort();
}

/** Every `{ agent, model }` assignment declared by a system model. */
export function modelAssignments(model) {
  const out = [];
  const orchestrator = model?.orchestrator;
  if (orchestrator && typeof orchestrator.model === "string") {
    out.push({ agent: orchestrator.name, model: orchestrator.model });
  }
  for (const agent of Array.isArray(model?.agents) ? model.agents : []) {
    if (agent && typeof agent.model === "string") out.push({ agent: agent.name, model: agent.model });
  }
  return out;
}

/**
 * Warnings for model references absent from the local catalog. An empty
 * catalog (Pi missing or no providers configured) yields no warnings: the
 * catalog is machine-specific, so absence is advisory, never a hard error.
 *
 * @param {object} model validated `system.yaml` document.
 * @param {string[]} catalog `provider/id` references from `parseModelList`.
 * @returns {string[]}
 */
export function unavailableModelWarnings(model, catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) return [];
  const available = new Set(catalog);
  return modelAssignments(model)
    .filter(({ model: ref }) => !available.has(ref))
    .map(({ agent, model: ref }) =>
      `${agent} uses model "${ref}", which is not in this machine's Pi line-up (pi --list-models)`);
}
