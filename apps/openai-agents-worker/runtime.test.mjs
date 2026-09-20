const businessEvent = ({ observability, ...event }) => event;
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { publicHealth } from './config.mjs';
import { configuration, fixture, request, run } from './test-support.mjs';
import { executeAgent } from './agent-runtime.mjs';

test('Google chat wire omits unsupported store while keeping SDK execution', async t => {
  const f = await fixture(t);
  const profile = { ...configuration().models[0], baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' };
  const events = [];
  await executeAgent({ request: request({ tools: ['calculator'] }), modelConfig: profile, signal: new AbortController().signal,
    emit: event => events.push(event), observer: {
      fetch(input, init) {
        assert.equal(String(input), `${profile.baseURL}/chat/completions`);
        return fetch(`${f.baseURL}/chat/completions`, init);
      },
      snapshot: () => ({}),
    } });
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(f.calls.length, 1);
  assert.ok(!Object.hasOwn(f.calls[0].body, 'store'));
  assert.equal(f.calls[0].body.parallel_tool_calls, false);
});

test('official SDK chat stream preserves isolated instructions, history and single-call settings', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const config = configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL });
  const input = request({ systemPrompt: 'You are Li Bai. Use only this persona.', messages: [{ role: 'user', content: 'Previous question' }, { role: 'assistant', content: 'Previous answer' }] });
  const task = await run(config, input, (event, released) => { if (event.type === 'completed') assert.equal(released, true); });
  assert.deepEqual(businessEvent(await task.result), { type: 'completed', text: 'Hello from Agents' });
  assert.equal(task.events.filter(e => e.type === 'text_delta').map(e => e.delta).join(''), 'Hello from Agents');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/v1/chat/completions');
  assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-key');
  assert.equal(f.calls[0].body.model, 'fixture-model');
  assert.equal(f.calls[0].body.max_tokens, 4096);
  assert.equal(f.calls[0].body.store, false);
  assert.equal(f.calls[0].body.stream, true);
  assert.deepEqual(f.calls[0].body.messages.map(m => [m.role, typeof m.content === 'string' ? m.content : m.content.map(p => p.text).join('')]), [['system', input.systemPrompt], ['user', 'Previous question'], ['assistant', 'Previous answer'], ['user', input.prompt]]);
  assert.ok(!f.calls[0].body.tools?.length);
  await assert.rejects(access(task.directory));
  assert.throws(() => process.kill(task.pid, 0), /ESRCH/);
});

test('official SDK Responses protocol preserves instructions and produces real terminal output', { timeout: 15_000 }, async t => {
  const f = await fixture(t, { text: 'Responses fixture output' });
  const task = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL, AWWO_OPENAI_AGENTS_PROTOCOL: 'responses' }), request({ systemPrompt: 'Independent persona' }));
  assert.deepEqual(businessEvent(await task.result), { type: 'completed', text: 'Responses fixture output' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/v1/responses');
  const metadata = publicHealth(configuration({ AWWO_OPENAI_AGENTS_PROTOCOL: 'responses' })).models[0];
  assert.equal(metadata.protocol, 'responses'); assert.equal(metadata.providerModel, f.calls[0].body.model);
  assert.equal(f.calls[0].body.instructions, 'Independent persona'); assert.equal(f.calls[0].body.store, false);
});

test('two simultaneous profiles use their own endpoint, key, model and capacity without contamination', { timeout: 15_000 }, async t => {
  const a = await fixture(t, { text: 'PROFILE A', delay: 100 }), b = await fixture(t, { text: 'PROFILE B', delay: 100 });
  const config = configuration({ AWWO_OPENAI_AGENTS_BASE_URL: a.baseURL, SECOND_KEY: 'fixture-key-b', AWWO_OPENAI_AGENTS_MODELS_JSON: JSON.stringify([{ id: 'second', provider: 'openai', model: 'model-b', baseURL: b.baseURL, apiKeyEnv: 'SECOND_KEY', contextWindow: 8192, maxTokens: 256 }]) });
  const [one, two] = await Promise.all([run(config), run(config, request({ runId: 'run-2', sessionId: 'session-2', model: 'second', systemPrompt: 'Persona B' }))]);
  assert.notEqual(one.pid, two.pid); assert.notEqual(one.directory, two.directory);
  assert.deepEqual((await Promise.all([one.result, two.result])).map(e => e.text), ['PROFILE A', 'PROFILE B']);
  assert.equal(a.calls[0].headers.authorization, 'Bearer fixture-key'); assert.equal(b.calls[0].headers.authorization, 'Bearer fixture-key-b');
  assert.equal(a.calls[0].body.model, 'fixture-model'); assert.equal(b.calls[0].body.model, 'model-b'); assert.equal(b.calls[0].body.max_tokens, 256);
  assert.equal(a.calls.length + b.calls.length, 2);
  const health = JSON.stringify(publicHealth(config));
  for (const privateValue of ['fixture-key', 'fixture-key-b', a.baseURL, b.baseURL, 'SECOND_KEY', 'apiKey', 'baseURL', 'piVersion']) assert.ok(!health.includes(privateValue));
});

for (const protocol of ['chat_completions', 'responses']) for (const tool of ['calculator', 'current_time']) test(`${protocol} safe ${tool} terminates after exactly one model call and suppresses preamble`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode: 'tool', tool, args: tool === 'calculator' ? { expression: '(2+3)*4' } : { timeZone: 'Asia/Shanghai' } });
  const task = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL, AWWO_OPENAI_AGENTS_PROTOCOL: protocol, AWWO_OPENAI_AGENTS_TOOLS_JSON: JSON.stringify([tool]) }), request({ tools: [tool] }));
  const end = await task.result;
  assert.equal(end.type, 'completed');
  const output = JSON.parse(end.text);
  if (tool === 'calculator') assert.equal(output.value, 20); else { assert.equal(output.timeZone, 'Asia/Shanghai'); assert.ok(Number.isFinite(Date.parse(output.iso))); }
  assert.equal(task.events.filter(e => e.type === 'text_delta').map(e => e.delta).join(''), end.text);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.tools.length, 1); assert.equal((f.calls[0].body.tools[0].function ?? f.calls[0].body.tools[0]).name, tool);
  assert.equal(f.calls[0].body.parallel_tool_calls, false);
});

for (const [name, options, code, tools] of [
  ['authentication redacted without retries', { status: 401 }, 'MODEL_AUTHENTICATION'],
  ['rate limiting without retries', { status: 429 }, 'MODEL_RATE_LIMIT'],
  ['provider outage without retries', { status: 503 }, 'MODEL_UNAVAILABLE'],
  ['truncated output', { mode: 'length' }, 'MODEL_OUTPUT_LIMIT'],
  ['refusal', { mode: 'refusal' }, 'MODEL_REFUSAL'],
  ['missing completion marker', { mode: 'missing-finish' }, 'MODEL_PROTOCOL_ERROR'],
  ['unknown tool', { mode: 'tool', tool: 'bash' }, 'TOOL_DENIED', ['calculator']],
  ['multiple tool calls', { mode: 'double-tool' }, 'TOOL_DENIED', ['calculator']],
  ['invalid tool arguments', { mode: 'tool', args: { expression: 'process.exit()' } }, 'TOOL_INPUT_INVALID', ['calculator']],
  ['malformed tool JSON', { mode: 'tool', args: '{broken' }, 'TOOL_INPUT_INVALID', ['calculator']],
]) test(name, { timeout: 15_000 }, async t => {
  const f = await fixture(t, options);
  const task = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL, AWWO_OPENAI_AGENTS_TOOLS_JSON: JSON.stringify(tools ?? []) }), request({ ...(tools ? { tools } : {}) }));
  const end = await task.result;
  assert.equal(end.type, 'failed'); assert.equal(end.code, code);
  assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(end).includes('private-upstream'));
  assert.ok(!task.events.some(e => e.type === 'completed'));
});

test('precise cancellation terminates the child and removes its private directory', { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode: 'stall' });
  const task = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL }));
  await f.ready; task.cancel();
  assert.deepEqual(businessEvent(await task.result), { type: 'cancelled' }); assert.equal(f.calls.length, 1);
  await assert.rejects(access(task.directory)); assert.throws(() => process.kill(task.pid, 0), /ESRCH/);
});

test('deadline and UTF-8 output bounds produce structured failures', { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode: 'stall' });
  const timed = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL, AWWO_OPENAI_AGENTS_TIMEOUT_MS: '2000' }));
  assert.equal((await timed.result).code, 'DEADLINE_EXCEEDED'); assert.equal(f.calls.length, 1);
  const g = await fixture(t, { text: '漢'.repeat(400) });
  const limited = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: g.baseURL, AWWO_OPENAI_AGENTS_MAX_OUTPUT_BYTES: '1024' }));
  assert.equal((await limited.result).code, 'OUTPUT_LIMIT');
});

for (const [name, usage, status] of [
  ['missing', undefined, 'unavailable'],
  ['explicit zero', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 'reported'],
  ['partial', { prompt_tokens: 9 }, 'partial'],
  ['cached and reasoning', { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }, 'reported'],
]) test(`real OpenAI Agents provider usage preserves ${name} across IPC and cleanup`, async t => {
  const f = await fixture(t, { usage, multilineUsage: name === 'cached and reasoning' });
  const task = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL }));
  const terminal = await task.result;
  assert.equal(terminal.type, 'completed');
  const observation = terminal.observability;
  assert.equal(observation.version, 1); assert.equal(observation.usage.status, status);
  assert.equal(observation.usage.inputTokens, usage?.prompt_tokens ?? null);
  assert.equal(observation.usage.outputTokens, usage?.completion_tokens ?? null);
  assert.equal(observation.usage.reasoningTokens, usage?.completion_tokens_details?.reasoning_tokens ?? null);
  assert.ok(observation.timing.workerTotalMs >= observation.timing.setupMs + observation.timing.providerMs - 1);
  assert.ok(observation.timing.providerTtftMs !== null);
  assert.ok(observation.timing.workerFirstDeltaMs >= observation.timing.providerTtftMs);
  assert.equal(f.calls.length, 1);
  for (const key of ['traceparent', 'tracestate', 'baggage']) assert.equal(f.calls[0].headers[key], undefined);
  await assert.rejects(access(task.directory));
});

test('Responses raw usage comes from the provider and never SDK synthetic zeros', async t => {
  for (const raw of [null, { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, { input_tokens: 10, output_tokens: 5, total_tokens: 15 }]) {
    const f = await fixture(t, { responseUsage: raw });
    const task = await run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL, AWWO_OPENAI_AGENTS_PROTOCOL: 'responses' }));
    const terminal = await task.result;
    assert.equal(terminal.type, 'completed');
    assert.equal(terminal.observability.usage.status, raw ? 'reported' : 'unavailable');
    assert.equal(terminal.observability.usage.inputTokens, raw?.input_tokens ?? null);
  }
});

for (const protocol of ['chat_completions', 'responses']) test(`${protocol} forwards only an explicitly admitted reasoning effort and never back-fills the advertised default`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, { text: 'Effortful answer' });
  const config = configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL, AWWO_OPENAI_AGENTS_PROTOCOL: protocol, AWWO_OPENAI_AGENTS_REASONING_EFFORTS: 'low,high', AWWO_OPENAI_AGENTS_DEFAULT_REASONING_EFFORT: 'low' });
  const explicit = await run(config, request({ effort: 'high' }));
  assert.deepEqual(businessEvent(await explicit.result), { type: 'completed', text: 'Effortful answer' });
  const silent = await run(config, request({ runId: 'run-2', sessionId: 'session-2' }));
  assert.deepEqual(businessEvent(await silent.result), { type: 'completed', text: 'Effortful answer' });
  assert.equal(f.calls.length, 2);
  const effortOf = body => protocol === 'responses' ? body.reasoning?.effort : body.reasoning_effort;
  assert.equal(effortOf(f.calls[0].body), 'high');
  assert.equal(effortOf(f.calls[1].body), undefined);
  assert.ok(!('reasoning' in f.calls[1].body) && !('reasoning_effort' in f.calls[1].body));
  await assert.rejects(run(config, request({ runId: 'run-3', sessionId: 'session-3', effort: 'medium' })), /not supported/);
  await assert.rejects(run(configuration({ AWWO_OPENAI_AGENTS_BASE_URL: f.baseURL, AWWO_OPENAI_AGENTS_PROTOCOL: protocol }), request({ runId: 'run-4', sessionId: 'session-4', effort: 'low' })), /not supported/);
  assert.equal(f.calls.length, 2);
});
