import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const skill = new URL('../skills/faur/SKILL.md', import.meta.url);
test('one Faur skill covers design and project maintenance', () => {
  const text = readFileSync(skill, 'utf8');
  assert.match(text, /## Project maintenance workflow/);
  assert.match(text, /use only faur_plan/i);
  assert.match(text.split('## Project maintenance workflow')[1].replace(/\s+/g, ' '), /apply only when `\/faur` runs inside a trusted Faur project/, 'maintenance rules are scoped so design mode is not blocked by them');
  assert.equal(existsSync(new URL('../skills/faur/maintenance-workflow.md', import.meta.url)), false);
});
