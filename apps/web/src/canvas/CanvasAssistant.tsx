import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Loader2, Square, Undo2, X } from 'lucide-react';
import './canvas-assistant.css';
import { useCanvasI18n } from './i18n';

export interface CanvasAssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'applied' | 'error' | 'stale';
}

export interface CanvasAssistantProps {
  mode: 'welcome' | 'panel';
  messages: CanvasAssistantMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  busy: boolean;
  error?: string;
  onSend: () => void;
  onCancel: () => void;
  onClose?: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
  runtimeControls?: ReactNode;
}

/** Presentation only: the host owns requests, applying changes, drafts and undo history. */
export function CanvasAssistant({ mode, messages, draft, onDraftChange, busy, error, onSend, onCancel,
  onClose, onUndo, canUndo = false, runtimeControls }: CanvasAssistantProps) {
  const { t } = useCanvasI18n();
  const examples = [t('assistant.exampleSaas'), t('assistant.exampleData'), t('assistant.exampleContent')];
  const welcome = mode === 'welcome';
  const sendLabel = t(welcome ? 'assistant.generate' : 'assistant.modify');
  const errorId = useId();
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const canSend = !busy && Boolean(draft.trim());
  const lastMessage = messages.at(-1);
  useEffect(() => {
    // Scroll only the conversation region, never the surrounding canvas or page.
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages.length, lastMessage?.content, lastMessage?.status, busy]);

  const send = () => { if (canSend) onSend(); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    send();
  };

  return <section className={`awwo-canvas-assistant awwo-canvas-assistant--${mode}`} aria-label={t('assistant.panelTitle')}>
    <header className="awwo-assistant-header">
      {welcome ? <h1>{t('assistant.title')}</h1> : <h2>{t('assistant.panelTitle')}</h2>}
      {!welcome && onClose ? <button type="button" className="awwo-assistant-icon-button" aria-label={t('assistant.close')} onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button> : null}
    </header>

    {(!welcome || messages.length > 0) && <div ref={log} className="awwo-assistant-messages" role="log" aria-label={t('assistant.conversation')} aria-live="polite" aria-relevant="additions text">
      {messages.length ? <ol>
        {messages.map(message => <li className={`awwo-assistant-message awwo-assistant-message--${message.role}`} key={message.id}>
          <p role={message.status === 'error' ? 'alert' : undefined}>{message.content}</p>
          {message.status === 'applied' ? <span className="awwo-assistant-message-status" role="status">{t('assistant.applied')}</span>
            : message.status === 'stale' ? <span className="awwo-assistant-message-status is-stale" role="alert">{t('assistant.stale')}</span> : null}
        </li>)}
      </ol> : <p className="awwo-assistant-empty">{t('assistant.empty')}</p>}
    </div>}

    <div className="awwo-assistant-composer-block">
      {error ? <p className="awwo-assistant-error" role="alert" id={errorId}>{error}</p> : null}
      {runtimeControls ? <div className="awwo-assistant-runtime">{runtimeControls}</div> : null}
      <form className="awwo-assistant-composer" aria-label={t('assistant.form')} onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={input} aria-label={t('assistant.input')} aria-describedby={error ? errorId : undefined}
          placeholder={t(welcome ? 'assistant.welcomePlaceholder' : 'assistant.panelPlaceholder')}
          value={draft} disabled={busy} rows={3} maxLength={8000}
          onChange={event => onDraftChange(event.target.value)} onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
        {busy ? <div className="awwo-assistant-progress" role="status">
          <Loader2 size={14} aria-hidden="true" />{t(welcome ? 'assistant.generating' : 'assistant.modifying')}
        </div> : null}
        <div className="awwo-assistant-composer-actions">
          {busy ? <button type="button" className="awwo-assistant-cancel" onClick={onCancel}><Square size={12} aria-hidden="true" />{t('assistant.cancel')}</button> : null}
          <button type="submit" className="awwo-assistant-send" disabled={!canSend}><span>{sendLabel}</span><ArrowUp size={15} aria-hidden="true" /></button>
        </div>
      </form>
      {onUndo ? <button type="button" className="awwo-assistant-undo" disabled={busy || !canUndo} onClick={onUndo}>
        <Undo2 size={14} aria-hidden="true" />{t('assistant.undo')}
      </button> : null}
    </div>

    {welcome ? <div className="awwo-assistant-examples" role="group" aria-label={t('assistant.examples')}>
      {examples.map(example => <button type="button" key={example} disabled={busy}
        onClick={() => { onDraftChange(example); input.current?.focus(); }}>{example}</button>)}
    </div> : null}
  </section>;
}
