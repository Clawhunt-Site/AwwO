// Turns the raw record of a recorded-canvas case (a film canvas: image, video and audio nodes, editor agents, edit nodes;
// or a film written as code: agents in sandbox computers, an assembly that pastes their modules into one page, a tester,
// an editor and the edit that renders the page and its sound) into its homepage record, the canvas a member copies and
// the files the case dialog shows. The raw record is the
// operator's read of the live canvas (every graph run with its frozen document, the run that made each published output,
// lineage, runs, model calls, and every file those outputs name, with its SHA-256); see docs/production-cases.md.
//   node scripts/showcase/publish-recorded-run.mjs <raw-record.json> <notes.json>
// notes.json: { "note", "verification", "edition" (English), "model" (the label shown), "source": { "api", "worker",
//   "runs"? }, "limits": { contextWindow, maxOutputTokens, modelCallsPerNode, concurrency }, "thinking",
//   "footage": { "stem", "from", "seconds" } (the homepage card's excerpt, without sound) }.
// Writes apps/web/src/saas/production-runs/<case>.ts (+ .media.json, summary.json), apps/web/src/saas/production-canvases/
// <case>.ts, apps/web/showcase/media/<case>/ (posters, stills, subtitles), apps/web/showcase/<stem>.mp4/.jpg (the excerpt),
// and, outside the repo beside the raw record, <case>-staged/: the film's web copy and the film as delivered, to be staged
// once on the host's store of earlier website files, never shipped with a release.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact, writeSummary } from './publish-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [rawFile, notesFile] = process.argv.slice(2);
if (!rawFile || !notesFile) throw new Error('Usage: publish-recorded-run.mjs <raw-record.json> <notes.json>');
const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
for (const key of ['note', 'verification', 'edition', 'model']) if (typeof notes[key] !== 'string' || !notes[key].trim()) throw new Error(`notes.${key} must be a non-empty English string`);
// What the dialog shows under "What happened" and "Checked before publishing" is what was done, never a placeholder.
for (const key of ['note', 'verification', 'edition']) if (/PROVISIONAL|TODO|TBD|placeholder|lorem ipsum/i.test(notes[key])) throw new Error(`notes.${key} is a placeholder, not what was done`);
if (raw.locale !== 'en') throw new Error(`${raw.caseId}: the run's locale is ${raw.locale}, not en`);
// How the film's web copy — the file the case dialog plays by default — is encoded. Never an upscale: a master
// narrower than FILM_WEB_WIDTH is kept at its own width. See the note beside the encode for what this costs.
const FILM_WEB_WIDTH = 1280, FILM_WEB_CRF = 23;
const COMMIT = /^[0-9a-f]{8,40}$/;
if (!COMMIT.test(notes.source?.api || '') || !COMMIT.test(notes.source?.worker || '') || typeof notes.thinking !== 'boolean')
  throw new Error('notes.source.api, notes.source.worker (commit hashes) and notes.thinking (boolean) are required');
const LIMIT_KEYS = ['contextWindow', 'maxOutputTokens', 'modelCallsPerNode', 'concurrency'];
if (!notes.limits || LIMIT_KEYS.some(key => !Number.isInteger(notes.limits[key]) || notes.limits[key] <= 0)) throw new Error(`notes.limits needs positive integers ${LIMIT_KEYS.join(', ')}`);
// The read must prove the film's provenance, and must say it did: every node's output was found in a graph run, and every
// wire's source had that same output in the document its target's run started from. A read that does not say so fails.
if (!Array.isArray(raw.problems) || !Array.isArray(raw.lineage) || !Array.isArray(raw.nodes) || typeof raw.producedBy !== 'object'
  || raw.producedBy === null || Array.isArray(raw.producedBy) || !Array.isArray(raw.graphs) || !Array.isArray(raw.files))
  throw new Error(`${raw.caseId}: the raw record does not carry its lineage check (problems, lineage, nodes, producedBy, graphs, files)`);
if (raw.problems.length || raw.lineage.length) throw new Error(`${raw.caseId}: the raw record has problems or lineage gaps:\n${[...raw.problems, ...raw.lineage].join('\n')}`);
// And the lineage proved again here, from the graph runs the read carries, not taken on its word: for every wire between
// published nodes, the output its source had in the document its target's run started from is the source's published
// output (a source made in the same run handed its target the output that run made, the one published).
const lineage = { wires: 0, across: 0 };
{
  const published = new Set(raw.nodes), runs = new Map(raw.graphs.map(graph => [graph.id, graph]));
  const final = new Map((raw.canvas?.document?.nodes ?? []).map(node => [node.id, node]));
  for (const edge of raw.canvas?.document?.edges ?? []) {
    const [source, target] = [edge.fromNode, edge.toNode];
    if (!published.has(source) || !published.has(target)) continue;
    lineage.wires += 1;
    const made = raw.producedBy[target]?.graph;
    if (!runs.has(made)) throw new Error(`${target}: no graph run the read carries made it`);
    if (raw.producedBy[source]?.graph === made) continue;
    lineage.across += 1;
    const had = (runs.get(made).document?.nodes ?? []).find(node => node.id === source)?.lastOutput?.text;
    if (typeof had !== 'string' || had !== final.get(source)?.lastOutput?.text) throw new Error(`${source} -> ${target}: the run that made ${target} read another output of ${source}`);
  }
  // Published nodes with no wire among them would prove nothing: a read whose canvas lost its wires is refused.
  if (published.size > 1 && !lineage.wires) throw new Error(`${raw.caseId}: no wire joins the published nodes, so there is no lineage to prove`);
}
// Which API release each graph run ran on: the releases in order, each from its switch (an ISO time).
const releases = (notes.releases ?? []).map(entry => ({ api: entry.api, from: Date.parse(entry.from) }));
if (!releases.length || releases.some((entry, index) => !COMMIT.test(entry.api || '') || !Number.isFinite(entry.from) || (index && entry.from <= releases[index - 1].from)))
  throw new Error('notes.releases must list the API releases in order: { "api": "<commit>", "from": "<ISO time of its switch>" }');
// The stored files by artifact id (a node made again keeps the same file names, so a name alone could be an older file),
// each the very bytes AwwO stored: the read compared every download with the canvas's artifact listing (AwwO's artifacts
// table, which it read whole) and kept what the listing said, so a published checksum is AwwO's, not only this read's.
if (raw.artifactListing?.complete !== true) throw new Error(`${raw.caseId}: the raw record does not say it read the canvas's whole artifact listing`);
const filesById = new Map();
for (const file of raw.files) {
  if (!file.artifactId || filesById.has(file.artifactId)) throw new Error(`${file.nodeId}/${file.name}: a stored file without its own artifact id`);
  if (!/^[0-9a-f]{64}$/.test(file.sha256 || '') || file.listed?.sha256 !== file.sha256 || file.listed?.size !== file.size)
    throw new Error(`${file.nodeId}/${file.name}: not the bytes the canvas's artifact listing names`);
  filesById.set(file.artifactId, file);
}

const { build } = await import(pathToFileURL(path.join(ROOT, 'apps/web/node_modules/rolldown/dist/index.mjs')).href);
const bundle = path.join(path.dirname(path.resolve(rawFile)), '.publish-helpers.mjs');
await build({ input: path.join(ROOT, 'scripts/showcase/publish-helpers.ts'), platform: 'node', output: { file: bundle, format: 'esm' }, logLevel: 'warn' });
const { recordedCanvasText, parseContractOutput, normalizeContract } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);

const CASE = raw.caseId, ROOT_NODE = raw.root;
const keep = new Set(raw.nodes);
raw.graphs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
const graphs = new Map(raw.graphs.map(graph => [graph.id, graph]));
const finalNodes = new Map(raw.canvas.document.nodes.map(node => [node.id, node]));
const madeIn = id => graphs.get(raw.producedBy[id]?.graph) ?? (() => { throw new Error(`${id}: no graph run made it`); })();
const frozen = id => madeIn(id).document.nodes.find(node => node.id === id) ?? (() => { throw new Error(`${id}: not in the document of the run that made it`); })();
const MEDIA = new Set(['image', 'video', 'audio', 'model3d']);
const activeThread = node => (node.threads || []).find(thread => thread.id === (node.activeThreadId || 'default')) ?? (node.threads || [])[0];

/** A node as a member's copy gets it: what it is and what it was asked, as it ran; nothing bound, said or delivered. */
function stored(id) {
  const node = frozen(id);
  if (node.kind === 'edit') return { id, kind: 'edit', x: node.x, y: node.y, w: node.w, h: node.h, title: node.title, timeline: node.timeline || '' };
  // An assembly pastes its inputs into its template with no model (a film written as code: its modules into one page).
  // Its template, contract and file name are what it is; the canvas drops one whose contract it cannot read. A contract
  // is stored as the canvas reads it (normalizeContract keeps its fields' known properties and nothing else).
  if (node.kind === 'assemble') {
    const contract = normalizeContract(node.contract);
    if (!contract) throw new Error(`${id}: an assembly without a readable contract`);
    return { id, kind: 'assemble', x: node.x, y: node.y, w: node.w, h: node.h, title: node.title, template: node.template || '', contract,
      ...(node.fileName ? { fileName: node.fileName } : {}) };
  }
  if (node.kind !== 'session') throw new Error(`${id}: a ${node.kind} node; a recorded canvas publishes session, assembly and edit nodes`);
  if (node.agentRef || node.team || (node.skills || []).some(skill => !skill.startsWith('builtin:')))
    throw new Error(`${id}: names a workspace agent, team or skill, which a copy cannot carry`);
  const media = MEDIA.has(node.agentKind);
  const thread = activeThread(node);
  // Any contract it holds (false, 0 and '' too, which the canvas refuses) is stored as the canvas reads it, or refused.
  const contract = node.contract != null ? normalizeContract(node.contract) : undefined;
  if (node.contract != null && !contract) throw new Error(`${id}: an agent with a contract the canvas cannot read`);
  return { id, kind: 'session', x: node.x, y: node.y, w: node.w, h: node.h, title: node.title, agentKind: node.agentKind,
    // An agent's model is the member's choice in the copy dialog; a media node keeps the model it generates with, and an
    // agent that works in its own sandbox computer (it writes, runs and publishes files there) keeps that runtime.
    runtime: media ? (node.runtime || '') : node.runtime === 'sandbox' ? 'sandbox' : '', model: media ? node.model : '', effort: '', persona: node.persona || '',
    binding: null, bindAttempt: null, issueId: null, preview: '',
    ...(media ? { activeThreadId: thread?.id || 'default', threads: [{ id: thread?.id || 'default', title: thread?.title || 'Session 1', issueId: null, preview: '', draft: thread?.draft || '', createdAt: 0 }] } : { threads: [] }),
    ...(node.mediaParams ? { mediaParams: node.mediaParams } : {}),
    ...(contract ? { contract } : {}),
    ...(node.templateId ? { templateId: node.templateId, ...(node.templateVersion !== undefined ? { templateVersion: node.templateVersion } : {}) } : {}),
    ...(node.taskFrame !== undefined ? { taskFrame: node.taskFrame } : {}),
    ...(node.skills?.length ? { skills: node.skills } : {}) };
}
const canvasNodes = [...keep].sort().map(stored);
const canvasEdges = raw.canvas.document.edges.filter(edge => keep.has(edge.fromNode) && keep.has(edge.toNode))
  .map(edge => ({ id: edge.id, fromNode: edge.fromNode, fromPort: edge.fromPort, toNode: edge.toNode, toPort: edge.toPort, dataType: edge.dataType, ...(edge.kind ? { kind: edge.kind } : {}) }))
  .sort((a, b) => (a.id < b.id ? -1 : 1));
// The wires into each node are the ones its run read: none was added or removed since, and none came from a node the
// case leaves out (the copy would lack that input).
for (const id of keep) {
  const ran = madeIn(id).document.edges.filter(edge => edge.toNode === id);
  const outside = ran.filter(edge => !keep.has(edge.fromNode));
  if (outside.length) throw new Error(`${id}: its run read ${outside.map(edge => edge.fromNode).join(', ')}, which the case does not publish`);
  const ids = edges => edges.map(edge => edge.id).sort().join('\n');
  if (ids(ran) !== ids(canvasEdges.filter(edge => edge.toNode === id))) throw new Error(`${id}: its wires changed after the run that made it`);
}
const canvas = { nodes: canvasNodes, edges: canvasEdges };
const canvasText = recordedCanvasText(canvas);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// No provider of a media model may be named in what the case shows; the models' ids stay in the canvas data, as the
// published workflows keep theirs (tripo.p1, xt.seedream-5-pro), and are never displayed.
const MARKS = /tripo|x-?tasy|runninghub|bytedance|dreamina|jimeng|kuaishou|midjourney|pixverse|shengshu|seedance|seedream|minimax|nano.?banana|gemini|hailuo|kling/i;
// The English words that hold a name are set aside before the scan ("sparkling", "a tripod", the Geminids); any other word
// that holds one is refused ("KlingAI", "klingai.com", "MiniMaxAI"), so a word this list lacks stops the publish, never slips by.
const HARMLESS = /(?<![a-z])(?:(?:buc|cac|chuc|crac|crin|dar|duc|frec|hac|hec|in|knuc|pic|pric|ran|roc|shac|sic|spac|spar|spec|sprin|stic|suc|tac|tic|tin|tric|twin|wea|wrin)klings?|tripods?|geminids?)(?![a-z])/gi;
const scan = (where, text) => { const hit = MARKS.exec((text || '').replace(HARMLESS, ' ')); if (hit) throw new Error(`${where} names a provider: “${hit[0]}”`); };
for (const node of canvasNodes) {
  scan(`${node.id}.title`, node.title); scan(`${node.id}.persona`, node.persona);
  for (const thread of node.threads || []) scan(`${node.id}.draft`, thread.draft);
  if (node.kind === 'edit') scan(`${node.id}.timeline`, node.timeline);
  if (node.kind === 'assemble') scan(`${node.id}.template`, node.template);
  // A contract's labels, help and the values its inputs hold (an agent's brief) are words the case shows too.
  if (node.contract) scan(`${node.id}.contract`, JSON.stringify(node.contract));
}

// Stages: dependency depth (sheets, keyframes, takes and score; clips; editors; reels; the act).
const into = new Map([...keep].map(id => [id, canvasEdges.filter(edge => edge.toNode === id).map(edge => edge.fromNode)]));
const depthOf = new Map();
const depth = id => { if (!depthOf.has(id)) depthOf.set(id, Math.max(-1, ...into.get(id).map(depth)) + 1); return depthOf.get(id); };
for (const id of keep) depth(id);
const order = ids => [...ids].sort((a, b) => depth(a) - depth(b) || frozen(a).y - frozen(b).y || frozen(a).x - frozen(b).x || (a < b ? -1 : 1));
const rows = new Map(), perColumn = new Map();
for (const id of order(keep)) {
  const column = depth(id), row = perColumn.get(column) ?? 0;
  perColumn.set(column, row + 1);
  rows.set(id, { column, row });
}
const seconds = (from, to) => from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : undefined;
const STORED = path.join(path.dirname(path.resolve(rawFile)), `${CASE}-files`);
const bytesOf = file => { const data = fs.readFileSync(path.join(STORED, file.file)); if (sha256(data) !== file.sha256 || data.length !== file.size) throw new Error(`${file.file}: not the file the raw record names`); return data; };
// A node's output as the graph run that made it recorded it (the read found that run by this very output), refused when
// it did not finish or delivered nothing.
const outputOf = id => {
  const state = (madeIn(id).nodes || []).find(entry => entry.nodeId === id);
  if (!state || state.state !== 'done' || typeof state.output !== 'string' || !state.output.trim()) throw new Error(`${id}: the run that made it did not record a finished output`);
  if (state.output !== finalNodes.get(id)?.lastOutput?.text) throw new Error(`${id}: the canvas holds another output than the run that made it`);
  return state.output;
};
const mediaRecord = id => {
  let value = null;
  try { value = JSON.parse(outputOf(id)); } catch { /* refused below */ }
  if (value?.type !== 'awwo.media' || !Array.isArray(value.items) || !value.items.length) throw new Error(`${id}: its output is not a media result with files`);
  return value;
};
// A file an output names, matched by its artifact id and size.
const fileOf = (id, item) => {
  const file = filesById.get(item.artifactId);
  if (!file || file.nodeId !== id || file.name !== item.name || (item.size !== undefined && file.size !== item.size)) throw new Error(`${id}/${item.name}: not the stored file its output names`);
  return file;
};
const count = value => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
// The timeline an edit ran, own or its editor's answer (a fenced JSON block): its still interval, for the dialog's stills.
const timelineOf = text => { try { const match = /```json\s*(\{[\s\S]*\})\s*```/.exec(text); return JSON.parse(match ? match[1] : text); } catch { return null; } };
// A node with a contract delivers named fields (its output is their JSON object): read with the canvas's own parser, as
// the API hands a field to the node wired to it (edits.go reads the wire's out:<field>), refused when it does not parse.
const contractOf = id => normalizeContract(frozen(id).contract);
const fieldsOf = id => {
  const contract = contractOf(id);
  if (!contract) return null;
  const parsed = parseContractOutput(contract, outputOf(id), 'en');
  if (parsed.errors.length) throw new Error(`${id}: ${parsed.errors.join('; ')}`);
  return { contract, values: parsed.values };
};
const fieldOf = (id, port) => { const fields = fieldsOf(id); return fields && /^out:/.test(port || '') ? fields.values[port.slice(4)] ?? '' : outputOf(id); };
// How a delivered text is shown: a page as its source, code or data (a module, a sheet, a timeline) as preformatted
// text, and Markdown as Markdown.
const shownAs = (type, text) => type === 'html' ? 'html' : type === 'text' || /^\s*[[{]/.test(text) && (() => { try { JSON.parse(text); return true; } catch { return false; } })() ? 'text' : 'markdown';

const agents = [], assemblies = [], edits = [], media = [];
for (const id of order(keep)) {
  const node = canvasNodes.find(value => value.id === id), made = raw.producedBy[id], place = rows.get(id);
  const took = seconds(made.startedAt, made.endedAt);
  if (node.kind === 'edit') {
    const value = mediaRecord(id), facts = value.edit ?? {};
    const film = value.items.find(item => /^video\//.test(item.contentType));
    if (!film) throw new Error(`${id}: its output has no film`);
    const stored_ = fileOf(id, film);
    for (const extra of facts.files ?? []) fileOf(id, extra);
    const wired = canvasEdges.find(edge => edge.toNode === id && edge.toPort === 'timeline');
    const ranTimeline = timelineOf(wired ? fieldOf(wired.fromNode, wired.fromPort) : node.timeline);
    if (!ranTimeline) throw new Error(`${id}: its timeline is not readable`);
    edits.push({ id, title: node.title, column: place.column, row: place.row, status: 'done', kind: 'edit', outputType: 'video',
      film: { name: film.name, bytes: stored_.size, sha256: stored_.sha256, seconds: facts.seconds, frames: facts.frames, fps: facts.fps, width: facts.width, height: facts.height,
        ...(facts.loudness ? { loudness: facts.loudness } : {}), warnings: facts.warnings ?? [],
        ...(Number.isFinite(ranTimeline.output?.stillsEverySeconds) ? { stillsEverySeconds: ranTimeline.output.stillsEverySeconds } : {}),
        timeline: wired ? { from: wired.fromNode } : { own: node.timeline } } });
  } else if (node.kind === 'assemble') {
    // Its one output is the page as a file, stored as an artifact: the one its output names, the bytes the read kept.
    const named = /^awwo-file:([A-Za-z0-9_-]+)$/.exec(String(fieldsOf(id)?.values.file ?? ''))?.[1];
    const file = named ? filesById.get(named) : undefined;
    if (!file || file.nodeId !== id) throw new Error(`${id}: the raw record has no stored file ${named} for the assembled page`);
    bytesOf(file);
    assemblies.push({ id, title: node.title, column: place.column, row: place.row, status: 'done', kind: 'assemble',
      ...(!(node.contract?.inputs ?? []).length ? { fromTemplate: true } : {}), ...(took !== undefined ? { seconds: took } : {}),
      outputType: 'html', file: { name: file.name, bytes: file.size } });
  } else if (MEDIA.has(node.agentKind)) {
    const value = mediaRecord(id);
    for (const item of value.items) fileOf(id, item);
    if (!node.threads[0].draft.trim()) throw new Error(`${id}: a media node without the words it generated from`);
    media.push({ id, title: node.title, kind: node.agentKind, status: 'done', ...(took !== undefined ? { seconds: took } : {}),
      files: value.items.map(item => `${id}/${item.name}`), column: place.column, row: place.row, words: node.threads[0].draft });
  } else {
    const items = raw.invocations?.[id]?.items ?? [];
    const usage = items.map(item => item?.usage && item.usageStatus !== 'invalid' ? { input: count(item.usage.inputTokens), output: count(item.usage.outputTokens) } : null);
    const tokens = usage.length && usage.every(Boolean) ? { input: usage.reduce((sum, value) => sum + (value.input ?? 0), 0), output: usage.reduce((sum, value) => sum + (value.output ?? 0), 0) } : undefined;
    scan(`${id}'s answer`, outputOf(id));
    // An agent with a contract delivered named fields: its result shown as what it is, its report beside it, and any
    // other text field (a director's sheet) after them, each verbatim. One without delivered a single answer.
    const fields = fieldsOf(id);
    const typeOf = field => fields?.contract.outputs.find(output => output.id === field)?.type;
    const result = fields ? String(fields.values.result ?? '') : outputOf(id);
    const report = fields && typeof fields.values.report === 'string' && fields.values.report.trim() ? fields.values.report : undefined;
    const extras = fields ? fields.contract.outputs.filter(output => !['result', 'report'].includes(output.id) && output.type !== 'file'
      && typeof fields.values[output.id] === 'string' && fields.values[output.id].trim()).map(output => ({ label: output.label || output.id, text: redact(fields.values[output.id]) })) : [];
    agents.push({ id, title: node.title, column: place.column, row: place.row, status: 'done', ...(took !== undefined ? { seconds: took } : {}),
      outputType: fields ? shownAs(typeOf('result'), result) : 'markdown', output: redact(result), ...(report ? { report: redact(report) } : {}),
      ...(extras.length ? { extras } : {}), ...(frozen(id).runtime === 'sandbox' ? { sandbox: true } : {}),
      brief: node.persona, ...(items.length > 1 ? { calls: items.length } : {}), ...(tokens ? { tokens } : {}) });
  }
}
const runtimes = new Set(agents.map(agent => frozen(agent.id).runtime));
if (runtimes.size !== 1) throw new Error(`the agents ran on ${[...runtimes].join(', ')}; one runtime is published`);
// Every graph run that ran a node of the film, with how long each took (not the time between them).
const ran = raw.graphs.filter(graph => !graph.scope?.length || graph.scope.some(id => keep.has(id)));
const first = ran[0], last = ran.at(-1);
const delivered = raw.producedBy[ROOT_NODE];
const artifact = edits.find(edit => edit.id === ROOT_NODE);
if (!artifact) throw new Error(`${ROOT_NODE}: the film's edit node is not published`);
const nodes = [...agents, ...assemblies, ...edits];
// A wire into a contract's input is named as that input is (its label), and says when it carries a file or a report.
const edges = canvasEdges.map(edge => {
  const input = /^in:/.test(edge.toPort || '') ? contractOf(edge.toNode)?.inputs.find(field => `in:${field.id}` === edge.toPort) : undefined;
  const label = input?.label || ({ reference: 'Picture', audio: 'Voice', context: 'Input', clips: 'Clip', sounds: 'Sound', pictures: 'Picture', timeline: 'Timeline' }[edge.toPort] ?? edge.toPort);
  const port = edge.fromPort === 'out:report' ? 'report' : contractOf(edge.fromNode)?.outputs.find(field => `out:${field.id}` === edge.fromPort)?.type === 'file' ? 'file' : undefined;
  return { from: edge.fromNode, to: edge.toNode, label, ...(port ? { port } : {}) };
});
// The receipt's revisions: the agents and edits by the runtimes notes.source.runs names (each once, the last one
// source.api and source.worker), and every media node by the API release that ran its graph run (notes.releases).
const named = (notes.source.runs ?? []).flatMap(entry => entry.nodes ?? []);
if (!Array.isArray(notes.source.runs) || notes.source.runs.some(entry => !COMMIT.test(entry.api || '') || !COMMIT.test(entry.worker || '') || !entry.nodes?.length)
  || named.length !== nodes.length || new Set(named).size !== named.length || named.some(id => !nodes.some(node => node.id === id))
  || notes.source.runs.at(-1).api !== notes.source.api || notes.source.runs.at(-1).worker !== notes.source.worker)
  throw new Error('notes.source.runs must name every agent and edit once, the last entry being source.api and source.worker');
const releaseOf = id => {
  const at = Date.parse(raw.producedBy[id].startedAt || madeIn(id).createdAt);
  const live = releases.filter(entry => entry.from <= at).at(-1);
  if (!live) throw new Error(`${id}: made before the first release notes.releases names`);
  return live.api;
};
const mediaSource = [];
for (const item of media) {
  const api = releaseOf(item.id), group = mediaSource.find(entry => entry.api === api);
  if (group) group.nodes.push(item.id); else mediaSource.push({ api, nodes: [item.id] });
}
for (const entry of notes.source.runs) for (const id of entry.nodes) if (releaseOf(id).slice(0, 8) !== entry.api.slice(0, 8)) throw new Error(`${id}: notes.source.runs says API ${entry.api.slice(0, 12)}, but its run ran on ${releaseOf(id).slice(0, 12)}`);
mediaSource.sort((a, b) => releases.findIndex(entry => entry.api === a.api) - releases.findIndex(entry => entry.api === b.api));
const record = {
  caseId: CASE, edition: notes.edition, runtime: [...runtimes][0], model: notes.model,
  capturedOn: new Date(delivered.endedAt || madeIn(ROOT_NODE).updatedAt).toISOString().slice(0, 10),
  // A canvas that ran again says how many runs and how long they took; one that ran once has its one span.
  seconds: seconds(first.createdAt, last.updatedAt),
  ...(ran.length > 1 ? { runs: ran.length, activeSeconds: ran.reduce((sum, graph) => sum + (seconds(graph.createdAt, graph.updatedAt) ?? 0), 0) } : {}),
  completed: nodes.filter(node => node.status === 'done').length, total: nodes.length,
  limits: { ...Object.fromEntries(LIMIT_KEYS.map(key => [key, notes.limits[key]])), thinking: notes.thinking },
  source: { api: notes.source.api, worker: notes.source.worker, runs: notes.source.runs, media: mediaSource }, canvasSHA256: sha256(canvasText), canvas: 'recorded',
  artifactNodeId: ROOT_NODE, artifactSHA256: artifact.film.sha256,
  nodes, edges, media, note: notes.note, verification: notes.verification,
};
for (const key of ['note', 'verification', 'edition', 'model']) scan(`notes.${key}`, notes[key]);
// Nothing private: no identifier and no path of the operator's machine in any string of the record or the stored
// canvas, keys included. Each string is read as it is, not JSON-escaped: escaped, a line ending in "T:" reads as a drive
// (T:\n). A letter after a lone backslash is code's escape, not a drive (a module's /^\d\d:\d\d/), and so is a letter
// and a colon before an escaped double quote, which no Windows path holds (a module's {l:\"D4 E4\"}); a drive after \\?\
// or \\.\ is a Windows path all the same. MACHINE_PATH is the pattern tests/saas-production-runs.test.ts pins.
const MACHINE_PATH = /(?<![A-Za-z0-9\\])[A-Za-z]:[\\/](?!")|\\\\[?.]\\[A-Za-z]:|\/Users\/|\/home\//;
const stringsOf = value => (typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [...(Array.isArray(value) ? [] : [key]), ...stringsOf(item)]) : []);
for (const [where, value] of [['the record', record], ['the stored canvas', canvas]]) {
  for (const text of stringsOf(value)) {
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) throw new Error(`${where} holds a UUID`);
    const machinePath = MACHINE_PATH.exec(text);
    if (machinePath) throw new Error(`${where} holds a machine path: …${text.slice(Math.max(0, machinePath.index - 80), machinePath.index + 40)}…`);
  }
}

// The files the dialog shows: a poster for every picture and clip, the film's stills and its subtitles here; the film
// itself (a web copy and the file as delivered) staged on the host once.
const caseDir = path.join(ROOT, 'apps/web/showcase/media', CASE);
const scratch = fs.mkdtempSync(path.join(path.dirname(path.resolve(rawFile)), '.media-'));
const staged = path.join(path.dirname(path.resolve(rawFile)), `${CASE}-staged`);
const manifest = {};
const ffmpeg = (what, args) => { const done = spawnSync(process.env.FFMPEG || 'ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 }); if (done.status !== 0) throw new Error(`ffmpeg ${what}: ${done.stderr}`); };
const publish = (key, bytes, type, extension) => {
  const sum = sha256(bytes), name = `${sum.slice(0, 16)}.${extension}`;
  fs.writeFileSync(path.join(caseDir, name), bytes);
  manifest[key] = { src: `/showcase/media/${CASE}/${name}`, type, bytes: bytes.length, sha256: sum };
};
try {
  fs.mkdirSync(caseDir, { recursive: true });
  fs.mkdirSync(staged, { recursive: true });
  for (const item of media) {
    if (item.kind === 'audio') continue;
    for (const output of mediaRecord(item.id).items) {
      const file = fileOf(item.id, output), reference = `${item.id}/${output.name}`;
      const source = path.join(STORED, file.file);
      bytesOf(file);
      const out = path.join(scratch, `${Object.keys(manifest).length}.webp`);
      // A clip's poster is its frame one second in; a picture's, the picture itself, at most 480 px wide.
      ffmpeg(reference, ['-y', '-v', 'error', ...(item.kind === 'video' ? ['-ss', '1'] : []), '-i', source, '-frames:v', '1', '-map_metadata', '-1',
        '-vf', "scale='min(480,iw)':-2", '-c:v', 'libwebp', '-quality', '78', out]);
      publish(`${reference}#poster`, fs.readFileSync(out), 'image/webp', 'webp');
    }
  }
  const value = mediaRecord(ROOT_NODE);
  for (const extra of value.edit?.files ?? []) {
    const file = fileOf(ROOT_NODE, extra);
    const data = bytesOf(file);
    if (extra.role === 'still') publish(`${ROOT_NODE}/${extra.name}`, data, 'image/jpeg', 'jpg');
    if (extra.role === 'subtitles') {
      // The film's .srt as WebVTT for the player's track: the same cues, times written with a full stop.
      const vtt = `WEBVTT\n\n${data.toString('utf8').replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n{2,}/).map(block => block.split('\n').slice(1).join('\n')
        .replace(/^(\d\d:\d\d:\d\d),(\d{3}) --> (\d\d:\d\d:\d\d),(\d{3})/, '$1.$2 --> $3.$4')).join('\n\n')}\n`;
      scan('the subtitles', vtt);
      publish(`${ROOT_NODE}/${extra.name.replace(/\.srt$/i, '.vtt')}`, Buffer.from(vtt, 'utf8'), 'text/vtt', 'vtt');
    }
  }
  // The film: as delivered (byte for byte) and a web copy (1280 px wide, the sound copied as mixed), staged by sha256.
  const film = fileOf(ROOT_NODE, value.items.find(item => item.name === artifact.film.name));
  const original = bytesOf(film);
  const probe = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', path.join(STORED, film.file)], { encoding: 'utf8' });
  scan('the film’s tags', probe.stdout);
  // The web copy is made once per film (kept beside the staged files by the film's own checksum), so publishing again
  // names the same staged file instead of a new encode of it.
  // It is the smaller, faster-starting default, and it is deliberately smaller than the film: measured on THE LONG
  // CHORD Episode I (2026-10-23), a 1680x720 24p master at 2.07 Mbps (270 MB) became 1280x548 at 891 kbps (130 MB) —
  // 58% of the pixels and 43% of the rate. That is the price of the default download, not the ceiling of the case:
  // ProductionFilm.tsx plays the file as delivered on request, and names the frame it is showing either way. Raise
  // FILM_WEB_WIDTH/FILM_WEB_CRF to serve more by default, at that much more of the host's egress per view.
  // Named after the settings as well as the film, so changing either constant makes a new encode rather than silently
  // re-using the last one (this folder is never cleaned, unlike scratch and the case's own).
  const web = path.join(staged, `.web-from-${film.sha256.slice(0, 16)}-w${FILM_WEB_WIDTH}-crf${FILM_WEB_CRF}.mp4`);
  if (!fs.existsSync(web)) ffmpeg('the film', ['-y', '-v', 'error', '-i', path.join(STORED, film.file), '-map', '0:v:0', '-map', '0:a:0', '-map_metadata', '-1',
    '-vf', `scale='min(${FILM_WEB_WIDTH},iw)':-2`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(FILM_WEB_CRF), '-maxrate', '2500k', '-bufsize', '5000k', '-g', '48',
    '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', web]);
  const webBytes = fs.readFileSync(web);
  const stage = (bytes) => { const sum = sha256(bytes), name = `${sum.slice(0, 16)}.mp4`; fs.writeFileSync(path.join(staged, name), bytes); return { src: `/showcase/staged/${CASE}/${name}`, bytes: bytes.length, sha256: sum }; };
  const copy = stage(webBytes), kept = stage(original);
  manifest[`${ROOT_NODE}/${artifact.film.name}`] = { src: copy.src, type: 'video/mp4', bytes: copy.bytes, sha256: copy.sha256, staged: true, original: kept };
  // The homepage card's excerpt: a few seconds of the film without sound, and its first frame.
  if (notes.footage?.stem) {
    const { stem, from, seconds: length } = notes.footage;
    // The card's frame is 16:9 and crops what does not fit: a portrait film (4:5) is shown whole in it, centred on
    // black, and a film narrower than 1280 px keeps its own width rather than being blown up.
    const cover = artifact.film.height > artifact.film.width ? 'scale=-2:720,pad=1280:720:(ow-iw)/2:0:black' : "scale='min(1280,iw)':-2";
    // crf 23, not 26. A film case's cover is the only one that is film — grain, smoke, star fields, long dissolves —
    // where every other case's cover is a screen recording of a mostly still interface, which holds together at a far
    // lower rate. Measured 2026-10-23: at crf 26 THE LONG CHORD's cover came out at 630 kbps, below the median 945 kbps
    // of the 17 recorded covers beside it, so the one cover made of film was among the softest on the page.
    ffmpeg('the excerpt', ['-y', '-v', 'error', '-ss', String(from), '-t', String(length), '-i', path.join(STORED, film.file), '-an', '-map_metadata', '-1',
      '-vf', cover, '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(ROOT, 'apps/web/showcase', `${stem}.mp4`)]);
    ffmpeg('the excerpt’s poster', ['-y', '-v', 'error', '-ss', String(from), '-i', path.join(STORED, film.file), '-frames:v', '1', '-map_metadata', '-1',
      '-vf', cover, '-q:v', '3', path.join(ROOT, 'apps/web/showcase', `${stem}.jpg`)]);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
const keepNames = new Set(Object.values(manifest).filter(file => !file.staged).map(file => path.basename(file.src)));
for (const name of fs.readdirSync(caseDir)) if (!keepNames.has(name)) fs.rmSync(path.join(caseDir, name));
const runsDir = path.join(ROOT, 'apps/web/src/saas/production-runs');
fs.writeFileSync(path.join(runsDir, `${CASE}.ts`), `// Generated by scripts/showcase/ from a recorded run; do not edit by hand.\nimport type { ProductionRunRecord } from '../productionRuns';\n\nconst record: ProductionRunRecord = ${JSON.stringify(record, null, 2)};\nexport default record;\n`);
fs.mkdirSync(path.join(ROOT, 'apps/web/src/saas/production-canvases'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'apps/web/src/saas/production-canvases', `${CASE}.ts`), `// Generated by scripts/showcase/publish-recorded-run.mjs from the frozen documents of the graph runs that made the case's\n// published outputs; do not edit by hand. Its recordedCanvasText (recordedCanvas.ts) hashes to the record's canvasSHA256.\nimport type { RecordedCanvas } from '../recordedCanvas';\n\nconst canvas: RecordedCanvas = ${JSON.stringify(canvas, null, 1)} as unknown as RecordedCanvas;\nexport default canvas;\n`);
fs.writeFileSync(path.join(runsDir, `${CASE}.media.json`), `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
writeSummary(path.join(runsDir, 'summary.json'), record, true);
const inRepo = Object.values(manifest).filter(file => !file.staged).reduce((sum, file) => sum + file.bytes, 0);
console.log(`${CASE}: ${record.completed}/${record.total} agents and edits, ${media.length} media nodes, ${record.runs ?? 1} ${record.runs ? 'runs' : 'run'}; lineage proved again over ${lineage.wires} wires (${lineage.across} across runs); ${Object.keys(manifest).length} files (${Math.round(inRepo / 1024)} KB in the repo); staged: ${staged}`);
