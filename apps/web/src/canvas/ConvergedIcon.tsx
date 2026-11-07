// One live icon for components drawn converged (收敛): the group as one bot avatar. Its head is flat, in the AwwO orb's
// colour, with two eyes whose expression is what the group is doing (avatarFace.ts) and a light at the chin, on a dark
// collar that carries a ring of its members. Each member is one arc of the ring, in pipeline order, in its own run state
// (one arc per state when there are too many to tell apart); the eyes look at the arc of the member the icon names now;
// the face and the card skin's ring say what the group is doing now, and the rows under it name it and count it. It wears
// the card's own skin (canvas-tile awwo-node is-<state>, as a 预览展示 window does), so every theme and both editions draw
// its states as they draw a card's.
//
// Honest by construction (groupStatus.ts): only live work loops (the running arcs breathe, and a working face blinks);
// the eyes move only to what the state names, or to a failure seen happen while the rest run; the ring counts real
// results and never fills on arrival; done means every member has a result; a failure or a block shows the moment it
// happens while the rest run.
// Its box is a fixed world size (CONVERGED_ICON_WORLD); its drawing scales up about its centre when the board is zoomed
// far out (convergedIconScale), and its rows keep 13 / 12 px on screen.
import {
  memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent,
  type PointerEvent,
} from 'react';
import { AVATAR_EXPRESSION, AVATAR_FACES, AVATAR_LOOKS, eyeGaze, type FacePart } from './avatarFace';
import type { CanvasNode } from './canvasDoc';
import { CANVAS_GROUP_ID, CONVERGED_ICON_WORLD, convergedIconScale, type ConvergedIconBox } from './convergedGroups';
import { groupStatus, memberLiveState, type GroupState, type GroupStatus, type MemberLiveState } from './groupStatus';
import { useCanvasI18n, type CanvasTextKey, type CanvasTranslate } from './i18n';
import { hasDeliveredResult } from './nextSteps';
import { getNodeThreads, sessionStoreKey } from './nodeThreads';
import { summaryNote } from './RunControls';
import type { RunView } from './RunTimeline';
import { getSnapshot, subscribe } from './sessions';
import { runBadgeText } from './SessionTile';
import { failureReason, recoveryDetailMessage } from './surfaceMessages';
import { WorkingTimer } from './WorkingIndicator';
import type { UiLocale } from '../locale';
import './converged-icon.css';

/** Up to this many members each get their own arc, while each still has room on screen to be told apart. */
export const RING_TICKS_MAX = 48;
const TICK_MIN_PX = 3.5;
/** The ring's radius over the drawing's half-width (viewBox -60…60, ring at 52). */
const RING_SHARE = 52 / 60;
/** The on-screen size from which the icon shows its third row (what runs now). */
const TIER_L_PX = 96;
const ARC_ORDER: ReadonlyArray<MemberLiveState> = ['done', 'delivered', 'cached', 'running', 'waiting', 'failed', 'blocked', 'cancelled', 'idle'];
/** A failure, a block or work in progress is never drawn thinner than this share of the ring. */
const MIN_SHARE: Partial<Record<MemberLiveState, number>> = { failed: .025, blocked: .025, running: .025 };
/** Loops share one phase: every icon breathes together, and one culled and mounted again carries on. */
const BREATH_MS = 2200;
/** A working face blinks once in two breaths, in one phase for every icon as well. */
const FACE_MS = 2 * BREATH_MS;
const FAILURE_COALESCE_MS = 1500;
/** How long the eyes are away from the work for a member that failed while the rest run, the glide there included
 *  (converged-icon.css's .45 s; with the glide back, about 1.4 s in all, about half a second at rest on the failure). */
export const GLANCE_MS = 950;
/** The light at the chin, as the head clips it (converged-icon.css): the head (r 50 about 50, 50) less the same circle
 *  8 units higher, 8 deep at the chin and nothing at the eyes' line (y 46). Its outer arc is drawn on r 52, past the head,
 *  so the head's clip draws the chin's edge however the SVG is rounded; its inner arc is that higher circle's. */
const CRESCENT = 'M 0.7716 33.25 A 52 52 0 1 0 99.2284 33.25 A 50 50 0 1 1 0.7716 33.25 Z';

export interface RingSegment { state: MemberLiveState; from: number; to: number }

/** The ring's arcs as shares of the circle (0 = 12 o'clock, clockwise): one per member while there are at most 48 and
 *  each has 3.5 px of ring on screen (`diameterPx`), else one per state family in a fixed order. */
export function ringSegments(states: ReadonlyArray<MemberLiveState>, diameterPx = Infinity): RingSegment[] {
  const n = states.length;
  if (!n) return [];
  if (n <= RING_TICKS_MAX && (Math.PI * diameterPx * RING_SHARE) / n >= TICK_MIN_PX) {
    const gap = n > 1 ? Math.min(.02, .3 / n) : 0;
    return states.map((state, index) => ({ state, from: index / n + gap / 2, to: (index + 1) / n - gap / 2 }));
  }
  // A family under its floor gets the floor; the others share what is left in proportion, so the floor holds exactly.
  const families = ARC_ORDER.map(state => ({ state, share: states.filter(item => item === state).length / n })).filter(item => item.share > 0);
  const floored = (item: { state: MemberLiveState; share: number }) => item.share < (MIN_SHARE[item.state] ?? 0);
  const reserved = families.filter(floored).reduce((sum, item) => sum + (MIN_SHARE[item.state] ?? 0), 0);
  const free = families.filter(item => !floored(item)).reduce((sum, item) => sum + item.share, 0);
  let at = 0;
  return families.map(item => {
    const from = at;
    at += floored(item) ? MIN_SHARE[item.state]! : free > 0 ? item.share * (1 - reserved) / free : 0;
    return { state: item.state, from, to: at };
  });
}

/** The middle of the arc drawn for member `index` (of the states ringSegments drew `segments` from), as a share of the
 *  circle: its own arc while every member has one, else its state's family arc. Null when nothing is drawn for it. */
export function arcMiddle(segments: ReadonlyArray<RingSegment>, states: ReadonlyArray<MemberLiveState>, index: number): number | null {
  const state = states[index];
  if (state === undefined) return null;
  // Its own arc is the one at its index in its own state (one arc per member); on a ring of state families that would be
  // another member's state, and the family's arc is the one.
  const own = segments.length === states.length && segments[index]?.state === state;
  const segment = own ? segments[index] : segments.find(item => item.state === state);
  return segment ? (segment.from + segment.to) / 2 : null;
}

function arcPath(r: number, from: number, to: number): string {
  const point = (share: number) => {
    const angle = share * 2 * Math.PI;
    return `${(r * Math.sin(angle)).toFixed(2)} ${(-r * Math.cos(angle)).toFixed(2)}`;
  };
  if (to - from >= .9999) return `M 0 ${-r} A ${r} ${r} 0 1 1 0 ${r} A ${r} ${r} 0 1 1 0 ${-r}`;
  return `M ${point(from)} A ${r} ${r} 0 ${to - from > .5 ? 1 : 0} 1 ${point(to)}`;
}

/** Every conversation of a member: a reply can stream in any of its threads, as the board's own check reads them. */
function streamKeys(node: CanvasNode): string[] {
  return node.kind === 'session' ? getNodeThreads(node).map(thread => sessionStoreKey(node, thread.id)) : [node.id];
}

/** The members' streaming flags and start times, as one string: re-read when a member's session changes, re-rendered
 *  only when one starts or stops streaming (a streamed token changes neither). */
function useMemberStreams(steps: ReadonlyArray<CanvasNode>): ReadonlyArray<{ streaming: boolean; since?: number }> {
  const groupsKey = steps.map(node => streamKeys(node).join('\u0002')).join('\u0001');
  // Split once per change of members: read() runs on every streamed token of every member.
  const keyGroups = useMemo(() => groupsKey ? groupsKey.split('\u0001').map(group => group.split('\u0002').filter(Boolean)) : [], [groupsKey]);
  const subscribeAll = useCallback((notify: () => void) => {
    const offs = keyGroups.flat().map(key => subscribe(key, notify));
    return () => offs.forEach(off => off());
  }, [keyGroups]);
  const read = useCallback(() => keyGroups.map(keys => {
    let since = Infinity;
    let streaming = false;
    for (const key of keys) {
      const session = getSnapshot(key);
      if (!session.streaming) continue;
      streaming = true;
      since = Math.min(since, session.streamingSince ?? 0);
    }
    return streaming ? `1:${since || ''}` : '0';
  }).join(','), [keyGroups]);
  const flags = useSyncExternalStore(subscribeAll, read, read);
  return useMemo(() => flags.split(',').map(flag => flag.startsWith('1')
    ? { streaming: true, since: Number(flag.slice(2)) || undefined } : { streaming: false }), [flags]);
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(REDUCED_MOTION).matches);
/** Told when the reader turns reduced motion on or off. */
function subscribeReducedMotion(notify: () => void): () => void {
  const query = typeof window !== 'undefined' ? window.matchMedia?.(REDUCED_MOTION) : undefined;
  query?.addEventListener?.('change', notify);
  return () => query?.removeEventListener?.('change', notify);
}

const drawPart = (part: FacePart, key: number) => part.shape === 'capsule'
  ? <rect key={key} x={part.cx - part.w / 2} y={part.cy - part.h / 2} width={part.w} height={part.h} rx={Math.min(part.w, part.h) / 2} />
  : part.shape === 'fill' ? <path key={key} className="is-fill" d={part.d} />
    : <path key={key} d={part.d} strokeWidth={part.width} />;

/** The head's face: the group's state as two eyes (avatarFace.ts), decoration only: the label and the rows say it in
 *  words. The gaze group carries where they look (face units; converged-icon.css glides it); inside it the eyes are one
 *  group, which a working face blinks in the shared phase: the delay is the eyes' own, so the face's one-shot hop or
 *  shake starts from its beginning. */
function AvatarFace({ state, phase, gaze }: { state: GroupState; phase: number; gaze: readonly [number, number] }) {
  const expression = AVATAR_EXPRESSION[state];
  return (
    <svg className="awwo-converged-face" viewBox="0 0 100 100" data-expression={expression} aria-hidden="true">
      <g className="awwo-converged-gaze" style={{ transform: `translate(${gaze[0].toFixed(2)}px, ${gaze[1].toFixed(2)}px)` }}>
        <g className="awwo-converged-eyes" style={{ animationDelay: `${phase}ms` }}>{AVATAR_FACES[expression].map(drawPart)}</g>
      </g>
    </svg>
  );
}

type Tone = 'failed' | 'blocked';
/** Row 2 in parts: what the group is doing, in real counts. In a run, done of the run's members; at rest, how many hold
 *  a result. A failed count is said in the danger ink, a blocked one in the warning ink, never folded together. */
export function groupStateParts(status: GroupStatus, t: CanvasTranslate, waitingText?: string): Array<{ text: string; tone?: Tone }> {
  const { counts } = status;
  const run = { done: counts.done, total: counts.inRun };
  const parts: Array<{ text: string; tone?: Tone }> = [];
  switch (status.state) {
    // A reply streaming with no run touching the group has no run fraction to give.
    case 'running': parts.push({ text: counts.inRun ? t('converge.progress', run) : t('tile.running') }); break;
    // Waiting for recovery to confirm, or for an automatic retry, says so (runBadgeText's words), not "queued".
    case 'waiting': parts.push({ text: waitingText ? `${waitingText} · ${counts.done}/${counts.inRun}` : t('converge.queuedLine', run) }); break;
    case 'done': return [{ text: t('converge.allDone', run) }];
    case 'cached': return [{ text: t('converge.reused', { done: status.settled, total: counts.total }) }];
    case 'cancelled': parts.push({ text: t('converge.stopped', run) }); break;
    case 'failed': case 'blocked': if (counts.done) parts.push({ text: t('converge.succeeded', { count: counts.done }) }); break;
    default: return [{ text: status.settled ? t('converge.results', { done: status.settled, total: counts.total }) : t('converge.notRun') }];
  }
  if (counts.failed) parts.push({ text: t('converge.failed', { count: counts.failed }), tone: 'failed' });
  if (counts.blocked) parts.push({ text: t('converge.blocked', { count: counts.blocked }), tone: 'blocked' });
  return parts;
}

export function groupStateText(status: GroupStatus, t: CanvasTranslate, waitingText?: string): string {
  return groupStateParts(status, t, waitingText).map(part => part.text).join(' · ');
}

/** What the first waiting member waits for, when it is more than a place in the queue, in a few fixed words that fit
 *  the row: recovery confirming whether it still runs, or which automatic retry it waits for (the card's words). The
 *  recovery's own detail, a sentence, is the tooltip's (reasonLines). Empty for a plain queue. */
export function waitingReason(run: RunView | undefined, t: CanvasTranslate): string {
  if (!run) return '';
  if (run.unconfirmed && run.state === 'running') return t('converge.confirming');
  if (run.state === 'waiting' && run.detail === 'retrying' && run.attempts && run.retryLimit) {
    return t('tile.retrying', { attempt: run.attempts, limit: run.retryLimit });
  }
  return '';
}

/** The accessible name's lead: words only (the card's own 完成 carries a check mark a screen reader would read out). */
const LEAD: Record<GroupState, CanvasTextKey> = {
  running: 'tile.running', waiting: 'tile.queued', failed: 'tile.failed', blocked: 'tile.blocked', cancelled: 'tile.cancelled',
  done: 'converge.allDoneLead', cached: 'tile.cached', delivered: 'converge.atRest', idle: 'converge.atRest',
};

/** The state in the accessible name: the lead word (what a waiting group waits for, when it is more than a queue), then
 *  every nonzero count; every member is accounted for. */
export function groupAccessibleState(status: GroupStatus, t: CanvasTranslate, locale: UiLocale, waitingText = ''): string {
  const { counts } = status;
  const pieces = [waitingText || t(LEAD[status.state]), counts.inRun ? t('converge.doneOf', { done: counts.done, total: counts.inRun })
    : t('converge.results', { done: status.settled, total: counts.total })];
  const add = (count: number, key: CanvasTextKey) => { if (count) pieces.push(t(key, { count })); };
  add(counts.running, 'converge.runningN');
  add(counts.waiting, 'converge.waitingN');
  add(counts.failed, 'converge.failed');
  add(counts.blocked, 'converge.blocked');
  add(counts.cancelled, 'converge.cancelled');
  // A run's count leaves out the members it does not touch: those reusing or holding an earlier result are said apart.
  // At rest the results piece already counts them, so they are not said twice.
  if (counts.inRun) {
    add(counts.cached, 'converge.cached');
    add(counts.delivered, 'converge.deliveredN');
  }
  add(counts.idle, 'converge.notRunN');
  return pieces.join(locale === 'zh' ? '，' : ', ');
}

/** Which members failed, were blocked or wait for recovery to confirm them, and why: the first three, then how many
 *  more. For the native tooltip, and for the icon's description, where a keyboard or screen reader finds them. */
function reasonLines(steps: ReadonlyArray<CanvasNode>, runs: Readonly<Record<string, RunView>>, t: CanvasTranslate, locale: UiLocale): string[] {
  const lines: string[] = [];
  let more = 0;
  for (const node of steps) {
    const run = runs[node.id];
    const confirming = Boolean(run?.unconfirmed && run.state === 'running');
    if (!run || (run.state !== 'failed' && run.state !== 'blocked' && !confirming)) continue;
    if (lines.length >= 3) { more += 1; continue; }
    const state = t(confirming ? 'converge.confirming' : run.state === 'failed' ? 'tile.failed' : 'tile.blocked');
    const reason = confirming ? recoveryDetailMessage(t, run.detail, locale)
      : run.state === 'failed' ? failureReason(t, run.detail, locale) : run.detail ? runBadgeText(run, locale, t) : '';
    const title = node.title.trim() || '—';
    // No reason, or one that only repeats the state: the state and the member alone ("失败：配图", not "失败：配图（失败）").
    lines.push(reason && reason !== state ? t('converge.reasonLine', { state, title, reason }) : t('converge.reasonLineBare', { state, title }));
  }
  if (more) lines.push(t('converge.moreReasons', { count: more }));
  return lines;
}

export interface ConvergedIconProps {
  icon: ConvergedIconBox;
  /** The members, in ring order (pipeline order). Forms among them are inputs: neither counted nor on the ring. */
  members: ReadonlyArray<CanvasNode>;
  runs: Readonly<Record<string, RunView>>;
  depths: ReadonlyMap<string, number>;
  title: string;
  scale: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onExpand: (id: string) => void;
  /** Says a change once, through the board's one polite status region. */
  onAnnounce?: (text: string) => void;
  /** Whether a run is going on the canvas: between runs a result an edit cleared no longer counts as done. */
  live: boolean;
}

function ConvergedIconImpl({ icon, members, runs, depths, title, scale, selected, onSelect, onExpand, onAnnounce, live }: ConvergedIconProps) {
  const { t, locale } = useCanvasI18n();
  const hintId = useId();
  const steps = useMemo(() => members.filter(node => node.kind !== 'form'), [members]);
  const streams = useMemberStreams(steps);
  const status = useMemo(() => groupStatus(steps.map((node, index) => ({
    id: node.id, run: runs[node.id] ?? null, streaming: streams[index]?.streaming, streamingSince: streams[index]?.since,
    depth: depths.get(node.id), delivered: hasDeliveredResult(node),
  })), live), [steps, runs, streams, depths, live]);
  const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const k = convergedIconScale(zoom);
  const diameter = CONVERGED_ICON_WORLD * zoom * k;
  const tier: 'M' | 'L' = diameter >= TIER_L_PX ? 'L' : 'M';
  const states = useMemo(() => steps.map((node, index) =>
    memberLiveState(runs[node.id], streams[index]?.streaming, hasDeliveredResult(node), live)), [steps, runs, streams, live]);
  const segments = useMemo(() => ringSegments(states, diameter), [states, diameter]);
  const settledMark = useSettledMark(status.state);
  const stepIds = useMemo(() => steps.map(node => node.id), [steps]);
  const glanceId = useFailureGlance(status, stepIds);
  // Where the eyes look: for a moment at a member seen failing while the rest run; else, on a face that looks, at the
  // member the icon names (while it runs, a streaming reply or the frontier; once it has failed, the first failure), at
  // its own arc or its state's; else straight ahead.
  const lookAt = glanceId ?? (AVATAR_LOOKS[AVATAR_EXPRESSION[status.state]] ? status.activeId : null);
  const lookIndex = lookAt ? steps.findIndex(node => node.id === lookAt) : -1;
  const lookShare = lookIndex < 0 ? null : arcMiddle(segments, states, lookIndex);
  const gaze: readonly [number, number] = lookShare === null ? [0, 0] : eyeGaze(lookShare);
  useAnnouncements(status, icon.id, title, steps, onAnnounce, t, locale);
  // Taken when a run starts, as the loops do (they start with is-running), so an icon converged before its run is in step
  // with every other one.
  const runningNow = status.state === 'running';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const phase = useMemo(() => -(Date.now() % BREATH_MS), [runningNow]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const facePhase = useMemo(() => -(Date.now() % FACE_MS), [runningNow]);
  const active = status.activeId ? steps.find(node => node.id === status.activeId) : undefined;
  const activeRun = active ? runs[active.id] : undefined;
  const waitingText = status.state === 'waiting' ? waitingReason(activeRun, t) : '';
  const parts = groupStateParts(status, t, waitingText);
  const stateText = parts.map(part => part.text).join(' · ');
  const nowText = active && status.state === 'running'
    ? `${active.title.trim() || '—'} · ${activeRun ? runBadgeText(activeRun, locale, t) : t('tile.running')}` : '';
  const moreRunning = Math.max(0, status.counts.running - 1);
  const badge = status.counts.failed ? { kind: 'failed', count: status.counts.failed }
    : status.counts.blocked ? { kind: 'blocked', count: status.counts.blocked } : null;
  // A badge whose count changed while this icon is drawn is a new element that pops in from its first frame (keyed by its
  // count); the one it mounted with never pops.
  const badgeKey = badge ? `${badge.kind}-${badge.count}` : null;
  // undefined once the badge has changed: every badge after that pops in, the mount's own count again included.
  const firstBadgeKey = useRef<string | null | undefined>(badgeKey);
  useEffect(() => { if (badgeKey !== firstBadgeKey.current) firstBadgeKey.current = undefined; }, [badgeKey]);
  const nameRow = t('converge.nameRow', { title, count: status.counts.total });
  const reasons = reasonLines(steps, runs, t, locale);
  const tooltip = [nameRow, stateText, nowText, ...reasons].filter(Boolean).join('\n');
  // A pointer's press selects, and its own click follows it. A click with no press of a pointer before it is a screen
  // reader's activation (NVDA and JAWS in browse mode, VoiceOver, TalkBack send only a click), which expands, as Enter
  // does; Chromium also marks such a click detail 0.
  const pointerPress = useRef(false);
  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    pointerPress.current = true;
    // Claimed like a card's press: the board must not pan, and the double-click must reach this element.
    event.stopPropagation();
    onSelect(icon.id);
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const fromPointer = pointerPress.current;
    pointerPress.current = false;
    if (event.detail === 0 || !fromPointer) onExpand(icon.id);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    onExpand(icon.id);
  };
  const running = segments.filter(segment => segment.state === 'running');
  return (
    <div
      className={`canvas-tile awwo-node awwo-converged is-${status.state}${selected ? ' canvas-tile--selected' : ''}${settledMark ? ` is-just-${settledMark}` : ''}`}
      style={{ left: icon.x, top: icon.y, width: icon.w, height: icon.h, '--cv-k': k, '--cv-px': 1 / (zoom * k) } as CSSProperties}
      role="button"
      tabIndex={0}
      aria-expanded={false}
      aria-label={`${t('converge.label', { title, count: status.counts.total, state: groupAccessibleState(status, t, locale, waitingText) })}${active && status.state === 'running' ? t('converge.now', { title: active.title.trim() || '—' }) : ''}`}
      aria-describedby={hintId}
      title={tooltip}
      data-converged-id={icon.id}
      data-state={status.state}
      data-tier={tier}
      data-testid={`converged-icon-${icon.id}`}
      onPointerDown={press}
      onClick={click}
      onDoubleClick={event => { event.stopPropagation(); onExpand(icon.id); }}
      onKeyDown={key}
    >
      <svg className="awwo-converged-ring" viewBox="-60 -60 120 120" aria-hidden="true">
        <circle className="awwo-converged-collar" r={52} />
        {segments.map((segment, index) => segment.state === 'running' ? null : (
          <g key={index}>
            {segment.state === 'failed' ? <path className="awwo-converged-keyline" d={arcPath(52, segment.from, segment.to)} /> : null}
            <path className={`awwo-converged-arc is-${segment.state}`} d={arcPath(52, segment.from, segment.to)} />
          </g>
        ))}
      </svg>
      {running.length ? (
        <svg className="awwo-converged-ring awwo-converged-live" viewBox="-60 -60 120 120" aria-hidden="true" style={{ animationDelay: `${phase}ms` }}>
          {running.map((segment, index) => <path key={index} className="awwo-converged-arc is-running" d={arcPath(52, segment.from, segment.to)} />)}
        </svg>
      ) : null}
      {/* The head: flat, with a light at the chin (still: only the face hops or shakes), on a dark style a light rim that
          keeps it apart from the plate (converged-icon.css), and the face that says what the group is doing; the counts
          are the rows' to give, under it. */}
      <span className="awwo-converged-orb" aria-hidden="true">
        <svg className="awwo-converged-crescent" viewBox="0 0 100 100" aria-hidden="true"><path d={CRESCENT} /></svg>
        <span className="awwo-converged-rim" />
        <AvatarFace state={status.state} phase={facePhase} gaze={gaze} />
      </span>
      {badge ? <span key={badgeKey} className={`awwo-converged-badge is-${badge.kind}${badgeKey !== firstBadgeKey.current ? ' is-new' : ''}`} aria-hidden="true">
        {badge.count > 99 ? '99+' : badge.count}</span> : null}
      <span className="awwo-converged-label" aria-hidden="true">
        <span className="awwo-converged-name">{nameRow}</span>
        <span className="awwo-converged-state">{parts.map((part, index) => <span key={index}>
          {index ? ' · ' : ''}<span className={part.tone ? `is-${part.tone}` : undefined}>{part.text}</span></span>)}</span>
        {tier === 'L' && status.state === 'running' && nowText ? <span className="awwo-converged-now">
          {status.since ? <><WorkingTimer since={status.since} /> · </> : null}{nowText}
          {moreRunning ? ` · ${t('converge.moreRunning', { count: moreRunning })}` : ''}
        </span> : null}
      </span>
      {/* How to expand, then which members failed, were blocked or wait for recovery, and why: what the tooltip shows a
          mouse, for a keyboard and a screen reader (aria-describedby is read over title). */}
      <span id={hintId} className="awwo-converged-sr">{[t('converge.expandHint'), ...reasons].join(locale === 'zh' ? '；' : '; ')}</span>
    </div>
  );
}

/** A group that finishes or fails while you watch answers once (is-just-done / is-just-failed, the card's ripple). */
function useSettledMark(state: GroupState): 'done' | 'failed' | null {
  const [mark, setMark] = useState<'done' | 'failed' | null>(null);
  const previous = useRef(state);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before !== 'running' || (state !== 'done' && state !== 'failed') || reducedMotion()) { setMark(null); return; }
    setMark(state);
    const timer = setTimeout(() => setMark(null), 1000);
    return () => clearTimeout(timer);
  }, [state]);
  return mark === state ? mark : null;
}

/** A member that fails while the group still runs draws the eyes to its arc for a moment (GLANCE_MS), then they go back
 *  to the work: only for a failure seen happen (one the icon mounted with, found again, or a member that joined failed
 *  is no news), while motion is welcome; a later failure takes the eyes from an earlier one, and of several at once the
 *  first in pipeline order (the upstream one explains those below it). A change that brings no new failure (another
 *  member retried, the members put in another order) leaves a glance as it is while its member is still failed. Null
 *  otherwise, once the group stops running, and the moment the reader turns reduced motion on. */
function useFailureGlance(status: GroupStatus, memberIds: ReadonlyArray<string>): string | null {
  const [glance, setGlance] = useState<string | null>(null);
  const running = status.state === 'running';
  const reduce = useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => false);
  const failedKey = status.failedIds.join('\u0001');
  const membersKey = memberIds.join('\u0001');
  // Read inside the effect, which runs on a change of the failed members, of the members or of running only.
  const latest = useRef({ failed: status.failedIds, members: memberIds });
  latest.current = { failed: status.failedIds, members: memberIds };
  const seen = useRef({ failed: new Set(status.failedIds) as ReadonlySet<string>, members: new Set(memberIds) as ReadonlySet<string> });
  // The glance's own timer, apart from the effect's runs: a run that brings no new failure must not end it.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const { failed, members } = latest.current;
    const before = seen.current;
    seen.current = { failed: new Set(failed), members: new Set(members) };
    if (!running || reduce) { clearTimeout(timer.current); setGlance(null); return; }
    const fresh = failed.filter(item => before.members.has(item) && !before.failed.has(item));
    if (fresh.length) {
      clearTimeout(timer.current);
      setGlance(fresh[0]);
      timer.current = setTimeout(() => setGlance(null), GLANCE_MS);
      return;
    }
    setGlance(current => current && failed.includes(current) ? current : null);
  }, [failedKey, membersKey, running, reduce]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return running && !reduce ? glance : null;
}

/** What the board's status region says for this icon: a member failing while the rest still run (a burst said once,
 *  within 1.5 s), and a group settling. The whole canvas's settling is the run note's to say (RunControls). */
function useAnnouncements(status: GroupStatus, id: string, title: string, steps: ReadonlyArray<CanvasNode>,
  onAnnounce: ((text: string) => void) | undefined, t: CanvasTranslate, locale: UiLocale) {
  // Read inside the effect, which runs on a change of state or of the failed count only: the latest of everything else.
  const latest = useRef({ status, id, title, steps, onAnnounce, t, locale });
  latest.current = { status, id, title, steps, onAnnounce, t, locale };
  const previous = useRef<{ state: GroupState; failed: ReadonlySet<string> }>({ state: status.state, failed: new Set(status.failedIds) });
  const burst = useRef<{ titles: string[]; timer?: ReturnType<typeof setTimeout> }>({ titles: [] });
  const { state } = status;
  const failedKey = status.failedIds.join('\u0001');
  useEffect(() => {
    const now = latest.current;
    const before = previous.current;
    previous.current = { state, failed: new Set(now.status.failedIds) };
    if (!now.onAnnounce) return;
    const live = state === 'running' || state === 'waiting';
    if ((before.state === 'running' || before.state === 'waiting') && !live) {
      clearTimeout(burst.current.timer);
      burst.current = { titles: [] };
      if (now.id !== CANVAS_GROUP_ID) now.onAnnounce(now.t('converge.announce.settled', { title: now.title, summary: settleSummary(now.status, now.locale) }));
      return;
    }
    const fresh = now.status.failedIds.filter(item => !before.failed.has(item));
    if (!live || !fresh.length) return;
    const names = new Map(now.steps.map(node => [node.id, node.title.trim() || '—']));
    burst.current.titles.push(...fresh.map(item => names.get(item) ?? '—'));
    // One window from the first failure: later ones join it and never push it back, so failures that keep coming are
    // still said, 1.5 s after the first.
    if (burst.current.timer) return;
    burst.current.timer = setTimeout(() => {
      const said = burst.current.titles;
      const at = latest.current;
      burst.current = { titles: [] };
      at.onAnnounce?.(said.length === 1 ? at.t('converge.announce.memberFailed', { title: at.title, member: said[0] })
        : at.t('converge.announce.failedMany', { title: at.title, count: said.length }));
    }, FAILURE_COALESCE_MS);
  }, [state, failedKey]);
  useEffect(() => () => clearTimeout(burst.current.timer), []);
}

/** The run note's own words for the group's outcome. */
function settleSummary(status: GroupStatus, locale: UiLocale): string {
  const { counts } = status;
  return summaryNote({
    ok: !counts.failed && !counts.blocked && !counts.cancelled, done: counts.done, failed: counts.failed, blocked: counts.blocked,
    cancelled: counts.cancelled, cached: counts.cached, total: counts.inRun,
  }, status.state === 'cancelled', locale);
}

export const ConvergedIcon = memo(ConvergedIconImpl);
