import { test } from "node:test";
import assert from "node:assert/strict";
import { importSystem } from "../import.mjs";
import { generateProject } from "../generate.mjs";
import { validateSystem } from "../validate.mjs";
import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;

const SETTINGS = {
  defaultProvider: "provider-a",
  defaultModel: "model-large",
  defaultThinkingLevel: "medium",
  defaultTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent"],
  spec: { baseBranch: "development", releaseBranch: "master", tagPrefix: "v", versionFile: "package.json" },
};

const DETECTED = {
  name: "coding-agent-system",
  skills: [{ name: "house-style", description: "Write plainly", source: "./.pi/skills/house-style" }],
  agents: [
    { name: "scout", description: "Read-only discovery", tools: ["read", "grep", "find", "ls"], model: "provider-b/model-small", skills: ["house-style"], prompt: "Investigate.\n" },
    { name: "worker", description: "Single writer", tools: ["read", "bash", "edit", "write"], model: "provider-a/model-medium", thinking: "high", prompt: "Implement.\n" },
    { name: "reviewer", description: "Read-only review", tools: ["read", "grep", "find", "ls", "bash"], model: "provider-b/model-small", prompt: "Review.\n" },
    { name: "oracle", description: "Hard reasoning", tools: ["read", "grep", "find", "ls"], model: "provider-a/model-large", prompt: "Reason.\n" },
  ],
  mcpServers: { cloudflare: { command: "npx", args: ["cloudflare-mcp", "--stdio"] } },
};

// Generated projects never pin Faur; specialists bring pi-subagents.
const PINS = ["npm:pi-subagents@0.83.1"];

test("round-trip: import → generate preserves each agent's model, skills and MCP", () => {
  const { system } = importSystem(SETTINGS, DETECTED);
  const { ok, errors } = validateSystem(system);
  assert.equal(ok, true, `imported system must validate: ${errors.join("; ")}`);

  const { files } = generateProject(system, {}, { piPackages: ["npm:pi-subagents@0.83.1", "npm:pi-web-access@0.27.0"] });

  const settings = JSON.parse(files.find((f) => f.path === ".pi/settings.json").content);
  assert.equal(settings.defaultProvider, "provider-a");
  assert.equal(settings.defaultModel, "model-large");
  assert.equal(settings.subagents, undefined, "no routing overrides");
  assert.deepEqual(settings.packages, PINS, "pinned packages survive");

  const agents = files.filter((f) => f.path.startsWith(".pi/agents/"));
  assert.equal(agents.length, 4, "four specialist agents materialize");
  const worker = agents.find((f) => f.path === ".pi/agents/worker.md").content;
  assert.match(worker, /^model: provider-a\/model-medium\nthinking: high$/m);
  assert.match(agents.find((f) => f.path === ".pi/agents/scout.md").content, /^skills:\n  - house-style$/m);

  const localSkills = files.filter((f) => f.path.includes("/SKILL.md"));
  assert.deepEqual(localSkills.map(f => f.path), [], "imported skills stay in their own directories");

  assert.ok(files.some((f) => f.path === ".pi/mcp.json" && f.content.includes("cloudflare")), "MCP integration survives");
});

test("round-trip: modify adds an agent and preserves unrelated authored content", () => {
  const { system } = importSystem(SETTINGS, DETECTED);

  // First generate, then simulate a user edit to an authored file.
  const first = generateProject(system, {}, { piPackages: ["npm:pi-subagents@0.83.1"] });
  const existing = Object.fromEntries(first.files.map((f) => [f.path, f.content]));
  const begin = existing[".pi/APPEND_SYSTEM.md"].indexOf("<!-- faur:derived v1 begin");
  existing[".pi/APPEND_SYSTEM.md"] = existing[".pi/APPEND_SYSTEM.md"].slice(0, begin).replace(/\n$/, "") + "User-added orchestrator line.\n\n" + existing[".pi/APPEND_SYSTEM.md"].slice(begin);

  // Modify: add a new agent.
  const changed = {
    ...system,
    agents: [...system.agents, { name: "researcher", description: "Researches", tools: ["read"], model: "provider-a/model-medium", prompt: "Research.\n" }],
  };
  const plan = generateProject(changed, existing);

  const researcher = plan.files.find((f) => f.path === ".pi/agents/researcher.md");
  assert.equal(researcher.action, "create", "the added agent is scaffolded");

  // The lead's generated section lists the new specialist; the authored edit stays.
  const append = plan.files.find((f) => f.path === ".pi/APPEND_SYSTEM.md");
  assert.equal(append.action, "write");
  assert.match(append.content, /User-added orchestrator line\./, "the authored edit is preserved, not overwritten");
  assert.match(append.content, /`researcher` — Researches/, "the derived section follows the declarations");
});
