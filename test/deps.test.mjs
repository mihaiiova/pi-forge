import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimePackages, runtimeNeeds, COMMANDS_PACKAGE } from "../src/deps.mjs";

const PI_PACKAGES = [
  "npm:pi-subagents@0.83.1",
  "npm:pi-web-access@0.27.0",
  "npm:yaml@2.8.3",
  "npm:@juicesharp/rpiv-ask-user-question@2.9.0",
  "npm:@lanlance/pi-btw@0.2.0",
];
const ALL = { commands: true, subagents: true };

test("runtimePackages never pins Faur; it pins the packages the design uses, in order", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES, [], ALL);
  assert.deepEqual(packages, [COMMANDS_PACKAGE, "npm:pi-subagents@0.83.1"]);
  assert.deepEqual(errors, []);
  assert.ok(!packages.some((p) => p.includes("faur")));
});

test("runtimePackages appends declared npm:/git: specs after the runtime packages", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES, ["npm:foo@1.2.3", "git:github.com/x/y@v1"]);
  assert.deepEqual(packages, ["npm:pi-subagents@0.83.1", "npm:foo@1.2.3", "git:github.com/x/y@v1"]);
  assert.deepEqual(errors, []);
});

test("runtimePackages never emits dev-only, web, local-path, or secret-shaped entries", () => {
  const hostile = [
    "npm:pi-subagents@0.83.1",
    "npm:pi-web-access@0.27.0",       // web tools — dev/ambient, not a primitive
    "npm:yaml@2.8.3",                  // faur dev dep
    "git:github.com/mihaiiova/pi-config@sha", // the old skill-leak pin
    "file:../../local",
    "link:../x",
    "/abs/path",
    "./rel/path",
    "GH_TOKEN=secret",
    "npm:@juicesharp/rpiv-ask-user-question@2.9.0",
  ];
  const { packages } = runtimePackages(hostile, []);
  assert.deepEqual(packages, ["npm:pi-subagents@0.83.1"]);
});

test("a primitive the caller does not pin takes this release's own pin, never none", () => {
  const { packages, errors } = runtimePackages(["npm:pi-web-access@0.27.0"]);
  assert.deepEqual(packages, ["npm:pi-subagents@0.83.1"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(runtimePackages(["npm:pi-subagents@0.80.0"]).packages, ["npm:pi-subagents@0.80.0"], "the caller's pin wins");
});

test("runtimePackages pins only what the design needs", () => {
  assert.deepEqual(runtimePackages(PI_PACKAGES, [], { subagents: false }).packages, []);
  assert.deepEqual(runtimePackages(PI_PACKAGES, ["npm:foo@1.0.0"], { commands: true, subagents: false }).packages, [COMMANDS_PACKAGE, "npm:foo@1.0.0"]);
  assert.deepEqual(runtimePackages(PI_PACKAGES, ["npm:pi-subagents@0.83.1"], { subagents: false }).packages, ["npm:pi-subagents@0.83.1"], "a declared pi-subagents is kept");
});

test("runtimeNeeds: pi-commands for commands and pi-subagents for specialists", () => {
  const lead = (tools, extra = {}) => runtimeNeeds({ orchestrator: { name: "l", tools }, ...extra });
  assert.deepEqual(lead(["read"]), { commands: false, subagents: false });
  assert.deepEqual(lead(["read", "subagent"]), { commands: false, subagents: true });
  assert.equal(lead(["read"], { agents: [{ name: "a" }] }).subagents, true);
  assert.equal(lead(["read", "cli:x"], { integrations: { cli: [{ name: "x", command: "echo" }] } }).commands, true);
  assert.deepEqual(lead(["read"], { integrations: { mcp: [{ name: "s", config: { url: "u" } }] } }), { commands: false, subagents: false }, "a lead without mcp needs no package: that rule is advisory");
  assert.deepEqual(lead(["read"], { skills: [{ name: "w" }] }), { commands: false, subagents: false }, "local skills run on Pi alone");
});

test("pi-mcp-adapter is rejected: it would replace Pi's built-in MCP", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES, ["npm:pi-mcp-adapter@2.32.1"]);
  assert.deepEqual(packages, ["npm:pi-subagents@0.83.1"]);
  assert.ok(errors.some((e) => e.includes("pi-mcp-adapter") && e.includes("built-in MCP")));
});

test("an unpinned declared spec is rejected", () => {
  const { errors } = runtimePackages(PI_PACKAGES, ["npm:foo", "git:github.com/x/y"]);
  assert.equal(errors.length, 2);
});

test("a declared pi-subagents that conflicts with the pinned primitive is rejected", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES, ["npm:pi-subagents@0.60.0"]);
  assert.deepEqual(packages, ["npm:pi-subagents@0.83.1"]);
  assert.ok(errors.some((e) => e.includes("conflicts")));
});

test("runtimePackages output is deterministic", () => {
  const a = runtimePackages(PI_PACKAGES, ["npm:foo@1.0.0"], ALL);
  const b = runtimePackages(PI_PACKAGES, ["npm:foo@1.0.0"], ALL);
  assert.deepEqual(a, b);
});

test("runtimePackages tolerates empty inputs", () => {
  const { packages, errors } = runtimePackages(undefined, undefined);
  assert.deepEqual(packages, ["npm:pi-subagents@0.83.1"]);
  assert.deepEqual(errors, []);
});
