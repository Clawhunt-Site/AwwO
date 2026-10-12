import { describe, expect, it } from 'vitest';
import { sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canConnect, isSoftMediaFeed, reconcileEdges } from '../src/canvas/ports';
import { mediaKindOf } from '../src/canvas/mediaCatalog';
import { findCycle, preflightGraph, preflightGraphIssue, runGraph } from '../src/canvas/runGraph';
import { normalizeContract } from '../src/canvas/nodeContracts';
import { OFFICIAL_WORKFLOWS, createOfficialDocument, getOfficialWorkflow } from '../src/saas/examples/officialWorkflows';

const locales = ['zh', 'en'] as const;

it('covers twelve flagship industries and preserves six starter identities with localized contracts', () => {
  expect(OFFICIAL_WORKFLOWS).toHaveLength(18);
  expect(OFFICIAL_WORKFLOWS.filter(item => item.tier !== 'flagship').map(item => item.id)).toEqual([
    'interaction-page', 'orbit-game', 'spatial-studio', 'knowledge-desk', 'model-lab', 'operations-hub',
  ]);
  const flagships = OFFICIAL_WORKFLOWS.filter(item => item.tier === 'flagship');
  expect(flagships).toHaveLength(12);
  expect(new Set(flagships.map(item => item.industry!.en)).size).toBe(12);
  expect(new Set(OFFICIAL_WORKFLOWS.map(item => item.id)).size).toBe(18);
  expect(new Set(OFFICIAL_WORKFLOWS.map(item => item.category)).size).toBe(6);
  expect(getOfficialWorkflow('untrusted-or-missing-id')).toBeUndefined();
  for (const item of OFFICIAL_WORKFLOWS) {
    expect(getOfficialWorkflow(item.id)).toBe(item);
    for (const localized of [item.title, item.summary, item.description, item.categoryLabel, item.pattern, item.brief, item.limitations, ...item.artifacts, ...(item.industry ? [item.industry] : []), ...(item.capabilities || []), ...(item.datasets || [])]) {
      for (const locale of locales) expect(localized[locale].trim()).not.toBe('');
    }
    expect(item.nodes.length).toBeGreaterThanOrEqual(item.tier === 'flagship' ? 11 : 5);
    expect(item.nodes.length).toBeLessThanOrEqual(item.tier === 'flagship' ? 14 : 8);
    if (item.tier === 'flagship') {
      expect(item.capabilities!.length).toBeGreaterThanOrEqual(6);
      expect(item.datasets!.length).toBeGreaterThan(0);
      expect(item.nodes.filter(node => node.role === 'review').length).toBeGreaterThanOrEqual(1);
      expect(item.edges.length).toBeGreaterThan(item.nodes.length);
      expect(Math.max(...item.nodes.map(node => node.column))).toBeGreaterThanOrEqual(5);
      const terminal = item.nodes.filter(node => !item.edges.some(edge => edge.from === node.id));
      expect(terminal).toHaveLength(1);
      expect(item.edges.filter(edge => edge.to === terminal[0].id).length).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(item.nodes.map(node => node.id)).size).toBe(item.nodes.length);
    for (const node of item.nodes) {
      for (const localized of [node.title, node.task, node.output, ...node.acceptance]) {
        for (const locale of locales) expect(localized[locale].trim()).not.toBe('');
      }
    }
  }
});

describe.each(OFFICIAL_WORKFLOWS)('$id executable reference', item => {
  // An example's image, video and 3D nodes feed the pages that show them (officialMedia.ts feeds) by a soft wire.
  const agents = (document: ReturnType<typeof createOfficialDocument>) => (document.nodes as SessionNode[]).filter(node => !mediaKindOf(node.agentKind));
  const media = (document: ReturnType<typeof createOfficialDocument>) => (document.nodes as SessionNode[]).filter(node => mediaKindOf(node.agentKind));

  it.each(locales)('creates a connected, acyclic, compatible %s graph with distinct fan-in fields', locale => {
    const document = createOfficialDocument(item, locale);
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
    expect(media(document).map(node => node.title)).toEqual((item.media ?? []).map(spec => spec.title[locale]));
    // Each case demonstrates parallel work and a real merge, rather than six isolated prompts.
    expect(document.nodes.some(node => document.edges.filter(edge => edge.fromNode === node.id).length > 1)).toBe(true);
    expect(document.nodes.some(node => document.edges.filter(edge => edge.toNode === node.id).length > 1)).toBe(true);
    for (const node of agents(document)) {
      expect(normalizeContract(node.contract)).toEqual(node.contract);
      expect(node.contract!.inputs.find(field => field.id === 'brief')?.value).toContain(item.brief[locale]);
      for (const field of node.contract!.inputs) {
        const upstream = document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`);
        if (field.value === '') expect(upstream).toHaveLength(1);
        else expect(upstream).toHaveLength(0);
      }
      // One model call per node: every node is told its length, and a page node that it must finish.
      expect(node.persona).toContain(node.contract!.outputs[0].type === 'html'
        ? (locale === 'zh' ? '整页 HTML 不超过 20000 个字符' : 'at most 20,000 characters')
        : (locale === 'zh' ? '说明文字不超过 2000 个中文字符' : 'Explanations stay within 1,000 words'));
      // A page a media node feeds is told how to show its files; any other page still uses none.
      const fed = node.contract!.inputs.some(field => field.id.startsWith('media_'));
      expect(node.persona.includes(locale === 'zh' ? '媒体节点会把它生成的文件交给你' : 'media nodes hand you the files')).toBe(fed);
    }
    for (const [index, node] of media(document).entries()) {
      const spec = item.media![index];
      const wires = document.edges.filter(edge => edge.fromNode === node.id);
      expect(spec.feeds?.length).toBeGreaterThan(0);
      expect(wires.map(edge => agents(document).find(page => page.id === edge.toNode)!.id))
        .toEqual(spec.feeds!.map(id => agents(document)[item.nodes.findIndex(page => page.id === id)].id));
      for (const wire of wires) {
        expect(wire).toMatchObject({ fromPort: 'result', toPort: `in:media_${spec.id}`, dataType: spec.kind === 'model3d' ? 'file' : spec.kind });
        const page = agents(document).find(candidate => candidate.id === wire.toNode)!;
        expect(page.contract!.outputs[0].type).toBe('html');
        expect(isSoftMediaFeed(node, page, wire)).toBe(true);
      }
      expect(document.edges.some(edge => edge.toNode === node.id)).toBe(false);
      expect(node.agentKind).toBe(spec.kind);
      expect(node.model).toBe(spec.model);
      expect(node.runtime).toBe('');
      expect(node.contract).toBeUndefined();
      expect(node.persona).toBe('');
      expect(node.mediaParams).toEqual(spec.params);
      expect(node.threads?.map(thread => thread.draft)).toEqual([spec.prompt[locale]]);
    }
    expect(agents(document).some(node => node.contract!.outputs.some(field => field.type === 'html' && field.required))).toBe(true);
    expect(preflightGraphIssue(document.nodes, document.edges)?.code).toBe('unbound_nodes');
  });

  it('survives JSON persistence and sanitization without dropping fields, nodes or connections', () => {
    const document = createOfficialDocument(item, 'zh');
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
    const first = createOfficialDocument(item, 'zh');
    const initial = first.nodes[0] as SessionNode;
    initial.binding = { companyId: 'private-tenant', agentId: 'private-agent', agentName: 'Private agent' };
    initial.runtime = 'private-runtime'; initial.model = 'private-model'; initial.effort = 'high';
    initial.issueId = 'private-conversation'; initial.preview = 'Private transcript';
    initial.lastOutput = { text: 'Private historical output', source: 'run', at: 1 };
    initial.contract!.inputs[0].value = 'Private input';
    initial.contract!.outputs[0].value = 'Private published value';
    first.edges[0].toPort = 'in:mutated';
    for (const node of media(first)) node.threads![0].draft = 'Private prompt';
    const second = createOfficialDocument(item, 'en');
    const firstIDs = new Set(first.nodes.map(node => node.id));
    expect(second.nodes.every(node => !firstIDs.has(node.id))).toBe(true);
    for (const node of second.nodes as SessionNode[]) {
      expect(node.binding).toBeNull(); expect(node.bindAttempt).toBeNull();
      expect(node.runtime).toBe(''); expect(node.effort).toBe('');
      expect(node.issueId).toBeNull(); expect(node.preview).toBe('');
      expect(node.lastOutput).toBeUndefined();
      expect(node.agentRef).toBeUndefined();
      if (mediaKindOf(node.agentKind)) {
        // A media node's choice of model is the example's own, and its prompt is its only draft.
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
    const document = createOfficialDocument(item, 'en');
    const nodes = document.nodes as SessionNode[];
    for (const node of nodes) node.binding = { companyId: 'test-tenant', agentId: `test-${node.id}`, agentName: node.title };
    expect(preflightGraph(nodes, document.edges)).toBeNull();
    const pictures = new Set(media(document).map(node => node.id));
    // What a media node delivers on the server: the record of the files it stored.
    const record = (node: SessionNode) => JSON.stringify({ type: 'awwo.media', version: 1, kind: node.agentKind, model: node.model,
      items: node.agentKind === 'model3d'
        ? [{ artifactId: 'aFIXTUREMODEL', name: 'model-1.glb', contentType: 'model/gltf-binary', size: 64 }, { artifactId: 'aFIXTUREPREVIEW', name: 'preview-1.webp', contentType: 'image/webp', size: 32 }]
        : [{ artifactId: 'aFIXTUREFILE1', name: `${node.agentKind}-1.${node.agentKind === 'video' ? 'mp4' : 'png'}`, contentType: node.agentKind === 'video' ? 'video/mp4' : 'image/png', size: 32 }] });
    const run = (fail: boolean) => {
      const completed = new Set<string>();
      const messages = new Map<string, string>();
      return { messages, summary: runGraph({ nodes, edges: document.edges, onStatus: () => {}, execAgent: async (node, message) => {
        for (const edge of document.edges.filter(edge => edge.toNode === node.id)) {
          expect(completed.has(edge.fromNode) || (fail && pictures.has(edge.fromNode))).toBe(true);
          expect(message).toContain(pictures.has(edge.fromNode) ? (fail ? '这次没有生成出' : `${edge.fromNode}/`) : `fixture-result:${edge.fromNode}`);
        }
        messages.set(node.id, message);
        if (pictures.has(node.id)) {
          if (fail) return { ok: false, output: '', detail: 'media_quota_exceeded' };
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
    if (pictures.size) {
      // The same run when no picture can be made: only the media nodes fail, and every page is still made.
      const refused = run(true);
      expect(await refused.summary).toMatchObject({ done: nodes.length - pictures.size, failed: pictures.size, blocked: 0 });
    }
    // Scheduler fixtures are test evidence only and never become case history.
    expect(nodes.every(node => node.lastOutput === undefined && (node.contract?.outputs ?? []).every(field => field.value === ''))).toBe(true);
  });
});

it('blocks downstream review and handoff when the builder fails the real HTML output contract', async () => {
  const document = createOfficialDocument(OFFICIAL_WORKFLOWS[0], 'en');
  const nodes = document.nodes as SessionNode[];
  for (const node of nodes) node.binding = { companyId: 'test', agentId: node.id, agentName: node.title };
  const builder = nodes.find(node => node.contract!.outputs[0].type === 'html')!;
  const downstream = document.edges.filter(edge => edge.fromNode === builder.id).map(edge => edge.toNode);
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
