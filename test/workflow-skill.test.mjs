import { test } from "node:test";
import assert from "node:assert/strict";
import { workflowSkill } from "../src/workflow-skill.mjs";

const workflow = {
  name: "analyze-and-draft",
  description: "Analyze SEO data, pick opportunities, draft articles",
  skill: "analyze-and-draft",
  trigger: { kind: "manual" },
  entry: "orchestrator",
  agents: ["seo-analyst", "article-writer", "researcher"],
  inputs: ["data/opportunities/*.md"],
  outputs: ["data/analyses/", "data/articles/"],
  approval: "publish",
  verify: "a draft exists under data/articles/",
};

test("workflowSkill returns the workflow name and description", () => {
  const { name, description } = workflowSkill(workflow);
  assert.equal(name, "analyze-and-draft");
  assert.equal(description, "Analyze SEO data, pick opportunities, draft articles");
});

test("workflowSkill body declares every boundary field", () => {
  const { body } = workflowSkill(workflow);
  assert.ok(body.includes("# analyze-and-draft"), "body has the workflow title");
  assert.ok(body.includes("Entry: orchestrator"), "entry is declared");
  assert.ok(body.includes("seo-analyst"), "available agent listed");
  assert.ok(body.includes("article-writer"), "available agent listed");
  assert.ok(body.includes("researcher"), "available agent listed");
  assert.ok(body.includes("data/opportunities/*.md"), "inputs declared");
  assert.ok(body.includes("data/analyses/"), "outputs declared");
  assert.ok(body.includes("data/articles/"), "outputs declared");
  assert.ok(body.includes("Approval boundary: publish"), "approval declared");
  assert.ok(body.includes("a draft exists under data/articles/"), "verify declared");
});

test("workflowSkill body instructs subagent orchestration, not a step graph", () => {
  const { body } = workflowSkill(workflow);
  assert.ok(body.includes("subagent"), "references the subagent tool");
  assert.ok(body.includes("workflowScript"), "mentions direct or workflowScript orchestration");
  assert.ok(body.includes("trigger: { kind: manual }"), "declares the manual trigger");
  assert.ok(body.includes('pi --approve -p "/skill:analyze-and-draft <request>"'), "declares the headless trigger surface");
  // No numbered list: a rigid step graph would enumerate fixed steps.
  assert.ok(!/\n[ \t]*\d+[.)][ \t]/.test(body), "body must not enumerate a fixed step sequence");
});

test("workflowSkill is deterministic", () => {
  assert.deepEqual(workflowSkill(workflow), workflowSkill(workflow));
});

test("workflowSkill handles a minimal workflow without optional fields", () => {
  const { body } = workflowSkill({ name: "simple", entry: "orchestrator", agents: [] });
  assert.ok(body.includes("# simple"));
  assert.ok(body.includes("Entry: orchestrator"));
  assert.ok(body.includes("none"), "missing approval defaults to none");
});

test("workflowSkill renders the declared trigger kind", () => {
  const headless = workflowSkill({ ...workflow, trigger: { kind: "headless" } }).body;
  assert.ok(headless.includes("trigger: { kind: headless }"), "headless trigger rendered");
  assert.ok(!headless.includes("kind: manual }"), "manual trigger not rendered for headless");

  const manual = workflowSkill(workflow).body;
  assert.ok(manual.includes("trigger: { kind: manual }"), "manual trigger rendered");
});

test('generated workflow instructions show the named unattended command', () => {
  assert.match(workflowSkill(workflow).body, /pi --approve -p "\/skill:analyze-and-draft <request>"/);
  const entryOnly = { name: "test", entry: "lead" };
  assert.match(workflowSkill(entryOnly).body, /\/skill:test <request>/, "a workflow without a skill is invoked by its own generated skill");
  assert.match(workflowSkill(workflow).body, /## Request\n\nThe text after the skill command is the request/);
});
