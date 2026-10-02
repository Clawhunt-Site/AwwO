import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedText, parseRun, parseAnswer, readBytes, safeEqual, WorkerError } from './protocol.ts';
import { coreEnvironment } from './runtime.ts';
import { TOOLS } from './transport.ts';

const request = { runId: 'opaque/中文', tenantId: 'tenant', sessionId: 'session', prompt: 'write a file', instructions: '', modelProxyURL: 'http://127.0.0.1:9000/v1', modelProxyToken: 'task-token-123456789', timeoutMs: 1000, maxModelCalls: 2 };
test('run scopes are opaque; callback URL and budgets are validated', () => {
  assert.deepEqual(parseRun(request, new Set()), request);
  for (const patch of [{ timeoutMs: 900001 }, { maxModelCalls: 0 }, { modelProxyURL: 'file:///etc/passwd' }, { modelProxyURL: 'http://evil.invalid/v1' }, { modelProxyURL: 'http://127.0.0.1/a?secret=x' }, { modelProxyToken: 'a\r\nb'.repeat(20) }, { prompt: 'a\0b' }, { tenantId: 'x\n' }]) assert.throws(() => parseRun({ ...request, ...patch }, new Set()), WorkerError);
  assert.equal(parseRun({ ...request, modelProxyURL: 'https://gateway.internal/v1' }, new Set(['https://gateway.internal'])).modelProxyURL, 'https://gateway.internal/v1');
});
test('answers and payload bounds reject malformed input', async () => {
  assert.deepEqual(parseAnswer({ requestId: 'r', behavior: 'deny' }), { requestId: 'r', behavior: 'deny' });
  assert.throws(() => parseAnswer({ requestId: 'r', behavior: 'always' }));
  await assert.rejects(readBytes((async function* () { yield Buffer.alloc(5); yield Buffer.alloc(6); })(), 10), /PAYLOAD_TOO_LARGE/);
  assert.equal(safeEqual('secret', 'secret'), true); assert.equal(safeEqual('secret', 'secretx'), false);
});
test('core environment never inherits credentials or host tools; MCP has only six operations', () => {
  process.env.AWWO_SENTINEL_SECRET = 'must-not-inherit';
  const env = coreEnvironment('/isolated', '1234', '1235');
  assert.equal(env.AWWO_SENTINEL_SECRET, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.OMB_LOOPBACK_TRUST, 'service');
  assert.deepEqual(TOOLS.map(tool => tool.name), ['list', 'read', 'write', 'exec', 'publish', 'archive']);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  delete process.env.AWWO_SENTINEL_SECRET;
});
test('display truncation counts UTF-8 bytes without splitting Chinese or emoji', () => {
  for (const value of ['中文'.repeat(100), '🙂'.repeat(100)]) {
    const result = boundedText(value, 200); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.text) <= 200); assert.ok(result.text.endsWith('[truncated]')); assert.ok(!result.text.includes('�'));
  }
});
