import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTransport, closeServer, listenLocal } from './transport.ts';
import { hash, json, type RunRequest, type WorkerEvent } from './protocol.ts';
import type { WorkspaceSandbox, WorkspaceRead } from '../openai-agents-worker/workspace-sandbox.ts';

test('fixed RPC rejects unknown tools, validates artifact hashes, deduplicates exact files and enforces model budget', async () => {
  const events: WorkerEvent[] = []; let upstreamCalls = 0, corrupted = false;
  const model = createServer((_req, res) => { upstreamCalls++; json(res, 200, { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }); });
  const url = await listenLocal(model);
  const file: WorkspaceRead = { path: 'reports/result.html', name: 'result.html', content: 'verified', encoding: 'utf8', byteLength: 8, sha256: hash('verified'), mimeType: 'text/html' };
  const sandbox: WorkspaceSandbox = { list: async () => [], read: async () => file, write: async () => file, exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }), publish: async () => corrupted ? { ...file, sha256: '0'.repeat(64) } : file, archive: async () => ({ ...file, encoding: 'base64', content: Buffer.from(file.content).toString('base64') }), close: async () => {} };
  const request: RunRequest = { runId: 'run', tenantId: 'tenant', sessionId: 'session', prompt: 'test', instructions: '', modelProxyURL: url + '/v1', modelProxyToken: 'scope-token-long-enough', timeoutMs: 1000, maxModelCalls: 1 };
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
