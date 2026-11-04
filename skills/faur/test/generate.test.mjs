import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSystem } from "../parse.mjs";
import { generateProject } from "../generate.mjs";
import { COMMANDS_PACKAGE, PERMISSIONS_PACKAGE } from "../deps.mjs";

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
  const approving = { ...model, orchestrator: { ...model.orchestrator, tools: [...model.orchestrator.tools, "mcp"] }, integrations: { mcp: [{ name: "seo", config: { url: "http://localhost:3002/mcp", approveTools: ["run_*"] } }] } };
  assert.deepEqual(pins(approving), [PERMISSIONS_PACKAGE], "approveTools comes from pi-permission-system");
  assert.deepEqual(pins(withServer), [], "a lead without mcp is advisory: no package");
  assert.deepEqual(pins({ ...model, workflows: [{ name: "w", entry: "helper" }] }), [], "workflows are skills Pi runs itself");
  assert.deepEqual(pins({ ...model, orchestrator: { ...model.orchestrator, tools: [...model.orchestrator.tools, "subagent"] } }), ["npm:pi-subagents@0.83.1"], "subagent alone pins pi-subagents at this release's version");
  for (const m of [model, withCommand, approving, withServer]) assert.ok(!pins(m).some((p) => p.includes("faur")));
});

test("the runtime packages get their native configuration, generated from the design", () => {
  const commands = JSON.parse(byPath(generateProject(withCommand, {}).files, ".pi/commands.json").content);
  assert.deepEqual(commands, { commands: [{ name: "hello", command: "echo", args: ["hi"], approve: true, lead: true }] });
  const approving = { ...model, integrations: { mcp: [{ name: "seo", config: { url: "u", approveTools: ["run_*", "publish"] } }, { name: "all", config: { url: "v", approveTools: true } }] } };
  const permissions = JSON.parse(byPath(generateProject(approving, {}).files, ".pi/extensions/pi-permission-system/config.json").content);
  assert.deepEqual(permissions, { permission: { "*": "allow", mcp: { "*": "allow", "seo:run_*": "ask", "seo:publish": "ask", "all:*": "ask" } } });
  const paths = generateProject(model, {}).files.map((f) => f.path);
  assert.ok(!paths.includes(".pi/commands.json") && !paths.some((p) => p.includes("pi-permission-system")), "nothing without the declarations");
  const readme = byPath(generateProject({ ...withCommand, integrations: { ...withCommand.integrations, mcp: approving.integrations.mcp } }, {}).files, "README.md").content;
  assert.match(readme, /Declared commands run without a shell.*\(pi-commands, `git:github\.com\/mihaiiova\/pi-commands@v0\.1\.0`\)/);
  assert.match(readme, /MCP `seo` tools matching `run_\*` ask before each call and are refused without a UI \(pi-permission-system, `npm:@gotgenes\/pi-permission-system@42\.0\.0`\)/);
  assert.match(byPath(generateProject(withServer, {}).files, "README.md").content, /### Advisory[\s\S]*`helper` is told it has no MCP tools; it is not prevented from calling them/);
});

test("files a design does not use are not generated", () => {
  const paths = (m) => generateProject(m, {}).files.map((f) => f.path);
  assert.ok(!paths(model).includes(".pi/mcp.json") && !paths(model).includes(".env.example"));
  assert.ok(paths(withServer).includes(".pi/mcp.json"));
  assert.ok(paths({ ...model, integrations: { env: [{ name: "TOKEN" }] } }).includes(".env.example"));
  assert.ok(!paths(model).includes("run"), "plain pi starts a design that does not depend on built-in MCP");
  assert.ok(paths(withServer).includes("run"), "a design with MCP servers gets the isolating launcher");
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
    skills: [{ name: "notes", body: "# Notes" }],
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
  const { files } = generateProject(model, {}, {
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

test("generateProject emits the executable run launcher for a design with MCP servers", () => {
  const { files } = generateProject(withServer, {});
  const run = byPath(files, "run");
  assert.ok(run, "run launcher is emitted");
  assert.equal(run.executable, true, "run launcher is marked executable");
  assert.match(run.content, /PI_CODING_AGENT_DIR/);
  assert.match(run.content, /exec pi/);
});

test("MCP and extension specialists run in the background; builtin-only ones do not", () => {
  const withAgents = {
    ...model,
    agents: [
      { name: "researcher", model: "provider-a/m", tools: ["read", "mcp:seo", "web_search"] },
      { name: "writer", model: "provider-a/m", tools: ["read", "write"] },
    ],
  };
  const { files } = generateProject(withAgents, { ".faur/pi-home/extensions/subagent/config.json": '{"timeoutMs": 5}\n' });
  assert.match(byPath(files, ".pi/agents/researcher.md").content, /\nasync: true\n/);
  assert.doesNotMatch(byPath(files, ".pi/agents/writer.md").content, /async:/);
  const config = byPath(files, ".faur/pi-home/extensions/subagent/config.json");
  assert.deepEqual(JSON.parse(config.content), { timeoutMs: 5, forceTopLevelAsync: true });
  assert.match(byPath(files, ".pi/APPEND_SYSTEM.md").content, /`researcher` use MCP or extension tools/);

  // Builtin-only systems keep their files exactly as before.
  const plain = generateProject({ ...model, agents: [withAgents.agents[1]] }, {}).files;
  assert.equal(byPath(plain, ".faur/pi-home/extensions/subagent/config.json"), undefined);
  assert.doesNotMatch(byPath(plain, ".pi/APPEND_SYSTEM.md").content, /Running specialists/);
});

test("agreed document formats land in their writer's instructions", () => {
  const documents = [
    { name: "decisions", path: "strategy/decisions.md", writer: model.orchestrator.name, purpose: "Owner decisions", maxWords: 600,
      sections: [{ heading: "Decide now", guide: "Yes/no questions" }, { heading: "Actions" }], rules: ["Caveats only in the last section"] },
    { name: "evidence-packet", writer: "writer", sections: [{ heading: "Findings" }] },
  ];
  const withDocs = { ...model, agents: [{ name: "writer", model: "provider-a/m", tools: ["read"], prompt: "Research." }], documents };
  const { files } = generateProject(withDocs, {});
  const lead = byPath(files, ".pi/APPEND_SYSTEM.md").content;
  assert.match(lead, /## Document formats/);
  assert.match(lead, /### decisions → `strategy\/decisions.md`/);
  assert.match(lead, /Length: at most 600 words\./);
  assert.match(lead, /1\. \*\*Decide now\*\* — Yes\/no questions\n2\. \*\*Actions\*\*/);
  assert.match(lead, /- Caveats only in the last section/);
  assert.doesNotMatch(lead, /evidence-packet/);
  const writer = byPath(files, ".pi/agents/writer.md").content;
  assert.match(writer, /  Research\.\n  \n  ## What you can use\n[\s\S]*## Document formats/);
  assert.match(writer, /### evidence-packet \(returned in your output\)/);
});

test("document delivery targets are rendered as steps for the writer", () => {
  const documents = [{ name: "article", path: "drafts/article.md", writer: "writer", sections: [{ heading: "Body" }],
    deliver: [{ mcp: "gdrive", tool: "create_file", with: { folder: "Owlie/Articles" } }, { mcp: "slack", tool: "post_message", note: "link only" }] }];
  const withDocs = { ...model, agents: [{ name: "writer", model: "provider-a/m", tools: ["write", "mcp:gdrive/create_file", "mcp:slack/post_message"] }], documents };
  const writer = byPath(generateProject(withDocs, {}).files, ".pi/agents/writer.md").content;
  assert.match(writer, /When the file is written, also deliver it:/);
  assert.match(writer, /- MCP server `gdrive`, tool `create_file` with \{"folder":"Owlie\/Articles"\}/);
  assert.match(writer, /- MCP server `slack`, tool `post_message` — link only/);
  assert.match(writer, /Report where each delivery landed/);
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

test('README lists each workflow as the headless skill command, for the launcher in use', () => {
  const workflows = [{ name: 'daily-report', entry: model.orchestrator.name }, { name: 'weekly', skill: 'summarize', entry: model.orchestrator.name }];
  const plain = byPath(generateProject({ ...model, workflows }, {}).files, 'README.md').content;
  assert.match(plain, /^pi --approve -p "\/skill:daily-report <request>"$/m);
  assert.match(plain, /^pi --approve -p "\/skill:summarize <request>"$/m, 'a declared skill is the one invoked');
  assert.match(plain, /exit code reports the run, not whether the task succeeded/);
  assert.match(plain, /a call that asks the user is refused in a headless run/);
  assert.doesNotMatch(plain, /--workflow|--timeout|systemd/);
  const isolated = byPath(generateProject({ ...withServer, workflows }, {}).files, 'README.md').content;
  assert.match(isolated, /^\.\/run --approve -p "\/skill:daily-report <request>"$/m);
});

test('a workflow without a skill gets one named after it', () => {
  const { files } = generateProject({ ...model, workflows: [{ name: 'daily-report', description: 'Report', entry: model.orchestrator.name }] }, {});
  const skill = byPath(files, '.pi/skills/daily-report/SKILL.md').content;
  assert.match(skill, /^---\nname: daily-report\ndescription: "Report"\n---/);
  assert.match(skill, /## Boundary[\s\S]*Entry: helper/);
});
