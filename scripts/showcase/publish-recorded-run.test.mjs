// Offline checks of the film-case publisher's gates (publish-recorded-run.mjs): it refuses, before reading any file,
// notes that are placeholders or lack the release windows, and a raw record that does not carry its lineage check, shows
// a gap, or holds a file that is not the bytes AwwO lists. Run: node --test scripts/showcase/publish-recorded-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'publish-recorded-run.mjs');
const NOTES = {
  note: 'What happened in the run.', verification: 'What was checked in a browser.', edition: 'The live AwwO.', model: 'Claude Opus 4.8',
  source: { api: 'a'.repeat(12), worker: 'b'.repeat(12), runs: [{ api: 'a'.repeat(12), worker: 'b'.repeat(12), nodes: ['ed'] }] },
  limits: { contextWindow: 200000, maxOutputTokens: 32000, modelCallsPerNode: 1, concurrency: 5 }, thinking: true,
  releases: [{ api: 'a'.repeat(12), from: '2026-10-19T13:23:35Z' }],
};
const RAW = { caseId: 'film-case', locale: 'en', root: 'edit', nodes: ['edit'], problems: [], lineage: [], producedBy: {}, graphs: [], files: [],
  artifactListing: { complete: true, count: 1 }, canvas: { id: 'c', version: 1, document: { nodes: [], edges: [] } } };
const FILE = { nodeId: 'edit', artifactId: 'a1', name: 'act-1.mp4', file: 'edit-a1-act-1.mp4', size: 10, sha256: 'a'.repeat(64), listed: { sha256: 'a'.repeat(64), size: 10 } };

function publish(raw, notes) {
  const dir = mkdtempSync(join(tmpdir(), 'awwo-publish-film-'));
  try {
    writeFileSync(join(dir, 'raw.json'), JSON.stringify(raw));
    writeFileSync(join(dir, 'notes.json'), JSON.stringify(notes));
    return spawnSync(process.execPath, [script, join(dir, 'raw.json'), join(dir, 'notes.json')], { encoding: 'utf8', timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('refuses notes that are placeholders, not what was done', () => {
  for (const text of ['PROVISIONAL: replaced later.', 'TODO: write this', 'TBD', 'placeholder text']) {
    const result = publish(RAW, { ...NOTES, verification: text });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /notes\.verification is a placeholder/);
  }
  assert.match(publish(RAW, { ...NOTES, note: 'TODO' }).stderr, /notes\.note is a placeholder/);
  assert.match(publish(RAW, { ...NOTES, edition: 'TBD' }).stderr, /notes\.edition is a placeholder/);
});

test('refuses a raw record that does not carry its lineage check, or shows a gap', () => {
  for (const missing of ['problems', 'lineage', 'producedBy', 'graphs', 'files']) {
    const raw = { ...RAW };
    delete raw[missing];
    const result = publish(raw, NOTES);
    assert.notEqual(result.status, 0, missing);
    assert.match(result.stderr, /does not carry its lineage check/, missing);
  }
  const gap = publish({ ...RAW, lineage: ['clip -> reel: in g1 reel read another output of clip'] }, NOTES);
  assert.notEqual(gap.status, 0);
  assert.match(gap.stderr, /has problems or lineage gaps:\s+clip -> reel/);
  assert.match(publish({ ...RAW, problems: ['take: no graph run finished with its current output'] }, NOTES).stderr, /has problems or lineage gaps/);
});

test('proves the lineage again from the graph runs the read carries, and refuses a gap the read did not report', () => {
  // a -> b: b was made in run g2, which started from a document where a still held its earlier output.
  const canvas = { id: 'c', version: 1, document: { nodes: [{ id: 'a', lastOutput: { text: 'a, made again' } }, { id: 'b', lastOutput: { text: 'b' } }],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] } };
  const graphs = [{ id: 'g1', createdAt: '2026-10-20T01:00:00Z', document: { nodes: [{ id: 'a' }] } },
    { id: 'g2', createdAt: '2026-10-20T00:00:00Z', document: { nodes: [{ id: 'a', lastOutput: { text: 'a, as first made' } }, { id: 'b' }] } }];
  const raw = { ...RAW, root: 'b', nodes: ['a', 'b'], canvas, graphs, producedBy: { a: { graph: 'g1' }, b: { graph: 'g2' } } };
  const gap = publish(raw, NOTES);
  assert.notEqual(gap.status, 0);
  assert.match(gap.stderr, /a -> b: the run that made b read another output of a/);
  assert.match(publish({ ...raw, producedBy: { a: { graph: 'g1' } } }, NOTES).stderr, /b: no graph run the read carries made it/);
  for (const producedBy of [[], 'g1', null]) assert.match(publish({ ...raw, producedBy }, NOTES).stderr, /does not carry its lineage check/);
  // A source made in the same run as its target is not compared (that run handed it the output it made).
  const same = publish({ ...raw, producedBy: { a: { graph: 'g2' }, b: { graph: 'g2' } } }, NOTES);
  assert.doesNotMatch(same.stderr, /read another output|no wire joins/);
  // Published nodes with no wire among them: nothing would be proved, so the read is refused.
  assert.match(publish({ ...raw, canvas: { ...canvas, document: { ...canvas.document, edges: [] } } }, NOTES).stderr,
    /no wire joins the published nodes, so there is no lineage to prove/);
});

test('refuses a stored file that is not the bytes AwwO lists for the canvas, or a read of part of its listing', () => {
  for (const listed of [undefined, { sha256: 'b'.repeat(64), size: 10 }, { sha256: 'a'.repeat(64), size: 11 }, { sha256: null, size: null }]) {
    const result = publish({ ...RAW, files: [{ ...FILE, listed }] }, NOTES);
    assert.notEqual(result.status, 0, JSON.stringify(listed));
    assert.match(result.stderr, /edit\/act-1\.mp4: not the bytes the canvas's artifact listing names/, JSON.stringify(listed));
  }
  for (const artifactListing of [undefined, { complete: false, count: 500 }]) {
    assert.match(publish({ ...RAW, artifactListing }, NOTES).stderr, /does not say it read the canvas's whole artifact listing/);
  }
  assert.match(publish({ ...RAW, files: [FILE, { ...FILE, name: 'again.mp4' }] }, NOTES).stderr, /edit\/again\.mp4: a stored file without its own artifact id/);
});

test('refuses notes without the API releases in order, or without the run settings', () => {
  assert.match(publish(RAW, { ...NOTES, releases: [] }).stderr, /notes\.releases must list the API releases in order/);
  assert.match(publish(RAW, { ...NOTES, releases: [{ api: 'a'.repeat(12), from: '2026-10-20T00:00:00Z' }, { api: 'c'.repeat(12), from: '2026-10-19T00:00:00Z' }] }).stderr,
    /notes\.releases must list the API releases in order/);
  assert.match(publish(RAW, { ...NOTES, limits: { ...NOTES.limits, concurrency: 0 } }).stderr, /notes\.limits needs positive integers/);
  assert.match(publish({ ...RAW, locale: 'zh' }, NOTES).stderr, /not en/);
});

test('refuses a provider named in what a node was asked, even inside another word, but not an English word that holds one', () => {
  // One picture node whose run is in the read: the scan of its words runs before any file is needed.
  const node = words => ({ id: 'kf', kind: 'session', agentKind: 'image', title: 'Keyframe', model: 'm', runtime: '', x: 0, y: 0, w: 1, h: 1,
    activeThreadId: 'default', threads: [{ id: 'default', title: 'Session 1', draft: words }], lastOutput: { text: 'out' } });
  const raw = words => ({ ...RAW, root: 'kf', nodes: ['kf'], producedBy: { kf: { graph: 'g1' } },
    graphs: [{ id: 'g1', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:01:00Z', document: { nodes: [node(words)], edges: [] },
      nodes: [{ nodeId: 'kf', state: 'done', output: 'out' }] }],
    canvas: { id: 'c', version: 1, document: { nodes: [node(words)], edges: [] } } });
  for (const [words, name] of [['A coast at dawn, made with Kling.', 'Kling'], ['Rendered by kling2.1 at dusk.', 'kling'], ['Seedance-made.', 'Seedance'],
    ['Styled like KlingAI samples.', 'Kling'], ['See klingai.com.', 'kling'], ['A MiniMaxAI voice.', 'MiniMax'], ['Cut on SuperKling.', 'Kling'],
    ['A sparkling Kling clip.', 'Kling'], ['See sparklingai.com.', 'kling']]) {
    assert.match(publish(raw(words), NOTES).stderr, new RegExp(`kf[.]draft names a provider: “${name}”`), words);
  }
  for (const words of ['A sparkling sea at dawn, the Twinkling of lamps.', 'Geminid meteors over the bay.', 'A camera on a tripod, the darkling plain.', 'The weakling, tickling a duckling.']) {
    assert.doesNotMatch(publish(raw(words), NOTES).stderr, /names a provider/, words);
  }
});

// A film written as code (2026-10-26): its page is pasted together by an assembly, and its agents' words sit in contracts.
const FILE_CONTRACT = { version: 1, inputs: [{ id: 'from_kernel', label: 'Kernel', type: 'text', required: true, value: '' }],
  outputs: [{ id: 'file', label: 'Page', type: 'file', required: true, value: '' }] };
const one = node => ({ ...RAW, root: node.id, nodes: [node.id], producedBy: { [node.id]: { graph: 'g1' } },
  graphs: [{ id: 'g1', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:01:00Z', document: { nodes: [node], edges: [] },
    nodes: [{ nodeId: node.id, state: 'done', output: node.lastOutput.text }] }],
  canvas: { id: 'c', version: 1, document: { nodes: [node], edges: [] } } });
const assembly = over => ({ id: 'page', kind: 'assemble', title: 'Assembly', x: 0, y: 0, w: 1, h: 1, template: '<!DOCTYPE html><script>{{in:from_kernel}}</script>',
  contract: FILE_CONTRACT, lastOutput: { text: '{"file":"awwo-file:a1"}' }, ...over });

test('publishes an assembly only with a contract it can read, and scans its template', () => {
  for (const contract of [undefined, null, { version: 2, inputs: [], outputs: [] }, { version: 1, inputs: 'x', outputs: [] }]) {
    assert.match(publish(one(assembly({ contract })), NOTES).stderr, /page: an assembly without a readable contract/, JSON.stringify(contract));
  }
  assert.match(publish(one(assembly({ template: '<!DOCTYPE html><!-- made with Kling -->{{in:from_kernel}}' })), NOTES).stderr, /page[.]template names a provider: “Kling”/);
  assert.doesNotMatch(publish(one(assembly({})), NOTES).stderr, /readable contract|names a provider/);
});

test('scans the words an agent’s contract holds: its inputs’ values and its fields’ labels', () => {
  const agent = value => ({ id: 'director', kind: 'session', agentKind: 'coding', runtime: 'sandbox', model: '', title: 'Director', persona: 'Write the brief.',
    x: 0, y: 0, w: 1, h: 1, threads: [], lastOutput: { text: '{"result":"A brief."}' },
    contract: { version: 1, inputs: [{ id: 'brief', label: 'Task', type: 'markdown', required: true, value }], outputs: [{ id: 'result', label: 'Brief', type: 'markdown', required: true, value: '' }] } });
  assert.match(publish(one(agent('Cut it like a Seedance trailer.')), NOTES).stderr, /director[.]contract names a provider: “Seedance”/);
  assert.doesNotMatch(publish(one(agent('A floating island at night, in rain.')), NOTES).stderr, /names a provider/);
  // A contract the canvas would refuse is refused here, a falsy one too, rather than published as no contract.
  for (const contract of [false, 0, '', { version: 2, inputs: [], outputs: [] }]) {
    assert.match(publish(one({ ...agent('A brief.'), contract }), NOTES).stderr, /director: an agent with a contract the canvas cannot read/, JSON.stringify(contract));
  }
});
