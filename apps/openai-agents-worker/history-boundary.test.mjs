import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executeAgent } from './agent-runtime.mjs';
import { RuntimeError } from './errors.mjs';
import { configuration, fixture, request, run } from './test-support.mjs';

// Go owns every conversation's history (docs/awwo-openai-agents-runtime.md, 会话历史归属).
// These tests pin the worker side of that decision: a run sends only what its own
// request carries, the fetch guard forwards only the exact endpoint, and no worker
// module reaches for SDK-owned history, response chaining, a process-wide default
// client, run_llm_again or a second run call.

const WORKER_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const business = ({ observability, ...event }) => event;

const RUN_A = Object.freeze({
  systemPrompt: 'HISTORY-BOUNDARY system prompt of run A',
  historyUser: 'HISTORY-BOUNDARY earlier user turn of run A',
  historyAssistant: 'HISTORY-BOUNDARY earlier assistant turn of run A',
  prompt: 'HISTORY-BOUNDARY prompt of run A',
  output: 'HISTORY-BOUNDARY model output of run A',
});
const RUN_B_PROMPT = 'HISTORY-BOUNDARY prompt of run B';
// Identifiers the fixture provider gives run A's response. Any of them in run B
// would mean response chaining or replayed output items.
const PROVIDER_IDS = Object.freeze(['resp_fixture', 'msg_fixture', 'chat_fixture']);
const CHAINING_KEYS = new Set(['previous_response_id', 'previousResponseId', 'conversation', 'conversation_id', 'conversationId']);
const PROTOCOLS = Object.freeze(['chat_completions', 'responses']);
const endpointPath = protocol => protocol === 'responses' ? 'responses' : 'chat/completions';

function bodyKeys(value, keys = new Set()) {
  if (Array.isArray(value)) for (const item of value) bodyKeys(item, keys);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { keys.add(key); bodyKeys(item, keys); }
  return keys;
}

const textOf = content => typeof content === 'string' ? content : content.map(part => part.text ?? JSON.stringify(part)).join('');

// Normalises both provider wire shapes to [role, text] pairs, instructions first.
function transcript(protocol, body) {
  const pair = item => [item.role ?? item.type, item.content === undefined ? JSON.stringify(item) : textOf(item.content)];
  return protocol === 'responses' ? [['system', body.instructions], ...body.input.map(pair)] : body.messages.map(pair);
}

for (const protocol of PROTOCOLS) test(`${protocol} run B on the same tenant and session carries only its own prompt, never run A's history or output`, { timeout: 20_000 }, async t => {
  const provider = await fixture(t, { text: RUN_A.output });
  const config = configuration({ AWWO_OPENAI_AGENTS_BASE_URL: provider.baseURL, AWWO_OPENAI_AGENTS_PROTOCOL: protocol });
  const first = request({ runId: 'history-run-a', systemPrompt: RUN_A.systemPrompt, prompt: RUN_A.prompt,
    messages: [{ role: 'user', content: RUN_A.historyUser }, { role: 'assistant', content: RUN_A.historyAssistant }] });
  const second = request({ runId: 'history-run-b', prompt: RUN_B_PROMPT, messages: [] });
  assert.equal(second.tenantId, first.tenantId);
  assert.equal(second.sessionId, first.sessionId);

  const a = await run(config, first);
  assert.deepEqual(business(await a.result), { type: 'completed', text: RUN_A.output });
  const b = await run(config, second);
  assert.deepEqual(business(await b.result), { type: 'completed', text: RUN_A.output });

  assert.equal(provider.calls.length, 2);
  const configured = new URL(provider.baseURL);
  const endpoint = `${configured.pathname}/${endpointPath(protocol)}`;
  for (const call of provider.calls) {
    assert.equal(call.url, endpoint);
    assert.equal(call.headers.host, configured.host);
    assert.equal(call.body.store, false);
    assert.deepEqual([...bodyKeys(call.body)].filter(key => CHAINING_KEYS.has(key)), []);
  }

  const [bodyA, bodyB] = provider.calls.map(call => call.body);
  // Run A really carried its instructions and history, so their absence from B is meaningful.
  assert.deepEqual(transcript(protocol, bodyA), [['system', RUN_A.systemPrompt], ['user', RUN_A.historyUser], ['assistant', RUN_A.historyAssistant], ['user', RUN_A.prompt]]);
  // B still carries its own system instruction (the worker default here); its only conversation turn is its prompt.
  const [instructions, ...turns] = transcript(protocol, bodyB);
  assert.equal(instructions[0], 'system');
  assert.deepEqual(turns, [['user', RUN_B_PROMPT]]);
  const serialized = JSON.stringify(bodyB);
  for (const leaked of [...Object.values(RUN_A), ...PROVIDER_IDS]) assert.ok(!serialized.includes(leaked), `run B must not carry ${leaked}`);
});

// The exact-URL fetch guard is checked by behaviour, not by spelling. The run executes
// in this process with an observer that stops every forwarded request, and the fetch
// the worker handed its OpenAI client is captured and called directly. Only the exact
// endpoint may reach the observer, and it must be forwarded with redirects refused.
for (const protocol of PROTOCOLS) test(`${protocol} fetch guard forwards only the exact endpoint, with redirects refused`, { timeout: 20_000 }, async t => {
  const { default: OpenAI } = await import('openai');
  const dispatch = OpenAI.prototype.fetchWithTimeout;
  assert.equal(typeof dispatch, 'function', 'openai no longer dispatches requests through fetchWithTimeout; update this capture');
  const guards = new Set();
  OpenAI.prototype.fetchWithTimeout = function capture(...args) { guards.add(this.fetch); return dispatch.apply(this, args); };
  t.after(() => { OpenAI.prototype.fetchWithTimeout = dispatch; });

  const forwarded = [];
  const observer = { async fetch(input, init) {
    forwarded.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, redirect: init?.redirect });
    throw new Error('HISTORY-BOUNDARY observer stops every forwarded request');
  } };
  const base = 'http://127.0.0.1:9/v1';
  const endpoint = `${base}/${endpointPath(protocol)}`;
  await assert.rejects(executeAgent({ request: { prompt: 'HISTORY-BOUNDARY guard probe', messages: [] },
    modelConfig: { protocol, baseURL: base, apiKey: 'fixture-key', model: 'fixture-model', maxTokens: 64 },
    signal: new AbortController().signal, emit: async () => {}, observer }));
  assert.equal(guards.size, 1, 'the run must dispatch through exactly one guarded fetch');
  assert.deepEqual(forwarded, [{ url: endpoint, redirect: 'error' }]);

  const [guard] = guards;
  const sibling = `${base}/${endpointPath(protocol === 'responses' ? 'chat_completions' : 'responses')}`;
  const refused = [
    `${base}/responses/compact`, `${endpoint}/compact`, `${endpoint}/`, `${endpoint}?stream=true`, `${endpoint}x`, sibling, `${base}/models`,
    endpoint.replace(':9/', ':10/'), endpoint.replace('127.0.0.1', 'localhost'), endpoint.replace('http:', 'https:'),
  ];
  for (const url of refused) for (const input of [url, new URL(url), new Request(url, { method: 'POST', body: '{}' })]) {
    await assert.rejects(async () => guard(input, { method: 'POST', body: '{}' }),
      error => error instanceof RuntimeError && error.code === 'MODEL_REQUEST_REJECTED', `${url} must be refused before it is sent`);
  }
  assert.equal(forwarded.length, 1, 'a refused URL must never reach the observer');
});

// Each entry hands history, response chaining, a provider client or another model
// call to the SDK. The scan reads raw source, comments included, so describe these
// rules in the docs rather than naming them in worker modules.
const DENYLIST = Object.freeze([
  ['SDK Session class or type', /\b\w*Session\b/g, ['new MemorySession()', 'new sdk.OpenAIConversationsSession()', 'OpenAIResponsesCompactionSession', 'startOpenAIConversationsSession()']],
  ['SDK Session interface method', /\bgetSessionId\b/g, ['await store.getSessionId()']],
  ['session run option', /\bsession\s*:|[{,]\s*session\s*[,}]/g, ['{ stream: true, session }', '{ session: history }']],
  ['sessionInputCallback', /\bsessionInputCallback\b/g, ['sessionInputCallback: merge']],
  ['previousResponseId', /\bpreviousResponseId\b|\bprevious_response_id\b/g, ['previousResponseId: id', 'body.previous_response_id = id']],
  ['conversationId', /\bconversationId\b|\bconversation_id\b|\bconversation['"]?\s*:/g, ['conversationId: id', "{ 'conversation': 'conv_1' }", 'conversation_id']],
  ['setDefaultOpenAIClient', /\bsetDefaultOpenAIClient\b/g, ['sdk.setDefaultOpenAIClient(client)']],
  ['setDefaultOpenAIKey', /\bsetDefaultOpenAIKey\b/g, ['setDefaultOpenAIKey(key)']],
  ['run_llm_again', /\brun_llm_again\b/g, ["toolUseBehavior: 'run_llm_again'"]],
  ['Responses compaction endpoint', /\bresponses\s*\.\s*compact\b|\/responses\/compact\b/g, ['client.responses.compact(input)', "'/v1/responses/compact'"]],
]);
// The worker's own per-request session bookkeeping must stay allowed.
const ALLOWED = Object.freeze(["sessionId: 'session-1'", 'sessions.add(sessionKey)', "code: 'SESSION_BUSY'", '`${body.tenantId}:${body.sessionId}`', '// No file-backed sessions.', 'store: false', "throw new Error('Conversation is too large')"]);

// Every spelling of a run call the scan can see: member access (a call, call/apply/bind
// or a stored reference), a bare call, computed access, and importing or destructuring
// run under any alias. Strings such as 'worker.run', declarations named run and the
// Runner class stay allowed.
const RUN_FORMS = Object.freeze([
  ['run member access', /\.\s*run\b(?!['"`])/g, ['runner.run(agent)', 'sdk\n  .run(agent, input)', 'runner?.run(agent)', 'const again = runner.run;', 'runner.run.call(runner, agent)', 'new sdk.Runner().run(agent)']],
  ['bare run call', /(?<![\w$.])(?<!\bfunction\s*\*?\s*)run\s*\(/g, ['await run(agent, input)', 'const result = run (agent)']],
  ['computed run access', /\[\s*(['"`])run\1\s*\]/g, ['sdk["run"](agent)', "runner['run']", 'sdk[`run`]']],
  ['run import or destructuring', /\{[^{}]*\brun\b[^{}]*\}\s*(?:=(?!=)|from\b)/g, ["import { run as runAgent } from '@openai/agents'", 'const { run } = sdk', 'const { Agent, run: go } = await import(name)']],
]);
const RUN_FORMS_ALLOWED = Object.freeze(["name: 'worker.run'", "if (started || message?.type !== 'run') return;", "child.send({ type: 'run', request })",
  'export async function run(config, input = request(), onEvent = () => {}) {', 'function* run() {}', 'if (active.has(body.runId)) return',
  'const runner = new sdk.Runner({ tracingDisabled: true });', '// Scope: one isolated agent run; deleted', 'await startIsolatedRun(options)']);

const matches = (pattern, source) => [...source.matchAll(pattern)];
const lineOf = (source, index) => source.slice(0, index).split('\n').length;

const MODULE = /\.(?:mjs|cjs|js)$/;
const TEST_MODULE = /\.test\.(?:mjs|cjs|js)$/;

// Walks the worker directory, so modules added later are scanned without editing this file.
async function workerModules(directory = WORKER_DIRECTORY) {
  const modules = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) modules.push(...await workerModules(path));
    } else if (entry.isFile() && MODULE.test(entry.name) && !TEST_MODULE.test(entry.name)) modules.push(path);
  }
  return modules.sort();
}

async function workerSources() {
  const sources = [];
  for (const path of await workerModules()) sources.push({ name: relative(WORKER_DIRECTORY, path).split(sep).join('/'), source: await readFile(path, 'utf8') });
  const names = sources.map(({ name }) => name);
  for (const expected of ['agent-runtime.mjs', 'agent-task.mjs', 'config.mjs', 'errors.mjs', 'observability.mjs', 'runner.mjs', 'server.mjs', 'test-support.mjs', 'tools.mjs', 'usage.mjs']) {
    assert.ok(names.includes(expected), `the scan must cover ${expected}`);
  }
  assert.ok(!names.some(name => TEST_MODULE.test(name) || name.split('/').includes('node_modules')));
  return sources;
}

test("denylist and run-call patterns catch each forbidden form and spare the worker's own bookkeeping", () => {
  for (const [label, pattern, samples] of [...DENYLIST, ...RUN_FORMS]) for (const sample of samples) assert.ok(matches(pattern, sample).length > 0, `${label} must match ${sample}`);
  for (const sample of ALLOWED) assert.deepEqual(DENYLIST.filter(([, pattern]) => matches(pattern, sample).length > 0).map(([label]) => label), [], sample);
  for (const sample of RUN_FORMS_ALLOWED) assert.deepEqual(RUN_FORMS.filter(([, pattern]) => matches(pattern, sample).length > 0).map(([label]) => label), [], sample);
});

test('no non-test worker module uses an SDK Session, response chaining, a default OpenAI client, run_llm_again or the compaction endpoint', async () => {
  const violations = [];
  for (const { name, source } of await workerSources()) for (const [label, pattern] of DENYLIST) for (const match of matches(pattern, source)) {
    violations.push(`${name}:${lineOf(source, match.index)} ${label}: ${match[0]}`);
  }
  assert.deepEqual(violations, []);
});

test('across every non-test worker module the only run call is the runner.run in agent-runtime.mjs', async () => {
  const found = [];
  for (const { name, source } of await workerSources()) for (const [label, pattern] of RUN_FORMS) for (const match of matches(pattern, source)) {
    found.push(`${name}:${lineOf(source, match.index)} ${label}: ${match[0].replace(/\s+/g, '')}`);
  }
  assert.equal(found.length, 1, `no worker module may add a run call, a run helper import or a run reference: ${found.join('; ')}`);
  assert.match(found[0], /^agent-runtime\.mjs:\d+ run member access: \.run$/);
});

const SINGLE_TURN_OPTIONS = Object.freeze(['maxTurns:1', 'signal', 'stream:true']);

// Whitespace and option order are formatting. Any other change to the one
// runner.run call, including its maxTurns value, is a behaviour change.
function assertSingleTurnRun(source) {
  assert.equal(matches(/\brun\b/g, source).length, 1, 'the runner.run call is the only run identifier: no run helper import or alias, stored reference, computed access, second call or comment naming it');
  assert.equal(matches(/\brunner\s*\.\s*run\s*\(/g, source).length, 1, 'exactly one runner.run( call');
  const options = matches(/\brunner\s*\.\s*run\s*\([^;{}]*?,\s*\{([^{}]*)\}\s*,?\s*\)/g, source).map(match => match[1]
    .split(',').map(option => option.replace(/\s+/g, '')).filter(Boolean)
    .map(option => option === 'signal:signal' ? 'signal' : option).sort());
  assert.deepEqual(options, [SINGLE_TURN_OPTIONS], 'runner.run options must be exactly { stream: true, signal, maxTurns: 1 }');
}

// The SDK default toolUseBehavior is run_llm_again, so omitting the setting brings it
// back without the literal ever appearing. Pin the one explicit value instead.
function assertStopOnFirstTool(source) {
  assert.equal(matches(/\btoolUseBehavior\b/g, source).length, 1, 'exactly one toolUseBehavior setting');
  assert.equal(matches(/\btoolUseBehavior\s*:\s*(['"`])stop_on_first_tool\1/g, source).length, 1, "toolUseBehavior must be 'stop_on_first_tool'; without it the SDK runs the model again");
}

test('the runner.run check tolerates formatting but not a changed or additional run call', () => {
  const current = 'const result = await runner.run(agent, input, { stream: true, signal, maxTurns: 1 });';
  assert.doesNotThrow(() => assertSingleTurnRun(current));
  assert.doesNotThrow(() => assertSingleTurnRun('const result = await runner\n  .run(\n    agent,\n    input,\n    {\n      maxTurns: 1,\n      signal: signal,\n      stream: true,\n    },\n  );'));
  for (const variant of [
    current.replace('maxTurns: 1', 'maxTurns: 2'),
    current.replace('maxTurns: 1', 'maxTurns: 10'),
    current.replace('maxTurns: 1', 'maxTurns: turns'),
    current.replace(', maxTurns: 1', ''),
    current.replace('signal, ', ''),
    current.replace('stream: true', 'stream: false'),
    current.replace('maxTurns: 1', 'maxTurns: 1, session'),
    current.replace('maxTurns: 1', 'maxTurns: 1, ...extra'),
    current.replace('{ stream: true, signal, maxTurns: 1 }', 'options'),
    `${current}\nconst again = await runner.run(agent, input, { stream: true, signal, maxTurns: 1 });`,
    `${current}\nconst again = await sdk.run(agent, input);`,
    current.replace('runner.run', 'sdk.run'),
    `import { run as runAgent } from '@openai/agents';\n${current}\nawait runAgent(agent, input, { stream: true, signal, maxTurns: 10 });`,
    `${current}\nconst { run } = sdk; await run(agent, input, { stream: true, signal, maxTurns: 10 });`,
    `${current}\nawait sdk["run"](agent, input, { maxTurns: 10 });`,
    `${current}\nawait runner['run'](agent, input);`,
    `${current}\nawait runner.run.call(runner, agent, input, { maxTurns: 10 });`,
    `${current}\nconst again = runner.run; await again.call(runner, agent, input);`,
  ]) assert.throws(() => assertSingleTurnRun(variant), assert.AssertionError, variant);
});

test('the toolUseBehavior check accepts only an explicit stop_on_first_tool', () => {
  const current = "model, tools, handoffs: [], toolUseBehavior: 'stop_on_first_tool',";
  assert.doesNotThrow(() => assertStopOnFirstTool(current));
  assert.doesNotThrow(() => assertStopOnFirstTool('toolUseBehavior :\n  "stop_on_first_tool",'));
  for (const variant of [
    'model, tools, handoffs: [],',
    current.replace("'stop_on_first_tool'", "'run_llm_again'"),
    current.replace("'stop_on_first_tool'", "{ stopAtToolNames: ['calculator'] }"),
    current.replace("'stop_on_first_tool'", '() => ({ isFinalOutput: false, isInterrupted: undefined })'),
    current.replace("'stop_on_first_tool'", 'behaviour'),
    `${current}\n...{ toolUseBehavior: 'run_llm_again' },`,
    `${current}\nagent.clone({ toolUseBehavior: 'run_llm_again' });`,
  ]) assert.throws(() => assertStopOnFirstTool(variant), assert.AssertionError, variant);
});

test('agent-runtime.mjs makes one runner.run call with { stream: true, signal, maxTurns: 1 } on an agent that stops on the first tool', async () => {
  const source = await readFile(join(WORKER_DIRECTORY, 'agent-runtime.mjs'), 'utf8');
  assertSingleTurnRun(source);
  assertStopOnFirstTool(source);
});
