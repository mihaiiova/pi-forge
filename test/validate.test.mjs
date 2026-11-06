import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSystem } from "../src/validate.mjs";

function validDoc(overrides = {}) {
  return {
    schema: 1,
    name: "seo-agent-system",
    description: "SEO analysis + drafting",
    orchestrator: {
      name: "orchestrator",
      description: "Primary agent",
      prompt: "Coordinate the system.",
      model: "provider-a/model-large",
      thinking: "medium",
      tools: ["read", "grep", "bash", "subagent"],
    },
    agents: [
      { name: "seo-analyst", description: "Analyzes SEO", tools: ["read"], model: "provider-b/model-small", skills: ["analyze-and-draft"], prompt: "Analyze." },
      { name: "article-writer", tools: ["write"], model: "provider-a/model-medium", thinking: "high" },
    ],
    skills: [
      { name: "analyze-and-draft", description: "Skill" },
    ],
    integrations: {
      mcp: [{ name: "openseo", config: { url: "http://localhost:3002/mcp" } }],
      env: [{ name: "OPENSEO_URL", secret: false }],
    },
    policies: {
      enforced: [
        { agent: "seo-analyst", tools: ["read"] },
        { mcp: "openseo", hide: ["publish_*"] },
      ],
      advisory: ["Publishing requires human confirmation"],
    },
    ...overrides,
  };
}

test("validateSystem accepts a valid document", () => {
  assert.deepEqual(validateSystem(validDoc()), { ok: true, errors: [] });
});

test("validateSystem rejects a non-object document", () => {
  const { ok, errors } = validateSystem("just a string");
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("mapping")));
});

test("validateSystem rejects unknown top-level and nested keys", () => {
  const { errors } = validateSystem(
    validDoc({ bogus: true, orchestrator: { name: "orchestrator", model: "provider-a/model-large", extra: 1 } }),
  );
  assert.ok(errors.some((e) => e.includes('unknown key "bogus"')));
  assert.ok(errors.some((e) => e.includes('document.orchestrator has unknown key "extra"')));
});

test("validateSystem rejects a missing/invalid schema", () => {
  const { errors } = validateSystem(validDoc({ schema: undefined }));
  assert.ok(errors.some((e) => e.includes("document.schema is required")));
  const newer = validateSystem(validDoc({ schema: 2 }));
  assert.ok(newer.errors.some((e) => e.includes("document.schema must be 1")));
});

test("validateSystem rejects a non-kebab-case name", () => {
  const { errors } = validateSystem(validDoc({ name: "Bad_Name" }));
  assert.ok(errors.some((e) => e.includes("kebab-case")));
});

test("validateSystem rejects the retired models/tiers block", () => {
  const { errors } = validateSystem(validDoc({ models: { tiers: {} } }));
  assert.ok(errors.some((e) => e.includes('document has unknown key "models"')));
});

test("validateSystem requires every agent to name a provider/id model", () => {
  const missing = validateSystem(validDoc({ orchestrator: { name: "orchestrator" } }));
  assert.ok(missing.errors.some((e) => e.includes("document.orchestrator.model is required")));

  const doc = validDoc();
  doc.agents[0].model = "high";
  const { errors } = validateSystem(doc);
  assert.ok(errors.some((e) => e.includes('document.agents[0].model must be a "provider/id" model reference (got "high")')));
});

test("validateSystem accepts any provider/id model with no catalog lookup", () => {
  const doc = validDoc();
  doc.agents[0].model = "openrouter/anthropic/some-model";
  assert.deepEqual(validateSystem(doc), { ok: true, errors: [] });
});

test("validateSystem rejects an unknown thinking level", () => {
  const doc = validDoc();
  doc.agents[1].thinking = "extreme";
  const { errors } = validateSystem(doc);
  assert.ok(errors.some((e) => e.includes("document.agents[1].thinking must be one of off, minimal, low, medium, high, xhigh, max")));
});

test("validateSystem rejects an agent skill that is not declared", () => {
  const doc = validDoc();
  doc.agents[0].skills = ["analyze-and-draft", "ghost-skill"];
  const { errors } = validateSystem(doc);
  assert.ok(errors.some((e) => e.includes('document.agents[0].skills[1] references "ghost-skill"')));
});

test("validateSystem accepts package and path skill sources and rejects others", () => {
  for (const source of ["npm:@acme/skills@1.2.3", "git:github.com/acme/skills@v1", "./skills/x", "../shared/x", "/abs/x", "~/skills/x"]) {
    const doc = validDoc();
    doc.skills.push({ name: "extra", source });
    assert.deepEqual(validateSystem(doc), { ok: true, errors: [] }, source);
  }
  for (const source of ["npm:unpinned", "skills/x", "https://example.com/x"]) {
    const doc = validDoc();
    doc.skills.push({ name: "extra", source });
    assert.ok(validateSystem(doc).errors.some((e) => e.includes("document.skills[1].source must be")), source);
  }
  const both = validDoc();
  both.skills.push({ name: "extra", source: "./x", body: "inline" });
  assert.ok(validateSystem(both).errors.some((e) => e.includes('unknown key "body"')));
});

test("validateSystem rejects an incompatible policy (undeclared mcp)", () => {
  const doc = validDoc();
  doc.policies.enforced = [{ mcp: "not-there", hide: ["x"] }];
  const { errors } = validateSystem(doc);
  assert.ok(errors.some((e) => e.includes('policies.enforced[0].mcp references "not-there"')));
});

test("validateSystem rejects duplicate agent names", () => {
  const doc = validDoc();
  doc.agents.push({ name: "seo-analyst", model: "provider-b/model-small" });
  const { errors } = validateSystem(doc);
  assert.ok(errors.some((e) => e.includes('duplicates name "seo-analyst"')));
});

test("validateSystem rejects a policy rule with neither agent nor mcp", () => {
  const doc = validDoc();
  doc.policies.enforced = [{ tools: ["read"] }];
  const { errors } = validateSystem(doc);
  assert.ok(errors.some((e) => e.includes('exactly one of "agent" or "mcp"')));
});

test("validateSystem rejects duplicate enforced rules for the same agent or mcp", () => {
  const doc = validDoc();
  doc.policies.enforced.push({ agent: "seo-analyst", tools: ["read", "write"] });
  const { errors } = validateSystem(doc);
  assert.ok(errors.some((e) => e.includes("duplicate agent rule")), "duplicate agent rule rejected");

  const doc2 = validDoc();
  doc2.policies.enforced.push({ mcp: "openseo", hide: ["delete_*"] });
  const errors2 = validateSystem(doc2).errors;
  assert.ok(errors2.some((e) => e.includes("duplicate mcp rule")), "duplicate mcp rule rejected");
});

test("validateSystem accepts declared npm:/git: packages and rejects bad specs", () => {
  const ok = validateSystem(validDoc({ packages: ["npm:foo@1.0.0", "git:github.com/x/y@v1"] }));
  assert.deepEqual(ok, { ok: true, errors: [] });

  for (const bad of [
    ["file:../../local"],
    ["GH_TOKEN=secret"],
    ["not-a-package"],
    "not-an-array",
  ]) {
    const { ok: valid, errors } = validateSystem(validDoc({ packages: bad }));
    assert.equal(valid, false, `should reject ${JSON.stringify(bad)}`);
    assert.ok(errors.some((e) => e.includes("document.packages")), `error names packages: ${errors.join("; ")}`);
  }
});

test("validateSystem requires shell-safe, non-reserved env names", () => {
  const withEnv = (name) => {
    const doc = validDoc();
    doc.integrations = { ...doc.integrations, env: [{ name, secret: true }] };
    return doc;
  };
  assert.equal(validateSystem(withEnv("GITHUB_PAT")).ok, true);
  assert.equal(validateSystem(withEnv("PI_API_KEY")).ok, true);
  for (const name of ["1TOKEN", "MY-TOKEN", "A B"]) {
    assert.ok(validateSystem(withEnv(name)).errors.some((e) => /shell variable name/.test(e)), name);
  }
  for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "https_proxy", "PI_CODING_AGENT_DIR", "BASH_ENV", "faur_line"]) {
    assert.ok(validateSystem(withEnv(name)).errors.some((e) => /is reserved/.test(e)), name);
  }
});

test("validateSystem rejects tools that ask the user in a background subagent", () => {
  const base = validDoc();
  const withMcp = (config, agentTools, enforced = base.policies.enforced) => validateSystem(validDoc({
    agents: [...base.agents, { name: "researcher", model: "provider-a/m", tools: agentTools }],
    integrations: { ...base.integrations, mcp: [{ name: "openseo", config: { url: "http://localhost:3002/mcp", ...config } }] },
    policies: { ...base.policies, enforced },
  })).errors;
  assert.ok(withMcp({ approveTools: true }, ["mcp:openseo"]).some((e) => e.includes("config.approveTools is no longer supported")));
  assert.ok(withMcp({ approveTools: ["run_*"] }, ["read"]).some((e) => e.includes("config.approveTools is no longer supported")));
  assert.deepEqual(withMcp({ includeTools: ["get_report"] }, ["mcp:openseo/get_report"]), []);

  const cli = validateSystem(validDoc({
    agents: [...base.agents, { name: "filer", model: "provider-a/m", tools: ["cli:file-issue", "cli:list-issues"] }],
    integrations: { ...base.integrations, cli: [
      { name: "file-issue", description: "File", command: "gh", args: ["issue", "create"] },
      { name: "list-issues", description: "List", command: "gh", args: ["issue", "list"], approve: false },
    ] },
  })).errors;
  assert.equal(cli.length, 1);
  assert.match(cli[0], /"filer" may run in the background, .*: command file-issue\./, "a command that asks, not one that doesn't");

});

test("validateSystem rejects MCP exposure keys: Faur derives them", () => {
  const base = validDoc();
  const { errors } = validateSystem(validDoc({
    integrations: { ...base.integrations, mcp: [{ name: "openseo", config: { url: "http://localhost:3002/mcp", exposure: "codemode", toolExposure: { "*": "direct" } } }] },
  }));
  assert.ok(errors.some((e) => e.includes("config.exposure is set by Faur")));
  assert.ok(errors.some((e) => e.includes("config.toolExposure is set by Faur")));
});
