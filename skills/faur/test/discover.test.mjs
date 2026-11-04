import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMcpFile, probeClis, scanSkills } from "../discover.mjs";

test("parseMcpFile parses the mcpServers wrapper form", () => {
  const text = JSON.stringify({ mcpServers: { openseo: { url: "http://localhost:3002/mcp" } } });
  assert.deepEqual(parseMcpFile(text).mcpServers, {
    openseo: { url: "http://localhost:3002/mcp" },
  });
});

test("parseMcpFile parses the plain server map form", () => {
  const text = JSON.stringify({ openseo: { command: "npx", args: ["openseo-mcp"] } });
  assert.deepEqual(parseMcpFile(text).mcpServers, {
    openseo: { command: "npx", args: ["openseo-mcp"] },
  });
});

test("parseMcpFile handles stdio and http entry shapes", () => {
  const text = JSON.stringify({
    mcpServers: {
      stdio: { command: "npx", args: ["x"], env: { A: "1" }, cwd: "/tmp" },
      http: { url: "http://x", headers: { Auth: "Bearer t" }, oauth: true },
    },
  });
  const servers = parseMcpFile(text).mcpServers;
  assert.deepEqual(servers.stdio, { command: "npx", args: ["x"], env: { A: "1" }, cwd: "/tmp" });
  assert.deepEqual(servers.http, { url: "http://x", headers: { Auth: "Bearer t" }, oauth: true });
});

test("parseMcpFile returns an empty inventory on malformed JSON", () => {
  assert.deepEqual(parseMcpFile("{ not json").mcpServers, {});
});

test("probeClis reports each CLI via the injected probe", () => {
  const found = probeClis(["gh", "wrangler"], { probe: (cli) => cli === "gh" });
  assert.deepEqual(found, { gh: true, wrangler: false });
});

test("scanSkills reads frontmatter name/description", () => {
  const files = {
    "/skills/seo/SKILL.md": "---\nname: seo\ndescription: SEO skill\n---\n# body\n",
  };
  const skills = scanSkills(files, {
    parse: () => ({ name: "seo", description: "SEO skill" }),
  });
  assert.deepEqual(skills, [{ name: "seo", description: "SEO skill", dir: "/skills/seo" }]);
});

test("scanSkills falls back to the directory name when frontmatter is absent", () => {
  const files = { "/skills/mystery/SKILL.md": "# No frontmatter\n" };
  const skills = scanSkills(files, { parse: () => ({}) });
  assert.deepEqual(skills, [{ name: "mystery", description: "", dir: "/skills/mystery" }]);
});
