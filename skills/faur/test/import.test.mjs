import { test } from "node:test";
import assert from "node:assert/strict";
import { importSystem } from "../import.mjs";
import { validateSystem } from "../validate.mjs";

const SETTINGS = {
  defaultProvider: "provider-a",
  defaultModel: "model-large",
  defaultThinkingLevel: "medium",
  defaultTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent"],
  subagents: { agentOverrides: { worker: { model: "provider-a/model-medium" } } },
  spec: { baseBranch: "development", releaseBranch: "master", tagPrefix: "v", versionFile: "package.json" },
};

const DETECTED = {
  name: "coding-agent-system",
  skills: [{ name: "house-style", description: "Write plainly", source: "./.pi/skills/house-style" }],
  agents: [
    { name: "scout", description: "Read-only discovery", tools: ["read", "grep", "find", "ls"], model: "provider-b/model-small", thinking: "low", skills: ["house-style"], prompt: "Investigate.\n" },
    { name: "worker", description: "Single writer", tools: ["read", "bash", "edit", "write"], model: "provider-a/model-medium", prompt: "Implement.\n" },
  ],
  mcpServers: { cloudflare: { command: "npx", args: ["cloudflare-mcp", "--stdio"] } },
};

test("importSystem derives the orchestrator model and thinking from settings defaults", () => {
  const { system } = importSystem(SETTINGS, DETECTED);
  assert.equal(system.orchestrator.name, "orchestrator");
  assert.equal(system.orchestrator.model, "provider-a/model-large");
  assert.equal(system.orchestrator.thinking, "medium");
  assert.deepEqual(system.orchestrator.tools, SETTINGS.defaultTools);
  assert.equal(system.models, undefined, "no tiers");
});

test('importSystem preserves an explicitly empty defaultTools allowlist', () => {
  const { system } = importSystem({ ...SETTINGS, defaultTools: [] }, {});
  assert.deepEqual(system.orchestrator.tools, []);
  assert.equal(validateSystem(system).ok, true);
});

test('importSystem separates intact generated specialist guidance and blocks ambiguous generated files', () => {
  const marker = "## What you can use\n\nGenerated from this system's declarations; it changes when they do. Use only what is listed here.";
  const agent = { name: 'scout', tools: ['read'], model: 'p/m', prompt: `Authored instructions.\n\n${marker}\n\n- read`, generatedMarker: true, intactGenerated: true };
  const clean = importSystem(SETTINGS, { agents: [agent] });
  assert.equal(clean.system.agents[0].prompt, 'Authored instructions.');
  assert.match(clean.report.flagged[0].reason, /not imported as authored prompt/);
  assert.equal(clean.report.blocked.length, 0);
  for (const modified of [ { ...agent, intactGenerated: false }, { ...agent, prompt: `${agent.prompt}\n\n${marker}` }, { ...agent, prompt: 'no recognized boundary' } ]) {
    assert.match(importSystem(SETTINGS, { agents: [modified] }).report.blocked[0].reason, /cannot be safely separated/);
  }
  const unmarked = importSystem(SETTINGS, { agents: [{ ...agent, generatedMarker: false }] });
  assert.equal(unmarked.system.agents[0].prompt, undefined);
  assert.match(unmarked.report.flagged[0].reason, /preserved in the native file/);
});

test('importSystem reconstructs only a separable marked lead prompt and reports other content', () => {
  const marked = `<!-- faur:generated v1 sha256=${'a'.repeat(64)} -->\nManual first line.\nSecond line.\n\n<!-- faur:derived v1 begin: generated from system.yaml; edits here are reported, not kept -->\nGenerated and native content.\n`;
  const imported = importSystem(SETTINGS, { appendSystem: marked });
  assert.equal(imported.system.orchestrator.prompt, 'Manual first line.\nSecond line.\n');
  assert.match(imported.report.flagged.find(flag => flag.key === '.pi/APPEND_SYSTEM.md').reason, /not reconstructed/);
  const unmarked = importSystem(SETTINGS, { appendSystem: 'Native instructions.\n' });
  assert.equal(unmarked.system.orchestrator.prompt, undefined);
  assert.match(unmarked.report.flagged.find(flag => flag.key === '.pi/APPEND_SYSTEM.md').reason, /not imported/);
});

test("importSystem keeps each agent's own model, thinking and skills", () => {
  const { system } = importSystem(SETTINGS, DETECTED);
  assert.deepEqual(system.agents.map((a) => [a.name, a.model, a.thinking, a.skills]), [
    ["scout", "provider-b/model-small", "low", ["house-style"]],
    ["worker", "provider-a/model-medium", undefined, undefined],
  ]);
});

test("importSystem declares only detected skills, by their own directory, and no workflows", () => {
  const { system } = importSystem(SETTINGS, DETECTED);
  assert.deepEqual(system.skills, [{ name: "house-style", description: "Write plainly", source: "./.pi/skills/house-style" }]);
  assert.equal(system.workflows, undefined, "no workflows are invented");
  assert.deepEqual(system.integrations.mcp, [
    { name: "cloudflare", config: { command: "npx", args: ["cloudflare-mcp", "--stdio"] } },
  ]);
});

test('importSystem reports native commands that cannot be reconstructed', () => {
  const { system, report } = importSystem(SETTINGS, { commandsPresent: true });
  assert.equal(system.integrations?.cli, undefined);
  assert.match(report.flagged.find(item => item.key === '.pi/commands.json').reason, /not reconstructed/);
  assert.ok(!importSystem(SETTINGS, {}).report.flagged.some(item => item.key === '.pi/commands.json'));
  const pin = 'git:github.com/mihaiiova/pi-commands@v0.1.0';
  assert.deepEqual(importSystem({ ...SETTINGS, packages: [pin] }, { commandsPresent: true }).system.packages, [pin]);
  assert.equal(importSystem({ ...SETTINGS, packages: [pin] }, {}).system.packages, undefined);
});

test("importSystem flags missing models instead of inventing them", () => {
  const { system, report } = importSystem({}, { agents: [{ name: "helper", tools: [] }] });
  assert.equal(system.orchestrator.model, undefined);
  assert.equal(system.agents[0].model, undefined);
  const keys = report.flagged.map((f) => f.key);
  assert.ok(keys.includes("orchestrator.model"));
  assert.ok(keys.includes("agents.helper.model"));
});

test("importSystem flags unsupported settings instead of silently dropping them", () => {
  const settings = {
    ...SETTINGS,
    customExtensions: ["/tmp/my-ext"],
    exoticProviderOverride: { model: "x/y" },
  };
  const { system, report } = importSystem(settings, DETECTED);

  const keys = report.flagged.map((f) => f.key);
  assert.ok(keys.includes("spec"), "spec block is flagged as preserved-not-modeled");
  assert.ok(keys.includes("subagents.agentOverrides"), "routing overrides are flagged, not modeled");
  assert.ok(keys.includes("customExtensions"), "unknown key is flagged");
  assert.ok(keys.includes("exoticProviderOverride"), "exotic override is flagged");
  assert.ok(report.flagged.every((f) => typeof f.reason === "string" && f.reason), "every flag has a reason");
  assert.ok(!("customExtensions" in system));
});

test("importSystem output is a valid schema-v1 document", () => {
  const { system } = importSystem(SETTINGS, DETECTED);
  const { ok, errors } = validateSystem(system);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});
