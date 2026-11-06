// A converged group's live state: what its icon shows must be true of its members. It runs while any member really runs
// or streams, is done only when every member has a result, and keeps a failure or a block visible while the rest run.
import { describe, expect, it } from 'vitest';
import { groupStatus, memberLiveState, type GroupMember } from '../src/canvas/groupStatus';
import type { RunNodeStatus } from '../src/canvas/runGraph';

const m = (id: string, state?: RunNodeStatus['state'], extra: Partial<GroupMember> & Partial<RunNodeStatus> & { startedAt?: number } = {}): GroupMember => {
  const { streaming, streamingSince, depth, delivered, ...run } = extra;
  return { id, run: state ? { state, ...run } : null, streaming, streamingSince, depth, delivered };
};

describe('one member', () => {
  it('runs while a reply streams, whatever the run map says, and waits when its end is unconfirmed', () => {
    expect(memberLiveState(null)).toBe('idle');
    expect(memberLiveState(null, true)).toBe('running');
    expect(memberLiveState({ state: 'done' }, true)).toBe('running');
    expect(memberLiveState({ state: 'running', unconfirmed: true })).toBe('waiting');
    for (const state of ['waiting', 'running', 'done', 'cached', 'failed', 'blocked', 'cancelled'] as const) {
      // A run's own news outranks an earlier result.
      expect(memberLiveState({ state }, false, true)).toBe(state);
      expect(memberLiveState({ state })).toBe(state);
    }
  });
});

describe('a converged group', () => {
  it('is idle with nothing run, and not done while any member has no result', () => {
    expect(groupStatus([m('a'), m('b')]).state).toBe('idle');
    const partly = groupStatus([m('a', 'done'), m('b')]);
    expect(partly.state).toBe('idle');
    expect(partly.settled).toBe(1);
    expect(partly.counts).toMatchObject({ total: 2, done: 1, idle: 1 });
  });

  it('is done only when every member has a result, and only reused when nothing new ran', () => {
    expect(groupStatus([m('a', 'done'), m('b', 'cached')]).state).toBe('done');
    expect(groupStatus([m('a', 'cached'), m('b', 'cached')]).state).toBe('cached');
    expect(groupStatus([m('a', 'done'), m('b', 'done')]).settled).toBe(2);
  });

  it('runs while any member runs, and still counts a failure or a block beside it', () => {
    const status = groupStatus([m('a', 'done'), m('b', 'failed'), m('c', 'running'), m('d', 'blocked'), m('e', 'waiting')]);
    expect(status.state).toBe('running');
    expect(status.counts).toMatchObject({ done: 1, failed: 1, running: 1, blocked: 1, waiting: 1 });
    expect(status.activeId).toBe('c');
  });

  it('waits while members queue and none runs', () => {
    const status = groupStatus([m('a', 'done'), m('b', 'waiting', { depth: 2 }), m('c', 'waiting', { depth: 1 })]);
    expect(status.state).toBe('waiting');
    expect(status.activeId).toBe('c');
  });

  it('keeps waiting over a failure while work is still queued: the run goes on with its independent branches', () => {
    const status = groupStatus([m('a', 'failed'), m('b', 'waiting'), m('c', 'done')]);
    expect(status.state).toBe('waiting');
    // The failure is still counted (it is the badge and a part of the words).
    expect(status.counts.failed).toBe(1);
    expect(status.failedIds).toEqual(['a']);
  });

  it('after the run: failed before blocked before cancelled, and 被阻断 is never folded into 失败', () => {
    expect(groupStatus([m('a', 'blocked'), m('b', 'failed'), m('c', 'cancelled')]).state).toBe('failed');
    const blocked = groupStatus([m('a', 'done'), m('b', 'blocked'), m('c', 'cancelled')]);
    expect(blocked.state).toBe('blocked');
    expect(blocked.counts.failed).toBe(0);
    expect(groupStatus([m('a', 'done'), m('b', 'cancelled')]).state).toBe('cancelled');
  });

  it('names a member streaming a reply first, then the deepest running one, then the one that started last', () => {
    expect(groupStatus([m('a', 'running', { depth: 3 }), m('b', 'running', { depth: 1, streaming: true })]).activeId).toBe('b');
    expect(groupStatus([m('a', 'running', { depth: 1 }), m('b', 'running', { depth: 2 })]).activeId).toBe('b');
    expect(groupStatus([m('a', 'running', { depth: 1, startedAt: 10 }), m('b', 'running', { depth: 1, startedAt: 20 })]).activeId).toBe('b');
  });

  it('names the upstream-most failure after a run, and nobody when all is well', () => {
    expect(groupStatus([m('a', 'failed', { depth: 2 }), m('b', 'failed', { depth: 0 })]).activeId).toBe('b');
    expect(groupStatus([m('a', 'done'), m('b', 'done')]).activeId).toBeNull();
  });

  it('counts a result from an earlier run when no run has news, and this run outranks it', () => {
    expect(memberLiveState(null, false, true)).toBe('delivered');
    expect(memberLiveState({ state: 'running' }, false, true)).toBe('running');
    // After a reload every member holds its result: the group is at rest (not "done": nothing ran), with 2 of 2 results.
    const before = groupStatus([m('a', undefined, { delivered: true }), m('b', undefined, { delivered: true })]);
    expect(before.state).toBe('idle');
    expect(before.settled).toBe(2);
    expect(before.counts.inRun).toBe(0);
    const mixed = groupStatus([m('a', 'done'), m('b', undefined, { delivered: true })]);
    expect(mixed.state).toBe('done');
    expect(mixed.counts.inRun).toBe(1);
    expect(groupStatus([m('a', undefined, { delivered: true }), m('b')]).state).toBe('idle');
    // Reused only when the run reused every member; inRun leaves reused members out, as the run controls count.
    const reused = groupStatus([m('a', 'cached'), m('b', 'cached')]);
    expect(reused.state).toBe('cached');
    expect(reused.counts.inRun).toBe(0);
    // One reused, one holding an earlier result: every member has one, but no run made one, so the group is at rest.
    const rest = groupStatus([m('a', 'cached'), m('b', undefined, { delivered: true })]);
    expect(rest.state).toBe('idle');
    expect(rest.settled).toBe(2);
  });

  it('between runs, a member whose result an edit cleared is not done any more; during a run, its state is trusted', () => {
    // Two members ran to done; then a persona edit cleared b's result (invalidateOutputs) and kept its run badge.
    const after = groupStatus([m('a', 'done', { delivered: true }), m('b', 'done', { delivered: false })], false);
    expect(after.state).toBe('idle');
    expect(after.counts.done).toBe(1);
    expect(memberLiveState({ state: 'cached' }, false, false, false)).toBe('idle');
    // A cloud run can report a member done before its result reaches the canvas: no flicker to "no result" then.
    expect(groupStatus([m('a', 'done'), m('b', 'done')], true).state).toBe('done');
  });

  it('lists who failed, in group order', () => {
    expect(groupStatus([m('a', 'failed'), m('b', 'running'), m('c', 'failed')]).failedIds).toEqual(['a', 'c']);
    expect(groupStatus([m('a', 'done')]).failedIds).toEqual([]);
  });

  it('dates its work from recorded times only', () => {
    expect(groupStatus([m('a', 'running', { startedAt: 300 }), m('b', 'running', { startedAt: 100 }), m('c', 'done', { startedAt: 50 })]).since).toBe(100);
    expect(groupStatus([m('a', 'running')]).since).toBeUndefined();
    expect(groupStatus([m('a', undefined, { streaming: true, streamingSince: 42 })]).since).toBe(42);
  });
});
