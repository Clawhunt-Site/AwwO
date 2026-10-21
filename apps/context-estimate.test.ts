import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PROSE_RATE_MAX, estimateTokens, proseRate, textCost } from './context-estimate.ts';

const vectors = JSON.parse(readFileSync(new URL('./context-estimate-vectors.json', import.meta.url), 'utf8')) as {
  rates: number[]; cases: { name: string; text: string; strict: number; prose: number; estimate: number[] }[];
};

test('every shared vector splits and estimates as the Go API and the Python worker do', () => {
  assert.ok(vectors.cases.length >= 20);
  for (const c of vectors.cases) {
    assert.deepEqual(textCost(c.text), { strict: c.strict, prose: c.prose }, c.name);
    assert.equal(c.strict + c.prose, Buffer.byteLength(c.text), c.name);
    vectors.rates.forEach((rate, i) => assert.equal(estimateTokens(c.text, rate), c.estimate[i], `${c.name} at ${rate}`));
  }
});

test('at a rate of 1, or none, the estimate is the text\'s UTF-8 bytes', () => {
  for (const c of vectors.cases) {
    assert.equal(estimateTokens(c.text), Buffer.byteLength(c.text), c.name);
    assert.equal(estimateTokens(c.text, 1), Buffer.byteLength(c.text), c.name);
  }
});

test('the estimate never exceeds the bytes and never falls below the strict part', () => {
  const text = `说明 version 5.6 ${'x'.repeat(40)} 😀 plain words`;
  const { strict } = textCost(text);
  for (const rate of [1, 1.5, 2.15, 3.3, 4]) {
    const estimate = estimateTokens(text, rate);
    assert.ok(estimate <= Buffer.byteLength(text) && estimate >= strict, `${rate}: ${estimate}`);
  }
  // A rate past the largest a profile may declare counts as the largest.
  assert.equal(estimateTokens(text, 9), estimateTokens(text, PROSE_RATE_MAX));
});

test('a declared prose rate must be a number from 1 to 4 in steps of 0.05', () => {
  assert.equal(proseRate(undefined), 1);
  for (const ok of [1, 1.05, 2.15, 3.3, 4]) assert.equal(proseRate(ok), ok);
  for (const bad of [0, 0.95, 4.05, 2.13, '2', null, Number.NaN, Number.POSITIVE_INFINITY, [2]]) {
    assert.throws(() => proseRate(bad), /Invalid proseBytesPerToken/, String(bad));
  }
});
