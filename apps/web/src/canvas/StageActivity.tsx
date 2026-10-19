// What the canvas assistant is doing, said on the stage itself. A customer's report (2026-10-16): with the conversation
// in the side panel, nothing on the canvas said whether the assistant was arranging it or doing the work elsewhere,
// and an empty canvas still showing its example looked stuck. Every line here is something the page observed.
import { Loader2 } from 'lucide-react';
import type { PlanProgress } from './canvasPlanning';
import type { AssistantPendingPhase } from './assistantRouting';
import { PlanSteps } from './CanvasAssistant';
import { useCanvasI18n, type CanvasTextKey } from './i18n';
import './stage-activity.css';

/** A message being handled, a plan being made, a direct task under way, or (an empty canvas whose conversation has
 *  tasks) nothing under way. */
export type StageActivityState =
  | { kind: 'pending'; phase: AssistantPendingPhase }
  | { kind: 'planning'; progress?: PlanProgress }
  | { kind: 'task' }
  | { kind: 'empty' };

const PENDING: Record<AssistantPendingPhase, CanvasTextKey> = { routing: 'assistant.routing', starting: 'assistant.starting', stopping: 'assistant.stopping' };

export interface StageActivityProps {
  state: StageActivityState;
  /** Over a canvas with nodes: one line at the stage's top right. Otherwise a card where an empty canvas's introduction was. */
  compact?: boolean;
  /** Said to screen readers as it changes: only while the conversation, which says it too, is not on screen. */
  announce?: boolean;
}

/** Whether the one line shows over a canvas with nodes: a plan being made or a direct task under way, on the canvas view,
 *  while no note is on the stage (a narrow stage can stretch one to the same corner; the conversation still says it). */
export function showsStageLine(state: StageActivityState | undefined, stage: { nodes: number; results: boolean; note: boolean }): boolean {
  return (state?.kind === 'planning' || state?.kind === 'task') && stage.nodes > 0 && !stage.results && !stage.note;
}

export function StageActivity({ state, compact = false, announce = false }: StageActivityProps) {
  const { t } = useCanvasI18n();
  const progress = state.kind === 'planning' ? state.progress : undefined;
  const headline = state.kind === 'pending' ? t(PENDING[state.phase]) : t(state.kind === 'planning' ? 'stage.planning' : state.kind === 'task' ? 'stage.task' : 'stage.empty');
  // What the plan has declared so far: counts the run reported, never an estimate.
  const facts = progress ? [...(progress.nodes > 0 ? [t('assistant.factNodes', { count: progress.nodes })] : []),
    ...(progress.edges > 0 ? [t('assistant.factEdges', { count: progress.edges })] : [])] : [];
  const body = compact ? '' : state.kind === 'task' ? t('stage.taskBody')
    : state.kind === 'empty' ? t('stage.emptyBody') : '';
  return <section className={`awwo-stage-activity${compact ? ' is-compact' : ''} is-${state.kind}`} aria-label={t('stage.activity')}>
    {/* Not paragraphs: an empty canvas's own paragraph styles (the introduction's) must not reach these. */}
    <div className="awwo-stage-activity-headline" {...(announce ? { 'aria-live': 'polite' as const } : {})}>
      {state.kind === 'empty' ? null : <Loader2 size={15} aria-hidden="true" />}
      <span>{headline}</span>
      {facts.length ? <small>{facts.join(' · ')}</small> : null}
    </div>
    {body ? <div className="awwo-stage-activity-body">{body}</div> : null}
    {state.kind === 'planning' && !compact ? <PlanSteps stage={progress?.stage} label={t('assistant.progressDetail')} /> : null}
  </section>;
}
