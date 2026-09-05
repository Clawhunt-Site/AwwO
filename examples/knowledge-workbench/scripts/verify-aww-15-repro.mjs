// Re-run the reviewer's unchanged reproduction, then assert its observations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const files = ['src/app.js', 'src/api.js', 'src/demo.js', 'src/unicode-casefold.js',
  'data/unicode/17.0.0/CaseFolding.txt', 'scripts/generate-unicode-casefold.mjs',
  'tests/model.test.js', 'tests/ui-dom.test.js', 'tests/demo-regressions.test.js',
  'tests/unicode-casefold.test.js', 'scripts/contract-review-repro.mjs'];
const hashes = () => Object.fromEntries(files.map(path => [path,
  createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex')]));
const before = hashes();
await import('./contract-review-repro.mjs');
const result = JSON.parse(readFileSync(new URL('../artifacts/contract-review-repro.json', import.meta.url), 'utf8'));
assert.equal(result.R1_casefold.exact_query_total, 1);
assert.equal(result.R1_casefold.actual_folded_query_total, 1);
assert.equal(result.R2_quality_invalidation.publishFailure.status, 422);
assert.equal(result.R2_quality_invalidation.publishFailure.code, 'QUALITY_FAILED');
assert.deepEqual(result.R2_quality_invalidation.actual_after_reactivate, {
  blocked_draft_count: 0, unchecked_draft_count: 3,
});
assert.equal(result.R2_quality_invalidation.current_version_quality_status, 'unchecked');
const after = hashes();
assert.deepEqual(after, before, 'Reviewed files changed during reproduction');
const evidence = {
  status: 'passed', observed_at: result.observed_at,
  scope: 'main demo modules; no live backend or browser acceptance',
  runtime: { node: process.version, unicode: process.versions.unicode, icu: process.versions.icu },
  source_hashes: after, reproduction: result,
};
writeFileSync(new URL('../artifacts/aww-15-final-verification.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log('AWW-15 assertions passed; source hashes and expected/actual observations saved.');
