// The canvas's 经验 tool (CanvasLessons.tsx): what AwwO learnt from a canvas's runs, retiring and restoring a lesson,
// handing a lesson's suggestion to the canvas assistant's box; and a run's 👍 / 👎 in the results receipt (RunRating).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasLessons, LessonsWorkbench, lessonOutcome, lessonRequest, lessonSuggests } from '../src/saas/CanvasLessons';
import { RunRating } from '../src/saas/RunRating';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import type { CanvasLesson } from '../src/saas/lessonsApi';
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
  seen: 2, applied: 1, succeeded: 1, failed: 0, proposal: 'lower_effort', proposalState: 'open', evidence: [{ graphId: 'g1', runId: 'r1', code: 'output_limit' }],
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

  it('names its refusals in both languages', () => {
    for (const code of ['run_not_rateable', 'invalid_lessons_response']) {
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
