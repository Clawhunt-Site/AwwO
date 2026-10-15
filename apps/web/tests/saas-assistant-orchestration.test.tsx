import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createSessionNode, emptyDocument, saveDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasText } from '../src/canvas/i18n';
import { nextSteps, runRequestKind } from '../src/canvas/nextSteps';
import { describePlanChanges } from '../src/canvas/planChanges';
import { updateNodeDraft } from '../src/canvas/nodeThreads';
import { resetAllSessions } from '../src/canvas/sessions';

// The canvas assistant does what developer mode was opened for in the case tutorials (owner request 2026-10-15): it
// says what it changed, fixes a failure or fills in inputs when asked from the 接下来 card, and runs the canvas when told.
const agent = (id: string, extra: Partial<SessionNode> = {}): SessionNode => ({ ...createAgentTemplate('general', { x: 0, y: 0 }, 'zh'), id, title: id, ...extra });
const doc = (...nodes: CanvasDocument['nodes']): CanvasDocument => ({ ...emptyDocument(), nodes });
const zh = (key: Parameters<typeof canvasText>[1], values?: Record<string, string | number>) => canvasText('zh', key, values);
const base = { edges: [], running: false, canRun: true, resultsAvailable: true, upgradeAvailable: false, isPremiumRefusal: () => false };

describe('next steps the assistant can take itself', () => {
  it('offers to adjust the canvas after running a failed node again, only while it can plan', () => {
    const failed = { nodes: [agent('a', { lastOutput: null })], runs: { a: { state: 'failed' as const, detail: 'output_limit' } } };
    expect(nextSteps({ ...base, ...failed, canPlan: true })?.steps.map(step => step.kind)).toEqual(['open-failed', 'rerun-failed', 'assistant-fix']);
    expect(nextSteps({ ...base, ...failed, canPlan: true })?.steps[2]).toEqual({ kind: 'assistant-fix', nodeIds: ['a'] });
    expect(nextSteps({ ...base, ...failed })?.steps.map(step => step.kind)).toEqual(['open-failed', 'rerun-failed']);
  });

  it('offers to fill in every missing input after the nodes that need them', () => {
    const input = { nodes: [agent('a'), agent('b')], runs: {} };
    const steps = nextSteps({ ...base, ...input, canPlan: true })!.steps;
    expect(steps.map(step => step.kind)).toEqual(['fill-inputs', 'fill-inputs', 'assistant-fill']);
    expect(steps[2]).toEqual({ kind: 'assistant-fill', nodeIds: ['a', 'b'] });
    expect(nextSteps({ ...base, ...input })!.steps.map(step => step.kind)).toEqual(['fill-inputs', 'fill-inputs']);
  });
});

describe('a message that only asks to run the canvas', () => {
  it.each([
    ['运行', 'all'], ['开始运行吧', 'all'], ['请帮我运行一下', 'all'], ['跑一下', 'all'], ['运行画布。', 'all'], ['重新运行', 'all'],
    ['继续运行', 'rest'], ['运行剩下的节点', 'rest'], ['Run it', 'all'], ['please run the canvas', 'all'], ['run the rest', 'rest'], ['Go!', 'all'],
  ])('reads “%s” as %s', (text, kind) => {
    expect(runRequestKind(text)).toBe(kind);
  });

  it.each(['运行后告诉我效果', '把前端改成 React 再运行', '为什么运行失败', '运行一个新的节点', 'run a new research step', 'how do I run it', '', '运行'.repeat(20)])(
    'leaves “%s” to the assistant', text => {
      expect(runRequestKind(text)).toBeNull();
    });
});

describe('what a plan changed, said under its reply', () => {
  const name = (id: string) => id === 'bedrock.claude-opus-5-5' ? 'Claude Opus 5.5' : id;
  const t = (key: Parameters<typeof canvasText>[1], values?: Record<string, string | number>) => canvasText('zh', key, values);

  it('names every kind of change by node', () => {
    const page = agent('页面', { taskFrame: { version: 1, source: 'manual', constraints: ['做一个页面'], acceptanceCriteria: [] } });
    const layout = agent('布局');
    const gone = agent('旧节点');
    const image = updateNodeDraft({ ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: '封面' }, 'a red car');
    const before = { ...doc(page, layout, gone, image), edges: [{ id: 'e1', fromNode: '布局', fromPort: 'out:result', toNode: '页面', toPort: 'in:brief', dataType: 'text' as const }] };
    const after: CanvasDocument = { ...before,
      nodes: [
        { ...page, persona: '只交付一个 HTML 页面', model: 'bedrock.claude-opus-5-5', effort: 'high',
          taskFrame: { version: 1, source: 'manual', constraints: ['做一个页面', '不联网'], acceptanceCriteria: ['页面能打开'] } },
        { ...layout, title: '关卡布局', contract: { ...layout.contract!, inputs: layout.contract!.inputs.map(field => ({ ...field, value: '三关' })) } },
        updateNodeDraft(image, 'a blue car'),
        agent('评审'),
      ],
      edges: [{ id: 'e2', fromNode: '评审', fromPort: 'out:result', toNode: '页面', toPort: 'in:brief', dataType: 'text' as const }] };
    expect(describePlanChanges(before, after, 'zh', t, name)).toEqual([
      zh('planning.changeAdded', { count: 1, names: '「评审」' }),
      zh('planning.changeRemoved', { names: '「旧节点」' }),
      zh('planning.changeRenamed', { from: '布局', to: '关卡布局' }),
      zh('planning.changePersona', { names: '「页面」' }),
      zh('planning.changeAcceptance', { names: '「页面」' }),
      zh('planning.changeConstraints', { names: '「页面」' }),
      zh('planning.changeInputs', { names: '「关卡布局」' }),
      // One line short of everything: the prompt and the model are said as more changes, the wires after them.
      zh('planning.changeMoreLines', { count: 4 }),
    ]);
  });

  it('says a model change with its effort, a return to the default, and the wires a plan made or broke', () => {
    const a = agent('a', { model: 'qwen' }); const b = agent('b', { model: 'bedrock.claude-opus-5-5', effort: 'high' });
    const before = { ...doc(a, b), edges: [{ id: 'x', fromNode: 'a', fromPort: 'out:result', toNode: 'b', toPort: 'in:brief', dataType: 'text' as const }] };
    const after = { ...doc({ ...a, model: 'bedrock.claude-opus-5-5', effort: 'high' }, { ...b, model: '', effort: '' }),
      edges: [{ id: 'y', fromNode: 'b', fromPort: 'out:result', toNode: 'a', toPort: 'in:brief', dataType: 'text' as const }] };
    expect(describePlanChanges(before, after, 'en', (key, values) => canvasText('en', key, values), name)).toEqual([
      '“a” now runs Claude Opus 5.5 (High reasoning)', '“b” now runs the workspace default model', 'Connected 1 wire(s)', 'Disconnected 1 wire(s)',
    ]);
    // A runtime the canvas moved a node to is not a change the reader made or needs to read about.
    expect(describePlanChanges(doc(a), doc({ ...a, runtime: 'openai-agents' }), 'en', (key, values) => canvasText('en', key, values), name)).toEqual([]);
  });
});

// On the canvas: 「运行」 runs it without asking the planner, and the 接下来 card's assistant steps send the assistant a
// request the reader can see.
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).getByRole('button', { name: '画布助手', exact: true });
const sidebar = () => within(document.querySelector('.awwo-planner-sidebar') as HTMLElement);
function seed(brief: string) {
  const node = { ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' } as SessionNode;
  const contract = node.contract!;
  saveDocument({ ...emptyDocument(), nodes: [{ ...node, contract: { ...contract, inputs: contract.inputs.map(field => field.id === 'brief' ? { ...field, value: brief } : field) } }], view: { x: 0, y: 0, scale: 1 } });
}

describe('the assistant on the canvas', () => {
  beforeEach(() => {
    cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const originalRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('canvas-root')
        ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
        : originalRect.call(this);
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
  });

  it('runs the canvas when told to, without a planner call, and leaves a request to change it to the planner', async () => {
    seed('为二年级学生设计游戏化学习知识库');
    const planRequest = vi.fn(async () => ({ version: 1 as const, summary: '改好了', operations: [] }));
    render(<CanvasSurface planRequest={planRequest} />);
    fireEvent.click(toggle());
    const box = sidebar().getByRole('textbox', { name: '画布需求' });
    fireEvent.change(box, { target: { value: '运行吧' } });
    fireEvent.click(sidebar().getByRole('button', { name: '修改画布' }));
    const log = within(sidebar().getByRole('log', { name: '画布对话' }));
    await waitFor(() => expect(log.getByText(zh('assistant.runStarting'))).toBeVisible());
    expect(box).toHaveValue('');
    expect(planRequest).not.toHaveBeenCalled();
    // Nothing is posted to a planner (the only reads are the planner's status and the like).
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => /\/canvas\/plan$/.test(String(url)) && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    // A request to change the canvas first still goes to the planner.
    fireEvent.change(box, { target: { value: '把前端改成 React 再运行' } });
    fireEvent.click(sidebar().getByRole('button', { name: '修改画布' }));
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
  });

  it('asks the planner to fill in what a run still needs, in a message the reader sees', async () => {
    seed('');
    const planRequest = vi.fn(async () => ({ version: 1 as const, summary: '已填写', operations: [] }));
    // The planner is reachable: its status read answers as available.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => String(url).includes('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'test' }) } : { ok: false, status: 503, json: async () => ({}) }));
    render(<CanvasSurface planRequest={planRequest} />);
    fireEvent.click(toggle());
    const next = within(sidebar().getByRole('group', { name: '接下来' }));
    fireEvent.click(await next.findByRole('button', { name: zh('assistant.nextAssistantFill') }));
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    const [prompt] = (planRequest.mock.calls as unknown as unknown[][])[0] as [string];
    expect(prompt).toBe(zh('assistant.fillRequest', { rows: zh('assistant.fillRequestRow', { node: '已有节点', fields: '任务要求' }) }));
    expect(within(sidebar().getByRole('log', { name: '画布对话' })).getByText(prompt)).toBeVisible();
  });
});
