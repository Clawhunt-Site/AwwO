import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnostic, proxyErrorCode, safeFailureDetails } from './diagnostics.ts';

test('diagnostics emit only identifiers, fixed code and HTTP status; discard unknown upstream content', () => {
  assert.equal(proxyErrorCode({ error: { code: 'invalid_completion_tool', message: 'SECRET' } }), 'invalid_completion_tool');
  assert.equal(proxyErrorCode({ error: { code: 'sk-secret-value', message: 'SECRET' } }), 'MODEL_PROXY_REJECTED');
  assert.equal(proxyErrorCode({ token: 'SECRET', error: 'bad' }), 'MODEL_PROXY_REJECTED');
  const original = console.error, lines: string[] = [];
  try { console.error = line => lines.push(String(line)); diagnostic('model_proxy_rejected', 'opaque-run', proxyErrorCode({ error: { code: 'context_limit', message: 'SECRET' } }), 400); }
  finally { console.error = original; }
  assert.equal(lines.length, 1); assert.ok(!lines[0].includes('SECRET'));
  assert.deepEqual(JSON.parse(lines[0]), { service: 'awwo-openmaus-worker', event: 'model_proxy_rejected', runId: 'opaque-run', code: 'context_limit', status: 400 });
});
test('runtime stage diagnostics expose only allowlisted names and network causes', () => {
  assert.deepEqual(safeFailureDetails(new TypeError('SECRET URL', { cause: { code: 'ECONNRESET', secret: 'SECRET' } })), { errorName: 'TypeError', reason: 'ECONNRESET' });
  assert.deepEqual(safeFailureDetails(new SyntaxError('SECRET BODY')), { errorName: 'Error', reason: 'INVALID_UPSTREAM_JSON' });
  assert.deepEqual(safeFailureDetails({ name: 'SECRET', code: 'SECRET' }), { errorName: 'Error', reason: 'UNCLASSIFIED' });
});
