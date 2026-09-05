import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  GitBranch,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  X,
} from 'lucide-react';
import { getStudioDispatchTargetHref } from '../../api';
import type {
  StudioDispatchBatchPlan,
  StudioDispatchBatchTarget,
  StudioDispatchMatrix,
  StudioDispatchMatrixEntry,
  StudioDispatchSession,
  StudioDispatchSessionTarget,
} from '../../api';
import { healthPillTone } from '../../model/dreamyWorkspace';
import { Pill } from '../studioStatus';

export function StudioDispatchBatchStrip({
  plan,
  session,
  planning,
  sessionRunning,
  selectedPageCount,
  onPlan,
  onPlanRemaining,
  onPlanSelected,
  onStartSession,
  onStartSelectedSession,
  onCancelSession,
  onRetrySession,
  onOpenTarget,
  onCompleteTarget,
  onErrorTarget,
  onSkipTarget,
}: {
  plan: StudioDispatchBatchPlan | null;
  session: StudioDispatchSession | null;
  planning: boolean;
  sessionRunning: boolean;
  selectedPageCount: number;
  onPlan: () => void;
  onPlanRemaining: () => void;
  onPlanSelected: () => void;
  onStartSession: () => void;
  onStartSelectedSession: () => void;
  onCancelSession: () => void;
  onRetrySession: () => void;
  onOpenTarget: (target: StudioDispatchBatchTarget | StudioDispatchSessionTarget) => void;
  onCompleteTarget: (target: StudioDispatchSessionTarget) => void;
  onErrorTarget: (target: StudioDispatchSessionTarget) => void;
  onSkipTarget: (target: StudioDispatchSessionTarget) => void;
}) {
  const summary = plan?.summary;
  const sessionSummary = session?.summary;
  const focusedTarget =
    session?.focusedTarget ||
    (session?.focusedTargetId ? session.targets.find((target) => target.id === session.focusedTargetId) : null);
  const nextDispatchTarget =
    session?.targets.find((target) => (
      target.status === 'pending' &&
      ((target.executor === 'navigation' && target.navigationPath) || target.executor !== 'navigation')
    )) ||
    plan?.targets.find((target) => (target.executor === 'navigation' && target.navigationPath) || target.executor !== 'navigation');
  const visitedTarget = session?.targets.find((target) => target.status === 'visited');
  const skipped = plan?.skippedTargets || [];
  const visibleTargets = (session?.targets || plan?.targets || []).slice(0, 5);
  const focusedTargetVisible = focusedTarget && !visibleTargets.some((target) => target.id === focusedTarget.id);
  const hasSelectedPages = selectedPageCount > 0;
  const canCancelSession = Boolean(session && session.status !== 'cancelled' && session.status !== 'done');
  const canRetrySession = Boolean(
    session &&
    ((session.summary.targetCancelled || 0) > 0 || (session.summary.targetErrors || 0) > 0 || session.status === 'cancelled'),
  );

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-2 [-webkit-overflow-scrolling:touch]">
      <Pill tone={plan?.readyForDispatch ? 'success' : plan ? 'danger' : 'default'}>
        {plan ? `Batch ${plan.status}` : 'Batch not planned'}
      </Pill>
      <Pill tone={session?.status === 'active' ? 'success' : session ? 'hot' : 'default'}>
        {session ? `Queue ${session.status}` : 'Queue not started'}
      </Pill>
      <button
        type="button"
        disabled={planning}
        onClick={onPlan}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <RefreshCcw size={12} className={planning ? 'animate-spin' : ''} />
        Plan All
      </button>
      <button
        type="button"
        disabled={planning}
        onClick={onPlanRemaining}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <RotateCcw size={12} className={planning ? 'animate-spin' : ''} />
        Plan Remaining
      </button>
      <button
        type="button"
        disabled={!hasSelectedPages || planning}
        onClick={onPlanSelected}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <CheckCircle2 size={12} className={planning ? 'animate-pulse' : ''} />
        Plan Selected
      </button>
      <button
        type="button"
        disabled={sessionRunning}
        onClick={onStartSession}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <GitBranch size={12} className={sessionRunning ? 'animate-pulse' : ''} />
        Start Queue
      </button>
      <button
        type="button"
        disabled={!hasSelectedPages || sessionRunning}
        onClick={onStartSelectedSession}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <GitBranch size={12} className={sessionRunning ? 'animate-pulse' : ''} />
        Start Selected
      </button>
      <button
        type="button"
        disabled={!canCancelSession || sessionRunning}
        onClick={onCancelSession}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <Pause size={12} />
        Cancel Queue
      </button>
      <button
        type="button"
        disabled={!canRetrySession || sessionRunning}
        onClick={onRetrySession}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <RotateCcw size={12} className={sessionRunning ? 'animate-spin' : ''} />
        Retry Queue
      </button>
      <button
        type="button"
        disabled={!nextDispatchTarget || sessionRunning}
        onClick={() => nextDispatchTarget && onOpenTarget(nextDispatchTarget)}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <Play size={12} />
        {nextDispatchTarget?.executor === 'navigation' ? 'Open Next' : 'Run Next'}
      </button>
      <button
        type="button"
        disabled={!visitedTarget || sessionRunning}
        onClick={() => visitedTarget && onCompleteTarget(visitedTarget)}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <CheckCircle2 size={12} />
        Mark Done
      </button>
      <button
        type="button"
        disabled={!visitedTarget || sessionRunning}
        onClick={() => visitedTarget && onErrorTarget(visitedTarget)}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <AlertTriangle size={12} />
        Mark Error
      </button>
      <button
        type="button"
        disabled={!visitedTarget || sessionRunning}
        onClick={() => visitedTarget && onSkipTarget(visitedTarget)}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <X size={12} />
        Skip
      </button>
      {summary && (
        <>
          <Pill tone={summary.planned ? 'success' : 'default'}>{`${summary.planned}/${summary.total} targets`}</Pill>
          <Pill>{`${summary.navigation} nav`}</Pill>
          <Pill>{`${summary.client} client`}</Pill>
          <Pill>{`${summary.server} server`}</Pill>
          <Pill tone={summary.skipped ? 'hot' : 'default'}>{`${summary.skipped} skipped`}</Pill>
          <Pill tone={summary.missingParams ? 'hot' : 'default'}>{`${summary.missingParams} missing params`}</Pill>
          {!!summary.coveredSkipped && <Pill tone="success">{`${summary.coveredSkipped} covered skipped`}</Pill>}
          {hasSelectedPages && <Pill tone="hot">{`${selectedPageCount} selected`}</Pill>}
        </>
      )}
      {!summary && hasSelectedPages && <Pill tone="hot">{`${selectedPageCount} selected`}</Pill>}
      {sessionSummary && (
        <>
          {focusedTarget && (
            <Pill tone={focusedTarget.status === 'completed' ? 'success' : focusedTarget.status === 'error' ? 'danger' : 'hot'}>
              {`Focus ${focusedTarget.pageName} ${focusedTarget.status}`}
            </Pill>
          )}
          <Pill tone={sessionSummary.pending ? 'hot' : 'default'}>{`${sessionSummary.pending} pending`}</Pill>
          <Pill tone={sessionSummary.visited ? 'hot' : 'default'}>{`${sessionSummary.visited} visited`}</Pill>
          <Pill tone={sessionSummary.completed ? 'success' : 'default'}>{`${sessionSummary.completed} done`}</Pill>
          <Pill tone={sessionSummary.targetSkipped ? 'hot' : 'default'}>{`${sessionSummary.targetSkipped || 0} skipped`}</Pill>
          <Pill tone={sessionSummary.targetErrors ? 'danger' : 'default'}>{`${sessionSummary.targetErrors || 0} errors`}</Pill>
          <Pill tone={sessionSummary.targetCancelled ? 'hot' : 'default'}>{`${sessionSummary.targetCancelled || 0} cancelled`}</Pill>
        </>
      )}
      {visibleTargets.map((target) => (
        <span
          key={target.id}
          title={target.navigationPath || target.dispatchMessage || target.recommendedAction}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
        >
          <GitBranch size={12} className={target.executor === 'navigation' ? 'text-Cr-text-success-default-v2' : 'text-dreamy-brand-hot-v2'} />
          <span className="max-w-[120px] truncate">{target.pageName}</span>
          <span className="text-Cr-text-subtlest-v2">{String('status' in target ? target.status : target.executor)}</span>
        </span>
      ))}
      {focusedTargetVisible && (
        <span
          key={focusedTarget.id}
          title={focusedTarget.navigationPath || focusedTarget.dispatchMessage || focusedTarget.recommendedAction}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/10 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
        >
          <GitBranch size={12} className="text-dreamy-brand-hot-v2" />
          <span className="max-w-[120px] truncate">{focusedTarget.pageName}</span>
          <span className="text-Cr-text-subtlest-v2">{focusedTarget.status}</span>
        </span>
      )}
      {skipped.slice(0, 4).map((target) => (
        <span
          key={target.id}
          title={target.message || target.reason}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
        >
          <AlertTriangle size={12} className="text-dreamy-brand-hot-v2" />
          <span className="max-w-[120px] truncate">{target.pageName}</span>
          <span className="text-Cr-text-subtlest-v2">{target.reason}</span>
        </span>
      ))}
    </div>
  );
}

export function StudioDispatchMatrixPanel({
  matrix,
  selectedPageId,
  selectedBatchPageIds,
  submitting,
  onSelectPage,
  onToggleBatchPage,
  onSelectReadyBatchPages,
  onClearBatchPageSelection,
  onRunEntry,
  onCopyEntryLink,
}: {
  matrix: StudioDispatchMatrix | null;
  selectedPageId: string;
  selectedBatchPageIds: string[];
  submitting: boolean;
  onSelectPage: (pageId: string) => void;
  onToggleBatchPage: (pageId: string) => void;
  onSelectReadyBatchPages: (pageIds: string[]) => void;
  onClearBatchPageSelection: () => void;
  onRunEntry: (entry: StudioDispatchMatrixEntry) => void;
  onCopyEntryLink: (entry: StudioDispatchMatrixEntry) => void;
}) {
  const entries = matrix?.entries || [];
  if (!entries.length) return null;
  const summary = matrix?.summary;
  const selectedBatchSet = new Set(selectedBatchPageIds);
  const readyPageIds = entries.filter((entry) => entry.dispatchReady).map((entry) => String(entry.pageId));

  return (
    <div className="shrink-0 border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-Cr-text-subtle-v2">
          <GitBranch size={14} />
          Dispatch Matrix
        </div>
        <div className="flex max-w-full items-center gap-2 overflow-x-auto [-webkit-overflow-scrolling:touch]">
          {summary && (
            <>
              <Pill tone={summary.ready === summary.total ? 'success' : 'hot'}>{`${summary.ready}/${summary.total} ready`}</Pill>
              <Pill tone={summary.missingParams ? 'hot' : 'default'}>{`${summary.missingParams} missing params`}</Pill>
              <Pill>{`${summary.navigation} nav`}</Pill>
              <Pill tone={selectedBatchPageIds.length ? 'hot' : 'default'}>{`${selectedBatchPageIds.length} selected`}</Pill>
              {matrix?.sourceSegmentId && <Pill tone="success">source segment</Pill>}
            </>
          )}
          <button
            type="button"
            disabled={!readyPageIds.length}
            onClick={() => onSelectReadyBatchPages(readyPageIds)}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
          >
            <CheckCircle2 size={12} />
            Select Ready
          </button>
          <button
            type="button"
            disabled={!selectedBatchPageIds.length}
            onClick={onClearBatchPageSelection}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
          >
            <X size={12} />
            Clear
          </button>
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
        {entries.map((entry) => {
          const active = entry.pageId === selectedPageId;
          const entryHref = getStudioDispatchTargetHref(entry);
          const selectedForBatch = selectedBatchSet.has(String(entry.pageId));
          const missingLabel = entry.missingRouteParams.length
            ? `Needs ${entry.missingRouteParams.join(', ')}`
            : '';
          const blockedLabel = missingLabel || entry.dispatchStatus;
          return (
            <div
              key={entry.pageId}
              className={`grid min-w-[230px] gap-2 rounded-lg-v2 border p-2 text-left text-xs transition-colors ${
                active
                  ? 'border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/10'
                  : 'border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 active:bg-Cr-beta-white-8-v2'
              }`}
            >
              <div className="grid min-w-0 gap-2 text-left">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedForBatch}
                      onChange={() => onToggleBatchPage(String(entry.pageId))}
                      aria-label={`Include ${entry.pageName} in selected dispatch batch`}
                      className="h-3.5 w-3.5 shrink-0 accent-dreamy-brand-hot-v2"
                    />
                    <span className="min-w-0 truncate font-semibold text-Cr-text-default-v2">{entry.pageName}</span>
                  </label>
                  <Pill tone={healthPillTone(entry.dispatchStatus)}>{entry.dispatchStatus}</Pill>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-Cr-text-subtler-v2">
                  <span className="truncate">{entry.agentId}</span>
                  <span className="shrink-0">{entry.executor}</span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-Cr-text-subtlest-v2">
                  <span className="truncate">{entry.navigationPath || entry.recommendedAction}</span>
                  {!!entry.missingRouteParams.length && (
                    <span className="shrink-0 font-semibold text-dreamy-brand-hot-v2">
                      {entry.missingRouteParams.join(', ')}
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-1.5">
                <button
                  type="button"
                  onClick={() => onSelectPage(entry.pageId)}
                  aria-label={`Focus ${entry.pageName} dispatch target`}
                  className="inline-flex h-8 items-center justify-center rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-default-v2"
                >
                  Focus
                </button>
                <button
                  type="button"
                  disabled={!entry.dispatchReady || submitting}
                  onClick={() => onRunEntry(entry)}
                  title={entry.dispatchReady ? `Dispatch ${entry.pageName}` : blockedLabel}
                  aria-label={`Dispatch ${entry.pageName}`}
                  className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-default-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
                >
                  <Play size={12} className="shrink-0" />
                  <span className="truncate">{entry.dispatchReady ? 'Dispatch' : blockedLabel}</span>
                </button>
                {entryHref ? (
                  <a
                    data-testid="studio-dispatch-open-link"
                    href={entryHref}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open ${entry.pageName} at ${entryHref}`}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-default-v2 hover:bg-Cr-beta-white-12-v2"
                  >
                    <ExternalLink size={12} />
                    Open
                  </a>
                ) : (
                  <span
                    title="No direct page link for this executor"
                    className="inline-flex h-8 items-center justify-center rounded-md-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-[11px] font-semibold text-Cr-text-subtlest-v2"
                  >
                    Open
                  </span>
                )}
                <button
                  type="button"
                  disabled={!entryHref}
                  onClick={() => onCopyEntryLink(entry)}
                  title={entryHref ? `Copy ${entry.pageName} link` : 'No direct page link to copy'}
                  aria-label={`Copy ${entry.pageName} dispatch link`}
                  className="inline-flex h-8 items-center justify-center rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-default-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
                >
                  <Copy size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
