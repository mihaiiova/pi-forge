import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimePlan, envNames } from "../src/runtime.mjs";
import { COMMANDS_PACKAGE } from '../src/deps.mjs';

const PI_PACKAGES = ["npm:pi-subagents@0.83.1", "npm:pi-web-access@0.27.0"];
const withMcp = { integrations: { mcp: [{ name: "s", config: { url: "u" } }] } };

test("buildRuntimePlan derives the agent dir, packages, and warnings", () => {
  const plan = buildRuntimePlan({ packages: ["npm:foo@1.0.0"] }, { piPackages: PI_PACKAGES });
  assert.deepEqual(plan.packages, ["npm:foo@1.0.0"], "nothing the design does not use");
  const commands = buildRuntimePlan({ orchestrator: { name: "l", tools: ["read", "subagent", "cli:x"] }, integrations: { cli: [{ name: "x", command: "echo" }] } }, { piPackages: PI_PACKAGES });
  assert.deepEqual(commands.packages, [COMMANDS_PACKAGE, "npm:pi-subagents@0.83.1"]);
  assert.deepEqual(buildRuntimePlan({ orchestrator: { name: "l", tools: ["read"] }, skills: [{ name: "w" }] }, { piPackages: PI_PACKAGES }).packages, [], "local skills run on Pi alone");
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, [], "no warning that does not apply");
});

test("buildRuntimePlan warns about context files from outside the project", () => {
  assert.deepEqual(buildRuntimePlan(withMcp, { piPackages: PI_PACKAGES }).warnings, []);
  assert.deepEqual(buildRuntimePlan({}, { piPackages: PI_PACKAGES, contextFiles: ["AGENTS.md"] }).warnings, [], "the project's own AGENTS.md loads natively; nothing to warn about");
  const outside = buildRuntimePlan({}, { piPackages: PI_PACKAGES, contextFiles: ["AGENTS.md", "../CLAUDE.md", "../../AGENTS.md"] });
  assert.equal(outside.warnings.length, 1);
  assert.match(outside.warnings[0], /\.\.\/CLAUDE\.md, \.\.\/\.\.\/AGENTS\.md from outside this project/);
});

test("buildRuntimePlan propagates dependency errors", () => {
  const plan = buildRuntimePlan({ packages: ["npm:unpinned"] }, { piPackages: [] });
  assert.ok(plan.errors.some((e) => e.includes("npm:unpinned")), "an invalid declared package surfaces as an error");
});

test("envNames lists declared names once, in order", () => {
  assert.deepEqual(envNames({ integrations: { env: [{ name: "GITHUB_PAT" }, { name: "OTHER" }, { name: "GITHUB_PAT" }] } }), ["GITHUB_PAT", "OTHER"]);
  assert.deepEqual(envNames({}), []);
});
