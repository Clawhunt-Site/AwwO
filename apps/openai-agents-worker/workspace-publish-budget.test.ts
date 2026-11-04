import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { completedEventBytes, deliveredBytes, EVENT_FRAMING_BYTES, executeWorkspaceAgent, FINAL_FIELDS_BYTES, NEXT_FILE_BYTES,
  PUBLISH_BUDGET_BYTES, PUBLISH_FILE_BUDGET, SNAPSHOT_EVENT_BYTES, withShortLastReply } from './workspace-runtime.ts';
import { WORKSPACE_BODY_BYTES, WORKSPACE_FILE_BYTES, type OutputField } from './workspace-protocol.ts';

// A delivery's published files must fit the completed event the worker writes in one piece (16 MiB with the snapshot):
// seven renders and models of up to 2 MiB each passed every publish and then lost a Blender run its whole delivery at
// the end (OUTPUT_LIMIT, 2026-11-04). A publish past the budget is refused while the agent can still shrink its files,
// and a final reply whose own fields would still overflow the event gets one correction.

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const binary = (path: string, bytes: number) => {
  const content = Buffer.alloc(bytes, 7);
  return { path, content: content.toString('base64'), encoding: 'base64' as const, byteLength: content.length, sha256: sha256(content) };
};
const text = (path: string, content: string) =>
  ({ path, content, encoding: 'utf8' as const, byteLength: Buffer.byteLength(content), sha256: sha256(Buffer.from(content)) });
const NEAR_LIMIT = 2_000_000; // just under a file's 2 MiB
type Step = { text: string } | { name: string; args: Record<string, string> };
const publish = (field: string, path: string): Step => ({ name: 'workspace_publish', args: { field, path } });
// The largest snapshot a run can carry, for measuring the event as server.mjs writes it.
const LARGEST_SNAPSHOT = { name: 'workspace.zip', encoding: 'base64', content: 'A'.repeat(Math.ceil(WORKSPACE_FILE_BYTES / 3) * 4), sha256: 'f'.repeat(64) };
const wireBytes = (event: Record<string, unknown>) => Buffer.byteLength(`data: ${JSON.stringify({ ...event, workspaceSnapshot: LARGEST_SNAPSHOT })}\n\n`);

async function fixture(t: TestContext, steps: Step[], fields: OutputField[], files: Record<string, ReturnType<typeof binary>>, maxCalls = steps.length + 2,
  options: { contextWindow?: number; maxTokens?: number; prompt?: string } = {}) {
  const provider: Record<string, unknown>[] = [], events: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body) as Record<string, unknown>;
    if (req.url === '/api/internal/workspace-calls') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ index: value.index, [value.operation === 'admit' ? 'admitted' : 'settled']: true })); return;
    }
    provider.push(value);
    const step = steps[provider.length - 1];
    if (!step) { res.writeHead(500); res.end('unexpected model request'); return; }
    res.setHeader('content-type', 'text/event-stream');
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: 'budget_' + provider.length, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant', ...('text' in step ? { content: step.text } : { tool_calls: [{ index: 0, id: 'tool_' + provider.length, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }) }, null);
    send({}, 'text' in step ? 'stop' : 'tool_calls');
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let error: unknown;
  try {
    await executeWorkspaceAgent({
      request: { prompt: options.prompt ?? 'Render the collection and publish every file.', messages: [], workspace: { version: 1, id: 'c'.repeat(64), maxModelCalls: maxCalls, callbackURL: `${origin}/api/internal/workspace-calls`, callbackToken: 'budget-callback-fixture-secret', inputs: [], outputFields: fields } },
      modelConfig: { model: 'fixture', apiKey: 'fixture', baseURL: `${origin}/v1`, protocol: 'chat_completions', contextWindow: options.contextWindow ?? 65_536, maxTokens: options.maxTokens ?? 4096 },
      signal: new AbortController().signal,
      emit: async event => { events.push(event); },
      broker: async (name, args) => {
        if (name === 'workspace_publish') { const file = files[String(args.path)]; assert.ok(file, `no fixture file ${args.path}`); return file; }
        if (name === 'snapshot') return text('workspace.zip', 'snapshot fixture');
        throw new Error(`unexpected broker operation ${name}`);
      },
    });
  } catch (caught) { error = caught; }
  // What each tool call answered, and the user turns the run added, as the model read them on its later requests.
  const messages = provider.flatMap(request => request.messages as { role: string; content: unknown }[]);
  const toolResults = [...new Set(messages.filter(message => message.role === 'tool').map(message => String(message.content)))];
  const userTurns = [...new Set(messages.filter(message => message.role === 'user').map(message => String(message.content)))];
  return { provider, events, toolResults, userTurns, error, completed: events.find(event => event.type === 'completed') };
}

const fileFields = (count: number, optional: readonly string[] = []): OutputField[] =>
  Array.from({ length: count }, (_, i) => ({ id: `f${i + 1}`, type: 'file', required: !optional.includes(`f${i + 1}`) }));
const finalReply = (ids: readonly string[], extra: Record<string, string> = {}): Step => ({ text: JSON.stringify({ ...Object.fromEntries(ids.map(id => [id, ''])), ...extra }) });

test('the publish budget is what one completed event holds beside the largest snapshot and the final reply', () => {
  assert.equal(PUBLISH_BUDGET_BYTES, WORKSPACE_BODY_BYTES - SNAPSHOT_EVENT_BYTES - FINAL_FIELDS_BYTES - EVENT_FRAMING_BYTES);
  assert.ok(SNAPSHOT_EVENT_BYTES >= LARGEST_SNAPSHOT.content.length);
  assert.equal((PUBLISH_FILE_BUDGET / 1024 / 1024).toFixed(1), '9.2');
  const file: OutputField = { id: 'model', type: 'file', required: true };
  const ring = binary('out/ring.glb', 3);
  // A file's entry as compileWorkspaceDelivery writes it (its name, not its path), escaped twice, with a comma.
  assert.equal(deliveredBytes(file, ring), Buffer.byteLength(JSON.stringify(JSON.stringify({ model: { name: 'ring.glb', content: ring.content, encoding: 'base64' } }))) + 2);
  assert.equal(deliveredBytes(file, { ...ring, path: `${'d'.repeat(200)}/${'e'.repeat(200)}/ring.glb` }), deliveredBytes(file, ring));
  // A text field is escaped twice: once in the delivery, once as the event's string.
  const notes: OutputField = { id: 'notes', type: 'markdown', required: true };
  const quoted = '"a\\b"';
  assert.equal(deliveredBytes(notes, text('notes.md', quoted)), Buffer.byteLength(JSON.stringify(JSON.stringify({ notes: quoted }))) + 2);
  assert.ok(deliveredBytes(notes, text('notes.md', quoted)) > Buffer.byteLength(quoted) * 2);
  // The receipt's reserve covers the largest name a workspace path can end in (255 quotes) and a 64-character id.
  const worst = { ...binary('x', 3), path: '"'.repeat(255) };
  const room = deliveredBytes({ id: 'f'.repeat(64), type: 'file', required: true }, worst) - Math.ceil(3 / 3) * 4;
  assert.ok(room <= NEXT_FILE_BYTES, `a worst-case entry takes ${room} bytes beside its content`);
  assert.equal(completedEventBytes('ab'), JSON.stringify('ab').length + SNAPSHOT_EVENT_BYTES + EVENT_FRAMING_BYTES);
});

test('a publish that would overflow the delivery is refused, the model is told, and a smaller file then fits', async t => {
  const files = { 'out/a.png': binary('out/a.png', NEAR_LIMIT), 'out/b.png': binary('out/b.png', NEAR_LIMIT), 'out/c.png': binary('out/c.png', NEAR_LIMIT),
    'out/d.png': binary('out/d.png', NEAR_LIMIT), 'out/e.png': binary('out/e.png', NEAR_LIMIT), 'out/e.jpg': binary('out/e.jpg', 300_000) };
  const steps: Step[] = [publish('f1', 'out/a.png'), publish('f2', 'out/b.png'), publish('f3', 'out/c.png'), publish('f4', 'out/d.png'),
    publish('f5', 'out/e.png'), publish('f5', 'out/e.jpg'), finalReply(['f1', 'f2', 'f3', 'f4', 'f5'])];
  const { toolResults, completed, error } = await fixture(t, steps, fileFields(5), files);
  assert.equal(error, undefined);
  const refusal = toolResults.find(result => result.includes('Not published'));
  assert.ok(refusal, 'the fifth near-2 MiB file is refused');
  assert.match(refusal, /out\/e\.png/);
  assert.match(refusal, /9\.2 MiB/);
  assert.match(refusal, /replaces it and frees room/);
  // Receipts say how much room is left; the four files before the refusal are kept.
  const receipts = toolResults.filter(result => result.includes('"published"')).map(result => JSON.parse(result));
  assert.deepEqual(receipts.map(receipt => receipt.published), ['f1', 'f2', 'f3', 'f4', 'f5']);
  assert.ok(receipts.every(receipt => Number.isSafeInteger(receipt.deliveryRoomBytes) && receipt.deliveryRoomBytes >= 0));
  assert.ok(receipts[1].deliveryRoomBytes < receipts[0].deliveryRoomBytes);
  assert.ok(completed, 'the run completes');
  const delivery = JSON.parse(String(completed.text));
  assert.equal(delivery.f5.name, 'e.jpg');
  assert.deepEqual(Object.keys(delivery).sort(), ['f1', 'f2', 'f3', 'f4', 'f5']);
  assert.ok(wireBytes(completed) <= WORKSPACE_BODY_BYTES);
});

test('a field published again counts only its last file, so a smaller one frees room for another', async t => {
  const files = { 'out/a.png': binary('out/a.png', NEAR_LIMIT), 'out/b.png': binary('out/b.png', NEAR_LIMIT), 'out/c.png': binary('out/c.png', NEAR_LIMIT),
    'out/d.png': binary('out/d.png', NEAR_LIMIT), 'out/a.jpg': binary('out/a.jpg', 200_000), 'out/e.png': binary('out/e.png', NEAR_LIMIT) };
  const steps: Step[] = [publish('f1', 'out/a.png'), publish('f2', 'out/b.png'), publish('f3', 'out/c.png'), publish('f4', 'out/d.png'),
    publish('f1', 'out/a.jpg'), publish('f5', 'out/e.png'), finalReply(['f1', 'f2', 'f3', 'f4', 'f5'])];
  const { toolResults, completed } = await fixture(t, steps, fileFields(5), files);
  assert.equal(toolResults.filter(result => result.includes('Not published')).length, 0);
  const delivery = JSON.parse(String(completed?.text));
  assert.equal(delivery.f1.name, 'a.jpg');
  assert.equal(delivery.f5.name, 'e.png');
});

test('a refused replacement leaves the field its earlier file', async t => {
  const files = { 'out/a.jpg': binary('out/a.jpg', 100_000), 'out/b.png': binary('out/b.png', NEAR_LIMIT), 'out/c.png': binary('out/c.png', NEAR_LIMIT),
    'out/d.png': binary('out/d.png', NEAR_LIMIT), 'out/e.png': binary('out/e.png', NEAR_LIMIT), 'out/a.png': binary('out/a.png', NEAR_LIMIT) };
  const steps: Step[] = [publish('f1', 'out/a.jpg'), publish('f2', 'out/b.png'), publish('f3', 'out/c.png'), publish('f4', 'out/d.png'),
    publish('f5', 'out/e.png'), publish('f1', 'out/a.png'), finalReply(['f1', 'f2', 'f3', 'f4', 'f5'])];
  const { toolResults, completed } = await fixture(t, steps, fileFields(5), files);
  assert.equal(toolResults.filter(result => result.includes('Not published')).length, 1);
  assert.match(toolResults.find(result => result.includes('Not published')) ?? '', /out\/a\.png/);
  assert.equal(JSON.parse(String(completed?.text)).f1.name, 'a.jpg');
});

test('a final reply whose own fields would overflow the event gets one correction, then fits', async t => {
  // Four whole 2 MiB files and a fifth that leaves well under 100 KB of the publish budget.
  const full = (path: string) => binary(path, WORKSPACE_FILE_BYTES);
  const four = ['out/a.png', 'out/b.png', 'out/c.png', 'out/d.png'];
  const used = four.reduce((sum, path, i) => sum + deliveredBytes({ id: `f${i + 1}`, type: 'file', required: true }, full(path)), 0);
  const fifth = Math.floor((PUBLISH_BUDGET_BYTES - used - 100_000) / 4) * 3;
  const files = { ...Object.fromEntries(four.map(path => [path, full(path)])), 'out/e.png': binary('out/e.png', fifth) };
  const fields: OutputField[] = [...fileFields(5), { id: 'notes', type: 'markdown', required: true }];
  const ids = ['f1', 'f2', 'f3', 'f4', 'f5'];
  const steps: Step[] = [...four.map((path, i) => publish(`f${i + 1}`, path)), publish('f5', 'out/e.png'),
    finalReply(ids, { notes: 'x'.repeat(1_200_000) }), finalReply(ids, { notes: 'Five files, checked.' })];
  const { provider, toolResults, userTurns, completed, error } = await fixture(t, steps, fields, files);
  assert.equal(error, undefined);
  assert.equal(toolResults.filter(result => result.includes('Not published')).length, 0, 'the five files fit the budget');
  assert.ok(userTurns.some(turn => turn.includes('was not sent')), 'the overflowing reply is sent back once');
  // The correction carries an excerpt of the overflowing reply, not the reply: whole, it would overflow the context.
  const corrected = JSON.stringify(provider.at(-1));
  assert.ok(corrected.includes('is not repeated') && Buffer.byteLength(corrected) < 200_000);
  assert.ok(completed);
  assert.equal(JSON.parse(String(completed.text)).notes, 'Five files, checked.');
  assert.ok(completedEventBytes(String(completed.text)) <= WORKSPACE_BODY_BYTES);
  assert.ok(wireBytes(completed) <= WORKSPACE_BODY_BYTES);
});

test('a final reply that still overflows after its correction fails as an output limit', async t => {
  const full = (path: string) => binary(path, WORKSPACE_FILE_BYTES);
  const four = ['out/a.png', 'out/b.png', 'out/c.png', 'out/d.png'];
  const files = Object.fromEntries(four.map(path => [path, full(path)]));
  const fields: OutputField[] = [...fileFields(4), { id: 'notes', type: 'markdown', required: true }];
  const ids = ['f1', 'f2', 'f3', 'f4'];
  const long = finalReply(ids, { notes: 'x'.repeat(3_000_000) });
  const { completed, error } = await fixture(t, [...four.map((path, i) => publish(`f${i + 1}`, path)), long, long], fields, files);
  assert.equal(completed, undefined);
  assert.equal((error as { code?: string })?.code, 'OUTPUT_LIMIT');
});

test('a run that ends its steps after a refusal still delivers what it published when the refused field is optional', async t => {
  const files = { 'out/a.png': binary('out/a.png', NEAR_LIMIT), 'out/b.png': binary('out/b.png', NEAR_LIMIT), 'out/c.png': binary('out/c.png', NEAR_LIMIT),
    'out/d.png': binary('out/d.png', NEAR_LIMIT), 'out/e.png': binary('out/e.png', NEAR_LIMIT) };
  // The fifth publish is refused and tried once more; the run then has no step left. (A tool's answer shows in the
  // model's next request, so the last one is never seen there: the first refusal is.)
  const steps: Step[] = [publish('f1', 'out/a.png'), publish('f2', 'out/b.png'), publish('f3', 'out/c.png'), publish('f4', 'out/d.png'),
    publish('f5', 'out/e.png'), publish('f5', 'out/e.png')];
  const { toolResults, completed, error } = await fixture(t, steps, fileFields(5, ['f5']), files, steps.length);
  assert.equal(error, undefined);
  assert.equal(toolResults.filter(result => result.includes('Not published')).length, 1);
  assert.ok(completed);
  assert.deepEqual(Object.keys(JSON.parse(String(completed.text))).sort(), ['f1', 'f2', 'f3', 'f4']);
});

const fullFiles = (paths: readonly string[]) => Object.fromEntries(paths.map(path => [path, binary(path, WORKSPACE_FILE_BYTES)]));
const FOUR = ['out/1.png', 'out/2.png', 'out/3.png', 'out/4.png'];
const publishFour = FOUR.map((path, i) => publish(`f${i + 1}`, path));
const withCount: OutputField[] = [...fileFields(4), { id: 'notes', type: 'markdown', required: true }, { id: 'count', type: 'number', required: true }];
const reply = (fields: Record<string, unknown>): Step => ({ text: JSON.stringify({ f1: '', f2: '', f3: '', f4: '', ...fields }) });

for (const path of ['out/e.png', `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}/e.png`]) {
  test(`a file of exactly the room a receipt reports still fits (a path of ${path.length} characters)`, async t => {
    const used = FOUR.reduce((sum, item, i) => sum + deliveredBytes({ id: `f${i + 1}`, type: 'file', required: true }, binary(item, WORKSPACE_FILE_BYTES)), 0);
    const room = Math.floor((PUBLISH_BUDGET_BYTES - used - NEXT_FILE_BYTES) / 4) * 3;
    const files = { ...fullFiles(FOUR), [path]: binary(path, room) };
    const { toolResults, completed } = await fixture(t, [...publishFour, publish('f5', path), finalReply(['f1', 'f2', 'f3', 'f4', 'f5'])], fileFields(5), files);
    const receipts = toolResults.filter(result => result.includes('"published"')).map(result => JSON.parse(result));
    assert.equal(receipts[3].deliveryRoomBytes, room);
    assert.equal(receipts[4]?.published, 'f5', 'the file the receipt made room for is published');
    assert.equal(JSON.parse(String(completed?.text)).f5.name, 'e.png');
  });
}

test('the final reply is cut as a whole: several assistant messages and a trailing reasoning item become one excerpt', () => {
  const big = 'y'.repeat(1_200_000);
  const before = [{ role: 'user', content: 'Render it.' }, { type: 'function_call_result', callId: 'c1', output: 'ok' }];
  // Responses ids on every item: the reasoning item goes, so no message may carry its old id (the API refuses it).
  const history = [...before,
    { type: 'reasoning', id: 'rs_1', content: [{ type: 'input_text', text: 'z'.repeat(50_000) }] },
    { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: big }], providerData: { k: 1 } },
    { type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"count":' }] },
    { type: 'reasoning', id: 'rs_2', content: [{ type: 'input_text', text: 'z'.repeat(50_000) }] }] as unknown as AgentInputItem[];
  const cut = withShortLastReply(history);
  assert.deepEqual(cut.slice(0, 2), before, 'what came before the final reply stays');
  assert.equal(cut.length, 3);
  const text = JSON.stringify(cut[2]);
  assert.ok(text.includes('is not repeated') && Buffer.byteLength(text) < 1_400);
  assert.deepEqual(Object.keys(cut[2] as object).sort(), ['content', 'role', 'status', 'type']);
  // The excerpt is bounded in bytes, cut at a character: 3,000 CJK characters are 9,000 bytes.
  const cjk = withShortLastReply([...before, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '中'.repeat(3000) }] }] as unknown as AgentInputItem[]);
  const excerpt = ((cjk[2] as { content: { text: string }[] }).content[0]).text;
  assert.ok(Buffer.byteLength(excerpt) < 1_100 && excerpt.startsWith('中'.repeat(341)) && !excerpt.includes('�'));
  // A small final reply, and a history that ends in a tool result, come back unchanged.
  const small = [...before, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"count":' }] }] as unknown as AgentInputItem[];
  assert.equal(withShortLastReply(small), small);
  assert.equal(withShortLastReply(before as unknown as AgentInputItem[]), before);
});

test('a malformed reply corrected into one that overflows fails as an output limit', async t => {
  const { completed, error } = await fixture(t, [...publishFour, reply({ notes: 'short' }), reply({ count: 3, notes: 'x'.repeat(3_000_000) })], withCount, fullFiles(FOUR));
  assert.equal(completed, undefined);
  assert.equal((error as { code?: string })?.code, 'OUTPUT_LIMIT');
});

test('an overflowing reply corrected into a malformed one fails as a contract error', async t => {
  const { completed, error } = await fixture(t, [...publishFour, reply({ count: 3, notes: 'x'.repeat(3_000_000) }), reply({ notes: 'short' })], withCount, fullFiles(FOUR));
  assert.equal(completed, undefined);
  assert.equal((error as { code?: string })?.code, 'OUTPUT_CONTRACT_INVALID');
});

test('a reply that overflows on the last permitted call fails at once, with no further request', async t => {
  const steps = [...publishFour, reply({ count: 3, notes: 'x'.repeat(3_000_000) })];
  const { provider, completed, error } = await fixture(t, steps, withCount, fullFiles(FOUR), steps.length);
  assert.equal(completed, undefined);
  assert.equal((error as { code?: string })?.code, 'OUTPUT_LIMIT');
  assert.equal(provider.length, steps.length);
});

test('a malformed CJK reply in a small context is corrected, its excerpt bounded in bytes', async t => {
  // Codex's round-4 case: a 32,768-token context, 4,096 max tokens, a 20,192-character prompt; 3,000 CJK characters
  // (9,000 bytes) cut at 2,048 characters still overflowed the correction request (32,265 bytes of 28,416).
  const fields: OutputField[] = [{ id: 'notes', type: 'text', required: true }, { id: 'count', type: 'number', required: true }];
  const steps: Step[] = [{ text: JSON.stringify({ notes: '中'.repeat(3000) }) }, { text: JSON.stringify({ notes: 'ok', count: 3 }) }];
  const { completed, error, provider } = await fixture(t, steps, fields, {}, 4, { contextWindow: 32_768, maxTokens: 4096, prompt: 'p'.repeat(20_192) });
  assert.equal(error, undefined);
  assert.equal(provider.length, 2, 'the correction reaches the model');
  assert.equal(JSON.parse(String(completed?.text)).count, 3);
});

test('a 3 KB malformed reply in a small context is cut too, and corrected', async t => {
  // Codex's round-5 case: under a 4 KiB threshold this reply went back whole and the correction did not fit.
  const fields: OutputField[] = [{ id: 'notes', type: 'text', required: true }, { id: 'count', type: 'number', required: true }];
  const steps: Step[] = [{ text: JSON.stringify({ notes: 'x'.repeat(3000) }) }, { text: JSON.stringify({ notes: 'ok', count: 3 }) }];
  const { completed, error, provider } = await fixture(t, steps, fields, {}, 4, { contextWindow: 32_768, maxTokens: 4096, prompt: 'p'.repeat(20_192) });
  assert.equal(error, undefined);
  assert.equal(provider.length, 2, 'the correction reaches the model');
  assert.equal(JSON.parse(String(completed?.text)).count, 3);
});

test('a large malformed reply is sent back as an excerpt, then corrected', async t => {
  const steps = [...publishFour, reply({ notes: 'x'.repeat(1_200_000) }), reply({ count: 3, notes: 'Four files.' })];
  const { provider, completed, error } = await fixture(t, steps, withCount, fullFiles(FOUR));
  assert.equal(error, undefined);
  const corrected = JSON.stringify(provider.at(-1));
  assert.ok(corrected.includes('is not repeated') && Buffer.byteLength(corrected) < 200_000);
  assert.equal(JSON.parse(String(completed?.text)).count, 3);
});
