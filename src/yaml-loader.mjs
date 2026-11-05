/**
 * yaml-loader — resolve the pinned `yaml` package from Pi's package install dir.
 *
 * Faur is a Pi *package*, not an application: its npm dependencies live in
 * the Pi package install dir (`~/.pi/agent/npm/node_modules`), not in the
 * Faur clone. `loadYaml` tries a local `yaml` first (a development clone
 * with node_modules), then Pi's install dir via `createRequire`, with an
 * actionable error when it is absent.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { homedir } from "node:os";

/** Directory where Pi installs its pinned npm packages. */
export const PI_NPM_DIR = resolve(homedir(), ".pi", "agent", "npm");

/**
 * Load the `yaml` package from Pi's package install dir.
 *
 * @returns {typeof import("yaml")} the yaml module (has `parse`, `stringify`, …)
 * @throws {Error} with an actionable message when yaml is not installed.
 */
export function loadYaml() {
  const local = createRequire(import.meta.url);
  try { return local("yaml"); } catch { /* main Faur installation */ }
  const require = createRequire(resolve(PI_NPM_DIR, "package.json"));
  try {
    return require("yaml");
  } catch {
    throw new Error(
      "The `yaml` package (pinned as npm:yaml@2.8.3) is not installed in Pi's " +
        `package directory (${PI_NPM_DIR}). Reinstall Faur with pi install so Pi ` +
        "installs its pinned packages, then retry.",
    );
  }
}
