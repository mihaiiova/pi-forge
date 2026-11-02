/**
 * documents — render agreed document formats into their writer's instructions.
 *
 * Pure seam: `documentInstructions(model, writer) -> string`. Each
 * `documents[]` entry is a structure the user validated (sections, length,
 * rules); the writer receives it verbatim so every run produces the same shape.
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** The declared documents written by `writer` (an agent or the orchestrator). */
export function documentsFor(model, writer) {
  const list = Array.isArray(model?.documents) ? model.documents : [];
  return list.filter((d) => isPlainObject(d) && d.writer === writer && isNonEmptyString(d.name));
}

function renderDocument(d) {
  const lines = [`### ${d.name}${isNonEmptyString(d.path) ? ` → \`${d.path}\`` : " (returned in your output)"}`, ""];
  if (isNonEmptyString(d.purpose)) lines.push(`Purpose: ${d.purpose}`);
  if (Number.isInteger(d.maxWords)) lines.push(`Length: at most ${d.maxWords} words.`);
  if (lines.length > 2) lines.push("");
  lines.push("Sections, in this order:", "");
  (Array.isArray(d.sections) ? d.sections : []).filter(isPlainObject).forEach((s, i) => {
    lines.push(`${i + 1}. **${s.heading}**${isNonEmptyString(s.guide) ? ` — ${s.guide}` : ""}`);
  });
  const rules = (Array.isArray(d.rules) ? d.rules : []).filter(isNonEmptyString);
  if (rules.length) lines.push("", "Rules:", "", ...rules.map((r) => `- ${r}`));
  const deliver = (Array.isArray(d.deliver) ? d.deliver : []).filter((t) => isPlainObject(t) && isNonEmptyString(t.mcp) && isNonEmptyString(t.tool));
  if (deliver.length) {
    lines.push("", isNonEmptyString(d.path) ? "When the file is written, also deliver it:" : "Deliver it:", "");
    for (const t of deliver) {
      const args = isPlainObject(t.with) && Object.keys(t.with).length ? ` with ${JSON.stringify(t.with)}` : "";
      lines.push(`- MCP server \`${t.mcp}\`, tool \`${t.tool}\`${args}${isNonEmptyString(t.note) ? ` — ${t.note}` : ""}`);
    }
    lines.push("", "Report where each delivery landed (link or ID), or exactly why it failed.");
  }
  return lines.join("\n");
}

/** Markdown appended to the writer's instructions, or "" when it writes none. */
export function documentInstructions(model, writer) {
  const docs = documentsFor(model, writer);
  if (docs.length === 0) return "";
  return [
    "## Document formats",
    "",
    "The owner agreed these formats. Use exactly these sections, in this order,",
    "within the length limit. If a format no longer fits the work, say so and",
    "suggest a change (applied with /faur) instead of deviating.",
    "",
    docs.map(renderDocument).join("\n\n"),
    "",
  ].join("\n");
}
