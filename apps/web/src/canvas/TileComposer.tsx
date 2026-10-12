// The in-tile composer — one turn on THIS tile's own conversation.
//
// Ported from the previous canvas's chat composer (since-deleted apps/web/src/studio/StudioChatBubble.tsx):
// Enter sends, Shift+Enter is a newline, the input and the button are disabled while a stream is
// in flight, and the honest notice stays visible.
//
// That notice is not decoration. Talking to an agent here wakes its FULL worker: it may really go
// do governed work (edit files, open sub-issues, request approvals), and the reply IS that
// execution, not a chatbot answer. The surface says so before the operator types.
//
// An UNBOUND tile cannot send at all. It is disabled with the reason stated — never a live-looking
// box whose message would silently go nowhere.
//
// It is a composite box: files of any type go with the words (the "+" button, a drop or a paste), shown as
// chips and carried as lines at the end of the message (ComposerAttachments.tsx).

import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import { AttachButton, AttachmentTray, useComposerAttachments } from './ComposerAttachments';
import { mediaKindOf, type MediaKind } from './mediaCatalog';
import type { NodeModelChoice } from './NodeModelPicker';

/**
 * What an image, video or 3D node's generator does with attached files: its kind, how many reference pictures the
 * node's model takes (the first picture attached is the one), and the models of that kind that take one.
 */
export interface MediaComposerInfo {
  kind: MediaKind;
  references: number;
  referenceModels: string[];
}

export function mediaComposerInfo(node: { kind: string; agentKind?: string; model?: string }, choices: ReadonlyArray<NodeModelChoice> | undefined): MediaComposerInfo | undefined {
  if (node.kind !== 'session') return undefined;
  const kind = mediaKindOf(node.agentKind ?? '');
  if (!kind) return undefined;
  const all = choices ?? [];
  return {
    kind,
    references: all.find(choice => choice.key === node.model)?.references ?? 0,
    referenceModels: all.filter(choice => (choice.references ?? 0) > 0).map(choice => choice.label),
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
}

/** The notice under a media node's attachments: which picture is used, or why none is. */
function mediaAttachmentNotice(t: ReturnType<typeof useCanvasI18n>['t'], media: MediaComposerInfo): string {
  if (media.references > 0) return t(media.kind === 'model3d' ? 'attach.mediaRef3d' : media.kind === 'video' ? 'attach.mediaRefVideo' : 'attach.mediaRefImage', { count: media.references });
  if (media.referenceModels.length) return t('attach.mediaNoRefs', { models: media.referenceModels.join('、') });
  return t('attach.mediaNote');
}

export function TileComposer({ streaming, blocked = false, blockedReason, sendUnavailableReason, draft, onDraftChange, onSend, deferClear = false, notice, accessory, attachNodeId, mediaNode }: TileComposerProps) {
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

  const send = () => {
    const message = input.trim();
    if (!message || disabled || sendReason || attach.busy) return;
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
    <div className={`canvas-composer${attach.dragging ? ' is-dropping' : ''}`} {...attach.dropProps}>
      {blocked ? (
        <div className="canvas-composer-blocked" data-testid="composer-blocked">
          {blockedReason || t('composer.unbound')}
        </div>
      ) : sendReason ? (
        <div className="canvas-composer-notice" id={reasonId} role="status">{sendReason}</div>
      ) : (
        <div className="canvas-composer-notice">{notice ?? t('composer.notice')}</div>
      )}
      <div className="canvas-composer-box">
        <AttachmentTray state={attach} disabled={disabled} />
        {mediaNode && attach.attachments.length ? <p className="awwo-attachment-notice is-info">{mediaAttachmentNotice(t, mediaNode)}</p> : null}
        <div className="canvas-composer-row">
          <AttachButton state={attach} className="canvas-composer-attach" />
          <textarea
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
      {accessory ? <div className="canvas-composer-accessory">{accessory}</div> : null}
      {blocked ? null : <small id={disclaimerId} className="canvas-composer-disclaimer" title={t('composer.disclaimerFull')}>
        <span aria-hidden="true">{t('composer.disclaimer')}</span><span className="sr-only">{t('composer.disclaimerFull')}</span>
      </small>}
    </div>
  );
}
