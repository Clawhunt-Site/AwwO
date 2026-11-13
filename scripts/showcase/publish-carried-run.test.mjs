// node --test scripts/showcase/publish-carried-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { carriedRecord } from './publish-carried-run.mjs';

const API = 'a'.repeat(40), CHAT = 'b'.repeat(40), STATION = 'c'.repeat(40);
const PAGE = '<!doctype html><html><head><title>Piece</title></head><body><script type="module" src="page/piece.js"></script></body></html>';
const agent = (id, title, x, y, runtime, outputs) => ({ id, kind: 'session', title, x, y, runtime, model: 'bedrock.claude-fable-5-2', persona: `You are ${title}.`,
  contract: { version: 1, inputs: [{ id: 'brief', label: 'Task', type: 'markdown', value: 'Carry it.\n\n[Attachment] a.glb · awwo-file:aAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }], outputs } });
const text = [{ id: 'result', label: 'Notes', type: 'markdown' }];

/** A whole raw run: a director, one carrier, the page node and the hand-over; the page node ran in a second graph run. */
function raw() {
  const nodes = [
    agent('direction', 'Direction', 0, 0, 'openai-agents', text),
    agent('models', 'Models', 340, 0, 'blender', [{ id: 'result', label: 'Models: table', type: 'markdown' }, { id: 'a_glb', label: 'models/a.glb', type: 'file' }]),
    agent('page', 'Game page', 680, 0, 'blender', [{ id: 'result', label: 'Piece, playable', type: 'html' }, { id: 'engine', label: 'page/piece.js', type: 'file' }, { id: 'report', label: 'Page report', type: 'markdown' }]),
    agent('handover', 'Hand-over', 1020, 0, 'openai-agents', text),
  ];
  const edge = (from, port, to, input) => ({ id: `${from}:out:${port}->${to}:in:${input}`, fromNode: from, fromPort: `out:${port}`, toNode: to, toPort: `in:${input}`, dataType: 'text' });
  const at = minute => `2026-11-12T10:${String(minute).padStart(2, '0')}:00.000000+00:00`;
  const entry = (nodeId, runId, state, from, to) => ({ nodeId, runId, state, startedAt: at(from), endedAt: at(to) });
  return {
    caseId: 'piece', locale: 'en', edition: 'The live AwwO', model: 'Claude Fable 5.2', api: API, workers: { 'openai-agents': CHAT, blender: STATION },
    limits: { contextWindow: 200000, maxOutputTokens: 64000, modelCallsPerNode: 64, thinking: true }, root: 'page',
    note: 'The canvas carried the piece; the page node failed once and ran again.', verification: 'Every file handed on was compared with the file put in.',
    document: { nodes, edges: [edge('direction', 'result', 'handover', 'from_direction'), edge('models', 'result', 'page', 'from_models'), edge('page', 'report', 'handover', 'from_page_report')] },
    graphs: [
      { id: 'g1', status: 'failed', createdAt: at(0), updatedAt: at(10), nodes: [entry('direction', 'r1', 'done', 0, 1), entry('models', 'r2', 'done', 0, 5), entry('page', 'r3', 'failed', 5, 6), { nodeId: 'handover', runId: null, state: 'blocked' }] },
      { id: 'g2', status: 'completed', createdAt: at(20), updatedAt: at(26), nodes: [{ nodeId: 'direction', runId: null, state: 'cached' }, { nodeId: 'models', runId: null, state: 'cached' }, entry('page', 'r4', 'done', 20, 24), entry('handover', 'r5', 'done', 24, 26)] },
    ],
    runs: {
      r1: { status: 'completed', output: '# Direction\nThe piece in three sentences.' },
      r2: { status: 'completed', output: JSON.stringify({ result: 'One file, 1,024 bytes, same bytes: yes.', a_glb: 'awwo-file:aBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }) },
      r3: { status: 'failed', output: '' },
      r4: { status: 'completed', output: JSON.stringify({ result: PAGE, engine: 'awwo-file:aCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', report: 'One path, one file: none missing.' }) },
      r5: { status: 'completed', output: '# Hand-over\nNo node here played the piece.' },
    },
    invocations: { r1: [{ usage: { inputTokens: '100', outputTokens: '50' } }], r2: [{ usage: { inputTokens: '1000', outputTokens: '10' } }, { usage: { inputTokens: '1100', outputTokens: '20' } }],
      r3: [], r4: [{ usage: { inputTokens: '2000', outputTokens: '30' } }, { usage: { inputTokens: '2100', outputTokens: '40' } }], r5: [{ usage: { inputTokens: '300', outputTokens: '60' } }] },
  };
}

test('makes the record of a whole carried run: each agent’s text, the runtimes, the times of both runs', () => {
  const record = carriedRecord(raw());
  assert.equal(record.canvas, 'carried');
  assert.deepEqual([record.completed, record.total, record.runs, record.seconds, record.activeSeconds], [4, 4, 2, 26 * 60, 16 * 60]);
  assert.equal(record.runtime, 'openai-agents + blender');
  assert.deepEqual(record.source, { api: API, worker: STATION, runs: [{ api: API, worker: CHAT, nodes: ['direction', 'handover'] }, { api: API, worker: STATION, nodes: ['models', 'page'] }] });
  assert.deepEqual(record.nodes.map(node => [node.id, node.column, node.row, node.status, node.outputType, node.blender === true, node.calls]),
    [['direction', 0, 0, 'done', 'markdown', false, undefined], ['models', 1, 0, 'done', 'markdown', true, 2], ['page', 2, 0, 'done', 'html', true, 2], ['handover', 3, 0, 'done', 'markdown', false, undefined]]);
  // The page node's record is its second run's: what the canvas holds.
  const page = record.nodes.find(node => node.id === 'page');
  assert.deepEqual([page.output, page.report, page.seconds, page.tokens], [PAGE, 'One path, one file: none missing.', 240, { input: 4100, output: 70 }]);
  assert.equal(record.artifactNodeId, 'page');
  assert.equal(record.artifactSHA256, createHash('sha256').update(PAGE).digest('hex'));
  assert.deepEqual(record.edges, [{ from: 'direction', to: 'handover', label: 'Notes' }, { from: 'models', to: 'page', label: 'Models: table' }, { from: 'page', to: 'handover', label: 'Page report', port: 'report' }]);
  // Two agents at most worked at one moment (the director and the carrier).
  assert.equal(record.limits.concurrency, 2);
  // An agent's brief is its persona; the attachment lines of its input, which name stored files, are not published.
  assert.equal(record.nodes[1].brief, 'You are Models.');
  assert.doesNotMatch(JSON.stringify(record), /awwo-file:/);
});

test('refuses a run that is not whole, and anything private, foreign or named after a provider', () => {
  const broken = change => { const value = raw(); change(value); return () => carriedRecord(value); };
  assert.throws(broken(value => { value.graphs.pop(); }), /page did not complete/);
  assert.throws(broken(value => { delete value.runs.r5; }), /handover: its run is not among the raw runs/);
  assert.throws(broken(value => { value.runs.r4.output = JSON.stringify({ result: PAGE, engine: 'x' }); }), /page delivered no report/);
  assert.throws(broken(value => { value.root = 'models'; }), /root must be the node that delivered the page/);
  assert.throws(broken(value => { value.locale = 'zh'; }), /English/);
  assert.throws(broken(value => { value.note = 'TODO'; }), /placeholder/);
  assert.throws(broken(value => { value.runs.r1.output = '方向'; }), /not English/);
  assert.throws(broken(value => { value.runs.r1.output = 'Models from Tripo.'; }), /names a provider/);
  assert.throws(broken(value => { value.runs.r1.output = 'See C:\\Users\\someone\\notes.txt'; }), /machine path/);
  assert.throws(broken(value => { value.runs.r5.output = 'Stored as awwo-file:aDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'; }), /AwwO's identifiers/);
  assert.throws(broken(value => { value.document.nodes[1].runtime = 'sandbox'; }), /chat or work in the workstation/);
  assert.throws(broken(value => { value.workers.blender = 'short'; }), /40-digit revision/);
  // A SHA-256 an agent reports is not one of AwwO's identifiers.
  assert.doesNotThrow(broken(value => { value.runs.r1.output = `Its SHA-256 is ${'ab'.repeat(32)}.`; }));
});
