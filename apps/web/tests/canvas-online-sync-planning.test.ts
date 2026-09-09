import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDocument } from '../src/canvas/canvasDoc';
import { AGENT_TEMPLATES, createAgentTemplate } from '../src/canvas/agentTemplates';
import { buildPlanningContext, requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { CANVAS_PLAN_PROTOCOL, type CanvasPlanOperation } from '../src/canvas/canvasPlan';
import { canvasFetch, clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

vi.mock('../src/saas/canvasBridge', async importOriginal => ({
  ...await importOriginal<typeof import('../src/saas/canvasBridge')>(), canvasFetch: vi.fn(),
}));
const tenant = { id: 'tenant', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } as const;
const activate = () => configureSaaSCanvas({ tenant, canvasId: 'canvas' });
const proposal = (operation: CanvasPlanOperation) => ({ version: 1, summary: 'Update structure', operations: [operation] });
const reply = (operation: CanvasPlanOperation) => vi.mocked(canvasFetch).mockResolvedValue(new Response(JSON.stringify({ plan: proposal(operation) })));
afterEach(() => { clearSaaSCanvas(); vi.resetAllMocks(); });

describe('planner host capability boundary after online integration', () => {
  it('advertises the native Review/HTML protocol and only Go-supported SaaS operations', () => {
    expect(buildPlanningContext(emptyDocument(), [])).toContain(CANVAS_PLAN_PROTOCOL);
    activate();
    const context = buildPlanningContext(emptyDocument(), [], 'en');
    const protocol = context.split('\n\n')[0];
    expect(protocol).toContain('add_field:');
    expect(protocol).toContain('connect:');
    expect(protocol).not.toMatch(/set_execution|set_edge_kind|kind\?:|"html"|reviewerNodeId/);
    expect(context).toContain('Do not create review policies, feedback connections or HTML fields');
    const doc = { ...emptyDocument(), nodes: AGENT_TEMPLATES.map((template, index) => createAgentTemplate(template.id, { x: index * 400, y: 0 })) };
    expect(new TextEncoder().encode(buildPlanningContext(doc, [])).length).toBeLessThan(16_000);
  });

  const unsupported: CanvasPlanOperation[] = [
    { type: 'set_execution', mode: 'review', maxRounds: 3, reviewerNodeId: 'reviewer', verdictFieldId: 'approved' },
    { type: 'set_edge_kind', edgeId: 'edge', kind: 'feedback' },
    { type: 'connect', fromNode: 'a', fromField: 'result', toNode: 'b', toField: 'context', kind: 'feedback' },
    { type: 'connect', fromNode: 'a', fromField: 'result', toNode: 'b', toField: 'context', kind: 'data' },
    { type: 'add_field', nodeId: 'a', side: 'output', field: { id: 'page', label: 'Page', type: 'html', required: true, value: '' } },
    { type: 'update_field', nodeId: 'a', side: 'output', fieldId: 'page', changes: { type: 'html' } },
  ];
  it.each(unsupported)('rejects unsupported SaaS output $type without changing the canvas, while native preserves it', async operation => {
    const doc = emptyDocument(); const original = structuredClone(doc);
    activate(); reply(operation);
    await expect(requestCanvasPlan('Plan', doc, [], new AbortController().signal)).rejects.toThrow('画布未改变');
    expect(doc).toEqual(original);
    clearSaaSCanvas(); reply(operation);
    await expect(requestCanvasPlan('Plan', doc, [], new AbortController().signal)).resolves.toEqual(proposal(operation));
  });

  it('keeps the ordinary SaaS connect contract free of native kind metadata', async () => {
    activate();
    const operation: CanvasPlanOperation = { type: 'connect', fromNode: 'a', fromField: 'result', toNode: 'b', toField: 'context' };
    reply(operation);
    await expect(requestCanvasPlan('Connect', emptyDocument(), [], new AbortController().signal)).resolves.toEqual(proposal(operation));
  });

  it('uses the requesting host capability even if the workspace closes while a response is pending', async () => {
    activate(); let resolve!: (response: Response) => void;
    vi.mocked(canvasFetch).mockReturnValue(new Promise(resolveResponse => { resolve = resolveResponse; }));
    const pending = requestCanvasPlan('Plan', emptyDocument(), [], new AbortController().signal, 'en');
    clearSaaSCanvas();
    resolve(new Response(JSON.stringify({ plan: proposal(unsupported[0]) })));
    await expect(pending).rejects.toThrow('the canvas was not changed');
  });
});
