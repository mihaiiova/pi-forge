import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimePackages, runtimeNeeds } from "../deps.mjs";

import { expectedForgePin as FORGE } from './version-helper.mjs';
const PI_PACKAGES = [
  "npm:pi-subagents@0.83.1",
  "npm:pi-web-access@0.27.0",
  "npm:yaml@2.8.3",
  "npm:@juicesharp/rpiv-ask-user-question@2.9.0",
  "npm:@lanlance/pi-btw@0.2.0",
];

test("runtimePackages emits the Forge pin and the subagent runtime, in order", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES);
  assert.deepEqual(packages, [FORGE, "npm:pi-subagents@0.83.1"]);
  assert.deepEqual(errors, []);
});

test("runtimePackages appends declared npm:/git: specs after the primitives", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES, ["npm:foo@1.2.3", "git:github.com/x/y@v1"]);
  assert.deepEqual(packages, [
    FORGE,
    "npm:pi-subagents@0.83.1",
    "npm:foo@1.2.3",
    "git:github.com/x/y@v1",
  ]);
  assert.deepEqual(errors, []);
});

test("runtimePackages never emits dev-only, web, local-path, or secret-shaped entries", () => {
  const hostile = [
    "npm:pi-subagents@0.83.1",
    "npm:pi-web-access@0.27.0",       // web tools — dev/ambient, not a primitive
    "npm:yaml@2.8.3",                  // forge dev dep
    "git:github.com/mihaiiova/pi-config@sha", // the old skill-leak pin
    "file:../../local",
    "link:../x",
    "/abs/path",
    "./rel/path",
    "GH_TOKEN=secret",
    "npm:@juicesharp/rpiv-ask-user-question@2.9.0",
  ];
  const { packages } = runtimePackages(hostile, []);
  assert.deepEqual(packages, [FORGE, "npm:pi-subagents@0.83.1"]);
});

test("a primitive the caller does not pin takes this release's own pin, never none", () => {
  const { packages, errors } = runtimePackages(["npm:pi-web-access@0.27.0"]);
  assert.deepEqual(packages, [FORGE, "npm:pi-subagents@0.83.1"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(runtimePackages(["npm:pi-subagents@0.80.0"]).packages, [FORGE, "npm:pi-subagents@0.80.0"], "the caller's pin wins");
});

test("runtimePackages pins only what the design needs", () => {
  assert.deepEqual(runtimePackages(PI_PACKAGES, [], { forge: false, subagents: false }).packages, []);
  assert.deepEqual(runtimePackages(PI_PACKAGES, ["npm:foo@1.0.0"], { forge: false, subagents: true }).packages, ["npm:pi-subagents@0.83.1", "npm:foo@1.0.0"]);
  assert.deepEqual(runtimePackages(PI_PACKAGES, ["npm:pi-subagents@0.83.1"], { forge: false, subagents: false }).packages, ["npm:pi-subagents@0.83.1"], "a declared pi-subagents is kept");
});

test("runtimeNeeds: the Forge runtime for commands, MCP approvals, a lead kept from MCP and workflows", () => {
  const lead = (tools, extra = {}) => runtimeNeeds({ orchestrator: { name: "l", tools }, ...extra });
  assert.deepEqual(lead(["read"]), { forge: false, subagents: false });
  assert.deepEqual(lead(["read", "subagent"]), { forge: false, subagents: true });
  assert.equal(lead(["read"], { agents: [{ name: "a" }] }).subagents, true);
  assert.equal(lead(["read", "cli:x"], { integrations: { cli: [{ name: "x", command: "echo" }] } }).forge, true);
  assert.equal(lead(["read", "mcp"], { integrations: { mcp: [{ name: "s", config: { url: "u" } }] } }).forge, false);
  assert.equal(lead(["read", "mcp"], { integrations: { mcp: [{ name: "s", config: { url: "u", approveTools: ["x"] } }] } }).forge, true);
  assert.equal(lead(["read"], { integrations: { mcp: [{ name: "s", config: { url: "u" } }] } }).forge, true, "a lead without mcp next to a server");
  assert.equal(lead(["read"], { workflows: [{ name: "w" }] }).forge, true);
});

test("pi-mcp-adapter is rejected: it would replace Pi's built-in MCP", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES, ["npm:pi-mcp-adapter@2.32.1"]);
  assert.deepEqual(packages, [FORGE, "npm:pi-subagents@0.83.1"]);
  assert.ok(errors.some((e) => e.includes("pi-mcp-adapter") && e.includes("built-in MCP")));
});

test("an unpinned declared spec is rejected", () => {
  const { errors } = runtimePackages(PI_PACKAGES, ["npm:foo", "git:github.com/x/y"]);
  assert.ok(errors.some((e) => e.includes("npm:foo") && e.includes("pinned")), "unpinned npm rejected");
  assert.ok(errors.some((e) => e.includes("git:github.com/x/y") && e.includes("pinned")), "unpinned git rejected");
});

test("a declared spec that conflicts with a pinned primitive is rejected", () => {
  const { packages, errors } = runtimePackages(PI_PACKAGES, ["npm:pi-subagents@0.60.0"]);
  assert.ok(!packages.includes("npm:pi-subagents@0.60.0"), "conflicting version not emitted");
  assert.ok(errors.some((e) => e.includes("conflicts")), "conflict reported");
});

test("runtimePackages output is deterministic", () => {
  const a = runtimePackages(PI_PACKAGES, ["npm:foo@1.0.0"]);
  const b = runtimePackages(PI_PACKAGES, ["npm:foo@1.0.0"]);
  assert.deepEqual(a, b);
});

test("runtimePackages tolerates empty inputs", () => {
  const { packages, errors } = runtimePackages(undefined, undefined);
  assert.deepEqual(packages, [FORGE, "npm:pi-subagents@0.83.1"]);
  assert.deepEqual(errors, []);
});
