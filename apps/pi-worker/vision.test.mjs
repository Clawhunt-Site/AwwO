import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { INPUT_LIMITS, loadConfig, publicHealth, resolveModelConfig, validateRequest } from './config.mjs';
import { startIsolatedRun } from './runner.mjs';
import { createPiServer } from './server.mjs';

// Pictures a model sees (vision): the API sends a run's pictures as `images` only to a worker that claims
// `imageInput` and only for a model whose input lists 'image'; this worker checks both again.
const TOKEN = 'local-test-service-token-with-32-characters';
const ENV = { AWWO_PI_TOKEN: TOKEN, AWWO_PI_PROVIDER: 'openai', AWWO_PI_MODEL: 'test-model', AWWO_PI_API_KEY: 'provider-test-key' };
const REQUEST = { runId: 'run_1', tenantId: 'tenant_1', sessionId: 'session_1', prompt: 'What is in this picture?', messages: [] };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const picture = (extra = {}) => ({ name: 'cat.png', mimeType: 'image/png', data: PNG, ...extra });
const SEER = { id: 'seer', provider: 'openai', model: 'seeing-model', apiKeyEnv: 'SEER_KEY', input: ['text', 'image'] };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('a run may carry up to six well-formed pictures and nothing else', () => {
  assert.equal(validateRequest({ ...REQUEST, images: [picture()] }).images.length, 1);
  assert.equal(validateRequest({ ...REQUEST, images: Array.from({ length: INPUT_LIMITS.images }, () => picture({ mimeType: 'image/webp' })) }).images.length, 6);
  for (const images of [[], {}, 'cat.png', Array.from({ length: 7 }, () => picture()), [picture({ mimeType: 'image/bmp' })],
    [picture({ mimeType: 'image/svg+xml' })], [picture({ data: 'not base64!' })], [picture({ data: 'AAA' })], [picture({ data: '' })],
    [picture({ name: '' })], [picture({ name: 'x'.repeat(201) })], [picture({ url: 'https://example.test/cat.png' })], ['cat.png'],
    [picture({ data: 'A'.repeat(5_242_884) })]]) {
    assert.throws(() => validateRequest({ ...REQUEST, images }), /Invalid images/, JSON.stringify(images).slice(0, 80));
  }
});

test('profiles say what their model takes; health reports it per model and claims pictures', () => {
  const config = loadConfig({ ...ENV, SEER_KEY: 'seer-secret', AWWO_PI_MODELS_JSON: JSON.stringify([SEER]) });
  assert.deepEqual(resolveModelConfig(config).input, ['text']);
  assert.deepEqual(resolveModelConfig(config, 'seer').input, ['text', 'image']);
  const health = publicHealth(config);
  assert.equal(health.imageInput, true);
  assert.deepEqual(health.models.map(model => model.input), [['text'], ['text', 'image']]);
  assert.equal(health.limits.images, 6);
  assert.equal(health.limits.imageBytes, 3_932_160);
  assert.deepEqual(resolveModelConfig(loadConfig({ ...ENV, AWWO_PI_INPUT: 'text, image' })).input, ['text', 'image']);
  assert.deepEqual(resolveModelConfig(loadConfig({ ...ENV, AWWO_PI_INPUT: '' })).input, ['text']);
  for (const value of ['image', 'text,text', 'text,audio']) assert.throws(() => loadConfig({ ...ENV, AWWO_PI_INPUT: value }), /AWWO_PI_INPUT/);
  for (const input of [['image'], ['text', 'text'], ['text', 'audio'], 'text', []]) {
    assert.throws(() => loadConfig({ ...ENV, SEER_KEY: 'k', AWWO_PI_MODELS_JSON: JSON.stringify([{ ...SEER, input }]) }), /input list/);
  }
  // A Bedrock profile of MODELS_JSON says it too, and stays text unless it does.
  const bedrock = loadConfig({ ...ENV, AWWO_PI_MODELS_JSON: JSON.stringify([
    { id: 'claude', provider: 'bedrock', model: 'global.anthropic.claude-opus-5-5', input: ['text', 'image'] },
    { id: 'deepseek', provider: 'bedrock', model: 'deepseek.v3.2' }]) });
  assert.deepEqual(resolveModelConfig(bedrock, 'claude').input, ['text', 'image']);
  assert.deepEqual(resolveModelConfig(bedrock, 'deepseek').input, ['text']);
});

test('pictures go to a seeing model run and are refused for a text model before any run starts', async t => {
  const config = loadConfig({ ...ENV, SEER_KEY: 'seer-secret', AWWO_PI_MODELS_JSON: JSON.stringify([SEER]) });
  const started = [];
  const app = createPiServer(config, { startRun: async ({ request, onEvent, onExit }) => {
    started.push(request);
    setImmediate(() => { onEvent({ type: 'completed', text: 'a cat' }); onExit(); });
    return { cancel() {}, done: Promise.resolve(), pid: 0, directory: '' };
  } });
  const url = await listen(app.server);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const refused = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, images: [picture()] }) });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'IMAGES_UNSUPPORTED');
  assert.equal(started.length, 0);
  const accepted = await fetch(`${url}/internal/runs`, { method: 'POST', headers, body: JSON.stringify({ ...REQUEST, runId: 'run_2', model: 'seer', images: [picture()] }) });
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /"type":"completed"/);
  assert.deepEqual(started[0].images, [picture()]);
  // Six pictures of the largest size fit the body bound.
  const big = 'A'.repeat(Math.floor(INPUT_LIMITS.imageBytes / 3) * 4);
  const largest = await fetch(`${url}/internal/runs`, { method: 'POST', headers,
    body: JSON.stringify({ ...REQUEST, runId: 'run_3', sessionId: 'session_3', model: 'seer', images: Array.from({ length: 6 }, () => picture({ data: big })) }) });
  assert.equal(largest.status, 200);
  await largest.text();
  assert.equal(started.length, 2);
});

test('an isolated Pi run sends the pictures with the final user turn to an OpenAI-compatible model', { timeout: 30000 }, async t => {
  const bodies = [];
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'seeing-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: 'A tiny ' });
    send({ content: 'picture.' });
    send({}, 'stop');
    res.end('data: [DONE]\n\n');
  });
  const baseURL = `${await listen(provider)}/v1`;
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  const config = loadConfig({ ...ENV, SEER_KEY: 'seer-secret', AWWO_PI_TIMEOUT_MS: '20000', AWWO_PI_CANCEL_GRACE_MS: '100',
    AWWO_PI_MODELS_JSON: JSON.stringify([{ ...SEER, baseURL }]) });
  const events = [];
  const request = { ...REQUEST, model: 'seer', messages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Answer' }], images: [picture()] };
  const handle = await startIsolatedRun({ config, request, onEvent: event => events.push(event) });
  t.after(async () => { handle.cancel(); await handle.done; });
  await handle.done;
  const terminal = events.find(event => event.type === 'completed' || event.type === 'failed');
  assert.equal(terminal?.type, 'completed', JSON.stringify(terminal));
  const messages = bodies[0].messages;
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content), JSON.stringify(last));
  assert.deepEqual(last.content.find(part => part.type === 'image_url')?.image_url?.url, `data:image/png;base64,${PNG}`);
  assert.ok(last.content.some(part => part.type === 'text' && part.text.includes('What is in this picture?')));
  // History stays text: the picture belongs to this turn only.
  assert.equal(JSON.stringify(messages.slice(0, -1)).includes('image_url'), false);
});
