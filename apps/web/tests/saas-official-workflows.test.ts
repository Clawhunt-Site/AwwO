import { describe, expect, it } from 'vitest';
import { sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canConnect, isSoftMediaFeed, reconcileEdges } from '../src/canvas/ports';
import { mediaKindOf, parseMediaCatalogue, replacementMediaModel } from '../src/canvas/mediaCatalog';
import { findCycle, preflightGraph, preflightGraphIssue, runGraph } from '../src/canvas/runGraph';
import { normalizeContract } from '../src/canvas/nodeContracts';
import { createOfficialDocument, type OfficialWorkflow } from '../src/saas/examples/officialWorkflows';
import { PRODUCTION_WORKFLOWS, PUBLISHED_EPICS, PUBLISHED_FLAGSHIPS } from '../src/saas/productionWorkflows';

// createOfficialDocument mints the canvas a member copies from every production case compiled from tasks
// (productionWorkflows.ts), the knowledge base's included. Every case is English, so there is one canvas whatever
// the interface language. No case has a 3D model node yet, so one copy of a media case gets one here, to keep the
// builder's 3D wiring covered.
const gt = PRODUCTION_WORKFLOWS['aurora-gt'];
const WITH_MODEL: OfficialWorkflow = { ...gt, id: 'aurora-gt-with-model', media: [...gt.media!, {
  id: 'model', kind: 'model3d', title: '3D model', prompt: 'A 3D model of the car',
  model: 'tripo.p1', params: { texture: true, pbr: true, textureQuality: 'detailed', faceLimit: 12000 }, column: 0, row: 4, feeds: ['page'] }] };
// A flagship canvas (an assembly node and agents that work in sandbox computers, dozens of model calls each) has its
// own tests, saas-flagship-workflows.test.ts.
const CASES = Object.values(PRODUCTION_WORKFLOWS).filter(item => ![...PUBLISHED_FLAGSHIPS, ...PUBLISHED_EPICS].includes(item.id as never));
// The same copy on three.js r186 with a rigged, animated model: only an r186 page (one that loads GLBs) fed by an
// animated 3D node is told where its clips are.
const WITH_ANIMATED_MODEL: OfficialWorkflow = { ...gt, id: 'aurora-gt-with-animated-model', stack: 'r186', media: [...gt.media!, {
  id: 'model', kind: 'model3d', title: '3D model', prompt: 'A 3D model of the driver',
  model: 'tripo.p1', params: { texture: true, pbr: true, faceLimit: 6000, rig: 'biped', motion: 'combat', inPlace: true }, column: 0, row: 4, feeds: ['page'] }] };
const WORKFLOWS: ReadonlyArray<OfficialWorkflow> = [...CASES, WITH_MODEL, WITH_ANIMATED_MODEL];

describe.each(WORKFLOWS)('$id compiled canvas', item => {
  // A case's image, video and 3D nodes feed the pages that show them (officialMedia.ts feeds) by a soft wire.
  const agents = (document: ReturnType<typeof createOfficialDocument>) => (document.nodes as SessionNode[]).filter(node => !mediaKindOf(node.agentKind));
  const media = (document: ReturnType<typeof createOfficialDocument>) => (document.nodes as SessionNode[]).filter(node => mediaKindOf(node.agentKind));

  it('creates a connected, acyclic, compatible graph with distinct fan-in fields, in English', () => {
    const document = createOfficialDocument(item);
    expect(document.version).toBe(2);
    expect(document.execution).toBeUndefined();
    expect(findCycle(document.nodes, document.edges)).toEqual([]);
    expect(reconcileEdges(document.nodes, document.edges)).toEqual(document.edges);
    const connected: typeof document.edges = [];
    for (const edge of document.edges) {
      expect(edge.kind).toBeUndefined();
      expect(canConnect(document.nodes, connected,
        { nodeId: edge.fromNode, portId: edge.fromPort }, { nodeId: edge.toNode, portId: edge.toPort })).toBe(true);
      connected.push(edge);
    }
    const touched = new Set(document.edges.flatMap(edge => [edge.fromNode, edge.toNode]));
    expect(touched.size).toBe(agents(document).length + media(document).length);
    expect(agents(document)).toHaveLength(item.nodes.length);
    expect(media(document).map(node => node.title)).toEqual((item.media ?? []).map(spec => spec.title));
    // A merge: some node takes several hand-offs, its upstream agents' or its media nodes'.
    expect(document.nodes.some(node => document.edges.filter(edge => edge.toNode === node.id).length > 1)).toBe(true);
    for (const node of agents(document)) {
      expect(normalizeContract(node.contract)).toEqual(node.contract);
      expect(node.contract!.inputs.find(field => field.id === 'brief')).toMatchObject({ label: 'Task and boundaries', value: expect.stringContaining(item.brief) });
      expect(node.persona).toMatch(/^Acceptance:$/m);
      for (const field of node.contract!.inputs) {
        const upstream = document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`);
        if (field.value === '') expect(upstream).toHaveLength(1);
        else expect(upstream).toHaveLength(0);
      }
      // A node a media node feeds (a page, or a module whose code the page holds) is told how to use its files, and a
      // 3D model's GLB; any other node uses none.
      const fed = node.contract!.inputs.filter(field => field.id.startsWith('media_'));
      expect(node.persona.includes('media nodes hand you the files')).toBe(fed.length > 0);
      const model = fed.some(field => item.media?.find(spec => `media_${spec.id}` === field.id)?.kind === 'model3d');
      expect(node.persona.includes('A 3D model node hands over a GLB model')).toBe(model);
      const animated = fed.some(field => {
        const spec = item.media?.find(candidate => `media_${candidate.id}` === field.id);
        return spec?.kind === 'model3d' && typeof spec.params?.motion === 'string' && spec.params.motion !== 'none';
      });
      expect(node.persona.includes('An animated model’s clips are in its GLB')).toBe(animated && item.stack === 'r186');
    }
    for (const [index, node] of media(document).entries()) {
      const spec = item.media![index];
      const wires = document.edges.filter(edge => edge.fromNode === node.id && edge.toPort !== 'reference');
      expect(spec.feeds?.length).toBeGreaterThan(0);
      expect(wires.map(edge => agents(document).find(page => page.id === edge.toNode)!.id))
        .toEqual(spec.feeds!.map(id => agents(document)[item.nodes.findIndex(page => page.id === id)].id));
      for (const wire of wires) {
        expect(wire).toMatchObject({ fromPort: 'result', toPort: `in:media_${spec.id}`, dataType: spec.kind === 'model3d' ? 'file' : spec.kind });
        const page = agents(document).find(candidate => candidate.id === wire.toNode)!;
        expect(['html', 'markdown']).toContain(page.contract!.outputs[0].type);
        expect(isSoftMediaFeed(node, page, wire)).toBe(true);
      }
      // Its only input is the picture it starts from, when it has one.
      expect(document.edges.filter(edge => edge.toNode === node.id).map(edge => edge.toPort)).toEqual((spec.references ?? []).map(() => 'reference'));
      expect(node.agentKind).toBe(spec.kind);
      expect(node.model).toBe(spec.model);
      expect(node.runtime).toBe('');
      expect(node.contract).toBeUndefined();
      expect(node.persona).toBe('');
      expect(node.mediaParams).toEqual(spec.params);
      expect(node.threads?.map(thread => thread.draft)).toEqual([spec.prompt]);
    }
    // A copy starts on models the service still offers: none on a retired one (which a canvas moves off when it opens,
    // dropping the case's settings), and a clip on Video · All-round with only the settings All-round takes
    // (backend xtasy.go: aspect ratio, duration, resolution, audio).
    const offered = parseMediaCatalogue({ configured: true, available: true, models: (['image', 'video', 'model3d'] as const).map(kind =>
      ({ id: `xt.other-${kind}`, name: kind, vendor: 'xtasy', kind, prompt: { minLength: 1, maxLength: 32000 }, params: [] })) });
    for (const spec of item.media ?? []) {
      expect(replacementMediaModel(offered, spec.kind, spec.model), spec.id).toBeNull();
      if (spec.model === 'xt.omni-video') expect(Object.keys(spec.params ?? {}).filter(name => !['aspectRatio', 'duration', 'resolution', 'generateAudio'].includes(name)), spec.id).toEqual([]);
    }
    expect(agents(document).some(node => node.contract!.outputs.some(field => field.type === 'html' && field.required))).toBe(true);
    expect(preflightGraphIssue(document.nodes, document.edges)?.code).toBe('unbound_nodes');
  });

  it('survives JSON persistence and sanitization without dropping fields, nodes or connections', () => {
    const document = createOfficialDocument(item);
    const restored = sanitizeDocument(JSON.parse(JSON.stringify(document)));
    expect(restored.edges).toEqual(document.edges);
    expect(restored.nodes).toHaveLength(document.nodes.length);
    document.nodes.forEach((node, index) => {
      expect(restored.nodes[index]).toMatchObject(node);
      expect((restored.nodes[index] as SessionNode).contract).toEqual((node as SessionNode).contract);
    });
    expect(sanitizeDocument(restored)).toEqual(restored);
  });

  it('creates fresh IDs and independent contracts without copying model choices, history or results', () => {
    const before = JSON.stringify(item);
    const first = createOfficialDocument(item);
    const initial = first.nodes[0] as SessionNode;
    initial.binding = { companyId: 'private-tenant', agentId: 'private-agent', agentName: 'Private agent' };
    initial.runtime = 'private-runtime'; initial.model = 'private-model'; initial.effort = 'high';
    initial.issueId = 'private-conversation'; initial.preview = 'Private transcript';
    initial.lastOutput = { text: 'Private historical output', source: 'run', at: 1 };
    initial.contract!.inputs[0].value = 'Private input';
    initial.contract!.outputs[0].value = 'Private published value';
    first.edges[0].toPort = 'in:mutated';
    for (const node of media(first)) node.threads![0].draft = 'Private prompt';
    const second = createOfficialDocument(item);
    const firstIDs = new Set(first.nodes.map(node => node.id));
    expect(second.nodes.every(node => !firstIDs.has(node.id))).toBe(true);
    for (const node of second.nodes as SessionNode[]) {
      expect(node.binding).toBeNull(); expect(node.bindAttempt).toBeNull();
      expect(node.runtime).toBe(''); expect(node.effort).toBe('');
      expect(node.issueId).toBeNull(); expect(node.preview).toBe('');
      expect(node.lastOutput).toBeUndefined();
      expect(node.agentRef).toBeUndefined();
      if (mediaKindOf(node.agentKind)) {
        // A media node's choice of model is the case's own, and its prompt is its only draft.
        expect(node.model).not.toBe('');
        expect(node.threads).toHaveLength(1);
        expect(node.threads![0]).toMatchObject({ issueId: null, preview: '' });
        continue;
      }
      expect(node.model).toBe('');
      expect(node.threads).toBeUndefined(); expect(node.activeThreadId).toBeUndefined();
      expect(node.contract!.outputs.every(field => field.value === '')).toBe(true);
    }
    expect(JSON.stringify(second)).not.toContain('Private');
    expect(JSON.stringify(item)).toBe(before);
    expect(reconcileEdges(second.nodes, second.edges)).toEqual(second.edges);
  });

  it('runs through the real graph scheduler with fixture outputs and passes every upstream result into its consumer', async () => {
    const document = createOfficialDocument(item);
    const nodes = document.nodes as SessionNode[];
    for (const node of nodes) node.binding = { companyId: 'test-tenant', agentId: `test-${node.id}`, agentName: node.title };
    expect(preflightGraph(nodes, document.edges)).toBeNull();
    const pictures = new Set(media(document).map(node => node.id));
    // A picture another media node starts from is made in both runs; every other media node is refused in the second.
    const referenced = new Set(document.edges.filter(edge => edge.toPort === 'reference').map(edge => edge.fromNode));
    const refusable = new Set([...pictures].filter(id => !referenced.has(id)));
    // What a media node delivers on the server: the record of the files it stored.
    const record = (node: SessionNode) => JSON.stringify({ type: 'awwo.media', version: 1, kind: node.agentKind, model: node.model,
      items: node.agentKind === 'model3d'
        ? [{ artifactId: 'aFIXTUREMODEL', name: 'model-1.glb', contentType: 'model/gltf-binary', size: 64 }, { artifactId: 'aFIXTUREPREVIEW', name: 'preview-1.webp', contentType: 'image/webp', size: 32 }]
        : [{ artifactId: 'aFIXTUREFILE1', name: `${node.agentKind}-1.${node.agentKind === 'video' ? 'mp4' : 'png'}`, contentType: node.agentKind === 'video' ? 'video/mp4' : 'image/png', size: 32 }] });
    const run = (fail: boolean) => {
      const completed = new Set<string>();
      const messages = new Map<string, string>();
      const refused = (id: string) => fail && refusable.has(id);
      return { messages, summary: runGraph({ nodes, edges: document.edges, onStatus: () => {}, execAgent: async (node, message) => {
        for (const edge of document.edges.filter(edge => edge.toNode === node.id)) {
          expect(completed.has(edge.fromNode) || refused(edge.fromNode)).toBe(true);
          if (edge.toPort === 'reference') continue;
          expect(message).toContain(pictures.has(edge.fromNode) ? (refused(edge.fromNode) ? '这次没有生成出' : `${edge.fromNode}/`) : `fixture-result:${edge.fromNode}`);
        }
        messages.set(node.id, message);
        if (pictures.has(node.id)) {
          if (refused(node.id)) return { ok: false, output: '', detail: 'media_quota_exceeded' };
          completed.add(node.id);
          return { ok: true, output: record(node) };
        }
        completed.add(node.id);
        const marker = `fixture-result:${node.id}`;
        const output = node.contract!.outputs[0].type === 'html'
          ? `<html><head><title>Test fixture</title></head><body>${marker}</body></html>` : marker;
        return { ok: true, output };
      } }) };
    };
    const made = run(false);
    expect(await made.summary).toMatchObject({ ok: true, done: nodes.length, failed: 0, blocked: 0, cached: 0 });
    expect(made.messages.size).toBe(nodes.length);
    if (refusable.size) {
      // The same run when those pictures cannot be made: only those media nodes fail, and every page is still made.
      const refusedRun = run(true);
      expect(await refusedRun.summary).toMatchObject({ done: nodes.length - refusable.size, failed: refusable.size, blocked: 0 });
    }
    // Scheduler fixtures are test evidence only and never become case history.
    expect(nodes.every(node => node.lastOutput === undefined && (node.contract?.outputs ?? []).every(field => field.value === ''))).toBe(true);
  });
});

it('blocks the review when the build fails the real HTML output contract', async () => {
  const document = createOfficialDocument(PRODUCTION_WORKFLOWS['pixel-platformer']);
  const nodes = document.nodes as SessionNode[];
  for (const node of nodes) node.binding = { companyId: 'test', agentId: node.id, agentName: node.title };
  const builder = nodes.find(node => node.contract!.outputs[0].type === 'html')!;
  const downstream = document.edges.filter(edge => edge.fromNode === builder.id).map(edge => edge.toNode);
  expect(downstream.length).toBeGreaterThan(0);
  const executed = new Set<string>();
  const result = await runGraph({ nodes, edges: document.edges, onStatus: () => {}, execAgent: async node => {
    executed.add(node.id);
    return { ok: true, output: node.id === builder.id ? '<p>Incomplete fragment</p>' : 'A fixture result' };
  } });
  expect(result.ok).toBe(false);
  expect(result.failed).toBe(1);
  expect(result.blocked).toBeGreaterThan(0);
  expect(downstream.every(id => !executed.has(id))).toBe(true);
});
