import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const skill = new URL('../skills/faur/SKILL.md', import.meta.url);
test('one Faur skill covers design and project maintenance', () => {
  const text = readFileSync(skill, 'utf8');
  assert.match(text, /## Project maintenance workflow/);
  assert.match(text, /Use only faur_plan/);
  assert.equal(existsSync(new URL('../skills/faur/maintenance-workflow.md', import.meta.url)), false);
});
