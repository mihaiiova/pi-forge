import { test } from "node:test";
import assert from "node:assert/strict";
import { generateProject } from "../src/generate.mjs";

const multiModel = {
  schema: 1,
  name: "seo-agent-system",
  description: "SEO analysis + article drafting",
  orchestrator: {
    name: "orchestrator",
    description: "Primary SEO agent",
    prompt: "You coordinate the SEO system.\n",
    model: "provider-a/model-large", thinking: "medium",
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent"],
  },
  agents: [
    {
      name: "seo-analyst",
      description: "Analyzes SEO data and identifies opportunities",
      tools: ["read", "grep", "find", "ls"],
      model: "provider-b/model-small", thinking: "low",
      prompt: "You analyze SEO data and identify opportunities. You never publish; publication requires the orchestrator's approval.\n",
    },
    {
      name: "article-writer",
      description: "Drafts articles",
      tools: ["read", "write"],
      model: "provider-a/model-medium", thinking: "high",
      prompt: "You draft articles. When you need more research, request it from the researcher.\n",
    },
    {
      name: "researcher",
      description: "Maintains shared product knowledge",
      tools: ["read", "write", "bash"],
      model: "provider-b/model-small", thinking: "low",
      prompt: "You independently maintain shared product knowledge under data/knowledge/.\n",
    },
  ],
  skills: [
    {
      name: "refresh-product-knowledge",
      description: "Refresh product knowledge",
    },
    { name: "analyze-and-draft", description: "Analyze and draft" },
  ],

};

function byPath(files, path) {
  return files.find((f) => f.path === path);
}

test("N agents materialize to N .pi/agents/*.md files with correct frontmatter", () => {
  const { files } = generateProject(multiModel, {});

  const agentFiles = files.filter((f) => f.path.startsWith(".pi/agents/"));
  assert.equal(agentFiles.length, 3);

  const analyst = byPath(files, ".pi/agents/seo-analyst.md");
  assert.equal(analyst.action, "create");
  assert.ok(analyst.content.includes("name: seo-analyst"));
  assert.ok(analyst.content.includes('description: "Analyzes SEO data and identifies opportunities"'));
  assert.ok(analyst.content.includes("tools:\n  - read\n  - grep\n  - find\n  - ls\n"));
  assert.ok(analyst.content.includes("model: provider-b/model-small"), "the agent's own model ref");
  assert.ok(analyst.content.includes("thinking: low"), "the agent's own thinking level");
  assert.ok(analyst.content.includes("systemPrompt: |"));
  assert.ok(analyst.content.includes("You analyze SEO data and identify opportunities."));

  const writer = byPath(files, ".pi/agents/article-writer.md");
  assert.ok(writer.content.includes("model: provider-a/model-medium"), "writer's own model ref");
  assert.ok(writer.content.includes("thinking: high"));
});

test("declared inheritProjectContext / inheritSkills are emitted as frontmatter", () => {
  const modelWithInherit = {
    ...multiModel,
    agents: [
      {
        name: "seo-analyst",
        description: "Reads project context",
        tools: ["read"],
        model: "provider-b/model-small", thinking: "low",
        prompt: "Analyze with project context.\n",
        inheritProjectContext: true,
        inheritSkills: true,
      },
    ],
  };
  const { files } = generateProject(modelWithInherit, {});
  const analyst = byPath(files, ".pi/agents/seo-analyst.md");
  assert.ok(analyst.content.includes("inheritProjectContext: true"));
  assert.ok(analyst.content.includes("inheritSkills: true"));
});

test("developer-owned skills are not generated; agent scaffolds retain markers", () => {
  const { files } = generateProject(multiModel, {});
  assert.equal(byPath(files, ".pi/skills/refresh-product-knowledge/SKILL.md"), undefined);
  const agent = byPath(files, ".pi/agents/seo-analyst.md").content;
  assert.match(agent, /^---\n/);
  assert.match(agent, /<!-- faur:generated v1 sha256=[0-9a-f]{64} -->\n$/);
});

test("round-trip-lite: a user edit to an agent file survives regeneration", () => {
  const first = generateProject(multiModel, {});
  const path = ".pi/agents/seo-analyst.md";
  const original = byPath(first.files, path).content;
  const edited = original.replace(
    "You analyze SEO data and identify opportunities.",
    "I now focus on competitor analysis instead.",
  );

  const second = generateProject(multiModel, { [path]: edited });
  const entry = byPath(second.files, path);
  assert.equal(entry.action, "none");
  assert.equal(entry.content, edited);
});

test("SEO delegation structure: writer research, independent researcher, no analyst auto-publish", () => {
  const { files } = generateProject(multiModel, {});

  const writer = byPath(files, ".pi/agents/article-writer.md").content;
  assert.ok(writer.includes("researcher"), "writer can request research from the researcher");

  const researcher = byPath(files, ".pi/agents/researcher.md").content;
  assert.ok(researcher.includes("independently maintain"), "researcher updates knowledge independently");
  assert.ok(researcher.includes("data/knowledge/"), "researcher owns data/knowledge/");

  const analyst = byPath(files, ".pi/agents/seo-analyst.md").content;
  assert.ok(analyst.includes("identify opportunities"), "analyst identifies opportunities");
  assert.ok(analyst.includes("tools:\n  - read\n  - grep\n  - find\n  - ls\n"), "analyst allowlist is read-only");
  assert.ok(!analyst.includes("write"), "analyst allowlist has no write tool → cannot auto-publish");

});
