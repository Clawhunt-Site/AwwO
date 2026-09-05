import './contract-review-repro.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const result = JSON.parse(await readFile(new URL('./contract-review-repro.json', import.meta.url), 'utf8'));
assert.equal(result.R1_casefold.exact_query_total, 1);
assert.equal(result.R1_casefold.actual_folded_query_total, 1);
const quality = result.R2_quality_invalidation;
assert.equal(quality.publishFailure.status, 422);
assert.equal(quality.publishFailure.code, 'QUALITY_FAILED');
assert.deepEqual(quality.actual_after_reactivate, quality.expected_after_reactivate);
assert.equal(quality.current_version_quality_status, 'unchecked');
await writeFile(new URL('./repro-status.json', import.meta.url), JSON.stringify({
  status: 'passed', observed_at: new Date().toISOString(), R1: 'passed', R2: 'passed',
  scope: 'Independent replay of original acceptance fixture against current demo; no real backend claims',
  adaptation: 'Only import path adjusted for dated evidence directory; original acceptance fixture preserved',
}, null, 2));
