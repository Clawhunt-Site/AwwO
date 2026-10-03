// Runs the homepage production-case canvases (apps/web/src/saas/productionWorkflows.ts) through an AwwO
// API exactly the way the canvas does — create, initialize, start a graph run, wait — and writes one raw
// record per case: the frozen graph run with every node's state and output, each node run and its model
// invocations, and the runtime catalog the API advertised. It never edits an output.
//
//   AWWO_SHOWCASE_EMAIL=… AWWO_SHOWCASE_PASSWORD=… node scripts/showcase/run-production-cases.mjs \
//     --api http://127.0.0.1:58821 --out .local/showcase/runs [--cases pixel-platformer,party-game]
//     [--locale zh] [--runtime openai-agents] [--model qwen3.8-27b-p6]
//
// The account is registered when it does not exist yet (local sign-in only). It refuses any API that is
// not on this machine: every case creates a canvas and spends model calls. Requires apps/web/node_modules (rolldown).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
const API = (args.api || 'http://127.0.0.1:58821').replace(/\/$/, '');
// It registers an account, creates canvases and spends model calls, so it only ever talks to a stack on this
// machine: never production, never a shared environment.
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(API).hostname)) throw new Error(`Refusing ${API}: point --api at a private stack on this machine.`);
const OUT = path.resolve(args.out || '.local/showcase/runs');
const LOCALE = args.locale || 'zh', RUNTIME = args.runtime || 'openai-agents', MODEL = args.model || 'qwen3.8-27b-p6';
const EMAIL = process.env.AWWO_SHOWCASE_EMAIL, PASSWORD = process.env.AWWO_SHOWCASE_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('Set AWWO_SHOWCASE_EMAIL and AWWO_SHOWCASE_PASSWORD (at least 12 characters).');
fs.mkdirSync(OUT, { recursive: true });

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
let cookie = '';
async function call(method, route, body) {
  const response = await fetch(`${API}/api/v1${route}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const set = response.headers.get('set-cookie');
  if (set?.startsWith('awwo_session=')) cookie = set.split(';')[0];
  const text = await response.text();
  let payload; try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) { const error = new Error(`${method} ${route} → ${response.status} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`); error.status = response.status; throw error; }
  return payload;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function documents() {
  const { build } = await import(pathToFileURL(path.join(ROOT, 'apps/web/node_modules/rolldown/dist/index.mjs')).href);
  const file = path.join(OUT, '.case-documents.mjs');
  await build({ input: path.join(ROOT, 'scripts/showcase/case-documents.ts'), platform: 'node', output: { file, format: 'esm' }, logLevel: 'warn' });
  const module = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return module.caseDocuments(LOCALE, RUNTIME, MODEL);
}

async function signIn() {
  try { await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD }); }
  catch (error) {
    if (error.status !== 401) throw error;
    await call('POST', '/auth/register', { email: EMAIL, password: PASSWORD, name: 'AwwO showcase', tenantName: 'AwwO showcase' });
  }
  const me = await call('GET', '/auth/me');
  const tenant = me.tenants.find(item => item.status === 'active' && item.role === 'owner') || me.tenants[0];
  if (!tenant) throw new Error('The account has no workspace.');
  return tenant;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
async function runCase(tenant, id, { name, document }, catalog) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = new Date().toISOString();
  const canvas = await call('POST', `/tenants/${tenant.id}/canvases`, { name: `${name} · ${stamp}`, document });
  const initialized = await call('POST', `/tenants/${tenant.id}/canvases/${canvas.id}/initialize`, { documentVersion: canvas.version });
  const operationId = `showcase-${id}-${stamp}`.slice(0, 200);
  let graph = await call('POST', `/tenants/${tenant.id}/canvases/${canvas.id}/graph-runs`, { operationId, documentVersion: initialized.version });
  log(`${id}: graph ${graph.id} started on canvas ${canvas.id}`);
  const seen = new Map();
  while (!TERMINAL.has(graph.status)) {
    await sleep(5000);
    try { graph = await call('GET', `/tenants/${tenant.id}/canvases/${canvas.id}/graph-runs/${graph.id}`); }
    catch (error) { log(`${id}: poll failed (${error.message}); retrying`); continue; }
    for (const node of graph.nodes || []) {
      if (seen.get(node.nodeId) === node.state) continue;
      seen.set(node.nodeId, node.state);
      const title = document.nodes.find(item => item.id === node.nodeId)?.title || node.nodeId;
      log(`${id}: ${title} → ${node.state}${node.detail ? ` (${String(node.detail).slice(0, 160)})` : ''}`);
    }
  }
  const runs = {}, invocations = {};
  for (const node of graph.nodes || []) {
    if (!node.runId) continue;
    runs[node.nodeId] = await call('GET', `/tenants/${tenant.id}/runs/${node.runId}`).catch(error => ({ error: error.message }));
    invocations[node.nodeId] = await call('GET', `/tenants/${tenant.id}/runs/${node.runId}/invocations`).catch(error => ({ error: error.message }));
  }
  const record = { caseId: id, locale: LOCALE, runtime: RUNTIME, model: MODEL, api: API, startedAt: started, finishedAt: new Date().toISOString(),
    canvas: { id: canvas.id, initializedVersion: initialized.version, document: initialized.document }, graph, runs, invocations, catalog };
  const file = path.join(OUT, `${id}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  const done = (graph.nodes || []).filter(node => node.state === 'done').length;
  log(`${id}: ${graph.status}, ${done}/${(graph.nodes || []).length} nodes done → ${path.relative(process.cwd(), file)}`);
  return graph.status;
}

const all = await documents();
const wanted = args.cases ? args.cases.split(',').map(value => value.trim()).filter(Boolean) : Object.keys(all);
for (const id of wanted) if (!all[id]) throw new Error(`Unknown case ${id}; known: ${Object.keys(all).join(', ')}`);
const tenant = await signIn();
const catalog = await call('GET', `/tenants/${tenant.id}/runtime`).catch(error => ({ error: error.message }));
log(`signed in; workspace ${tenant.id}; ${wanted.length} case(s); model ${RUNTIME}/${MODEL}`);
const results = {};
for (const id of wanted) {
  try { results[id] = await runCase(tenant, id, all[id], catalog); }
  catch (error) { results[id] = `error: ${error.message}`; log(`${id}: ${error.message}`); }
}
console.log(JSON.stringify(results, null, 2));
