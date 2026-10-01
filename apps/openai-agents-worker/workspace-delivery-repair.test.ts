import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { compileWorkspaceDelivery, executeWorkspaceAgent } from './workspace-runtime.ts';
import { classifyError } from './errors.mjs';
import type { OutputField } from './workspace-protocol.ts';

const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const, byteLength: Buffer.byteLength(content), sha256: checksum(content) });
type Step = { text: string } | { name: string; args: Record<string, string> };

async function fixture(t: TestContext, steps: Step[], fields: OutputField[], options: { maxCalls?: number; denyIndex?: number } = {}) {
  const provider: Record<string, unknown>[] = [], ledger: Record<string, unknown>[] = [], events: Record<string, unknown>[] = [], operations: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body) as Record<string, unknown>;
    if (req.url === '/api/internal/workspace-calls') {
      ledger.push(value);
      if (value.operation === 'admit' && value.index === options.denyIndex) { res.writeHead(403); res.end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ index: value.index, [value.operation === 'admit' ? 'admitted' : 'settled']: true })); return;
    }
    provider.push(value);
    const step = steps[provider.length - 1];
    // An unexpected extra request is counted and fails immediately rather than
    // silently handing the implementation an unlimited mock response sequence.
    if (!step) { res.writeHead(500); res.end('unexpected model request'); return; }
    res.setHeader('content-type', 'text/event-stream');
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'repair_' + provider.length, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant', ...('text' in step ? { content: step.text } : { tool_calls: [{ index: 0, id: 'tool_' + provider.length, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }) }, null);
    send({}, 'text' in step ? 'stop' : 'tool_calls');
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const run = () => executeWorkspaceAgent({
    request: { prompt: 'Complete the original authorized project, retain these exact requirements.', messages: [], workspace: { version: 1, id: 'b'.repeat(64), maxModelCalls: options.maxCalls ?? 8, callbackURL: `${origin}/api/internal/workspace-calls`, callbackToken: 'repair-callback-fixture-secret', inputs: [], outputFields: fields } },
    modelConfig: { model: 'fixture', apiKey: 'fixture', baseURL: `${origin}/v1`, protocol: 'chat_completions', contextWindow: 65_536, maxTokens: 4096 },
    signal: new AbortController().signal,
    emit: async event => { events.push(event); },
    broker: async (name, args) => {
      operations.push(name);
      if (name === 'workspace_list') return [{ name: 'actual.txt', type: 'file' }];
      if (name === 'workspace_publish') { assert.equal(args.path, 'actual.txt'); return file('actual.txt', 'actual verified project bytes'); }
      if (name === 'snapshot') return file('workspace.zip', 'snapshot fixture');
      throw new Error('unexpected broker operation');
    },
  });
  return { run, provider, ledger, events, operations };
}

const countFields: OutputField[] = [{ id: 'count', type: 'number', required: true }];
const fileFields: OutputField[] = [{ id: 'bundle', type: 'file', required: true }];
const invalid = { text: '{"count":"not a number"}' };
function assertPaidCalls(state: Awaited<ReturnType<typeof fixture>>, count: number) {
  assert.equal(state.provider.length, count);
  assert.deepEqual(state.ledger.map(value => [value.operation, value.index]), Array.from({ length: count }, (_, i) => [['admit', i + 1], ['settle', i + 1]]).flat());
  assert.ok(state.ledger.filter(value => value.operation === 'settle').every(value => value.status === 'completed'));
  assert.ok(!JSON.stringify(state.provider).includes('repair-callback-fixture-secret'));
}

test('natural final prose fills only the single remaining narrative field alongside verified deliveries', () => {
  const fields: OutputField[] = [{ id: 'page', type: 'html', required: true }, { id: 'bundle', type: 'file', required: true }, { id: 'handoff', type: 'markdown', required: true }];
  const published = new Map([['page', file('index.html', '<!doctype html><title>Actual page</title>')], ['bundle', file('main.ts', 'console.log(1)')]]);
  const result = JSON.parse(compileWorkspaceDelivery('Actual check: node main.ts exited 0.', fields, published));
  assert.equal(result.page, published.get('page')?.content);
  assert.equal(Buffer.from(result.bundle.content, 'base64').toString(), published.get('bundle')?.content);
  assert.equal(result.handoff, 'Actual check: node main.ts exited 0.');
  assert.throws(() => compileWorkspaceDelivery('   ', fields, published));
  assert.throws(() => compileWorkspaceDelivery('Here is the missing archive.', fileFields, new Map()));
  assert.throws(() => compileWorkspaceDelivery('Unbound fields cannot be guessed.', fields, new Map()));
});

test('one invalid final is repaired with the same history and separately admitted model call', async t => {
  const state = await fixture(t, [invalid, { text: '{"count":7}' }], countFields);
  await state.run(); assertPaidCalls(state, 2);
  assert.equal(state.events.at(-1)?.type, 'completed');
  assert.equal(JSON.parse(String(state.events.at(-1)?.text)).count, 7);
  const repairMessages = state.provider[1].messages as { role: string; content: unknown }[];
  assert.ok(repairMessages.some(item => item.role === 'assistant' && (item.content === invalid.text
    || (Array.isArray(item.content) && item.content.some(part => part && typeof part === 'object' && 'text' in part && part.text === invalid.text)))));
  assert.ok(JSON.stringify(repairMessages).includes('original authorized project'));
  assert.ok(JSON.stringify(repairMessages).includes('final delivery was rejected'));
  assert.deepEqual(state.operations, ['snapshot']);
});

test('a second invalid final fails honestly without a third repair or completion', async t => {
  const state = await fixture(t, [invalid, invalid], countFields);
  await assert.rejects(state.run(), { code: 'OUTPUT_CONTRACT_INVALID' });
  assertPaidCalls(state, 2);
  assert.deepEqual(state.operations, []); assert.equal(state.events.some(event => event.type === 'completed'), false);
});

test('repair cannot invent required file bytes or satisfy publication with a path placeholder', async t => {
  const fake = { text: '{"bundle":{"name":"fake.zip","content":"invented","encoding":"base64"}}' };
  const state = await fixture(t, [fake, { text: '{"bundle":"actual.txt"}' }], fileFields);
  await assert.rejects(state.run(), { code: 'WORKSPACE_FILE_INVALID' });
  assertPaidCalls(state, 2); assert.deepEqual(state.operations, []);
  assert.equal(state.events.some(event => event.type === 'completed'), false);
});

test('repair may publish an existing real file before its single corrected final', async t => {
  const state = await fixture(t, [{ text: '{"bundle":""}' }, { name: 'workspace_publish', args: { field: 'bundle', path: 'actual.txt' } }, { text: '{"bundle":""}' }], fileFields);
  await state.run(); assertPaidCalls(state, 3);
  assert.deepEqual(state.operations, ['workspace_publish', 'snapshot']);
  const delivery = JSON.parse(String(state.events.at(-1)?.text));
  assert.equal(delivery.bundle.name, 'actual.txt'); assert.equal(Buffer.from(delivery.bundle.content, 'base64').toString(), 'actual verified project bytes');
});

test('an invalid final at the global call limit cannot start or bill a repair', async t => {
  const state = await fixture(t, [{ name: 'workspace_list', args: { path: '.' } }, invalid], countFields, { maxCalls: 2 });
  await assert.rejects(state.run(), { code: 'OUTPUT_CONTRACT_INVALID' });
  assertPaidCalls(state, 2); assert.deepEqual(state.operations, ['workspace_list']);
  assert.equal(state.events.some(event => event.type === 'completed'), false);
});

test('tools used during final repair still consume the original global call budget', async t => {
  const state = await fixture(t, [invalid, { name: 'workspace_list', args: { path: '.' } }, { name: 'workspace_list', args: { path: '.' } }], countFields, { maxCalls: 3 });
  await assert.rejects(state.run()); assertPaidCalls(state, 3);
  assert.deepEqual(state.operations, ['workspace_list', 'workspace_list']);
  assert.equal(state.events.some(event => event.type === 'completed'), false);
});

test('denied repair admission never makes an unpaid extra provider request', async t => {
  const state = await fixture(t, [invalid], countFields, { denyIndex: 2 });
  await assert.rejects(state.run(), { code: 'WORKSPACE_ADMISSION_FAILED' });
  assert.equal(state.provider.length, 1);
  assert.deepEqual(state.ledger.map(value => [value.operation, value.index]), [['admit', 1], ['settle', 1], ['admit', 2]]);
  assert.deepEqual(state.operations, []); assert.equal(state.events.some(event => event.type === 'completed'), false);
});

test('a 32-call project loop completes with one admission and settlement per model call', { timeout: 15_000 }, async t => {
  const steps: Step[] = [...Array.from({ length: 31 }, () => ({ name: 'workspace_list', args: { path: '.' } })), { text: '{"count":32}' }];
  const state = await fixture(t, steps, countFields, { maxCalls: 32 });
  await state.run(); assertPaidCalls(state, 32);
  assert.equal(state.events.at(-1)?.type, 'completed');
  assert.equal(JSON.parse(String(state.events.at(-1)?.text)).count, 32);
  assert.equal(state.operations.filter(name => name === 'workspace_list').length, 31);
  assert.equal(state.operations.at(-1), 'snapshot');
});

for (const maxCalls of [32, 64]) test(`call ${maxCalls + 1} is refused without provider traffic or admission after a ${maxCalls}-call budget`, { timeout: 15_000 }, async t => {
  const steps: Step[] = Array.from({ length: maxCalls }, () => ({ name: 'workspace_list', args: { path: '.' } }));
  const state = await fixture(t, steps, countFields, { maxCalls });
  await assert.rejects(state.run(), (error: unknown) => {
    assert.equal(classifyError(error).code, 'MODEL_CALL_LIMIT'); return true;
  });
  assertPaidCalls(state, maxCalls);
  assert.equal(state.operations.length, maxCalls);
  assert.equal(state.events.some(event => event.type === 'completed'), false);
  assert.equal(state.ledger.some(event => Number(event.index) > maxCalls), false);
});
