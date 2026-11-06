/** Small schema-aware change layer. No filesystem or installation authority. */
import { withBaseline, withBaselineTools } from './policy.mjs';
import { loadYaml } from './yaml-loader.mjs';
import { validateSystem } from './validate.mjs';

const collections = { agent: ['agents'], skill: ['skills'], mcp: ['integrations', 'mcp'], env: ['integrations', 'env'], cli: ['integrations', 'cli'] };
const blocks = { orchestrator: ['orchestrator'], policies: ['policies'], integrations: ['integrations'], packages: ['packages'] };
const safeName = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]+$/.test(s) && !['__proto__', 'constructor', 'prototype'].includes(s);
// Removed in 0.36 (#75). Maintenance reads a design that still has them so
// Faur can propose the replacing skills; the next approved change drops them.
export const LEGACY_KEYS = ['documents', 'workflows'];
const withoutLegacy = model => model && typeof model === 'object' && !Array.isArray(model) ? Object.fromEntries(Object.entries(model).filter(([key]) => !LEGACY_KEYS.includes(key))) : model;
/** The legacy declarations a design still carries, by key, or null. */
export function legacyDeclarations(text) {
  const model = loadYaml().parse(text);
  const found = Object.fromEntries(LEGACY_KEYS.filter(key => model?.[key] !== undefined).map(key => [key, model[key]]));
  return Object.keys(found).length ? found : null;
}
const SKILL_LIMIT = 64000;
/** A proposed local skill file: frontmatter naming this skill, with a description. */
function skillContent(name, content) {
  if (typeof content !== 'string' || !content.trim() || content.length > SKILL_LIMIT) throw new Error(`skill ${name}: content must be a non-empty SKILL.md under ${SKILL_LIMIT} characters`);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(content);
  const data = front ? loadYaml().parse(front[1]) : null;
  if (data?.name !== name) throw new Error(`skill ${name}: SKILL.md frontmatter must start with name: ${name}`);
  if (typeof data.description !== 'string' || !data.description.trim()) throw new Error(`skill ${name}: SKILL.md frontmatter needs a description saying when to use it`);
  return content.endsWith('\n') ? content : `${content}\n`;
}
export function assertValid(model) {
  const result = validateSystem(model);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  if (model.skills?.some(s => s.name === 'faur')) throw new Error('faur is reserved: it is the Faur skill');
  return model;
}

/** Operations: add/update/remove named entities; assign an agent's model (and
 * thinking level); set a schema block; replace the entire model for uncommon edits. Validate the final
 * batch, allowing dependent references to be repaired in the same proposal.
 * YAML nodes not changed by the batch retain comments and presentation. */
export function changeModel(text, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new Error('Expected 1–100 structured operations');
  const yaml = loadYaml();
  let doc = yaml.parseDocument(text);
  if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('\n'));
  if (doc.toJS()?.schema !== 1 && !operations.some(o => o.op === 'replace')) throw new Error('Unsupported schema; preview an explicit replace operation first');
  const legacyRemoved = LEGACY_KEYS.filter(key => doc.has(key));
  for (const key of legacyRemoved) doc.delete(key);
  // Local skill files proposed with this change; system.yaml records only the
  // declaration, never the procedure.
  const skillFiles = {};
  const put = (path, value) => doc.setIn(path, doc.createNode(value));
  for (const o of operations) {
    if (!o || typeof o !== 'object') throw new Error('Invalid operation');
    if (o.op === 'reconcile') {
      if (operations.length !== 1) throw new Error('Reconciliation must be a separate proposal');
      continue;
    }
    if (o.op === 'replace') {
      doc = new yaml.Document(assertValid(o.model));
      continue;
    }
    if (o.op === 'set' && Object.hasOwn(blocks, o.target)) {
      put(blocks[o.target], o.value);
      continue;
    }
    if (o.op === 'assign' && safeName(o.name) && typeof o.model === 'string') {
      const model = doc.toJS();
      let path = ['orchestrator'];
      if (o.name !== model.orchestrator?.name) {
        const index = model.agents?.findIndex(a => a.name === o.name) ?? -1;
        if (index < 0) throw new Error(`Unknown agent ${o.name}`);
        path = ['agents', index];
      }
      put([...path, 'model'], o.model);
      if (o.thinking === null) doc.deleteIn([...path, 'thinking']);
      else if (o.thinking !== undefined) put([...path, 'thinking'], o.thinking);
      continue;
    }
    if (!['add', 'update', 'remove'].includes(o.op) || !safeName(o.name)) throw new Error('Unknown operation or unsafe name');
    if (Object.hasOwn(collections, o.target)) {
      const path = collections[o.target];
      const list = doc.toJS();
      const items = path.reduce((v, k) => v?.[k], list) ?? [];
      const index = items.findIndex(i => i.name === o.name);
      if ((o.op === 'add') === (index >= 0)) throw new Error(`${o.target} ${o.name}: ${index >= 0 ? 'already exists' : 'not found'}`);
      if (o.content !== undefined) {
        if (o.target !== 'skill' || o.op === 'remove') throw new Error('content is only for adding or updating a local skill');
        skillFiles[o.name] = skillContent(o.name, o.content);
      }
      if (o.op === 'add') {
        if (!doc.hasIn(path)) put(path, []);
        doc.addIn(path, doc.createNode({ ...o.value, name: o.name }));
      } else if (o.op === 'remove') doc.deleteIn([...path, index]);
      else {
        if (o.value === undefined && o.content !== undefined) continue;
        if (!o.value || typeof o.value !== 'object' || Array.isArray(o.value)) throw new Error('update requires an object value');
        for (const [key, value] of Object.entries(o.value)) {
          if (key === 'name' && value !== o.name) throw new Error('Rename via a validated model replacement');
          put([...path, index, key], value);
        }
      }
    } else throw new Error(`Unknown target ${o.target}`);
  }
  // Write the browsing baseline into the design, so the record says it.
  const js = doc.toJS();
  const paths = [['orchestrator'], ...(Array.isArray(js?.agents) ? js.agents.map((_, i) => ['agents', i]) : [])];
  let baselineAdded = false;
  for (const path of paths) {
    const tools = path.reduce((v, k) => v?.[k], js)?.tools;
    const full = withBaseline(tools);
    if (Array.isArray(tools) && full.length !== tools.length) { put([...path, 'tools'], full); baselineAdded = true; }
  }
  const model = assertValid(doc.toJS());
  for (const name of Object.keys(skillFiles)) {
    if (model.skills?.find(skill => skill.name === name)?.source) throw new Error(`skill ${name}: content is only for a local skill, not one with a source`);
  }
  return { model, text: doc.toString(), baselineAdded, skillFiles, legacyRemoved };
}
/** Parse and validate the project's current model, with the browsing baseline.
 * Legacy keys are set aside here; inspection reports them. */
export function parsedModel(text) { return withBaselineTools(assertValid(withoutLegacy(loadYaml().parse(text)))); }
