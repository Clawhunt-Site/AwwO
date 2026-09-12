// The conversation rendered INSIDE a tile.
//
// Ported from the previous canvas's chat body (since-deleted apps/web/src/studio/StudioChatBubble.tsx), with the
// state removed: the transcript now comes from the module-level session store (./sessions) so it
// survives the tile being culled by the viewport and is shared with the graph run engine.
//
// The honesty invariant this component exists to protect:
//
//   'unreadable' history is NOT 'no history yet'.
//
// A conversation store we could not read renders an explicit notice ("下面只显示本次新消息"),
// visually distinct from the empty state ("还没有对话"). Collapsing the two would tell the
// operator that nothing was ever said when the truth is that we could not find out.

import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HistoryState, Turn } from './sessions';
import { useCanvasI18n } from './i18n';
import { collapseHistoricalInput, collaborationInputSummary, htmlPreviewSummary, readableOutput } from './readableTranscript';
import './readable-transcript.css';

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => <div className="canvas-transcript-table"><table {...props} /></div>,
  // Agent-authored image URLs are references, not permission to contact a remote host.
  // ReactMarkdown applies its existing safe URL transform before passing src here.
  img: ({ alt, src, title }) => typeof src === 'string' && src
    ? <a className="canvas-transcript-image-reference" href={src} title={title} target="_blank" rel="noopener noreferrer">{alt || src}</a>
    : <span className="canvas-transcript-image-reference">{alt}</span>,
};

function RawDetails({ label, text }: { label: string; text: string }) {
  return <details className="canvas-transcript-details">
    <summary>{label}</summary>
    <pre className="canvas-transcript-raw">{text}</pre>
  </details>;
}

function TurnContent({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  const { locale, t } = useCanvasI18n();
  if (turn.role === 'user') {
    if (turn.nativeSource === 'issue_description') {
      return <RawDetails label={t('transcript.conversationContext')} text={turn.text} />;
    }
    const collaboration = collaborationInputSummary(turn, locale);
    if (collaboration) return <>
      <div>{collaboration}</div>
      <RawDetails label={t('transcript.executionDetails')} text={turn.text} />
    </>;
    const presentation = turn.presentation;
    if (presentation?.inputKind === 'legacy-execution') {
      return <RawDetails label={t('transcript.legacyExecution')} text={turn.text} />;
    }
    if (collapseHistoricalInput(turn)) {
      return <RawDetails label={t('transcript.historyMessage')} text={turn.text} />;
    }
    if (presentation?.inputKind === 'workflow') {
      return <>
        <div>{presentation.displayText || t('transcript.workflowRequest')}</div>
        <RawDetails label={t('transcript.executionDetails')} text={turn.text} />
      </>;
    }
    if (presentation?.displayText !== undefined && presentation.displayText !== turn.text) {
      return <>
        <div>{presentation.displayText}</div>
        <RawDetails label={t('transcript.executionDetails')} text={turn.text} />
      </>;
    }
  }
  const output = readableOutput(turn);
  // A complete document is a display shape, not proof that a run or collaboration succeeded.
  const confirmedHtml = turn.presentation?.outputState === 'final'
    && turn.tone !== 'error' && turn.tone !== 'warn' && !output.invalid
    && (!turn.collaboration || turn.collaboration.phase === 'synthesis');
  const htmlSummary = t(confirmedHtml ? 'transcript.htmlReady' : 'transcript.htmlUnconfirmed');
  if (turn.role === 'agent' && htmlPreviewSummary(turn.text, locale)) {
    return <>
      {output.invalid ? <div className="canvas-transcript-format-notice" role="status">{t('transcript.invalidOutput')}</div> : null}
      <div>{htmlSummary}</div>
      <RawDetails label={t('transcript.htmlSource')} text={turn.text} />
    </>;
  }
  if (output.fields.length) {
    return <>
      <div className="canvas-transcript-fields">
        {output.fields.map(({ field, value }) => <section className="canvas-transcript-field" key={field.id}>
          <h3>{field.label || field.id}</h3>
          {field.type === 'html' && htmlPreviewSummary(value, locale)
            ? <div>{htmlSummary}</div>
            : field.type === 'markdown'
            ? <div className="canvas-transcript-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{value}</ReactMarkdown></div>
            : field.type === 'file'
              ? <code className="canvas-transcript-field-value">{value}</code>
              : <div className="canvas-transcript-field-value">{value}</div>}
        </section>)}
      </div>
      <RawDetails label={t('transcript.rawResponse')} text={turn.text} />
    </>;
  }
  return <>
    {output.invalid ? <div className="canvas-transcript-format-notice" role="status">{t('transcript.invalidOutput')}</div> : null}
    {/* Only an actual empty in-flight agent turn receives the waiting placeholder. */}
    {turn.text || (turn.role === 'agent' && streaming ? t('transcript.thinking') : '')}
  </>;
}

export const TRANSCRIPT_COPY = {
  /** Reading the stored transcript FAILED — deliberately distinct from an empty transcript. */
  unreadable: '（无法读取历史对话，下面只显示本次新消息）',
  loading: '正在读取历史对话…',
  empty: '还没有对话。发第一条消息，唤醒这个 agent。',
  thinking: '已投递，等待 agent 启动…',
} as const;

export interface TileTranscriptProps {
  turns: ReadonlyArray<Turn>;
  history: HistoryState;
  streaming: boolean;
  /** How many trailing turns to render (Infinity at focus LOD — see ./lod TAIL_LINES). */
  limit: number;
  /** Raw status note from the gateway, shown while a run is in flight. */
  status?: string | null;
  /** Auto-scroll to the newest turn. Off for the tiers that render a fixed tail. */
  autoScroll?: boolean;
  renderTurnDetails?: (turn: Turn, latest: boolean) => ReactNode;
}

export function TileTranscript({ turns, history, streaming, limit, status = null, autoScroll = false, renderTurnDetails }: TileTranscriptProps) {
  const { t } = useCanvasI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const shown = Number.isFinite(limit) ? turns.slice(Math.max(0, turns.length - limit)) : turns;
  // Failed restored runs may have only their accepted user message. Keep one details slot per
  // run, preferring its agent reply when present; message text is not a durable identity.
  const detailOwners = new Map<string, number>();
  shown.forEach((turn, index) => {
    if (!turn.runId || turn.role === 'system') return;
    const owner = detailOwners.get(turn.runId);
    if (turn.role === 'agent' || owner === undefined || shown[owner].role !== 'agent') {
      detailOwners.set(turn.runId, index);
    }
  });

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    // jsdom implements neither scrollTo nor real layout; guard both so a test environment (and any
    // engine without smooth scrolling) degrades to a plain assignment instead of throwing.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
    else el.scrollTop = el.scrollHeight;
  }, [turns, autoScroll]);

  return (
    <div className="canvas-transcript">
      {history === 'unreadable' ? (
        <div className="canvas-transcript-notice" data-testid="transcript-unreadable">
          {t('transcript.unreadable')}
        </div>
      ) : null}
      <div className="canvas-transcript-scroll" ref={scrollRef} data-testid="transcript-scroll">
        {shown.length === 0 ? (
          history === 'loading' ? (
            <div className="canvas-transcript-loading">{t('transcript.loading')}</div>
          ) : history === 'unreadable' ? null : (
            <div className="canvas-transcript-empty" data-testid="transcript-empty">
              {t('transcript.empty')}
            </div>
          )
        ) : (
          shown.map((turn, index) => (
            <Fragment key={turn.id}>
            <div
              key={turn.id}
              className={`canvas-transcript-turn canvas-transcript-turn--${turn.role}${turn.tone ? ` is-${turn.tone}` : ''}`}
            >
              <TurnContent turn={turn} streaming={streaming} />
            </div>
            {(turn.runId ? detailOwners.get(turn.runId) === index : turn.role === 'agent')
              && renderTurnDetails?.(turn, index === shown.length - 1)}
            </Fragment>
          ))
        )}
      </div>
      {streaming && status ? <div className="canvas-transcript-status">{status}</div> : null}
    </div>
  );
}
