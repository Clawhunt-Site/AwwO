import type { UiLocale } from '../locale';
import type { CanvasTextKey, CanvasTextValues, CanvasTranslate } from './i18n';
import type { PreflightIssue, PreflightIssueCode } from './runGraph';

export type SurfaceNotice =
  | 'recovering_run'
  | 'run_identity_unconfirmed'
  | 'recovery_pending'
  | 'recovery_complete'
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
  | 'plan_undone';

const NOTICE_KEYS = {
  recovering_run: 'surface.recoveringRun',
  run_identity_unconfirmed: 'surface.runIdentityUnconfirmed',
  recovery_pending: 'surface.recoveryPending',
  recovery_complete: 'surface.recoveryComplete',
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
  plan_undone: 'surface.planUndone',
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
  succeeded: 'session.succeeded',
  failed: 'session.failed',
  cancelled: 'session.cancelled',
  timed_out: 'session.timedOut',
} as const satisfies Record<string, CanvasTextKey>;

/** Known persisted/native status codes are localized; unknown evidence remains verbatim. */
export function recoveryDetailMessage(t: CanvasTranslate, detail?: string): string | undefined {
  if (!detail) return undefined;
  const key = RECOVERY_DETAIL_KEYS[detail as keyof typeof RECOVERY_DETAIL_KEYS];
  return key ? t(key) : detail;
}

const PREFLIGHT_KEYS: Record<PreflightIssueCode, CanvasTextKey> = {
  empty_graph: 'run.preflightEmptyGraph',
  empty_scope: 'run.preflightEmptyScope',
  unbound_nodes: 'run.preflightUnbound',
  multiple_inputs: 'run.preflightMultipleInputs',
  missing_inputs: 'run.preflightMissingInputs',
  cycle: 'run.preflightCycle',
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
  return issue ? t(PREFLIGHT_KEYS[issue.code], localizedValues(issue, locale)) : null;
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
