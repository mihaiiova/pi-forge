import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(resolve(here, "../SKILL.md"), "utf-8");

test("SKILL.md routes faur/agent-system intents and documents force-invocation", () => {
  assert.ok(skill.includes("/skill:faur"), "documents the force-invocation command");
  assert.ok(/agent system/i.test(skill), "describes the agent-system outcome it serves");
  assert.ok(/multi-agent/i.test(skill), "describes multi-agent systems");
});

test("SKILL.md drives the lifecycle through discover/generate/modify/validate", () => {
  assert.ok(skill.includes("faur discover"), "references faur discover");
  assert.ok(skill.includes("faur generate"), "references faur generate");
  assert.ok(skill.includes("faur modify"), "references faur modify");
  assert.ok(skill.includes("faur validate"), "references faur validate");
});

test("SKILL.md converses without depending on host skills and previews before applying", () => {
  assert.ok(!/grill-me|grill-with-docs|decisionThreshold/.test(skill), "the conversation is self-contained");
  assert.ok(skill.includes("--dry-run"), "references the preview-before-apply dry-run");
});

test("SKILL.md designs conversationally and keeps the build confirmation", () => {
  for (const phase of ["### Explore", "### Synthesize", "### Build"]) assert.ok(skill.includes(phase), `describes ${phase}`);
  for (const mark of ["**Confirmed**", "**Proposed**", "**Unresolved**"]) assert.ok(skill.includes(mark), `marks ${mark}`);
  assert.ok(/conversation is the requirement source/.test(skill), "reuses the conversation as requirements");
  assert.ok(/not a\s+checklist or a state machine/.test(skill), "phases are not a state machine");
  assert.ok(/not\s+approval to write files unseen/.test(skill), "build intent is not approval to write files");
  assert.ok(!/\binterview for\b/i.test(skill), "no interview-first step");
});

test("conversational acceptance scenarios are documented", () => {
  const doc = readFileSync(resolve(here, "../../../docs/faur-conversation.md"), "utf-8");
  const scenarios = doc.match(/^## \d\. /gm) ?? [];
  assert.equal(scenarios.length, 6, "six numbered scenarios");
  for (const part of ["**Input.**", "**Pass.**", "**Fail.**"]) assert.equal(doc.split(part).length - 1, 6, `each scenario has ${part}`);
});

test("SKILL.md asks for each agent's model from the full Pi line-up", () => {
  assert.ok(skill.includes("pi --list-models"), "names the model catalog source");
  assert.ok(/ships no default models/.test(skill), "hardcodes no models");
  assert.ok(skill.includes("model: provider/id"), "records the choice on the agent");
  assert.ok(/"op":"assign"/.test(skill), "documents changing a model later");
});

test("SKILL.md suggests registry skills per agent and installs only the user's picks, project-locally", () => {
  assert.ok(/ships no skills of its own; each agent gets the\s+skills the user chooses for it/.test(skill));
  assert.ok(/search-skills/.test(skill) && /preview-skill/.test(skill), "searches and previews skills.sh skills");
  assert.ok(/project-local, never global/.test(skill), "never installs globally");
  assert.ok(!skill.includes("knownIntegrations"), "no built-in recommendation list");
  for (const form of ["npm:<name>@<version>", "./path", "agents[].skills", "skills:<owner>/<repo>/<dir>@<commit>"]) {
    assert.ok(skill.includes(form), `documents ${form}`);
  }
});

test("SKILL.md states the enforced-vs-advisory split and the ownership contract", () => {
  assert.ok(skill.includes("Enforced"), "states the enforced category");
  assert.ok(skill.includes("Advisory"), "states the advisory category");
  assert.ok(skill.includes("excludeTools"), "names the enforced MCP mechanism");
  assert.ok(skill.includes("never silently overwritten"), "states the conflict contract");
  assert.ok(/never write a secret/i.test(skill), "states the credential-safety rule");
});
