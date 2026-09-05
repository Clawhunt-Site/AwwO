import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Loader2, Square, Undo2, X } from 'lucide-react';
import './canvas-assistant.css';

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

const EXAMPLES = [
  '做一个有用户登录、权限和数据看板的SaaS产品',
  '搭建一套从数据清洗、质量校验到分析报告的数据流程',
  '为新产品建立从品牌文案、视觉素材到交付验收的内容流程',
];

/** Presentation only: the host owns requests, applying changes, drafts and undo history. */
export function CanvasAssistant({ mode, messages, draft, onDraftChange, busy, error, onSend, onCancel,
  onClose, onUndo, canUndo = false, runtimeControls }: CanvasAssistantProps) {
  const welcome = mode === 'welcome';
  const sendLabel = welcome ? '生成画布' : '修改画布';
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

  return <section className={`awwo-canvas-assistant awwo-canvas-assistant--${mode}`} aria-label="画布助手">
    <header className="awwo-assistant-header">
      {welcome ? <h1>想一起搭建什么？</h1> : <h2>画布助手</h2>}
      {!welcome && onClose ? <button type="button" className="awwo-assistant-icon-button" aria-label="关闭画布助手" onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button> : null}
    </header>

    {(!welcome || messages.length > 0) && <div ref={log} className="awwo-assistant-messages" role="log" aria-label="画布对话" aria-live="polite" aria-relevant="additions text">
      {messages.length ? <ol>
        {messages.map(message => <li className={`awwo-assistant-message awwo-assistant-message--${message.role}`} key={message.id}>
          <p role={message.status === 'error' ? 'alert' : undefined}>{message.content}</p>
          {message.status === 'applied' ? <span className="awwo-assistant-message-status" role="status">已更新画布</span>
            : message.status === 'stale' ? <span className="awwo-assistant-message-status is-stale" role="alert">画布已有新改动，请重新生成</span> : null}
        </li>)}
      </ol> : <p className="awwo-assistant-empty">描述想调整的结构，也可以直接编辑画布。</p>}
    </div>}

    <div className="awwo-assistant-composer-block">
      {error ? <p className="awwo-assistant-error" role="alert" id={errorId}>{error}</p> : null}
      {runtimeControls ? <div className="awwo-assistant-runtime">{runtimeControls}</div> : null}
      <form className="awwo-assistant-composer" aria-label="画布需求表单" onSubmit={event => { event.preventDefault(); send(); }}>
        <textarea ref={input} aria-label="画布需求" aria-describedby={error ? errorId : undefined}
          placeholder={welcome ? '描述你的目标、需要的能力和交付结果…' : '描述你想调整的结构…'}
          value={draft} disabled={busy} rows={3} maxLength={8000}
          onChange={event => onDraftChange(event.target.value)} onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
        {busy ? <div className="awwo-assistant-progress" role="status">
          <Loader2 size={14} aria-hidden="true" />{welcome ? '正在生成画布…' : '正在修改画布…'}
        </div> : null}
        <div className="awwo-assistant-composer-actions">
          {busy ? <button type="button" className="awwo-assistant-cancel" onClick={onCancel}><Square size={12} aria-hidden="true" />取消</button> : null}
          <button type="submit" className="awwo-assistant-send" disabled={!canSend}><span>{sendLabel}</span><ArrowUp size={15} aria-hidden="true" /></button>
        </div>
      </form>
      {onUndo ? <button type="button" className="awwo-assistant-undo" disabled={busy || !canUndo} onClick={onUndo}>
        <Undo2 size={14} aria-hidden="true" />撤销本次更改
      </button> : null}
    </div>

    {welcome ? <div className="awwo-assistant-examples" role="group" aria-label="需求示例">
      {EXAMPLES.map(example => <button type="button" key={example} disabled={busy}
        onClick={() => { onDraftChange(example); input.current?.focus(); }}>{example}</button>)}
    </div> : null}
  </section>;
}
