import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleInputViews, assembleTemplate, templateIssues, templateSlots, unfenceAssembleValue } from '../src/canvas/assembleNode';
import { createAssembleNode, createFormNode, sanitizeDocument, type AssembleNode, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { portsFor, reconcileEdges } from '../src/canvas/ports';
import { runGraph, type RunNodeStatus } from '../src/canvas/runGraph';
import { createOfficialDocument, type OfficialWorkflow } from '../src/saas/examples/officialWorkflows';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';

type Vector = { name: string; template: string; values: Record<string, string>; output?: string; error?: string };
const vectors: Vector[] = JSON.parse(readFileSync(resolve(process.cwd(), '../../backend/internal/app/testdata/assemble_vectors.json'), 'utf8')).vectors;

describe('assemble node template filling (shared with the API)', () => {
  it('reads the shared vectors', () => expect(vectors.length).toBeGreaterThanOrEqual(10));
  for (const vector of vectors) {
    it(vector.name, () => {
      const result = assembleTemplate(vector.template, vector.values);
      if (vector.error) expect(result).toEqual({ ok: false, error: vector.error });
      else expect(result).toEqual({ ok: true, text: vector.output });
    });
  }

  it('lists the slots a template names and the problems the API refuses', () => {
    expect(templateSlots('{{in:a}}{{in:b}}{{in:a}}')).toEqual(['a', 'b']);
    expect(templateIssues('{{in:a}}{{in:c}}', ['a', 'b'])).toEqual(['Template slot {{in:c}} names no input']);
    expect(templateIssues('   ', [])).toHaveLength(1);
    expect(templateIssues('x'.repeat(64 * 1024 + 1), [])).toHaveLength(1);
    expect(unfenceAssembleValue('```\nplain\n```')).toBe('plain');
  });
});

const page = (id: string, inputs: string[], outputs: AssembleNode['contract']['outputs'] = [{ id: 'result', label: 'Page', type: 'html', required: true, value: '' }]): AssembleNode => ({
  ...createAssembleNode({ x: 400, y: 0 }, 'en'), id, title: 'Page',
  template: `<!DOCTYPE html><html><head></head><body><script>${inputs.map(input => `{{in:${input}}}`).join('\n')}</script></body></html>`,
  contract: { version: 1, inputs: inputs.map(input => ({ id: input, label: input, type: 'text' as const, required: true, value: '' })), outputs },
});

describe('assemble node on the canvas', () => {
  it('survives a save and reload, and a damaged one is never read as some other node', () => {
    const node = { ...page('p', ['a']), fileName: 'game.html' };
    const doc = sanitizeDocument(JSON.parse(JSON.stringify({ version: 2, nodes: [node], edges: [] })));
    expect(doc.nodes[0]).toMatchObject({ kind: 'assemble', template: node.template, fileName: 'game.html', contract: node.contract });
    const broken = sanitizeDocument({ version: 2, nodes: [{ ...node, contract: { version: 9, inputs: [], outputs: [] } }], edges: [] });
    expect(broken.nodes).toHaveLength(0);
  });

  it('exposes its slots as inputs and its page and file as outputs', () => {
    const node = page('p', ['a', 'b'], [
      { id: 'result', label: 'Page', type: 'html', required: true, value: '' },
      { id: 'file', label: 'Page file', type: 'file', required: true, value: '' },
    ]);
    expect(portsFor(node).map(port => `${port.side}:${port.id}:${port.dataType}`))
      .toEqual(['input:in:a:text', 'input:in:b:text', 'output:out:result:text', 'output:out:file:file']);
  });

  it('assembles on this device without calling any agent, and hands the page downstream', async () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'f', fields: [{ id: 'x', label: 'Code', value: 'boot()' }] };
    const node = page('p', ['a']);
    const edges = reconcileEdges([form, node], [{ id: 'e', fromNode: 'f', fromPort: 'data', toNode: 'p', toPort: 'in:a', dataType: 'text' }]);
    const statuses: Record<string, RunNodeStatus> = {};
    const calls: string[] = [];
    const summary = await runGraph({ nodes: [form, node], edges, onStatus: (id, status) => { statuses[id] = status; },
      execAgent: async (n: SessionNode) => { calls.push(n.id); return { ok: true, output: '', detail: '' }; } });
    expect(calls).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(statuses.p).toEqual({ state: 'done', output: '<!DOCTYPE html><html><head></head><body><script>Code: boot()</script></body></html>' });
  });

  it('refuses a file output on this device, where nothing stores files', async () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'f' };
    const node = page('p', ['a'], [{ id: 'file', label: 'File', type: 'file', required: true, value: '' }]);
    const edges = reconcileEdges([form, node], [{ id: 'e', fromNode: 'f', fromPort: 'data', toNode: 'p', toPort: 'in:a', dataType: 'text' }]);
    const statuses: Record<string, RunNodeStatus> = {};
    await runGraph({ nodes: [form, node], edges, onStatus: (id, status) => { statuses[id] = status; },
      execAgent: async () => ({ ok: true, output: '', detail: '' }) });
    expect(statuses.p.state).toBe('failed');
  });

  it('says where each slot reads from and how much it holds', () => {
    const upstream = { id: 'm', kind: 'session', title: 'Engine', contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: 'Code', type: 'markdown', required: true, value: '' }] },
      lastOutput: { text: '```js\nconst E=1;\n```', at: 1, source: 'run' } } as unknown as CanvasNode;
    const node = { ...page('p', ['a', 'b']), template: '{{in:a}}' };
    const views = assembleInputViews(node, [upstream, node], [{ id: 'e', fromNode: 'm', fromPort: 'out:result', toNode: 'p', toPort: 'in:a', dataType: 'text' }]);
    expect(views).toEqual([
      { id: 'a', label: 'a', required: true, source: 'Engine', bytes: 'const E=1;'.length, used: true },
      { id: 'b', label: 'b', required: true, source: null, bytes: 0, used: false },
    ]);
  });
});

describe('assemble node in a case canvas', () => {
  const workflow: OfficialWorkflow = {
    id: 'assembled', title: 'Assembled', brief: 'Build it.',
    nodes: [
      { id: 'engine', title: 'Engine', role: 'frontend', task: 'Write the engine.', output: 'Engine code', acceptance: ['Runs.'], column: 0, row: 0 },
      { id: 'page', title: 'Page', role: 'general', task: 'AwwO puts the modules into one page.', output: 'Page', outputType: 'html', acceptance: ['Complete document.'], column: 1, row: 0,
        assemble: { template: '<!DOCTYPE html><html><head></head><body><script>{{in:from_engine}}</script></body></html>', file: true, fileName: 'app.html' } },
    ],
    edges: [{ from: 'engine', to: 'page', label: 'Engine code' }],
  };

  it('becomes an assemble node fed by the wire, and its template is part of the pinned canvas text', () => {
    const doc = createOfficialDocument(workflow);
    const node = doc.nodes[1];
    expect(node.kind).toBe('assemble');
    if (node.kind !== 'assemble') return;
    expect(node.contract.inputs.map(field => field.id)).toEqual(['from_engine']);
    expect(node.contract.outputs.map(field => `${field.id}:${field.type}`)).toEqual(['result:html', 'file:file']);
    expect(node.fileName).toBe('app.html');
    expect(doc.edges.map(edge => `${edge.fromPort}>${edge.toPort}`)).toEqual(['out:result>in:from_engine']);
    const text = canonicalCanvasText(doc);
    expect(text).toContain('{{in:from_engine}}');
    const changed = createOfficialDocument({ ...workflow, nodes: [workflow.nodes[0], { ...workflow.nodes[1], assemble: { ...workflow.nodes[1].assemble!, template: '<!DOCTYPE html><html><head></head><body></body></html>' } }] });
    expect(canonicalCanvasText(changed)).not.toBe(text);
  });
});
