import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelRef, splitModelRef, parseModelList, modelAssignments, unavailableModelWarnings,
} from "../models.mjs";

const LIST = [
  "provider      model                context  max-out  thinking  images",
  "deepseek      deepseek-flash       1M       384K     yes       yes   ",
  "openai-codex  gpt-6-sol            272K     128K     yes       yes   ",
  "",
].join("\n");

test("isModelRef requires provider/id with no whitespace", () => {
  assert.ok(isModelRef("deepseek/deepseek-flash"));
  assert.ok(isModelRef("openrouter/anthropic/some-model"));
  for (const bad of ["high", "/id", "provider/", "a b/c", "", undefined]) assert.equal(isModelRef(bad), false, String(bad));
});

test("splitModelRef splits on the first slash", () => {
  assert.deepEqual(splitModelRef("openrouter/anthropic/x"), { provider: "openrouter", id: "anthropic/x" });
  assert.deepEqual(splitModelRef("high"), { provider: undefined, id: undefined });
});

test("parseModelList reads pi --list-models output, skipping the header", () => {
  assert.deepEqual(parseModelList(LIST), ["deepseek/deepseek-flash", "openai-codex/gpt-6-sol"]);
  assert.deepEqual(parseModelList(""), []);
  assert.deepEqual(parseModelList(undefined), []);
});

test("modelAssignments lists the orchestrator and every subagent", () => {
  const model = {
    orchestrator: { name: "lead", model: "a/x" },
    agents: [{ name: "helper", model: "b/y" }],
  };
  assert.deepEqual(modelAssignments(model), [
    { agent: "lead", model: "a/x" },
    { agent: "helper", model: "b/y" },
  ]);
});

test("unavailableModelWarnings flags refs missing from the catalog, never with an empty catalog", () => {
  const model = {
    orchestrator: { name: "lead", model: "deepseek/deepseek-flash" },
    agents: [{ name: "helper", model: "deepseek/deepseek-v4-flash" }],
  };
  const warnings = unavailableModelWarnings(model, parseModelList(LIST));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /helper uses model "deepseek\/deepseek-v4-flash"/);
  assert.deepEqual(unavailableModelWarnings(model, []), []);
});
