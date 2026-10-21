import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contextOverflow } from './context-overflow.ts';

const vectors = JSON.parse(readFileSync(new URL('./context-overflow-vectors.json', import.meta.url), 'utf8')) as { cases: Array<{ message: string; overflow: boolean }> };

test('a provider message refuses a request as too large for the model exactly when the shared cases say so', () => {
  assert.ok(vectors.cases.some(item => item.overflow) && vectors.cases.some(item => !item.overflow));
  for (const item of vectors.cases) assert.equal(contextOverflow(item.message), item.overflow, item.message);
});

test('reads only a message, and only its first 4 KiB', () => {
  for (const value of [undefined, null, 413, { message: 'prompt is too long' }]) assert.equal(contextOverflow(value), false);
  assert.equal(contextOverflow(`${'x'.repeat(4000)} prompt is too long`), true);
  assert.equal(contextOverflow(`${'x'.repeat(4096)} prompt is too long`), false);
});
