import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurationAdvisories } from '../advisories.mjs';
import { commandShape, readerFileWarning } from '../cli-tools.mjs';

test('command equivalence preserves repeated parameter identity and file semantics', () => {
  const shape = args => commandShape({ command: 'cat', args });
  assert.equal(shape(['{a}', '{a}']), shape(['{b}', '{b}']));
  assert.notEqual(shape(['{a}', '{a}']), shape(['{a}', '{b}']));
  assert.notEqual(shape(['{a}']), shape(['{a:file}']));
  assert.match(readerFileWarning({ command: '/bin/cat', args: ['{path:file}'] }), /not a path/);
  assert.equal(readerFileWarning({ command: 'cat', args: ['{path}'] }), '');
});

test('reports unused and equivalent commands and lead file access as advisories', () => {
  const model = { orchestrator: { name: 'lead', tools: ['subagent'], prompt: 'Keep receipt paths.' }, integrations: { cli: [
    { name: 'one', command: 'cat', args: ['{path}'] },
    { name: 'two', command: 'cat', args: ['{file}'] },
  ] } };
  const warnings = configurationAdvisories(model);
  assert.ok(warnings.some(s => s.includes('not available')));
  assert.ok(warnings.some(s => s.includes('equivalent shapes')));
  assert.ok(warnings.some(s => s.includes('may need to read files')));
  model.orchestrator.tools.push('read');
  assert.ok(!configurationAdvisories(model).some(s => s.includes('may need to read files')));
});
