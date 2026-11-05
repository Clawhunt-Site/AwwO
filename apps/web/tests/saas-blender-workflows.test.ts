import { describe, expect, it } from 'vitest';
import type { SessionNode } from '../src/canvas/canvasDoc';
import { findCycle } from '../src/canvas/runGraph';
import { pickCanvasFile } from '../src/canvas/studio/canvasAssets';
import type { StudioEntry } from '../src/canvas/studio/studioModel';
import { BLENDER_WORKFLOWS } from '../src/saas/blenderWorkflows';
import { createOfficialDocument, type OfficialWorkflow } from '../src/saas/examples/officialWorkflows';
import { createProductionCopyDocument } from '../src/saas/productionCopy';
import type { ProductionRunRecord } from '../src/saas/productionRuns';

// The Blender cases (blenderWorkflows.ts): makers on the Blender workstation hand on files of their own (GLBs, renders),
// which a photographer takes by wire and a page loads by `<node id>/<file name>`.
const GYROID = BLENDER_WORKFLOWS['gyroid-jewellery'];
const MAX_PROMPT_BYTES = 128000;

describe('the GYROID canvas', () => {
  const document = createOfficialDocument(GYROID);
  const nodes = document.nodes as SessionNode[];
  const node = (id: string) => nodes[GYROID.nodes.findIndex(spec => spec.id === id)];

  it('puts its makers and photographer on the Blender workstation and its site in the sandbox computer', () => {
    expect(GYROID.nodes.map(spec => spec.id)).toEqual(['ring', 'pieces', 'photo', 'site']);
    expect(['ring', 'pieces', 'photo', 'site'].map(id => node(id).runtime)).toEqual(['blender', 'blender', 'blender', 'sandbox']);
    expect(node('site').contract!.outputs.map(field => field.type)).toEqual(['html']);
  });

  it('gives each file its own file output, labelled with the path the page loads it by, at most 8 a node', () => {
    for (const spec of GYROID.nodes) {
      const outputs = node(spec.id).contract!.outputs;
      expect(outputs[0]).toMatchObject({ id: 'result', type: spec.outputType ?? 'markdown' });
      const files = outputs.filter(field => field.type === 'file');
      expect(files.map(field => [field.id, field.label]), spec.id).toEqual((spec.files ?? []).map(file => [file.id, `${spec.id}/${file.label}`]));
      expect(files.length).toBeLessThanOrEqual(8);
      for (const file of files) expect(file.label, `${spec.id}.${file.id}`).toMatch(/^[a-z]+\/[a-z0-9_-]+\.(glb|jpg)$/);
    }
    // The preview finds a canvas file by its name: no two files share one.
    const labels = GYROID.nodes.flatMap(spec => (spec.files ?? []).map(file => file.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('wires each model into the photographer as a file input of its own, one source per input, and the ring’s notes', () => {
    const photo = node('photo');
    const files = photo.contract!.inputs.filter(field => field.type === 'file').map(field => field.id);
    expect(files).toEqual(['from_ring_model', 'from_pieces_pendant', 'from_pieces_earrings']);
    const wires = document.edges.filter(edge => edge.toNode === photo.id);
    // The ring's notes give its sheet() call, from which the photographer builds the ring again at full resolution for
    // the macro (a web GLB's facets show in one: the trial of 2026-11-05).
    expect(wires.map(edge => [edge.fromPort, edge.toPort, edge.dataType])).toEqual([
      ['out:model', 'in:from_ring_model', 'file'], ['out:result', 'in:from_ring', 'text'], ['out:pendant', 'in:from_pieces_pendant', 'file'],
      ['out:earrings', 'in:from_pieces_earrings', 'file']]);
    for (const target of nodes) {
      const inputs = target.contract!.inputs.map(field => field.id);
      expect(new Set(inputs).size).toBe(inputs.length);
      for (const input of inputs.filter(value => value !== 'brief'))
        expect(document.edges.filter(edge => edge.toNode === target.id && edge.toPort === `in:${input}`), `${target.title}.${input}`).toHaveLength(1);
    }
    expect(findCycle(document.nodes, document.edges)).toEqual([]);
  });

  it('has the site load every file the canvas makes by its path, and no other', () => {
    const site = GYROID.nodes.find(spec => spec.id === 'site')!;
    const made = GYROID.nodes.flatMap(spec => (spec.files ?? []).map(file => `${spec.id}/${file.label}`));
    const named = [...site.task.matchAll(/\b([a-z]+\/[a-z0-9_-]+\.(?:glb|jpg))\b/g)].map(match => match[1]);
    expect(new Set(named)).toEqual(new Set(made));
    // The site's page rule lets it show them; it is not told the media nodes' rule.
    const persona = node('site').persona!;
    expect(persona).toContain('images (the canvas’s files your task names excepted)');
    expect(persona).not.toContain('the media nodes’ files excepted');
  });

  it('keeps every node’s prompt within what the API admits', () => {
    for (const target of nodes) {
      const bytes = Buffer.byteLength(`${target.persona}\n${target.contract!.inputs.map(field => `${field.label}\n${field.value}`).join('\n')}`);
      expect(bytes, target.title).toBeLessThan(MAX_PROMPT_BYTES / 4);
    }
  });
});

describe('a page and a maker’s file', () => {
  it('resolves `<node id>/<label>` to that file in the canvas preview, whatever the node’s id there', () => {
    const stored = (nodeId: string, label: string): StudioEntry => ({ nodeId, nodeTitle: nodeId, folder: [], state: 'done', id: `${nodeId}:field:x`,
      name: label.replace(/\.[a-z]+$/, ''), label, kind: 'file', source: { type: 'stored', reference: `awwo-file:${nodeId}-${label}` } } as unknown as StudioEntry);
    const entries = [stored('node-7f3a', 'ring.glb'), stored('node-91c2', 'pendant.glb'), stored('node-91c2', 'earrings.glb')];
    expect(pickCanvasFile(entries, 'ring/ring.glb')?.nodeId).toBe('node-7f3a');
    expect(pickCanvasFile(entries, './pieces/earrings.glb')?.label).toBe('earrings.glb');
    expect(pickCanvasFile(entries, 'ring/hero.jpg')).toBeUndefined();
    // Labelled with its path, a file is found by it whatever name the agent stored it under, before a file another
    // maker stored under the same name (review rounds 4 to 8).
    const output = (nodeId: string, path: string, name: string) => ({ ...stored(nodeId, path), name } as StudioEntry);
    const render = output('node-7f3a', 'ring/ring.jpg', 'hero.jpg'), hero = output('node-55aa', 'photo/hero.jpg', 'shot-final.jpg');
    for (const pool of [[render, hero], [hero, render]]) {
      expect(pickCanvasFile(pool, 'photo/hero.jpg')?.nodeId).toBe('node-55aa');
      expect(pickCanvasFile(pool, './photo/hero.jpg', undefined, entry => entry.name)?.nodeId).toBe('node-55aa');
      expect(pickCanvasFile(pool, 'ring/ring.jpg')?.nodeId).toBe('node-7f3a');
    }
    // A path no output is labelled with, its whole path compared (round 10), is found as before: the first of that name.
    expect(pickCanvasFile([render, hero], 'assets/hero.jpg')?.nodeId).toBe('node-7f3a');
    expect(pickCanvasFile([render, hero], 'assets/photo/hero.jpg')?.nodeId).toBe('node-7f3a');
    // An archive's member, labelled with its path in the archive, never takes that place: a generated picture first
    // stays first when an unrelated ZIP holds assets/image-1.png (review round 9).
    const generated = { ...stored('node-0b1d', 'image-1.png'), id: 'node-0b1d:media:1', name: 'image-1.png', label: 'Image 1',
      source: { type: 'media', artifactId: 'artifact-1' } } as unknown as StudioEntry;
    const member = { ...stored('node-91c2', 'assets/image-1.png'), id: 'zip:assets/image-1.png', name: 'image-1.png',
      source: { type: 'member', parentId: 'zip', path: 'assets/image-1.png', bytes: new Uint8Array() } } as unknown as StudioEntry;
    expect(pickCanvasFile([generated, member], 'assets/image-1.png')?.id).toBe(generated.id);
  });

  it('has every maker save each file under the name the site finds it by (review rounds 4 to 7)', () => {
    // The previews of a member's copy find a file by its name or label, the first that has it: a maker that stored its
    // render as hero.jpg would show where the photographer's hero.jpg belongs. Each brief names each file, and no two
    // files of the canvas share a name (checkFiles).
    for (const spec of GYROID.nodes) for (const file of spec.files ?? [])
      expect(spec.task, `${spec.id}.${file.id}`).toContain(`${file.label} into ${file.id}`);
    const labels = GYROID.nodes.flatMap(spec => (spec.files ?? []).map(file => file.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('refuses a wire from an output its source does not have, or a file into an assemble node', () => {
    const bad: OfficialWorkflow = { ...GYROID, edges: [...GYROID.edges, { from: 'ring', to: 'site', label: 'Nothing', port: 'video' }] };
    expect(() => createOfficialDocument(bad)).toThrow('Invalid official workflow port: ring.video');
    // An assemble node takes its sources' text only (review round 8).
    const assembly: OfficialWorkflow = { ...GYROID, nodes: [...GYROID.nodes, { id: 'book', title: 'Lookbook', role: 'frontend', column: 3, row: 0,
      output: 'Lookbook', outputType: 'html', task: 'Assemble the lookbook.', acceptance: [], assemble: { template: '{{in:from_ring}}' } } as unknown as OfficialWorkflow['nodes'][number]],
      edges: [...GYROID.edges, { from: 'ring', to: 'book', label: 'The ring (GLB)', port: 'model' }] };
    expect(() => createOfficialDocument(assembly)).toThrow('Invalid official workflow port: ring.model into book, which takes text');
  });

  it('refuses a file its node’s contract, the previews or the server could not tell apart', () => {
    const withFiles = (files: ReadonlyArray<{ id: string; label: string }>): OfficialWorkflow =>
      ({ ...GYROID, nodes: GYROID.nodes.map(spec => spec.id === 'ring' ? { ...spec, files: [...files, { id: 'render', label: 'ring.jpg' }] } : spec) });
    // Its id names an output of its own: not the result, the report or the handoff, nor one twice, nor a name the
    // workspace runtime refuses (constructor, prototype, over 64 characters), nor a bad name.
    for (const id of ['result', 'report', 'file', 'render', 'Model', '1x', 'constructor', 'prototype', 'a'.repeat(65)])
      expect(() => createOfficialDocument(withFiles([{ id, label: 'ring.glb' }])), id).toThrow('Invalid official workflow file:');
    const long = 'a'.repeat(64);
    expect(() => createOfficialDocument({ ...withFiles([{ id: long, label: 'ring.glb' }]),
      edges: GYROID.edges.map(edge => edge.port === 'model' ? { ...edge, port: long } : edge) })).not.toThrow();
    // A wire from the result, named or not, carries text (review round 2: `port: 'result'` became a file wire).
    const named: OfficialWorkflow = { ...GYROID, edges: GYROID.edges.map(edge => edge.from === 'ring' && edge.to === 'site' ? { ...edge, port: 'result' } : edge) };
    const compiled = createOfficialDocument(named);
    const site = compiled.nodes[GYROID.nodes.findIndex(spec => spec.id === 'site')] as SessionNode;
    expect(site.contract!.inputs.find(field => field.id === 'from_ring')?.type).toBe('markdown');
    expect(compiled.edges.find(edge => edge.toNode === site.id && edge.toPort === 'in:from_ring')?.dataType).toBe('text');
    // Its name is the file's, which the previews find it by: never another node's file's, nor a media node's kind.
    for (const label of ['pendant.glb', 'image-1.jpg', 'preview-2.png', 'ring', 'Ring.GLB'])
      expect(() => createOfficialDocument(withFiles([{ id: 'model', label }])), label).toThrow('Invalid official workflow file name:');
    // A source and one of its files fill `from_<source>_<file id>`, which a source named so would fill too.
    const twin: OfficialWorkflow = { ...GYROID, nodes: [...GYROID.nodes, { ...GYROID.nodes[0], id: 'ring_model', files: undefined, row: 2 }],
      edges: [...GYROID.edges, { from: 'ring_model', to: 'photo', label: 'Notes' }] };
    expect(() => createOfficialDocument(twin)).toThrow('two wires into photo fill one input');
  });

  it('counts a handoff among the 8 files a node may deliver, and tells its name from the files’ (review round 3)', () => {
    const ring = (files: number, handoff?: string): OfficialWorkflow => ({ ...GYROID, nodes: GYROID.nodes.map(spec => spec.id === 'ring'
      ? { ...spec, ...(handoff ? { handoff } : {}), files: Array.from({ length: files }, (_, at) => ({ id: at ? `part_${at}` : 'model', label: at ? `part-${at}.glb` : 'ring.glb' })) }
      : spec) });
    expect(() => createOfficialDocument(ring(8))).not.toThrow();
    expect(() => createOfficialDocument(ring(7, 'ring.zip'))).not.toThrow();
    expect(() => createOfficialDocument(ring(8, 'ring.zip'))).toThrow('has more than 8, its handoff counted');
    expect(() => createOfficialDocument(ring(2, 'part-1.glb'))).toThrow('Invalid official workflow file name: ring part-1.glb');
    // As the previews find files: by the last part of the name, in lower case (round 6).
    expect(() => createOfficialDocument(ring(2, 'RING.GLB'))).toThrow('Invalid official workflow file name: ring ring.glb');
    expect(() => createOfficialDocument(ring(2, 'exports/Part-1.glb'))).toThrow('Invalid official workflow file name: ring part-1.glb');
  });
});

describe('a member’s copy of a Blender case', () => {
  it('pins no page that names the makers’ files, which the copy makes afresh', () => {
    const output = (id: string) => id === 'site'
      ? '<!doctype html><html><head></head><body><img src="photo/hero.jpg"><script>load("ring/ring.glb")</script></body></html>' : `Notes of ${id}`;
    const record = {
      caseId: GYROID.id, edition: 'test', runtime: 'blender + sandbox', model: 'Claude Opus 5.5', capturedOn: '2026-11-05', seconds: 600,
      completed: 4, total: 4, limits: { contextWindow: 200000, maxOutputTokens: 64000, modelCallsPerNode: 64, concurrency: 4, thinking: false },
      source: { api: '0123456789ab', worker: '0123456789ab' }, canvasSHA256: '0'.repeat(64), note: 'test', verification: 'test',
      nodes: GYROID.nodes.map(spec => ({ id: spec.id, title: spec.title, column: spec.column, row: spec.row, status: 'done' as const,
        outputType: spec.outputType ?? 'markdown', output: output(spec.id), ...(spec.files ? { files: spec.files.map(file => `${spec.id}/${file.label}`) } : {}) })),
      edges: GYROID.edges,
    } satisfies ProductionRunRecord;
    const copy = createProductionCopyDocument(GYROID, record, null);
    const pinned = (id: string) => (copy.nodes[GYROID.nodes.findIndex(spec => spec.id === id)] as SessionNode).lastOutput;
    // The makers hand files on and are made afresh, and so is the page that names their files.
    for (const id of ['ring', 'pieces', 'photo', 'site']) expect(pinned(id), id).toBeUndefined();
  });
});
