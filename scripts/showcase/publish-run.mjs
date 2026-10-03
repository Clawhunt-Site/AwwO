// Turns one raw run record from run-production-cases.mjs into the homepage record
// apps/web/src/saas/production-runs/<case>.ts. Each node's delivered value is read from the frozen
// graph run with the canvas's own contract parser; nothing is rewritten except identifier redaction.
//   node scripts/showcase/publish-run.mjs <raw-record.json> <notes.json>
// notes.json: { "note": { "zh": "…", "en": "…" }, "verification": { "zh": "…", "en": "…" },
//   "source": { "api": "<commit>", "worker": "<commit>" }, "thinking": false } — what happened in the run, what
// was checked in a browser before publishing, the revisions that ran, and whether thinking was off. All required.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact, writeRecord, writeSummary } from './publish-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [rawFile, notesFile] = process.argv.slice(2);
if (!rawFile || !notesFile) throw new Error('Usage: publish-run.mjs <raw-record.json> <notes.json>');
const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
for (const key of ['note', 'verification']) if (!notes[key]?.zh?.trim() || !notes[key]?.en?.trim()) throw new Error(`notes.${key} needs zh and en`);
// The revisions that ran and whether the model's thinking was off are part of the receipt, never assumed.
if (!/^[0-9a-f]{8,40}$/.test(notes.source?.api || '') || !/^[0-9a-f]{8,40}$/.test(notes.source?.worker || '') || typeof notes.thinking !== 'boolean')
  throw new Error('notes.source.api, notes.source.worker (commit hashes) and notes.thinking (boolean) are required');

const { build } = await import(pathToFileURL(path.join(ROOT, 'apps/web/node_modules/rolldown/dist/index.mjs')).href);
const bundle = path.join(path.dirname(path.resolve(rawFile)), '.publish-helpers.mjs');
await build({ input: path.join(ROOT, 'scripts/showcase/publish-helpers.ts'), platform: 'node', output: { file: bundle, format: 'esm' }, logLevel: 'warn' });
const { PRODUCTION_WORKFLOWS, createOfficialDocument, canonicalCanvasText, parseContractOutput, normalizeContract } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);

const workflow = PRODUCTION_WORKFLOWS[raw.caseId];
if (!workflow) throw new Error(`Unknown case ${raw.caseId}`);
const frozen = raw.graph.document.nodes.filter(node => node.kind === 'session');
if (frozen.length !== workflow.nodes.length) throw new Error('The frozen canvas does not have the workflow’s nodes');
// The homepage says a case ran on the canvas a member copies, so a run of any other text is never published.
const ranText = canonicalCanvasText(raw.graph.document);
if (ranText !== canonicalCanvasText(createOfficialDocument(workflow, raw.locale)))
  throw new Error(`${raw.caseId}: this run used a different canvas (tasks, contracts or wires) from productionWorkflows.ts today; run the case again`);
const states = new Map((raw.graph.nodes || []).map(node => [node.nodeId, node]));
const STATUS = new Set(['done', 'failed', 'blocked', 'cancelled', 'cached']);
const seconds = (from, to) => from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : undefined;
const usage = item => {
  const value = item?.usage;
  if (!value || item.usageStatus === 'invalid') return undefined;
  const tokens = { ...(Number.isFinite(value.inputTokens) ? { input: value.inputTokens } : {}), ...(Number.isFinite(value.outputTokens) ? { output: value.outputTokens } : {}) };
  return Object.keys(tokens).length ? tokens : undefined;
};
const nodes = workflow.nodes.map((spec, index) => {
  const document = frozen[index];
  if (document.title !== spec.title[raw.locale]) throw new Error(`Node ${index} is “${document.title}”, expected “${spec.title[raw.locale]}”`);
  const state = states.get(document.id);
  if (!state || !STATUS.has(state.state)) throw new Error(`${spec.id} ended as ${state?.state}`);
  const invocation = raw.invocations[spec.id] ?? raw.invocations[document.id];
  const item = Array.isArray(invocation?.items) ? invocation.items.at(-1) : undefined;
  const run = raw.runs[document.id];
  const contract = normalizeContract(document.contract);
  let output;
  if (state.state === 'done' && state.output) {
    const parsed = parseContractOutput(contract, state.output);
    if (parsed.errors.length) throw new Error(`${spec.id}: ${parsed.errors.join('; ')}`);
    output = redact(parsed.values.result);
  }
  return { id: spec.id, title: spec.title, column: spec.column, row: spec.row, status: state.state,
    ...(seconds(item?.admittedAt ?? run?.createdAt, item?.completedAt ?? run?.updatedAt) !== undefined ? { seconds: seconds(item?.admittedAt ?? run?.createdAt, item?.completedAt ?? run?.updatedAt) } : {}),
    outputType: spec.outputType ?? 'markdown', ...(output !== undefined ? { output } : {}),
    ...(state.detail ? { detail: redact(String(state.detail)) } : {}), ...(usage(item) ? { tokens: usage(item) } : {}) };
});
const artifact = workflow.nodes.find(node => node.outputType === 'html');
const artifactOutput = nodes.find(node => node.id === artifact?.id)?.output;
const catalog = raw.catalog?.runtimes?.find(runtime => runtime.id === raw.runtime);
const record = {
  caseId: raw.caseId,
  edition: { zh: '本地部署的 AwwO，API 与执行器和这次发布到线上的版本相同，使用默认执行设置', en: 'A local AwwO running the same API and runtime as the production release, on default execution settings' },
  runtime: raw.runtime, model: raw.model, capturedOn: raw.startedAt.slice(0, 10),
  seconds: seconds(raw.graph.createdAt, raw.graph.updatedAt), completed: nodes.filter(node => node.status === 'done').length, total: nodes.length,
  outputLocale: raw.locale,
  limits: { contextWindow: 32768, maxOutputTokens: 4096, modelCallsPerNode: 1, concurrency: 2, thinking: notes.thinking !== false },
  source: notes.source,
  canvasSHA256: crypto.createHash('sha256').update(ranText).digest('hex'),
  ...(artifactOutput ? { artifactNodeId: artifact.id, artifactSHA256: crypto.createHash('sha256').update(artifactOutput).digest('hex') } : {}),
  nodes, edges: workflow.edges, note: notes.note, verification: notes.verification,
};
if (!catalog?.available) console.warn('warning: the raw record’s runtime catalog did not list the runtime as available');
const target = path.join(ROOT, 'apps/web/src/saas/production-runs', `${raw.caseId}.ts`);
writeRecord(target, record);
writeSummary(path.join(path.dirname(target), 'summary.json'), record, Boolean(artifactOutput) && nodes.find(node => node.id === artifact.id)?.status === 'done');
console.log(`${raw.caseId}: ${record.completed}/${record.total} done, ${record.seconds}s → ${path.relative(ROOT, target)}`);
