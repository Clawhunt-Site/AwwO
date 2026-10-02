import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerServer } from './server.ts';
import { loadConfig } from './config.ts';
import { closeServer, listenLocal } from './transport.ts';
import { json, readJSON, record, type WorkerEvent } from './protocol.ts';

const enabled = process.env.AWWO_OPENMAUS_REAL_TEST === '1';
const workerToken = 'worker-test-token-'.repeat(3), modelToken = 'model-scope-token-'.repeat(3);
async function* events(response: Response) {
  assert.equal(response.status, 200); assert.ok(response.body);
  let buffer = ''; const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number; while ((end = buffer.indexOf('\n\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (line.startsWith('data: ')) yield JSON.parse(line.slice(6)) as WorkerEvent; }
  }
}

test('real pinned core + real Docker: approval, exec, verified artifact, question and cleanup', { skip: !enabled, timeout: 120_000 }, async () => {
  let modelCalls = 0; const received: Record<string, unknown>[] = [];
  const content = '<!doctype html><h1>AwwO isolated artifact</h1>\n';
  const model = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${modelToken}`);
    const body = await readJSON(req); assert.ok(record(body)); received.push(body);
    const advertised = (body.tools as { function: { name: string } }[]).map(tool => tool.function.name).sort();
    assert.deepEqual(advertised, ['ask_user', 'awwo_workspace_archive', 'awwo_workspace_exec', 'awwo_workspace_list', 'awwo_workspace_publish', 'awwo_workspace_read', 'awwo_workspace_write']);
    const plan = [
      { name: 'awwo_workspace_write', arguments: JSON.stringify({ path: 'index.html', content }) },
      { name: 'awwo_workspace_exec', arguments: JSON.stringify({ command: "python3 -c \"from pathlib import Path; assert 'AwwO' in Path('index.html').read_text(); print('REAL_DOCKER_TEST_OK')\"" }) },
      { name: 'awwo_workspace_publish', arguments: JSON.stringify({ path: 'index.html' }) },
      { name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: 'Keep this generated file?', options: [{ label: 'Yes' }, { label: 'No' }] }] }) },
    ];
    const tool = plan[modelCalls++];
    json(res, 200, { id: 'fixture', object: 'chat.completion', model: 'awwo-model', choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${modelCalls}`, type: 'function', function: tool }] } : { role: 'assistant', content: 'Created index.html. The Docker test passed.' } }], usage: { prompt_tokens: 12, completion_tokens: 8 } });
  });
  const modelURL = await listenLocal(model), dir = await mkdtemp(join(tmpdir(), 'awwo-openmaus-integration-'));
  const config = loadConfig({ ...process.env, AWWO_OPENMAUS_TOKEN: workerToken, AWWO_OPENMAUS_DATA_DIR: dir, AWWO_OPENMAUS_DOCKER: process.env.AWWO_TEST_DOCKER_EXECUTABLE || '/usr/local/bin/docker', AWWO_OPENMAUS_WORKSPACE_IMAGE: process.env.AWWO_TEST_WORKSPACE_IMAGE || 'awwo-workspace:20261001', AWWO_OPENMAUS_DOCKER_CONTEXT: process.env.AWWO_TEST_DOCKER_CONTEXT || 'desktop-linux' });
  const worker = createWorkerServer(config), url = await listenLocal(worker.server), headers = { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, runId = randomUUID();
  try {
    let health: { ready: boolean } = { ready: false };
    for (let attempt = 0; attempt < 6; attempt++) { health = await (await fetch(url + '/health', { headers })).json(); if (health.ready) break; await delay(2100); }
    assert.equal(health.ready, true, JSON.stringify(health));
    assert.equal((await fetch(url + '/health')).status, 401);
    const response = await fetch(url + '/internal/runs', { method: 'POST', headers, body: JSON.stringify({ runId, tenantId: 'tenant-a', sessionId: 'canvas-a', prompt: 'Create, test and publish index.html; ask me whether to keep it.', instructions: 'You are a bounded workspace worker.', modelProxyURL: modelURL + '/v1', modelProxyToken: modelToken, timeoutMs: 90_000, maxModelCalls: 8 }) });
    const observed: WorkerEvent[] = [];
    for await (const event of events(response)) {
      observed.push(event);
      if (event.type === 'computer_approval') {
        assert.ok(record(event.arguments));
        if (event.kind === 'approval' && event.title === 'awwo_workspace_write') assert.equal(event.arguments.content, content);
        const answer = { requestId: event.requestId, behavior: 'allow', ...(event.kind === 'question' ? { message: 'Yes, keep it.' } : {}) };
        const respond = () => fetch(url + `/internal/runs/${runId}/respond`, { method: 'POST', headers, body: JSON.stringify(answer) });
        const [first, again] = await Promise.all([respond(), respond()]);
        assert.equal(first.status, 200, JSON.stringify(event) + ' ' + await first.text());
        assert.equal(again.status, 200, await again.text());
        const conflict = await fetch(url + `/internal/runs/${runId}/respond`, { method: 'POST', headers, body: JSON.stringify({ ...answer, behavior: 'deny' }) }); assert.equal(conflict.status, 409);
      }
    }
    assert.equal(observed.at(-1)?.type, 'completed', JSON.stringify(observed));
    const artifact = observed.find(event => event.type === 'computer_artifact'); assert.ok(artifact);
    assert.equal(Buffer.from(String(artifact.content), 'base64').toString(), content);
    assert.equal(artifact.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(observed.filter(event => event.type === 'computer_approval').length, 4);
    const writeApproval = observed.find(event => event.type === 'computer_approval' && record(event.arguments) && event.arguments.content !== undefined);
    assert.ok(writeApproval && record(writeApproval.arguments)); assert.equal(writeApproval.arguments.content, content);
    assert.ok(JSON.stringify(received).includes('REAL_DOCKER_TEST_OK'));
    assert.ok(JSON.stringify(received).includes('Yes, keep it.'));
    assert.ok(!JSON.stringify(observed).includes(modelToken));
    assert.deepEqual(await readdir(dir), []);
  } finally { await worker.close(); await closeServer(model); await rm(dir, { recursive: true, force: true }); }
});

for (const mode of ['deny', 'cancel', 'disconnect', 'budget'] as const) {
  test(`real core and Docker: ${mode} never reports false completion and cleans up`, { skip: !enabled, timeout: 90_000 }, async () => {
    let calls = 0, sawDenial = false;
    const model = createServer(async (req, res) => {
      const body = await readJSON(req); calls++;
      if (mode === 'deny' && calls > 1) sawDenial = /denied|declined|not allowed|rejected/i.test(JSON.stringify(body));
      const done = mode === 'deny' && calls > 1;
      json(res, 200, { choices: [{ finish_reason: done ? 'stop' : 'tool_calls', message: done ? { role: 'assistant', content: 'The requested write was denied.' } : { role: 'assistant', content: null, tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name: 'awwo_workspace_write', arguments: JSON.stringify({ path: 'pending.txt', content: 'must wait for approval' }) } }] } }] });
    });
    const modelURL = await listenLocal(model), dir = await mkdtemp(join(tmpdir(), 'awwo-openmaus-negative-'));
    const config = loadConfig({ ...process.env, AWWO_OPENMAUS_TOKEN: workerToken, AWWO_OPENMAUS_DATA_DIR: dir, AWWO_OPENMAUS_DOCKER: process.env.AWWO_TEST_DOCKER_EXECUTABLE || '/usr/local/bin/docker', AWWO_OPENMAUS_WORKSPACE_IMAGE: process.env.AWWO_TEST_WORKSPACE_IMAGE || 'awwo-workspace:20261001', AWWO_OPENMAUS_DOCKER_CONTEXT: process.env.AWWO_TEST_DOCKER_CONTEXT || 'desktop-linux' });
    const worker = createWorkerServer(config), url = await listenLocal(worker.server), runId = randomUUID();
    const headers = { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, abort = new AbortController();
    try {
      const response = await fetch(url + '/internal/runs', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ runId, tenantId: 'isolated-negative-tenant', sessionId: 'negative-session', prompt: 'Write pending.txt with tools.', instructions: '', modelProxyURL: modelURL + '/v1', modelProxyToken: modelToken, timeoutMs: 60_000, maxModelCalls: mode === 'budget' ? 1 : 3 }) });
      const observed: WorkerEvent[] = [];
      try {
        for await (const event of events(response)) {
          observed.push(event);
          if (event.type !== 'computer_approval') continue;
          // No model continuation while the native gate is pending.
          await delay(150); assert.equal(calls, 1);
          if (mode === 'disconnect') { abort.abort(); break; }
          if (mode === 'cancel') { assert.equal((await fetch(url + `/internal/runs/${runId}`, { method: 'DELETE', headers })).status, 202); }
          else { const answer = await fetch(url + `/internal/runs/${runId}/respond`, { method: 'POST', headers, body: JSON.stringify({ requestId: event.requestId, behavior: mode === 'deny' ? 'deny' : 'allow' }) }); assert.equal(answer.status, 200); }
        }
      } catch (error) { if (mode !== 'disconnect') throw error; }
      await worker.runs.get(runId)?.done;
      assert.equal(observed.some(event => event.type === 'computer_artifact'), false);
      if (mode === 'cancel') assert.equal(observed.at(-1)?.type, 'cancelled', JSON.stringify(observed));
      if (mode === 'budget') { assert.equal(observed.at(-1)?.type, 'failed'); assert.equal(observed.at(-1)?.code, 'MODEL_BUDGET_EXCEEDED'); assert.equal(calls, 1); }
      if (mode === 'deny') { assert.equal(observed.at(-1)?.type, 'failed'); assert.equal(sawDenial, true); }
      assert.deepEqual(await readdir(dir), []);
    } finally { await worker.close(); await closeServer(model); await rm(dir, { recursive: true, force: true }); }
  });
}
