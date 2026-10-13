// Turns one raw run record from run-production-cases.mjs into the homepage record
// apps/web/src/saas/production-runs/<case>.ts. Each node's delivered value is read from the frozen
// graph run with the canvas's own contract parser; nothing is rewritten except identifier redaction.
//   node scripts/showcase/publish-run.mjs <raw-record.json> <notes.json>
// notes.json: { "note": { "zh": "…", "en": "…" }, "verification": { "zh": "…", "en": "…" }, "edition": { "zh": "…", "en": "…" },
//   "source": { "api": "<commit>", "worker": "<commit>" }, "thinking": false, "model": "<label shown>" (optional),
//   "limits": { "contextWindow": n, "maxOutputTokens": n, "modelCallsPerNode": n, "concurrency": n } } — what happened in
// the run, what was checked in a browser before publishing, where it ran, the revisions that ran, whether thinking was
// off, and the execution settings it had. All required except the model label.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact, writeRecord, writeSummary } from './publish-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [rawFile, notesFile] = process.argv.slice(2);
if (!rawFile || !notesFile) throw new Error('Usage: publish-run.mjs <raw-record.json> <notes.json>');
const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
for (const key of ['note', 'verification', 'edition']) if (!notes[key]?.zh?.trim() || !notes[key]?.en?.trim()) throw new Error(`notes.${key} needs zh and en`);
// The revisions that ran and whether the model's thinking was off are part of the receipt, never assumed.
if (!/^[0-9a-f]{8,40}$/.test(notes.source?.api || '') || !/^[0-9a-f]{8,40}$/.test(notes.source?.worker || '') || typeof notes.thinking !== 'boolean')
  throw new Error('notes.source.api, notes.source.worker (commit hashes) and notes.thinking (boolean) are required');
// The execution settings the run actually had (the model's own limits on the runtime that ran it), never a default.
const LIMIT_KEYS = ['contextWindow', 'maxOutputTokens', 'modelCallsPerNode', 'concurrency'];
if (!notes.limits || LIMIT_KEYS.some(key => !Number.isInteger(notes.limits[key]) || notes.limits[key] <= 0))
  throw new Error(`notes.limits needs positive integers ${LIMIT_KEYS.join(', ')}`);

const { build } = await import(pathToFileURL(path.join(ROOT, 'apps/web/node_modules/rolldown/dist/index.mjs')).href);
const bundle = path.join(path.dirname(path.resolve(rawFile)), '.publish-helpers.mjs');
await build({ input: path.join(ROOT, 'scripts/showcase/publish-helpers.ts'), platform: 'node', output: { file: bundle, format: 'esm' }, logLevel: 'warn' });
const { PRODUCTION_WORKFLOWS, createOfficialDocument, canonicalCanvasText, parseContractOutput, normalizeContract } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);

const workflow = PRODUCTION_WORKFLOWS[raw.caseId];
if (!workflow) throw new Error(`Unknown case ${raw.caseId}`);
// createOfficialDocument mints the agents first, then the case's image and video nodes (officialMedia.ts).
const mediaSpecs = workflow.media ?? [];
if (mediaSpecs.some(spec => spec.kind !== 'image' && spec.kind !== 'video')) throw new Error(`${raw.caseId}: only image and video media nodes are published`);
const frozen = raw.graph.document.nodes.filter(node => node.kind === 'session');
if (frozen.length !== workflow.nodes.length + mediaSpecs.length) throw new Error('The frozen canvas does not have the workflow’s nodes');
// A node's canvas id (minted afresh for every canvas) names a media node's files in the page it feeds, and an agent may
// name any node by it (a review listing the files it checked); the public record names each node by its own id instead
// (identifier redaction), so no canvas identifier is published.
const MEDIA_IDS = new Map(mediaSpecs.map((spec, index) => [frozen[workflow.nodes.length + index].id, spec.id]));
const CANVAS_IDS = new Map([...workflow.nodes.map((spec, index) => [frozen[index].id, spec.id]), ...MEDIA_IDS]);
const plain = text => [...CANVAS_IDS].reduce((value, [from, to]) => value.split(from).join(to), text);
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
    output = plain(redact(parsed.values.result));
  }
  return { id: spec.id, title: spec.title, column: spec.column, row: spec.row, status: state.state,
    ...(seconds(item?.admittedAt ?? run?.createdAt, item?.completedAt ?? run?.updatedAt) !== undefined ? { seconds: seconds(item?.admittedAt ?? run?.createdAt, item?.completedAt ?? run?.updatedAt) } : {}),
    outputType: spec.outputType ?? 'markdown', ...(output !== undefined ? { output } : {}),
    ...(state.detail ? { detail: plain(redact(String(state.detail))) } : {}), ...(usage(item) ? { tokens: usage(item) } : {}) };
});
const artifact = workflow.nodes.find(node => node.outputType === 'html');
const artifactOutput = nodes.find(node => node.id === artifact?.id)?.output;
// Each media node as the run stored it: its state and the files it made, by the `<node id>/<file>` path the canvas handed
// the page. They are not agents, so they stay out of `nodes` (a copy pins agents only).
const media = mediaSpecs.map((spec, index) => {
  const document = frozen[workflow.nodes.length + index];
  if (document.title !== spec.title[raw.locale]) throw new Error(`Media node ${index} is “${document.title}”, expected “${spec.title[raw.locale]}”`);
  const state = states.get(document.id);
  if (!state || !STATUS.has(state.state)) throw new Error(`${spec.id} ended as ${state?.state}`);
  let files = [];
  if (state.state === 'done' && state.output) {
    const value = JSON.parse(state.output);
    if (value?.type !== 'awwo.media' || !Array.isArray(value.items)) throw new Error(`${spec.id}: its output is not a media result`);
    files = value.items.map(item => `${spec.id}/${item.name}`);
  }
  const run = raw.runs[document.id];
  const took = seconds(run?.createdAt, run?.updatedAt);
  return { id: spec.id, title: spec.title, kind: spec.kind, status: state.state, ...(took !== undefined ? { seconds: took } : {}), files,
    ...(state.detail ? { detail: redact(String(state.detail)) } : {}) };
});
const catalog = raw.catalog?.runtimes?.find(runtime => runtime.id === raw.runtime);
const record = {
  caseId: raw.caseId,
  edition: notes.edition,
  runtime: raw.runtime, model: notes.model || raw.model, capturedOn: raw.startedAt.slice(0, 10),
  seconds: seconds(raw.graph.createdAt, raw.graph.updatedAt), completed: nodes.filter(node => node.status === 'done').length, total: nodes.length,
  outputLocale: raw.locale,
  limits: { contextWindow: notes.limits.contextWindow, maxOutputTokens: notes.limits.maxOutputTokens, modelCallsPerNode: notes.limits.modelCallsPerNode,
    concurrency: notes.limits.concurrency, thinking: notes.thinking },
  source: notes.source,
  canvasSHA256: crypto.createHash('sha256').update(ranText).digest('hex'),
  ...(artifactOutput ? { artifactNodeId: artifact.id, artifactSHA256: crypto.createHash('sha256').update(artifactOutput).digest('hex') } : {}),
  nodes, edges: workflow.edges, ...(media.length ? { media } : {}), note: notes.note, verification: notes.verification,
};
if (!catalog?.available) console.warn('warning: the raw record’s runtime catalog did not list the runtime as available');
const target = path.join(ROOT, 'apps/web/src/saas/production-runs', `${raw.caseId}.ts`);
writeRecord(target, record);
writeSummary(path.join(path.dirname(target), 'summary.json'), record, Boolean(artifactOutput) && nodes.find(node => node.id === artifact.id)?.status === 'done');
if (media.length) writeMedia(path.join(path.dirname(target), `${raw.caseId}.media.ts`));
console.log(`${raw.caseId}: ${record.completed}/${record.total} done, ${record.seconds}s → ${path.relative(ROOT, target)}`);

/** The files the published page names, shrunk (pictures to JPEG at most 1600 px wide, the clip to H.264 at most 960 px
 * wide, without sound) and inlined as data: URLs, keyed by the path the page uses: the homepage has no canvas files. */
function writeMedia(file) {
  const stored = path.join(path.dirname(path.resolve(rawFile)), `${path.basename(rawFile).replace(/-\d{8}T\d{6}Z\.json$/, '')}-files`);
  const scratch = fs.mkdtempSync(path.join(path.dirname(path.resolve(rawFile)), '.media-'));
  const inlined = {};
  try {
    for (const item of media) for (const reference of item.files) {
      if (!artifactOutput?.includes(reference)) continue;
      const [specId, name] = [reference.slice(0, reference.indexOf('/')), reference.slice(reference.indexOf('/') + 1)];
      const nodeId = [...MEDIA_IDS].find(([, to]) => to === specId)?.[0];
      const entry = (raw.files || []).find(value => value.nodeId === nodeId && value.name === name);
      if (!entry) throw new Error(`${reference}: the run record has no stored file for it`);
      const source = path.join(stored, entry.file);
      const video = item.kind === 'video';
      const out = path.join(scratch, `${Object.keys(inlined).length}.${video ? 'mp4' : 'jpg'}`);
      const args = video
        ? ['-y', '-v', 'error', '-i', source, '-an', '-vf', "scale='min(960,iw)':-2", '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]
        : ['-y', '-v', 'error', '-i', source, '-vf', "scale='min(1600,iw)':-2", '-q:v', '4', out];
      const done = spawnSync('ffmpeg', args, { encoding: 'utf8' });
      if (done.status !== 0) throw new Error(`ffmpeg ${reference}: ${done.stderr}`);
      inlined[reference] = `data:${video ? 'video/mp4' : 'image/jpeg'};base64,${fs.readFileSync(out).toString('base64')}`;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const missing = media.flatMap(item => item.files).filter(reference => artifactOutput?.includes(reference) && !inlined[reference]);
  if (missing.length) throw new Error(`not inlined: ${missing.join(', ')}`);
  fs.writeFileSync(file, `// Generated by scripts/showcase/publish-run.mjs from a recorded run; do not edit by hand.\n/** The files of ${raw.caseId}'s image and video nodes that its page names, by the path the page uses, as small data: URLs. */\nconst media: Readonly<Record<string, string>> = ${JSON.stringify(inlined)};\nexport default media;\n`);
  console.log(`${raw.caseId}: ${Object.keys(inlined).length} media file(s) inlined, ${Math.round(fs.statSync(file).size / 1024)} KB → ${path.relative(ROOT, file)}`);
}
