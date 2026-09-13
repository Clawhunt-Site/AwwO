import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const flag = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value === 'true';
};
export function loadObservabilityConfig(env, runtime, environment) {
  const enabled = flag(env.AWWO_METRICS_ENABLED, false, 'AWWO_METRICS_ENABLED');
  const address = env.AWWO_METRICS_LISTEN_ADDR || `127.0.0.1:${runtime === 'pi' ? 9102 : 9103}`;
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(address);
  if (!match || Number(match[2]) > 65535) throw new Error('AWWO_METRICS_LISTEN_ADDR must be an explicit loopback IP and port');
  const tracing = flag(env.AWWO_OTEL_ENABLED, false, 'AWWO_OTEL_ENABLED');
  let endpoint = '';
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      const u = new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
      const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const ip = isIP(host), octets = host.split('.').map(Number);
      const loopback = host === 'localhost' || host === '::1' || (ip === 4 && octets[0] === 127);
      const privateIP = ip === 4 ? octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 : ip === 6 && /^(fc|fd|fe[89ab])/.test(host);
      const privateName = !ip && (/^[a-z0-9-]+$/.test(host) || host.endsWith('.internal') || host.endsWith('.svc.cluster.local'));
      if (!loopback && !privateIP && !privateName || environment !== 'development' && u.protocol === 'http:' && !loopback) throw new Error();
      u.pathname = `${u.pathname.replace(/\/$/, '').replace(/\/v1\/traces$/, '')}/v1/traces`;
      endpoint = u.href;
    } catch { throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an internal HTTP collector URL without credentials or query; non-development remote collectors require HTTPS'); }
  }
  if (tracing && !endpoint) throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT is required when tracing is enabled');
  if (env.OTEL_TRACES_SAMPLER && env.OTEL_TRACES_SAMPLER !== 'parentbased_traceidratio') throw new Error('OTEL_TRACES_SAMPLER must be parentbased_traceidratio');
  const ratioValue = env.OTEL_TRACES_SAMPLER_ARG || (environment === 'production' ? '0.05' : '1');
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(ratioValue)) throw new Error('OTEL_TRACES_SAMPLER_ARG must be between 0 and 1');
  const revision = env.AWWO_REVISION || env.BUILD_REVISION || 'unknown';
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(revision)) throw new Error('AWWO_REVISION must be a bounded revision identifier');
  const serviceName = `awwo-${runtime}-worker`;
  if (env.OTEL_SERVICE_NAME && env.OTEL_SERVICE_NAME !== serviceName) throw new Error('OTEL_SERVICE_NAME must match this worker service');
  // Deliberately ignore arbitrary OTEL_RESOURCE_ATTRIBUTES and exporter header
  // env vars; neither is an approved path for user data or exporter credentials.
  return Object.freeze({ enabled, host: match[1] === '[::1]' ? '::1' : match[1], port: Number(match[2]), tracing, endpoint, ratio: Number(ratioValue), revision, serviceName, runtime, environment });
}

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 610];
const safeLabel = value => JSON.stringify(value).replace(/\n/g, '\\n');
const nanos = ms => String(BigInt(Math.floor(ms * 1_000_000)));
const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) } });
export function parseInternalParent(value) {
  if (typeof value !== 'string') return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/.exec(value);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], parentSpanId: match[2], sampled: match[3] === '01' };
}

export function createWorkerObservability(config, activeRuns = () => 0) {
  const c = config.observability;
  const counts = new Map(), histograms = new Map();
  let exportFailures = 0, droppedSpans = 0, exporter, timer, closed = false;
  const queue = [];
  const descriptors = new Map(config.models.map(model => [model.id, {
    runtime: c.runtime, model: model.id, provider: model.provider,
    protocol: model.protocol ?? (model.provider === 'anthropic' ? 'anthropic_messages' : 'chat_completions'),
  }]));
  const exportBatch = () => {
    if (closed || exporter || !queue.length) return exporter ?? Promise.resolve();
    const spans = queue.splice(0, 128);
    const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [attr('service.name', c.serviceName), attr('deployment.environment.name', c.environment), attr('service.version', c.revision)] }, scopeSpans: [{ scope: { name: 'awwo.worker', version: '1.0.0' }, spans }] }] });
    // Fixed size/time bounds, no retries and no awaiting from model execution.
    exporter = fetch(c.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000), headers: { 'content-type': 'application/json' }, body })
      .then(async response => { if (!response.ok) exportFailures++; await response.body?.cancel(); })
      .catch(() => { exportFailures++; })
      .finally(() => { exporter = undefined; });
    return exporter;
  };
  if (c.tracing) { timer = setInterval(exportBatch, 500); timer.unref(); }
  const enqueue = span => { if (queue.length < 512) queue.push(span); else droppedSpans++; };
  function observe(name, labels, milliseconds) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return;
    const key = `${name}{${labels}}`;
    let h = histograms.get(key);
    if (!h) { h = { name, labels, count: 0, sum: 0, buckets: buckets.map(() => 0) }; histograms.set(key, h); }
    const value = milliseconds / 1000; h.count++; h.sum += value;
    buckets.forEach((bound, index) => { if (value <= bound) h.buckets[index]++; });
  }
  function begin(model, traceparent) {
    const descriptor = descriptors.get(model.id);
    const parent = parseInternalParent(traceparent);
    const traceId = parent?.traceId ?? randomBytes(16).toString('hex');
    const sampled = c.tracing && (parent ? parent.sampled : Number.parseInt(traceId.slice(-13), 16) / 2 ** 52 < c.ratio);
    const spanId = randomBytes(8).toString('hex');
    const start = Date.now(), monotonic = performance.now();
    let settled = false;
    return event => {
      if (settled || !['completed', 'failed', 'cancelled'].includes(event.type)) return;
      settled = true;
      const outcome = event.type;
      const usageStatus = ['reported', 'partial', 'unavailable', 'invalid', 'unknown'].includes(event.observability?.usage?.status) ? event.observability.usage.status : 'unavailable';
      const labels = `runtime=${safeLabel(c.runtime)},model=${safeLabel(descriptor?.model ?? 'unknown')}`;
      const countKey = `${labels},outcome=${safeLabel(outcome)},usage_status=${safeLabel(usageStatus)}`;
      counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
      const timing = event.observability?.timing ?? {};
      for (const [name, field] of [['awwo_worker_duration_seconds', 'workerTotalMs'], ['awwo_worker_provider_duration_seconds', 'providerMs'], ['awwo_worker_provider_ttft_seconds', 'providerTtftMs'], ['awwo_worker_first_delta_seconds', 'workerFirstDeltaMs']]) observe(name, labels, timing[field]);
      if (!sampled) return;
      const attributes = [attr('awwo.runtime', c.runtime), attr('awwo.model', descriptor?.model ?? 'unknown'), attr('awwo.outcome', outcome)];
      const total = Math.max(0, performance.now() - monotonic);
      enqueue({ traceId, spanId, ...(parent ? { parentSpanId: parent.parentSpanId } : {}), name: 'worker.run', kind: 2, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(start + total), attributes, status: { code: outcome === 'completed' ? 1 : 2 } });
      if (Number.isSafeInteger(timing.providerMs) && Number.isSafeInteger(timing.setupMs)) {
        const offset = Math.max(0, Math.min(timing.setupMs, total));
        enqueue({ traceId, spanId: randomBytes(8).toString('hex'), parentSpanId: spanId, name: 'worker.provider.call', kind: 3, startTimeUnixNano: nanos(start + offset), endTimeUnixNano: nanos(start + Math.min(total, offset + timing.providerMs)), attributes: [...attributes, attr('awwo.provider', descriptor?.provider ?? 'unknown'), attr('awwo.protocol', descriptor?.protocol ?? 'unknown')], status: { code: outcome === 'completed' ? 1 : 2 } });
      }
    };
  }
  function metrics() {
    const lines = ['# TYPE awwo_worker_invocations_total counter'];
    for (const [labels, count] of counts) lines.push(`awwo_worker_invocations_total{${labels}} ${count}`);
    for (const name of new Set([...histograms.values()].map(h => h.name))) lines.push(`# TYPE ${name} histogram`);
    for (const h of histograms.values()) {
      buckets.forEach((bound, index) => lines.push(`${h.name}_bucket{${h.labels},le="${bound}"} ${h.buckets[index]}`));
      lines.push(`${h.name}_bucket{${h.labels},le="+Inf"} ${h.count}`, `${h.name}_count{${h.labels}} ${h.count}`, `${h.name}_sum{${h.labels}} ${h.sum}`);
    }
    lines.push('# TYPE awwo_worker_active gauge', `awwo_worker_active ${activeRuns()}`, '# TYPE awwo_worker_capacity gauge', `awwo_worker_capacity ${config.maxConcurrency}`, '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${process.memoryUsage().rss}`, '# TYPE awwo_otel_export_failures_total counter', `awwo_otel_export_failures_total ${exportFailures}`, '# TYPE awwo_otel_dropped_spans_total counter', `awwo_otel_dropped_spans_total ${droppedSpans}`);
    return `${lines.join('\n')}\n`;
  }
  const server = c.enabled ? createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' }); response.end(metrics());
  }) : undefined;
  return {
    server, begin, metrics, flush: exportBatch,
    async listen() {
      if (!server || server.listening) return;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.port, c.host, () => { server.removeListener('error', reject); resolve(); }); });
    },
    async close() {
      clearInterval(timer);
      if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      await exporter;
      await exportBatch();
      closed = true;
      queue.length = 0;
    },
  };
}
