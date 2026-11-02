#!/usr/bin/env node
/**
 * forge — the deterministic Pi Forge CLI (Node ESM).
 *
 * Commands:
 *   validate <dir>             parse + validate <dir>/.pi/system.yaml
 *   generate <dir> [--dry-run] materialize a Pi project from system.yaml
 *   discover [dir] [--cli <name>]...
                             print a read-only capability inventory as JSON;
                             probes only the CLIs named with --cli
 *   modify <dir> [--dry-run] [--yes]  diff project vs model, apply confirmed changes
 *   search-skills <query...>   search skills.sh (JSON)
 *   preview-skill <spec>       pin owner/repo@name, or show a skills: source
 *   import <dir>               reconstruct system.yaml from an existing project
 *   change <dir> --operations <file> [--dry-run] [--yes] declarative change batch
 *
 * Exit codes:
 *   0  valid / generated / discovered / modified / imported (reported conflicts do not fail)
 *   1  invalid, missing, or unparseable system.yaml; or an unknown command
 *
 * Generated sessions use /faur from the pinned Forge package, not
 * this development CLI or the user's globally installed Pi Forge.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve, dirname, basename, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseSystem } from "./parse.mjs";
import { validateSystem } from "./validate.mjs";
import { generateProject, managedPaths } from "./generate.mjs";
import { modifyPlan } from "./modify.mjs";
import { effectiveCapabilities, checkCapabilities } from "./capabilities.mjs";
import { indent, diffLines } from "./diff.mjs";
import { parseMcpFile, probeClis, scanSkills } from "./discover.mjs";
import { loadYaml } from "./yaml-loader.mjs";
import { importSystem } from "./import.mjs";
import { parseModelList, unavailableModelWarnings } from "./models.mjs";
import { vendoredSkills } from "./skill-sources.mjs";
import { registrySkills, installedDir, installRegistrySkill, searchSkills, previewRegistrySkill, resolveRegistrySkill } from "./registry-skills.mjs";
import { planChange, applyChange, withSkillPreviews } from './maintenance.mjs';
import { fingerprints, atomicWrite } from './maintenance-store.mjs';
import { checkAgent, loadProjectTools, connectMcp } from './check.mjs';
import { parsedModel } from './changes.mjs';
import { unmetSetup, installSetup } from './setup.mjs';
import { ensureSecretFiles, preflightSecretFiles } from './integration-secrets.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `Usage: forge <command> [options]

Commands:
  setup <dir> --yes          run unmet setup installs after explicit approval
  validate <dir>             validate <dir>/.pi/system.yaml against schema v1
  check-agent <dir> [--connect]
                             report effective capabilities (no model calls);
                             --connect starts configured MCP servers
  generate <dir> [--dry-run] generate the project from system.yaml
  discover [dir] [--cli <name>]...
                             print a read-only capability inventory as JSON;
                             probes only the CLIs named with --cli
  modify <dir> [--dry-run] [--yes]
                             diff project vs model and apply confirmed changes
  change <dir> --operations <json-file> [--dry-run] [--yes]
                             validate/preview a structured system.yaml change
  search-skills <query...>   search the open skills registry (skills.sh) as JSON
  preview-skill <owner/repo@name | source>
                             pin a skills.sh result to its current commit, or
                             read a pinned "skills:<owner>/<repo>/<dir>@<commit>"
                             source; prints the source, SKILL.md and files (JSON)
  import <dir>               reconstruct <dir>/.pi/system.yaml from an existing
                             Pi project (settings + detected agents/skills/MCP)

Exit codes:
  0  valid / generated / discovered / modified / imported
  1  invalid, missing, or unparseable input; or an unknown command
`;

function fail(message) {
  console.error(`error - ${message}`);
  process.exitCode = 1;
}

function printWarnings(warnings) {
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    console.error(`warning - ${warning}`);
  }
}

function failOnErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  for (const error of errors) console.error(`error - ${error}`);
  process.exitCode = 1;
  return true;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read, parse, and validate the model at `<dir>/.pi/system.yaml`. */
function loadModel(dir) {
  const systemPath = join(resolve(dir), ".pi", "system.yaml");

  let text;
  try {
    text = readFileSync(systemPath, "utf-8");
  } catch {
    return { systemPath, error: `no readable system.yaml at ${systemPath}` };
  }

  let doc;
  try {
    doc = parseSystem(text);
  } catch (err) {
    return { systemPath, error: `failed to parse ${systemPath}: ${err.message}` };
  }

  const { ok, errors } = validateSystem(doc);
  return { systemPath, normalized: doc, ok, errors };
}

/** The machine's Pi model line-up (`provider/id`), or [] when unavailable. */
function modelCatalog() {
  try {
    const out = execFileSync("pi", ["--list-models"], {
      encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"],
    });
    return parseModelList(out);
  } catch {
    return [];
  }
}

function warnUnavailableModels(model) {
  printWarnings(unavailableModelWarnings(model, modelCatalog()));
}

function expandHome(path) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Read a skill directory as binary-safe files; symlinks are refused. */
function readSkillDir(root, prefix = "") {
  const files = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlink ${rel} is not allowed`);
    if (entry.isDirectory()) Object.assign(files, readSkillDir(root, rel));
    else if (entry.isFile()) {
      const path = join(root, rel);
      files[rel] = { content: readFileSync(path), executable: (statSync(path).mode & 0o111) !== 0 };
    }
  }
  return files;
}

/**
 * Plan copies of user-supplied skill directories into `.pi/skills/<name>/`.
 * A copy is made once: an existing project copy is never overwritten.
 */
function vendorPlan(dir, model) {
  const root = resolve(dir);
  const copies = [];
  const errors = [];
  for (const skill of vendoredSkills(model)) {
    const dest = `.pi/skills/${skill.name}`;
    if (existsSync(join(root, dest))) continue;
    const from = resolve(root, expandHome(skill.source));
    const skillFile = join(from, "SKILL.md");
    if (!existsSync(skillFile)) {
      errors.push(`skill "${skill.name}" source ${skill.source} has no SKILL.md (resolved ${from})`);
      continue;
    }
    const declaredName = scanSkills({ [skillFile]: readFileSync(skillFile, "utf-8") })[0]?.name;
    if (declaredName !== skill.name) {
      errors.push(`skill "${skill.name}" source ${skill.source} declares name "${declaredName}"; the names must match`);
      continue;
    }
    try {
      copies.push({ name: skill.name, source: skill.source, dest, files: readSkillDir(from) });
    } catch (err) {
      errors.push(`skill "${skill.name}" source ${skill.source}: ${err.message}`);
    }
  }
  return { copies, errors };
}

/** Registry skills not yet installed in the project's `.agents/skills/`. */
function registryPlan(dir, model) {
  return registrySkills(model).filter((skill) => !existsSync(join(resolve(dir), installedDir(skill.name), "SKILL.md")));
}

function printRegistryPlan(skills) {
  for (const skill of skills) console.log(`  ${pad("install")} ${installedDir(skill.name)}/ (skills CLI, ${skill.source})`);
}

function applyRegistryPlan(dir, skills) {
  for (const skill of skills) {
    installRegistrySkill(resolve(dir), skill);
    console.log(`installed ${installedDir(skill.name)}/ from ${skill.source}`);
  }
}

function printVendorPlan(copies) {
  for (const copy of copies) {
    const count = Object.keys(copy.files).length;
    console.log(`  ${pad("vendor")} ${copy.dest}/ (${count} file${count === 1 ? "" : "s"} from ${copy.source})`);
  }
}

function applyVendorPlan(dir, copies) {
  for (const copy of copies) {
    for (const [rel, file] of Object.entries(copy.files)) {
      const target = join(resolve(dir), copy.dest, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
      if (file.executable) chmodSync(target, 0o755);
    }
    console.log(`vendored ${copy.dest}/ from ${copy.source}`);
  }
}

/** Context files plain Pi would load from the project and its parents (one per directory), which `./run` skips. */
function skippedContextFiles(dir) {
  const found = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"].map((name) => join(d, name)).find((path) => existsSync(path));
    if (file) found.push(relative(resolve(dir), file));
    if (dirname(d) === d) return found;
  }
}

function readExisting(dir, model) {
  const existing = {};
  for (const rel of managedPaths(model)) {
    const path = join(resolve(dir), rel);
    if (existsSync(path)) {
      try {
        existing[rel] = readFileSync(path, "utf-8");
      } catch {
        // unreadable — treat as absent
      }
    }
  }
  return existing;
}

function runValidate(dir) {
  const { systemPath, error, normalized, ok, errors } = loadModel(dir);
  if (error) {
    fail(error);
    return;
  }
  if (ok) {
    console.log(`ok - ${systemPath} is a valid system.yaml (schema v1)`);
    warnUnavailableModels(normalized);
    process.exitCode = 0;
  } else {
    for (const e of errors) console.error(`error - ${e}`);
    process.exitCode = 1;
  }
}

function listFiles(dir, predicate) {
  const out = [];
  const walk = (current) => {
    if (!existsSync(current)) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && predicate(entry.name, path)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function readMcpFile(path) {
  if (!existsSync(path)) return {};
  try {
    return parseMcpFile(readFileSync(path, "utf-8")).mcpServers;
  } catch {
    return {};
  }
}

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

function kebabName(name) {
  const kebab = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return kebab || "imported-system";
}

function detectAgents(dir) {
  const agents = [];
  for (const path of listFiles(join(dir, ".pi", "agents"), (name) => name.endsWith(".md"))) {
    let text;
    try { text = readFileSync(path, "utf-8"); } catch { continue; }
    const { frontmatter, body } = splitFrontmatter(text);
    let fm = {};
    if (frontmatter) {
      try { fm = parseSystem(frontmatter); } catch { fm = {}; }
    }
    if (!isObject(fm) || typeof fm.name !== "string" || !fm.name) continue;
    agents.push({
      name: fm.name,
      description: typeof fm.description === "string" ? fm.description : "",
      tools: Array.isArray(fm.tools) ? fm.tools : [],
      model: typeof fm.model === "string" ? fm.model : "",
      thinking: typeof fm.thinking === "string" ? fm.thinking : "",
      skills: Array.isArray(fm.skills)
        ? fm.skills
        : typeof fm.skills === "string" ? fm.skills.split(",").map((s) => s.trim()).filter(Boolean) : [],
      prompt: typeof fm.systemPrompt === "string" ? fm.systemPrompt : body,
    });
  }
  return agents;
}

function detectSkills(dir) {
  const skillFiles = {};
  for (const path of listFiles(join(dir, ".pi", "skills"), (name) => name === "SKILL.md")) {
    try { skillFiles[path] = readFileSync(path, "utf-8"); } catch { /* unreadable */ }
  }
  return scanSkills(skillFiles)
    .filter(skill => skill.name !== 'forge')
    .map(skill => ({ ...skill, source: `./${relative(resolve(dir), skill.dir)}` }));
}

function writeGenerated(targetPath, file) {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, file.content, "utf-8");
  if (file.executable === true) chmodSync(targetPath, 0o755);
}

function readPiPackages() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    return Array.isArray(pkg?.pi?.packages) ? pkg.pi.packages : [];
  } catch {
    return [];
  }
}

function runDiscover(dir, clis) {
  const target = resolve(dir ?? process.cwd());

  const mcpServers = {};
  for (const path of [
    join(homedir(), ".pi", "agent", "mcp.json"),
    join(homedir(), ".config", "mcp", "mcp.json"),
    join(target, ".mcp.json"),
    join(target, ".pi", "mcp.json"),
  ]) {
    Object.assign(mcpServers, readMcpFile(path));
  }

  // Only the user's own skills are candidates; the forge ships none.
  const skillFiles = {};
  for (const dir of [
    join(homedir(), ".pi", "agent", "skills"),
    join(target, ".pi", "skills"),
  ]) {
    for (const path of listFiles(dir, (name) => name === "SKILL.md")) {
      try {
        skillFiles[path] = readFileSync(path, "utf-8");
      } catch {
        // unreadable — skip
      }
    }
  }

  const subagents = listFiles(join(target, ".pi", "agents"), (name) => name.endsWith(".md"))
    .map((path) => basename(path, ".md"));

  const skills = scanSkills(skillFiles);
  const seenSkills = new Set();
  const dedupedSkills = skills.filter((skill) => {
    if (seenSkills.has(skill.dir)) return false;
    seenSkills.add(skill.dir);
    return true;
  });

  const inventory = {
    skills: dedupedSkills,
    mcpServers,
    clis: probeClis(clis),
    subagents,
    models: modelCatalog(),
  };

  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  process.exitCode = 0;
}

function pad(action) {
  return action.padEnd(9, " ");
}

function printPlan(systemPath, dir, files, existing, label) {
  console.log(`${label} for ${systemPath}:`);
  if (!existsSync(join(resolve(dir), ".pi", "agents"))) {
    console.log(`  ${pad("create")} .pi/agents/ (empty directory)`);
  }
  for (const f of files) {
    if (f.action === "none") continue;
    console.log(`  ${pad(f.action)} ${f.path}`);
    if (f.action === "create") {
      console.log(indent(f.content, "    + "));
    } else if (f.action === "write") {
      console.log(indent(f.diff ?? diffLines(existing[f.path] ?? "", f.content), "    "));
    } else if (f.action === "conflict") {
      console.log(f.reason ? `    (${f.reason})` : `    (user edit vs model change — proposed diff)`);
      console.log(indent(f.diff ?? diffLines(existing[f.path] ?? "", f.desired ?? ""), "    "));
    }
  }
}

function runGenerate(dir, dryRun) {
  const { systemPath, error, normalized, ok, errors } = loadModel(dir);
  if (error) {
    fail(error);
    return;
  }
  if (!ok) {
    for (const e of errors) console.error(`error - ${e}`);
    process.exitCode = 1;
    return;
  }

  const existing = readExisting(dir, normalized);
  const { files, warnings, errors: depErrors } = generateProject(normalized, existing, { piPackages: readPiPackages(), contextFiles: skippedContextFiles(dir) });
  const vendor = vendorPlan(dir, normalized);
  if (failOnErrors([...depErrors, ...vendor.errors])) return;
  printWarnings(warnings);
  warnUnavailableModels(normalized);
  const changes = files.filter((f) => f.action === "create" || f.action === "write");
  const conflicts = files.filter((f) => f.action === "conflict");

  if (dryRun) {
    printPlan(systemPath, dir, files, existing, "Planned changes (dry run — nothing written)");
    printVendorPlan(vendor.copies);
    printRegistryPlan(registryPlan(dir, normalized));
    process.exitCode = 0;
    return;
  }

  try { preflightSecretFiles(resolve(dir), normalized); } catch (error) { fail(error.message); return; }
  for (const f of changes) {
    const target = join(resolve(dir), f.path);
    writeGenerated(target, f);
    console.log(`wrote ${f.path} (${f.action})`);
  }
  try { ensureSecretFiles(resolve(dir), normalized); } catch (error) { fail(error.message); return; }
  applyVendorPlan(dir, vendor.copies);
  try { applyRegistryPlan(dir, registryPlan(dir, normalized)); } catch (err) { fail(err.message); return; }
  mkdirSync(join(resolve(dir), ".pi", "agents"), { recursive: true });

  // Write the deterministic effective-capability manifest and verify the
  // just-generated config matches the model (defense against drift).
  const settingsFile = files.find((f) => f.path === ".pi/settings.json");
  const mcpFile = files.find((f) => f.path === ".pi/mcp.json");
  const settingsJson = settingsFile ? JSON.parse(settingsFile.content) : {};
  const mcpJson = mcpFile ? JSON.parse(mcpFile.content) : {};
  const caps = effectiveCapabilities(normalized, { piPackages: readPiPackages() });
  mkdirSync(join(resolve(dir), ".forge"), { recursive: true });
  writeFileSync(join(resolve(dir), ".forge", "capabilities.json"), `${JSON.stringify(caps, null, 2)}\n`, "utf-8");
  const check = checkCapabilities(normalized, { settings: settingsJson, mcpJson }, { piPackages: readPiPackages() });
  for (const e of check.errors) console.error(`warning - ${e}`);

  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const fileFingerprints = fingerprints(resolve(dir), managedPaths(normalized));
  writeFileSync(join(resolve(dir), '.forge', 'build.json'), `${JSON.stringify({ version, fingerprints: fileFingerprints }, null, 2)}\n`);
  for (const c of conflicts) {
    console.error(`conflict - ${c.path}: user edit vs model change; not applied. Proposed:\n${c.desired}`);
  }
  process.exitCode = 0;
}

function runImport(dir) {
  const target = resolve(dir);
  const settingsPath = join(target, ".pi", "settings.json");

  let settings;
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { fail(`unreadable ${settingsPath}`); return; }
  }
  if (!settings) {
    fail(`no readable .pi/settings.json at ${target}`);
    return;
  }

  const detected = {
    name: kebabName(basename(target)),
    skills: detectSkills(target),
    agents: detectAgents(target),
    mcpServers: readMcpFile(join(target, ".pi", "mcp.json")),
  };

  const { system, report } = importSystem(settings, detected);

  // Fail before writing anything if runtime dependencies cannot be resolved.
  if (failOnErrors(generateProject(system, {}, { piPackages: readPiPackages() }).errors)) return;

  const systemPath = join(target, ".pi", "system.yaml");
  if (existsSync(systemPath)) {
    console.error(`error - ${systemPath} already exists; not overwriting (delete it first or run in a fresh project).`);
    process.exitCode = 1;
    return;
  }

  let yamlText;
  try {
    yamlText = loadYaml().stringify(system);
  } catch (err) {
    fail(`failed to serialize system.yaml: ${err.message}`);
    return;
  }

  mkdirSync(dirname(systemPath), { recursive: true });
  writeFileSync(systemPath, yamlText, "utf-8");
  console.log(`wrote .pi/system.yaml (imported: ${report.imported.join(", ")})`);

  // Conservative additive scaffolding: create missing native files only. Every
  // existing file is preserved; derived files are never regenerated here.
  const existing = readExisting(target, system);
  const { files } = generateProject(system, existing, { piPackages: readPiPackages() });
  for (const f of files) {
    if (f.action !== "create") continue;
    writeGenerated(join(target, f.path), f);
    console.log(`scaffolded ${f.path}`);
  }
  mkdirSync(join(target, ".pi", "agents"), { recursive: true });

  console.log('Import preserved existing configuration. Preview forge generate, then apply it to include package-based maintenance.');
  for (const flag of report.flagged) {
    console.error(`flagged - ${flag.key}: ${flag.reason}`);
  }
  process.exitCode = 0;
}

async function runModify(dir, dryRun, yes) {
  const { systemPath, error, normalized, ok, errors } = loadModel(dir);
  if (error) {
    fail(error);
    return;
  }
  if (!ok) {
    for (const e of errors) console.error(`error - ${e}`);
    process.exitCode = 1;
    return;
  }

  const existing = readExisting(dir, normalized);
  const { files, conflicts, warnings, errors: depErrors } = modifyPlan(normalized, existing, { piPackages: readPiPackages(), contextFiles: skippedContextFiles(dir) });
  const vendor = vendorPlan(dir, normalized);
  if (failOnErrors([...depErrors, ...vendor.errors])) return;
  printWarnings(warnings);
  warnUnavailableModels(normalized);
  const changes = files.filter((f) => f.action === "create" || f.action === "write");

  // Always preview the full planned diff before touching anything.
  printPlan(systemPath, dir, files, existing, dryRun
    ? "Planned changes (dry run — nothing written)"
    : "Preview of changes to apply");
  printVendorPlan(vendor.copies);
  const installs = registryPlan(dir, normalized);
  printRegistryPlan(installs);

  if (dryRun) {
    process.exitCode = 0;
    return;
  }

  if (!yes && !process.stdin.isTTY) {
    console.error("error - non-interactive without --yes: no changes applied (preview only). Use --dry-run or --yes.");
    process.exitCode = 0;
    return;
  }

  try { preflightSecretFiles(resolve(dir), normalized); } catch (error) { fail(error.message); return; }
  const apply = (f) => {
    const target = join(resolve(dir), f.path);
    writeGenerated(target, f);
    console.log(`wrote ${f.path} (${f.action})`);
  };

  if (yes) {
    for (const f of changes) apply(f);
    applyVendorPlan(dir, vendor.copies);
    try { applyRegistryPlan(dir, installs); } catch (err) { fail(err.message); return; }
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (const f of changes) {
      const answer = await new Promise(resolve => rl.question(`Apply ${f.path}? [y/N] `, resolve));
      if (/^y(es)?$/i.test(answer.trim())) apply(f);
      else console.log(`skipped ${f.path}`);
    }
    for (const copy of vendor.copies) {
      const answer = await new Promise(resolve => rl.question(`Vendor ${copy.dest}/ from ${copy.source}? [y/N] `, resolve));
      if (/^y(es)?$/i.test(answer.trim())) applyVendorPlan(dir, [copy]);
      else console.log(`skipped ${copy.dest}/`);
    }
    for (const skill of installs) {
      const answer = await new Promise(resolve => rl.question(`Install ${installedDir(skill.name)}/ from ${skill.source} with the skills CLI? [y/N] `, resolve));
      if (!/^y(es)?$/i.test(answer.trim())) { console.log(`skipped ${installedDir(skill.name)}/`); continue; }
      try { applyRegistryPlan(dir, [skill]); } catch (err) { console.error(`error - ${err.message}`); process.exitCode = 1; }
    }
    rl.close();
  }

  try { ensureSecretFiles(resolve(dir), normalized); } catch (error) { fail(error.message); return; }
  mkdirSync(join(resolve(dir), ".pi", "agents"), { recursive: true });

  for (const c of conflicts) {
    console.error(`conflict - ${c.path}: user edit vs model change; not applied. Proposed:\n${c.desired}`);
  }
  process.exitCode = 0;
}

async function main(argv) {
  const [command, dir, ...rest] = argv;
  const dryRun = rest.includes("--dry-run");

  if (command === "-h" || command === "--help" || command === undefined) {
    process.stdout.write(USAGE);
    process.exitCode = command === undefined ? 1 : 0;
    return;
  }

  if (command === 'setup') {
    if (!dir) { fail('missing <dir> argument'); return; }
    const root = resolve(dir);
    const model = parsedModel(readFileSync(join(root, '.pi/system.yaml'), 'utf8'));
    const steps = unmetSetup(root, model);
    for (const step of steps) console.log(`${step.owner}: ${step.description}\n  ${step.install}${step.needsRoot ? ' (run manually; needs root)' : ''}`);
    if (!steps.length) { console.log('No unmet setup steps.'); return; }
    if (!rest.includes('--yes')) { fail('setup needs explicit approval: rerun with --yes'); return; }
    const results = installSetup(root, model, steps);
    for (const result of results) console.log(`${result.description}: ${result.status}`);
    if (results.some(result => result.status === 'failed')) process.exitCode = 1;
    return;
  }

  if (command === 'check-agent') {
    if (!dir) { fail('missing <dir> argument'); return; }
    const root = resolve(dir);
    try { parsedModel(readFileSync(join(root, '.pi/system.yaml'), 'utf8')); }
    catch (error) { fail(error.message); return; }
    const connected = rest.includes('--connect') ? connectMcp(root) : null;
    const report = checkAgent(root, { toolCheck: await loadProjectTools(root), ...(connected?.servers ? { mcpServers: connected.servers } : {}) });
    if (connected?.trustSaved) { report.trustSaved = connected.trustSaved; atomicWrite(root, '.forge/check.json', `${JSON.stringify(report, null, 2)}\n`); }
    if (connected?.error) { report.ok = false; report.mcpDiagnostic = connected.error; atomicWrite(root, '.forge/check.json', `${JSON.stringify(report, null, 2)}\n`); }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "validate") {
    if (!dir) {
      fail("missing <dir> argument");
      process.stderr.write(USAGE);
      return;
    }
    runValidate(dir);
    return;
  }

  if (command === "generate") {
    if (!dir) {
      fail("missing <dir> argument");
      process.stderr.write(USAGE);
      return;
    }
    runGenerate(dir, dryRun);
    if (!dryRun && !process.exitCode) {
      const model = parsedModel(readFileSync(join(resolve(dir), '.pi/system.yaml'), 'utf8'));
      for (const step of unmetSetup(resolve(dir), model)) console.error(`warning - setup ${step.owner}: ${step.description}; fix: ${step.install}`);
    }
    return;
  }

  if (command === "discover") {
    // The forge knows no CLIs of its own: probe only those the user names.
    const args = argv.slice(1);
    const clis = [];
    let target;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--cli") {
        const name = args[++i];
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name ?? "")) {
          fail(`invalid --cli name: ${name ?? "(missing)"}`);
          return;
        }
        clis.push(name);
      } else if (target === undefined) target = args[i];
    }
    runDiscover(target, [...new Set(clis)]);
    return;
  }

  if (command === "modify") {
    if (!dir) {
      fail("missing <dir> argument");
      process.stderr.write(USAGE);
      return;
    }
    await runModify(dir, dryRun, rest.includes("--yes"));
    return;
  }

  if (command === 'change') {
    if (!dir) { fail('missing <dir> argument'); return; }
    const root = resolve(dir);
    const index = rest.indexOf('--operations');
    if (index < 0 || !rest[index + 1]) { fail('change requires --operations <json-file>'); return; }
    const plan = await withSkillPreviews(planChange(root, JSON.parse(readFileSync(rest[index + 1], 'utf8'))));
    console.log(JSON.stringify(plan.preview, null, 2));
    if (dryRun) { console.log('Dry run — nothing written.'); return; }
    let approved = rest.includes('--yes');
    if (!approved && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      approved = await new Promise(resolve => rl.question('Apply this maintenance proposal? [y/N] ', answer => resolve(/^y(es)?$/i.test(answer.trim()))));
      rl.close();
    }
    if (!approved) { console.log('Not approved — nothing written.'); return; }
    applyChange(root, plan, true);
    console.log('Applied. Restart ./run.');
    return;
  }

  if (command === "search-skills" || command === "preview-skill") {
    const args = [dir, ...rest].filter(Boolean);
    if (args.length === 0) { fail(`${command} requires ${command === "search-skills" ? "a query" : "a skills: source"}`); return; }
    try {
      const result = command === "search-skills" ? await searchSkills(args.join(" "))
        : args[0].startsWith("skills:") ? await previewRegistrySkill(args[0]) : await resolveRegistrySkill(args[0]);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) { fail(err.message); }
    return;
  }

  if (command === "import") {
    if (!dir) {
      fail("missing <dir> argument");
      process.stderr.write(USAGE);
      return;
    }
    runImport(dir);
    return;
  }

  fail(`unknown command "${command}"`);
  process.stderr.write(USAGE);
}

main(process.argv.slice(2)).catch(error => fail(error.message));
