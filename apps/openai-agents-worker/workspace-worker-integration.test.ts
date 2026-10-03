import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { configuration, request, run } from './test-support.mjs';
import { RuntimeError } from './errors.mjs';
import { createOpenAIAgentsServer } from './server.mjs';
import type { WorkspaceRequest } from './workspace-protocol.ts';

const enabled = Boolean(process.env.AWWO_TEST_WORKSPACE_IMAGE && process.env.AWWO_TEST_DOCKER_EXECUTABLE);
const checksum = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const CALLBACK_TOKEN = 'fixture-ledger-secret-must-never-reach-model';
const PROVIDER_KEY = 'fixture-provider-secret-must-never-reach-container';
type Step = { name: string; args: Record<string, string> } | { final: string; finish?: string | null } | { stall: true } | { flood: 'text' | 'arguments' };
type JsonObject = Record<string, unknown>;
type ProviderCall = { body: JsonObject; authorization: string | undefined };

async function fixture(t: TestContext, options: { steps: Step[]; denyAdmission?: number; denySettlement?: number; env?: Record<string, string> }) {
  const ledger: JsonObject[] = [], calls: ProviderCall[] = [];
  let wakeProvider: (() => void) | undefined;
  const providerStarted = new Promise<void>(resolve => { wakeProvider = resolve; });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as JsonObject;
    if (req.url === '/api/internal/workspace-calls') {
      assert.equal(req.headers.authorization, `Bearer ${CALLBACK_TOKEN}`);
      ledger.push(input);
      if ((input.operation === 'admit' && input.index === options.denyAdmission)
        || (input.operation === 'settle' && input.index === options.denySettlement)) { res.writeHead(403); res.end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ [input.operation === 'admit' ? 'admitted' : 'settled']: true, index: input.index }));
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    calls.push({ body: input, authorization: req.headers.authorization });
    wakeProvider?.();
    const step = options.steps[calls.length - 1];
    if (!step) { res.writeHead(500); res.end('{}'); return; }
    res.setHeader('content-type', 'text/event-stream');
    const send = (delta: unknown, finish: string | null) => res.write(`data: ${JSON.stringify({ id: `fixture_${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if ('stall' in step) { send({ role: 'assistant', content: 'Unfinished output' }, null); return; }
    if ('flood' in step) {
      if (step.flood === 'arguments') send({ role: 'assistant', tool_calls: [{ index: 0, id: 'oversized', type: 'function', function: { name: 'workspace_write', arguments: '{"path":"large.txt","content":"' } }] }, null);
      const fragment = 'x'.repeat(64 * 1024);
      for (let index = 0; index < 320 && !res.destroyed; index++) {
        const writable = send(step.flood === 'arguments' ? { tool_calls: [{ index: 0, function: { arguments: fragment } }] } : { content: fragment }, null);
        if (!writable) {
          const drained = await new Promise<boolean>(resolve => {
            const finish = (ok: boolean) => { res.off('drain', onDrain); res.off('close', onClose); resolve(ok); };
            const onDrain = () => finish(true), onClose = () => finish(false);
            res.once('drain', onDrain); res.once('close', onClose);
          });
          if (!drained) return;
        }
      }
      // Deliberately no completion frame: only the byte limit may terminate this response successfully.
      return;
    }
    if ('name' in step) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `tool_${calls.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }, null);
      send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: step.final }, null); if (step.finish !== null) send({}, step.finish ?? 'stop'); }
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = configuration({
    AWWO_OPENAI_AGENTS_BASE_URL: `${origin}/v1`, AWWO_OPENAI_AGENTS_API_KEY: PROVIDER_KEY,
    AWWO_OPENAI_AGENTS_CONTEXT_WINDOW: '131072', AWWO_OPENAI_AGENTS_TIMEOUT_MS: '30000',
    AWWO_OPENAI_AGENTS_CANCEL_GRACE_MS: '2000',
    AWWO_OPENAI_AGENTS_WORKSPACE_IMAGE: process.env.AWWO_TEST_WORKSPACE_IMAGE || 'awwo-workspace:fixture',
    AWWO_OPENAI_AGENTS_WORKSPACE_DOCKER: process.env.AWWO_TEST_DOCKER_EXECUTABLE || '/usr/bin/docker',
    AWWO_OPENAI_AGENTS_WORKSPACE_CALLBACK_URL: `${origin}/api/internal/workspace-calls`,
    AWWO_OPENAI_AGENTS_WORKSPACE_MAX_CALLS: '16',
    ...options.env,
  });
  const workspace: WorkspaceRequest = { version: 1, id: checksum('integration-tenant/session/node'), maxModelCalls: 16,
    callbackURL: `${origin}/api/internal/workspace-calls`, callbackToken: CALLBACK_TOKEN,
    inputs: [{ name: 'task.txt', encoding: 'base64', content: Buffer.from('authorized seed').toString('base64'), sha256: checksum('authorized seed') }],
    outputFields: [{ id: 'page', type: 'html', required: true }, { id: 'source', type: 'file', required: true }],
  };
  return { config, workspace, calls, ledger, providerStarted };
}

const page = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
const steps = (title: string, continuation = false): Step[] => [
  { name: 'workspace_list', args: { path: '.' } },
  { name: 'workspace_read', args: { path: continuation ? 'index.html' : 'inputs/task.txt' } },
  { name: 'workspace_write', args: { path: 'index.html', content: page(title) } },
  { name: 'workspace_exec', args: { command: `node -e "const fs=require('fs'); if(!fs.readFileSync('index.html','utf8').includes('${title}'))process.exit(3); console.log(JSON.stringify({uid:process.getuid(),environment:process.env}));"` } },
  { name: 'workspace_publish', args: { field: 'page', path: 'index.html' } },
  { name: 'workspace_archive', args: { field: 'source' } },
  { final: '{"page":"","source":""}' },
];

function assertLedger(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  assert.deepEqual(f.ledger.map(item => [item.operation, item.index]), Array.from({ length: count }, (_, i) => [['admit', i + 1], ['settle', i + 1]]).flat());
  for (const item of f.ledger.filter(item => item.operation === 'settle')) {
    const observability = item.observability as { usage: { status: string; providerTotalTokens: number } };
    assert.equal(item.status, 'completed'); assert.equal(observability.usage.status, 'reported'); assert.equal(observability.usage.providerTotalTokens, 13);
  }
}

test('real fork + SDK + Docker writes, tests, publishes and resumes verified source on a second run', { skip: !enabled, timeout: 60_000 }, async t => {
  const first = await fixture(t, { steps: steps('Round one') });
  const task = await run(first.config, request({ workspace: first.workspace, prompt: 'Create and test a page using the authorized seed.' }));
  const final = await task.result;
  assert.equal(final.type, 'completed', JSON.stringify(final));
  const delivery = JSON.parse(final.text);
  assert.equal(delivery.page, page('Round one'));
  assert.equal(delivery.source.encoding, 'base64');
  assert.equal(Buffer.from(delivery.source.content, 'base64').subarray(0, 2).toString(), 'PK');
  assert.equal(final.workspaceSnapshot.sha256, checksum(Buffer.from(final.workspaceSnapshot.content, 'base64')));
  assertLedger(first, 7);
  assert.ok(first.calls.every(call => call.authorization === `Bearer ${PROVIDER_KEY}`));
  assert.ok(first.calls.every(call => call.body.store === false), 'project conversations must preserve the existing no-store model policy');
  const modelBodies = JSON.stringify(first.calls.map(call => call.body));
  assert.ok(!modelBodies.includes(PROVIDER_KEY) && !modelBodies.includes(CALLBACK_TOKEN));
  assert.ok(modelBodies.includes('1000'), 'actual container UID must appear in the tool result');
  assert.ok(!modelBodies.includes('AWWO_OPENAI_AGENTS_API_KEY') && !modelBodies.includes('AWS_SECRET_ACCESS_KEY'));
  await assert.rejects(access(task.directory));
  const pid = task.pid; assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const second = await fixture(t, { steps: steps('Round two', true) });
  const followup = await run(second.config, request({ runId: 'run-2', workspace: { ...second.workspace, snapshot: final.workspaceSnapshot }, prompt: 'Update the existing page and run the checks again.' }));
  const updated = await followup.result;
  assert.equal(updated.type, 'completed', JSON.stringify(updated));
  assert.equal(JSON.parse(updated.text).page, page('Round two'));
  assert.ok(JSON.stringify(second.calls.map(call => call.body)).includes('Round one'), 'the restored prior file must enter the follow-up tool result');
  assertLedger(second, 7);
});

test('real fork denies a model step before provider call and refuses settlement failure as success', { skip: !enabled, timeout: 30_000 }, async t => {
  const denied = await fixture(t, { steps: steps('Denied'), denyAdmission: 1 });
  const blocked = await run(denied.config, request({ workspace: denied.workspace }));
  assert.equal((await blocked.result).type, 'failed');
  assert.equal(denied.calls.length, 0); assert.deepEqual(denied.ledger.map(item => item.operation), ['admit']);
  const unrecorded = await fixture(t, { steps: [{ final: '{"page":"not committed","source":""}' }], denySettlement: 1 });
  const failed = await run(unrecorded.config, request({ runId: 'unsettled-run', workspace: unrecorded.workspace }));
  assert.equal((await failed.result).type, 'failed');
  assert.equal(unrecorded.calls.length, 1);
  assert.deepEqual(unrecorded.ledger.map(item => item.operation), ['admit', 'settle']);
  assert.equal(failed.events.filter((event: JsonObject) => event.type === 'completed').length, 0);
});

test('real fork cancellation settles the admitted call and removes child and workspace', { skip: !enabled, timeout: 20_000 }, async t => {
  const f = await fixture(t, { steps: [{ stall: true }] });
  const task = await run(f.config, request({ workspace: f.workspace }));
  await f.providerStarted; task.cancel();
  const terminal = await task.result;
  assert.equal(terminal.type, 'cancelled', JSON.stringify(terminal));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.ledger.map(item => [item.operation, item.index]), [['admit', 1], ['settle', 1]]);
  assert.equal(f.ledger[1].status, 'cancelled');
  await assert.rejects(access(task.directory));
  const pid = task.pid; assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(task.events.filter((event: JsonObject) => event.type === 'completed').length, 0);
});

test('failed sandbox health probe rejects execution before admission or provider payment', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { steps: [] });
  let starts = 0;
  const app = createOpenAIAgentsServer(f.config, {
    workspaceProbe: async () => { throw new Error('fixture Docker unavailable'); },
    startRun: async () => { starts++; throw new Error('must not launch'); },
  });
  await app.workspaceReady;
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(`${origin}/health`)).json() as { workspace: { available: boolean }; activeRuns: number };
  assert.equal(health.workspace.available, false);
  const response = await fetch(`${origin}/internal/runs`, { method: 'POST', headers: { authorization: `Bearer ${f.config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request({ workspace: f.workspace })) });
  assert.equal(response.status, 503); await response.body?.cancel();
  assert.equal(starts, 0); assert.equal(f.calls.length, 0); assert.equal(f.ledger.length, 0); assert.equal(health.activeRuns, 0);
});

test('cleanup failure quarantines workspace capability and prevents subsequent admission', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { steps: [] });
  let starts = 0;
  const app = createOpenAIAgentsServer(f.config, {
    workspaceProbe: async () => undefined,
    startRun: async ({ onExit, onEvent }) => {
      starts++;
      onExit({ workspaceCleanupFailed: true });
      onEvent({ type: 'failed', code: 'WORKSPACE_UNAVAILABLE', message: 'Workspace cleanup failed.' });
      return { cancel: () => undefined, done: Promise.resolve(), pid: process.pid, directory: '' };
    },
  });
  await app.workspaceReady;
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (runId: string) => fetch(`${origin}/internal/runs`, { method: 'POST', headers: { authorization: `Bearer ${f.config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request({ runId, workspace: f.workspace })) });
  const first = await send('cleanup-first'); assert.equal(first.status, 200);
  assert.ok((await first.text()).includes('WORKSPACE_UNAVAILABLE'));
  const health = await (await fetch(`${origin}/health`)).json() as { workspace: { available: boolean }; activeRuns: number };
  assert.equal(health.workspace.available, false); assert.equal(health.activeRuns, 0);
  const second = await send('cleanup-second'); assert.equal(second.status, 503); await second.body?.cancel();
  assert.equal(starts, 1); assert.equal(f.calls.length, 0); assert.equal(f.ledger.length, 0);
});

test('sandbox becoming unavailable after its probe withdraws health capability', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { steps: [] });
  let starts = 0;
  const app = createOpenAIAgentsServer(f.config, {
    workspaceProbe: async () => undefined,
    startRun: async () => { starts++; throw new Error('Docker stopped after startup probe'); },
  });
  await app.workspaceReady;
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (runId: string) => fetch(`${origin}/internal/runs`, { method: 'POST', headers: { authorization: `Bearer ${f.config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request({ runId, workspace: f.workspace })) });
  const first = await send('lost-docker-first'); assert.equal(first.status, 200);
  assert.ok((await first.text()).includes('failed'));
  const health = await (await fetch(`${origin}/health`)).json() as { workspace: { available: boolean } };
  assert.equal(health.workspace.available, false);
  const second = await send('lost-docker-second'); assert.equal(second.status, 503); await second.body?.cancel();
  assert.equal(starts, 1); assert.equal(f.calls.length, 0); assert.equal(f.ledger.length, 0);
});

test('a Bedrock credential that cannot be resolved fails that run but keeps workspace execution available', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { steps: [], env: { AWWO_BEDROCK_CATALOG: 'builtin' } });
  const { config } = f;
  let starts = 0;
  const app = createOpenAIAgentsServer(config, {
    workspaceProbe: async () => undefined,
    startRun: async () => { starts++; throw new RuntimeError('MODEL_AUTHENTICATION'); },
  });
  await app.workspaceReady;
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (runId: string, model?: string) => fetch(`${origin}/internal/runs`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request({ runId, workspace: f.workspace, ...(model ? { model } : {}) })) });
  const first = await send('bedrock-credential', 'bedrock.glm-5'); assert.equal(first.status, 200);
  assert.ok((await first.text()).includes('MODEL_AUTHENTICATION'));
  const health = await (await fetch(`${origin}/health`)).json() as { workspace: { available: boolean } };
  assert.equal(health.workspace.available, true);
  // The next project run, on any model, is admitted rather than refused as WORKSPACE_UNAVAILABLE.
  const second = await send('gate-after-bedrock'); assert.equal(second.status, 200); await second.body?.cancel();
  assert.equal(starts, 2); assert.equal(f.calls.length, 0); assert.equal(f.ledger.length, 0);
});

for (const flood of ['text', 'arguments'] as const) test(`provider ${flood} overflow stops before SDK can accumulate an unbounded result`, { skip: !enabled, timeout: 20_000 }, async t => {
  const f = await fixture(t, { steps: [{ flood }] });
  const task = await run(f.config, request({ workspace: f.workspace }));
  t.after(async () => { task.cancel(); await task.done; });
  const terminal = await task.result;
  assert.equal(terminal.type, 'failed', JSON.stringify(terminal));
  assert.equal(terminal.code, 'OUTPUT_LIMIT');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.ledger.map(item => [item.operation, item.index]), [['admit', 1], ['settle', 1]]);
  assert.equal(f.ledger[1].status, 'failed');
  assert.equal(task.events.filter((event: JsonObject) => event.type === 'workspace_activity' || event.type === 'completed').length, 0);
});

for (const [finish, code] of [['length', 'MODEL_OUTPUT_LIMIT'], ['content_filter', 'MODEL_REFUSAL'], [null, 'MODEL_PROTOCOL_ERROR']] as const) test(`provider terminal guard rejects ${finish ?? 'missing finish reason'} before delivery`, { skip: !enabled, timeout: 10_000 }, async t => {
  const f = await fixture(t, { steps: [{ final: '{"page":"untrusted partial","source":""}', finish }] });
  const task = await run(f.config, request({ workspace: f.workspace }));
  const terminal = await task.result;
  assert.equal(terminal.type, 'failed', JSON.stringify(terminal)); assert.equal(terminal.code, code);
  assert.equal(f.calls.length, 1); assert.equal(f.ledger[1].status, 'failed');
  assert.equal(task.events.filter((event: JsonObject) => event.type === 'completed').length, 0);
});
