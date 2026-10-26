// RerunConfirm — asked before a run of the whole canvas runs nodes again that already have their result.
//
// A paying user pressed 运行 on a canvas whose nodes had all finished but one, and every node ran again, each a paid
// call, each result replaced (2026-10-25). The run button, the 成果 view, the command bar and 「运行」 in the assistant
// now ask first when that would happen (wholeRunChoice, nextSteps.ts): run only the nodes without a result and what
// they feed, as 「运行剩下的节点」 does, or every node again, each with what it spends; or neither.
//
// It is a modal <dialog> inside the workspace, whose colours are set on .awwo-workspace (portalled to the body it would
// lose a chosen look), and outside .canvas-root, which turns inert under the 成果 view. Keys pressed in it stay in it:
// the board's shortcuts (Delete, Ctrl+Z, …) listen on the window. Enter held down on the control that opened it would
// go on to click its first choice, so its repeats are refused (heldEnter.ts).

import { useEffect, useId, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { refuseHeldEnter } from './heldEnter';
import { useCanvasI18n } from './i18n';
import type { WholeRunChoice } from './nextSteps';
import './rerunConfirm.css';

type Cost = { calls: number; generations?: number };

export interface RerunConfirmProps {
  choice: WholeRunChoice;
  /** The canvas changed while the question was open, and it is asked again as things now stand. */
  changed?: boolean;
  /** A node's title, for the nodes with a result the question names. */
  titleOf: (nodeId: string) => string;
  /** A choice's label with what it spends, as the 接下来 card words a step's (the host leaves the cost out where it
   *  counts no calls). */
  withCost: (label: string, cost: Cost) => string;
  onRest: () => void;
  onWhole: () => void;
  onCancel: () => void;
}

/** How many of the nodes with a result are named before the others are only counted. */
const NAMED = 3;
/** How long the choices of a question asked again take no press: longer than a double click's second press. */
const RE_ASK_PAUSE_MS = 700;

export function RerunConfirm({ choice, changed = false, titleOf, withCost, onRest, onWhole, onCancel }: RerunConfirmProps) {
  const { locale, t } = useCanvasI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  // The safe choice takes the focus: running only what is left, or, where that is not offered, not running.
  const first = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const titleId = useId();
  const bodyId = useId();
  const hintId = useId();
  // Until when, asked again, its choices take no press.
  const shield = useRef(0);
  // When the press that its next click ends began: one begun before the pause ended is no fresh answer, whenever it is
  // let go. A pointer's press ends with its click; an Enter or a Space lasts until it is let go, its repeats included
  // (Space clicks as it comes up). A click with no press before it (a screen reader's) counts once the pause is over.
  const pointerAt = useRef<number | null>(null);
  // Each key held down (Enter, Space) from when it went down: one let go leaves the other held.
  const keysAt = useRef(new Map<string, number>());
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Where the control that opened it is gone when it closes (the command bar closes as its command runs), the
    // canvas's run button takes the focus back.
    const runButton = element.closest('.awwo-workspace')?.querySelector<HTMLElement>('.awwo-run-slot .canvas-run-btn') ?? null;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    first.current?.focus();
    // Opened by Enter on 运行 or in the assistant's box, that key may still be down.
    refuseHeldEnter({ detail: 0 });
    // Tab goes round its buttons: past the last one Chrome hands the focus to the page's body, where a key would reach
    // the board's shortcuts (Delete would delete the selection behind it). A key aimed at the page, not at it or at
    // another dialog opened over it (a sign-in, say), is kept from them too, and a focus that lands on the page is
    // taken back.
    const onPage = (target: EventTarget | null) => !(target instanceof Element && target.closest('dialog[open]'));
    const keydown = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (event.key === 'Tab' && (element.contains(active) || onPage(active))) {
        const controls = Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled])'));
        const inside = element.contains(active);
        if (event.shiftKey && (!inside || active === controls[0])) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && (!inside || active === controls.at(-1))) { event.preventDefault(); controls[0]?.focus(); }
      }
      if (onPage(event.target)) event.stopPropagation();
    };
    const focusin = (event: FocusEvent) => { if (onPage(event.target)) first.current?.focus(); };
    // A key held down is let go wherever that happens, after the click it ends (Space clicks as it comes up); one let go
    // in another window never comes back, so the window losing the focus lets every press go.
    const keyup = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') setTimeout(() => keysAt.current.delete(event.key), 0); };
    const blur = () => { keysAt.current.clear(); pointerAt.current = null; };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', blur);
      if (element.open && typeof element.close === 'function') element.close();
      const usable = (target: HTMLElement | null) => Boolean(target?.isConnected && target !== document.body && !target.closest('[inert]'));
      if (usable(previous)) previous!.focus();
      else if (usable(runButton)) runButton!.focus();
    };
  }, []);
  // Asked again with what changed, it takes a fresh answer: the press that found the change must not go on to accept
  // the new question (an Enter held down repeats; a double click's second press lands a moment later), so the focus
  // goes to the safe choice, a held Enter is refused again, and its choices take no press for a moment.
  useEffect(() => {
    if (!changed) return;
    shield.current = Date.now() + RE_ASK_PAUSE_MS;
    first.current?.focus();
    refuseHeldEnter({ detail: 0 });
  }, [choice, changed]);
  // A double click's second click (detail 2) is no answer either.
  const answer = (choose: () => void) => (event: ReactMouseEvent) => {
    const began = keysAt.current.size ? Math.min(...keysAt.current.values()) : pointerAt.current;
    pointerAt.current = null;
    if (event.detail > 1 || Date.now() < shield.current || (began !== null && began < shield.current)) return;
    // The focus goes back to 运行图 (now ■ 停止) as it closes: an Enter that answered, still held, must not press it.
    refuseHeldEnter(event);
    choose();
  };
  const { finished, cleared, left, rest } = choice;
  const quote = (title: string) => locale === 'zh' ? `「${title}」` : `“${title}”`;
  const list = (ids: ReadonlyArray<string>) => ids.slice(0, NAMED).map(id => quote(titleOf(id))).join(locale === 'zh' ? '、' : ', ')
    + (ids.length > NAMED ? t('rerun.more', { count: ids.length - NAMED }) : '');
  const names = list(finished);
  // The body takes the padding, so a press on the dialog element itself is a press on its backdrop.
  return <dialog ref={dialog} className="awwo-rerun-dialog" aria-labelledby={titleId} aria-describedby={bodyId}
    onCancel={event => { event.preventDefault(); cancel.current(); }}
    onPointerDownCapture={() => { pointerAt.current = Date.now(); }}
    onKeyDownCapture={event => { if ((event.key === 'Enter' || event.key === ' ') && !keysAt.current.has(event.key)) keysAt.current.set(event.key, Date.now()); }}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) cancel.current(); }}>
    <div className="awwo-rerun-body">
      <h2 id={titleId}>{t(left ? 'rerun.title' : 'rerun.titleAll')}</h2>
      {changed && <p className="awwo-rerun-changed" role="status">{t('rerun.changed')}</p>}
      <p id={bodyId}>{left ? t('rerun.body', { count: finished.length, names }) : t('rerun.bodyAll')}</p>
      {/* On this device a whole run clears what only a cloud run makes (an edit, a file) and cannot make it again. */}
      {cleared.length > 0 && <p className="awwo-rerun-cleared">{t('rerun.cleared', { names: list(cleared) })}</p>}
      <div className="awwo-rerun-actions">
        {rest && <button ref={first} type="button" className="awwo-primary" aria-describedby={rest.after ? hintId : undefined} onClick={answer(onRest)}>
          {withCost(t('rerun.rest', { count: rest.nodeIds.length }), rest)}</button>}
        {rest && rest.after > 0 && <p id={hintId} className="awwo-rerun-hint">{t('rerun.restAfter', { count: rest.after })}</p>}
        <button type="button" className={rest ? 'awwo-secondary' : 'awwo-primary'} onClick={answer(onWhole)}>{withCost(t('rerun.whole'), choice.whole)}</button>
        <button ref={rest ? undefined : first} type="button" className="awwo-secondary" onClick={event => { refuseHeldEnter(event); onCancel(); }}>{t('common.cancel')}</button>
      </div>
    </div>
  </dialog>;
}
