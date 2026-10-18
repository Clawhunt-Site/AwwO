import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { compileWorkspaceDelivery, executeWorkspaceAgent, verifiedWorkspaceFile, WORKSPACE_MODEL_TIMEOUT_MS } from './workspace-runtime.ts';
import { authorizeWorkspace, loadWorkspaceConfig, validateWorkspaceRequest, type WorkspaceRequest } from './workspace-protocol.ts';
import { classifyError } from './errors.mjs';

const checksum = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const workspace = (callbackURL = 'http://127.0.0.1:8087/api/internal/workspace-calls'): WorkspaceRequest => ({
  version: 1, id: 'a'.repeat(64), maxModelCalls: 8, callbackURL, callbackToken: 'test-callback-credential-never-in-model-state',
  inputs: [], outputFields: [{ id: 'page', type: 'html', required: true }],
});
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const, byteLength: Buffer.byteLength(content), sha256: checksum(content) });
const snapshot = () => { const content = Buffer.from('fixture-only-zip'); return { path: 'workspace.zip', content: content.toString('base64'), encoding: 'base64' as const, byteLength: content.length, sha256: checksum(content) }; };
async function listening(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('workspace authorization is configured, bounded and bound to an exact callback endpoint', () => {
  const spec = workspace(); validateWorkspaceRequest(spec);
  const config = loadWorkspaceConfig({ AWWO_OPENAI_AGENTS_WORKSPACE_IMAGE: 'awwo-workspace:test', AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER: '/usr/bin/docker', AWWO_OPENAI_AGENTS_WORKSPACE_CALLBACK_URL: spec.callbackURL });
  authorizeWorkspace(config, { workspace: spec });
  assert.throws(() => authorizeWorkspace(undefined, { workspace: spec }));
  assert.throws(() => authorizeWorkspace(config, { workspace: { ...spec, callbackURL: 'http://127.0.0.1:8088/api/internal/workspace-calls' } }));
  assert.throws(() => authorizeWorkspace(config, { workspace: spec, tools: ['calculator'] }));
  assert.throws(() => validateWorkspaceRequest({ ...spec, inputs: [{ name: '../secret', encoding: 'base64', content: '', sha256: checksum('') }] }));
  assert.throws(() => validateWorkspaceRequest({ ...spec, inputs: [{ name: 'a', encoding: 'base64', content: 'YQ==', sha256: checksum('different') }] }));
  assert.throws(() => validateWorkspaceRequest({ ...spec, outputFields: [{ id: '__workspace_snapshot', type: 'file', required: true }] }));
  assert.throws(() => validateWorkspaceRequest({ ...spec, maxModelCalls: 65 }));
  assert.throws(() => validateWorkspaceRequest({ ...spec, callbackURL: 'http://127.0.0.1/api/internal/workspace-calls' }));
});

test('a workspace container has 1 GiB unless the worker is given 256-4,096 MiB', () => {
  // A headless Chromium testing a large self-testing page needs more (the flagship tester's page, 2026-10-17).
  const env = { AWWO_OPENAI_AGENTS_WORKSPACE_IMAGE: 'awwo-workspace:test', AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER: '/usr/bin/docker', AWWO_OPENAI_AGENTS_WORKSPACE_CALLBACK_URL: workspace().callbackURL };
  assert.equal(loadWorkspaceConfig(env)?.memoryMB, undefined);
  assert.equal(loadWorkspaceConfig({ ...env, AWWO_OPENAI_AGENTS_WORKSPACE_MEMORY_MB: '3072' })?.memoryMB, 3072);
  for (const value of ['255', '4097', '2.5', '-1', 'lots']) assert.throws(() => loadWorkspaceConfig({ ...env, AWWO_OPENAI_AGENTS_WORKSPACE_MEMORY_MB: value }), /MEMORY_MB/);
});

test('workspace defaults to 32 model calls, permits explicit 2..64, and preserves frozen 16-call runs', () => {
  const spec = workspace();
  const env = { AWWO_OPENAI_AGENTS_WORKSPACE_IMAGE: 'awwo-workspace:test', AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER: '/usr/bin/docker', AWWO_OPENAI_AGENTS_WORKSPACE_CALLBACK_URL: spec.callbackURL };
  const defaults = loadWorkspaceConfig(env);
  assert.equal(defaults?.maxModelCalls, 32);
  for (const maxModelCalls of [2, 16, 32, 64]) {
    validateWorkspaceRequest({ ...spec, maxModelCalls });
    const configured = loadWorkspaceConfig({ ...env, AWWO_OPENAI_AGENTS_WORKSPACE_MAX_CALLS: String(maxModelCalls) });
    assert.equal(configured?.maxModelCalls, maxModelCalls);
    authorizeWorkspace(configured, { workspace: { ...spec, maxModelCalls } });
  }
  authorizeWorkspace(defaults, { workspace: { ...spec, maxModelCalls: 16 } });
  assert.throws(() => authorizeWorkspace(defaults, { workspace: { ...spec, maxModelCalls: 33 } }));
  for (const maxModelCalls of [0, 1, 2.5, 65, Infinity, -1]) {
    assert.throws(() => validateWorkspaceRequest({ ...spec, maxModelCalls }));
    assert.throws(() => loadWorkspaceConfig({ ...env, AWWO_OPENAI_AGENTS_WORKSPACE_MAX_CALLS: String(maxModelCalls) }));
  }
});

test('delivery binds actual published bytes and rejects invented files or mismatched receipt', () => {
  const source = '<!doctype html><html><head></head><body><button>Play</button></body></html>';
  const fields = workspace().outputFields;
  assert.equal(JSON.parse(compileWorkspaceDelivery('{"page":"invented"}', fields, new Map([['page', file('index.html', source)]]))).page, source);
  assert.throws(() => compileWorkspaceDelivery('{"bundle":{"name":"fake.zip","content":"made up"}}', [{ id: 'bundle', type: 'file', required: true }], new Map()));
  assert.throws(() => verifiedWorkspaceFile({ ...file('index.html', source), sha256: checksum('wrong') }));
  assert.throws(() => compileWorkspaceDelivery('{"count":"1"}', [{ id: 'count', type: 'number', required: true }], new Map()));
  const bigText = 'a'.repeat(300_000);
  const delivery = JSON.parse(compileWorkspaceDelivery('{"bundle":""}', [{ id: 'bundle', type: 'file', required: true }], new Map([['bundle', file('main.ts', bigText)]])));
  assert.equal(delivery.bundle.encoding, 'base64');
  assert.equal(Buffer.from(delivery.bundle.content, 'base64').toString(), bigText);
});

test('SDK workspace loop edits, tests and publishes with one admission and receipt per model call', { timeout: 20_000 }, async t => {
  const calls: Record<string, unknown>[] = [];
  const ledger: Record<string, unknown>[] = [];
  const page = '<!doctype html><html><head></head><body><button>Play</button></body></html>';
  const steps = [
    { name: 'workspace_list', arguments: { path: '.' } },
    { name: 'workspace_write', arguments: { path: 'index.html', content: page } },
    { name: 'workspace_exec', arguments: { command: "node -e 'console.log(2+2)'" } },
    { name: 'workspace_publish', arguments: { field: 'page', path: 'index.html' } },
  ];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    if (req.url === '/api/internal/workspace-calls') {
      assert.equal(req.headers.authorization, `Bearer ${workspace().callbackToken}`);
      ledger.push(value); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ [value.operation === 'admit' ? 'admitted' : 'settled']: true, index: value.index })); return;
    }
    calls.push(value);
    const step = steps[calls.length - 1];
    res.setHeader('content-type', 'text/event-stream');
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: `chat_${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant', ...(step ? { tool_calls: [{ index: 0, id: `tool_${calls.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] } : { content: '{"page":""}' }) }, null);
    send({}, step ? 'tool_calls' : 'stop');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`); res.end();
  });
  const base = await listening(server); t.after(() => { server.closeAllConnections(); server.close(); });
  const operations: string[] = [], events: Record<string, unknown>[] = [];
  await executeWorkspaceAgent({ request: { prompt: 'Build and test a page',
    messages: [{ role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier reply' }], workspace: workspace(`${base}/api/internal/workspace-calls`) },
    modelConfig: { model: 'fixture', apiKey: 'provider-secret-not-in-sandbox', baseURL: `${base}/v1`, protocol: 'chat_completions', contextWindow: 65_536, maxTokens: 4096 }, signal: new AbortController().signal,
    emit: async event => { events.push(event); }, broker: async (name, args) => {
      operations.push(name);
      if (name === 'workspace_list') return [];
      if (name === 'workspace_write') { assert.equal(args.content, page); return file('index.html', page); }
      if (name === 'workspace_exec') return { exitCode: 0, stdout: '4\n', stderr: '', truncated: false };
      if (name === 'workspace_publish') return file('index.html', page);
      if (name === 'snapshot') return snapshot();
      throw new Error('unexpected tool');
    } });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.store === false));
  // A worker that names no tools and no web tells its agent exactly that.
  const system = String((calls[0].messages as { role: string; content: unknown }[]).find(item => item.role === 'system')?.content);
  assert.ok(system.includes('There is no network') && !system.includes('HTTPS_PROXY') && !system.includes('awwo-check-page'));
  // History and task reach the provider as plain text (LLM Gate's Responses endpoint ignores an input_text part list).
  assert.deepEqual((calls[0].messages as { role: string; content: unknown }[]).filter(item => item.role === 'user').map(item => item.content), ['Earlier request', 'Build and test a page']);
  assert.deepEqual(ledger.map(item => [item.operation, item.index]), Array.from({ length: 5 }, (_, i) => [['admit', i + 1], ['settle', i + 1]]).flat());
  assert.ok(ledger.filter(item => item.operation === 'settle').every(item => item.status === 'completed'));
  assert.ok(!JSON.stringify(calls).includes(workspace().callbackToken));
  assert.ok(!JSON.stringify(calls).includes('provider-secret-not-in-sandbox'));
  assert.deepEqual(operations, ['workspace_list', 'workspace_write', 'workspace_exec', 'workspace_publish', 'snapshot']);
  assert.equal(events.at(-1)?.type, 'completed');
  assert.equal(JSON.parse(String(events.at(-1)?.text)).page, page);
  assert.equal(events.filter(event => event.type === 'text_delta').length, 0);
});

test('a model call may wait for its first byte as long as the runtime says, not the SDK default of 10 minutes', { timeout: 20_000 }, async t => {
  // Bedrock answers a Claude call only once the model has thought: Opus 5.5's Rigs builder was cut at 600 s (2026-10-18).
  assert.ok(WORKSPACE_MODEL_TIMEOUT_MS >= 30 * 60_000);
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    if (req.url === '/api/internal/workspace-calls') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ [value.operation === 'admit' ? 'admitted' : 'settled']: true, index: value.index })); return;
    }
    // The provider says nothing for 1.2 s, then answers at once.
    await new Promise(resolve => setTimeout(resolve, 1200));
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Thought it over.' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`); res.end();
  });
  const base = await listening(server); t.after(() => { server.closeAllConnections(); server.close(); });
  const run = (modelTimeoutMs: number) => executeWorkspaceAgent({ request: { prompt: 'Think, then answer', messages: [],
    workspace: { ...workspace(`${base}/api/internal/workspace-calls`), outputFields: [] } },
    modelConfig: { model: 'fixture', apiKey: 'fixture', baseURL: `${base}/v1`, protocol: 'chat_completions', contextWindow: 65_536, maxTokens: 4096 },
    signal: new AbortController().signal, emit: async () => undefined, modelTimeoutMs,
    broker: async name => { if (name === 'snapshot') return snapshot(); throw new Error('unexpected tool'); } });
  await assert.rejects(run(400), (error: unknown) => classifyError(error).code === 'DEADLINE_EXCEEDED');
  await run(10_000);
});

test('denied admission never reaches the provider or sandbox', { timeout: 10_000 }, async t => {
  let providerCalls = 0;
  const server = createServer((req, res) => { if (req.url !== '/api/internal/workspace-calls') providerCalls++; res.writeHead(403); res.end('{}'); });
  const base = await listening(server); t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(executeWorkspaceAgent({ request: { prompt: 'test', messages: [], workspace: workspace(`${base}/api/internal/workspace-calls`) },
    modelConfig: { model: 'fixture', apiKey: 'fixture', baseURL: `${base}/v1`, protocol: 'chat_completions', contextWindow: 65_536, maxTokens: 4096 },
    signal: new AbortController().signal, emit: async () => undefined, broker: async () => { throw new Error('should not execute'); } }), /authorized|recorded/);
  assert.equal(providerCalls, 0);
});
