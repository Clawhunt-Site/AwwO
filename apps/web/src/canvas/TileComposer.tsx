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

import { useState, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';

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
  /** An optional card-owned draft survives switching its input/output tabs. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  onSend: (text: string) => void;
}

export function TileComposer({ streaming, blocked = false, blockedReason, draft, onDraftChange, onSend }: TileComposerProps) {
  const [localInput, setLocalInput] = useState('');
  const input = draft ?? localInput;
  const setInput = (value: string) => { setLocalInput(value); onDraftChange?.(value); };
  const disabled = blocked || streaming;

  const send = () => {
    const message = input.trim();
    if (!message || disabled) return;
    setInput('');
    onSend(message);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="canvas-composer">
      {blocked ? (
        <div className="canvas-composer-blocked" data-testid="composer-blocked">
          {blockedReason || COMPOSER_COPY.unbound}
        </div>
      ) : (
        <div className="canvas-composer-notice">{COMPOSER_COPY.notice}</div>
      )}
      <div className="canvas-composer-row">
        <textarea
          className="canvas-composer-input"
          data-testid="composer-input"
          value={input}
          rows={2}
          placeholder={COMPOSER_COPY.placeholder}
          aria-label={COMPOSER_COPY.placeholder}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="canvas-composer-send"
          data-testid="composer-send"
          disabled={disabled || !input.trim()}
          onClick={send}
        >
          {streaming ? <Loader2 size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
          <span>{streaming ? COMPOSER_COPY.sending : COMPOSER_COPY.send}</span>
        </button>
      </div>
    </div>
  );
}
