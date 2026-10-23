import type { UiLocale } from '../locale';
import { isRunFailureCopy, runFailureText } from '../saas/canvasErrors';
import type { CanvasNode } from './canvasDoc';
import type { CanvasTextKey, CanvasTextValues, CanvasTranslate } from './i18n';
import type { PreflightIssue, PreflightIssueCode } from './runGraph';
import type { ReviewPreflightReason } from './reviewGraph';

export type SurfaceNotice =
  | 'recovering_run'
  | 'run_identity_unconfirmed'
  | 'recovery_pending'
  | 'graph_recovery_pending'
  | 'recovery_complete'
  | 'graph_recovery_complete'
  | 'recovery_input_changed'
  | 'execution_owned_elsewhere'
  | 'canvas_changed_elsewhere'
  | 'bind_before_run'
  | 'wait_conversation'
  | 'storage_unavailable'
  | 'storage_write_failed'
  | 'config_forked'
  | 'planning_busy'
  | 'plan_stale'
  | 'plan_cancelled'
  | 'plan_interrupted'
  | 'plan_undone'
  | 'node_busy_edit'
  | 'node_already_running'
  | 'run_wait_others'
  | 'run_lanes_full'
  | 'media_runs_alone';

const NOTICE_KEYS = {
  recovering_run: 'surface.recoveringRun',
  run_identity_unconfirmed: 'surface.runIdentityUnconfirmed',
  recovery_pending: 'surface.recoveryPending',
  graph_recovery_pending: 'surface.graphRecoveryPending',
  recovery_complete: 'surface.recoveryComplete',
  graph_recovery_complete: 'surface.graphRecoveryComplete',
  recovery_input_changed: 'surface.recoveryInputChanged',
  execution_owned_elsewhere: 'surface.executionOwnedElsewhere',
  canvas_changed_elsewhere: 'surface.canvasChangedElsewhere',
  bind_before_run: 'surface.bindBeforeRun',
  wait_conversation: 'surface.waitConversation',
  storage_unavailable: 'surface.storageUnavailable',
  storage_write_failed: 'surface.storageWriteFailed',
  config_forked: 'run.configForked',
  planning_busy: 'surface.planningBusy',
  plan_stale: 'surface.planStale',
  plan_cancelled: 'surface.planCancelled',
  plan_interrupted: 'surface.planInterrupted',
  plan_undone: 'surface.planUndone',
  node_busy_edit: 'surface.nodeBusyEdit',
  node_already_running: 'surface.nodeAlreadyRunning',
  run_wait_others: 'surface.runWaitOthers',
  run_lanes_full: 'surface.runLanesFull',
  media_runs_alone: 'surface.mediaRunsAlone',
} as const;

export function surfaceNotice(t: CanvasTranslate, notice: SurfaceNotice): string {
  return t(NOTICE_KEYS[notice]);
}

const RECOVERY_DETAIL_KEYS = {
  recovery_not_dispatched: 'surface.recoveryNotDispatched',
  recovery_identity_missing: 'surface.recoveryIdentityMissing',
  recovery_invalid_output: 'surface.recoveryInvalidOutput',
  recovery_input_changed: 'surface.recoveryInputChanged',
  recovery_unconfirmed: 'surface.recoveryUnconfirmed',
  recovery_settlement_unconfirmed: 'surface.settlementUnconfirmed',
  review_invalid_verdict: 'graph.invalidVerdict',
  review_exhausted: 'graph.exhausted',
  succeeded: 'session.succeeded',
  failed: 'session.failed',
  cancelled: 'session.cancelled',
  'Graph cancelled': 'session.cancelled',
  'Upstream did not complete': 'surface.upstreamIncomplete',
  'Missing cached upstream output': 'surface.cachedOutputMissing',
  'Cached upstream output holds no deliverable': 'surface.cachedOutputEmpty',
  timed_out: 'session.timedOut',
  retrying: 'surface.retrying',
  // An edit node's failures (edits.go, edit_worker.go): what stopped the film, and the local engine's refusal.
  timeout: 'edit.timeout',
  edit_cloud_only: 'edit.cloudOnly',
  edit_allowance: 'edit.allowance',
  edit_unavailable: 'edit.unavailable',
  edit_busy: 'edit.busy',
  edit_rejected: 'edit.rejectedBare',
  edit_failed: 'edit.failed',
  edit_file_mismatch: 'edit.fileMismatch',
  edit_file_missing: 'edit.fileMissing',
  edit_output_invalid: 'edit.outputInvalid',
  edit_storage_failed: 'edit.storageFailed',
} as const satisfies Record<string, CanvasTextKey>;

/** A timeline the render worker refused keeps the worker's own words (editFailureDetail in edits.go). */
const EDIT_REJECTED = 'edit_rejected: ';

/** Known persisted/native status codes are localized, and so is a failure's code as a cloud run's node records it (its
 * run's, or its admission's): the reader is told what happened and what to do (canvasErrors.ts), never shown
 * `run_timeout`. Unknown evidence remains verbatim. */
export function recoveryDetailMessage(t: CanvasTranslate, detail: string | undefined, locale: UiLocale): string | undefined {
  if (!detail) return undefined;
  const key = RECOVERY_DETAIL_KEYS[detail as keyof typeof RECOVERY_DETAIL_KEYS];
  if (key) return t(key);
  if (detail.startsWith(EDIT_REJECTED)) return t('edit.rejected', { detail: detail.slice(EDIT_REJECTED.length) });
  // The API's delivery-contract refusals (graph_contracts.go graphOutputFiles) say what a model's answer lacked, in
  // terms of field IDs the reader never sees; the reader is told what it means and what to do.
  if (DELIVERY_FORMAT_DETAIL.test(detail)) return t('surface.deliveryFormat');
  return runFailureText(detail, locale) ?? detail;
}

const DELIVERY_FORMAT_DETAIL = /^(?:Output must be a JSON object keyed by output field IDs|Missing output \S+|Output \S+ (?:requires|allows only|must be) .+)$/;

/** What happened, from a failure copy: what it says before what to do (canvasErrors.ts, api.ts), which ends at its first
 *  sentence or, in Chinese, where a 请 starts the advice in the same sentence (「生成超时，请稍后重试」). */
export function failureCause(text: string): string {
  const end = text.search(/[。！？]|[，；：]\s*请(?!求)|[.!?](?=\s|$)/);
  return (end > 0 ? text.slice(0, end) : text).trim();
}

/** A node's last failure as what the reader asks the assistant and what the planner is told carry it: what a copy says
 *  happened, not the advice the node's note gives the reader (to run it again, which the assistant cannot do), and any
 *  other detail whole: the provider's or the worker's own words, an edit's refusal with the render worker's. A copy is
 *  the canvas's words for a recorded code or status, or the copy a node's own Send recorded (canvasErrorMessage). */
export function failureReason(t: CanvasTranslate, detail: string | undefined, locale: UiLocale): string | undefined {
  const raw = detail?.trim();
  const shown = recoveryDetailMessage(t, raw, locale)?.trim();
  if (!raw || !shown) return undefined;
  const copy = shown !== raw ? !raw.startsWith(EDIT_REJECTED) : isRunFailureCopy(raw);
  return copy ? failureCause(shown) : shown;
}

/** Every code and status the canvas words itself (above). */
export const recoveryDetailCodes = (): string[] => Object.keys(RECOVERY_DETAIL_KEYS);

const PREFLIGHT_KEYS: Record<PreflightIssueCode, CanvasTextKey> = {
  empty_graph: 'run.preflightEmptyGraph',
  empty_scope: 'run.preflightEmptyScope',
  unbound_nodes: 'run.preflightUnbound',
  multiple_inputs: 'run.preflightMultipleInputs',
  missing_inputs: 'run.preflightMissingInputs',
  cycle: 'run.preflightCycle',
  invalid_team: 'run.preflightInvalidTeam',
  edit_timeline: 'edit.preflightTimeline',
  media_params: 'run.preflightMediaParams',
};

const REVIEW_PREFLIGHT_KEYS: Record<ReviewPreflightReason, CanvasTextKey> = {
  full_graph_required: 'graph.preflightFullGraph',
  invalid_round_limit: 'graph.preflightRoundLimit',
  duplicate_nodes: 'graph.preflightDuplicateNodes',
  duplicate_edges: 'graph.preflightDuplicateEdges',
  invalid_edges: 'graph.preflightInvalidEdges',
  missing_feedback: 'graph.preflightMissingFeedback',
  missing_reviewer: 'graph.preflightMissingReviewer',
  invalid_verdict_field: 'graph.preflightVerdictField',
  reviewer_not_terminal: 'graph.preflightReviewerTerminal',
  missing_reviewer_feedback: 'graph.preflightReviewerFeedback',
  invalid_feedback_input: 'graph.preflightFeedbackInput',
  conflicting_feedback_input: 'graph.preflightFeedbackConflict',
  invalid_feedback_path: 'graph.preflightFeedbackPath',
  unreviewed_nodes: 'graph.preflightUnreviewedNodes',
};

function localizedValues(issue: PreflightIssue, locale: UiLocale): CanvasTextValues {
  return Object.fromEntries(Object.entries(issue.values).map(([name, value]) => [
    name,
    Array.isArray(value) ? value.join(locale === 'zh' ? '、' : ', ') : value,
  ]));
}

/** Translate the stable preflight code; the legacy Chinese message is never rendered by new UI. */
export function preflightIssueMessage(
  t: CanvasTranslate,
  issue: PreflightIssue | null,
  locale: UiLocale,
): string | null {
  if (!issue) return null;
  const reason = issue.values.reviewReason;
  if (typeof reason === 'string' && Object.hasOwn(REVIEW_PREFLIGHT_KEYS, reason)) {
    return t(REVIEW_PREFLIGHT_KEYS[reason as ReviewPreflightReason], localizedValues(issue, locale));
  }
  return t(PREFLIGHT_KEYS[issue.code], localizedValues(issue, locale));
}

/**
 * A refusal of a whole canvas run, with the node the service refused it for named in front of its copy. A canvas run
 * freezes the model and settings of every media node in its scope before it starts, so one node's own saved state
 * refuses the whole canvas (`graph_runs.go`), and the refusal code's copy says nothing about which node that was: on
 * a canvas of hundreds that left the reader to find it. The service carries the node's id only (graphRefusedNodeId);
 * the titles are this page's own. A refusal that names no node, or one whose node this page no longer holds, reads
 * exactly as the service worded it.
 */
export function refusedNodeMessage(message: string, nodeId: string | null, nodes: ReadonlyArray<CanvasNode>, locale: UiLocale): string {
  const title = nodeId ? nodes.find(node => node.id === nodeId)?.title : undefined;
  return title ? `“${title}”${locale === 'zh' ? '：' : ': '}${message}` : message;
}

/** Known wrapper text is localized; an unknown native/server detail stays verbatim evidence. */
export function stopUnconfirmedMessage(t: CanvasTranslate, detail: string): string {
  return t('surface.stopUnconfirmed', { detail });
}

export function planFailureMessage(t: CanvasTranslate, error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('surface.planFailed');
}

export function plannerConnectionMessage(
  t: CanvasTranslate,
  status: { available: boolean; provider: string } | null,
): string {
  if (!status) return t('surface.plannerConnecting');
  return status.available
    ? t('surface.plannerReady', { provider: status.provider || 'AI' })
    : t('surface.plannerDisconnected');
}

export function surfaceViewMessages(t: CanvasTranslate) {
  return {
    toolbar: t('surface.viewTools'),
    zoomOut: t('surface.zoomOut'),
    zoomIn: t('surface.zoomIn'),
    fitAll: t('surface.fitAll'),
    arrange: t('surface.arrange'),
    arrangeTitle: t('surface.arrangeUndoable'),
    showMinimap: t('surface.showMinimap'),
    undo: t('surface.undo'),
    redo: t('surface.redo'),
    runSelection: t('surface.runSelection'),
  };
}
