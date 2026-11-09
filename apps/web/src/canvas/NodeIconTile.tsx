// One component of the board drawn as a live icon (图标视图: the view preference that draws every component so, wired as
// the cards are; nodeIcons.ts has its geometry). An Agent is the converged icon's flat head with a face for its state
// (avatarFace.ts); a form, an assemble node and an edit node are a token in the head's white on the same plate. The
// collar's ring says the state too; the ports sit on the rim at the sides, on the same band the wires end on; the name and
// a state line are under it. Its press, drag and double-click are the card's (SessionTile), on the plate. A separate
// button covering the plate takes focus, keys and a screen reader's activation, so the ports beside it are never a
// button's children.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties,
  type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { CanvasNode, FormNode } from './canvasDoc';
import { AVATAR_CRESCENT, AVATAR_EXPRESSION, AVATAR_FACES, eyeGaze } from './avatarFace';
import { arcPath, drawPart, useMemberStreams, waitingReason } from './ConvergedIcon';
import { editPreview } from './EditTileBody';
import { memberLiveState, type MemberLiveState } from './groupStatus';
import { useCanvasI18n } from './i18n';
import { hasDeliveredResult } from './nextSteps';
import { modelChoiceKey, type NodeModelChoice } from './NodeModelPicker';
import { sessionStoreKey } from './nodeThreads';
import { nodeIconGeometry, nodeIconTier } from './nodeIcons';
import type { RunView } from './RunTimeline';
import { compactSessionPreview, glyphOf, runBadgeText, type SelectMode } from './SessionTile';
import { getSnapshot, subscribe } from './sessions';
import { refuseHeldEnter } from './heldEnter';
import { failureReason } from './surfaceMessages';
import { mediaComposerInfo } from './TileComposer';
import { TilePorts, type WiringApi } from './TilePorts';
import { useSimpleCanvas } from './uiMode';
import { WorkingTimer } from './WorkingIndicator';
import { cardPressAllowed, holdCardGesture, holdPassivePress } from './cardGesture';
import './converged-icon.css';
import './node-icon.css';

/** A press is a drag once it travels this far (a finger farther: a tap wobbles). */
const DRAG_THRESHOLD_PX = 3;
const TOUCH_DRAG_THRESHOLD_PX = 10;
/** A double-click this soon after a drag ended is the drag's own last click, not a wish to open. */
const AFTER_DRAG_MS = 250;
/** How long a press stays the press of the click that follows it: a mouse's click comes in the task of its release, a
 *  tap's (a finger's or a pen's) later, from the browser's tap gesture once the touch has ended. */
const TAP_CLICK_MS = 800;
/** One turn of the running arc; the eyes follow it, and blink once in two turns. */
const ORBIT_MS = 2200;
const BLINK_MS = 2 * ORBIT_MS;
/** The arc that goes round a running icon's collar: a quarter, centred on 12 o'clock (the loading pages' head's). */
const ORBIT_ARC = arcPath(52, -0.125, 0.125);

/** The token of a component that is not an Agent, in the head's white over its 100-unit box: a page, layers, a clapper. */
const TOKENS: Record<'form' | 'assemble' | 'edit', ReactNode> = {
  form: <>
    <path d="M 34 25 H 58 L 68 35 V 75 H 34 Z" strokeWidth={5} />
    <path d="M 58 25 V 35 H 68" strokeWidth={5} />
    <path d="M 41 48 H 61 M 41 57 H 61 M 41 66 H 54" strokeWidth={4.5} />
  </>,
  assemble: <>
    <path d="M 50 27 L 73 39 L 50 51 L 27 39 Z" strokeWidth={5} />
    <path d="M 27 51 L 50 63 L 73 51" strokeWidth={5} />
    <path d="M 27 62 L 50 74 L 73 62" strokeWidth={5} />
  </>,
  edit: <>
    <path d="M 28 47 H 72 V 72 H 28 Z" strokeWidth={5} />
    <path d="M 28 47 L 26 37 L 69 29 L 71 39" strokeWidth={5} />
    <path d="M 38 35 L 43 44 M 51 33 L 56 42" strokeWidth={4.5} />
  </>,
};

type Tone = 'failed' | 'blocked';
interface Line { text: ReactNode; words: string; tone?: Tone }

/** Whether a reason is one of these words (a state said again), whatever its case. */
const sameWord = (said: string, ...words: string[]) => words.some(word => word.toLowerCase() === said.trim().toLowerCase());

/** A form says whether it is filled in: every field holds a value (it has at least one), or how many still wait. */
function formFill(node: FormNode) {
  const missing = node.fields.filter(field => !field.value.trim()).length;
  return { filled: node.fields.length > 0 && missing === 0, missing, first: node.fields.find(field => field.value.trim())?.value.trim() ?? '' };
}

export interface NodeIconTileProps {
  /** The document's node: its kind, title, fields, binding and results, and the x and y a drag moves. */
  node: CanvasNode;
  /** The node as the board draws it (renderNodes' object): the icon's geometry is taken from it, one set per object. */
  drawn: CanvasNode;
  /** Its run as the board records it, with when it started (the running line's timer). */
  run: RunView | null;
  /** Whether a run is under way or being recovered (memberLiveState: a result an edit cleared reads as gone otherwise). */
  live: boolean;
  scale: number;
  selected: boolean;
  /** Selected alone: a tap on it opens it (touch has no reliable double-click). */
  soleSelected: boolean;
  /** The one icon a Tab reaches (a roving stop: the board would otherwise hold one per component). */
  tabbable: boolean;
  readOnly?: boolean;
  /** As the card's: a run holds it, or the canvas is busy; its ports are inert then. */
  interactionLocked?: boolean;
  wiring?: WiringApi;
  modelChoices?: ReadonlyArray<NodeModelChoice>;
  onMove?: (nodeId: string, x: number, y: number) => void;
  onSelect?: (nodeId: string, mode: SelectMode) => void;
  onToggleFocus?: (nodeId: string) => void;
}

export const NodeIconTile = memo(function NodeIconTile({ node, drawn, run, live, scale, selected, soleSelected, tabbable,
  readOnly = false, interactionLocked = false, wiring, modelChoices, onMove, onSelect, onToggleFocus }: NodeIconTileProps) {
  const { t, locale } = useCanvasI18n();
  const simple = useSimpleCanvas();
  const hintId = useId();
  const { icon, wire, labelWidth } = nodeIconGeometry(drawn);
  const members = useMemo(() => [node], [node]);
  const stream = useMemberStreams(members)[0];
  const form = useMemo(() => node.kind === 'form' ? formFill(node) : null, [node]);
  const state: MemberLiveState = form ? (form.filled ? 'done' : 'idle')
    : memberLiveState(run, stream?.streaming, hasDeliveredResult(node), live);
  const running = state === 'running';
  const agent = node.kind === 'session';
  const expression = AVATAR_EXPRESSION[state];
  const kindLabel = glyphOf(node, locale).label;
  const title = node.title.trim() || '—';
  // A session's line at rest is its compact card's (compactSessionPreview), from the conversation chosen as the sessions
  // store holds it, read as that line: a reply streaming in draws the icon again only when what the line says changes.
  const storeKey = node.kind === 'session' ? sessionStoreKey(node) : null;
  const subscribeStore = useCallback((notify: () => void) => storeKey ? subscribe(storeKey, notify) : () => {}, [storeKey]);
  const readResting = () => node.kind === 'session' && storeKey ? compactSessionPreview(node, getSnapshot(storeKey).turns, locale, t) : '';
  const resting = useSyncExternalStore(subscribeStore, readResting, readResting);

  const line = useMemo((): Line => {
    // A connection that may already exist is a warning whatever a run says (the card's chip stays in its header): a
    // blind retry could hire a second Agent.
    const pendingBind = (said: Line & { text: string }): Line => node.kind === 'session' && node.bindAttempt === 'unknown'
      ? { ...said, text: `${said.text} · ${t('tile.bindPending')}`, words: `${said.words} · ${t('tile.bindPending')}` } : said;
    if (form) {
      return form.filled ? { text: `${t('nodeIcon.formFilled')} · ${form.first}`, words: t('nodeIcon.formFilled') }
        : node.kind === 'form' && !node.fields.length ? { text: t('nodeIcon.formEmpty'), words: t('nodeIcon.formEmpty') }
          : { text: t('nodeIcon.formToFill', { count: form.missing }), words: t('nodeIcon.formToFill', { count: form.missing }) };
    }
    switch (state) {
      case 'running': {
        const since = stream?.streaming ? stream.since ?? run?.startedAt : run?.startedAt;
        return { text: <>{t('tile.running')}{since ? <> · <WorkingTimer since={since} /></> : null}</>, words: t('tile.running') };
      }
      case 'waiting': {
        // What it waits for when it is more than a place in the queue (the group icon's words): a run whose stream was
        // lost being confirmed (memberLiveState draws it waiting), or which automatic retry comes next.
        const words = waitingReason(run ?? undefined, t) || (run ? runBadgeText(run, locale, t) : t('tile.queued'));
        return { text: words, words };
      }
      case 'done': return pendingBind({ text: t('tile.completed'), words: t('nodeIcon.done') });
      case 'cached': return pendingBind({ text: t('tile.cached'), words: t('tile.cached') });
      case 'failed': {
        // A reason that only says the state again (a run's own status, 失败) is no reason: never 「失败 · 失败」.
        const reason = failureReason(t, run?.detail, locale);
        const words = reason && !sameWord(reason, t('tile.failed'), t('session.failed')) ? `${t('tile.failed')} · ${reason}` : t('tile.failed');
        return pendingBind({ text: words, words, tone: 'failed' });
      }
      case 'blocked': {
        // Never the bare word, nor a run's own 失败 for a node that never ran (a graph's status left on its waiting nodes):
        // what holds it back, else that what it waits on did not finish.
        const said = run?.detail ? runBadgeText(run, locale, t) : '';
        const words = said && !sameWord(said, t('tile.blocked'), t('tile.failed'), t('session.failed')) ? said : t('surface.upstreamIncomplete');
        return pendingBind({ text: words, words, tone: 'blocked' });
      }
      case 'cancelled': { const words = run ? runBadgeText(run, locale, t) : t('tile.cancelled'); return pendingBind({ text: words, words }); }
      default: {
        // At rest, the card's own words: a connection that may already exist is a warning (a blind retry could hire a
        // second Agent), a session never connected is a draft, else what it delivered or that it has nothing yet.
        if (node.kind === 'session') {
          if (node.bindAttempt === 'unknown') return { text: t('tile.bindPending'), words: t('tile.bindPending'), tone: 'blocked' };
          if (!node.binding) return { text: t('tile.draft'), words: t('tile.draft') };
          return { text: resting, words: resting };
        }
        const words = node.kind === 'assemble' ? t('tile.assembleSummary', { inputs: node.contract.inputs.length,
          outputs: node.contract.outputs.map(field => field.label || field.id).join(' + ') })
          : node.kind === 'edit' ? editPreview(node, t) : t('converge.notRun');
        return { text: words, words };
      }
    }
  }, [form, node, state, run, stream, resting, locale, t]);

  // The phase of a run's motion, taken when it starts: the arc and the eyes that follow it in one, the blink in its own.
  const phase = useMemo(() => running ? { orbit: `${-(Date.now() % ORBIT_MS)}ms`, blink: `${-(Date.now() % BLINK_MS)}ms` } : null, [running]);
  // A failed Agent's worried eyes look down (the ring's bottom), the others straight ahead.
  const [gx, gy] = state === 'failed' ? eyeGaze(0.5).map(share => Math.round(share * 100) / 100) : [0, 0];

  // Once, when a run of it ends done or failed while it is watched (the card's ripple): a hop, a shake. Not for a run
  // that comes back as it was (a page repair the service refused before it ran gives the node its earlier badge back).
  const [settled, setSettled] = useState<'done' | 'failed' | null>(null);
  const previousState = useRef(state);
  const runNow = useRef(run);
  runNow.current = run;
  const restingRun = useRef(run);
  useEffect(() => {
    const before = previousState.current;
    previousState.current = state;
    const returned = runNow.current !== null && runNow.current === restingRun.current;
    if (before !== 'running' || (state !== 'done' && state !== 'failed') || returned) { setSettled(null); return; }
    setSettled(state);
    const timer = setTimeout(() => setSettled(null), 1000);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => { if (state !== 'running') restingRun.current = run; }, [state, run]);
  // Drawn only while the state is still the one it settled in (a run started again within its second has none).
  const settledMark = settled === state ? settled : null;

  // The card's press, drag and double-click (SessionTile), with the drag ending with the icon and each gesture following
  // its own pointer.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const gestureEnds = useRef(new Set<() => void>());
  useEffect(() => () => { for (const end of [...gestureEnds.current]) end(); }, []);
  const pointerPress = useRef(false);
  // A tap on the one selected opens it, at the tap's click: that click then lands on the icon, never on the card drawn
  // in its place. `pressCount` lets only the latest press end the press flag.
  const tapOpens = useRef(false);
  const pressCount = useRef(0);
  const dragEndedAt = useRef(0);
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Claimed like a card's left press: the board must not pan, and the double-click must reach this icon. A middle
    // press is the board's (it pans).
    if (event.button === 0) event.stopPropagation();
    // While another pointer holds a card (cardGesture.ts), this press is a press (it selects, a tap opens), never a
    // drag: it moves nothing, and the cards' one gesture stays that pointer's.
    const mayDrag = event.button !== 0 || cardPressAllowed(event);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const wasSole = soleSelected;
    onSelect?.(node.id, additive ? 'additive' : 'preserve');
    if (event.button !== 0) return;
    pointerPress.current = true;
    tapOpens.current = false;
    const press = ++pressCount.current;
    const target = event.target as HTMLElement | null;
    // A press on a control (a port, locked or not) is that control's, never a drag.
    const onControl = Boolean(target?.closest?.('button, a, input, select, textarea'));
    const touch = event.pointerType === 'touch';
    // A finger or a pen: its click comes late, and a tap on the one selected opens it. Only a finger wobbles.
    const tapping = touch || event.pointerType === 'pen';
    const threshold = touch ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX;
    const pointerId = event.pointerId;
    const px = event.clientX;
    const py = event.clientY;
    const ox = node.x;
    const oy = node.y;
    const canDrag = !readOnly && Boolean(onMove) && !onControl && mayDrag;
    let dragged = false;
    const move = (pe: PointerEvent) => {
      if (pe.pointerId !== pointerId) return;
      // No button held any more: it was let go where this page never heard it (outside the window, in another app). The
      // gesture ended then; a pointer that only passes over the board afterwards moves nothing.
      if (pe.buttons === 0) { end(); if (dragged) dragEndedAt.current = Date.now(); return; }
      if (!dragged && (Math.abs(pe.clientX - px) > threshold || Math.abs(pe.clientY - py) > threshold)) dragged = true;
      if (!dragged || !canDrag) return;
      const s = scaleRef.current || 1;
      onMove?.(node.id, ox + (pe.clientX - px) / s, oy + (pe.clientY - py) / s);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      gestureEnds.current.delete(end);
      release();
      // The press is over once its click (if any: a drag let go elsewhere has none) has been handled: a focus or a click
      // after that is no press's.
      setTimeout(() => { if (pressCount.current === press) { pointerPress.current = false; tapOpens.current = false; } }, tapping ? TAP_CLICK_MS : 0);
    };
    const up = (pe: PointerEvent) => {
      if (pe.pointerId !== pointerId) return;
      end();
      if (dragged) { dragEndedAt.current = Date.now(); return; }
      // A press with a modifier, or on a control (a port), leaves the selection as it is, as on a card.
      if (additive || onControl) return;
      onSelect?.(node.id, 'only');
      if (tapping && wasSole) tapOpens.current = true;
    };
    const cancel = (pe: PointerEvent) => { if (pe.pointerId === pointerId) end(); };
    gestureEnds.current.add(end);
    const release = mayDrag ? holdCardGesture(event, end) : holdPassivePress(event, end);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, [node.id, node.x, node.y, readOnly, onMove, onSelect, soleSelected]);
  const onDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (Date.now() - dragEndedAt.current < AFTER_DRAG_MS) return;
    // A port's double-click is the port's.
    if ((event.target as HTMLElement | null)?.closest?.('button')) return;
    onToggleFocus?.(node.id);
  }, [node.id, onToggleFocus]);
  // A pointer's press selects and its click follows it. A click with no press before it is a screen reader's activation
  // (NVDA and JAWS in browse mode, VoiceOver, TalkBack send only a click), which opens the card, as Enter does. A port's
  // click (a pointer's or a key's) is the port's: it arms or ends a wire, and never opens the card.
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const fromPointer = pointerPress.current;
    const tap = tapOpens.current;
    pointerPress.current = false;
    tapOpens.current = false;
    if ((event.target as HTMLElement | null)?.closest?.('button')) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) return;
    if (tap || event.detail === 0 || !fromPointer) onToggleFocus?.(node.id);
  }, [node.id, onToggleFocus]);
  // Enter opens it at once, as a button's Enter clicks, and its repeats while it is held go nowhere (the focus goes into
  // the card, onto its close button, which they would press). Space opens it when it comes up, as a button's Space
  // clicks: its keyup never reaches the card.
  const spaceHeld = useRef(false);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === ' ') { spaceHeld.current = true; return; }
    refuseHeldEnter({ detail: 0 });
    onToggleFocus?.(node.id);
  }, [node.id, onToggleFocus]);
  const onKeyUp = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== ' ' || !spaceHeld.current) return;
    spaceHeld.current = false;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    onToggleFocus?.(node.id);
  }, [node.id, onToggleFocus]);
  // Focus that no press brought (a Tab, ⌘[ ], the board moving it) selects the icon, keeping a selection it is in, so
  // the keys that act on the selection (Delete, run the selection) act on what is focused and on nothing it did not see.
  const onFocus = useCallback(() => { if (!pointerPress.current) onSelect?.(node.id, 'preserve'); }, [node.id, onSelect]);
  const onBlur = useCallback(() => { spaceHeld.current = false; }, []);

  const portsWiring = readOnly || simple || interactionLocked ? undefined : wiring;
  const media = node.kind === 'session' && modelChoices?.some(choice => choice.key === modelChoiceKey(node)) ? mediaComposerInfo(node, modelChoices) : undefined;
  const words = t(selected ? 'nodeIcon.labelSelected' : 'nodeIcon.label', { title, kind: kindLabel, state: line.words });
  const tooltip = `${title}\n${line.words}`;
  const tier = nodeIconTier(scale);

  return (
    <div
      className={`canvas-tile awwo-node awwo-node-icon is-${state}${selected ? ' canvas-tile--selected' : ''}${settledMark ? ` is-just-${settledMark}` : ''}`}
      style={{ left: icon.x, top: icon.y, width: icon.w, height: icon.h, '--cv-px': 1 / (scale || 1),
        '--cv-label-w': labelWidth } as CSSProperties}
      data-node-icon={node.id}
      data-kind={node.kind}
      data-state={state}
      data-tier={tier}
      data-testid={`node-icon-${node.id}`}
      title={tooltip}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <svg className="awwo-converged-ring" viewBox="-60 -60 120 120" aria-hidden="true">
        <circle className="awwo-converged-collar" r={52} />
        {state === 'failed' ? <circle className="awwo-converged-keyline" r={52} /> : null}
        <circle className={`awwo-converged-arc is-${running ? 'idle' : state}`} r={52} />
        {/* Still, under reduced motion: a full running ring instead of the arc going round (never a part that reads as
            progress). */}
        {running ? <circle className="awwo-converged-arc is-running awwo-node-icon-still" r={52} /> : null}
      </svg>
      {running ? (
        <svg className="awwo-converged-ring awwo-node-icon-orbit" viewBox="-60 -60 120 120" aria-hidden="true" style={{ animationDelay: phase?.orbit }}>
          <path className="awwo-converged-arc is-running" d={ORBIT_ARC} />
        </svg>
      ) : null}
      <span className="awwo-converged-orb" aria-hidden="true">
        <svg className="awwo-converged-crescent" viewBox="0 0 100 100" aria-hidden="true"><path d={AVATAR_CRESCENT} /></svg>
        <span className="awwo-converged-rim" />
        {agent ? (
          <span className="awwo-node-icon-gaze" style={{ translate: `${gx}% ${gy}%`, animationDelay: phase?.orbit }}>
            <svg className="awwo-converged-face" viewBox="0 0 100 100" data-expression={expression} aria-hidden="true">
              <g className="awwo-converged-eyes awwo-node-icon-eyes" style={{ animationDelay: phase?.blink }}>{AVATAR_FACES[expression].map(drawPart)}</g>
            </svg>
          </span>
        ) : (
          <svg className="awwo-converged-face awwo-node-icon-token" viewBox="0 0 100 100" data-token={node.kind} aria-hidden="true">
            {TOKENS[node.kind as 'form' | 'assemble' | 'edit']}
          </svg>
        )}
      </span>
      <span
        className="awwo-node-icon-hit"
        role="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={words}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      {/* The button's description only (hidden, so a screen reader's reading of the page does not meet it beside every
          icon): its name already says the state and why. */}
      <span id={hintId} hidden>{t('nodeIcon.openHint')}</span>
      <div className="awwo-node-icon-ports" style={{ top: wire.y - icon.y, height: wire.h }}>
        <TilePorts node={wire} wiring={portsWiring} media={media} scale={scale} tabbable={tabbable} />
      </div>
      {tier !== 'S' ? (
        <span className="awwo-converged-label awwo-node-icon-label" aria-hidden="true">
          <span className="awwo-converged-name">{title}</span>
          {tier === 'L' ? <span className="awwo-converged-state"><span className={line.tone ? `is-${line.tone}` : undefined}>{line.text}</span></span> : null}
        </span>
      ) : null}
    </div>
  );
});
