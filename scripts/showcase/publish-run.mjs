// Turns one raw run record from run-production-cases.mjs into the homepage record
// apps/web/src/saas/production-runs/<case>.ts. Each node's delivered value is read from the frozen
// graph run with the canvas's own contract parser; nothing is rewritten except identifier redaction.
//   node scripts/showcase/publish-run.mjs <raw-record.json> <notes.json>
// notes.json: { "note": "…", "verification": "…", "edition": "…" (English: every case is English, in both interface languages),
//   "source": { "api": "<commit>", "worker": "<commit>", "runs": [{ "api", "worker", "nodes": [<node ids>] }, …] (optional:
//   a canvas that ran again between releases, which nodes ran on which, in order; api and worker are the last run's) },
//   "thinking": false, "model": "<label shown>" (optional),
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
for (const key of ['note', 'verification', 'edition']) if (typeof notes[key] !== 'string' || !notes[key].trim()) throw new Error(`notes.${key} must be a non-empty English string`);
// Every case runs in English (owner 2026-10-14); a run in any other language is never published.
if (raw.locale !== 'en') throw new Error(`${raw.caseId}: the run's locale is ${raw.locale}, not en; run the case in English`);
// The revisions that ran and whether the model's thinking was off are part of the receipt, never assumed.
const COMMIT = /^[0-9a-f]{8,40}$/;
if (!COMMIT.test(notes.source?.api || '') || !COMMIT.test(notes.source?.worker || '') || typeof notes.thinking !== 'boolean')
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
// Which nodes ran on which revisions, when they were more than one: every node exactly once, the last entry the run's own.
if (notes.source.runs !== undefined) {
  const runs = notes.source.runs, named = Array.isArray(runs) ? runs.flatMap(entry => entry?.nodes ?? []) : [];
  if (!Array.isArray(runs) || runs.length < 2 || runs.some(entry => !COMMIT.test(entry?.api || '') || !COMMIT.test(entry?.worker || '') || !entry.nodes?.length)
    || named.length !== workflow.nodes.length || new Set(named).size !== named.length || named.some(id => !workflow.nodes.some(node => node.id === id))
    || runs.at(-1).api !== notes.source.api || runs.at(-1).worker !== notes.source.worker)
    throw new Error('notes.source.runs must name every node once, on two or more revisions, the last one source.api and source.worker');
}
// createOfficialDocument mints the agents first, then the case's image, video and 3D model nodes (officialMedia.ts).
const mediaSpecs = workflow.media ?? [];
if (mediaSpecs.some(spec => !['image', 'video', 'model3d'].includes(spec.kind))) throw new Error(`${raw.caseId}: only image, video and 3D model media nodes are published`);
// A flagship canvas also has an assemble node, which makes its page from the modules with no model.
const frozen = raw.graph.document.nodes.filter(node => node.kind === 'session' || node.kind === 'assemble');
if (frozen.length !== workflow.nodes.length + mediaSpecs.length) throw new Error('The frozen canvas does not have the workflow’s nodes');
// A node's canvas id (minted afresh for every canvas) names a media node's files in the page it feeds, and an agent may
// name any node by it (a review listing the files it checked); the public record names each node by its own id instead
// (identifier redaction), so no canvas identifier is published.
const MEDIA_IDS = new Map(mediaSpecs.map((spec, index) => [frozen[workflow.nodes.length + index].id, spec.id]));
const CANVAS_IDS = new Map([...workflow.nodes.map((spec, index) => [frozen[index].id, spec.id]), ...MEDIA_IDS]);
const plain = text => [...CANVAS_IDS].reduce((value, [from, to]) => value.split(from).join(to), text);
// The homepage says a case ran on the canvas a member copies, so a run of any other text is never published.
const ranText = canonicalCanvasText(raw.graph.document);
if (ranText !== canonicalCanvasText(createOfficialDocument(workflow)))
  throw new Error(`${raw.caseId}: this run used a different canvas (tasks, contracts or wires) from productionWorkflows.ts today; run the case again`);
// The files a run stored sit beside its record, in <case stem>-files (a retried run's record, <stem>-<stamp>-retry<n>.json,
// shares the folder of the run it retried).
const STORED = path.join(path.dirname(path.resolve(rawFile)), `${path.basename(rawFile).replace(/-\d{8}T\d{6}Z(?:-retry\d+)?\.json$/, '')}-files`);
// The runtime the agents ran on: a canvas's nodes may each name one (a flagship's work in sandbox computers), and the
// ledger names the one each model call ran on; the record names it only when they all agree.
const agentNodes = raw.graph.document.nodes.filter(node => node.kind === 'session');
const ranOn = new Set(agentNodes.map(node => node.runtime || raw.runtime));
const ledgerRuntimes = new Set(Object.values(raw.invocations || {}).flatMap(value => (value?.items || []).map(item => item.runtime)).filter(Boolean));
if (ranOn.size !== 1 || [...ledgerRuntimes].some(runtime => !ranOn.has(runtime)))
  throw new Error(`${raw.caseId}: the agents ran on ${[...ranOn].join(', ')} and the ledger names ${[...ledgerRuntimes].join(', ')}; one runtime is published`);
const runtime = [...ranOn][0];
const states = new Map((raw.graph.nodes || []).map(node => [node.nodeId, node]));
const STATUS = new Set(['done', 'failed', 'blocked', 'cancelled', 'cached']);
const seconds = (from, to) => from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : undefined;
// The ledger reports token counts as numbers or as decimal strings.
const count = value => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
const usage = item => {
  const value = item?.usage;
  if (!value || item.usageStatus === 'invalid') return undefined;
  const input = count(value.inputTokens), output = count(value.outputTokens);
  const tokens = { ...(Number.isFinite(input) ? { input } : {}), ...(Number.isFinite(output) ? { output } : {}) };
  return Object.keys(tokens).length ? tokens : undefined;
};
// A node's tokens over all its model calls: one call for most nodes, dozens for one that worked in a sandbox computer.
// A total is published only when every call reported its usage, never a partial sum.
const totalUsage = items => {
  const counted = items.map(usage).filter(Boolean);
  if (!counted.length || counted.length !== items.length) return undefined;
  const sum = key => counted.every(value => value[key] === undefined) ? undefined : counted.reduce((total, value) => total + (value[key] ?? 0), 0);
  const input = sum('input'), output = sum('output');
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
};
const nodes = workflow.nodes.map((spec, index) => {
  const document = frozen[index];
  if (document.title !== spec.title) throw new Error(`Node ${index} is “${document.title}”, expected “${spec.title}”`);
  const state = states.get(document.id);
  if (!state || !STATUS.has(state.state)) throw new Error(`${spec.id} ended as ${state?.state}`);
  const invocation = raw.invocations[spec.id] ?? raw.invocations[document.id];
  const items = Array.isArray(invocation?.items) ? invocation.items : [];
  const first = items[0], item = items.at(-1);
  const run = raw.runs[document.id];
  const contract = normalizeContract(document.contract);
  let output, report, file;
  if (document.kind === 'assemble') {
    // Its one output is the page as a file, which the run stored as an artifact: the one its output names (a canvas run
    // again keeps the pages of earlier runs too).
    if (state.state === 'done') {
      const named = /^awwo-file:([A-Za-z0-9_-]+)$/.exec(JSON.parse(state.output || '{}').file || '')?.[1];
      const stored = (raw.files || []).find(value => value.nodeId === document.id && value.id === named);
      if (!stored) throw new Error(`${spec.id}: the run record has no stored file ${named} for the assembled page`);
      // The bytes on disk must be that file's: a record whose files share a name on disk (saved before 2026-10-17 12:40)
      // is fetched again first (refetch_files.py), which names each by its artifact id and records its size and sha256.
      const bytes = fs.readFileSync(path.join(STORED, stored.file));
      if ((raw.files || []).some(value => value !== stored && value.file === stored.file) || !/^[0-9a-f]{64}$/.test(stored.sha256 || '')
        || crypto.createHash('sha256').update(bytes).digest('hex') !== stored.sha256 || bytes.length !== stored.size)
        throw new Error(`${spec.id}: the stored file ${stored.file} is not provably the artifact ${named}; fetch the run's files again`);
      file = { name: stored.name, bytes: bytes.length };
    }
  } else if (state.state === 'done' && state.output) {
    const parsed = parseContractOutput(contract, state.output);
    if (parsed.errors.length) throw new Error(`${spec.id}: ${parsed.errors.join('; ')}`);
    output = plain(redact(parsed.values.result));
    if (typeof parsed.values.report === 'string') report = plain(redact(parsed.values.report));
  }
  const took = seconds(first?.admittedAt ?? run?.createdAt, item?.completedAt ?? run?.updatedAt);
  return { id: spec.id, title: spec.title, column: spec.column, row: spec.row, status: state.state,
    ...(document.kind === 'assemble' ? { kind: 'assemble' } : {}), ...(document.runtime === 'sandbox' ? { sandbox: true } : {}),
    ...(took !== undefined ? { seconds: took } : {}),
    outputType: spec.outputType ?? 'markdown', ...(output !== undefined ? { output } : {}), ...(report !== undefined ? { report } : {}),
    ...(file ? { file } : {}), ...(items.length > 1 ? { calls: items.length } : {}),
    ...(state.detail ? { detail: plain(redact(String(state.detail))) } : {}), ...(totalUsage(items) ? { tokens: totalUsage(items) } : {}) };
});
const artifact = workflow.nodes.find(node => node.outputType === 'html');
const artifactOutput = nodes.find(node => node.id === artifact?.id)?.output;
// Each media node as the run stored it: its state and the files it made, by the `<node id>/<file>` path the canvas handed
// the page. They are not agents, so they stay out of `nodes` (a copy pins agents only).
const media = mediaSpecs.map((spec, index) => {
  const document = frozen[workflow.nodes.length + index];
  if (document.title !== spec.title) throw new Error(`Media node ${index} is “${document.title}”, expected “${spec.title}”`);
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
const catalog = raw.catalog?.runtimes?.find(entry => entry.id === runtime);
// A canvas that ran again for what had not finished: the runs and how long they took, without the time between them.
// The first run's span is in its own record, which the retries' record sits beside (<stem>-<stamp>.json).
const retries = Array.isArray(raw.retries) ? raw.retries : [];
let activeSeconds;
if (retries.length) {
  const firstFile = path.resolve(rawFile).replace(/-retry\d+\.json$/, '.json');
  const first = JSON.parse(fs.readFileSync(firstFile, 'utf8'));
  if (firstFile === path.resolve(rawFile) || first.graph?.createdAt !== raw.graph.createdAt || first.retries?.length)
    throw new Error(`${firstFile} is not the first run of this record`);
  const spans = [seconds(first.graph.createdAt, first.graph.updatedAt), ...retries.map(entry => seconds(entry.startedAt, entry.finishedAt))];
  if (spans.some(value => value === undefined)) throw new Error('a run of this record has no start or end time');
  activeSeconds = spans.reduce((sum, value) => sum + value, 0);
}
const record = {
  caseId: raw.caseId,
  edition: notes.edition,
  runtime, model: notes.model || raw.model, capturedOn: raw.startedAt.slice(0, 10),
  seconds: seconds(raw.graph.createdAt, raw.graph.updatedAt), ...(retries.length ? { runs: retries.length + 1, activeSeconds } : {}),
  completed: nodes.filter(node => node.status === 'done').length, total: nodes.length,
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
if (media.length) writeStaticMedia(path.join(path.dirname(target), `${raw.caseId}.media.json`));
console.log(`${raw.caseId}: ${record.completed}/${record.total} done, ${record.seconds}s → ${path.relative(ROOT, target)}`);

/**
 * The files the published page names, and a 3D model node's rendered preview picture (the case dialog shows it beside
 * the agents), published as static files in apps/web/showcase/media/<case>/, each named by the first 16 hex digits of
 * its sha256 so a cached copy is never a stale one; production-runs/<case>.media.json maps each `<node id>/<file>` path
 * the page uses to its file. Pictures are re-encoded for the web as JPEG at most 2048 px wide (a preview picture as
 * WebP at most 512 px, keeping its transparency), clips as H.264 at most 1280 px wide without sound; a 3D model is the
 * GLB the run made with its geometry and textures byte for byte, its provider's marks taken out (neutralGlb). Only this
 * run's files stay in the case's folder.
 */
function writeStaticMedia(manifestFile) {
  const stored = STORED;
  const caseDir = path.join(ROOT, 'apps/web/showcase/media', raw.caseId);
  const scratch = fs.mkdtempSync(path.join(path.dirname(path.resolve(rawFile)), '.media-'));
  const manifest = {};
  try {
    fs.mkdirSync(caseDir, { recursive: true });
    for (const item of media) for (const reference of item.files) {
      const preview = item.kind === 'model3d' && /\.(?:png|jpe?g|webp)$/i.test(reference);
      if (!artifactOutput?.includes(reference) && !preview) continue;
      const [specId, name] = [reference.slice(0, reference.indexOf('/')), reference.slice(reference.indexOf('/') + 1)];
      const nodeId = [...MEDIA_IDS].find(([, to]) => to === specId)?.[0];
      const entry = (raw.files || []).find(value => value.nodeId === nodeId && value.name === name);
      if (!entry) throw new Error(`${reference}: the run record has no stored file for it`);
      const source = path.join(stored, entry.file);
      let out = source, type = 'model/gltf-binary', extension = 'glb';
      if (item.kind === 'video') {
        out = path.join(scratch, `${Object.keys(manifest).length}.mp4`); type = 'video/mp4'; extension = 'mp4';
        ffmpeg(reference, ['-y', '-v', 'error', '-i', source, '-an', '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
      } else if (preview) {
        out = path.join(scratch, `${Object.keys(manifest).length}.webp`); type = 'image/webp'; extension = 'webp';
        ffmpeg(reference, ['-y', '-v', 'error', '-i', source, '-vf', "scale='min(512,iw)':-2", '-c:v', 'libwebp', '-quality', '82', out]);
      } else if (!/\.glb$/i.test(name)) {
        out = path.join(scratch, `${Object.keys(manifest).length}.jpg`); type = 'image/jpeg'; extension = 'jpg';
        ffmpeg(reference, ['-y', '-v', 'error', '-i', source, '-vf', "scale='min(2048,iw)':-2", '-q:v', '3', out]);
      }
      const bytes = extension === 'glb' ? neutralGlb(fs.readFileSync(out), reference) : fs.readFileSync(out);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const fileName = `${sha256.slice(0, 16)}.${extension}`;
      fs.writeFileSync(path.join(caseDir, fileName), bytes);
      manifest[reference] = { src: `/showcase/media/${raw.caseId}/${fileName}`, type, bytes: bytes.length, sha256 };
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const missing = media.flatMap(item => item.files).filter(reference => artifactOutput?.includes(reference) && !manifest[reference]);
  if (missing.length) throw new Error(`not published: ${missing.join(', ')}`);
  const keep = new Set(Object.values(manifest).map(file => path.basename(file.src)));
  for (const name of fs.readdirSync(caseDir)) if (!keep.has(name)) fs.rmSync(path.join(caseDir, name));
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(manifestFile, `${JSON.stringify(sorted, null, 1)}\n`);
  // The inlined data: URLs these files replace (published before 2026-10-15).
  fs.rmSync(path.join(path.dirname(manifestFile), `${raw.caseId}.media.ts`), { force: true });
  const total = Object.values(manifest).reduce((sum, file) => sum + file.bytes, 0);
  console.log(`${raw.caseId}: ${Object.keys(manifest).length} media file(s), ${Math.round(total / 1024)} KB → ${path.relative(ROOT, caseDir)}`);
}

/**
 * A GLB without its provider's marks: the 3D model nodes' files name the service that made them (asset.generator, and
 * material, mesh and node names), and a published file is downloadable by anyone. The JSON chunk's generator becomes
 * AwwO and every named object is renamed by its kind and index (the delivered pages load the model's scene and name no
 * object in it); the binary chunk, the geometry and the textures, is kept byte for byte. A mark this cannot take out
 * (in the binary chunk, say a texture's metadata) stops the publish.
 */
function neutralGlb(bytes, reference) {
  // Names of the generation providers behind AwwO's media nodes, which users never see (the site names its models
  // generically): none may be left in a published file.
  const marks = /tripo|x-?tasy|runninghub|bytedance|dreamina|jimeng|kuaishou|midjourney|pixverse|shengshu/i;
  const singular = kind => (kind === 'meshes' ? 'mesh' : kind.replace(/s$/, ''));
  const word = at => bytes.readUInt32LE(at);
  if (bytes.toString('latin1', 0, 4) !== 'glTF' || word(4) !== 2 || word(8) !== bytes.length) throw new Error(`${reference}: not a glTF 2.0 binary`);
  if (bytes.toString('latin1', 16, 20) !== 'JSON') throw new Error(`${reference}: its first chunk is not JSON`);
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + word(12)));
  const rest = bytes.subarray(20 + word(12));
  if (marks.test(rest.toString('latin1'))) throw new Error(`${reference}: its binary chunk names a provider`);
  doc.asset = { ...doc.asset, generator: 'AwwO' };
  for (const [kind, values] of Object.entries(doc)) if (Array.isArray(values)) values.forEach((value, index) => {
    if (value && typeof value === 'object' && typeof value.name === 'string') value.name = `${singular(kind)}_${index}`;
  });
  const text = JSON.stringify(doc);
  if (marks.test(text)) throw new Error(`${reference}: its JSON chunk still names a provider`);
  // A chunk is padded to 4 bytes, the JSON one with spaces.
  const plain = Buffer.from(text, 'utf8');
  const json = Buffer.concat([plain, Buffer.alloc((4 - (plain.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length + rest.length, 8);
  head.writeUInt32LE(json.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, json, rest]);
}

function ffmpeg(reference, args) {
  const done = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffmpeg ${reference}: ${done.stderr}`);
}
