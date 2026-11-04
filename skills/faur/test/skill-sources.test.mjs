import { test } from "node:test";
import assert from "node:assert/strict";
import { skillSourceKind, authoredSkills, vendoredSkills, declaredPackages } from "../skill-sources.mjs";

const model = {
  packages: ["npm:extra@1.0.0"],
  skills: [
    { name: "inline", body: "# Inline" },
    { name: "workflow" },
    { name: "packaged", source: "npm:@acme/skills@2.0.0" },
    { name: "from-git", source: "git:github.com/acme/skills@v3" },
    { name: "local", source: "./my-skills/local" },
    { name: "dup", source: "npm:extra@1.0.0" },
  ],
};

test("skillSourceKind distinguishes pinned packages from directory paths", () => {
  assert.equal(skillSourceKind("npm:x@1.0.0"), "package");
  assert.equal(skillSourceKind("git:github.com/a/b@main"), "package");
  for (const p of ["./x", "../x", "/x", "~/x"]) assert.equal(skillSourceKind(p), "path", p);
  for (const bad of ["npm:x", "x", "", undefined]) assert.equal(skillSourceKind(bad), null, String(bad));
});

test("authoredSkills are the ones without a source", () => {
  assert.deepEqual(authoredSkills(model).map((s) => s.name), ["inline", "workflow"]);
});

test("vendoredSkills are the directory-sourced ones", () => {
  assert.deepEqual(vendoredSkills(model).map((s) => s.name), ["local"]);
});

test("declaredPackages appends packaged skill sources to explicit packages, deduplicated", () => {
  assert.deepEqual(declaredPackages(model), [
    "npm:extra@1.0.0",
    "npm:@acme/skills@2.0.0",
    "git:github.com/acme/skills@v3",
  ]);
  assert.deepEqual(declaredPackages({}), []);
});
