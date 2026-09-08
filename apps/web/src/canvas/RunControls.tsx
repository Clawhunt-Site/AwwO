// RunControls — the graph run/stop cluster and its honest note line.
//
// Fixed canvas chrome at TOP-LEFT. The host parks its own launcher top-center and the ClawHunt
// login chip top-right, so this corner is the one that is free; the placement is inline (not
// CSS-dependent) so the control is never invisible because a stylesheet did not load.
//
// The honesty this component owns:
//
//  - Legacy hosts preflight locally before onStart. SaaS hosts opt into initializeOnRun and
//    prepare missing node resources before their own preflight. Refusal details name the nodes
//    that need attention and can open their configuration directly.
//  - LIVE PROGRESS is counted from REAL per-node states, never from a timer or an estimate.
//  - THE FINAL SUMMARY distinguishes 成功 / 失败 / 被阻断, and a stopped run says it was stopped
//    with the count it actually completed. "被阻断" is never folded into "失败": a node that never
//    ran because its upstream failed did not itself fail.

import { useEffect, useState } from 'react';
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
  /** SaaS prepares missing node resources before performing its authoritative preflight. */
  initializeOnRun?: boolean;
  /** Open a node's configuration from the preflight details. */
  onConfigureNode?: (nodeId: string) => void;
  /** Called after local preflight, or directly when initializeOnRun is enabled. */
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
  initializeOnRun = false,
  onConfigureNode,
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
  const [dismissedProblem, setDismissedProblem] = useState<string | null>(null);
  const [expandedProblem, setExpandedProblem] = useState<string | null>(null);
  const [dismissedSummary, setDismissedSummary] = useState<string | null>(null);
  const issue = refused && !initializeOnRun ? preflightGraphIssue(nodes, edges) : null;
  const problemNodes = issue?.code === 'unbound_nodes'
    ? nodes.filter(node => node.kind === 'session' && !node.binding)
    : nodes.filter(node => issue?.values.nodeTitle === node.title ||
      (Array.isArray(issue?.values.titles) && issue.values.titles.includes(node.title)));
  const issueKey = issue ? JSON.stringify({ issue, nodeIds: problemNodes.map(node => node.id) }) : null;
  const problem = preflightIssueMessage(t, issue, locale);
  const problemVisible = Boolean(problem && issueKey !== dismissedProblem);
  const expanded = issueKey !== null && expandedProblem === issueKey;
  const summaryKey = summary ? JSON.stringify({ summary, stopped }) : null;
  // A refusal describes a click on the whole graph. It must not survive a subsequent scoped
  // run, or reappear after the operator fixes that problem and later edits something else.
  useEffect(() => {
    if (running || !issueKey) {
      setRefused(false); setExpandedProblem(null); setDismissedProblem(null);
    }
    if (running) setDismissedSummary(null);
  }, [running, issueKey]);

  const start = () => {
    if (readOnly) return;
    setDismissedSummary(null); setDismissedProblem(null); setExpandedProblem(null);
    const found = initializeOnRun ? null : preflightGraphIssue(nodes, edges);
    if (found) {
      setRefused(true);
      return;
    }
    setRefused(false);
    onStart();
  };

  const doneNow = Object.values(runs).filter((s) => s.state === 'done').length;
  const hasRuns = Object.keys(runs).length > 0;
  const liveTotal = hasRuns ? Object.values(runs).filter(s => s.state !== 'cached').length : nodes.length;
  const runTotal = running ? liveTotal : summary?.total ?? liveTotal;

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

      {running ? (
        <span className="canvas-run-note" role="status">
          {hasRuns ? t('run.inProgress', { done: doneNow, total: runTotal }) : t('run.preparing')}
        </span>
      ) : problemVisible ? (
        <div className="canvas-run-note canvas-run-note--err" role="alert">
          <div className="canvas-run-note-head">
            <span>{issue?.code === 'unbound_nodes' ? t('run.nodesNeedSetup', { count: problemNodes.length }) : t('run.needsAttention')}</span>
            <button type="button" className="canvas-run-note-action" aria-expanded={expanded}
              onClick={() => setExpandedProblem(expanded ? null : issueKey)}>{t(expanded ? 'run.collapseProblems' : 'run.expandProblems')}</button>
            <button type="button" className="canvas-run-note-dismiss" aria-label={t('run.dismissNotice')}
              onClick={() => setDismissedProblem(issueKey)}>×</button>
          </div>
          {expanded && <div className="canvas-run-note-details">
            <p>{problem}</p>
            {problemNodes.length > 0 && <ul>{problemNodes.map(node => <li key={node.id}>
              {onConfigureNode ? <button type="button" className="canvas-run-note-action" disabled={readOnly}
                aria-label={t('run.configureNode', { title: node.title })}
                onClick={() => { if (!readOnly) onConfigureNode(node.id); }}>{node.title}</button> : node.title}
            </li>)}</ul>}
          </div>}
        </div>
      ) : summary && summaryKey !== dismissedSummary ? (
        <div className="canvas-run-note" role="status"><div className="canvas-run-note-head">
          <span>{summaryNote(summary, stopped, locale)}</span>
          <button type="button" className="canvas-run-note-dismiss" aria-label={t('run.dismissNotice')}
            onClick={() => setDismissedSummary(summaryKey)}>×</button>
        </div></div>
      ) : null}

      {onToggleTimeline && hasRuns ? (
        <button type="button" className="canvas-run-timeline-toggle" onClick={onToggleTimeline}>
          {t(timelineOpen ? 'run.timelineCollapse' : 'run.timeline')}
        </button>
      ) : null}
    </div>
  );
}
