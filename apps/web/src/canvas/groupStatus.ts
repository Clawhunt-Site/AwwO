// What a converged group of components is doing right now: one state for its icon, real counts for its ring and badges,
// and which member to name in its live line. Pure (no React, no DOM), like wireState.ts.
//
// Honest by construction: the group runs while any member really runs or streams; it is done only when EVERY member has
// a result; a failed or blocked member is counted while its siblings still run (a run keeps independent branches
// going), and 被阻断 (never ran: an upstream did not finish) is never folded into 失败. Between runs (after a reload, the
// live run map is empty) a member's earlier result still counts, as the results view counts it: it is "delivered".
import type { RunNodeStatus } from './runGraph';

export type MemberLiveState = 'running' | 'waiting' | 'done' | 'cached' | 'delivered' | 'failed' | 'blocked' | 'cancelled' | 'idle';
export type GroupState = MemberLiveState;

export interface GroupMember {
  id: string;
  run?: (RunNodeStatus & { startedAt?: number }) | null;
  /** A reply streaming into the member's conversation (the sessions store). */
  streaming?: boolean;
  streamingSince?: number;
  /** The member's step in the graph (nodeDepths): the deepest running member is the run's frontier. */
  depth?: number;
  /** The member holds a result from an earlier run (nextSteps hasDeliveredResult): what it shows when no run has news. */
  delivered?: boolean;
}

export type GroupCounts = Record<MemberLiveState, number> & { total: number; inRun: number };

export interface GroupStatus {
  state: GroupState;
  counts: GroupCounts;
  /** The member the live line names: one streaming a reply first, then the run's frontier. Null when nothing runs and
   *  nothing failed or was blocked. */
  activeId: string | null;
  /** When the group's current work began, from recorded times only (absent rather than guessed). */
  since?: number;
  /** Members with a result (done, reused, or delivered earlier), for the ring's k of n. */
  settled: number;
  /** The members that failed, in group order (what is said when one fails while the rest still run). */
  failedIds: ReadonlyArray<string>;
}

/** One member's state: a streaming reply is running whatever the run map says; an unconfirmed end waits for recovery;
 *  with no news from a run, an earlier result shows as delivered. Between runs (`live` false) a member the last run
 *  finished but whose result an edit has since cleared (invalidateOutputs) holds no result: it is not done any more. While
 *  a run goes on, its states are trusted (a cloud run can report a member done before its result reaches the canvas). */
export function memberLiveState(run: RunNodeStatus | null | undefined, streaming = false, delivered = false, live = true): MemberLiveState {
  if (streaming) return 'running';
  if (!run) return delivered ? 'delivered' : 'idle';
  // The transport ended without proof the execution ended: recovery still owns it, so it waits rather than runs.
  if (run.unconfirmed && run.state === 'running') return 'waiting';
  if (!live && !delivered && (run.state === 'done' || run.state === 'cached')) return 'idle';
  return run.state;
}

const ORDER_WHILE_ACTIVE: ReadonlyArray<MemberLiveState> = ['running', 'waiting'];
const ORDER_SETTLED: ReadonlyArray<MemberLiveState> = ['failed', 'blocked', 'cancelled'];

/** `live`: whether a run is going on the canvas (see memberLiveState). */
export function groupStatus(members: ReadonlyArray<GroupMember>, live = true): GroupStatus {
  const counts: GroupCounts = { total: members.length, inRun: 0, running: 0, waiting: 0, done: 0, cached: 0, delivered: 0, failed: 0, blocked: 0, cancelled: 0, idle: 0 };
  const states = members.map(member => memberLiveState(member.run, member.streaming, member.delivered, live));
  states.forEach(state => { counts[state] += 1; });
  counts.inRun = members.filter(member => member.run && member.run.state !== 'cached').length;
  const settled = counts.done + counts.cached + counts.delivered;
  const state = ORDER_WHILE_ACTIVE.find(item => counts[item] > 0)
    ?? ORDER_SETTLED.find(item => counts[item] > 0)
    ?? (members.length > 0 && settled === members.length ? allSettled(counts) : 'idle');
  const failedIds = members.filter((_, index) => states[index] === 'failed').map(member => member.id);
  return { state, counts, activeId: activeMember(members, states, state), since: sinceOf(members, states), settled, failedIds };
}

/** Every member has a result: done when this run made at least one; reused when the run only reused them; otherwise (a
 *  reload, results from earlier runs) the group is at rest, and its ring and its words say how many results it holds. */
function allSettled(counts: GroupCounts): GroupState {
  if (counts.done > 0) return 'done';
  return counts.cached === counts.total ? 'cached' : 'idle';
}

function activeMember(members: ReadonlyArray<GroupMember>, states: ReadonlyArray<MemberLiveState>, state: GroupState): string | null {
  const indexed = members.map((member, index) => ({ member, state: states[index], index }));
  if (state === 'running') {
    const streaming = indexed.filter(item => item.member.streaming);
    const pool = streaming.length ? streaming : indexed.filter(item => item.state === 'running');
    // The frontier: the deepest running member; among equals the one that started last, then the first in the group.
    pool.sort((a, b) => (b.member.depth ?? 0) - (a.member.depth ?? 0)
      || (b.member.run?.startedAt ?? b.member.streamingSince ?? 0) - (a.member.run?.startedAt ?? a.member.streamingSince ?? 0)
      || a.index - b.index);
    return pool[0]?.member.id ?? null;
  }
  if (state === 'waiting' || state === 'failed' || state === 'blocked') {
    // The first one in graph order: the upstream-most failure explains the ones below it.
    const pool = indexed.filter(item => item.state === state)
      .sort((a, b) => (a.member.depth ?? 0) - (b.member.depth ?? 0) || a.index - b.index);
    return pool[0]?.member.id ?? null;
  }
  return null;
}

function sinceOf(members: ReadonlyArray<GroupMember>, states: ReadonlyArray<MemberLiveState>): number | undefined {
  let since: number | undefined;
  members.forEach((member, index) => {
    if (states[index] !== 'running') return;
    const at = member.streaming ? member.streamingSince ?? member.run?.startedAt : member.run?.startedAt;
    if (typeof at === 'number' && Number.isFinite(at) && (since === undefined || at < since)) since = at;
  });
  return since;
}
