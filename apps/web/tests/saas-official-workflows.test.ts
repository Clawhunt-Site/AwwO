import { describe, expect, it } from 'vitest';
import { sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canConnect, reconcileEdges } from '../src/canvas/ports';
import { findCycle, preflightGraph, preflightGraphIssue, runGraph } from '../src/canvas/runGraph';
import { normalizeContract } from '../src/canvas/nodeContracts';
import { OFFICIAL_WORKFLOWS, createOfficialDocument, getOfficialWorkflow } from '../src/saas/examples/officialWorkflows';

const locales = ['zh', 'en'] as const;

it('covers all six official examples with stable identities and localized descriptions', () => {
  expect(OFFICIAL_WORKFLOWS.map(item => item.id)).toEqual([
    'interaction-page', 'orbit-game', 'spatial-studio', 'knowledge-desk', 'model-lab', 'operations-hub',
  ]);
  expect(new Set(OFFICIAL_WORKFLOWS.map(item => item.category)).size).toBe(6);
  expect(getOfficialWorkflow('untrusted-or-missing-id')).toBeUndefined();
  for (const item of OFFICIAL_WORKFLOWS) {
    expect(getOfficialWorkflow(item.id)).toBe(item);
    for (const localized of [item.title, item.summary, item.description, item.categoryLabel, item.pattern, item.brief, item.limitations, ...item.artifacts]) {
      for (const locale of locales) expect(localized[locale].trim()).not.toBe('');
    }
    expect(item.nodes.length).toBeGreaterThanOrEqual(5);
    expect(item.nodes.length).toBeLessThanOrEqual(8);
    expect(new Set(item.nodes.map(node => node.id)).size).toBe(item.nodes.length);
    for (const node of item.nodes) {
      for (const localized of [node.title, node.task, node.output, ...node.acceptance]) {
        for (const locale of locales) expect(localized[locale].trim()).not.toBe('');
      }
    }
  }
});

describe.each(OFFICIAL_WORKFLOWS)('$id executable reference', item => {
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
    expect(touched.size).toBe(document.nodes.length);
    // Each case demonstrates parallel work and a real merge, rather than six isolated prompts.
    expect(document.nodes.some(node => document.edges.filter(edge => edge.fromNode === node.id).length > 1)).toBe(true);
    expect(document.nodes.some(node => document.edges.filter(edge => edge.toNode === node.id).length > 1)).toBe(true);
    for (const node of document.nodes as SessionNode[]) {
      expect(normalizeContract(node.contract)).toEqual(node.contract);
      expect(node.contract!.inputs.find(field => field.id === 'brief')?.value).toContain(item.brief[locale]);
      for (const field of node.contract!.inputs) {
        const upstream = document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`);
        if (field.value === '') expect(upstream).toHaveLength(1);
        else expect(upstream).toHaveLength(0);
      }
    }
    expect((document.nodes as SessionNode[]).some(node => node.contract!.outputs.some(field => field.type === 'html' && field.required))).toBe(true);
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
    const second = createOfficialDocument(item, 'en');
    const firstIDs = new Set(first.nodes.map(node => node.id));
    expect(second.nodes.every(node => !firstIDs.has(node.id))).toBe(true);
    for (const node of second.nodes as SessionNode[]) {
      expect(node.binding).toBeNull(); expect(node.bindAttempt).toBeNull();
      expect(node.runtime).toBe(''); expect(node.model).toBe(''); expect(node.effort).toBe('');
      expect(node.issueId).toBeNull(); expect(node.preview).toBe('');
      expect(node.lastOutput).toBeUndefined(); expect(node.threads).toBeUndefined();
      expect(node.activeThreadId).toBeUndefined(); expect(node.agentRef).toBeUndefined();
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
    const completed = new Set<string>();
    const messages = new Map<string, string>();
    const summary = await runGraph({ nodes, edges: document.edges, onStatus: () => {}, execAgent: async (node, message) => {
      for (const edge of document.edges.filter(edge => edge.toNode === node.id)) {
        expect(completed.has(edge.fromNode)).toBe(true);
        expect(message).toContain(`fixture-result:${edge.fromNode}`);
      }
      messages.set(node.id, message);
      completed.add(node.id);
      const marker = `fixture-result:${node.id}`;
      const output = node.contract!.outputs[0].type === 'html'
        ? `<html><head><title>Test fixture</title></head><body>${marker}</body></html>` : marker;
      return { ok: true, output };
    } });
    expect(summary).toMatchObject({ ok: true, done: nodes.length, failed: 0, blocked: 0, cached: 0 });
    expect(messages.size).toBe(nodes.length);
    // Scheduler fixtures are test evidence only and never become case history.
    expect(nodes.every(node => node.lastOutput === undefined && node.contract!.outputs.every(field => field.value === ''))).toBe(true);
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
