import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { CORE_MODEL_ROUNDS, FINAL_CALL_NOTE, PROXY_MESSAGES, createTransport, closeServer, finalModelCall, listenLocal } from './transport.ts';
import { hash, json, type RunRequest, type WorkerEvent } from './protocol.ts';
import type { WorkspaceSandbox, WorkspaceRead } from '../openai-agents-worker/workspace-sandbox.ts';

test('fixed RPC rejects unknown tools, validates artifact hashes, deduplicates exact files and enforces model budget', async () => {
  const events: WorkerEvent[] = []; let upstreamCalls = 0, corrupted = false;
  const model = createServer((_req, res) => { upstreamCalls++; json(res, 200, { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }); });
  const url = await listenLocal(model);
  const file: WorkspaceRead = { path: 'reports/result.html', name: 'result.html', content: 'verified', encoding: 'utf8', byteLength: 8, sha256: hash('verified'), mimeType: 'text/html' };
  const sandbox: WorkspaceSandbox = { list: async () => [], read: async () => file, write: async () => file, exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }), publish: async () => corrupted ? { ...file, sha256: '0'.repeat(64) } : file, archive: async () => ({ ...file, encoding: 'base64', content: Buffer.from(file.content).toString('base64') }), close: async () => {} };
  const request: RunRequest = { runId: 'run', tenantId: 'tenant', sessionId: 'session', prompt: 'test', instructions: '', modelProxyURL: url + '/v1', modelProxyToken: 'scope-token-long-enough', timeoutMs: 1000, maxModelCalls: 1, inputs: [] };
  const transport = await createTransport(request, sandbox, new AbortController().signal, event => events.push(event));
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
    const transport = await createTransport(request, sandbox, new AbortController().signal, () => {});
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
