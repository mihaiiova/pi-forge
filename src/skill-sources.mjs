/**
 * skill-sources — where a declared skill's content comes from.
 *
 * Pure module. The faur ships no skills of its own: a skill is either
 * developer-owned, provided by a pinned package (`source:
 * npm:<name>@<version>` / `git:<repo>@<ref>`), or vendored from a directory the
 * user supplies (`source: ./path`, `../path`, `/abs/path`, `~/path`), or comes
 * from the open Agent Skills ecosystem pinned to a commit (`source:
 * skills:<owner>/<repo>/<skill-dir>@<commit>`, installed by the `skills` CLI
 * into `.agents/skills/<name>/`; see registry-skills.mjs). Packaged
 * skills join the runtime `packages`; vendored skills are copied into
 * `.pi/skills/<name>/` by the faur CLI so the generated system stays
 * standalone.
 */

export const PACKAGE_SOURCE_RE = /^(npm:(@[^/\s]+\/)?[^@\s]+@[^@\s]+|git:[^\s]+@[^\s]+)$/;
const PATH_SOURCE_RE = /^(\.\.?\/|\/|~\/)/;
export const REGISTRY_SOURCE_RE = /^skills:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/((?:[A-Za-z0-9_.@ -]+\/)*[A-Za-z0-9_.@ -]+)@([0-9a-f]{40})$/;

/** `"package" | "path" | "registry" | null` for a skill `source` value. */
export function skillSourceKind(source) {
  if (typeof source !== "string" || source === "") return null;
  if (source.startsWith("skills:")) {
    const match = source.match(REGISTRY_SOURCE_RE);
    return match && !match[3].split("/").some((seg) => seg === ".." || seg === ".") ? "registry" : null;
  }
  if (PACKAGE_SOURCE_RE.test(source)) return "package";
  if (PATH_SOURCE_RE.test(source)) return "path";
  return null;
}

function skillList(model) {
  return (Array.isArray(model?.skills) ? model.skills : [])
    .filter((skill) => skill && typeof skill === "object" && typeof skill.name === "string");
}

/** Skills vendored from a user-supplied directory. */
export function vendoredSkills(model) {
  return skillList(model).filter((skill) => skillSourceKind(skill.source) === "path");
}

/**
 * The model's declared runtime packages: explicit `packages` first, then each
 * packaged skill source (deduplicated, order-preserving).
 */
export function declaredPackages(model) {
  const out = [];
  for (const spec of Array.isArray(model?.packages) ? model.packages : []) {
    if (!out.includes(spec)) out.push(spec);
  }
  for (const skill of skillList(model)) {
    if (skillSourceKind(skill.source) === "package" && !out.includes(skill.source)) out.push(skill.source);
  }
  return out;
}
