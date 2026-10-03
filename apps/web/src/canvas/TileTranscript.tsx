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

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HistoryState, Turn } from './sessions';
import { useCanvasI18n } from './i18n';
import { collapseHistoricalInput, collaborationInputSummary, htmlPreviewSummary, readableOutput } from './readableTranscript';
import { WorkingDots, WorkingTimer } from './WorkingIndicator';
import './readable-transcript.css';
import { fileSafeDisplaySource } from './fileDeliveryPresentation';
import { PendingFileDelivery } from './PendingFileDelivery';
import { storedArtifactUrl } from '../saas/canvasBridge';
import { parseMediaOutput } from './mediaOutput';
import { MediaResult } from './MediaResult';

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => <div className="canvas-transcript-table"><table {...props} /></div>,
  // Agent-authored image URLs are references, not permission to contact a remote host.
  // ReactMarkdown applies its existing safe URL transform before passing src here.
  img: ({ alt, src, title }) => typeof src === 'string' && src
    ? <a className="canvas-transcript-image-reference" href={src} title={title} target="_blank" rel="noopener noreferrer">{alt || src}</a>
    : <span className="canvas-transcript-image-reference">{alt}</span>,
};

function RawDetails({ label, text }: { label: string; text: string }) {
  const { locale } = useCanvasI18n();
  const display = fileSafeDisplaySource(text);
  return <details className="canvas-transcript-details">
    <summary>{label}{display === text ? '' : locale === 'zh' ? '（文件内容已隐藏）' : ' (attachment content omitted)'}</summary>
    <pre className="canvas-transcript-raw">{display}</pre>
  </details>;
}

function TurnContent({ turn, mediaResults }: { turn: Turn; mediaResults: boolean }) {
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
  // An image or video node's result names stored files; show them, not the record. Only such a
  // node's turns are read this way: a text agent cannot present stored media as its own result.
  const media = mediaResults && turn.role === 'agent' && turn.tone !== 'error' && turn.tone !== 'warn' ? parseMediaOutput(turn.text) : null;
  if (media) return <MediaResult output={media} />;
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
        {output.fields.map(({ field, value, pendingFile }) => <section className="canvas-transcript-field" key={field.id}>
          <h3>{field.label || field.id}</h3>
          {pendingFile ? <PendingFileDelivery file={pendingFile} /> : field.type === 'html' && htmlPreviewSummary(value, locale)
            ? <div>{htmlSummary}</div>
            : field.type === 'markdown'
            ? <div className="canvas-transcript-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{fileSafeDisplaySource(value)}</ReactMarkdown></div>
            : field.type === 'file'
              ? storedArtifactUrl(value) ? <a href={storedArtifactUrl(value)!} download rel="noreferrer">{t('deliverable.downloadFile')}</a>
                : <code className="canvas-transcript-field-value">{value}</code>
              : <div className="canvas-transcript-field-value">{fileSafeDisplaySource(value)}</div>}
        </section>)}
      </div>
      <RawDetails label={t('transcript.rawResponse')} text={turn.text} />
    </>;
  }
  // Ordinary agent prose uses the same safe Markdown surface as published fields. Raw
  // transport envelopes and failure evidence remain verbatim rather than being prettified.
  let rawEnvelope = /^\s*(?:\{|\[\s*(?:\{|\[)|```(?:json)?\s*[\[{])/i.test(turn.text);
  if (!rawEnvelope && turn.text.trimStart().startsWith('[')) {
    try { rawEnvelope = Array.isArray(JSON.parse(turn.text)); } catch { /* A Markdown link is ordinary prose. */ }
  }
  const prose = turn.role === 'agent' && Boolean(turn.text) && !output.invalid && !rawEnvelope
    && turn.tone !== 'error' && turn.tone !== 'warn' && turn.presentation?.outputState !== 'failed';
  return <>
    {output.invalid ? <div className="canvas-transcript-format-notice" role="status">{t('transcript.invalidOutput')}</div> : null}
    {prose
      ? <div className="canvas-transcript-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{fileSafeDisplaySource(turn.text)}</ReactMarkdown></div>
      : fileSafeDisplaySource(turn.text)}
  </>;
}

/** The one live line while a run is in flight: what it is doing, and for how long. A polite live
 *  region rather than role=status: the tile's composer already owns its status landmark. */
function TurnPresence({ label, since }: { label: string; since?: number }) {
  return <div className="canvas-transcript-presence" data-testid="transcript-presence">
    <WorkingDots />
    <span className="canvas-transcript-presence-label" aria-live="polite">{label}</span>
    {since ? <WorkingTimer since={since} /> : null}
  </div>;
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
  /** When the current stream began; drives the presence row's elapsed readout. */
  streamingSince?: number;
  renderTurnDetails?: (turn: Turn, latest: boolean) => ReactNode;
  /** Admitted graph execution observed independently from the historical messages. */
  currentRunDetails?: ReactNode;
  /** An image or video node: its results are shown as the stored files they name. */
  mediaResults?: boolean;
}

export function TileTranscript({ turns, history, streaming, limit, status = null, autoScroll = false, streamingSince, renderTurnDetails, currentRunDetails, mediaResults = false }: TileTranscriptProps) {
  const { locale, t } = useCanvasI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const previousScrollTop = useRef(0);
  const previousAutoScroll = useRef(autoScroll);
  const [following, setFollowing] = useState(true);
  const follow = (value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  };
  const scrollToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Keep this instant: an animated jump can race the next streaming update or an upward
    // gesture. The browser clamps the value to its current scrollable extent.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
    else el.scrollTop = el.scrollHeight;
    previousScrollTop.current = el.scrollTop;
  };
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

  useLayoutEffect(() => {
    if (autoScroll && !previousAutoScroll.current) follow(true);
    previousAutoScroll.current = autoScroll;
    if (autoScroll && followingRef.current) scrollToLatest();
  }, [turns, autoScroll, history]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScroll) return;
    const pause = () => {
      if (el.scrollHeight > el.clientHeight) follow(false);
    };
    // Listen at the scroller itself: the canvas tile claims wheel events before they reach
    // React's delegated listener. Pause before the next token can steal the user's gesture.
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (touchY !== null && next !== undefined && next > touchY + 4) pause();
      if (next !== undefined) touchY = next;
    };
    el.addEventListener('wheel', wheel, { passive: true });
    el.addEventListener('touchstart', touchStart, { passive: true });
    el.addEventListener('touchmove', touchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('touchstart', touchStart);
      el.removeEventListener('touchmove', touchMove);
    };
  }, [autoScroll]);

  // The reply that is still empty is replaced by one presence row; once text arrives the row goes
  // and the bubble takes over. A stream without any placeholder turn keeps the row at the tail.
  const lastTurn = shown.at(-1);
  const awaitingReply = streaming && (!lastTurn || lastTurn.role !== 'agent' || !lastTurn.text);
  const presenceLabel = status || t('transcript.thinking');

  return (
    <div className="canvas-transcript">
      {history === 'unreadable' ? (
        <div className="canvas-transcript-notice" data-testid="transcript-unreadable">
          {t('transcript.unreadable')}
        </div>
      ) : null}
      <div className="canvas-transcript-viewport">
      <div className="canvas-transcript-scroll" ref={scrollRef} data-testid="transcript-scroll" tabIndex={autoScroll ? 0 : undefined}
        onKeyDownCapture={event => {
          const target = event.target as HTMLElement;
          if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
          if (autoScroll && ['PageUp', 'Home', 'ArrowUp'].includes(event.key)
            && event.currentTarget.scrollHeight > event.currentTarget.clientHeight) follow(false);
        }}
        onScroll={event => {
          const el = event.currentTarget;
          const top = el.scrollTop;
          if (autoScroll) {
            const nearBottom = el.scrollHeight - top - el.clientHeight <= 40;
            // Resizing the node or collapsing content can clamp scrollTop down while the
            // reader is still at the end. Only a move away from the end pauses here;
            // explicit upward wheel, keyboard and touch gestures already pause immediately.
            if (top < previousScrollTop.current && !nearBottom) follow(false);
            // Only a downward scroll re-arms following. A layout or streaming update near
            // the bottom must not cancel the user's explicit upward gesture.
            else if (top > previousScrollTop.current && nearBottom) follow(true);
          }
          previousScrollTop.current = top;
        }}>
        {shown.length === 0 ? currentRunDetails ? null : (
          history === 'loading' ? (
            <div className="canvas-transcript-loading">{t('transcript.loading')}</div>
          ) : history === 'unreadable' ? null : (
            <div className="canvas-transcript-empty" data-testid="transcript-empty">
              {t('transcript.empty')}
            </div>
          )
        ) : (
          shown.map((turn, index) => {
            // The accepted reply keeps its own element (run details attach to it); until its
            // first text arrives that element is the presence row, not an empty bubble.
            const placeholder = streaming && index === shown.length - 1 && turn.role === 'agent' && !turn.text;
            return <Fragment key={turn.id}>
            <div
              className={`canvas-transcript-turn canvas-transcript-turn--${turn.role}${turn.tone ? ` is-${turn.tone}` : ''}${placeholder ? ' is-pending' : ''}`}
            >
              {placeholder ? <TurnPresence label={presenceLabel} since={streamingSince} /> : <TurnContent turn={turn} mediaResults={mediaResults} />}
            </div>
            {(turn.runId ? detailOwners.get(turn.runId) === index : turn.role === 'agent')
              && renderTurnDetails?.(turn, index === shown.length - 1)}
            </Fragment>;
          })
        )}
        {awaitingReply && lastTurn?.role !== 'agent' ? <TurnPresence label={presenceLabel} since={streamingSince} /> : null}
        {currentRunDetails}
      </div>
      {autoScroll && !following && <button className="canvas-transcript-jump" type="button" onClick={() => {
        follow(true);
        scrollToLatest();
        // The pill disappears after jumping; keep keyboard focus in the reading surface.
        scrollRef.current?.focus({ preventScroll: true });
      }}>
        <ArrowDown size={13} aria-hidden="true" />{locale === 'zh' ? '回到最新' : 'Jump to latest'}
      </button>}
      </div>
      {/* A reply that is already streaming text keeps its status note as a quiet footer. */}
      {streaming && status && !awaitingReply ? <div className="canvas-transcript-status">{status}</div> : null}
    </div>
  );
}
