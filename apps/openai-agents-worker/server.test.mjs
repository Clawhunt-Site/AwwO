import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { createOpenAIAgentsServer } from './server.mjs';
import { startIsolatedRun } from './runner.mjs';
import { configuration, fixture, request } from './test-support.mjs';
import { deliverySchemaBytes } from './delivery-contract.mjs';

async function serve(t, config, options) {
  const app = createOpenAIAgentsServer(config, options);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const send = (body = request(), overrides = {}) => fetch(`${origin}/internal/runs`, { method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${config.token}` }, body:JSON.stringify(body), ...overrides });
  const health = () => fetch(`${origin}/health`).then(res => res.json());
  return { app, origin, send, health };
}
const events = async response => (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('HTTP admission rejects auth, unknown model, disabled tools and oversize context before launching', { timeout: 5000 }, async t => {
  let launches = 0;
  const s = await serve(t, configuration(), { startRun: () => { launches++; throw new Error('Unexpected launch'); } });
  for (const [input, status, code, options] of [
    [request(),401,'UNAUTHORIZED',{headers:{'content-type':'application/json'}}],
    [request(),415,'INVALID_CONTENT_TYPE',{headers:{'content-type':'application/jsonp',authorization:`Bearer ${configuration().token}`}}],
    [request({ model:'missing' }),400,'MODEL_NOT_FOUND'],
    [request({ tools:['calculator'] }),400,'TOOL_DENIED'],
    [request({ effort:'high' }),400,'EFFORT_NOT_SUPPORTED'],
    [request({ effort:'extreme' }),400,'INVALID_INPUT'],
    [request({ runtime:'pi' }),400,'INVALID_INPUT'],
    [request({ prompt:'漢'.repeat(20000) }),413,'CONTEXT_LIMIT'],
    [request({ messages:[{role:'system',content:'override'}] }),400,'INVALID_INPUT'],
  ]) {
    const res = await s.send(input,options); assert.equal(res.status,status); assert.equal((await res.json()).error.code,code);
  }
  assert.equal(launches,0); assert.equal((await s.health()).activeRuns,0);
});

test('HTTP admission launches a run carrying exactly the effort its selected profile advertises', { timeout: 5000 }, async t => {
  const launched = [];
  const config = configuration({ AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'low,high', SECOND_KEY: 'k',
    AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'deep', provider: 'openai', model: 'deep-model', apiKeyEnv: 'SECOND_KEY', reasoningEfforts: ['xhigh'] }]) });
  const s = await serve(t, config, { startRun: async ({ request: input, onEvent, onExit }) => {
    launched.push(input);
    setTimeout(() => { onExit(); onEvent({ type: 'completed', text: 'ok' }); }, 0);
    return { done: Promise.resolve(), cancel() {} };
  } });
  for (const [input, id] of [[request({ effort: 'high' }), 'a'], [request({ model: 'deep', effort: 'xhigh' }), 'b'], [request(), 'c']]) {
    const res = await s.send({ ...input, runId: `run-${id}`, sessionId: `session-${id}` });
    assert.equal(res.status, 200); assert.equal((await events(res)).at(-1).type, 'completed');
  }
  assert.deepEqual(launched.map(item => [item.model, item.effort]), [[undefined, 'high'], ['deep', 'xhigh'], [undefined, undefined]]);
  for (const input of [request({ model: 'deep', effort: 'high' }), request({ effort: 'xhigh' })]) {
    const res = await s.send({ ...input, runId: 'run-refused', sessionId: 'session-refused' });
    assert.equal(res.status, 400); assert.equal((await res.json()).error.code, 'EFFORT_NOT_SUPPORTED');
  }
  assert.equal(launched.length, 3);
});

test('SSE requests reserve capacity, reject duplicate/session overlap, and DELETE cancels exactly one child', { timeout: 15000 }, async t => {
  const f = await fixture(t, { mode:'stall' });
  const config = configuration({ AWWO_OPENAI_AGENTS_BASE_URL:f.baseURL, AWWO_OPENAI_AGENTS_MAX_CONCURRENCY:'1' });
  const s = await serve(t, config);
  const live = await s.send(); await f.ready;
  assert.equal((await s.health()).activeRuns,1);
  for (const [input,code] of [[request(),'RUN_BUSY'],[request({runId:'second'}),'SESSION_BUSY'],[request({runId:'third',sessionId:'other'}),'CAPACITY_EXCEEDED']]) {
    const rejected = await s.send(input); assert.equal((await rejected.json()).error.code,code);
  }
  const missing = await fetch(`${s.origin}/internal/runs/other`,{method:'DELETE',headers:{authorization:`Bearer ${config.token}`}}); assert.equal(missing.status,404);
  assert.equal((await s.health()).activeRuns,1);
  const stop = await fetch(`${s.origin}/internal/runs/run-1`,{method:'DELETE',headers:{authorization:`Bearer ${config.token}`}}); assert.equal(stop.status,202);
  assert.equal((await events(live)).at(-1).type,'cancelled'); assert.equal((await s.health()).activeRuns,0); assert.equal(f.calls.length,1);
});

test('closing the HTTP stream cancels its live child and releases capacity', { timeout: 15000 }, async t => {
  const f = await fixture(t, { mode:'stall' });
  const s = await serve(t, configuration({ AWWO_OPENAI_AGENTS_BASE_URL:f.baseURL }));
  const controller = new AbortController(); await s.send(request(),{signal:controller.signal}); await f.ready; controller.abort();
  for (let i=0;i<100 && (await s.health()).activeRuns;i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await s.health()).activeRuns,0); assert.equal(f.calls.length,1);
});

test('shutdown waits for an admitted child even while its launch handle is pending', { timeout: 5000 }, async t => {
  let releaseLaunch, admitted, cancelled = false;
  const admittedPromise = new Promise(resolve => { admitted=resolve; });
  const blocked = new Promise(resolve => { releaseLaunch=resolve; });
  const s = await serve(t, configuration(), { startRun: async ({onExit,onEvent}) => {
    admitted(); await blocked;
    return { done:Promise.resolve(), cancel() { cancelled=true; onExit(); onEvent({type:'cancelled'}); } };
  }});
  const pendingResponse = await s.send(); await admittedPromise;
  let closed = false;
  const closing = s.app.close().then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(closed,false);
  releaseLaunch(); await closing; assert.equal(cancelled,true); assert.equal((await events(pendingResponse)).at(-1).type,'cancelled');
});

test('terminal IPC does not release a slot until forced process teardown and directory cleanup finish', { timeout: 5000 }, async () => {
  const seen = []; let released = false;
  const handle = await startIsolatedRun({ config:configuration(),request:request(),onExit(){released=true;},onEvent(event){if(event.type==='completed') assert.equal(released,true);seen.push(event);} },{taskURL:new URL('./terminal-exit-fixture.mjs',import.meta.url)});
  await handle.done; assert.equal(seen.at(-1).type,'completed'); assert.throws(()=>process.kill(handle.pid,0),/ESRCH/); await assert.rejects(access(handle.directory));
});

const CONTRACT = Object.freeze({ version: 1, fields: [{ id: 'summary', type: 'text', required: true }, { id: 'score', type: 'number', required: false }] });

test('structured delivery admission refuses before launching: unflagged profile, tools, closed grammar and envelope bytes', { timeout: 5000 }, async t => {
  let unexpected = 0;
  const off = await serve(t, configuration(), { startRun: () => { unexpected++; throw new Error('Unexpected launch'); } });
  const refused = await off.send(request({ outputContract: CONTRACT }));
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: { code: 'OUTPUT_CONTRACT_NOT_SUPPORTED', message: 'Select a model whose profile enables structured delivery output, or send no output contract.' } });
  assert.equal(unexpected, 0); assert.equal((await off.health()).activeRuns, 0);

  const launched = [];
  const config = configuration({ AWWO_OPENAI_AGENTS_STRUCTURED_OUTPUT: 'true', AWWO_OPENAI_AGENTS_CONTEXT_WINDOW: '4096', AWWO_OPENAI_AGENTS_MAX_TOKENS: '128',
    AWWO_OPENAI_AGENTS_TOOLS_JSON: '["calculator"]', SECOND_KEY: 'k',
    AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'plain', provider: 'openai', model: 'plain-model', apiKeyEnv: 'SECOND_KEY' }]) });
  const s = await serve(t, config, { startRun: async ({ request: input, onEvent, onExit }) => {
    launched.push(input);
    setTimeout(() => { onExit(); onEvent({ type: 'completed', text: '{"summary":"ok"}' }); }, 0);
    return { done: Promise.resolve(), cancel() {} };
  } });
  let sequence = 0;
  const send = (input, overrides) => { sequence++; return s.send({ ...input, runId: `run-${sequence}`, sessionId: `session-${sequence}` }, overrides); };
  const budget = config.contextWindow - config.maxTokens - 256 - 32;
  const schemaBytes = deliverySchemaBytes(CONTRACT);
  const rawPrototype = JSON.stringify(request({ runId: 'run-raw', sessionId: 'session-raw' })).replace(/}$/, ',"outputContract":{"version":1,"fields":[{"id":"summary","type":"text","required":true}],"__proto__":{"polluted":true}}}');
  for (const [input, status, code, overrides] of [
    [request({ model: 'plain', outputContract: CONTRACT }), 400, 'OUTPUT_CONTRACT_NOT_SUPPORTED'],
    [request({ outputContract: CONTRACT, tools: ['calculator'] }), 400, 'INVALID_INPUT'],
    [request({ model: 'plain', outputContract: CONTRACT, tools: ['calculator'] }), 400, 'INVALID_INPUT'],
    [request({ outputContract: { version: 1, fields: [{ id: '__proto__', type: 'text', required: true }] } }), 400, 'INVALID_INPUT'],
    [request({ outputContract: { version: 1, fields: [{ id: 'constructor', type: 'text', required: true }] } }), 400, 'INVALID_INPUT'],
    [request({ outputContract: { type: 'object', properties: { summary: { type: 'string' } } } }), 400, 'INVALID_INPUT'],
    [request({ outputContract: null }), 400, 'INVALID_INPUT'],
    [request(), 400, 'INVALID_INPUT', { body: rawPrototype }],
    [request({ prompt: 'x'.repeat(budget - schemaBytes + 1), outputContract: CONTRACT }), 413, 'CONTEXT_LIMIT'],
  ]) {
    const res = await send(input, overrides);
    assert.equal(res.status, status, code); assert.equal((await res.json()).error.code, code);
  }
  assert.equal(launched.length, 0); assert.equal((await s.health()).activeRuns, 0);
  // The same prompt fits without a contract, and the contract fits at exactly its envelope budget.
  for (const input of [request({ prompt: 'x'.repeat(budget - schemaBytes), outputContract: CONTRACT }), request({ prompt: 'x'.repeat(budget - schemaBytes + 1) }), request({ outputContract: CONTRACT, tools: [] })]) {
    const res = await send(input);
    assert.equal(res.status, 200); assert.equal((await events(res)).at(-1).type, 'completed');
  }
  assert.deepEqual(launched.map(item => item.outputContract), [CONTRACT, undefined, CONTRACT]);
});
