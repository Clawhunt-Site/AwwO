// The in-tile composer — one turn on THIS tile's own conversation.
//
// Ported from the previous canvas's chat composer (since-deleted apps/web/src/studio/StudioChatBubble.tsx):
// Enter sends, Shift+Enter is a newline, the input and the button are disabled while a stream is
// in flight, and the honest notice is one click away, in 用户须知 beside the model. A box that had
// the keyboard's focus when it locked gets it back when the work ends (useFocusBackOnUnlock).
//
// That notice is not decoration. Talking to an agent here wakes its FULL worker: it may really go
// do governed work (edit files, open sub-issues, request approvals), and the reply IS that
// execution, not a chatbot answer. 用户须知 says so, with the notice against sensitive data, which is
// also the input's description for a screen reader.
//
// An UNBOUND tile cannot send at all. It is disabled with the reason stated — never a live-looking
// box whose message would silently go nowhere.
//
// It is a composite box: files of any type go with the words (the "+" button, a drop or a paste), shown as
// chips and carried as lines at the end of the message (ComposerAttachments.tsx).

import { useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import { AttachButton, AttachmentTray, useComposerAttachments } from './ComposerAttachments';
import { ComposerNotes } from './ComposerNotes';
import { mediaKindOf, type MediaKind } from './mediaCatalog';
import type { NodeModelChoice } from './NodeModelPicker';

/**
 * What an image, video or 3D node's generator does with attached files: its kind, how many reference pictures the
 * node's model takes (the first picture attached is the one), and the models of that kind that take one. A video node
 * also says how many voices wired into its `audio` input its model lip-syncs to, and the video models that take any.
 */
export interface MediaComposerInfo {
  kind: MediaKind;
  references: number;
  referenceModels: string[];
  /** Every picture is a subject reference, a single one included (never the video's first frame). */
  subjects?: boolean;
  /** A video node: how many voices its model takes as voice references (0: none). */
  audioReferences?: number;
  /** A video node: the video models that take voice references. */
  audioReferenceModels?: string[];
}

export function mediaComposerInfo(node: { kind: string; agentKind?: string; model?: string }, choices: ReadonlyArray<NodeModelChoice> | undefined): MediaComposerInfo | undefined {
  if (node.kind !== 'session') return undefined;
  const kind = mediaKindOf(node.agentKind ?? '');
  if (!kind) return undefined;
  const all = choices ?? [];
  const current = all.find(choice => choice.key === node.model);
  return {
    kind,
    references: current?.references ?? 0,
    referenceModels: all.filter(choice => (choice.references ?? 0) > 0).map(choice => choice.label),
    ...(current?.subjectReferences && (current.references ?? 0) > 0 ? { subjects: true } : {}),
    // Only a video node has an `audio` input to say this of.
    ...(kind === 'video' ? { audioReferences: current?.audioReferences ?? 0,
      audioReferenceModels: all.filter(choice => (choice.audioReferences ?? 0) > 0).map(choice => choice.label) } : {}),
  };
}

export const COMPOSER_COPY = {
  notice:
    'Agent 将按已配置的权限执行任务。',
  placeholder: '给这个 Agent 发消息…',
  send: '发送',
  sending: '运行中…',
  unbound: '本节点尚未绑定真实 Agent，无法对话。',
} as const;

export interface TileComposerProps {
  /** True while this tile's stream is live — sending again would supersede it. */
  streaming: boolean;
  /** Hard block (e.g. the tile is not bound to a real agent). `blockedReason` says why. */
  blocked?: boolean;
  blockedReason?: string;
  /** A temporary execution prerequisite disables sending while leaving the draft editable. */
  sendUnavailableReason?: string;
  /** An optional card-owned draft survives switching its input/output tabs. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  onSend: (text: string, onAccepted?: () => void) => void;
  /** The host acknowledges only after the message has a durable execution record. */
  deferClear?: boolean;
  notice?: string;
  /** Shown under the input, like a chat app's model switch. */
  accessory?: ReactNode;
  /** The node files are attached on (provenance only). */
  attachNodeId?: string;
  /** An image, video or 3D node: what its generator does with attached files, which the box says when files are attached. */
  mediaNode?: MediaComposerInfo;
  /** For the node's starter prompts, which are drawn outside the box. */
  ref?: Ref<TileComposerHandle>;
}

/** What the node around the composer may write into it. */
export interface TileComposerHandle {
  /** Adds a prompt after the words the box shows, a blank line between. Through the box, which keeps its files: one that
   *  has just landed too, whose answer is not drawn yet (useComposerAttachments). */
  addPrompt: (prompt: string) => void;
}

/** The notice under a media node's attachments: which picture is used, or why none is. */
function mediaAttachmentNotice(t: ReturnType<typeof useCanvasI18n>['t'], media: MediaComposerInfo): string {
  if (media.references > 0) {
    const voices = media.kind === 'video' ? media.audioReferences ?? 0 : 0;
    const subjects = voices > 0 ? 'attach.mediaRefSubjectsVoices' : 'attach.mediaRefSubjects';
    const key = media.kind === 'model3d' ? 'attach.mediaRef3d' : media.kind === 'video' ? (media.subjects ? subjects : 'attach.mediaRefVideo') : 'attach.mediaRefImage';
    return t(key, { count: media.references, voices });
  }
  if (media.referenceModels.length) return t('attach.mediaNoRefs', { models: media.referenceModels.join('、') });
  return t('attach.mediaNote');
}

/**
 * Calls `away` when the reader turns from the composer: a press or a focus outside it; a key that takes them elsewhere
 * (Escape, Tab, or the canvas's camera keys as useCanvasKeys reads them: Ctrl/⌘ with a digit recalls a waypoint, with 0
 * fits all, with Shift and a digit from 1 to 9 only saves one); a wheel outside its node, which moves the canvas or scrolls something
 * else (over its own opened node a wheel scrolls it); or the focus gone into a frame, a preview, which gives the page no
 * focusin. Typing, editing chords and the browser's own keys do not count (AltGr's digits do: the canvas moves its camera
 * for them). Listens in the capture phase, as a press on a node stops at its tile. Returns the cleanup. `cameraKeys:
 * false` leaves the camera keys to the caller (the assistant's panel counts them as the canvas takes them).
 */
export function watchReaderAway(composer: HTMLElement, away: () => void, { cameraKeys = true }: { cameraKeys?: boolean } = {}): () => void {
  const node = composer.closest('.canvas-tile') ?? composer;
  const outside = (event: Event, scope: Element) => !(event.target instanceof Node && scope.contains(event.target));
  const onPress = (event: Event) => { if (outside(event, composer)) away(); };
  const onKey = (event: DocumentEventMap['keydown']) => {
    const camera = cameraKeys && (event.ctrlKey || event.metaKey) && ((/^Digit[1-9]$/.test(event.code) && !event.shiftKey) || event.code === 'Digit0' || event.key === '0');
    if ((camera || event.key === 'Escape' || event.key === 'Tab') && outside(event, composer)) away();
  };
  const onWheel = (event: Event) => { if (outside(event, node)) away(); };
  const onBlur = () => { if (document.activeElement instanceof HTMLIFrameElement) away(); };
  const options = { capture: true, passive: true };
  document.addEventListener('pointerdown', onPress, options);
  document.addEventListener('focusin', onPress, options);
  document.addEventListener('keydown', onKey, options);
  document.addEventListener('wheel', onWheel, options);
  window.addEventListener('blur', onBlur);
  return () => {
    document.removeEventListener('pointerdown', onPress, options);
    document.removeEventListener('focusin', onPress, options);
    document.removeEventListener('keydown', onKey, options);
    document.removeEventListener('wheel', onWheel, options);
    window.removeEventListener('blur', onBlur);
  };
}

/** A phone or a tablet, where the box's keyboard would come up over the reply just in. */
function touchFirst(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * The box is disabled while its node works (a reply streaming in, a run of it), and a browser then drops the keyboard's
 * focus to the page; nothing would bring it back. So a composer that held the focus when it locked gives it to its box
 * when it unlocks, unless the focus is somewhere by then or the reader turned elsewhere meanwhile (watchReaderAway: the
 * reply, to copy from it; the canvas; another node; the assistant): a focus the reader moved is never taken from them.
 * Both ends are read in the commit that changes `locked`: when it locks the browser has not dropped the focus yet, and
 * when it unlocks the box is enabled already, so no frame comes between (CanvasSurface's `refocus` had that race).
 * Nothing is moved on a touch-first device (touchFirst).
 */
function useFocusBackOnUnlock(composer: RefObject<HTMLElement | null>, box: RefObject<HTMLTextAreaElement | null>, locked: boolean) {
  const lockedWithFocus = useRef(false);
  useLayoutEffect(() => {
    if (locked) { lockedWithFocus.current = Boolean(composer.current?.contains(document.activeElement)); return; }
    const active = document.activeElement;
    // Lost: on the page, gone, or left on a control of the composer that is still disabled (as a browser may keep it).
    const lost = !active || active === document.body || !active.isConnected || (Boolean(composer.current?.contains(active)) && active.matches(':disabled'));
    // A selection the reader made meanwhile would go with the focus.
    const selecting = !(document.getSelection()?.isCollapsed ?? true);
    // The canvas under the node must not move to show the box.
    if (lockedWithFocus.current && lost && !selecting && !touchFirst()) box.current?.focus({ preventScroll: true });
    lockedWithFocus.current = false;
  }, [locked, composer, box]);
  useLayoutEffect(() => {
    const element = composer.current;
    if (!locked || !element) return undefined;
    return watchReaderAway(element, () => { lockedWithFocus.current = false; });
  }, [locked, composer]);
}

export function TileComposer({ streaming, blocked = false, blockedReason, sendUnavailableReason, draft, onDraftChange, onSend, deferClear = false, notice, accessory, attachNodeId, mediaNode, ref }: TileComposerProps) {
  const { t } = useCanvasI18n();
  const reasonId = useId();
  const disclaimerId = useId();
  const [localInput, setLocalInput] = useState('');
  const input = draft ?? localInput;
  const setInput = (value: string) => { setLocalInput(value); onDraftChange?.(value); };
  const disabled = blocked || streaming;
  const sendReason = !blocked ? sendUnavailableReason?.trim() || undefined : undefined;
  const attach = useComposerAttachments({ value: input, onChange: setInput, nodeId: attachNodeId, disabled });
  const waitReason = attach.busy ? t('attach.waiting') : undefined;
  const { setBody } = attach;
  useImperativeHandle(ref, () => ({ addPrompt: prompt => setBody(body => body ? `${body}\n\n${prompt}` : prompt) }), [setBody]);
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useFocusBackOnUnlock(composerRef, inputRef, disabled);

  const send = () => {
    const message = input.trim();
    if (!message || disabled || sendReason || attach.busy) return;
    // Sent with the button, the conversation goes on in the box: the button, which an empty box disables, keeps no focus
    // to lose (and Safari gives a pressed button none). Not on a phone or a tablet, whose keyboard would come up.
    if (document.activeElement !== inputRef.current && !touchFirst()) inputRef.current?.focus({ preventScroll: true });
    const sent = () => { setInput(''); attach.markSent(); };
    if (deferClear) onSend(message, sent);
    else { sent(); onSend(message); }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div ref={composerRef} className={`canvas-composer${attach.dragging ? ' is-dropping' : ''}`} {...attach.dropProps}>
      {blocked ? (
        <div className="canvas-composer-blocked" data-testid="composer-blocked">
          {blockedReason || t('composer.unbound')}
        </div>
      ) : sendReason ? (
        <div className="canvas-composer-notice" id={reasonId} role="status">{sendReason}</div>
      ) : null}
      <div className="canvas-composer-box">
        <AttachmentTray state={attach} disabled={disabled} />
        {mediaNode && attach.attachments.length ? <p className="awwo-attachment-notice is-info">{mediaAttachmentNotice(t, mediaNode)}</p> : null}
        <div className="canvas-composer-row">
          <AttachButton state={attach} className="canvas-composer-attach" />
          <textarea
            ref={inputRef}
            className="canvas-composer-input"
            data-testid="composer-input"
            value={attach.body}
            rows={2}
            placeholder={t('composer.placeholder')}
            aria-label={t('composer.placeholder')}
            aria-describedby={blocked ? undefined : disclaimerId}
            disabled={disabled}
            onChange={(e) => attach.setBody(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={attach.onPaste}
          />
          <button
            type="button"
            className="canvas-composer-send"
            data-testid="composer-send"
            disabled={disabled || Boolean(sendReason) || attach.busy || !input.trim()}
            title={sendReason ?? waitReason}
            aria-label={sendReason ? `${t('composer.send')}：${sendReason}` : waitReason ? `${t('composer.send')}：${waitReason}` : undefined}
            aria-describedby={sendReason ? reasonId : undefined}
            onClick={send}
          >
            {streaming ? <Loader2 size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
            <span>{t(streaming ? 'composer.sending' : 'composer.send')}</span>
          </button>
        </div>
      </div>
      {/* The model on the left, 用户须知 on the right: the standing notices are no longer printed around the box. */}
      {accessory || !blocked ? <div className="canvas-composer-accessory">
        {accessory}
        {blocked ? null : <ComposerNotes className="canvas-composer-notes" notes={[notice ?? t('composer.notice'), t('composer.disclaimerFull')]} />}
      </div> : null}
      {blocked ? null : <p id={disclaimerId} className="sr-only">{t('composer.disclaimerFull')}</p>}
    </div>
  );
}
