import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSystem } from "../src/parse.mjs";
import { generateProject } from "../src/generate.mjs";
import { withBaselineTools } from "../src/policy.mjs";
import { COMMANDS_PACKAGE } from "../src/deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures/generate/minimal");
const minimalYaml = readFileSync(resolve(fixtureRoot, ".pi/system.yaml"), "utf-8");
const model = parseSystem(minimalYaml);

// The minimal agent (generated-agent audit, A): nothing it does not use.
const EXPECTED_PATHS = [
  ".gitignore",
  ".pi/APPEND_SYSTEM.md",
  ".pi/settings.json",
  "README.md",
];
/** A design that needs the Faur runtime: one declared command. */
const withCommand = { ...model, orchestrator: { ...model.orchestrator, tools: [...model.orchestrator.tools, "cli:hello"] }, integrations: { cli: [{ name: "hello", command: "echo", args: ["hi"] }] } };
const withServer = { ...model, integrations: { mcp: [{ name: "openseo", config: { url: "http://localhost:3002/mcp" } }] } };

function byPath(files, path) {
  return files.find((f) => f.path === path);
}

test("fresh generate creates the full single-agent tree", () => {
  const { files } = generateProject(model, {});

  assert.deepEqual(
    files.map((f) => f.path).sort(),
    EXPECTED_PATHS.slice().sort(),
  );
  for (const f of files) {
    assert.equal(f.action, "create", `${f.path} should be created fresh`);
  }

  const settings = JSON.parse(byPath(files, ".pi/settings.json").content);
  assert.equal(settings.defaultProvider, "anthropic");
  assert.equal(settings.defaultModel, "claude-sonnet-5-5");
  assert.deepEqual(settings.defaultTools, ["read", "grep", "find", "ls"]);
  assert.equal(settings.packages, undefined, "the minimal agent pins no packages");
  assert.equal(settings.subagents, undefined, "no routing overrides: agents carry their own models");
});

test("projects never pin Faur; they pin the runtime packages their design uses", () => {
  const pins = (m) => JSON.parse(byPath(generateProject(m, {}).files, ".pi/settings.json").content).packages ?? [];
  assert.deepEqual(pins(model), []);
  assert.deepEqual(pins(withCommand), [COMMANDS_PACKAGE], "declared commands come from pi-commands");
  assert.deepEqual(pins(withServer), [], "a lead without mcp is advisory: no package");
  assert.ok(!generateProject(withServer, {}).files.some((f) => f.path.includes("pi-permission-system")), "MCP generates no approval config");
  assert.deepEqual(pins({ ...model, orchestrator: { ...model.orchestrator, tools: [...model.orchestrator.tools, "subagent"] } }), ["npm:pi-subagents@0.83.1"], "subagent alone pins pi-subagents at this release's version");
  for (const m of [model, withCommand, withServer]) assert.ok(!pins(m).some((p) => p.includes("faur")));
});

test("the runtime packages get their native configuration, generated from the design", () => {
  const commands = JSON.parse(byPath(generateProject(withCommand, {}).files, ".pi/commands.json").content);
  assert.deepEqual(commands, { commands: [{ name: "hello", command: "echo", args: ["hi"], approve: true, lead: true }] });
  const paths = generateProject(model, {}).files.map((f) => f.path);
  assert.ok(!paths.includes(".pi/commands.json") && !paths.some((p) => p.includes("pi-permission-system")), "nothing without the declarations");
  const readme = byPath(generateProject(withCommand, {}).files, "README.md").content;
  assert.match(readme, /Declared commands run without a shell.*\(pi-commands, `git:github\.com\/mihaiiova\/pi-commands@v0\.1\.0`\)/);
  assert.match(byPath(generateProject(withServer, {}).files, "README.md").content, /### Advisory[\s\S]*`helper` is told it has no MCP tools; it is not prevented from calling them/);
});

test("files a design does not use are not generated", () => {
  const paths = (m) => generateProject(m, {}).files.map((f) => f.path);
  assert.ok(!paths(model).includes(".pi/mcp.json") && !paths(model).includes(".env.example"));
  assert.ok(paths(withServer).includes(".pi/mcp.json"));
  assert.ok(paths({ ...model, integrations: { env: [{ name: "TOKEN" }] } }).includes(".env.example"));
  assert.ok(!paths(model).includes("run"), "plain pi starts a design that does not depend on built-in MCP");
  assert.ok(!paths(withServer).includes("run"), "MCP projects use plain Pi without a generated launcher");
});

test("re-running generate is a no-op (idempotent)", () => {
  const first = generateProject(model, {});
  const existing = Object.fromEntries(first.files.map((f) => [f.path, f.content]));

  const second = generateProject(model, existing);
  for (const f of second.files) {
    assert.equal(f.action, "none", `${f.path} should be unchanged on re-run`);
  }
});

test("unrelated keys in .pi/settings.json survive regeneration", () => {
  const existing = {
    ".pi/settings.json": JSON.stringify({
      theme: "dark",
      defaultModel: "old/model",
      subagents: { agentOverrides: { worker: { model: "old/model" } }, maxDepth: 2 },
    }),
  };

  const { files } = generateProject(model, existing);
  const settings = JSON.parse(byPath(files, ".pi/settings.json").content);

  assert.equal(settings.theme, "dark", "unrelated key preserved");
  assert.equal(settings.defaultModel, "claude-sonnet-5-5", "model-owned key overwritten");
  assert.deepEqual(settings.subagents, { maxDepth: 2 }, "stale routing overrides dropped, other subagent settings kept");
});

test("orchestrator.model and thinking drive the primary session", () => {
  const changed = {
    ...model,
    orchestrator: { ...model.orchestrator, model: "openrouter/anthropic/some-model", thinking: "low" },
  };

  const { files } = generateProject(changed, {});
  const settings = JSON.parse(byPath(files, ".pi/settings.json").content);

  assert.equal(settings.defaultProvider, "openrouter");
  assert.equal(settings.defaultModel, "anthropic/some-model");
  assert.equal(settings.defaultThinkingLevel, "low");

  const { thinking, ...noThinking } = changed.orchestrator;
  const plain = JSON.parse(byPath(generateProject({ ...model, orchestrator: noThinking }, {}).files, ".pi/settings.json").content);
  assert.equal(plain.defaultThinkingLevel, undefined, "thinking omitted when undeclared");
});

test("each agent's own model, thinking and skills land in its frontmatter", () => {
  const withAgent = {
    ...model,
    agents: [{ name: "helper", model: "provider-b/model-small", thinking: "high", skills: ["notes"], tools: ["read"] }],
    skills: [{ name: "notes" }],
  };
  const agent = byPath(generateProject(withAgent, {}).files, ".pi/agents/helper.md").content;
  assert.match(agent, /^model: provider-b\/model-small$/m);
  assert.match(agent, /^thinking: high$/m);
  assert.match(agent, /^skills:\n  - notes$/m);
});

test("sourced skills generate no SKILL.md and packaged sources join runtime packages", () => {
  const sourced = {
    ...model,
    skills: [
      { name: "packaged", source: "npm:@acme/skills@1.0.0" },
      { name: "local", source: "./vendor/local" },
    ],
  };
  const { files } = generateProject(sourced, {}, {
    piPackages: ["npm:pi-subagents@0.83.1"],
  });
  assert.ok(!files.some((f) => f.path.startsWith(".pi/skills/packaged") || f.path.startsWith(".pi/skills/local")));
  const settings = JSON.parse(byPath(files, ".pi/settings.json").content);
  assert.deepEqual(settings.packages, ["npm:@acme/skills@1.0.0"]);
});

test("unrelated keys in .pi/mcp.json survive regeneration", () => {
  const existing = {
    ".pi/mcp.json": JSON.stringify({
      mcpServers: { stale: { url: "http://localhost:3003/mcp" } },
      extra: true,
    }),
  };

  const { files } = generateProject(withServer, existing);
  const mcp = JSON.parse(byPath(files, ".pi/mcp.json").content);

  assert.equal(mcp.extra, true, "non-capability key preserved");
  // system.yaml is authoritative: an undeclared server is dropped, not preserved.
  assert.deepEqual(Object.keys(mcp.mcpServers), ["openseo"], "undeclared server removed");
});

test("user edits to an authored file survive when the model is unchanged", () => {
  const first = generateProject(model, {});
  const original = byPath(first.files, ".pi/APPEND_SYSTEM.md").content;
  const userEdited = original.replace(model.orchestrator.prompt, "I added my own orchestrator instructions.\n");

  const { files } = generateProject(model, { ".pi/APPEND_SYSTEM.md": userEdited });
  const entry = byPath(files, ".pi/APPEND_SYSTEM.md");

  assert.equal(entry.action, "none");
  assert.equal(entry.content, userEdited);
});

test("user-authored files without a faur marker are never touched", () => {
  const existing = { "README.md": "# My own README\n\nHand written.\n" };

  const { files } = generateProject(model, existing);
  const entry = byPath(files, "README.md");

  assert.equal(entry.action, "none");
  assert.equal(entry.content, existing["README.md"]);
});

test("conflict when a user edits an authored file AND the model changes it", () => {
  const first = generateProject(model, {});
  const original = byPath(first.files, ".pi/APPEND_SYSTEM.md").content;
  const userEdited = original.replace(model.orchestrator.prompt, "User's own instructions.\n");

  const changedModel = {
    ...model,
    orchestrator: { ...model.orchestrator, prompt: "A new orchestrator prompt.\n" },
  };

  const { files } = generateProject(changedModel, { ".pi/APPEND_SYSTEM.md": userEdited });
  const entry = byPath(files, ".pi/APPEND_SYSTEM.md");

  assert.equal(entry.action, "conflict");
  assert.equal(entry.content, userEdited, "conflict must not overwrite");
  assert.equal(entry.desired, changedModel.orchestrator.prompt);
});

test("authored scaffold carries an faur marker and the scaffolded body", () => {
  const { files } = generateProject(model, {});
  const append = byPath(files, ".pi/APPEND_SYSTEM.md").content;
  assert.match(append, /^<!-- faur:generated v1 sha256=[0-9a-f]{64} -->\n/);
  assert.ok(append.indexOf(model.orchestrator.prompt) < append.indexOf("## What you can use"), "the authored prompt, then the derived section");
  assert.match(append, /<!-- faur:derived v1 begin[^\n]*-->\n## What you can use[\s\S]*\n<!-- faur:derived v1 end sha256=[0-9a-f]{64} -->\n$/);

  const gitignore = byPath(files, ".gitignore").content;
  assert.match(gitignore, /^# faur:generated v1 sha256=[0-9a-f]{64}\n/);
  assert.ok(gitignore.includes("data/"));
  assert.ok(gitignore.includes(".env\n"));
  assert.ok(gitignore.includes(".pi/state.json"));
  assert.ok(gitignore.includes(".pi/sessions/"));

  const readme = byPath(files, "README.md").content;
  assert.ok(readme.includes(`# ${model.name}`));
  assert.ok(readme.includes(model.description));
});

test("golden tree: minimal fixture produces the committed snapshot", () => {
  const goldenDir = resolve(fixtureRoot, "golden");
  const { files } = generateProject(withBaselineTools(model), {}, {
    piPackages: ["npm:pi-subagents@0.83.1", "npm:pi-web-access@0.27.0"],
    contextFiles: [],
  });

  const produced = new Map(files.map((f) => [f.path, f.content]));
  const goldenPaths = readdirSync(goldenDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      entry.parentPath === goldenDir
        ? entry.name
        : `${entry.parentPath.slice(goldenDir.length + 1)}/${entry.name}`,
    )
    .sort();

  assert.deepEqual([...produced.keys()].sort(), goldenPaths);
  for (const path of goldenPaths) {
    const expected = readFileSync(resolve(goldenDir, path), "utf-8");
    assert.equal(produced.get(path), expected, `golden mismatch: ${path}`);
  }
});

test("runtime packages are computed from piPackages + declared model packages", () => {
  const piPackages = [
    "npm:pi-subagents@0.83.1",
        "npm:pi-web-access@0.27.0",
  ];
  const withDeclared = generateProject(
    { ...model, packages: ["npm:foo@1.0.0"] },
    {},
    { piPackages },
  );
  const settings = JSON.parse(byPath(withDeclared.files, ".pi/settings.json").content);
  assert.deepEqual(settings.packages, ["npm:foo@1.0.0"]);

  const commands = generateProject({ ...withCommand, agents: [{ name: "w", model: "p/m", tools: ["read"] }] }, {}, { piPackages });
  assert.deepEqual(JSON.parse(byPath(commands.files, ".pi/settings.json").content).packages, [COMMANDS_PACKAGE, "npm:pi-subagents@0.83.1"]);
});

test("a primitive the caller does not pin takes this release's version", () => {
  const { files, errors } = generateProject({ ...model, agents: [{ name: "w", model: "p/m", tools: ["read"] }] }, {}, { piPackages: [] });
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(byPath(files, ".pi/settings.json").content).packages, ["npm:pi-subagents@0.83.1"]);
});

test("APPEND_SYSTEM.md: the derived section follows declarations; the authored prompt is never overwritten", () => {
  const first = byPath(generateProject(model, {}).files, ".pi/APPEND_SYSTEM.md").content;
  const edited = first.replace(model.orchestrator.prompt, "My own prompt.\n");
  const added = { ...model, orchestrator: { ...model.orchestrator, tools: [...model.orchestrator.tools, "bash"] } };
  const next = byPath(generateProject(added, { ".pi/APPEND_SYSTEM.md": edited }).files, ".pi/APPEND_SYSTEM.md");
  assert.equal(next.action, "write", "a capability change rewrites only the derived section");
  assert.match(next.content, /My own prompt\./);
  assert.match(next.content, /\*\*Built-in tools:\*\* read, grep, find, ls, bash/);
  assert.equal(byPath(generateProject(added, { ".pi/APPEND_SYSTEM.md": next.content }).files, ".pi/APPEND_SYSTEM.md").action, "none", "idempotent");

  const handEdited = first.replace("Use only what is listed here.", "Use anything.");
  const conflict = byPath(generateProject(added, { ".pi/APPEND_SYSTEM.md": handEdited }).files, ".pi/APPEND_SYSTEM.md");
  assert.equal(conflict.action, "conflict", "a hand edit of the derived section is reported, not overwritten");
  assert.equal(conflict.content, handEdited);
  assert.match(conflict.reason, /edited by hand/);
});

test("text after the generated section is never dropped", () => {
  const first = byPath(generateProject(model, {}).files, ".pi/APPEND_SYSTEM.md").content;
  const noted = `${first}\nMy note.\n`;
  assert.equal(byPath(generateProject(model, { ".pi/APPEND_SYSTEM.md": noted }).files, ".pi/APPEND_SYSTEM.md").action, "none", "kept while nothing changes");
  const added = { ...model, orchestrator: { ...model.orchestrator, tools: [...model.orchestrator.tools, "bash"] } };
  const entry = byPath(generateProject(added, { ".pi/APPEND_SYSTEM.md": noted }).files, ".pi/APPEND_SYSTEM.md");
  assert.equal(entry.action, "conflict");
  assert.equal(entry.content, noted);
  assert.match(entry.reason, /move it above the section/);
});

test("a hand-written APPEND_SYSTEM.md without Faur markers is left alone, with a warning", () => {
  const { files, warnings } = generateProject(model, { ".pi/APPEND_SYSTEM.md": "Mine.\n" });
  assert.equal(byPath(files, ".pi/APPEND_SYSTEM.md").action, "none");
  assert.ok(warnings.some((w) => w.includes("without Faur's generated section")));
});

test("generation never manages an existing run script", () => {
  const custom = "#!/bin/sh\necho developer\n";
  const { files } = generateProject(withServer, { run: custom });
  assert.ok(!files.some(f => f.path === "run"));
});

test("specialists leave launch mode to pi-subagents and do not generate isolated-home config", () => {
  const withAgents = { ...model, agents: [
    { name: "researcher", model: "provider-a/m", tools: ["read", "mcp:seo", "web_search"] },
    { name: "writer", model: "provider-a/m", tools: ["read", "write"] },
  ] };
  const config = ".faur/pi-home/extensions/subagent/config.json";
  const { files } = generateProject(withAgents, { [config]: '{"timeoutMs": 5}\n' });
  assert.equal(byPath(files, config), undefined);
  assert.doesNotMatch(byPath(files, ".pi/agents/researcher.md").content, /\nasync:/);
  assert.doesNotMatch(byPath(files, ".pi/agents/writer.md").content, /\nasync:/);
  assert.doesNotMatch(byPath(files, ".pi/APPEND_SYSTEM.md").content, /Running specialists/);
});

test("developer extension paths in agent files are not overwritten", () => {
  const doc = { ...model, agents: [{ name: "researcher", model: "provider-a/m", tools: ["read", "web_search"] }] };
  const path = ".pi/agents/researcher.md";
  const generated = byPath(generateProject(doc, {}).files, path).content;
  const edited = generated.replace("  - web_search", "  - ./.pi/extensions/web.ts\n  - web_search");
  assert.notEqual(edited, generated);
  const planned = byPath(generateProject(doc, { [path]: edited }).files, path);
  assert.equal(planned.content, edited);
  assert.notEqual(planned.action, "write");
});

test("existing gitignore gets only missing safety entries without changing user text", () => {
  const original = "# user rules\nnode_modules\n.env/\n.pi/sessions";
  const file = byPath(generateProject(model, { ".gitignore": original }).files, ".gitignore");
  assert.equal(file.action, "write");
  assert.equal(file.content, original + "\n# faur: required ignores\n.env\n.faur/\n.pi/state.json\n.pi/git/\n.pi/npm/\n");
  const again = byPath(generateProject(model, { ".gitignore": file.content }).files, ".gitignore");
  assert.equal(again.action, "none");
  assert.equal(again.content, file.content);
});

test("complete user gitignore stays byte-for-byte unchanged", () => {
  const original = "# hand-written\r\n.env\r\n.faur\r\n.pi/state.json\r\n.pi/sessions\r\n.pi/git\r\n.pi/npm/\r\n";
  const file = byPath(generateProject(model, { ".gitignore": original }).files, ".gitignore");
  assert.equal(file.action, "none");
  assert.equal(file.content, original);
});

test("edited scaffold gets safety entries appended without replacing edits", () => {
  const scaffold = byPath(generateProject(model, {}).files, ".gitignore").content;
  const edited = scaffold.replace('.faur/\n', '') + '# custom\n';
  const file = byPath(generateProject(model, { ".gitignore": edited }).files, ".gitignore");
  assert.equal(file.action, 'write');
  assert.equal(file.content, edited + '# faur: required ignores\n.faur/\n');
});
