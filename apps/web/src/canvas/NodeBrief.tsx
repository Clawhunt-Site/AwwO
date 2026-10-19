// What an opened Agent node was asked to do, at the top of its conversation: its task (the persona's role), the checks
// its delivery is held to, how many constraints it follows and the model it runs. It used to be shown only in
// developer mode's Configure panel, so a reader who opened a node in the simple view saw what it made but never what it
// was asked (owner request 2026-10-15). Collapsed to a few lines; a reader who only talks to the assistant changes it
// there (onAskAssistant), a developer in Configure.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, MessageSquareText, TriangleAlert } from 'lucide-react';
import type { SessionNode } from './canvasDoc';
import { useCanvasI18n } from './i18n';
import { isTaskFrame } from './taskFrame';
import { figureRole } from './figureKit/figureKit';
import type { AgentTemplate } from './agentTemplates';
import './node-brief.css';

export interface NodeBriefProps {
  node: SessionNode;
  template?: AgentTemplate;
  /** The model the node runs, in the reader's words (absent: the workspace default). */
  modelLabel?: string;
  /** Ask the canvas assistant to change this node (the simple view's way to edit it). */
  onAskAssistant?: () => void;
  /** Another panel shares the column (the inputs): one line of the task until expanded, the checks only counted. */
  compact?: boolean;
}

export function NodeBrief({ node, template, modelLabel, onAskAssistant, compact = false }: NodeBriefProps) {
  const { t } = useCanvasI18n();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const persona = node.templateId === 'figure' ? figureRole(node.persona) : node.persona;
  const task = persona.trim() || template?.subtitle?.trim() || '';
  const frame = isTaskFrame(node.taskFrame) ? node.taskFrame : null;
  const criteria = frame?.acceptanceCriteria.filter(item => item.trim()) ?? [];
  const constraints = frame?.constraints.filter(item => item.trim()) ?? [];
  // The task is clamped to a few lines (one beside the inputs): whatever the clamp hides is a press away. Its lines and
  // length say so before layout; the clamped box itself says so once laid out (a narrow column wraps sooner).
  const taskRef = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const box = taskRef.current;
    if (!box || open) return;
    const measure = () => setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [task, compact, open]);
  if (!task && !criteria.length && !constraints.length) return null;
  const lines = task.split(/\r?\n/).length;
  const long = clipped || task.length > (compact ? 60 : 220) || lines > (compact ? 1 : 3) || criteria.length > (compact ? 0 : 2) || constraints.length > 0;
  const lists = open || !compact;
  return <section className={`awwo-node-brief${open ? ' is-open' : ''}${compact && !open ? ' is-compact' : ''}`} aria-label={t('brief.label', { node: node.title })}>
    <header>
      <strong>{t('brief.title')}</strong>
      <span className="awwo-node-brief-model">{modelLabel ? t('brief.model', { model: modelLabel }) : t('brief.modelDefault')}</span>
      {onAskAssistant ? <button type="button" className="awwo-node-brief-ask" onClick={onAskAssistant}>
        <MessageSquareText size={13} aria-hidden="true" />{t('brief.askAssistant')}</button> : null}
      {long ? <button type="button" className="awwo-node-brief-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}{t(open ? 'brief.collapse' : 'brief.expand')}</button> : null}
    </header>
    <div id={bodyId} className="awwo-node-brief-body">
    {task ? <p ref={taskRef} className="awwo-node-brief-task">{task}</p> : null}
    {criteria.length && lists ? <div className="awwo-node-brief-list">
      <span>{t('brief.acceptance')}</span>
      <ul>{criteria.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div> : null}
    {constraints.length && lists ? <div className="awwo-node-brief-list is-constraints">
      <span>{t('brief.constraints', { count: constraints.length })}</span>
      {open ? <ul>{constraints.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
    </div> : null}
    {!lists && (criteria.length || constraints.length) ? <p className="awwo-node-brief-counts">
      {[criteria.length ? t('brief.acceptanceCount', { count: criteria.length }) : '', constraints.length ? t('brief.constraints', { count: constraints.length }) : '']
        .filter(Boolean).join(' · ')}</p> : null}
    </div>
  </section>;
}

export interface NodeFailureProps {
  detail: string;
  onRerun?: () => void;
  onAskAssistant?: () => void;
}

/** How the node's last run ended when it failed, in words, with the two ways on: run it again (a passing fault), or let
 *  the assistant change the canvas so it can finish (an answer too long, a call out of time). The run badge used to
 *  keep the reason in a tooltip. */
export function NodeFailure({ detail, onRerun, onAskAssistant }: NodeFailureProps) {
  const { t } = useCanvasI18n();
  // A note that is there each time the node opens, said politely: an alert would be announced again on every open.
  return <div className="awwo-node-failure">
    <p role="status"><TriangleAlert size={14} aria-hidden="true" /><span title={detail || undefined}><strong>{t('brief.failedTitle')}</strong>{detail || t('brief.failedNoReason')}</span></p>
    {onRerun || onAskAssistant ? <div className="awwo-node-failure-actions">
      {onRerun ? <button type="button" onClick={onRerun}>{t('brief.failedRerun')}</button> : null}
      {onAskAssistant ? <button type="button" className="is-primary" onClick={onAskAssistant}>{t('brief.failedAskAssistant')}</button> : null}
    </div> : null}
  </div>;
}
