import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { classifyError, errorDiagnostic, failureEvent, sanitizeErrorDiagnostic } from './errors.mjs';
import { startIsolatedRun } from './runner.mjs';
import { createOpenAIAgentsServer } from './server.mjs';
import { configuration, request } from './test-support.mjs';

const SECRET = 'fixture-private-key-prompt-request-url';

test('real SDK connection and timeout classes are recognized despite inheriting Error.name', () => {
  const connection = new APIConnectionError({ message: SECRET, cause: new TypeError(SECRET) });
  const timeout = new APIConnectionTimeoutError({ message: SECRET });
  assert.equal(connection.name, 'Error');
  assert.equal(classifyError(connection).code, 'MODEL_CONNECTION_ERROR');
  assert.deepEqual(errorDiagnostic(connection), { errorClass: 'APIConnectionError', category: 'connection', causeClass: 'TypeError' });
  assert.equal(classifyError(timeout).code, 'DEADLINE_EXCEEDED');
  assert.equal(errorDiagnostic(timeout).errorClass, 'APIConnectionTimeoutError');
  assert.ok(!JSON.stringify([classifyError(connection), errorDiagnostic(connection)]).includes(SECRET));
});

test('diagnostics never read raw error text and restrict HTTP status, classes and categories', () => {
  const error = { name: 'APIError', status: 503, cause: { name: 'TypeError', code: 'ECONNRESET' } };
  for (const key of ['message', 'stack', 'body', 'request', 'headers', 'prompt', 'toString']) Object.defineProperty(error, key, { get() { throw new Error('must not inspect private error data'); } });
  assert.deepEqual(errorDiagnostic(error), { errorClass: 'APIError', causeClass: 'TypeError', httpStatus: 503, category: 'unavailable' });
  assert.equal(classifyError({ name: 'TypeError', cause: { code: 'ECONNRESET', message: SECRET } }).code, 'MODEL_CONNECTION_ERROR');
  assert.equal(classifyError({ name: 'TypeError', cause: { code: 'ETIMEDOUT' } }).code, 'DEADLINE_EXCEEDED');
  for (const status of [SECRET, 999_999, 200, 499.5, Infinity, -1]) assert.equal('httpStatus' in errorDiagnostic({ name: SECRET, status }), false);
  assert.deepEqual(errorDiagnostic({ name: SECRET, message: SECRET }), { errorClass: 'UnknownError', category: 'unknown' });
  const circular: { name: string; cause?: unknown } = { name: 'Error' }; circular.cause = circular;
  assert.deepEqual(errorDiagnostic(circular), { errorClass: 'Error', category: 'unknown' });
});

test('untrusted child diagnostics are rebuilt and arbitrary fields or enum strings cannot cross IPC', () => {
  const dirty = { errorClass: 'APIError', category: 'request', httpStatus: 400, causeClass: 'Error', message: SECRET, stack: SECRET, prompt: SECRET, rawRequest: SECRET, nested: { apiKey: SECRET } };
  assert.deepEqual(sanitizeErrorDiagnostic(dirty), { errorClass: 'APIError', category: 'request', httpStatus: 400, causeClass: 'Error' });
  for (const value of [null, [], SECRET, { ...dirty, errorClass: SECRET }, { ...dirty, category: SECRET }]) assert.equal(sanitizeErrorDiagnostic(value), undefined);
  assert.deepEqual(sanitizeErrorDiagnostic({ ...dirty, causeClass: SECRET, httpStatus: SECRET }), { errorClass: 'APIError', category: 'request' });
  assert.equal(failureEvent({ toString() { throw new Error('untrusted failure code must not be coerced'); } }).code, 'MODEL_ERROR');
  assert.deepEqual(sanitizeErrorDiagnostic({ errorClass: 'RuntimeError', category: 'budget', contextSize: { requestBytes: 9000, projectedBytes: 4000, reasoningBytes: 2000, projectedReasoningBytes: 300, otherItemBytes: 0, providerDataBytes: 500, latestArgumentsBytes: 7000, inputItemCount: SECRET, budgetBytes: Infinity, userMessageBytes: -1, source: SECRET, command: SECRET, rawReasoning: SECRET } }),
    { errorClass: 'RuntimeError', category: 'budget', contextSize: { requestBytes: 9000, projectedBytes: 4000, reasoningBytes: 2000, projectedReasoningBytes: 300, otherItemBytes: 0, providerDataBytes: 500, latestArgumentsBytes: 7000 } });
});

test('real child IPC strips malicious diagnostic fields and replaces an unknown failure code', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'awwo-diagnostic-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'diagnostic-fixture.ts');
  await writeFile(path, `process.on('message', () => process.send?.({type:'failed',code:${JSON.stringify(SECRET)},message:${JSON.stringify(SECRET)},diagnostic:{errorClass:'APIConnectionError',category:'connection',httpStatus:503,causeClass:'Error',message:${JSON.stringify(SECRET)},rawRequest:${JSON.stringify(SECRET)}}}, () => process.disconnect?.()));\n`);
  const events: Record<string, unknown>[] = [];
  const diagnostics: unknown[] = [];
  const run = await startIsolatedRun({ config: configuration(), request: request(), onEvent: (event: Record<string, unknown>) => events.push(event), onExit: () => undefined, onDiagnostic: (value: unknown) => { diagnostics.push(value); } }, { taskURL: pathToFileURL(path) });
  await run.done;
  assert.equal(events.at(-1)?.code, 'MODEL_ERROR');
  assert.equal(events.at(-1)?.diagnostic, undefined);
  assert.deepEqual(diagnostics, [{ errorClass: 'APIConnectionError', category: 'connection', httpStatus: 503, causeClass: 'Error' }]);
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test('real SDK socket failure travels child IPC to safe server logs, never exposing diagnostic data on SSE or retrying', { timeout: 10_000 }, async t => {
  let calls = 0;
  const provider = createServer(async (req) => { for await (const _chunk of req) { /* drain fixture request without logging it */ } calls++; req.socket.destroy(); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  const config = configuration({ AWWO_OPENAI_AGENTS_BASE_URL: `http://127.0.0.1:${address.port}/v1`, AWWO_OPENAI_AGENTS_API_KEY: SECRET });
  const app = createOpenAIAgentsServer(config);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const appAddress = app.server.address(); assert.ok(appAddress && typeof appAddress !== 'string');
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  const response = await fetch(`http://127.0.0.1:${appAddress.port}/internal/runs`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request({ prompt: SECRET })) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.at(-1).code, 'MODEL_CONNECTION_ERROR'); assert.equal(events.at(-1).diagnostic, undefined);
  assert.match(events.at(-1).message, /connection.*interrupted/i); assert.equal(calls, 1);
  const failures = logs.flatMap(args => typeof args[0] === 'string' ? [JSON.parse(args[0])] : []);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].diagnostic, { errorClass: 'APIConnectionError', category: 'connection', causeClass: 'TypeError' });
  assert.ok(!JSON.stringify(logs).includes(SECRET)); assert.ok(!text.includes(SECRET));
});
