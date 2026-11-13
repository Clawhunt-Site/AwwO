#!/usr/bin/env node
// Publishes the record of a CARRIED case: a canvas that carries a piece made before it (a game, a film), whose agents
// read and checked the piece's files and handed them on unchanged, and whose page node put the piece's page together.
// The canvas was laid out through the API on the live site and ran there; it is not a workflow of this repository
// (productionWorkflows.ts) and no copy of it is stored (its files are uploads that belong to the canvas they were
// made in, so a member's copy would carry nothing). What is published is what the agents delivered as text, and the
// run's facts; the files they handed on, and the page's own files, stay in the canvas.
//
//   node scripts/showcase/publish-carried-run.mjs <raw.json> [--dry]
//
// <raw.json>, gathered from the site after the run (never edited afterwards):
//   { caseId, locale: "en", edition, model, api, workers: { "<runtime>": "<revision>" }, limits: { contextWindow,
//     maxOutputTokens, modelCallsPerNode, thinking }, root: "<the page node's id>", note, verification,
//     document: <the canvas as the site holds it>, graphs: [<each graph run, oldest first>],
//     runs: { "<run id>": <the node run> }, invocations: { "<run id>": [<its model calls>] } }
//
// Writes apps/web/src/saas/production-runs/<case>.ts and summary.json, together or not at all. Refuses a run that is
// not whole (a node whose last run did not complete, an output no listed graph run made), a text that is not English,
// a placeholder note, and anything that names a provider, a machine path or one of AwwO's own identifiers.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { recordText, summaryText, writeTogether } from './publish-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MARKS = /tripo|x-?tasy|runninghub|bytedance|dreamina|jimeng|kuaishou|midjourney|pixverse|shengshu|seedance|seedream|minimax|nano.?banana|gemini|hailuo|kling/i;
const HARMLESS = /(?<![a-z])(?:(?:buc|cac|chuc|crac|crin|dar|duc|frec|hac|hec|in|knuc|pic|pric|ran|roc|shac|sic|spac|spar|spec|sprin|stic|suc|tac|tic|tin|tric|twin|wea|wrin)klings?|tripods?|geminids?)(?![a-z])/gi;
const DRIVE_PATH = /(?<![A-Za-z0-9\\])[A-Za-z]:[\\/](?!")|\\\\[?.]\\[A-Za-z]:/;
const HOME_PATH = /(?:^|[^A-Za-z0-9.])(?:\/Users\/|\/home\/|~\/)/;
const OWN_ID = /awwo-file:|(?<![A-Za-z0-9_-])a[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])|\bcv-[0-9a-z]{6,}-[0-9a-z]+-[0-9a-z]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const seconds = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));

/** The record of a carried case from its raw run, or an Error saying what is not whole. Pure: nothing is read or written. */
export function carriedRecord(raw) {
  const fail = message => { throw new Error(`${raw.caseId ?? 'case'}: ${message}`); };
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(raw.caseId ?? '')) fail('caseId is missing or not a slug');
  if (raw.locale !== 'en') fail('a case is English: locale must be "en"');
  for (const key of ['edition', 'model', 'api', 'note', 'verification', 'root']) if (typeof raw[key] !== 'string' || !raw[key].trim()) fail(`${key} is missing`);
  for (const key of ['note', 'verification', 'edition']) if (/PROVISIONAL|TODO|TBD|placeholder|lorem ipsum/i.test(raw[key])) fail(`${key} is a placeholder, not what was done`);
  if (!/^[0-9a-f]{40}$/.test(raw.api)) fail('api must be the 40-digit revision the run ran on');
  const graphs = raw.graphs ?? [];
  if (!graphs.length) fail('no graph run');
  const agents = (raw.document?.nodes ?? []).filter(node => node.kind === 'session');
  if (agents.length !== (raw.document?.nodes ?? []).length || !agents.length) fail('a carried canvas has agent nodes only');
  const columns = [...new Set(agents.map(node => node.x))].sort((a, b) => a - b);
  // Each node's last run among the listed graph runs: the one that made what the canvas holds.
  const last = new Map();
  for (const graph of graphs) for (const entry of graph.nodes ?? []) if (entry.runId && entry.state !== 'cached') last.set(entry.nodeId, entry);
  const nodes = agents.map(node => {
    const entry = last.get(node.id);
    if (!entry) fail(`${node.id} was run by none of the listed graph runs`);
    if (entry.state !== 'done') fail(`${node.id} did not complete (${entry.state})`);
    const run = raw.runs?.[entry.runId];
    if (!run || run.status !== 'completed' || typeof run.output !== 'string') fail(`${node.id}: its run is not among the raw runs, or did not complete`);
    const workstation = node.runtime === 'blender';
    if (!workstation && node.runtime !== 'openai-agents') fail(`${node.id}: a carried canvas's agents chat or work in the workstation (${node.runtime})`);
    if (!raw.workers?.[node.runtime] || !/^[0-9a-f]{40}$/.test(raw.workers[node.runtime])) fail(`workers.${node.runtime} must be the 40-digit revision the node ran on`);
    const outputs = node.contract?.outputs ?? [];
    const result = outputs.find(field => field.id === 'result');
    if (!result) fail(`${node.id} has no result output`);
    // A node with one text output delivers that text; one with more delivers a JSON object keyed by its outputs.
    let fields = { result: run.output };
    if (outputs.length > 1) { try { fields = JSON.parse(run.output); } catch { fail(`${node.id}: its delivery is not the JSON object its outputs ask for`); } }
    if (typeof fields.result !== 'string' || !fields.result.trim()) fail(`${node.id} delivered no result`);
    const report = outputs.some(field => field.id === 'report') ? fields.report : undefined;
    if (outputs.some(field => field.id === 'report') && (typeof report !== 'string' || !report.trim())) fail(`${node.id} delivered no report`);
    const calls = raw.invocations?.[entry.runId] ?? [];
    if (!calls.length) fail(`${node.id}: its model calls are not among the raw invocations`);
    const sum = key => calls.reduce((total, call) => total + Number(call.usage?.[key] ?? 0), 0);
    return {
      id: node.id, title: node.title, column: columns.indexOf(node.x), row: 0, y: node.y, status: 'done',
      seconds: seconds(entry.startedAt, entry.endedAt), outputType: result.type === 'html' ? 'html' : 'markdown', output: fields.result,
      ...(report ? { report } : {}), ...(workstation ? { blender: true } : {}), ...(calls.length > 1 ? { calls: calls.length } : {}),
      tokens: { input: sum('inputTokens'), output: sum('outputTokens') }, brief: node.persona,
      started: entry.startedAt, ended: entry.endedAt, runtime: node.runtime,
    };
  });
  // Rows count down each stage in the order the canvas places them.
  for (const column of new Set(nodes.map(node => node.column))) nodes.filter(node => node.column === column).sort((a, b) => a.y - b.y).forEach((node, row) => { node.row = row; });
  const root = nodes.find(node => node.id === raw.root);
  if (!root || root.outputType !== 'html') fail('root must be the node that delivered the page');
  const label = (id, port) => agents.find(node => node.id === id)?.contract?.outputs?.find(field => field.id === port)?.label ?? port;
  const edges = (raw.document.edges ?? []).map(edge => {
    const port = edge.fromPort.replace(/^out:/, '');
    return { from: edge.fromNode, to: edge.toNode, label: label(edge.fromNode, port), ...(port === 'result' ? {} : { port }) };
  });
  const starts = graphs.map(graph => graph.createdAt), ends = graphs.map(graph => graph.updatedAt);
  const whole = seconds(starts[0], ends.at(-1)), active = graphs.reduce((total, graph) => total + seconds(graph.createdAt, graph.updatedAt), 0);
  // The most agents at work at one moment, from each node's own start and end.
  const moments = nodes.flatMap(node => [[Date.parse(node.started), 1], [Date.parse(node.ended), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0, concurrency = 0;
  for (const [, step] of moments) { running += step; concurrency = Math.max(concurrency, running); }
  const runtimes = [...new Set(nodes.map(node => node.runtime))];
  const order = ['openai-agents', 'blender'].filter(name => runtimes.includes(name));
  const record = {
    caseId: raw.caseId, edition: raw.edition, runtime: order.join(' + '), model: raw.model, capturedOn: ends.at(-1).slice(0, 10), seconds: whole,
    ...(graphs.length > 1 ? { runs: graphs.length, activeSeconds: active } : {}),
    completed: nodes.length, total: nodes.length,
    limits: { contextWindow: raw.limits.contextWindow, maxOutputTokens: raw.limits.maxOutputTokens, modelCallsPerNode: raw.limits.modelCallsPerNode, concurrency, thinking: raw.limits.thinking },
    source: { api: raw.api, worker: raw.workers[order.at(-1)],
      ...(order.length > 1 ? { runs: order.map(name => ({ api: raw.api, worker: raw.workers[name], nodes: nodes.filter(node => node.runtime === name).map(node => node.id) })) } : {}) },
    canvasSHA256: sha256(JSON.stringify({ nodes: agents.map(node => ({ id: node.id, title: node.title, persona: node.persona, runtime: node.runtime, model: node.model, contract: node.contract })), edges: raw.document.edges })),
    canvas: 'carried', artifactNodeId: root.id, artifactSHA256: sha256(root.output),
    nodes: nodes.map(({ y, started, ended, runtime, ...node }) => node),
    edges, note: raw.note, verification: raw.verification,
  };
  // Nothing private, nothing that names a provider, nothing that is not English.
  const strings = [];
  const walk = value => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  walk({ ...record, source: undefined, canvasSHA256: undefined, artifactSHA256: undefined });
  for (const text of strings) {
    const hit = MARKS.exec(text.replace(HARMLESS, ' '));
    if (hit) fail(`a text names a provider: “${hit[0]}”`);
    if (/\p{Script=Han}/u.test(text)) fail(`a text is not English: “${text.match(/\p{Script=Han}+/u)[0]}”`);
    if (DRIVE_PATH.test(text) || HOME_PATH.test(text)) fail(`a text holds a machine path: “${text.slice(Math.max(0, text.search(DRIVE_PATH) - 20), text.search(DRIVE_PATH) + 40)}”`);
    // AwwO's own identifiers: a stored file's reference, a tenant's, run's or session's id, a canvas's own node id, a
    // UUID. (Not publish-common's identifying(): it also takes any 64 hex digits for a workspace's id, and these
    // agents report the SHA-256 of what they hand on; nor a workspace path, which names no one.)
    const own = OWN_ID.exec(text);
    if (own) fail(`a text holds one of AwwO's identifiers: “${own[0].slice(0, 24)}…”`);
  }
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, flag] = process.argv.slice(2);
  if (!file) { console.error('usage: publish-carried-run.mjs <raw.json> [--dry]'); process.exit(2); }
  const record = carriedRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
  const runsDir = path.join(ROOT, 'apps/web/src/saas/production-runs');
  const summary = path.join(runsDir, 'summary.json');
  if (flag !== '--dry') writeTogether([[path.join(runsDir, `${record.caseId}.ts`), recordText(record)], [summary, summaryText(summary, record, true)]]);
  console.log(`${record.caseId}: ${record.completed}/${record.total} nodes, ${record.seconds} s${record.runs ? ` in ${record.runs} runs (${record.activeSeconds} s at work)` : ''}, up to ${record.limits.concurrency} at once${flag === '--dry' ? ' (dry: nothing written)' : ''}`);
}
