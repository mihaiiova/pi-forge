/**
 * discover — deterministic, read-only capability inventory parsers.
 *
 * Pure module: each export is a function of its inputs and never touches the
 * filesystem or spawns processes itself unless an injectable helper is not
 * supplied (in which case it uses the real thing at call time). `faur.mjs`
 * assembles these into the `faur discover` JSON inventory.
 */
import { execFileSync } from "node:child_process";
import { dirname, basename } from "node:path";
import { loadYaml } from "./yaml-loader.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse an MCP config file's text into a normalized `{ mcpServers }` object.
 * Accepts both the canonical `{ "mcpServers": {…} }` form and the plain
 * `{ serverName: {…} }` form. Stdio entries keep `command`/`args`/`env`/`cwd`;
 * HTTP entries keep `url`/`headers`/`oauth`. Malformed input yields an empty
 * inventory (never throws).
 *
 * @param {string} text
 * @returns {{ mcpServers: Record<string, object> }}
 */
export function parseMcpFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { mcpServers: {} };
  }
  if (!isPlainObject(parsed)) return { mcpServers: {} };

  const raw = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const mcpServers = {};
  for (const [name, config] of Object.entries(raw)) {
    if (isPlainObject(config)) mcpServers[name] = config;
  }
  return { mcpServers };
}

function defaultProbe(cli) {
  try {
    execFileSync("bash", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "bash", cli], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe which CLIs are present. Each name is checked with `command -v`; the
 * probe is injectable so tests never shell out.
 *
 * @param {string[]} clis
 * @param {{ probe?: (cli: string) => boolean }} [opts]
 * @returns {Record<string, boolean>}
 */
export function probeClis(clis, opts = {}) {
  const probe = typeof opts?.probe === "function" ? opts.probe : defaultProbe;
  const out = {};
  for (const cli of clis) {
    out[cli] = probe(cli);
  }
  return out;
}

function parseFrontmatter(content, parseYaml) {
  if (typeof content !== "string") return {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const value = parseYaml(match[1]);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Scan SKILL.md files for `{ name, description, dir }`. `skillFiles` maps a
 * path to its text content. The YAML frontmatter supplies `name`/`description`;
 * when absent, the skill's directory name is the fallback name. The parser is
 * injectable (defaults to the pinned `yaml` package).
 *
 * @param {Record<string, string>} skillFiles path → SKILL.md text.
 * @param {{ parse?: (text: string) => unknown }} [opts]
 * @returns {Array<{ name: string, description: string, dir: string }>}
 */
export function scanSkills(skillFiles, opts = {}) {
  const parseYaml = typeof opts?.parse === "function" ? opts.parse : loadYaml().parse;
  const entries = Object.entries(skillFiles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  for (const [path, content] of entries) {
    const fm = parseFrontmatter(content, parseYaml);
    const dir = dirname(path);
    const name =
      typeof fm.name === "string" && fm.name
        ? fm.name
        : basename(dir);
    const description = typeof fm.description === "string" ? fm.description : "";
    out.push({ name, description, dir });
  }
  return out;
}
