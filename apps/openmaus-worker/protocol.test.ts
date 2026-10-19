import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedText, hash, parseRun, parseAnswer, readBytes, safeEqual, WorkerError } from './protocol.ts';
import { coreEnvironment, workspaceSoul } from './runtime.ts';
import { TOOLS } from './transport.ts';

const request = { runId: 'opaque/中文', tenantId: 'tenant', sessionId: 'session', prompt: 'write a file', instructions: '', modelProxyURL: 'http://127.0.0.1:9000/v1', modelProxyToken: 'task-token-123456789', timeoutMs: 1000, maxModelCalls: 2 };
test('run scopes are opaque; callback URL and budgets are validated', () => {
  assert.deepEqual(parseRun(request, new Set()), { ...request, inputs: [] });
  for (const patch of [{ timeoutMs: 900001 }, { maxModelCalls: 0 }, { modelProxyURL: 'file:///etc/passwd' }, { modelProxyURL: 'http://evil.invalid/v1' }, { modelProxyURL: 'http://127.0.0.1/a?secret=x' }, { modelProxyToken: 'a\r\nb'.repeat(20) }, { prompt: 'a\0b' }, { tenantId: 'x\n' }]) assert.throws(() => parseRun({ ...request, ...patch }, new Set()), WorkerError);
  assert.equal(parseRun({ ...request, modelProxyURL: 'https://gateway.internal/v1' }, new Set(['https://gateway.internal'])).modelProxyURL, 'https://gateway.internal/v1');
});
test('input files are names with real base64 and matching digests, within the totals', () => {
  const file = (name: string, text: string) => { const content = Buffer.from(text).toString('base64'); return { name, content, encoding: 'base64', sha256: hash(Buffer.from(text)) }; };
  const parsed = parseRun({ ...request, inputs: [file('app.zip', 'PK'), file('notes.md', '# hi')] }, new Set());
  assert.deepEqual(parsed.inputs.map(input => input.name), ['app.zip', 'notes.md']);
  const good = file('a.txt', 'abc');
  for (const inputs of [[{ ...good, name: '../a' }], [{ ...good, name: 'a/b' }], [{ ...good, sha256: 'f'.repeat(64) }], [{ ...good, content: 'not base64!' }],
    [{ ...good, encoding: 'utf8' }], [good, good], Array.from({ length: 9 }, (_, i) => file(`f${i}`, 'x')), 'a.txt'])
    assert.throws(() => parseRun({ ...request, inputs }, new Set()), WorkerError);
  const big = 'x'.repeat(2 * 1024 * 1024);
  assert.throws(() => parseRun({ ...request, inputs: [file('big', big + 'x')] }, new Set()), WorkerError);
  assert.throws(() => parseRun({ ...request, inputs: [file('a', big), file('b', big), file('c', big), file('d', big), file('e', 'x')] }, new Set()), WorkerError);
});
test('the agent is told about its files, the tools its image has and the web, and nothing else', () => {
  const inputs = [{ name: 'app.zip', content: '', encoding: 'base64' as const, sha256: '' }];
  const plain = workspaceSoul({ tools: new Set(), sandbox: {} }, { inputs: [] });
  assert.ok(plain.includes('no network') && !plain.includes('/inputs') && !plain.includes('rea ') && !plain.includes('awwo-check-page') && !plain.includes('PROXY'));
  const full = workspaceSoul({ tools: new Set(['rea', 'check-page']), sandbox: { egress: { socketDir: '/srv/egress', secret: 'x'.repeat(32) } } }, { inputs });
  assert.ok(full.includes('/inputs: app.zip') && full.includes('rea analyze-javascript-application') && full.includes('awwo-check-page'));
  assert.ok(full.includes('HTTPS_PROXY') && !full.includes('no network') && !full.includes('x'.repeat(32)));
  // A recoverable tool failure is an ordinary result (tool-failures.ts): the agent is told what it means.
  for (const soul of [plain, full]) assert.ok(soul.includes('failed: true did nothing') && soul.includes('Only published: true delivered a file.'));
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
  // A model call may take up to the API proxy's 10 minutes before its one-piece answer arrives.
  assert.equal(env.OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS, '600000');
  assert.deepEqual(TOOLS.map(tool => tool.name), ['list', 'read', 'write', 'exec', 'publish', 'archive']);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  delete process.env.AWWO_SENTINEL_SECRET;
});
test('display truncation counts UTF-8 bytes without splitting Chinese or emoji', () => {
  for (const value of ['中文'.repeat(100), '🙂'.repeat(100)]) {
    const result = boundedText(value, 200); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.text) <= 200); assert.ok(result.text.endsWith('[truncated]')); assert.ok(!result.text.includes('�'));
  }
});
