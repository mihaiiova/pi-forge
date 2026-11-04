import { test } from "node:test";
import assert from "node:assert/strict";
import { generateProject } from "../generate.mjs";
import { diffLines } from "../diff.mjs";

const baseModel = {
  schema: 1,
  name: "seo-agent-system",
  description: "SEO",
  orchestrator: {
    name: "orchestrator",
    model: "a/high",
    thinking: "high",
    tools: ["read", "subagent"],
    prompt: "Coordinate.\n",
  },
  agents: [
    { name: "seo-analyst", description: "Analyst", tools: ["read"], model: "c/small", thinking: "low", prompt: "Analyze.\n" },
  ],
};

function byPath(files, path) {
  return files.find((f) => f.path === path);
}

/** The faur-written project as it would exist on disk before a modify. */
function baseline() {
  const { files } = generateProject(baseModel, {});
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

test("add-agent: a new agents[] entry produces a create", () => {
  const existing = baseline();
  const model = {
    ...baseModel,
    agents: [
      ...baseModel.agents,
      { name: "article-writer", tools: ["write"], model: "b/medium", prompt: "Draft.\n" },
    ],
  };

  const { files } = generateProject(model, existing);
  const entry = byPath(files, ".pi/agents/article-writer.md");

  assert.equal(entry.action, "create");
  assert.equal(entry.diff, undefined, "create entries carry content, not a diff");
});

test("change-model: agent and orchestrator model changes produce writes with diffs", () => {
  const existing = baseline();
  const model = {
    ...baseModel,
    orchestrator: { ...baseModel.orchestrator, model: "d/other" },
    agents: [{ ...baseModel.agents[0], model: "b/medium" }],
  };

  const { files } = generateProject(model, existing);

  const agent = byPath(files, ".pi/agents/seo-analyst.md");
  assert.equal(agent.action, "write");
  const agentDiff = diffLines(existing[agent.path], agent.content);
  assert.ok(agentDiff.includes("b/medium") && agentDiff.includes("c/small"),
    "agent diff shows the model ref change");

  const settings = byPath(files, ".pi/settings.json");
  assert.equal(settings.action, "write");
  const settingsDiff = diffLines(existing[settings.path], settings.content);
  assert.ok(settingsDiff.includes('"defaultProvider": "a"') && settingsDiff.includes('"defaultProvider": "d"'),
    "settings diff shows the primary-session model change");
});

test("preserve-unrelated-edit: hand-authored file and unknown settings key survive", () => {
  const existing = baseline();
  existing["README.md"] = "# My custom README\n"; // no faur marker → user-owned
  const parsedSettings = JSON.parse(existing[".pi/settings.json"]);
  existing[".pi/settings.json"] = JSON.stringify({ ...parsedSettings, theme: "dark" });

  const { files } = generateProject(baseModel, existing);

  assert.equal(byPath(files, "README.md").action, "none", "user-authored README untouched");

  const settings = byPath(files, ".pi/settings.json");
  assert.equal(JSON.parse(settings.content).theme, "dark", "unknown settings key preserved");
});

test("conflict-detection: user edit + model change on an authored file is a conflict", () => {
  const existing = baseline();
  const original = existing[".pi/APPEND_SYSTEM.md"];
  const marker = original.split("\n", 1)[0];
  const userEdited = `${marker}\nUser's own instructions.\n`;
  existing[".pi/APPEND_SYSTEM.md"] = userEdited;

  const model = {
    ...baseModel,
    orchestrator: { ...baseModel.orchestrator, prompt: "New prompt.\n" },
  };

  const { files } = generateProject(model, existing);
  const conflicts = files.filter(f => f.action === 'conflict');
  const append = byPath(files, ".pi/APPEND_SYSTEM.md");

  assert.equal(append.action, "conflict");
  assert.ok(conflicts.includes(append), "conflict is surfaced in the conflicts list");
  assert.equal(append.content, userEdited, "conflict must not overwrite the user edit");
  assert.ok(diffLines(existing[append.path], append.desired).length > 0, "conflict can be diffed against the proposed content");
});

test('modify previews missing gitignore entries without changing existing rules', () => {
  const existing = baseline();
  existing['.gitignore'] = 'node_modules\n.env\n';
  const file = byPath(generateProject(baseModel, existing).files, '.gitignore');
  assert.equal(file.action, 'write');
  const diff = diffLines(existing[file.path], file.content);
  assert.match(diff, /\+ # faur: required ignores/);
  assert.match(diff, /\+ \.faur\//);
  assert.equal(existing['.gitignore'], 'node_modules\n.env\n');
});
