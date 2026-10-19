import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ManagedRun } from './runtime.ts';
import { WORKER_DIR, loadConfig } from './config.ts';
import { PATCH_VERSION, UPSTREAM_REVISION } from './setup.ts';
import { closeServer, createTransport, listenLocal } from './transport.ts';
import { hash, json, readJSON, record, type RunRequest, type WorkerEvent } from './protocol.ts';
import type { WorkspaceRead, WorkspaceSandbox } from '../openai-agents-worker/workspace-sandbox.ts';

// 2026-10-18: the broker paired the core's approval cards with captured tool calls first-in-first-out by tool name. A
// call the core refused before any card (arguments outside its tool's schema), or one too large to capture, shifted
// every later card of that tool onto another call's arguments: the card showed, and the API allowed, arguments that
// were not the ones the core then ran. The pairing rules alone are in approval.test.ts.

// The whole broker against a core: approval-pairing's stand-in (fake-core.mjs) by default, or the real pinned core when
// AWWO_OPENMAUS_TEST_CORE names its built dist-server/index.js (Node 24, after `npm run setup`). The workspace is a stand-in
// that records what ran, so no Docker is needed.
const realCore = process.env.AWWO_OPENMAUS_TEST_CORE;
type Step = { content?: string; calls?: Array<{ id: string; name: string; arguments: unknown }> };
async function broker(steps: Step[], instructions = '') {
  const received: Array<Record<string, unknown>> = [];
  let round = 0;
  const model = createServer(async (req, res) => {
    const body = await readJSON(req); assert.ok(record(body)); received.push(body);
    const step = steps[round++] ?? { content: 'Done.' };
    const calls = step.calls?.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } }));
    json(res, 200, { id: 'fixture', object: 'chat.completion', model: 'awwo-model', choices: [{ index: 0, finish_reason: calls ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: step.content ?? null, ...(calls ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  const dir = await mkdtemp(join(tmpdir(), 'awwo-openmaus-pairing-'));
  let corePath = realCore;
  if (!corePath) {
    corePath = join(dir, 'core', 'index.mjs');
    await mkdir(dirname(corePath));
    await copyFile(join(WORKER_DIR, 'fake-core.mjs'), corePath);
    await writeFile(join(dirname(corePath), 'awwo-build.json'), JSON.stringify({ upstreamRevision: UPSTREAM_REVISION, patchVersion: PATCH_VERSION }));
  }
  const config = loadConfig({ AWWO_OPENMAUS_TOKEN: 'worker-test-token-'.repeat(3), AWWO_OPENMAUS_CORE_PATH: corePath, AWWO_OPENMAUS_DATA_DIR: join(dir, 'runs') });
  const ran: Array<[string, string]> = [];
  const file = (path: string, content: string): WorkspaceRead => ({ path, name: path, content, encoding: 'utf8', byteLength: Buffer.byteLength(content), sha256: hash(content), mimeType: 'text/plain' });
  const sandbox: WorkspaceSandbox = {
    list: async () => [], read: async path => file(path, ''), exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
    write: async (path, content) => { ran.push([path, content]); return file(path, content); },
    publish: async path => file(path, ''), archive: async () => ({ ...file('workspace.zip', ''), encoding: 'base64' }), close: async () => {},
  };
  const events: WorkerEvent[] = [];
  try {
    const request: RunRequest = { runId: 'pairing-run', tenantId: 'tenant', sessionId: 'session', prompt: 'Write the page.', instructions, modelProxyURL: await listenLocal(model) + '/v1',
      modelProxyToken: 'model-scope-token-'.repeat(3), timeoutMs: 60_000, maxModelCalls: 8, inputs: [] };
    // Every card is allowed at once, as the API's auto-allow answers a workspace tool's card (and a question is answered).
    const run: ManagedRun = new ManagedRun(request, config, event => {
      events.push(event);
      if (event.type === 'computer_approval') void run.respond({ requestId: String(event.requestId), behavior: 'allow', ...(event.kind === 'question' ? { message: 'Yes, keep both.' } : {}) }).catch(() => {});
    }, async () => sandbox);
    await run.execute();
    assert.deepEqual(await readdir(join(dir, 'runs')), [], 'the run left its data behind');
  } finally { await closeServer(model); await rm(dir, { recursive: true, force: true }); }
  const approvals = events.filter(event => event.type === 'computer_approval');
  return { approvals, ran, received, last: events.at(-1) };
}
const toolResult = (received: Array<Record<string, unknown>>, id: string) => (received.at(-1)?.messages as Array<Record<string, unknown>>).find(message => message.role === 'tool' && message.tool_call_id === id);
const env = { timeout: 60_000 };

test('a card after a call the core refused carries its own call\'s arguments, never the refused call\'s', env, async () => {
  const real = { path: 'index.html', content: '<h1>real</h1>' };
  const { approvals, ran, received, last } = await broker([{ calls: [
    { id: 'call_decoy', name: 'awwo_workspace_write', arguments: { path: 'notes.txt', content: 'decoy', mode: 'append' } },
    { id: 'call_real', name: 'awwo_workspace_write', arguments: real },
  ] }]);
  assert.equal(approvals.length, 1, JSON.stringify(approvals));
  assert.equal(approvals[0].title, 'awwo_workspace_write');
  assert.deepEqual(approvals[0].arguments, real);
  assert.deepEqual(ran, [['index.html', '<h1>real</h1>']]);
  // The core refused the decoy itself, and so (as at UPSTREAM_REVISION) gives the turn no final answer.
  assert.match(String(toolResult(received, 'call_decoy')?.content), /"ok":false/);
  assert.deepEqual(last, { type: 'failed', code: 'CORE_EXECUTION_FAILED', message: 'OpenMaus task stopped (CORE_EXECUTION_FAILED).' });
});

test('a card for a call too large to capture stops the task, and never shows a later call\'s arguments', env, async () => {
  // 180,000 Chinese characters: within the core's 256,000 characters, over the broker's 512 KiB of UTF-8.
  const { approvals, ran, last } = await broker([{ calls: [
    { id: 'call_big', name: 'awwo_workspace_write', arguments: { path: 'big.txt', content: '中'.repeat(180_000) } },
    { id: 'call_real', name: 'awwo_workspace_write', arguments: { path: 'index.html', content: '<h1>real</h1>' } },
  ] }]);
  assert.deepEqual(approvals, []);
  assert.deepEqual(ran, []);
  assert.deepEqual(last, { type: 'failed', code: 'APPROVAL_ARGUMENTS_UNAVAILABLE', message: 'OpenMaus task stopped (APPROVAL_ARGUMENTS_UNAVAILABLE).' });
});

test('calls of one answer get their own cards in order, a question shows its own questions, and the task completes', env, async () => {
  const question = { questions: [{ question: 'Keep both files?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
  const { approvals, ran, received, last } = await broker([{ calls: [
    { id: 'call_a', name: 'awwo_workspace_write', arguments: { path: 'a.txt', content: 'one' } },
    { id: 'call_ask', name: 'ask_user', arguments: question },
    { id: 'call_b', name: 'awwo_workspace_write', arguments: { path: 'b.txt', content: 'two' } },
  ] }, { content: 'Wrote a.txt and b.txt.' }]);
  assert.deepEqual(approvals.map(event => [event.kind, event.arguments]), [
    ['approval', { path: 'a.txt', content: 'one' }],
    ['question', { version: 1, questions: question.questions }],
    ['approval', { path: 'b.txt', content: 'two' }],
  ]);
  assert.deepEqual(ran, [['a.txt', 'one'], ['b.txt', 'two']]);
  assert.match(String(toolResult(received, 'call_ask')?.content), /Yes, keep both\./);
  assert.deepEqual(last, { type: 'completed', output: 'Wrote a.txt and b.txt.', truncated: false });
});

test('a call to a tool the core does not advertise, which leaves no activity, does not shift the next card', env, async () => {
  const real = { path: 'index.html', content: '<h1>real</h1>' };
  const { approvals, ran, last } = await broker([{ calls: [
    { id: 'call_unknown', name: 'x__ask_bot', arguments: {} },
    { id: 'call_real', name: 'awwo_workspace_write', arguments: real },
  ] }]);
  assert.deepEqual(approvals.map(event => event.arguments), [real]);
  assert.deepEqual(ran, [['index.html', '<h1>real</h1>']]);
  assert.deepEqual(last, { type: 'failed', code: 'CORE_EXECUTION_FAILED', message: 'OpenMaus task stopped (CORE_EXECUTION_FAILED).' });
});

// A core that ran a tool its card did not allow is refused by the broker itself: with no card at all, with other
// arguments than the card's, a second time on one allow, or on an allow it said it did not take or whose answer failed.
// Only the stand-in can be made to misbehave.
const misbehaviour = { skip: realCore ? 'the real core cannot misbehave' : false, timeout: 60_000 };
for (const [mode, cards, expectRan] of [['no cards', 0, []], ['tamper', 1, []], ['twice', 1, [['a.txt', 'one']]], ['unavailable', 1, []], ['refused', 1, []]] as const) {
  test(`a tool call no card allowed never runs, and stops the task (${mode})`, misbehaviour, async () => {
    const { approvals, ran, last } = await broker([{ calls: [{ id: 'call_a', name: 'awwo_workspace_write', arguments: { path: 'a.txt', content: 'one' } }] }], `[fake-core: ${mode}]`);
    assert.equal(approvals.length, cards);
    assert.deepEqual(ran, expectRan);
    assert.deepEqual(last, { type: 'failed', code: 'TOOL_CALL_NOT_ALLOWED', message: 'OpenMaus task stopped (TOOL_CALL_NOT_ALLOWED).' });
  });
}
test('cards a core opens at once are each paired with their own call', misbehaviour, async () => {
  const { approvals, ran, last } = await broker([{ calls: [
    { id: 'call_a', name: 'awwo_workspace_write', arguments: { path: 'a.txt', content: 'one' } },
    { id: 'call_b', name: 'awwo_workspace_write', arguments: { path: 'b.txt', content: 'two' } },
  ] }, { content: 'Wrote both.' }], '[fake-core: together]');
  assert.deepEqual(approvals.map(event => event.arguments), [{ path: 'a.txt', content: 'one' }, { path: 'b.txt', content: 'two' }]);
  assert.deepEqual(ran, [['a.txt', 'one'], ['b.txt', 'two']]);
  assert.deepEqual(last, { type: 'completed', output: 'Wrote both.', truncated: false });
});
test('an allowed call the core runs before it answers the allow still runs', misbehaviour, async () => {
  const { approvals, ran, last } = await broker([{ calls: [{ id: 'call_a', name: 'awwo_workspace_write', arguments: { path: 'a.txt', content: 'one' } }] }], '[fake-core: early]');
  assert.equal(approvals.length, 1);
  assert.deepEqual(ran, [['a.txt', 'one']]);
  assert.deepEqual(last, { type: 'completed', output: 'Done.', truncated: false });
});

test('the transport keeps every call of the turn\'s answers in order, and none of an answer to a call that declared no tools', async () => {
  const answers = [
    // The core's text-only helper (a summary, a memory note: generateText at UPSTREAM_REVISION) declares no tools.
    [{ id: 'ghost', type: 'function', function: { name: 'awwo_workspace_write', arguments: '{"path":"index.html","content":"ghost"}' } }],
    [{ id: 'c1', type: 'function', function: { name: 'awwo_workspace_write', arguments: '{"path":"a.txt","content":"one"}' } },
      { id: 'c2', type: 'function', function: { name: 'awwo_workspace_write', arguments: '{"path":' } },
      { id: 'c3', type: 'function', function: { name: 'awwo_workspace_exec', arguments: '["ls"]' } },
      { id: 'c4', type: 'function', function: { name: 'awwo_workspace_write', arguments: JSON.stringify({ path: 'big.txt', content: 'x'.repeat(600 * 1024) }) } },
      { id: 'c5', type: 'function' }, 'not a call'],
  ];
  let answer = 0;
  const model = createServer((_req, res) => json(res, 200, { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: answers[answer++] } }] }));
  const request: RunRequest = { runId: 'run', tenantId: 'tenant', sessionId: 'session', prompt: 'test', instructions: '', modelProxyURL: await listenLocal(model) + '/v1',
    modelProxyToken: 'scope-token-long-enough', timeoutMs: 1000, maxModelCalls: 4, inputs: [] };
  const transport = await createTransport(request, {} as WorkspaceSandbox, new AbortController().signal, () => {}, () => {});
  const ask = (tools?: unknown) => fetch(transport.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'awwo-model', messages: [{ role: 'user', content: 'task' }], ...(tools ? { tools } : {}) }) });
  try {
    assert.equal((await ask()).status, 200);
    assert.deepEqual(transport.calls, []);
    assert.equal((await ask([{ type: 'function', function: { name: 'awwo_workspace_write', parameters: { type: 'object' } } }])).status, 200);
    assert.deepEqual(transport.calls, [
      { id: 'c1', tool: 'awwo_workspace_write', arguments: { path: 'a.txt', content: 'one' } },
      { id: 'c2', tool: 'awwo_workspace_write' }, { id: 'c3', tool: 'awwo_workspace_exec' }, { id: 'c4', tool: 'awwo_workspace_write' },
      { id: 'c5', tool: '' }, { id: '', tool: '' },
    ]);
  } finally { await transport.close(); await closeServer(model); }
});
