import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCapabilities, checkCapabilities } from "../capabilities.mjs";

const PI_PACKAGES = ["npm:pi-subagents@0.83.1", "npm:pi-web-access@0.27.0"];

const MODEL = {
  schema: 1,
  name: "seo-system",
  orchestrator: { name: "orchestrator", model: "m/large", tools: ["read", "grep", "bash", "subagent"] },
  agents: [
    { name: "analyst", tools: ["read", "grep"], model: "m/small", thinking: "low", skills: ["draft"], prompt: "Analyze." },
  ],
  skills: [
    { name: "draft", description: "draft" },
    { name: "packaged", description: "pkg", source: "npm:@acme/skills@2.0.0" },
    { name: "local", source: "./vendor/local" },
  ],
  integrations: {
    mcp: [{ name: "openseo", config: { url: "http://localhost:3002/mcp" } }],
  },
  policies: { enforced: [{ mcp: "openseo", hide: ["publish_*"] }] },
  packages: ["npm:extra@1.0.0"],
};

test("effectiveCapabilities derives the full intended surface", () => {
  const caps = effectiveCapabilities(MODEL, { piPackages: PI_PACKAGES });
  assert.deepEqual(caps.orchestratorTools, ["bash", "grep", "read", "subagent"]);
  assert.equal(caps.orchestratorModel, "m/large");
  assert.deepEqual(caps.agents, [{ name: "analyst", tools: ["grep", "read"], model: "m/small", thinking: "low", skills: ["draft"] }]);
  assert.deepEqual(caps.skills, [
    { name: "draft", source: "authored" },
    { name: "packaged", source: "package" },
    { name: "local", source: "path" },
  ]);
  assert.deepEqual(caps.mcpServers, [{ name: "openseo", exposure: "deferred", toolExposure: { "publish_*": "hidden" } }]);
  assert.deepEqual(caps.packages, [
    "npm:pi-subagents@0.83.1",
    "npm:extra@1.0.0",
    "npm:@acme/skills@2.0.0",
  ]);
  assert.ok(caps.notes.length >= 2, "states subagent + extension-tool enforcement notes");
});

test('capability preview uses effective policy overrides, not the wider agent declaration', () => {
  const caps = effectiveCapabilities({ ...MODEL, policies: { enforced: [{ agent: 'analyst', tools: [] }] } }, { piPackages: PI_PACKAGES });
  assert.deepEqual(caps.agents[0].tools, []);
  assert.equal(caps.maintenance.operationalToolExpansion, false);
});

test("checkCapabilities passes for consistent generated config", () => {
  const caps = effectiveCapabilities(MODEL, { piPackages: PI_PACKAGES });
  const generated = {
    settings: { defaultProvider: "m", defaultModel: "large", defaultTools: MODEL.orchestrator.tools, packages: caps.packages },
    mcpJson: { mcpServers: { openseo: { url: "http://localhost:3002/mcp", exposure: "deferred", toolExposure: { "publish_*": "hidden" } } }, autoEnableCodemode: false },
  };
  const { ok, errors } = checkCapabilities(MODEL, generated, { piPackages: PI_PACKAGES });
  assert.equal(ok, true, `expected consistent: ${errors.join("; ")}`);
  const lead = { ...MODEL, orchestrator: { ...MODEL.orchestrator, tools: [...MODEL.orchestrator.tools, "mcp"] } };
  // A lead with mcp needs no runtime boundary, so its expected pins differ; its defaultTools do not.
  const leadPins = effectiveCapabilities(lead, { piPackages: PI_PACKAGES }).packages;
  assert.equal(checkCapabilities(lead, { ...generated, settings: { ...generated.settings, packages: leadPins } }, { piPackages: PI_PACKAGES }).ok, true, "mcp is reached through exposure, not defaultTools");
  const unhidden = { ...generated, mcpJson: { mcpServers: { openseo: { url: "http://localhost:3002/mcp", exposure: "deferred" } }, autoEnableCodemode: false } };
  assert.ok(checkCapabilities(MODEL, unhidden, { piPackages: PI_PACKAGES }).errors.some((e) => e.includes("toolExposure mismatch")), "a hidden tool made reachable is flagged");
  const codemode = { ...generated, mcpJson: { ...generated.mcpJson, autoEnableCodemode: true } };
  assert.ok(checkCapabilities(MODEL, codemode, { piPackages: PI_PACKAGES }).errors.some((e) => e.includes("autoEnableCodemode")));
});

test("checkCapabilities flags a hand-added mcp server", () => {
  const caps = effectiveCapabilities(MODEL, { piPackages: PI_PACKAGES });
  const generated = {
    settings: { defaultProvider: "m", defaultModel: "large", defaultTools: MODEL.orchestrator.tools, packages: caps.packages },
    mcpJson: { mcpServers: { openseo: {}, ghost: {} } },
  };
  const { ok, errors } = checkCapabilities(MODEL, generated, { piPackages: PI_PACKAGES });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("mcpServers mismatch")), "undeclared server flagged");
});

test("checkCapabilities flags a wrong defaultTools", () => {
  const caps = effectiveCapabilities(MODEL, { piPackages: PI_PACKAGES });
  const generated = {
    settings: { defaultProvider: "m", defaultModel: "large", defaultTools: ["read"], packages: caps.packages },
    mcpJson: { mcpServers: {} },
  };
  const { ok, errors } = checkCapabilities(MODEL, generated, { piPackages: PI_PACKAGES });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("defaultTools mismatch")), "tool mismatch flagged");
});

test("checkCapabilities flags a primary-session model that drifted from system.yaml", () => {
  const caps = effectiveCapabilities(MODEL, { piPackages: PI_PACKAGES });
  const generated = {
    settings: { defaultProvider: "m", defaultModel: "other", defaultTools: MODEL.orchestrator.tools, packages: caps.packages },
    mcpJson: { mcpServers: { openseo: { excludeTools: ["publish_*"] } } },
  };
  const { ok, errors } = checkCapabilities(MODEL, generated, { piPackages: PI_PACKAGES });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("default model mismatch: expected m/large got m/other")));
});
