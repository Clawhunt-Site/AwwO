import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createWorkerObservability, loadObservabilityConfig, parseInternalParent } from './observability.mjs';
import { emptyUsage } from './usage.mjs';

function configuration(env = {}) {
  return { models: [{ id: 'catalog-model', provider: 'openai', protocol: 'responses' }], maxConcurrency: 4,
    observability: loadObservabilityConfig(env, 'pi', 'development') };
}
const event = { type: 'completed', text: 'private-output', observability: { usage: { ...emptyUsage(), status: 'reported' }, timing: { workerTotalMs: 120, setupMs: 10, providerMs: 80, providerTtftMs: 30, workerFirstDeltaMs: 40 } } };

test('management metrics are disabled by default and reject non-loopback configuration', async () => {
  const disabled = createWorkerObservability(configuration());
  assert.equal(configuration({ OTEL_TRACES_SAMPLER_ARG: '' }).observability.ratio, 1);
  assert.throws(() => configuration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.openai.com/v1/traces' }), /internal/);
  assert.equal(disabled.server, undefined); await disabled.listen(); await disabled.close();
  for (const address of ['0.0.0.0:9102', 'localhost:9102', '192.168.1.2:9102', '127.0.0.1:99999']) assert.throws(() => configuration({ AWWO_METRICS_LISTEN_ADDR: address }), /loopback/);
  assert.throws(() => configuration({ AWWO_METRICS_ENABLED: 'yes' }), /true or false/);
  assert.throws(() => configuration({ AWWO_OTEL_ENABLED: 'true' }), /required/);
  assert.throws(() => configuration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://key:secret@host/' }), /without credentials/);
  assert.throws(() => configuration({ OTEL_TRACES_SAMPLER_ARG: '2' }), /between/);
});

test('independent real management listener has bounded labels and terminal counters are idempotent', async t => {
  const config = configuration({ AWWO_METRICS_ENABLED: 'true', AWWO_METRICS_LISTEN_ADDR: '127.0.0.1:0' });
  const monitor = createWorkerObservability(config, () => 2); t.after(() => monitor.close()); await monitor.listen();
  const finish = monitor.begin(config.models[0], 'private-invalid-parent'); finish({ type: 'text_delta', delta: 'private-input' }); finish(event); finish(event);
  const base = `http://127.0.0.1:${monitor.server.address().port}`;
  const response = await fetch(`${base}/metrics`); assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /awwo_worker_invocations_total\{runtime="pi",model="catalog-model",outcome="completed",usage_status="reported"\} 1/);
  assert.match(metrics, /awwo_worker_provider_ttft_seconds_count.* 1/); assert.match(metrics, /awwo_worker_active 2/);
  assert.ok(!metrics.includes('private')); assert.ok(!metrics.includes('tenant'));
  assert.equal((await fetch(`${base}/health`)).status, 404); assert.equal((await fetch(`${base}/metrics?prompt=private`)).status, 404);
});

test('bounded OTLP export uses authenticated parent identity and excludes content and custom env attributes', async t => {
  const batches = [];
  const collector = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    batches.push({ path: request.url, body: JSON.parse(text) }); response.writeHead(200); response.end('{}');
  });
  collector.listen(0, '127.0.0.1'); await once(collector, 'listening');
  t.after(async () => { collector.closeAllConnections(); await new Promise(resolve => collector.close(resolve)); });
  const config = configuration({ AWWO_OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`, OTEL_RESOURCE_ATTRIBUTES: 'tenant_id=private-tenant,prompt=private-prompt' });
  const monitor = createWorkerObservability(config); t.after(() => monitor.close());
  const trace = '1'.repeat(32), parent = '2'.repeat(16);
  const finish = monitor.begin(config.models[0], `00-${trace}-${parent}-01`); finish(event);
  await monitor.flush();
  assert.equal(batches.length, 1); assert.equal(batches[0].path, '/v1/traces');
  const spans = batches[0].body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2); assert.equal(spans[0].name, 'worker.run'); assert.equal(spans[0].traceId, trace); assert.equal(spans[0].parentSpanId, parent);
  assert.equal(spans[1].parentSpanId, spans[0].spanId); assert.equal(spans[1].name, 'worker.provider.call');
  const serialized = JSON.stringify(batches); assert.ok(!serialized.includes('private')); assert.ok(!serialized.includes('tenant_id'));
  monitor.begin(config.models[0], `00-${trace}-${parent}-00`)(event); await monitor.flush(); assert.equal(batches.length, 1);
  assert.equal(parseInternalParent(`00-${'0'.repeat(32)}-${parent}-01`), null);
});

test('collector failure is isolated and the exporter queue stays bounded', async t => {
  const config = configuration({ AWWO_OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' });
  const monitor = createWorkerObservability(config); t.after(() => monitor.close());
  for (let i = 0; i < 300; i++) monitor.begin(config.models[0])(event);
  assert.match(monitor.metrics(), /awwo_otel_dropped_spans_total 88/);
  await monitor.flush(); assert.match(monitor.metrics(), /awwo_otel_export_failures_total 1/);
  assert.match(monitor.metrics(), /usage_status="reported"\} 300/);
});

test('business listener never serves metrics and only an authenticated accepted run receives W3C parent', async t => {
  const { loadConfig } = await import('./config.mjs');
  const worker = await import('./server.mjs');
  const makeServer = worker.createPiServer ?? worker.createOpenAIAgentsServer;
  const token = 'private-auth-test-token-longer-than-32-characters';
  const config = loadConfig({
    AWWO_PI_PROVIDER: 'openai', AWWO_PI_BASE_URL: 'http://127.0.0.1:1/v1', AWWO_PI_TOKEN: token, AWWO_PI_MODEL: 'catalog-model', AWWO_PI_API_KEY: 'private-key',
    AWWO_OPENAI_AGENTS_TOKEN: token, AWWO_OPENAI_AGENTS_MODEL: 'catalog-model', AWWO_OPENAI_AGENTS_API_KEY: 'private-key',
    AWWO_METRICS_ENABLED: 'true', AWWO_METRICS_LISTEN_ADDR: '127.0.0.1:0',
  });
  let launched = 0;
  const app = makeServer(config, { startRun: async ({ onExit, onEvent }) => {
    launched++; onExit(); onEvent(event); return { cancel() {}, done: Promise.resolve() };
  } });
  t.after(() => app.close());
  await app.observability.listen(); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  const body = JSON.stringify({ runId: 'private-run', tenantId: 'private-tenant', sessionId: 'private-session', messages: [], prompt: 'private-prompt' });
  const headers = { 'content-type': 'application/json', traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`, baggage: 'private-baggage' };
  assert.equal((await fetch(`${url}/internal/runs`, { method: 'POST', headers, body })).status, 401); assert.equal(launched, 0);
  assert.ok(!app.observability.metrics().includes('usage_status='));
  const response = await fetch(`${url}/internal/runs`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body });
  assert.equal(response.status, 200); await response.text(); assert.equal(launched, 1);
  assert.match(app.observability.metrics(), /usage_status="reported"\} 1/);
  assert.ok(!app.observability.metrics().includes('private'));
});
