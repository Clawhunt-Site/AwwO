import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { CORE_MODEL_ROUNDS, FINAL_CALL_NOTE, PROXY_MESSAGES, RESULT_BYTES, createTransport, closeServer, finalModelCall, listenLocal } from './transport.ts';
import { hash, json, type RunRequest, type WorkerEvent } from './protocol.ts';
import type { WorkspaceSandbox, WorkspaceRead } from '../openai-agents-worker/workspace-sandbox.ts';

test('fixed RPC rejects unknown tools, validates artifact hashes, deduplicates exact files and enforces model budget', async () => {
  const events: WorkerEvent[] = []; let upstreamCalls = 0, corrupted = false;
  const model = createServer((_req, res) => { upstreamCalls++; json(res, 200, { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }); });
  const url = await listenLocal(model);
  const file: WorkspaceRead = { path: 'reports/result.html', name: 'result.html', content: 'verified', encoding: 'utf8', byteLength: 8, sha256: hash('verified'), mimeType: 'text/html' };
  const sandbox: WorkspaceSandbox = { list: async () => [], read: async () => file, write: async () => file, exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }), publish: async () => corrupted ? { ...file, sha256: '0'.repeat(64) } : file, archive: async () => ({ ...file, encoding: 'base64', content: Buffer.from(file.content).toString('base64') }), close: async () => {} };
  const request: RunRequest = { runId: 'run', tenantId: 'tenant', sessionId: 'session', prompt: 'test', instructions: '', modelProxyURL: url + '/v1', modelProxyToken: 'scope-token-long-enough', timeoutMs: 1000, maxModelCalls: 1, inputs: [] };
  // Every tool call allowed: the RPC itself is what this test checks (a managed run allows only what a card allowed).
  const transport = await createTransport(request, sandbox, new AbortController().signal, event => events.push(event), () => {});
  const headers = { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' };
  const call = async (name: string, args: unknown) => (await fetch(transport.url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json();
  try {
    assert.equal((await fetch(transport.url + '/mcp', { method: 'POST' })).status, 401);
    assert.equal((await call('host_shell', { command: 'whoami' })).result.isError, true);
    assert.equal((await call('write', { path: 'x', content: 'x', host: true })).result.isError, true);
    await call('publish', { path: file.path }); await call('publish', { path: file.path });
    assert.equal(events.length, 1); assert.equal(events[0].name, 'result.html'); assert.equal(events[0].path, 'reports/result.html');
    corrupted = true; assert.equal((await call('publish', { path: file.path })).result.isError, true); assert.equal(events.length, 1);
    const invoke = () => fetch(transport.url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'awwo-model', messages: [{ role: 'user', content: 'test' }] }) });
    assert.equal((await invoke()).status, 200); assert.equal((await invoke()).status, 429); assert.equal(upstreamCalls, 1);
  } finally { await transport.close(); await closeServer(model); }
});

// The pinned core refuses a turn's final answer once any tool result was an error (2026-10-18: tasks whose model had
// recovered lost their answer), so a slip the workspace survived comes back as an ordinary result that did nothing.
test('a tool slip the model can correct is an ordinary result that did nothing, and the rest stays an error', async () => {
  const events: WorkerEvent[] = [];
  let failRead: Error | null = null;
  const file = (path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): WorkspaceRead => ({ path, name: path, content, encoding, byteLength: Buffer.byteLength(content), sha256: hash(content), mimeType: 'text/plain' });
  // Long files whose text grows when encoded: quotes are escaped, Chinese takes three bytes, an emoji is a UTF-16 pair.
  const long: Record<string, string> = { 'big.txt': 'x'.repeat(60 * 1024), 'quotes.txt': '"'.repeat(30 * 1024), 'zh.txt': '关卡'.repeat(10 * 1024), 'emoji.txt': 'a' + '😀'.repeat(20 * 1024), 'fits.txt': 'x'.repeat(50 * 1024 - 200) };
  const binary = Buffer.alloc(60 * 1024, 7).toString('base64');
  const traceback = (action: string, path: string) => new Error(`Workspace ${action} failed: Traceback (most recent call last):\n  File "<string>", line 140, in <module>\nFileNotFoundError: [Errno 2] No such file or directory: '${path}'\n`);
  const sandbox: WorkspaceSandbox = {
    list: async () => [],
    read: async path => { if (failRead) throw failRead; return path === 'image.bin' ? file(path, binary, 'base64') : file(path, long[path] ?? 'small'); },
    write: async (path, content) => file(path, content),
    exec: async () => ({ exitCode: 1, stdout: '', stderr: 'boom', truncated: false }),
    publish: async path => { if (path === 'missing.html') throw traceback('publish', path); return file(path, `page ${path}`); },
    archive: async () => { throw new Error('Workspace sandbox is closed'); },
    close: async () => {},
  };
  const request: RunRequest = { runId: 'run', tenantId: 'tenant', sessionId: 'session', prompt: 'test', instructions: '', modelProxyURL: 'http://127.0.0.1:9/v1', modelProxyToken: 'scope-token-long-enough', timeoutMs: 1000, maxModelCalls: 1, inputs: [] };
  const transport = await createTransport(request, sandbox, new AbortController().signal, event => events.push(event), () => {});
  const headers = { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' };
  const call = async (name: string, args: unknown) => (await fetch(transport.url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json();
  const text = (response: { result: { content: Array<{ text: string }> } }) => JSON.parse(response.result.content[0].text);
  try {
    // A missing file: no error, the call did nothing, and the file name the model asked for is not repeated from the sandbox.
    failRead = traceback('read', 'notes-secret.md');
    let response = await call('read', { path: 'notes-secret.md' });
    assert.equal(response.result.isError, undefined);
    assert.deepEqual(text(response), { failed: true, error: 'NOT_FOUND', message: 'read did nothing: No such file or directory.' });
    failRead = null;
    // The broker's own field checks name what was wrong.
    assert.equal(text(await call('read', { path: '' })).error, 'INVALID_PATH');
    assert.equal(text(await call('exec', { command: '   ' })).error, 'INVALID_COMMAND');
    assert.equal(text(await call('write', { path: 'a.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) })).error, 'TOO_LARGE');
    // A publish that found nothing delivered nothing, and says so.
    assert.deepEqual(text(await call('publish', { path: 'missing.html' })), { failed: true, error: 'NOT_FOUND', message: 'publish did nothing: No such file or directory.', published: false });
    assert.equal(events.length, 0);
    // A command that exited non-zero is its own ordinary result, as before; a sandbox that closed stays an error.
    assert.equal(text(await call('exec', { command: 'false' })).exitCode, 1);
    response = await call('archive', {});
    assert.equal(response.result.isError, true); assert.equal(response.result.content[0].text, 'Workspace operation failed; do not claim it succeeded.');
    // A long read is cut to the longest start whose whole result the core passes on, and says so before its text; a
    // write does not echo what it wrote.
    for (const path of [...Object.keys(long), 'image.bin']) {
      const raw: string = (await call('read', { path })).result.content[0].text, read = JSON.parse(raw);
      const whole = path === 'image.bin' ? binary : long[path];
      assert.ok(Buffer.byteLength(raw) <= RESULT_BYTES, path);
      assert.ok(whole.startsWith(read.content), path); assert.equal(read.byteLength, Buffer.byteLength(whole), path);
      if (path === 'fits.txt') { assert.equal(read.truncated, undefined); assert.equal(read.content, whole); continue; }
      assert.equal(read.truncated, true, path); assert.ok(raw.indexOf('"truncated":true') < raw.indexOf('"content"'), path);
      assert.ok(!/[\ud800-\udbff]$/.test(read.content), path);
      if (path === 'image.bin') assert.equal(read.content.length % 4, 0);
      // One unit more would not have fitted.
      const longer = whole.slice(0, read.content.length + (path === 'image.bin' ? 4 : path === 'emoji.txt' ? 2 : 1));
      assert.ok(Buffer.byteLength(JSON.stringify({ ...read, content: longer })) > RESULT_BYTES, path);
    }
    assert.equal(text(await call('read', { path: 'small.txt' })).truncated, undefined);
    assert.deepEqual(text(await call('write', { path: 'a.txt', content: 'hello' })), { path: 'a.txt', byteLength: 5, sha256: hash('hello'), written: true });
    // Past the task's 16 files nothing more is delivered, and the model is told so rather than the turn failing.
    for (let i = 0; i < 16; i++) assert.equal(text(await call('publish', { path: `p${i}.html` })).published, true);
    response = await call('publish', { path: 'p16.html' });
    assert.equal(response.result.isError, undefined);
    assert.deepEqual(text(response), { failed: true, error: 'ARTIFACT_BUDGET', message: 'publish did nothing: A task publishes at most 16 files and 8 MiB; this file was not delivered.', published: false });
    assert.equal(events.length, 16);
  } finally { await transport.close(); }
});

test('the call that can be a task\'s last asks for the final answer, and only that call', async () => {
  const seen: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown }> = [];
  const model = createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { seen.push(JSON.parse(raw)); json(res, 200, { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }); });
  });
  const url = await listenLocal(model);
  const sandbox = {} as WorkspaceSandbox;
  const run = async (maxModelCalls: number, calls: number, earlier = 0) => {
    seen.length = 0;
    const request: RunRequest = { runId: 'run', tenantId: 'tenant', sessionId: 'session', prompt: 'test', instructions: '', modelProxyURL: url + '/v1', modelProxyToken: 'scope-token-long-enough', timeoutMs: 1000, maxModelCalls, inputs: [] };
    const transport = await createTransport(request, sandbox, new AbortController().signal, () => {}, () => {});
    const headers = { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' };
    const statuses: number[] = [];
    try {
      for (let i = 0; i < calls; i++) {
        const before = Array.from({ length: earlier }, (_, j) => ({ role: 'user', content: 'earlier ' + j }));
        const body = { model: 'awwo-model', messages: [{ role: 'user', content: 'task' }, ...before, { role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'list', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c' + i, content: '[]' }], tools: [{ type: 'function', function: { name: 'list', parameters: { type: 'object' } } }] };
        statuses.push((await fetch(transport.url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) })).status);
      }
    } finally { await transport.close(); }
    return statuses;
  };
  try {
    // Three calls allowed: the third carries the note after the tool results, the first two are sent as they came.
    assert.deepEqual(await run(3, 4), [200, 200, 200, 429]);
    assert.equal(seen.length, 3);
    for (const call of seen.slice(0, 2)) { assert.equal(call.messages.length, 3); assert.ok(!JSON.stringify(call).includes(FINAL_CALL_NOTE)); }
    assert.deepEqual(seen[2].messages.at(-1), { role: 'user', content: FINAL_CALL_NOTE });
    assert.equal(seen[2].messages.length, 4); assert.equal(seen[2].messages[2].role, 'tool'); assert.ok(seen[2].tools, 'the tools stay declared');
    // A budget past the core's 16 rounds: the note goes with the 16th call, the core's last, and with no other.
    assert.equal(finalModelCall({ maxModelCalls: 32 }), CORE_MODEL_ROUNDS);
    assert.deepEqual(await run(32, 17), Array(17).fill(200));
    assert.deepEqual(seen.map((call, i) => [i + 1, JSON.stringify(call).includes(FINAL_CALL_NOTE)]).filter(([, has]) => has), [[16, true]]);
    // The API's proxy refuses a call of more than PROXY_MESSAGES messages: a final call one below still gets the note,
    // one already there goes as it came.
    assert.deepEqual(await run(1, 1, PROXY_MESSAGES - 4), [200]);
    assert.equal(seen[0].messages.length, PROXY_MESSAGES); assert.deepEqual(seen[0].messages.at(-1), { role: 'user', content: FINAL_CALL_NOTE });
    assert.deepEqual(await run(1, 1, PROXY_MESSAGES - 3), [200]);
    assert.equal(seen[0].messages.length, PROXY_MESSAGES); assert.ok(!JSON.stringify(seen[0]).includes(FINAL_CALL_NOTE));
  } finally { await closeServer(model); }
});

test('the proxy cap the final-call note keeps within is the API proxy\'s own', async () => {
  const proxy = await readFile(new URL('../../backend/internal/app/computer_model_proxy.go', import.meta.url), 'utf8');
  assert.ok(proxy.includes(`len(messages) > ${PROXY_MESSAGES} {`), 'computer_model_proxy.go no longer caps a call at PROXY_MESSAGES messages');
});
