import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpFromIntegrations, mcpToolName } from "../mcp-gen.mjs";

test("servers keep their connection settings; without includeTools their tools are deferred", () => {
  const mcp = [
    { name: "openseo", config: { url: "http://localhost:3002/mcp", headers: { Authorization: "Bearer ${SEO_TOKEN}" }, description: "SEO data" } },
    { name: "gh", config: { command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "${GH_TOKEN}" } } },
  ];
  assert.deepEqual(mcpFromIntegrations(mcp, undefined), {
    openseo: { url: "http://localhost:3002/mcp", headers: { Authorization: "Bearer ${SEO_TOKEN}" }, description: "SEO data", exposure: "deferred" },
    gh: { command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "${GH_TOKEN}" }, exposure: "deferred" },
  });
});

test("includeTools declares only those tools directly; the rest of the server is hidden", () => {
  const servers = mcpFromIntegrations([{ name: "seo", config: { url: "http://x", includeTools: ["get_report", "run_*"], approveTools: ["run_*"] } }], undefined);
  assert.deepEqual(servers.seo, { url: "http://x", exposure: "hidden", toolExposure: { get_report: "direct", "run_*": "direct" } });
});

test("excludeTools and enforced hide policies are hidden and win over includeTools", () => {
  const policies = { enforced: [{ mcp: "seo", hide: ["publish_*"] }] };
  const servers = mcpFromIntegrations([{ name: "seo", config: { url: "http://x", includeTools: ["get_report", "publish_post", "delete_*"], excludeTools: ["delete_*"] } }], policies);
  assert.deepEqual(servers.seo.toolExposure, { "delete_*": "hidden", "publish_*": "hidden", get_report: "direct" });
  assert.equal(servers.seo.exposure, "hidden");
  const open = mcpFromIntegrations([{ name: "seo", config: { url: "http://x" } }], policies);
  assert.deepEqual(open.seo, { url: "http://x", exposure: "deferred", toolExposure: { "publish_*": "hidden" } });
});

test("removing a server from the model drops it on the next materialization", () => {
  const first = mcpFromIntegrations(
    [{ name: "openseo", config: { url: "http://x" } }, { name: "gh", config: { command: "npx" } }],
    undefined,
  );
  assert.deepEqual(Object.keys(first).sort(), ["gh", "openseo"]);

  const second = mcpFromIntegrations([{ name: "openseo", config: { url: "http://x" } }], undefined);
  assert.deepEqual(Object.keys(second), ["openseo"], "gh is gone after removal");
});

test("Pi names each MCP tool mcp__<server>__<tool>, replacing other characters with _", () => {
  assert.equal(mcpToolName("my-docs", "get-item"), "mcp__my_docs__get_item");
  assert.equal(mcpToolName("seo", "run_*"), "mcp__seo__run_*", "patterns keep their wildcards");
});
