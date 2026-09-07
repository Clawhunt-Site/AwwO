// RunControls — the graph run/stop cluster and its honest note line.
//
// Fixed canvas chrome at TOP-LEFT. The host parks its own launcher top-center and the ClawHunt
// login chip top-right, so this corner is the one that is free; the placement is inline (not
// CSS-dependent) so the control is never invisible because a stylesheet did not load.
//
// The honesty this component owns:
//
//  - PRE-FLIGHT IS UP FRONT. Clicking 运行 runs `preflightGraph` FIRST and, if the graph cannot
//    execute, reports the problem and does NOT call onStart. A run that half-starts and then
//    discovers an unbound node has already lied to the operator about what it was doing. The
//    problem text NAMES the offending nodes (unbound session tiles, cycle members) — "graph
//    invalid" is not actionable.
//  - LIVE PROGRESS is counted from REAL per-node states, never from a timer or an estimate.
//  - THE FINAL SUMMARY distinguishes 成功 / 失败 / 被阻断, and a stopped run says it was stopped
//    with the count it actually completed. "被阻断" is never folded into "失败": a node that never
//    ran because its upstream failed did not itself fail.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { CanvasEdge, CanvasNode } from './canvasDoc';
import { preflightGraphIssue, type RunNodeStatus, type RunSummary } from './runGraph';
import { canvasText, useCanvasI18n } from './i18n';
import type { UiLocale } from '../locale';
import { preflightIssueMessage } from './surfaceMessages';

export interface RunControlsProps {
  /** The graph as it stands NOW — preflight runs against this exact snapshot. */
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  running: boolean;
  readOnly?: boolean;
  /** Live per-node states (RAW node ids), for the in-flight progress count. */
  runs: Readonly<Record<string, RunNodeStatus>>;
  /** The finished run's summary; null while none has finished in this session. */
  summary?: RunSummary | null;
  /** Whether the summarised run ended because the operator stopped it. */
  stopped?: boolean;
  /** Called ONLY after preflight passes. */
  onStart: () => void;
  onStop: () => void;
  /** Timeline drawer toggle (omitted → the toggle button is not rendered). */
  onToggleTimeline?: () => void;
  timelineOpen?: boolean;
  style?: CSSProperties;
}

const CLUSTER_STYLE: CSSProperties = {
  position: 'fixed',
  top: 16,
  left: 16,
  zIndex: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  maxWidth: 'min(560px, 46vw)',
};

/** The finished-run note. Pure + exported so the wording is testable without a render. */
export function summaryNote(summary: RunSummary, stopped: boolean, locale: UiLocale = 'zh'): string {
  // A scoped run reused upstream results instead of re-running them. Saying so is the difference
  // between "3/3 succeeded" reading as "the whole graph is fresh" and reading as what it is.
  const reused = summary.cached ? canvasText(locale, 'run.reusedSummary', { count: summary.cached }) : '';
  const cancelledCount = 'cancelled' in summary && typeof summary.cancelled === 'number' ? summary.cancelled : 0;
  const cancelled = cancelledCount ? canvasText(locale, 'run.cancelledSummary', { count: cancelledCount }) : '';
  const values = { done: summary.done, total: summary.total, failed: summary.failed, blocked: summary.blocked, reused };
  if (stopped) return canvasText(locale, 'run.stoppedSummary', values);
  if (summary.ok) return canvasText(locale, 'run.completedSummary', values);
  return `${canvasText(locale, 'run.failedSummary', values).replace(/\.$/, '')}${cancelled}.`;
}

export function RunControls({
  nodes,
  edges,
  running,
  readOnly = false,
  runs,
  summary = null,
  stopped = false,
  onStart,
  onStop,
  onToggleTimeline,
  timelineOpen = false,
  style,
}: RunControlsProps) {
  const { locale, t } = useCanvasI18n();
  // "The operator asked and was refused" — a flag, not the refusal TEXT. The text is re-derived
  // from the CURRENT graph on every render, so a refusal can never outlive the problem it named:
  // bind the missing agent and the message goes away by itself (and if the graph acquires a
  // different problem meanwhile, the operator sees THAT one, not a stale sentence).
  const [refused, setRefused] = useState(false);
  const problem = refused ? preflightIssueMessage(t, preflightGraphIssue(nodes, edges), locale) : null;

  const start = () => {
    if (readOnly) return;
    const found = preflightGraphIssue(nodes, edges);
    if (found) {
      setRefused(true);
      return;
    }
    setRefused(false);
    onStart();
  };

  const doneNow = Object.values(runs).filter((s) => s.state === 'done').length;
  const hasRuns = Object.keys(runs).length > 0;
  const runTotal = summary?.total ?? (hasRuns ? Object.values(runs).filter(s => s.state !== 'cached').length : nodes.length);

  return (
    <div
      className="canvas-run-ctl"
      role="group"
      aria-label={t('run.controls')}
      style={{ ...CLUSTER_STYLE, ...style }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {running ? (
        <button type="button" className="canvas-run-btn canvas-run-btn--stop" disabled={readOnly} onClick={() => { if (!readOnly) onStop(); }}>
          ■ {t('run.stop')}
        </button>
      ) : (
        <button
          type="button"
          className="canvas-run-btn"
          onClick={start}
          disabled={readOnly || nodes.length === 0}
          title={readOnly ? t('common.readOnly') : nodes.length === 0 ? t('run.emptyTitle') : undefined}
        >
          ▶ {t('run.runGraph')}
        </button>
      )}

      {problem ? (
        // role=alert: a refusal must reach a screen reader immediately — the operator clicked
        // 运行 and nothing is going to happen.
        <span className="canvas-run-note canvas-run-note--err" role="alert">
          {problem}
        </span>
      ) : running ? (
        <span className="canvas-run-note">
          {t('run.inProgress', { done: doneNow, total: runTotal })}
        </span>
      ) : summary ? (
        <span className="canvas-run-note">{summaryNote(summary, stopped, locale)}</span>
      ) : null}

      {onToggleTimeline && hasRuns ? (
        <button type="button" className="canvas-run-timeline-toggle" onClick={onToggleTimeline}>
          {t(timelineOpen ? 'run.timelineCollapse' : 'run.timeline')}
        </button>
      ) : null}
    </div>
  );
}
