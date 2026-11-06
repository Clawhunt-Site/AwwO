// THE CONVERGED ICON. One live icon for many components: what it draws and says must be true of its members.
// The ring has one arc per member while they can be told apart on screen, else one arc per state family; the words count
// real results (in a run: done of the run's members; at rest: how many hold a result); only live work loops, in one
// shared phase; a failure shows the moment it happens while the rest run, and is said once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createFormNode, createSessionNode, type CanvasNode } from '../src/canvas/canvasDoc';
import { ConvergedIcon, groupAccessibleState, groupStateParts, groupStateText, ringSegments, RING_TICKS_MAX, waitingReason } from '../src/canvas/ConvergedIcon';
import { groupStatus, type GroupMember, type MemberLiveState } from '../src/canvas/groupStatus';
import { canvasText } from '../src/canvas/i18n';
import type { RunView } from '../src/canvas/RunTimeline';
import { resetAllSessions } from '../src/canvas/sessions';

const zh = (key: Parameters<typeof canvasText>[1], values?: Record<string, string | number>) => canvasText('zh', key, values);
const node = (id: string, title = id): CanvasNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id, title });
const box = { id: 'canvas', x: 0, y: 0, w: 160, h: 160, members: [] as string[] };
const member = (id: string, state?: RunView['state'], extra: Partial<GroupMember> = {}): GroupMember => ({ id, run: state ? { state } : null, ...extra });

function draw(members: CanvasNode[], runs: Record<string, RunView>, props: Partial<Parameters<typeof ConvergedIcon>[0]> = {}) {
  const handlers = { onSelect: vi.fn(), onExpand: vi.fn(), onAnnounce: vi.fn() };
  const view = render(<ConvergedIcon icon={{ ...box, members: members.map(item => item.id) }} members={members} runs={runs}
    depths={new Map()} title="整个画布" scale={.75} selected={false} live {...handlers} {...props} />);
  return { ...view, ...handlers, root: () => screen.getByTestId('converged-icon-canvas') };
}

beforeEach(() => { cleanup(); resetAllSessions(); });
afterEach(() => { vi.useRealTimers(); });

describe('the ring', () => {
  it('gives each member its own arc while they fit and have room on screen, in order', () => {
    const states: MemberLiveState[] = ['done', 'running', 'failed', 'idle'];
    const segments = ringSegments(states, 120);
    expect(segments.map(segment => segment.state)).toEqual(states);
    for (let i = 1; i < segments.length; i++) expect(segments[i].from).toBeGreaterThan(segments[i - 1].to);
  });

  it('draws one arc per state family past the cap, or when the arcs would be too thin to tell apart', () => {
    const many = Array.from({ length: RING_TICKS_MAX + 1 }, (_, index): MemberLiveState => index === 0 ? 'failed' : 'done');
    const families = ringSegments(many, 1000);
    expect(families.map(segment => segment.state)).toEqual(['done', 'failed']);
    // 40 members on a 40 px icon have 2.7 px of ring each: under 3.5 px, so families.
    expect(ringSegments(Array.from({ length: 40 }, (): MemberLiveState => 'done'), 40)).toHaveLength(1);
    // One failure among many is never a hairline: at least 2.5 % of the ring.
    const failed = families.find(segment => segment.state === 'failed')!;
    expect(failed.to - failed.from).toBeGreaterThanOrEqual(.0249);
    expect(families.at(-1)!.to).toBeCloseTo(1);
  });
});

describe('the words', () => {
  it('counts a run by its own members and a canvas at rest by the results it holds', () => {
    expect(groupStateText(groupStatus([member('a', 'done'), member('b', 'running'), member('c', 'failed')]), zh)).toBe('运行中 · 1/3 · 失败 1');
    expect(groupStateText(groupStatus([member('a', 'done'), member('b', 'done')]), zh)).toBe('全部完成 · 2/2');
    expect(groupStateText(groupStatus([member('a', undefined, { delivered: true }), member('b', undefined, { delivered: true })]), zh)).toBe('2/2 有结果');
    // "No results", never "not run": after a reload a member that ran and failed holds no result either.
    expect(groupStateText(groupStatus([member('a'), member('b')]), zh)).toBe('还没有结果');
    expect(groupStateText(groupStatus([member('a', 'cached'), member('b', 'cached')]), zh)).toBe('沿用上次产出 · 2/2');
  });

  it('says what a waiting group waits for: recovery or a retry, not just a place in the queue', () => {
    expect(waitingReason({ state: 'waiting', detail: 'retrying', attempts: 2, retryLimit: 3 }, zh)).toBe(zh('tile.retrying', { attempt: 2, limit: 3 }));
    expect(waitingReason({ state: 'running', unconfirmed: true }, zh)).toBe('正在核对是否仍在运行');
    expect(waitingReason({ state: 'waiting' }, zh)).toBe('');
    const status = groupStatus([member('a', 'done'), { id: 'b', run: { state: 'running', unconfirmed: true } }]);
    expect(groupStateText(status, zh, '正在核对是否仍在运行')).toBe('正在核对是否仍在运行 · 1/2');
    expect(groupAccessibleState(status, zh, 'zh', '正在核对是否仍在运行').startsWith('正在核对是否仍在运行，')).toBe(true);
  });

  it('keeps a recovery\'s own sentence out of the row and the name, where it would cut the counts off, and gives it in the tooltip', () => {
    // A run whose stream ended before its end was known: recovery's sentence is long ("…Check workspace runs before retrying.").
    const run: RunView = { state: 'running', unconfirmed: true, detail: 'recovery_identity_missing' };
    expect(waitingReason(run, zh)).toBe('正在核对是否仍在运行');
    const members = [node('a', '调研'), node('b', '配图')];
    const { root } = draw(members, { a: { state: 'done' }, b: run });
    expect(root().textContent).toContain('正在核对是否仍在运行 · 1/2');
    const label = root().getAttribute('aria-label')!;
    expect(label).toContain('正在核对是否仍在运行，已完成 1/2');
    expect(label).not.toMatch(/。，|\.,/);
    // The sentence is the tooltip's, and the description's, beside the member it is about.
    expect(root().getAttribute('title')).toMatch(/正在核对是否仍在运行：配图（.+）/);
    const description = document.getElementById(root().getAttribute('aria-describedby')!)!.textContent!;
    expect(description).toMatch(/^按 Enter 或双击展开；正在核对是否仍在运行：配图（.+）$/);
  });

  it('gives no run fraction to a reply streaming with no run touching the group', () => {
    expect(groupStateText(groupStatus([member('a', undefined, { streaming: true }), member('b')]), zh)).toBe('运行中');
  });

  it('keeps 被阻断 apart from 失败, each in its own ink', () => {
    const parts = groupStateParts(groupStatus([member('a', 'done'), member('b', 'done'), member('c', 'blocked'), member('d', 'failed')]), zh);
    expect(parts).toEqual([{ text: '成功 2' }, { text: '失败 1', tone: 'failed' }, { text: '被阻断 1', tone: 'blocked' }]);
  });

  it('accounts for every member in the accessible name, those a run leaves out included', () => {
    // A run of four (运行所选及下游) on a canvas of six: one outside it holds an earlier result, one holds none.
    const status = groupStatus([member('a', 'done'), member('b', 'running'), member('c', 'waiting'), member('d', 'failed'), member('e'),
      member('f', undefined, { delivered: true })]);
    expect(groupAccessibleState(status, zh, 'zh')).toBe('运行中，已完成 1/4，运行中 1，等待 1，失败 1，已有结果 1，无结果 1');
    // At rest the results piece counts the earlier and the reused results already: neither is said twice.
    const rest = groupStatus([member('a', undefined, { delivered: true }), member('b')]);
    expect(groupAccessibleState(rest, zh, 'zh')).toBe('未在运行，1/2 有结果，无结果 1');
    const reusedAtRest = groupStatus([member('a', 'cached'), member('b', undefined, { delivered: true }), member('c')]);
    expect(groupAccessibleState(reusedAtRest, zh, 'zh')).toBe('未在运行，2/3 有结果，无结果 1');
    // In a run a reused member is outside its count, so it is said apart.
    const inRun = groupStatus([member('a', 'cached'), member('b', 'running')]);
    expect(groupAccessibleState(inRun, zh, 'zh')).toBe('运行中，已完成 0/1，运行中 1，沿用 1');
  });

  it('leads with words a screen reader says as they are, never a check mark', () => {
    const done = groupAccessibleState(groupStatus([member('a', 'done'), member('b', 'done')]), zh, 'zh');
    expect(done).toBe('全部完成，已完成 2/2');
    expect(groupAccessibleState(groupStatus([member('a', 'done'), member('b', 'done')]), (key, values) => canvasText('en', key, values), 'en'))
      .toBe('All done, 2 of 2 done');
    expect(done).not.toMatch(/✓/);
  });

  it('calls recovery and retries waiting in its counts, not queued', () => {
    const status = groupStatus([member('a', 'done'), { id: 'b', run: { state: 'running', unconfirmed: true } }, member('c', 'running')]);
    expect(groupAccessibleState(status, zh, 'zh')).toBe('运行中，已完成 1/3，运行中 1，等待 1');
  });
});

describe('the icon', () => {
  it('shows a running group with live work looping, a failure counted, and why in the tooltip', () => {
    const members = [node('a', '调研'), node('b', '配图'), node('c', '页面')];
    const { root } = draw(members, { a: { state: 'done' }, b: { state: 'failed', detail: '上游未完成' }, c: { state: 'running' } });
    expect(root().className).toContain('is-running');
    expect(root().getAttribute('aria-label')).toContain('失败 1');
    expect(root().getAttribute('aria-label')).toContain('正在运行：页面');
    expect(root().getAttribute('title')).toContain('配图');
    const live = root().querySelector('.awwo-converged-live') as SVGElement;
    expect(live).toBeTruthy();
    expect(Number.parseFloat(live.style.animationDelay)).toBeLessThanOrEqual(0);
    expect(root().querySelector('.awwo-converged-badge.is-failed')?.textContent).toBe('1');
    // The failed member's arc is keylined: one keyline, on that very arc.
    const keylines = root().querySelectorAll('.awwo-converged-keyline');
    expect(keylines).toHaveLength(1);
    expect(keylines[0].getAttribute('d')).toBe(root().querySelector('.awwo-converged-arc.is-failed')!.getAttribute('d'));
  });

  it('loops nothing at rest, and counts the results it holds after a reload', () => {
    const members = [node('a'), node('b')].map(item => ({ ...item, lastOutput: { text: '结果', at: 1, source: 'run' as const } }));
    const { root } = draw(members, {});
    expect(root().className).toContain('is-idle');
    expect(root().querySelector('.awwo-converged-live')).toBeNull();
    expect(root().textContent).toContain('2/2 有结果');
    expect(root().querySelector('.awwo-converged-badge')).toBeNull();
  });

  it('neither counts nor rings a form: it is an input, not a step', () => {
    const members = [node('a'), node('b'), { ...createFormNode({ x: 0, y: 0 }), id: 'f' }];
    const { root } = draw(members, {});
    expect(root().querySelectorAll('.awwo-converged-arc')).toHaveLength(2);
    expect(root().textContent).toContain('2 个组件');
  });

  it('is selected by a press and expanded by Enter, Space or a double-click', () => {
    const { root, onSelect, onExpand } = draw([node('a'), node('b')], {});
    fireEvent.pointerDown(root(), { button: 0 });
    expect(onSelect).toHaveBeenCalledWith('canvas');
    // The press's own click only selects.
    fireEvent.click(root(), { detail: 1 });
    expect(onExpand).not.toHaveBeenCalled();
    fireEvent.keyDown(root(), { key: 'Enter' });
    fireEvent.keyDown(root(), { key: ' ' });
    fireEvent.doubleClick(root());
    expect(onExpand).toHaveBeenCalledTimes(3);
    expect(root().getAttribute('role')).toBe('button');
  });

  it('expands for a screen reader\'s activation, a click with no press of a pointer before it', () => {
    const { root, onSelect, onExpand } = draw([node('a'), node('b')], {});
    // NVDA or JAWS in browse mode, VoiceOver and TalkBack send a click alone (Chromium marks it detail 0).
    fireEvent.click(root(), { detail: 0 });
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(root(), { detail: 1 });
    expect(onExpand).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('names who failed or was blocked, with the reason when there is one and only then', () => {
    const members = [node('a', '调研'), node('b', '配图'), node('c', '页面')];
    const { root } = draw(members, { a: { state: 'done' }, b: { state: 'failed' }, c: { state: 'blocked' } });
    const lines = root().getAttribute('title')!.split('\n');
    expect(lines).toContain('失败：配图');
    expect(lines).toContain('被阻断：页面');
    const description = document.getElementById(root().getAttribute('aria-describedby')!)!.textContent;
    expect(description).toBe('按 Enter 或双击展开；失败：配图；被阻断：页面');
  });

  it('pops its badge in for a new failure, the count it was drawn with again included', () => {
    const members = [node('a', '调研'), node('b', '配图')];
    const { rerender, root } = draw(members, { a: { state: 'done' }, b: { state: 'failed' } });
    const again = (runs: Record<string, RunView>) => rerender(<ConvergedIcon icon={{ ...box, members: ['a', 'b'] }} members={members} runs={runs}
      depths={new Map()} title="整个画布" scale={.75} selected={false} live onSelect={vi.fn()} onExpand={vi.fn()} onAnnounce={vi.fn()} />);
    // Drawn with a failure already: no pop, nothing new happened.
    expect(root().querySelector('.awwo-converged-badge')!.className).not.toContain('is-new');
    again({ a: { state: 'done' }, b: { state: 'running' } });
    expect(root().querySelector('.awwo-converged-badge')).toBeNull();
    again({ a: { state: 'done' }, b: { state: 'failed' } });
    expect(root().querySelector('.awwo-converged-badge')!.className).toContain('is-new');
  });

  it('says a member failing while the rest run once, and leaves the canvas settling to the run note', () => {
    vi.useFakeTimers();
    const members = [node('a', '调研'), node('b', '配图'), node('c', '页面')];
    const running = { a: { state: 'running' as const }, b: { state: 'running' as const }, c: { state: 'running' as const } };
    const { rerender, onAnnounce } = draw(members, running);
    const again = (runs: Record<string, RunView>) => rerender(<ConvergedIcon icon={{ ...box, members: ['a', 'b', 'c'] }} members={members} runs={runs}
      depths={new Map()} title="整个画布" scale={.75} selected={false} live onSelect={vi.fn()} onExpand={vi.fn()} onAnnounce={onAnnounce} />);
    again({ ...running, b: { state: 'failed' } });
    act(() => { vi.advanceTimersByTime(1499); });
    expect(onAnnounce).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onAnnounce).toHaveBeenCalledTimes(1);
    expect(onAnnounce).toHaveBeenLastCalledWith('「整个画布」里的「配图」失败了，其余组件仍在运行');
    again({ ...running, a: { state: 'failed' }, b: { state: 'failed' }, c: { state: 'failed' } });
    act(() => { vi.advanceTimersByTime(2000); });
    // The whole canvas's settling is the run note's to say: nothing more from the icon.
    expect(onAnnounce).toHaveBeenCalledTimes(1);
  });

  it('still says failures that keep coming: the window starts at the first and is never pushed back', () => {
    vi.useFakeTimers();
    const members = ['a', 'b', 'c', 'd', 'e'].map(id => node(id, `成员${id}`));
    const runs: Record<string, RunView> = Object.fromEntries(members.map(item => [item.id, { state: 'running' as const }]));
    const { rerender, onAnnounce } = draw(members, runs);
    const again = (next: Record<string, RunView>) => rerender(<ConvergedIcon icon={{ ...box, members: members.map(item => item.id) }} members={members}
      runs={next} depths={new Map()} title="整个画布" scale={.75} selected={false} live onSelect={vi.fn()} onExpand={vi.fn()} onAnnounce={onAnnounce} />);
    let now = { ...runs };
    // One more member fails every second while the others keep running.
    for (const id of ['a', 'b']) {
      now = { ...now, [id]: { state: 'failed' } };
      again(now);
      act(() => { vi.advanceTimersByTime(1000); });
    }
    // 1.5 s after the first failure (at 2.0 s now): both are said together, though the second came 1 s later.
    expect(onAnnounce).toHaveBeenCalledTimes(1);
    expect(onAnnounce).toHaveBeenLastCalledWith('「整个画布」里有 2 个组件失败了');
  });
});
