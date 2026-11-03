/**
 * capabilities — the deterministic effective-capability manifest for a
 * generated system, plus a consistency check against generated config.
 *
 * Pure module. `effectiveCapabilities(model)` derives the intended runtime
 * surface solely from `system.yaml` (orchestrator/subagent tools, skills, MCP
 * servers + exclusions, packages). `checkCapabilities(model, generated)`
 * verifies that generated `.pi/settings.json` + `.pi/mcp.json` match the
 * model. Subagent `tools:` allowlists are enforced by pi-subagents (a child
 * literally lacks unlisted tools); extension-provided tools are enforced by Pi
 * at runtime and are not assertable without a running process — the manifest
 * states this instead of claiming they are absent.
 */
import { enforcedAgentTools } from "./policy.mjs";
import { runtimePackages, runtimeNeeds } from "./deps.mjs";
import { declaredPackages, skillSourceKind } from "./skill-sources.mjs";
import { splitModelRef } from "./models.mjs";
import { needsBackground } from "./generate.mjs";
import { cliAgents, cliEntries, cliRef } from "./cli-tools.mjs";
import { mcpFromIntegrations } from "./mcp-gen.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortUnique(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((v) => typeof v === "string"))].sort();
}

function arraysEqual(a, b) {
  const x = sortUnique(a);
  const y = sortUnique(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * @param {object} model the validated `system.yaml` document.
 * @param {object} [opts] `{ piPackages?: string[] }` for pinned runtime packages.
 * @returns {object} the intended capability surface.
 */
export function effectiveCapabilities(model, opts = {}) {
  const orchestrator = isPlainObject(model.orchestrator) ? model.orchestrator : {};
  const integrations = isPlainObject(model.integrations) ? model.integrations : {};
  const mcpList = Array.isArray(integrations.mcp) ? integrations.mcp : [];

  const declared = declaredPackages(model);
  const { packages } = runtimePackages(opts?.piPackages, declared, runtimeNeeds(model));

  return {
    schema: model?.schema,
    name: model?.name,
    orchestratorModel: orchestrator.model,
    orchestratorTools: sortUnique(orchestrator.tools),
    agents: (Array.isArray(model.agents) ? model.agents : []).map((agent) => ({
      name: agent.name,
      tools: sortUnique(enforcedAgentTools(agent.name, model.policies, agent.tools)),
      model: agent.model,
      ...(typeof agent.thinking === "string" ? { thinking: agent.thinking } : {}),
      skills: sortUnique(agent.skills),
      ...(needsBackground(enforcedAgentTools(agent.name, model.policies, agent.tools)) ? { launch: "background" } : {}),
    })),
    documents: (Array.isArray(model.documents) ? model.documents : []).map((d) => ({
      name: d.name, writer: d.writer, ...(d.path ? { path: d.path } : {}),
    })),
    skills: (Array.isArray(model.skills) ? model.skills : []).map((skill) => ({
      name: skill.name,
      source: skillSourceKind(skill.source) ?? "authored",
    })),
    // Declared command shapes and who may run them (enforced: pi-commands
    // registers lead commands only in the lead, and the subagent allowlists
    // pick theirs).
    commands: cliEntries(model).map((entry) => ({
      name: entry.name,
      command: [entry.command, ...(entry.args ?? [])].join(" "),
      approve: entry.approve !== false,
      agents: cliAgents(model, entry.name, (agent) => enforcedAgentTools(agent.name, model.policies, agent.tools)),
    })),
    // How each server's tools reach agents: exposure and per-tool overrides.
    mcpServers: Object.entries(mcpFromIntegrations(mcpList, model?.policies)).map(([name, server]) => ({
      name,
      exposure: server.exposure,
      ...(server.toolExposure ? { toolExposure: server.toolExposure } : {}),
    })),
    packages,
    // Declared package specs (npm:/git:) may register extension-provided
    // tools; their concrete tool surface is enforced by Pi at runtime and is
    // not assertable here (see notes).
    extensions: [...declared].sort(),
    maintenance: {
      command: '/faur',
      proposalTool: 'forge_plan (hidden outside a direct maintenance request)',
      applicationAuthority: 'direct user command plus interactive confirmation',
      operationalToolExpansion: false,
      dependencies: "Faur installed in the developer's Pi; the project pins no Faur package",
    },
    notes: [
      "subagent tools are enforced by pi-subagents allowlists (a child lacks unlisted tools)",
      "orchestrator defaultTools bounds built-in tools; extension- and MCP-provided tools are enforced by Pi at runtime and are not assertable without a running process",
    ],
  };
}

/**
 * Verify generated `.pi/settings.json` + `.pi/mcp.json` match the model.
 *
 * @param {object} model the validated `system.yaml` document.
 * @param {object} generated `{ settings, mcpJson }` parsed JSON.
 * @param {object} [opts] `{ piPackages?: string[] }`.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkCapabilities(model, generated, opts = {}) {
  const errors = [];
  const caps = effectiveCapabilities(model, opts);
  const settings = isPlainObject(generated?.settings) ? generated.settings : {};
  const mcp = isPlainObject(generated?.mcpJson) ? generated.mcpJson : {};

  const { provider, id } = splitModelRef(caps.orchestratorModel);
  if (settings.defaultProvider !== provider || settings.defaultModel !== id) {
    errors.push(
      `settings default model mismatch: expected ${caps.orchestratorModel} got ` +
        `${settings.defaultProvider}/${settings.defaultModel}`,
    );
  }

  const actualTools = sortUnique(settings.defaultTools);
  if (!arraysEqual(caps.orchestratorTools.filter((tool) => !cliRef(tool) && tool !== "mcp" && !tool.startsWith("mcp:")), actualTools)) {
    errors.push(
      `settings.defaultTools mismatch: expected [${caps.orchestratorTools}] got [${actualTools}]`,
    );
  }

  const actualPackages = sortUnique(settings.packages);
  if (!arraysEqual(caps.packages, actualPackages)) {
    errors.push(
      `settings.packages mismatch: expected [${caps.packages}] got [${actualPackages}]`,
    );
  }

  const actualServers = isPlainObject(mcp.mcpServers) ? mcp.mcpServers : {};
  const expectedNames = caps.mcpServers.map((s) => s.name).sort();
  if (!arraysEqual(expectedNames, Object.keys(actualServers))) {
    errors.push(
      `mcpServers mismatch: expected [${expectedNames}] got [${Object.keys(actualServers).sort()}]`,
    );
  }
  for (const server of caps.mcpServers) {
    const actual = actualServers[server.name];
    if (actual?.exposure !== server.exposure) {
      errors.push(`mcpServers.${server.name}.exposure mismatch: expected ${server.exposure} got ${actual?.exposure}`);
    }
    if (JSON.stringify(actual?.toolExposure ?? {}) !== JSON.stringify(server.toolExposure ?? {})) {
      errors.push(`mcpServers.${server.name}.toolExposure mismatch: expected ${JSON.stringify(server.toolExposure ?? {})} got ${JSON.stringify(actual?.toolExposure ?? {})}`);
    }
  }
  if (Object.keys(actualServers).length && mcp.autoEnableCodemode !== false) {
    errors.push("mcp.json must set autoEnableCodemode: false, or codemode would reach every server's tools");
  }

  return { ok: errors.length === 0, errors };
}
