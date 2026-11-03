import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimePlan, launcherScript, envNames, needsIsolation, AGENT_DIR } from "../runtime.mjs";
import { expectedForgePin } from './version-helper.mjs';

const PI_PACKAGES = ["npm:pi-subagents@0.83.1", "npm:pi-web-access@0.27.0"];
const withMcp = { integrations: { mcp: [{ name: "s", config: { url: "u" } }] } };

test("buildRuntimePlan derives the agent dir, packages, and warnings", () => {
  const plan = buildRuntimePlan({ packages: ["npm:foo@1.0.0"] }, { piPackages: PI_PACKAGES });
  assert.equal(plan.agentDir, ".forge/pi-home");
  assert.deepEqual(plan.packages, ["npm:foo@1.0.0"], "nothing the design does not use");
  const commands = buildRuntimePlan({ orchestrator: { name: "l", tools: ["read", "subagent", "cli:x"] }, integrations: { cli: [{ name: "x", command: "echo" }] } }, { piPackages: PI_PACKAGES });
  assert.deepEqual(commands.packages, [expectedForgePin, "npm:pi-subagents@0.83.1"]);
  assert.deepEqual(buildRuntimePlan({ orchestrator: { name: "l", tools: ["read"] }, workflows: [{ name: "w" }] }, { piPackages: PI_PACKAGES }).packages, [], "workflows run on Pi alone");
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, [], "no warning that does not apply");
});

test("run is generated only for designs that rely on Pi's built-in MCP", () => {
  assert.equal(needsIsolation({}), false);
  assert.equal(buildRuntimePlan({}, { piPackages: PI_PACKAGES }).launcherScript, null);
  assert.equal(needsIsolation(withMcp), true);
  assert.equal(buildRuntimePlan(withMcp, { piPackages: PI_PACKAGES }).launcherScript, launcherScript());
});

test("buildRuntimePlan warns about run's logins on the first build and context files from outside the project", () => {
  assert.deepEqual(buildRuntimePlan({}, { piPackages: PI_PACKAGES, firstBuild: true }).warnings, [], "plain pi uses the user's logins");
  const first = buildRuntimePlan(withMcp, { piPackages: PI_PACKAGES, firstBuild: true });
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /\.\/run uses the project's own Pi logins.*environment is inherited/);
  assert.deepEqual(buildRuntimePlan({}, { piPackages: PI_PACKAGES, contextFiles: ["AGENTS.md"] }).warnings, [], "the project's own AGENTS.md loads natively; nothing to warn about");
  const outside = buildRuntimePlan({}, { piPackages: PI_PACKAGES, contextFiles: ["AGENTS.md", "../CLAUDE.md", "../../AGENTS.md"] });
  assert.equal(outside.warnings.length, 1);
  assert.match(outside.warnings[0], /\.\.\/CLAUDE\.md, \.\.\/\.\.\/AGENTS\.md from outside this project/);
});

test("buildRuntimePlan propagates dependency errors", () => {
  const plan = buildRuntimePlan({ packages: ["npm:unpinned"] }, { piPackages: [] });
  assert.ok(plan.errors.some((e) => e.includes("npm:unpinned")), "an invalid declared package surfaces as an error");
});

test("run only sets the isolated Pi configuration directory and executes Pi", () => {
  const script = launcherScript();
  assert.match(script, /export PI_CODING_AGENT_DIR="\$ROOT\/\.forge\/pi-home"/);
  assert.match(script, /\$\{BASH_SOURCE\[0\]\}/, "resolves root from its own location");
  assert.match(script, /cd "\$ROOT"/, "changes into the project root");
  assert.match(script, /\nexec pi "\$@"\n$/, "Pi with the caller's arguments, nothing added");
  assert.doesNotMatch(script, /\.env|--approve|workflow|system\.yaml|node /, "no environment parsing, trust, workflow logic or Faur code");
  assert.ok(!/auth\.json|cp .*auth|ln .*auth/.test(script), "must not copy host credentials");
  assert.match(script, /not an OS sandbox/);
});

test("AGENT_DIR constant is the stable project-relative pi-home", () => {
  assert.equal(AGENT_DIR, ".forge/pi-home");
});

test("envNames lists declared names once, in order", () => {
  assert.deepEqual(envNames({ integrations: { env: [{ name: "GITHUB_PAT" }, { name: "OTHER" }, { name: "GITHUB_PAT" }] } }), ["GITHUB_PAT", "OTHER"]);
  assert.deepEqual(envNames({}), []);
});
