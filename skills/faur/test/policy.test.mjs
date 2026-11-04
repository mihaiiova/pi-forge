import { test } from "node:test";
import assert from "node:assert/strict";
import { enforcedAgentTools, hiddenMcpTools, advisoryText } from "../policy.mjs";

test("enforcedAgentTools returns declared tools when no policy names the agent", () => {
  assert.deepEqual(enforcedAgentTools("analyst", undefined, ["read", "grep"]), ["read", "grep"]);
});

test("enforcedAgentTools replaces declared tools with the policy allowlist", () => {
  const policies = { enforced: [{ agent: "analyst", tools: ["read"] }] };
  assert.deepEqual(enforcedAgentTools("analyst", policies, ["read", "write"]), ["read"]);
});

test("enforcedAgentTools allows an empty allowlist (least privilege)", () => {
  const policies = { enforced: [{ agent: "analyst", tools: [] }] };
  assert.deepEqual(enforcedAgentTools("analyst", policies, ["read", "write"]), []);
});

test("hiddenMcpTools returns hide globs for the named server", () => {
  const policies = { enforced: [{ mcp: "openseo", hide: ["publish_*", "delete_*"] }] };
  assert.deepEqual(hiddenMcpTools("openseo", policies), ["publish_*", "delete_*"]);
});

test("hiddenMcpTools returns [] when no policy names the server", () => {
  assert.deepEqual(hiddenMcpTools("other", { enforced: [] }), []);
});

test("advisoryText returns advisory strings in order", () => {
  const policies = { advisory: ["Publishing requires human confirmation."] };
  assert.deepEqual(advisoryText(policies), ["Publishing requires human confirmation."]);
});

test("advisoryText handles missing policies", () => {
  assert.deepEqual(advisoryText(undefined), []);
});
