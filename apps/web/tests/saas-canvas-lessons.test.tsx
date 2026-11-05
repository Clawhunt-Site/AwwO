// The canvas's 经验 tool (CanvasLessons.tsx): what AwwO learnt from a canvas's runs, retiring and restoring a lesson,
// applying a lesson's suggested reasoning effort on the canvas, handing its suggested model to the canvas assistant's
// box; and a run's 👍 / 👎 in the results receipt (RunRating).
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasEvolution } from '../src/canvas/CanvasSurface';
import { CanvasLessons, LessonsWorkbench, lessonEffort, lessonOfEvolution, lessonOutcome, lessonPromotable, lessonRequest, lessonSatisfied, lessonSuggests, useLessonEvolutions } from '../src/saas/CanvasLessons';
import { RunRating } from '../src/saas/RunRating';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { readCanvasLessons, type CanvasLesson } from '../src/saas/lessonsApi';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const tenant = '/api/v1/tenants/tenant-a';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Call = { url: string; method: string; body: any };
function server(routes: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return routes(call) ?? json({ error: { code: 'not_found', message: 'missing' } }, 404);
  }));
  return calls;
}
const lesson = (patch: Partial<CanvasLesson> = {}): CanvasLesson => ({ id: 'l1', canvasId: 'canvas-a', nodeId: 'page', nodeTitle: '生成页面', kind: 'output_limit',
  source: 'rule', rule: 'An earlier run of this node stopped at the model\'s output limit before it finished.', given: true, status: 'active', retiredReason: '',
  seen: 2, applied: 1, succeeded: 1, failed: 0, proposal: 'lower_effort', proposalState: 'open', scope: { runtime: 'pi', model: 'claude-opus-5-5', effort: '' },
  evidence: [{ graphId: 'g1', runId: 'r1', code: 'output_limit' }],
  lastSeenAt: '2026-10-31T01:00:00Z', lastAppliedAt: '2026-10-31T02:00:00Z', createdAt: '2026-10-30T01:00:00Z', updatedAt: '2026-10-31T02:00:00Z', ...patch });
const runs = [{ id: 'g1', status: 'failed', createdAt: '2026-10-30T01:00:00Z', endedAt: '2026-10-30T01:05:00Z', ran: 2, firstPass: 1, retried: 0, failed: 1, givenLessons: 0 },
  { id: 'g2', status: 'completed', createdAt: '2026-10-31T01:00:00Z', endedAt: '2026-10-31T01:04:00Z', ran: 2, firstPass: 2, retried: 0, failed: 0, givenLessons: 1 }];
const preferences = (children: React.ReactNode) => <SaaSPreferencesProvider>{children}</SaaSPreferencesProvider>;
const zh = (zhText: string) => zhText;

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('a lesson\'s suggestion', () => {
  it('asks the assistant for the change in the reader\'s words, and offers a model switch only after a provider failed twice', () => {
    expect(lessonRequest(lesson(), zh)).toBe('「生成页面」已经 2 次停在模型的输出上限，没有交付完。把它的推理强度调成 low，模型不变。');
    expect(lessonRequest(lesson({ proposal: 'larger_context', kind: 'context_limit' }), zh)).toContain('换成上下文更长的模型');
    expect(lessonRequest(lesson({ proposal: '' }), zh)).toBe('');
    expect(lessonSuggests(lesson())).toBe(true);
    expect(lessonSuggests(lesson({ proposalState: 'asked' }))).toBe(false);
    expect(lessonSuggests(lesson({ proposalState: 'dismissed' }))).toBe(false);
    expect(lessonSuggests(lesson({ proposal: 'other_model', kind: 'provider', given: false, seen: 1 }))).toBe(false);
    expect(lessonSuggests(lesson({ proposal: 'other_model', kind: 'provider', given: false, seen: 2 }))).toBe(true);
    expect(lessonSuggests(lesson({ proposalState: 'applied' }))).toBe(false);
  });

  it('runs its node at low for a lower effort and at medium for a higher one, the latter once its failure came twice', () => {
    expect(lessonEffort(lesson())).toBe('low');
    expect(lessonEffort(lesson({ proposal: 'raise_effort', kind: 'delivery' }))).toBe('medium');
    expect(lessonEffort(lesson({ proposal: 'larger_context', kind: 'context_limit' }))).toBe('');
    expect(lessonSuggests(lesson({ proposal: 'raise_effort', kind: 'delivery', seen: 1 }))).toBe(false);
    expect(lessonSuggests(lesson({ proposal: 'raise_effort', kind: 'delivery', seen: 2 }))).toBe(true);
    expect(lessonRequest(lesson({ proposal: 'raise_effort', kind: 'delivery', seen: 2 }), zh))
      .toBe('「生成页面」最近一次在 low 推理强度下没能完成交付（同样的问题已出现 2 次）。把它的推理强度调回 medium，模型不变。');
    // A node already at the effort, in the canvas as saved, is offered nothing; one applied is offered nothing again
    // until its failure comes back (the server opens it again), whatever the node runs at now.
    expect(lessonSatisfied(lesson({ nodeEffort: 'low' }))).toBe(true);
    expect(lessonSuggests(lesson({ nodeEffort: 'low' }))).toBe(false);
    expect(lessonSuggests(lesson({ nodeEffort: 'medium' }))).toBe(true);
    expect(lessonSuggests(lesson({ nodeEffort: '', proposalState: 'applied' }))).toBe(false);
    expect(lessonSuggests(lesson({ nodeEffort: null, proposalState: 'applied' }))).toBe(false);
    expect(lessonSuggests(lesson({ nodeEffort: 'medium', proposalState: 'dismissed' }))).toBe(false);
    // Any effort but low satisfies a higher one, the model's default ('') included.
    expect(lessonSatisfied(lesson({ proposal: 'raise_effort', kind: 'delivery', nodeEffort: '' }))).toBe(true);
    expect(lessonSuggests(lesson({ proposal: 'raise_effort', kind: 'delivery', seen: 2, nodeEffort: 'low' }))).toBe(true);
    expect(lessonSatisfied(lesson({ proposal: 'larger_context', kind: 'context_limit', nodeEffort: 'low' }))).toBeNull();
    // One written from the platform's counts says so, and asks for low.
    const tuning = lesson({ kind: 'effort_tuning', given: false, seen: 1 });
    expect(lessonRequest(tuning, zh)).toBe('在至少两个工作区的运行里，和「生成页面」同类、用同一个模型的节点，用 low 推理强度首轮完成得一样多，输出更少。把它的推理强度调成 low，模型不变。');
    expect(lessonEffort(tuning)).toBe('low');
    expect(lessonSuggests(tuning)).toBe(true);
    // A request names its lesson, whatever the lesson's id holds.
    expect(lessonOfEvolution('lesson:l:1:2:1788398979451')).toBe('l:1:2');
    expect(lessonOfEvolution('draft-1')).toBe('');
  });

  it('says how the runs given a lesson went, and what has not judged it yet', () => {
    expect(lessonOutcome(lesson({ applied: 0, succeeded: 0, failed: 0 }), zh)).toBe('还没有带着它的运行');
    expect(lessonOutcome(lesson({ applied: 2, succeeded: 2, failed: 0 }), zh)).toBe('带着它完成 2 次');
    expect(lessonOutcome(lesson({ applied: 4, succeeded: 1, failed: 3 }), zh)).toBe('带着它完成 1 次，同样的问题又出现 3 次');
    // Runs that ended in another failure a lesson could prevent: given it, but neither a success nor its failure.
    expect(lessonOutcome(lesson({ applied: 2, succeeded: 0, failed: 0 }), zh)).toBe('带着它完成 0 次，别的原因没完成 2 次');
    const en = (_zh: string, english: string) => english;
    expect(lessonOutcome(lesson({ applied: 3, succeeded: 1, failed: 1 }), en)).toBe('finished with it 1 time, the same failure came back 1 time, other failures 1 time');
  });
});

describe('the lessons workbench', () => {
  it('lists the canvas\'s lessons and runs, retires and restores one, and hands a suggestion to the assistant', async () => {
    let items = [lesson(), lesson({ id: 'l2', nodeId: 'gone', nodeTitle: '', kind: 'step_limit', proposal: '', status: 'retired', retiredReason: 'ineffective', seen: 4, applied: 3, failed: 3, succeeded: 0 })];
    const calls = server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/canvases/canvas-a/lessons`) return json({ lessons: items, runs });
      if (call.method === 'PATCH') {
        const id = call.url.split('/').pop()!;
        items = items.map(item => item.id === id ? { ...item, ...call.body, ...(call.body.status === 'retired' ? { retiredReason: 'person' } : call.body.status === 'active' ? { retiredReason: '' } : {}) } : item);
        const { nodeTitle: _drop, ...rest } = items.find(item => item.id === id)!;
        return json(rest);
      }
    });
    const drafts: { id: string; prompt: string }[] = [];
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={draft => drafts.push(draft)} onClose={() => {}} />));
    const list = await screen.findByRole('list', { name: '经验' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('生成页面')).toBeVisible();
    expect(within(rows[0]).getByText('停在输出上限')).toBeVisible();
    expect(within(rows[0]).getByText('生效中')).toBeVisible();
    expect(within(rows[1]).getByText('已不在画布上的节点')).toBeVisible();
    expect(within(rows[1]).getByText('已自动停用：一直没帮上忙')).toBeVisible();
    // The runs, counted as the lessons are judged.
    const recent = screen.getByRole('region', { name: '最近的运行' });
    expect(within(recent).getByRole('img', { name: '2 个节点里 1 个首轮完成' })).toBeVisible();
    expect(within(recent).getByText('1 个带着经验')).toBeVisible();

    fireEvent.click(within(rows[0]).getByRole('button', { name: '停用' }));
    await screen.findByText('已停用：之后的运行不再带它。');
    expect(calls.find(call => call.method === 'PATCH')).toMatchObject({ url: `${tenant}/canvas-lessons/l1`, body: { status: 'retired' } });
    const restored = within(screen.getByRole('list', { name: '经验' })).getAllByRole('listitem')[0];
    fireEvent.click(within(restored).getByRole('button', { name: '恢复' }));
    await screen.findByText('已恢复：之后的运行会带上它。');
    // One that retired itself is told its failures are counted afresh.
    const ineffective = within(screen.getByRole('list', { name: '经验' })).getAllByRole('listitem')[1];
    fireEvent.click(within(ineffective).getByRole('button', { name: '恢复' }));
    await screen.findByText('已恢复：之后的运行会带上它，没完成的次数重新算起。');

    // The suggestion goes to the assistant's box as the reader's request, and is not offered again.
    const first = within(screen.getByRole('list', { name: '经验' })).getAllByRole('listitem')[0];
    fireEvent.click(within(first).getByRole('button', { name: '交给画布助手' }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].prompt).toBe(lessonRequest(lesson(), zh));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toContainEqual({ proposalState: 'asked' }));
  });

  it('dismisses a suggestion, and offers no actions read-only', async () => {
    let items = [lesson()];
    const calls = server(call => {
      if (call.method === 'GET') return json({ lessons: items, runs: [] });
      if (call.method === 'PATCH') { items = items.map(item => ({ ...item, ...call.body })); return json(items[0]); }
    });
    const first = render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onTaskDraft={() => {}} onClose={() => {}} />));
    const row = within(await screen.findByRole('list', { name: '经验' })).getAllByRole('listitem')[0];
    fireEvent.click(within(row).getByRole('button', { name: '忽略建议' }));
    await screen.findByText('已忽略这条建议。');
    expect(calls.find(call => call.method === 'PATCH')!.body).toEqual({ proposalState: 'dismissed' });
    expect(screen.queryByRole('button', { name: '交给画布助手' })).toBeNull();
    first.unmount();
    items = [lesson()];
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" readOnly onClose={() => {}} />));
    const readOnly = within(await screen.findByRole('list', { name: '经验' })).getAllByRole('listitem')[0];
    expect(within(readOnly).queryAllByRole('button')).toHaveLength(0);
    // The suggestion is still shown, for the reader to know.
    expect(within(readOnly).getByText(lessonRequest(lesson(), zh))).toBeVisible();
  });

  it('says what an empty canvas will learn, and opens over the canvas from its bar', async () => {
    server(call => call.method === 'GET' ? json({ lessons: [], runs: [] }) : undefined);
    render(preferences(<div className="awwo-canvas-bar"><CanvasLessons tenantId="tenant-a" canvasId="canvas-a" /></div>));
    fireEvent.click(screen.getByRole('button', { name: '经验' }));
    const dialog = await screen.findByRole('dialog', { name: '经验与进化' });
    expect(await within(dialog).findByText(/还没有经验/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭经验' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('applies a suggested effort on the canvas, and hands only a suggested model to the assistant', async () => {
    const items = [lesson(), lesson({ id: 'l3', nodeId: 'search', nodeTitle: '检索', kind: 'context_limit', given: false, proposal: 'larger_context' }),
      lesson({ id: 'l4', kind: 'delivery', proposal: 'raise_effort', proposalState: 'applied', seen: 3 })];
    const calls = server(call => call.method === 'GET' ? json({ lessons: items, runs: [] }) : undefined);
    const evolutions: CanvasEvolution[] = [];
    const drafts: { id: string; prompt: string }[] = [];
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onEvolve={item => evolutions.push(item)} onTaskDraft={draft => drafts.push(draft)} onClose={() => {}} />));
    const rows = within(await screen.findByRole('list', { name: '经验' })).getAllByRole('listitem');
    expect(within(rows[0]).queryByRole('button', { name: '交给画布助手' })).toBeNull();
    fireEvent.click(within(rows[0]).getByRole('button', { name: '应用建议' }));
    expect(evolutions).toEqual([{ id: expect.stringMatching(/^lesson:l1:\d+$/), nodeId: 'page', effort: 'low', model: 'claude-opus-5-5', note: lessonRequest(lesson(), zh) }]);
    expect(lessonOfEvolution(evolutions[0].id)).toBe('l1');
    // The canvas marks it applied once its plan changed the node: the panel itself writes nothing.
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    expect(within(rows[1]).queryByRole('button', { name: '应用建议' })).toBeNull();
    fireEvent.click(within(rows[1]).getByRole('button', { name: '交给画布助手' }));
    expect(drafts.map(draft => draft.prompt)).toEqual([lessonRequest(items[1], zh)]);
    // One applied says so, and is not offered again.
    expect(within(rows[2]).getByText(/建议已应用/)).toBeVisible();
    expect(within(rows[2]).queryByRole('button', { name: '应用建议' })).toBeNull();
  });

  it('offers no effort its node already runs at, and an applied one not again until its failure comes back', async () => {
    const items = [lesson({ proposalState: 'applied', nodeEffort: 'medium' }), lesson({ id: 'l2', nodeId: 'other', nodeTitle: '另一个', nodeEffort: 'low' })];
    server(call => call.method === 'GET' ? json({ lessons: items, runs: [] }) : undefined);
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onEvolve={() => {}} onClose={() => {}} />));
    const rows = within(await screen.findByRole('list', { name: '经验' })).getAllByRole('listitem');
    expect(within(rows[0]).queryByRole('button', { name: '应用建议' })).toBeNull();
    expect(within(rows[0]).getByText(/建议已应用/)).toBeVisible();
    expect(within(rows[1]).queryByRole('button', { name: '应用建议' })).toBeNull();
    expect(within(rows[1]).queryByText(lessonRequest(items[1], zh))).toBeNull();
  });

  it('applies the efforts it is handed in turn, and marks one applied only once the cloud holds it', async () => {
    const calls = server(call => call.method === 'PATCH' ? json({ ...lesson(), proposalState: 'applied' }) : undefined);
    const { result } = renderHook(() => useLessonEvolutions('tenant-a'));
    const first = { id: 'lesson:l1:1788398979451', nodeId: 'page', effort: 'low', model: 'm', note: 'n' };
    const second = { ...first, id: 'lesson:l2:1788398979452', nodeId: 'other' };
    const third = { ...first, id: 'lesson:l3:1788398979453', nodeId: 'third', effort: 'medium' };
    const canvas = (efforts: Record<string, string>) => ({ nodes: Object.entries(efforts).map(([id, effort]) => ({ id, kind: 'session', effort })) });
    act(() => { result.current.saved(canvas({ page: 'medium', other: 'medium', third: 'medium' })); result.current.enqueue(first); result.current.enqueue(second); });
    expect(result.current.evolution?.id).toBe(first.id);
    act(() => result.current.settled(first.id, { applied: true }));
    expect(result.current.evolution?.id).toBe(second.id);
    act(() => result.current.settled(second.id, { applied: false, reason: 'busy' }));
    expect(result.current.evolution).toBeNull();
    // Not yet: the cloud still holds the node at medium.
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    // A canvas the cloud confirmed with it: marked. One never confirmed (undone, or another tab's canvas won) is not.
    act(() => result.current.saved(canvas({ page: 'low', other: 'medium', third: 'medium' })));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH').map(call => call.url)).toEqual([`${tenant}/canvas-lessons/l1`]));
    // Already so, as the cloud has it: marked at once.
    act(() => { result.current.enqueue(third); result.current.settled(third.id, { applied: false, satisfied: true }); });
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH').map(call => call.url)).toEqual([`${tenant}/canvas-lessons/l1`, `${tenant}/canvas-lessons/l3`]));
    act(() => result.current.saved(canvas({ page: 'low', other: 'low', third: 'medium' })));
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(2);
  });

  it('reads a suggestion or a state it does not know as none, and goes on showing the lesson', async () => {
    server(call => call.method === 'GET' ? json({ lessons: [{ ...lesson(), proposal: 'split_node', proposalState: 'snoozed' }], runs: [] }) : undefined);
    const view = await readCanvasLessons('tenant-a', 'canvas-a');
    expect(view.lessons[0]).toMatchObject({ proposal: '', proposalState: 'dismissed' });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onEvolve={() => {}} onTaskDraft={() => {}} onClose={() => {}} />));
    const row = within(await screen.findByRole('list', { name: '经验' })).getAllByRole('listitem')[0];
    expect(within(row).getByText('停在输出上限')).toBeVisible();
    expect(within(row).queryByRole('button', { name: '应用建议' })).toBeNull();
    expect(within(row).queryByRole('button', { name: '交给画布助手' })).toBeNull();
  });

  it('closes over the canvas once it hands a suggested effort over', async () => {
    server(call => call.method === 'GET' ? json({ lessons: [lesson()], runs: [] }) : undefined);
    const evolutions: CanvasEvolution[] = [];
    render(preferences(<div className="awwo-canvas-bar"><CanvasLessons tenantId="tenant-a" canvasId="canvas-a" onEvolve={item => evolutions.push(item)} /></div>));
    fireEvent.click(screen.getByRole('button', { name: '经验' }));
    const dialog = await screen.findByRole('dialog', { name: '经验与进化' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '应用建议' }));
    expect(evolutions).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reads the lessons of an API that returns no scope, as having none', async () => {
    const { scope: _drop, ...old } = lesson();
    server(call => call.method === 'GET' ? json({ lessons: [old], runs: [] }) : undefined);
    const view = await readCanvasLessons('tenant-a', 'canvas-a');
    expect(view.lessons[0].scope).toEqual({});
    server(call => call.method === 'GET' ? json({ lessons: [{ ...old, scope: { model: 7 } }], runs: [] }) : undefined);
    await expect(readCanvasLessons('tenant-a', 'canvas-a')).rejects.toMatchObject({ code: 'invalid_lessons_response' });
  });

  it('promotes a lesson that helped to every node of its template, and lists the workspace’s lessons', async () => {
    const proved = lesson({ id: 'l1', applied: 3, succeeded: 3, failed: 0, nodeTemplate: 'frontend', proposal: '' });
    expect(lessonPromotable(proved)).toBe(true);
    expect(lessonPromotable({ ...proved, succeeded: 2 })).toBe(false);
    expect(lessonPromotable({ ...proved, failed: 2, applied: 5 })).toBe(false);
    expect(lessonPromotable({ ...proved, nodeTemplate: '' })).toBe(false);
    expect(lessonPromotable({ ...proved, promoted: true })).toBe(false);
    expect(lessonPromotable({ ...proved, given: false })).toBe(false);
    let items = [proved, lesson({ id: 'w1', canvasId: null, nodeId: null, nodeTitle: '', source: 'person', proposal: '', scope: { templateId: 'review' } })];
    const calls = server(call => {
      if (call.method === 'GET') return json({ lessons: items, runs: [] });
      if (call.method === 'POST' && call.url === `${tenant}/canvas-lessons/l1/promote`) {
        items = [{ ...proved, promoted: true }, items[1]];
        return json(lesson({ id: 'w2', canvasId: null, nodeId: null, source: 'person', proposal: '', scope: { templateId: 'frontend' } }));
      }
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    let rows = within(await screen.findByRole('list', { name: '经验' })).getAllByRole('listitem');
    expect(within(rows[1]).getByText('工作区 · 所有「交付验收」节点')).toBeVisible();
    expect(within(rows[1]).queryByRole('button', { name: '推广到工作区' })).toBeNull();
    fireEvent.click(within(rows[0]).getByRole('button', { name: '推广到工作区' }));
    expect(await screen.findByText('已推广：工作区里的「前端开发」节点之后都会带上这条经验（自己已有同类经验的节点除外）。')).toBeVisible();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    rows = within(screen.getByRole('list', { name: '经验' })).getAllByRole('listitem');
    expect(within(rows[0]).getByText(/已推广到工作区/)).toBeVisible();
    expect(within(rows[0]).queryByRole('button', { name: '推广到工作区' })).toBeNull();
  });

  it('says to restore a workspace lesson a person retired, rather than that it now goes to every node', async () => {
    const proved = lesson({ id: 'l1', applied: 3, succeeded: 3, failed: 0, nodeTemplate: 'frontend', proposal: '' });
    server(call => {
      if (call.method === 'GET') return json({ lessons: [proved], runs: [] });
      if (call.method === 'POST') return json(lesson({ id: 'w1', canvasId: null, nodeId: null, source: 'person', proposal: '', status: 'retired', retiredReason: 'person', scope: { templateId: 'frontend' } }));
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    const row = within(await screen.findByRole('list', { name: '经验' })).getAllByRole('listitem')[0];
    fireEvent.click(within(row).getByRole('button', { name: '推广到工作区' }));
    expect(await screen.findByText('这条经验已经在工作区里，但被停用了：在下面恢复它，所有「前端开发」节点才会带上它。')).toBeVisible();
  });

  const learningChange = (id: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'merge_notes', canvasId: 'canvas-a', itemId: `n-${id}`, sources: 2,
    title: `标题 ${id}`, lessonKind: '', templateId: '', canvases: ['canvas-a'], undoneAt: null, createdAt: '2026-11-04T01:00:00Z', undoable: true, ...patch });
  const learningCycle = (id: string, patch: Record<string, unknown> = {}) => ({ id, state: 'done', reason: '', readNotes: true, counts: {},
    startedAt: '2026-11-04T01:00:00Z', finishedAt: '2026-11-04T01:01:00Z', changes: [] as ReturnType<typeof learningChange>[], ...patch });

  it('lists what the learning cycles changed of this canvas and of the whole workspace, each to take back once', async () => {
    // The latest cycle (it failed), one that changed this canvas's notes and the whole workspace's, and one that changed
    // only another canvas's, which is left out.
    let cycles = [learningCycle('c3', { state: 'failed', reason: 'worker_busy', readNotes: false, startedAt: '2026-11-05T01:00:00Z' }),
      learningCycle('c2', { changes: [learningChange('merge'), learningChange('elsewhere', { canvasId: 'canvas-b', canvases: ['canvas-b'] }),
        learningChange('promote', { kind: 'promote_note', canvasId: null, canvases: ['canvas-a', 'canvas-b'], title: '蓝色是整个工作区的主色' }),
        learningChange('lesson', { kind: 'promote_lesson', canvasId: null, canvases: ['canvas-b'], title: '', sources: 1, lessonKind: 'output_limit', templateId: 'frontend' }),
        learningChange('gone', { kind: 'archive_note', title: '', undoable: false })] }),
      learningCycle('c1', { startedAt: '2026-11-01T01:00:00Z', changes: [learningChange('other', { canvasId: 'canvas-b', canvases: ['canvas-b'] })] })];
    const calls = server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles, everyHours: 72 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
      if (call.method === 'POST' && call.url.endsWith('/undo')) {
        const id = call.url.split('/').slice(-2)[0];
        cycles = cycles.map(cycle => ({ ...cycle, changes: cycle.changes.map(item => item.id === id ? { ...item, undoneAt: '2026-11-04T02:00:00Z', undoable: false } : item) }));
        return json({ id, kind: 'merge_notes', undoneAt: '2026-11-04T02:00:00Z' });
      }
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    const section = await screen.findByRole('region', { name: '学习周期' });
    expect(within(section).getByText(/每 3 天整理一次/)).toBeVisible();
    // This canvas's changes and the whole workspace's, not another canvas's own.
    expect(within(section).getByText('把 2 条说法相同的笔记并入「标题 merge」')).toBeVisible();
    expect(within(section).queryByText(/标题 elsewhere/)).toBeNull();
    expect(within(section).getByText('提升到整个工作区：「蓝色是整个工作区的主色」（来自 2 条笔记）')).toBeVisible();
    expect(within(section).getByText('所有「前端开发」节点都带上了这条经验：停在输出上限')).toBeVisible();
    expect(within(section).getByText('归档了「一条已删除的笔记」')).toBeVisible();
    expect(within(section).getByText(/改了 4 处/)).toBeVisible();
    expect(within(section).getByText(/没有做完，稍后会再试/)).toBeVisible();
    expect(within(section).queryByText(/标题 other/)).toBeNull();
    expect(within(section).getAllByRole('listitem').filter(item => item.parentElement?.parentElement === section)).toHaveLength(2);
    const lessonsRead = calls.filter(call => call.method === 'GET' && call.url.endsWith('/lessons')).length;
    const undo = within(section).getAllByRole('button', { name: '撤销' });
    expect(undo).toHaveLength(3);
    fireEvent.click(undo[0]);
    await waitFor(() => expect(within(screen.getByRole('region', { name: '学习周期' })).getAllByText('已撤销')).toHaveLength(1));
    expect(within(screen.getByRole('region', { name: '学习周期' })).getAllByRole('button', { name: '撤销' })).toHaveLength(2);
    expect(calls.filter(call => call.method === 'POST').map(call => call.url)).toEqual([`${tenant}/learning/changes/merge/undo`]);
    // The panel's lessons are read again: the change taken back may have been one of them.
    await waitFor(() => expect(calls.filter(call => call.method === 'GET' && call.url.endsWith('/lessons')).length).toBeGreaterThan(lessonsRead));
  });

  it('says why a change cannot be taken back, lets a reader take nothing back, and shows no cycle it cannot read', async () => {
    server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles: [learningCycle('c1', { changes: [learningChange('merge')] })], everyHours: 72 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
      if (call.method === 'POST') return json({ error: { code: 'learning_change_changed', message: 'changed' } }, 409);
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    let section = await screen.findByRole('region', { name: '学习周期' });
    fireEvent.click(within(section).getByRole('button', { name: '撤销' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('这处改动之后又被改过了');
    cleanup();
    server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles: [learningCycle('c2', { reason: 'learning_off', readNotes: false, startedAt: '2026-11-05T01:00:00Z' }),
        learningCycle('c1', { changes: [learningChange('merge')] })], everyHours: 72 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" readOnly onClose={() => {}} />));
    section = await screen.findByRole('region', { name: '学习周期' });
    expect(within(section).getByText('把 2 条说法相同的笔记并入「标题 merge」')).toBeVisible();
    expect(within(section).getByText(/关闭了自动学习/)).toBeVisible();
    expect(within(section).queryByRole('button')).toBeNull();
    cleanup();
    server(call => call.method === 'GET' && call.url.endsWith('/lessons') ? json({ lessons: [], runs: [] }) : undefined);
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    expect(await screen.findByText(/还没有经验/)).toBeVisible();
    expect(screen.queryByRole('region', { name: '学习周期' })).toBeNull();
    cleanup();
    // The latest cycle changed only another canvas's notes: it says so.
    server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles: [learningCycle('c1', { changes: [learningChange('other', { canvasId: 'canvas-b', canvases: ['canvas-b'] })] })], everyHours: 72 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    section = await screen.findByRole('region', { name: '学习周期' });
    expect(within(section).getByText(/改动都在其他画布的笔记上/)).toBeVisible();
    expect(within(section).queryByText(/标题 other/)).toBeNull();
    cleanup();
    // Cycles paused: the panel says so, and what they changed can still be taken back.
    server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles: [learningCycle('c1', { changes: [learningChange('merge')] })], everyHours: 0 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    section = await screen.findByRole('region', { name: '学习周期' });
    expect(within(section).getByText(/已暂停/)).toBeVisible();
    expect(within(section).queryByText(/每 0/)).toBeNull();
    expect(within(section).getByRole('button', { name: '撤销' })).toBeEnabled();
  });

  it('says how often cycles come before any has run, and nothing where none run nor ran', async () => {
    server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles: [], everyHours: 72 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    let section = await screen.findByRole('region', { name: '学习周期' });
    expect(within(section).getByText('学习周期：AwwO 每 3 天整理一次它记下的笔记和经验')).toBeVisible();
    expect(within(section).getByText('还没有跑过学习周期。')).toBeVisible();
    cleanup();
    server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles: [learningCycle('c1', { state: 'running', finishedAt: null })], everyHours: 72 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    section = await screen.findByRole('region', { name: '学习周期' });
    expect(within(section).getByText('第一次学习周期正在进行。')).toBeVisible();
    cleanup();
    server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles: [], everyHours: 0 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    expect(await screen.findByText(/还没有经验/)).toBeVisible();
    expect(screen.queryByRole('region', { name: '学习周期' })).toBeNull();
  });

  it('reads the learning cycles again when the panel is refreshed', async () => {
    let cycles = [learningCycle('c1')];
    const calls = server(call => {
      if (call.method === 'GET' && call.url === `${tenant}/learning/cycles`) return json({ cycles, everyHours: 72 });
      if (call.method === 'GET') return json({ lessons: [], runs: [] });
    });
    render(preferences(<LessonsWorkbench tenantId="tenant-a" canvasId="canvas-a" onClose={() => {}} />));
    const section = await screen.findByRole('region', { name: '学习周期' });
    expect(within(section).getByText(/没有需要改动的/)).toBeVisible();
    const read = calls.filter(call => call.method === 'GET' && call.url === `${tenant}/learning/cycles`).length;
    cycles = [learningCycle('c2', { startedAt: '2026-11-07T01:00:00Z', changes: [learningChange('merge')] }), ...cycles];
    fireEvent.click(screen.getByRole('button', { name: '刷新经验' }));
    expect(await screen.findByText('把 2 条说法相同的笔记并入「标题 merge」')).toBeVisible();
    expect(calls.filter(call => call.method === 'GET' && call.url === `${tenant}/learning/cycles`).length).toBeGreaterThan(read);
  });

  it('names its refusals in both languages', () => {
    for (const code of ['run_not_rateable', 'invalid_lessons_response', 'learning_change_changed', 'learning_change_undone', 'invalid_learning_response']) {
      const error = new SaaSApiError(400, code, 'server text');
      expect(saasErrorMessage(error, 'zh')).not.toBe('server text');
      expect(saasErrorMessage(error, 'en')).not.toBe('server text');
    }
  });
});

describe('a run\'s rating', () => {
  it('reads the reader\'s thumbs, sets one, and takes it back on a second press', async () => {
    let rating = 0;
    const calls = server(call => {
      if (call.url !== `${tenant}/runs/run-a/rating`) return undefined;
      if (call.method === 'PUT') rating = call.body.rating;
      return json({ runId: 'run-a', rating });
    });
    render(preferences(<RunRating tenantId="tenant-a" runId="run-a" canRate />));
    const up = screen.getByRole('button', { name: '好' });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(up).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'true'));
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { rating: 1 } });
    fireEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'false'));
    expect(calls[2]).toMatchObject({ method: 'PUT', body: { rating: 0 } });
    fireEvent.click(screen.getByRole('button', { name: '不好' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '不好' })).toHaveAttribute('aria-pressed', 'true'));
  });

  // Answers that come back late are for the run and the moment they were asked for: a read older than a vote, or a
  // vote for the run shown before, changes nothing.
  it('keeps a vote over a read that comes back after it, and a vote off the next run it shows', async () => {
    const waiting: { url: string; method: string; answer: (rating: number) => void }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => new Promise<Response>(resolve => {
      waiting.push({ url: String(url), method: init.method ?? 'GET', answer: rating => resolve(json({ rating })) });
    })));
    const take = (method: string, url: string) => {
      const index = waiting.findIndex(item => item.method === method && item.url === url);
      if (index < 0) throw new Error(`no ${method} ${url} waiting: ${waiting.map(item => item.method + ' ' + item.url).join(', ')}`);
      return waiting.splice(index, 1)[0];
    };
    const { rerender } = render(preferences(<RunRating tenantId="tenant-a" runId="run-a" canRate />));
    const read = take('GET', `${tenant}/runs/run-a/rating`);
    fireEvent.click(screen.getByRole('button', { name: '好' }));
    await act(async () => take('PUT', `${tenant}/runs/run-a/rating`).answer(1));
    expect(screen.getByRole('button', { name: '好' })).toHaveAttribute('aria-pressed', 'true');
    // The read asked before the vote comes back with what was stored then.
    await act(async () => read.answer(-1));
    expect(screen.getByRole('button', { name: '好' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '不好' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: '不好' }));
    const vote = take('PUT', `${tenant}/runs/run-a/rating`);
    rerender(preferences(<RunRating tenantId="tenant-a" runId="run-b" canRate />));
    await act(async () => take('GET', `${tenant}/runs/run-b/rating`).answer(0));
    await act(async () => vote.answer(-1));
    expect(screen.getByRole('button', { name: '不好' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '好' })).not.toBeDisabled();
  });

  it('says when a rating cannot be read, and still takes a vote', async () => {
    let failRead = true;
    const calls = server(call => {
      if (call.method === 'GET' && failRead) return json({ error: { code: 'internal_error', message: 'down' } }, 500);
      return json({ runId: 'run-a', rating: call.body?.rating ?? 0 });
    });
    render(preferences(<RunRating tenantId="tenant-a" runId="run-a" canRate />));
    expect(await screen.findByRole('alert')).toBeVisible();
    failRead = false;
    fireEvent.click(screen.getByRole('button', { name: '好' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '好' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  });

  it('shows a reader the rating without letting them change it', async () => {
    const calls = server(() => json({ runId: 'run-a', rating: -1 }));
    render(preferences(<RunRating tenantId="tenant-a" runId="run-a" canRate={false} />));
    await waitFor(() => expect(screen.getByRole('button', { name: '不好' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: '好' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '好' }));
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
});
