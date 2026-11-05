/**
 * parse — turn `system.yaml` text into a plain JavaScript document.
 *
 * Pure seam: `parseSystem(text) -> doc`. It delegates to the established
 * `yaml` package (pinned v2.8.3), never a hand-rolled subset. The parser is
 * injectable so node:test can supply the real `yaml.parse` (or a stub) without
 * this module doing filesystem or CLI work itself.
 */
import { loadYaml } from "./yaml-loader.mjs";

/**
 * Parse a `system.yaml` string into a document.
 *
 * @param {string} text YAML source text.
 * @param {(text: string) => unknown} [parse] YAML parse function; defaults to
 *   the pinned `yaml` package's `parse`, resolved from Pi's package dir.
 * @returns {unknown} the parsed document (typically a plain object).
 * @throws {TypeError} when `text` is not a string.
 * @throws {Error} when the YAML is malformed (from the underlying parser).
 */
export function parseSystem(text, parse = loadYaml().parse) {
  if (typeof text !== "string") {
    throw new TypeError("parseSystem: expected a string of YAML text");
  }
  return parse(text);
}
