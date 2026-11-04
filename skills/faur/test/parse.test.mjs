import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSystem } from "../parse.mjs";
import { loadYaml } from "../yaml-loader.mjs";

const realParse = loadYaml().parse;

test("parseSystem returns the document for valid YAML", () => {
  const doc = parseSystem(
    "schema: 1\nname: seo-agent-system\ndescription: A test system\n",
    realParse,
  );
  assert.deepEqual(doc, {
    schema: 1,
    name: "seo-agent-system",
    description: "A test system",
  });
});

test("parseSystem preserves nested structures and arrays", () => {
  const doc = parseSystem(
    "schema: 1\nname: demo\nagents:\n  - name: worker\n    model: openai/gpt-5\n    thinking: high\n    tools: [read, write]\n",
    realParse,
  );
  assert.equal(doc.agents[0].model, "openai/gpt-5");
  assert.equal(doc.agents[0].thinking, "high");
  assert.deepEqual(doc.agents[0].tools, ["read", "write"]);
});

test("parseSystem strips comments and keeps non-comment values", () => {
  const doc = parseSystem(
    "# leading comment\nschema: 1 # trailing comment\nname: demo\n",
    realParse,
  );
  assert.equal(doc.schema, 1);
  assert.equal(doc.name, "demo");
});

test("parseSystem throws on malformed YAML", () => {
  assert.throws(
    () => parseSystem("schema: 1\n  bad-indent: [unclosed\n", realParse),
    /./,
  );
});

test("parseSystem rejects non-string input", () => {
  assert.throws(() => parseSystem(42, realParse), TypeError);
  assert.throws(() => parseSystem(null, realParse), TypeError);
});
