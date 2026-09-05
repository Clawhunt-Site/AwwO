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

import { useEffect, useRef } from 'react';
import type { HistoryState, Turn } from './sessions';

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
}

export function TileTranscript({ turns, history, streaming, limit, status = null, autoScroll = false }: TileTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shown = Number.isFinite(limit) ? turns.slice(Math.max(0, turns.length - limit)) : turns;

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
          {TRANSCRIPT_COPY.unreadable}
        </div>
      ) : null}
      <div className="canvas-transcript-scroll" ref={scrollRef} data-testid="transcript-scroll">
        {shown.length === 0 ? (
          history === 'loading' ? (
            <div className="canvas-transcript-loading">{TRANSCRIPT_COPY.loading}</div>
          ) : history === 'unreadable' ? null : (
            <div className="canvas-transcript-empty" data-testid="transcript-empty">
              {TRANSCRIPT_COPY.empty}
            </div>
          )
        ) : (
          shown.map((turn) => (
            <div
              key={turn.id}
              className={`canvas-transcript-turn canvas-transcript-turn--${turn.role}${turn.tone ? ` is-${turn.tone}` : ''}`}
            >
              {/* An empty agent turn mid-stream is the placeholder the gateway has not filled yet;
                  saying so is honest, inventing text would not be. */}
              {turn.text || (turn.role === 'agent' && streaming ? TRANSCRIPT_COPY.thinking : '')}
            </div>
          ))
        )}
      </div>
      {streaming && status ? <div className="canvas-transcript-status">{status}</div> : null}
    </div>
  );
}
