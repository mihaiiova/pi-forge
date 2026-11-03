import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimePlan, launcherScript, envNames, AGENT_DIR } from "../runtime.mjs";
import { expectedForgePin } from './version-helper.mjs';

const PI_PACKAGES = ["npm:pi-subagents@0.83.1", "npm:pi-web-access@0.27.0"];

test("buildRuntimePlan derives the isolated agent dir, packages, and warnings", () => {
  const plan = buildRuntimePlan({ packages: ["npm:foo@1.0.0"] }, { piPackages: PI_PACKAGES });
  assert.equal(plan.agentDir, ".forge/pi-home");
  assert.deepEqual(plan.packages, ["npm:foo@1.0.0"], "nothing the design does not use");
  const workflow = buildRuntimePlan({ orchestrator: { name: "l", tools: ["read", "subagent"] }, workflows: [{ name: "w" }] }, { piPackages: PI_PACKAGES });
  assert.deepEqual(workflow.packages, [expectedForgePin, "npm:pi-subagents@0.83.1"]);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, [], "no warning that does not apply");
});

test("buildRuntimePlan warns about logins on the first build and context files from outside the project", () => {
  const first = buildRuntimePlan({}, { piPackages: PI_PACKAGES, firstBuild: true });
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /login files are not inherited.*environment is inherited/);
  assert.deepEqual(buildRuntimePlan({}, { piPackages: PI_PACKAGES, contextFiles: ["AGENTS.md"] }).warnings, [], "the project's own AGENTS.md loads natively; nothing to warn about");
  const outside = buildRuntimePlan({}, { piPackages: PI_PACKAGES, contextFiles: ["AGENTS.md", "../CLAUDE.md", "../../AGENTS.md"] });
  assert.equal(outside.warnings.length, 1);
  assert.match(outside.warnings[0], /\.\.\/CLAUDE\.md, \.\.\/\.\.\/AGENTS\.md from outside this project/);
});

test("buildRuntimePlan propagates dependency errors", () => {
  const plan = buildRuntimePlan({ packages: ["npm:unpinned"] }, { piPackages: [] });
  assert.ok(plan.errors.some((e) => e.includes("npm:unpinned")), "an invalid declared package surfaces as an error");
});

test("launcherScript sets the isolated agent dir and never copies auth.json", () => {
  const script = launcherScript();
  assert.match(script, /PI_CODING_AGENT_DIR/);
  assert.match(script, /\.forge\/pi-home/);
  assert.match(script, /exec pi/);
  assert.match(script, /\$\{BASH_SOURCE\[0\]\}/, "resolves root from its own location");
  assert.match(script, /command -v pi/, "fails explicitly when pi is missing");
  assert.match(script, /cd "\$ROOT"/, "changes into the project root");
  assert.match(script, /\.pi\/system\.yaml/, "validates the project model before launching");
  assert.ok(!/auth\.json|cp .*auth|ln .*auth/.test(script), "must not copy host credentials");
});

test("AGENT_DIR constant is the stable project-relative pi-home", () => {
  assert.equal(AGENT_DIR, ".forge/pi-home");
});

test("launcherScript adds a .env loader only for declared env names", () => {
  assert.ok(!launcherScript().includes(".env"));
  assert.ok(!launcherScript([]).includes("FORGE_ENV_NAMES"));
  const script = launcherScript(envNames({ integrations: { env: [{ name: "GITHUB_PAT" }, { name: "OTHER" }, { name: "GITHUB_PAT" }] } }));
  assert.match(script, /FORGE_ENV_NAMES=" GITHUB_PAT OTHER "/);
  assert.ok(script.indexOf("FORGE_ENV_NAMES") > script.indexOf("export PI_CODING_AGENT_DIR"), "the agent dir cannot be overridden from .env");
  assert.ok(!/\bsource\b|^\s*\. /m.test(script), ".env is parsed, never sourced");
});
