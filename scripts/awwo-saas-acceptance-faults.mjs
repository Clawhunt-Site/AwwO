// Test-harness-only HTTP faults. Never imported by the application or dev launcher.
import { request } from 'node:http';

export function createAcceptanceFaults({ target, token, record = () => {}, now = Date.now }) {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('Fault proxy requires a fixed loopback API target');
  if (typeof token !== 'string' || token.length < 32) throw new Error('Fault control requires a random token');
  let rules = [];
  function replace(input) {
    if (!input || Object.keys(input).some(k => k !== 'rules') || !Array.isArray(input.rules) || input.rules.length > 32) throw new Error('Invalid fault rules');
    const ids = new Set();
    const next = input.rules.map(rule => {
      if (!rule || typeof rule !== 'object' || Object.keys(rule).some(k => !['id', 'method', 'path', 'status', 'delayMs', 'disconnect', 'ttlMs'].includes(k))) throw new Error('Invalid fault rule');
      if (typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rule.id) || ids.has(rule.id)) throw new Error('Invalid fault ID');
      ids.add(rule.id);
      if (!['GET', 'PUT'].includes(rule.method) || typeof rule.path !== 'string' || rule.path.length > 4096 || !/^\/api\/v1\/tenants\/[A-Za-z0-9_-]+\/(canvases|sessions|runs)(?:[/?][^\s#]*)?$/.test(rule.path)) throw new Error('Fault requires an exact tenant API path');
      if (rule.path.includes('..') || rule.path.includes('\\') || /%2e|%2f|%5c/i.test(rule.path)) throw new Error('Invalid fault path');
      if (rule.status !== undefined && rule.status !== 503) throw new Error('Only an explicit 503 response can be injected');
      if (rule.delayMs !== undefined && (!Number.isInteger(rule.delayMs) || rule.delayMs < 1 || rule.delayMs > 30000)) throw new Error('Invalid fault delay');
      if (rule.disconnect !== undefined && rule.disconnect !== true) throw new Error('Invalid disconnect rule');
      if (rule.disconnect && (rule.method !== 'GET' || !/^\/api\/v1\/tenants\/[A-Za-z0-9_-]+\/runs\/[A-Za-z0-9_-]+\/events$/.test(rule.path) || rule.status)) throw new Error('Disconnect is only supported for an exact run event stream');
      if (!rule.status && !rule.delayMs && !rule.disconnect) throw new Error('Fault rule needs an action');
      const ttlMs = rule.ttlMs ?? 60000;
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000) throw new Error('Invalid fault expiry');
      return { ...rule, expiresAt: now() + ttlMs };
    });
    rules = next; // Invalid replacements never partially install rules.
    return rules.map(({ id, method, path, expiresAt }) => ({ id, method, path, expiresAt }));
  }
  async function control(req, res) {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const installed = replace(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ installed }));
    } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid fixture fault rules' })); }
  }
  async function proxy(req, res) {
    if (!req.url?.startsWith('/api/v1/')) { res.writeHead(404).end(); return; }
    rules = rules.filter(rule => rule.expiresAt > now());
    const index = rules.findIndex(rule => rule.method === req.method && rule.path === req.url);
    const rule = index < 0 ? null : rules.splice(index, 1)[0];
    if (rule) record({ type: 'fault_consumed', id: rule.id, at: new Date(now()).toISOString() });
    if (rule?.delayMs) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); res.off('close', done); resolve(); };
      const timer = setTimeout(done, rule.delayMs); res.once('close', done);
    });
    if (res.destroyed) return;
    if (rule?.status) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: { code: 'fixture_unavailable', message: 'Explicit acceptance fault', faultId: rule.id } })); return; }
    // The target is fixed by the harness. Request paths can never change its host.
    const outgoing = request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, incoming => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      if (rule?.disconnect) {
        incoming.once('data', () => { incoming.destroy(); outgoing.destroy(); res.destroy(); });
        incoming.once('end', () => res.destroy());
        incoming.resume();
      } else incoming.pipe(res);
      incoming.on('error', () => res.destroy());
    });
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    res.once('close', () => outgoing.destroy());
    req.pipe(outgoing);
  }
  return { replace, control, proxy };
}
