/**
 * validate — strict schema validation for a `system.yaml` document (v1).
 *
 * Pure seam: `validateSystem(doc) -> { ok, errors[] }`. Every error is a
 * single, actionable sentence naming the offending path/key and what was
 * expected. No filesystem or CLI work; the document is already parsed.
 *
 * See `schema.md` for the field-by-field schema and validation rules.
 */

import { THINKING_LEVELS, isModelRef } from "./models.mjs";
import { PACKAGE_SOURCE_RE, skillSourceKind } from "./skill-sources.mjs";
import { isMisplacedPlaceholder } from "./cli-tools.mjs";
import { backgroundAskingIssues } from "./asking.mjs";
import { validSecretsPath } from './integration-secrets.mjs';

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TOP_LEVEL_KEYS = [
  "schema", "name", "description", "orchestrator",
  "agents", "skills", "integrations", "policies", "packages", "setup",
];
const ORCHESTRATOR_KEYS = ["name", "description", "prompt", "model", "thinking", "tools"];
const AGENT_KEYS = [
  "name", "description", "tools", "model", "thinking", "skills", "prompt",
  "inheritProjectContext", "inheritSkills",
];
const SKILL_KEYS = ["name", "description", "source"];
const INTEGRATIONS_KEYS = ["mcp", "env", "cli"];
const CLI_KEYS = ["name", "description", "command", "args", "approve", "setup", "secretsFile"];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Declared names are values an integration reads; these would change what
// code runs or where traffic goes for the whole run, so they cannot be declared.
const RESERVED_ENV_RE = /^(PATH|HOME|SHELL|USER|IFS|ENV|BASH_ENV|PS4|PROMPT_COMMAND|TMPDIR|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|PI_CODING_AGENT_DIR|PI_PACKAGE_DIR|PI_OFFLINE|PI_NO_UPDATE_CHECK|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_[A-Z0-9_]*|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|RUBYOPT|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|FAUR_[A-Z0-9_]*)$/i;
const MCP_KEYS = ["name", "config", "setup", "secretsFile"];
const ENV_KEYS = ["name", "secret"];
const POLICIES_KEYS = ["enforced", "advisory"];
const ENFORCED_KEYS = ["agent", "tools", "mcp", "hide"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkUnknownKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(
        `${path} has unknown key "${key}" (allowed: ${allowed.join(", ")})`,
      );
    }
  }
}

function checkSetup(value, path, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value)) { errors.push(`${path} must be an array`); return; }
  value.forEach((step, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(step)) { errors.push(`${p} must be an object`); return; }
    checkUnknownKeys(step, ['description', 'check', 'install', 'platforms', 'needsRoot'], p, errors);
    checkNonEmptyString(step.description, `${p}.description`, errors);
    checkNonEmptyString(step.install, `${p}.install`, errors);
    if (!isPlainObject(step.check) || Object.keys(step.check).length !== 1 || !['command', 'file'].includes(Object.keys(step.check)[0]) || !isNonEmptyString(Object.values(step.check)[0])) errors.push(`${p}.check must contain exactly one non-empty command or file`);
    if (step.platforms !== undefined && (!Array.isArray(step.platforms) || step.platforms.some(v => !['linux', 'darwin'].includes(v)))) errors.push(`${p}.platforms must contain only linux or darwin`);
    if (step.needsRoot !== undefined && typeof step.needsRoot !== 'boolean') errors.push(`${p}.needsRoot must be a boolean`);
  });
}

function checkNonEmptyString(value, path, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function checkStringArray(value, path, errors) {
  if (!isStringArray(value)) {
    errors.push(`${path} must be an array of strings`);
  }
}

function checkKebabCase(value, path, errors) {
  if (typeof value === "string" && value.length > 0 && !KEBAB_CASE.test(value)) {
    errors.push(
      `${path} must be kebab-case (lowercase letters, digits, single ` +
        `hyphens between segments, no leading/trailing hyphen)`,
    );
  }
}

function checkModelRef(value, path, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} is required: a "provider/id" model from the Pi line-up (pi --list-models)`);
  } else if (!isModelRef(value)) {
    errors.push(`${path} must be a "provider/id" model reference (got "${value}")`);
  }
}

function checkThinking(value, path, errors) {
  if (value !== undefined && !THINKING_LEVELS.includes(value)) {
    errors.push(`${path} must be one of ${THINKING_LEVELS.join(", ")} (got ${JSON.stringify(value)})`);
  }
}

function checkPackageSpecs(value, path, errors) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings`);
    return;
  }
  value.forEach((spec, i) => {
    if (!isNonEmptyString(spec) || !PACKAGE_SOURCE_RE.test(spec)) {
      errors.push(
        `${path}[${i}] must be a pinned package spec: "npm:name@version" (scoped names allowed) or "git:...@ref"`,
      );
    }
  });
}

/** Collect names from a list of named blocks, reporting duplicates. */
function collectNames(list, path, errors) {
  const names = new Set();
  if (list === undefined) return names;
  if (!Array.isArray(list)) {
    errors.push(`${path} must be an array`);
    return names;
  }
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isPlainObject(item)) {
      errors.push(`${path}[${i}] must be an object`);
      continue;
    }
    if (isNonEmptyString(item.name)) {
      if (names.has(item.name)) {
        errors.push(`${path}[${i}] duplicates name "${item.name}"`);
      }
      names.add(item.name);
    }
  }
  return names;
}

/**
 * Validate a parsed `system.yaml` document.
 *
 * @param {unknown} doc parsed document (typically a plain object).
 * @returns {{ ok: boolean, errors: string[] }} result; `ok` is true when there
 *   are no errors.
 */
export function validateSystem(doc) {
  const errors = [];

  if (!isPlainObject(doc)) {
    return { ok: false, errors: ["document must be a YAML mapping (object)"] };
  }

  // ── Top-level ────────────────────────────────────────────────
  checkUnknownKeys(doc, TOP_LEVEL_KEYS, "document", errors);
  checkSetup(doc.setup, 'document.setup', errors);

  if (doc.schema !== 1) {
    errors.push(
      doc.schema === undefined
        ? 'document.schema is required (must be 1 for schema v1)'
        : `document.schema must be 1 (got ${JSON.stringify(doc.schema)}); ` +
          "older versions must be migrated first",
    );
  }

  if (!isNonEmptyString(doc.name)) {
    errors.push("document.name is required and must be a non-empty string");
  } else if (!KEBAB_CASE.test(doc.name)) {
    errors.push(
      `document.name must be kebab-case (lowercase letters, digits, single ` +
        `hyphens), got "${doc.name}"`,
    );
  }

  if (doc.description !== undefined && !isNonEmptyString(doc.description)) {
    errors.push("document.description must be a non-empty string");
  }

  checkPackageSpecs(doc.packages, "document.packages", errors);

  // ── orchestrator ────────────────────────────────────────────
  let orchestratorName = null;
  if (doc.orchestrator !== undefined) {
    if (!isPlainObject(doc.orchestrator)) {
      errors.push("document.orchestrator must be an object");
    } else {
      checkUnknownKeys(doc.orchestrator, ORCHESTRATOR_KEYS, "document.orchestrator", errors);

      checkNonEmptyString(doc.orchestrator.name, "document.orchestrator.name", errors);
      if (isNonEmptyString(doc.orchestrator.name)) orchestratorName = doc.orchestrator.name;
      checkModelRef(doc.orchestrator.model, "document.orchestrator.model", errors);
      checkThinking(doc.orchestrator.thinking, "document.orchestrator.thinking", errors);

      if (
        doc.orchestrator.description !== undefined &&
        !isNonEmptyString(doc.orchestrator.description)
      ) {
        errors.push("document.orchestrator.description must be a non-empty string");
      }
      if (doc.orchestrator.prompt !== undefined && !isNonEmptyString(doc.orchestrator.prompt)) {
        errors.push("document.orchestrator.prompt must be a non-empty string");
      }
      if (doc.orchestrator.tools !== undefined) {
        checkStringArray(doc.orchestrator.tools, "document.orchestrator.tools", errors);
      }
    }
  }

  // ── agents ──────────────────────────────────────────────────
  const agentNames = collectNames(doc.agents, "document.agents", errors);
  if (doc.agents !== undefined && Array.isArray(doc.agents)) {
    doc.agents.forEach((agent, i) => {
      if (!isPlainObject(agent)) return;
      checkUnknownKeys(agent, AGENT_KEYS, `document.agents[${i}]`, errors);
      checkNonEmptyString(agent.name, `document.agents[${i}].name`, errors);
      checkKebabCase(agent.name, `document.agents[${i}].name`, errors);
      checkModelRef(agent.model, `document.agents[${i}].model`, errors);
      checkThinking(agent.thinking, `document.agents[${i}].thinking`, errors);
      if (agent.skills !== undefined) {
        checkStringArray(agent.skills, `document.agents[${i}].skills`, errors);
      }
      for (const key of ["inheritProjectContext", "inheritSkills"]) {
        if (agent[key] !== undefined && typeof agent[key] !== "boolean") {
          errors.push(`document.agents[${i}].${key} must be a boolean`);
        }
      }
      if (agent.description !== undefined && !isNonEmptyString(agent.description)) {
        errors.push(`document.agents[${i}].description must be a non-empty string`);
      }
      if (agent.prompt !== undefined && !isNonEmptyString(agent.prompt)) {
        errors.push(`document.agents[${i}].prompt must be a non-empty string`);
      }
      if (agent.tools !== undefined) {
        checkStringArray(agent.tools, `document.agents[${i}].tools`, errors);
      }
    });
  }

  // ── skills ──────────────────────────────────────────────────
  const skillNames = collectNames(doc.skills, "document.skills", errors);
  if (doc.skills !== undefined && Array.isArray(doc.skills)) {
    doc.skills.forEach((skill, i) => {
      if (!isPlainObject(skill)) return;
      checkUnknownKeys(skill, SKILL_KEYS, `document.skills[${i}]`, errors);
      checkNonEmptyString(skill.name, `document.skills[${i}].name`, errors);
      checkKebabCase(skill.name, `document.skills[${i}].name`, errors);
      if (skill.name === 'faur') errors.push(`document.skills[${i}].name faur is reserved: it is the Faur skill`);
      if (skill.description !== undefined && !isNonEmptyString(skill.description)) {
        errors.push(`document.skills[${i}].description must be a non-empty string`);
      }
      if (skill.source !== undefined) {
        if (skillSourceKind(skill.source) === null) {
          errors.push(
            `document.skills[${i}].source must be a pinned package ("npm:name@version" or ` +
              `"git:repo@ref"), a directory path (./, ../, /, ~/) containing SKILL.md, or ` +
              `"skills:<owner>/<repo>/<skill-dir>@<40-character commit>"`,
          );
        }
      }
    });
  }

  // ── integrations ────────────────────────────────────────────
  const mcpNames = new Set();
  const cliNames = new Set();
  if (doc.integrations !== undefined) {
    if (!isPlainObject(doc.integrations)) {
      errors.push("document.integrations must be an object");
    } else {
      checkUnknownKeys(doc.integrations, INTEGRATIONS_KEYS, "document.integrations", errors);

      if (doc.integrations.mcp !== undefined) {
        if (!Array.isArray(doc.integrations.mcp)) {
          errors.push("document.integrations.mcp must be an array");
        } else {
          doc.integrations.mcp.forEach((mcp, i) => {
            if (!isPlainObject(mcp)) {
              errors.push(`document.integrations.mcp[${i}] must be an object`);
              return;
            }
            checkUnknownKeys(mcp, MCP_KEYS, `document.integrations.mcp[${i}]`, errors);
            checkSetup(mcp.setup, `document.integrations.mcp[${i}].setup`, errors);
            if (mcp.secretsFile !== undefined && !validSecretsPath(mcp.secretsFile)) errors.push(`document.integrations.mcp[${i}].secretsFile must be a safe project-relative file path`);
            checkNonEmptyString(mcp.name, `document.integrations.mcp[${i}].name`, errors);
            checkKebabCase(mcp.name, `document.integrations.mcp[${i}].name`, errors);
            if (isNonEmptyString(mcp.name)) {
              if (mcpNames.has(mcp.name)) {
                errors.push(`document.integrations.mcp[${i}] duplicates name "${mcp.name}"`);
              }
              mcpNames.add(mcp.name);
            }
            if (!isPlainObject(mcp.config) || Object.keys(mcp.config).length === 0) {
              errors.push(
                `document.integrations.mcp[${i}].config must be a non-empty object ` +
                  "(url, or command + args)",
              );
            } else {
              if ("approveTools" in mcp.config) errors.push(`document.integrations.mcp[${i}].config.approveTools is no longer supported; Faur does not provide MCP per-call approval`);
              for (const key of ["exposure", "toolExposure"]) {
                if (key in mcp.config) errors.push(`document.integrations.mcp[${i}].config.${key} is set by Faur: list the tools agents use in includeTools and hide others with excludeTools`);
              }
            }
          });
        }
      }

      if (doc.integrations.env !== undefined) {
        if (!Array.isArray(doc.integrations.env)) {
          errors.push("document.integrations.env must be an array");
        } else {
          doc.integrations.env.forEach((env, i) => {
            if (!isPlainObject(env)) {
              errors.push(`document.integrations.env[${i}] must be an object`);
              return;
            }
            checkUnknownKeys(env, ENV_KEYS, `document.integrations.env[${i}]`, errors);
            checkNonEmptyString(env.name, `document.integrations.env[${i}].name`, errors);
            if (typeof env.name === "string" && env.name.length > 0) {
              if (!ENV_NAME_RE.test(env.name)) {
                errors.push(`document.integrations.env[${i}].name must be a shell variable name (letters, digits, underscore; not starting with a digit)`);
              } else if (RESERVED_ENV_RE.test(env.name)) {
                errors.push(`document.integrations.env[${i}].name "${env.name}" is reserved: it changes how the shell, Node, Pi or the network stack runs, so it cannot be an integration variable`);
              }
            }
            if (env.secret !== undefined && typeof env.secret !== "boolean") {
              errors.push(`document.integrations.env[${i}].secret must be a boolean`);
            }
          });
        }
      }

      if (doc.integrations.cli !== undefined) {
        if (!Array.isArray(doc.integrations.cli)) {
          errors.push("document.integrations.cli must be an array");
        } else {
          doc.integrations.cli.forEach((cli, i) => {
            const path = `document.integrations.cli[${i}]`;
            if (!isPlainObject(cli)) { errors.push(`${path} must be an object`); return; }
            checkUnknownKeys(cli, CLI_KEYS, path, errors);
            checkSetup(cli.setup, `${path}.setup`, errors);
            if (cli.secretsFile !== undefined && !validSecretsPath(cli.secretsFile)) errors.push(`${path}.secretsFile must be a safe project-relative file path`);
            checkNonEmptyString(cli.name, `${path}.name`, errors);
            checkKebabCase(cli.name, `${path}.name`, errors);
            if (isNonEmptyString(cli.name)) {
              if (cliNames.has(cli.name)) errors.push(`${path} duplicates name "${cli.name}"`);
              cliNames.add(cli.name);
            }
            if (cli.description !== undefined && !isNonEmptyString(cli.description)) {
              errors.push(`${path}.description must be a non-empty string`);
            }
            if (!isNonEmptyString(cli.command) || /[\s\0]/.test(cli.command)) {
              errors.push(`${path}.command must be one program name or path, without spaces (put arguments in args)`);
            }
            if (cli.args !== undefined) {
              checkStringArray(cli.args, `${path}.args`, errors);
              if (Array.isArray(cli.args)) cli.args.forEach((arg, j) => {
                if (typeof arg === "string" && isMisplacedPlaceholder(arg)) {
                  errors.push(`${path}.args[${j}] looks like a placeholder but isn't one: a placeholder is a whole argument in lowercase: "{name}" is a value you supply; "{name:file}" writes your text to a temporary file and passes its path`);
                }
              });
            }
            if (cli.approve !== undefined && typeof cli.approve !== "boolean") {
              errors.push(`${path}.approve must be a boolean`);
            }
          });
        }
      }
    }
  }

  // ── policies ────────────────────────────────────────────────
  if (doc.policies !== undefined) {
    if (!isPlainObject(doc.policies)) {
      errors.push("document.policies must be an object");
    } else {
      checkUnknownKeys(doc.policies, POLICIES_KEYS, "document.policies", errors);

      if (doc.policies.enforced !== undefined) {
        if (!Array.isArray(doc.policies.enforced)) {
          errors.push("document.policies.enforced must be an array");
        } else {
          doc.policies.enforced.forEach((rule, i) => {
            const path = `document.policies.enforced[${i}]`;
            if (!isPlainObject(rule)) {
              errors.push(`${path} must be an object`);
              return;
            }
            checkUnknownKeys(rule, ENFORCED_KEYS, path, errors);

            const hasAgent = isNonEmptyString(rule.agent);
            const hasMcp = isNonEmptyString(rule.mcp);
            if (hasAgent === hasMcp) {
              errors.push(
                `${path} must have exactly one of "agent" or "mcp"`,
              );
            }
            if (rule.agent !== undefined) {
              checkNonEmptyString(rule.agent, `${path}.agent`, errors);
              checkStringArray(rule.tools, `${path}.tools`, errors);
            }
            if (rule.mcp !== undefined) {
              checkNonEmptyString(rule.mcp, `${path}.mcp`, errors);
              checkStringArray(rule.hide, `${path}.hide`, errors);
            }
          });

          const seenAgents = new Set();
          const seenMcps = new Set();
          for (const rule of doc.policies.enforced) {
            if (!isPlainObject(rule)) continue;
            if (isNonEmptyString(rule.agent)) {
              if (seenAgents.has(rule.agent)) {
                errors.push(`document.policies.enforced has a duplicate agent rule for "${rule.agent}"`);
              }
              seenAgents.add(rule.agent);
            }
            if (isNonEmptyString(rule.mcp)) {
              if (seenMcps.has(rule.mcp)) {
                errors.push(`document.policies.enforced has a duplicate mcp rule for "${rule.mcp}"`);
              }
              seenMcps.add(rule.mcp);
            }
          }
        }
      }

      if (doc.policies.advisory !== undefined) {
        checkStringArray(doc.policies.advisory, "document.policies.advisory", errors);
      }
    }
  }

  // ── References ──────────────────────────────────────────────
  if (doc.agents !== undefined && Array.isArray(doc.agents)) {
    doc.agents.forEach((agent, i) => {
      if (!isPlainObject(agent) || !isStringArray(agent.skills)) return;
      agent.skills.forEach((name, j) => {
        if (!skillNames.has(name)) {
          const available = [...skillNames].sort().join(", ");
          errors.push(
            `document.agents[${i}].skills[${j}] references "${name}" which is not a ` +
              (available ? `declared skill (declared: ${available})` : "declared skill (no skills declared)"),
          );
        }
      });
    });
  }

  if (
    doc.policies !== undefined && isPlainObject(doc.policies) &&
    Array.isArray(doc.policies.enforced)
  ) {
    doc.policies.enforced.forEach((rule, i) => {
      if (!isPlainObject(rule)) return;
      if (isNonEmptyString(rule.agent) && !agentNames.has(rule.agent)) {
        const available = [...agentNames].sort().join(", ");
        errors.push(
          `document.policies.enforced[${i}].agent references "${rule.agent}" which ` +
            (available ? `is not a declared agent (declared: ${available})` : "is not a declared agent (no agents declared)"),
        );
      }
      if (isNonEmptyString(rule.mcp) && !mcpNames.has(rule.mcp)) {
        const available = [...mcpNames].sort().join(", ");
        errors.push(
          `document.policies.enforced[${i}].mcp references "${rule.mcp}" which ` +
            (available ? `is not a declared MCP server (declared: ${available})` : "is not a declared MCP server (no servers declared)"),
        );
      }
    });
  }

  // cli:<name> tool references must name a declared command.
  const cliRefs = [
    ["document.orchestrator.tools", isPlainObject(doc.orchestrator) ? doc.orchestrator.tools : undefined],
    ...(Array.isArray(doc.agents) ? doc.agents.map((a, i) => [`document.agents[${i}].tools`, isPlainObject(a) ? a.tools : undefined]) : []),
    ...(isPlainObject(doc.policies) && Array.isArray(doc.policies.enforced)
      ? doc.policies.enforced.map((r, i) => [`document.policies.enforced[${i}].tools`, isPlainObject(r) ? r.tools : undefined]) : []),
  ];
  for (const [path, tools] of cliRefs) {
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (typeof tool === "string" && tool.startsWith("cli:") && !cliNames.has(tool.slice(4))) {
        errors.push(`${path} references "${tool}" but integrations.cli declares no "${tool.slice(4)}"`);
      }
    }
  }

  // Background subagents cannot answer tool approval prompts.
  if (isPlainObject(doc) && errors.length === 0) {
    for (const issue of backgroundAskingIssues(doc)) {
      errors.push(`document.agents[${issue.index}] ${issue.message}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
