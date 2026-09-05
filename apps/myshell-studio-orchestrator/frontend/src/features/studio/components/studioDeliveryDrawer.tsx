import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Layers3,
  PanelRightOpen,
  RefreshCcw,
  RotateCcw,
  X,
} from 'lucide-react';
import type {
  StudioAgentCapability,
  StudioApi,
  StudioCoverageReport,
  StudioDeliveryAudit,
  StudioDeliveryBundle,
  StudioDispatchBatchPlan,
  StudioDispatchBatchTarget,
  StudioDispatchMatrix,
  StudioDispatchMatrixEntry,
  StudioDispatchSession,
  StudioDispatchSessionTarget,
  StudioHandoffAction,
  StudioHandoffSnapshot,
  StudioHealth,
  StudioJob,
  StudioOverview,
  StudioOverviewPage,
  StudioPageAdapter,
  StudioProjectDeliveryReport,
  StudioReadiness,
  StudioSegment,
  StudioStatus,
} from '../api';
import {
  healthPillTone,
  QUEUE_STATUS_OPTIONS,
  statusPillTone,
} from '../model/dreamyWorkspace';
import {
  StudioCoverageStrip,
  StudioDeliveryAuditStrip,
  StudioDeliveryCommandCenter,
  StudioDeliveryReportStrip,
  StudioDispatchBatchStrip,
  StudioDispatchMatrixPanel,
  StudioHandoffSnapshotStrip,
} from './delivery';
import { Pill, StudioHealthStrip, StudioReadinessStrip } from './studioStatus';

type MaybePromise<T = unknown> = T | Promise<T>;
type DispatchTarget = StudioDispatchBatchTarget | StudioDispatchSessionTarget;
type QueueStatusFilter = StudioStatus | 'all';

export interface StudioDeliveryDrawerProps {
  open: boolean;
  onClose: () => void;
  health: StudioHealth | null;
  readiness: StudioReadiness | null;
  audit: StudioDeliveryAudit | null;
  report: StudioProjectDeliveryReport | null;
  coverage: StudioCoverageReport | null;
  snapshot: StudioHandoffSnapshot | null;
  bundle: StudioDeliveryBundle | null;
  matrix: StudioDispatchMatrix | null;
  plan: StudioDispatchBatchPlan | null;
  session: StudioDispatchSession | null;
  overview: StudioOverview | null;
  projectId?: string;
  refreshingAudit: boolean;
  verifyingCoverage: boolean;
  planningDispatch: boolean;
  dispatchSessionRunning: boolean;
  bundling: boolean;
  resolvingActionId: string | null;
  resolvingBatch: boolean;
  refreshingHandoff: boolean;
  selectedBatchPageIds: string[];
  submitting: boolean;
  pageOptions: StudioPageAdapter[];
  overviewPages: Array<StudioPageAdapter | StudioOverviewPage>;
  agentOptions: StudioAgentCapability[];
  selectedPageId: StudioApi | string;
  selectedAgentId: string;
  selectedSegment: StudioSegment | null;
  previewDispatchReady?: boolean;
  previewDispatchStatus?: string;
  previewDispatchMode?: string;
  previewNavigationPath?: string;
  previewMissingParams: string[];
  previewDispatchMessage?: string;
  previewAuthMode?: string;
  queueStatusFilter: QueueStatusFilter;
  queuePageFilter: StudioApi | string | 'all';
  queueAgentFilter: string;
  jobs: StudioJob[];
  bulkActionRunning: 'cancel' | 'retry' | null;
  onRefreshAudit: () => MaybePromise;
  onVerifyCoverage: () => MaybePromise;
  onPlanDispatchBatch: (options?: { excludeCovered?: boolean; pageIds?: string[] }) => MaybePromise;
  onStartDispatchSession: (options?: { pageIds?: string[] }) => MaybePromise;
  onRefreshBundle: () => MaybePromise;
  onDownloadAudit: () => void;
  onResolveAuditAction: (action: StudioHandoffAction) => MaybePromise;
  onResolveSafeActions: () => MaybePromise;
  onRefreshHandoff: () => MaybePromise;
  onCancelDispatchSession: () => MaybePromise;
  onRetryDispatchSession: () => MaybePromise;
  onOpenDispatchTarget: (target: DispatchTarget) => MaybePromise;
  onCompleteDispatchTarget: (target: StudioDispatchSessionTarget) => MaybePromise;
  onReviewDispatchTarget: (target: StudioDispatchSessionTarget, status: 'error' | 'skipped') => MaybePromise;
  onChangePage: (pageId: string) => void;
  onChangeAgent: (agentId: string) => void;
  onRefreshSelectedTask: () => MaybePromise;
  onSelectOverviewPage: (pageId: string) => void;
  onToggleBatchPage: (pageId: string) => void;
  onSelectReadyBatchPages: (pageIds: string[]) => void;
  onClearBatchPageSelection: () => void;
  onRunMatrixEntry: (entry: StudioDispatchMatrixEntry) => MaybePromise;
  onCopyMatrixEntryLink: (entry: StudioDispatchMatrixEntry) => MaybePromise;
  onQueueStatusFilterChange: (status: QueueStatusFilter) => void;
  onQueuePageFilterChange: (pageId: StudioApi | string | 'all') => void;
  onQueueAgentFilterChange: (agentId: string) => void;
  onBulkJobAction: (action: 'cancel' | 'retry') => MaybePromise;
  onCancelJob: (jobId: string) => MaybePromise;
  onRetryJob: (jobId: string) => MaybePromise;
}

export function StudioDeliveryDrawer({
  open,
  onClose,
  health,
  readiness,
  audit,
  report,
  coverage,
  snapshot,
  bundle,
  matrix,
  plan,
  session,
  overview,
  projectId,
  refreshingAudit,
  verifyingCoverage,
  planningDispatch,
  dispatchSessionRunning,
  bundling,
  resolvingActionId,
  resolvingBatch,
  refreshingHandoff,
  selectedBatchPageIds,
  submitting,
  pageOptions,
  overviewPages,
  agentOptions,
  selectedPageId,
  selectedAgentId,
  selectedSegment,
  previewDispatchReady,
  previewDispatchStatus,
  previewDispatchMode,
  previewNavigationPath,
  previewMissingParams,
  previewDispatchMessage,
  previewAuthMode,
  queueStatusFilter,
  queuePageFilter,
  queueAgentFilter,
  jobs,
  bulkActionRunning,
  onRefreshAudit,
  onVerifyCoverage,
  onPlanDispatchBatch,
  onStartDispatchSession,
  onRefreshBundle,
  onDownloadAudit,
  onResolveAuditAction,
  onResolveSafeActions,
  onRefreshHandoff,
  onCancelDispatchSession,
  onRetryDispatchSession,
  onOpenDispatchTarget,
  onCompleteDispatchTarget,
  onReviewDispatchTarget,
  onChangePage,
  onChangeAgent,
  onRefreshSelectedTask,
  onSelectOverviewPage,
  onToggleBatchPage,
  onSelectReadyBatchPages,
  onClearBatchPageSelection,
  onRunMatrixEntry,
  onCopyMatrixEntryLink,
  onQueueStatusFilterChange,
  onQueuePageFilterChange,
  onQueueAgentFilterChange,
  onBulkJobAction,
  onCancelJob,
  onRetryJob,
}: StudioDeliveryDrawerProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Delivery evidence center">
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close delivery evidence center"
        onClick={onClose}
      />
      <aside className="relative z-10 flex h-full w-full max-w-[960px] flex-col border-l border-white/10 bg-[#090a0f] shadow-2xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-[#0f1016] px-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <PanelRightOpen size={15} className="text-dreamy-brand-hot-v2" />
              Delivery Evidence
            </div>
            <div className="truncate text-[11px] text-Cr-text-subtler-v2">
              Readiness, coverage, handoff, dispatch matrix, and recoverable queue controls.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md-v2 border border-white/10 bg-white/[0.04] text-Cr-text-subtler-v2 active:bg-white/[0.08]"
            aria-label="Close delivery evidence center"
          >
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StudioHealthStrip health={health} />
          <StudioReadinessStrip readiness={readiness} />
          <StudioDeliveryCommandCenter
            audit={audit}
            coverage={coverage}
            snapshot={snapshot}
            bundle={bundle}
            matrix={matrix}
            plan={plan}
            session={session}
            overview={overview}
            refreshingAudit={refreshingAudit}
            verifyingCoverage={verifyingCoverage}
            planningDispatch={planningDispatch}
            sessionRunning={dispatchSessionRunning}
            bundling={bundling}
            onRefreshAudit={() => void onRefreshAudit()}
            onVerifyCoverage={() => void onVerifyCoverage()}
            onPlanRemaining={() => void onPlanDispatchBatch({ excludeCovered: true })}
            onStartQueue={() => void onStartDispatchSession()}
            onBundle={() => void onRefreshBundle()}
          />
          <StudioDeliveryAuditStrip
            audit={audit}
            refreshing={refreshingAudit}
            resolvingActionId={resolvingActionId}
            resolvingBatch={resolvingBatch}
            onRefresh={() => void onRefreshAudit()}
            onDownload={onDownloadAudit}
            onResolveAction={(action) => void onResolveAuditAction(action)}
            onResolveSafeActions={() => void onResolveSafeActions()}
          />
          <StudioDeliveryReportStrip projectId={projectId} report={report} />
          <StudioCoverageStrip
            coverage={coverage}
            verifying={verifyingCoverage}
            onVerify={() => void onVerifyCoverage()}
          />
          <StudioHandoffSnapshotStrip
            snapshot={snapshot}
            bundle={bundle}
            refreshing={refreshingHandoff}
            bundling={bundling}
            onRefresh={() => void onRefreshHandoff()}
            onBundle={() => void onRefreshBundle()}
          />
          <StudioDispatchBatchStrip
            plan={plan}
            session={session}
            planning={planningDispatch}
            sessionRunning={dispatchSessionRunning}
            selectedPageCount={selectedBatchPageIds.length}
            onPlan={() => void onPlanDispatchBatch()}
            onPlanRemaining={() => void onPlanDispatchBatch({ excludeCovered: true })}
            onPlanSelected={() => void onPlanDispatchBatch({ pageIds: selectedBatchPageIds })}
            onStartSession={() => void onStartDispatchSession()}
            onStartSelectedSession={() => void onStartDispatchSession({ pageIds: selectedBatchPageIds })}
            onCancelSession={() => void onCancelDispatchSession()}
            onRetrySession={() => void onRetryDispatchSession()}
            onOpenTarget={(target) => void onOpenDispatchTarget(target)}
            onCompleteTarget={(target) => void onCompleteDispatchTarget(target)}
            onErrorTarget={(target) => void onReviewDispatchTarget(target, 'error')}
            onSkipTarget={(target) => void onReviewDispatchTarget(target, 'skipped')}
          />

          <StudioRuntimeDispatchPanel
            pageOptions={pageOptions}
            agentOptions={agentOptions}
            selectedPageId={selectedPageId}
            selectedAgentId={selectedAgentId}
            canRefreshSelectedTask={Boolean(selectedSegment?.taskId)}
            previewDispatchReady={previewDispatchReady}
            previewDispatchStatus={previewDispatchStatus}
            previewDispatchMode={previewDispatchMode}
            previewNavigationPath={previewNavigationPath}
            previewMissingParams={previewMissingParams}
            previewDispatchMessage={previewDispatchMessage}
            previewAuthMode={previewAuthMode}
            onChangePage={onChangePage}
            onChangeAgent={onChangeAgent}
            onRefreshSelectedTask={onRefreshSelectedTask}
          />

          <StudioPageRegistryPanel
            overview={overview}
            overviewPages={overviewPages}
            selectedPageId={selectedPageId}
            onSelectPage={onSelectOverviewPage}
          />

          <StudioDispatchMatrixPanel
            matrix={matrix}
            selectedPageId={selectedPageId}
            selectedBatchPageIds={selectedBatchPageIds}
            submitting={submitting}
            onSelectPage={onSelectOverviewPage}
            onToggleBatchPage={onToggleBatchPage}
            onSelectReadyBatchPages={onSelectReadyBatchPages}
            onClearBatchPageSelection={onClearBatchPageSelection}
            onRunEntry={(entry) => void onRunMatrixEntry(entry)}
            onCopyEntryLink={(entry) => void onCopyMatrixEntryLink(entry)}
          />

          <StudioDispatchQueuePanel
            jobs={jobs}
            pageOptions={pageOptions}
            agentOptions={agentOptions}
            statusFilter={queueStatusFilter}
            pageFilter={queuePageFilter}
            agentFilter={queueAgentFilter}
            bulkActionRunning={bulkActionRunning}
            onStatusFilterChange={onQueueStatusFilterChange}
            onPageFilterChange={onQueuePageFilterChange}
            onAgentFilterChange={onQueueAgentFilterChange}
            onBulkAction={onBulkJobAction}
            onCancelJob={onCancelJob}
            onRetryJob={onRetryJob}
          />
        </div>
      </aside>
    </div>
  );
}

function StudioRuntimeDispatchPanel({
  pageOptions,
  agentOptions,
  selectedPageId,
  selectedAgentId,
  canRefreshSelectedTask,
  previewDispatchReady,
  previewDispatchStatus,
  previewDispatchMode,
  previewNavigationPath,
  previewMissingParams,
  previewDispatchMessage,
  previewAuthMode,
  onChangePage,
  onChangeAgent,
  onRefreshSelectedTask,
}: {
  pageOptions: StudioPageAdapter[];
  agentOptions: StudioAgentCapability[];
  selectedPageId: StudioApi | string;
  selectedAgentId: string;
  canRefreshSelectedTask: boolean;
  previewDispatchReady?: boolean;
  previewDispatchStatus?: string;
  previewDispatchMode?: string;
  previewNavigationPath?: string;
  previewMissingParams: string[];
  previewDispatchMessage?: string;
  previewAuthMode?: string;
  onChangePage: (pageId: string) => void;
  onChangeAgent: (agentId: string) => void;
  onRefreshSelectedTask: () => MaybePromise;
}) {
  return (
    <div className="grid shrink-0 gap-2 border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <label className="grid gap-1">
        <span className="text-[10px] font-semibold uppercase text-Cr-text-subtlest-v2">Page</span>
        <select
          value={selectedPageId}
          onChange={(event) => onChangePage(event.target.value)}
          className="h-10 min-w-0 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2 outline-none"
          aria-label="Studio page adapter"
        >
          {pageOptions.map((page) => (
            <option key={page.id} value={page.id}>{page.name}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-[10px] font-semibold uppercase text-Cr-text-subtlest-v2">Agent</span>
        <select
          value={selectedAgentId}
          onChange={(event) => onChangeAgent(event.target.value)}
          className="h-10 min-w-0 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2 outline-none"
          aria-label="Studio agent"
        >
          {agentOptions.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => void onRefreshSelectedTask()}
        disabled={!canRefreshSelectedTask}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg-v2 bg-Cr-Bg-surface-subtle-v2 px-3 text-xs font-semibold text-Cr-text-subtle-v2 disabled:opacity-40 sm:self-end"
      >
        <RotateCcw size={14} />
        Refresh
      </button>
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 py-2 sm:col-span-3 [-webkit-overflow-scrolling:touch]">
        {previewDispatchReady ? (
          <CheckCircle2 size={14} className="shrink-0 text-Cr-text-success-default-v2" />
        ) : (
          <AlertTriangle size={14} className="shrink-0 text-Cr-text-critical-default-v2" />
        )}
        <Pill tone={healthPillTone(previewDispatchStatus)}>{previewDispatchStatus || 'unknown'}</Pill>
        <span className="shrink-0 text-[11px] font-semibold text-Cr-text-subtler-v2">
          {previewDispatchMode || 'dispatch'}
        </span>
        {previewNavigationPath && (
          <span className="shrink-0 text-[11px] font-semibold text-Cr-text-subtle-v2">
            {previewNavigationPath}
          </span>
        )}
        {!!previewMissingParams.length && (
          <Pill tone="hot">{`Missing ${previewMissingParams.join(', ')}`}</Pill>
        )}
        <span className="min-w-[160px] truncate text-[11px] text-Cr-text-subtler-v2">
          {previewDispatchMessage || previewAuthMode || 'No runtime status'}
        </span>
      </div>
    </div>
  );
}

function StudioPageRegistryPanel({
  overview,
  overviewPages,
  selectedPageId,
  onSelectPage,
}: {
  overview: StudioOverview | null;
  overviewPages: Array<StudioPageAdapter | StudioOverviewPage>;
  selectedPageId: StudioApi | string;
  onSelectPage: (pageId: string) => void;
}) {
  return (
    <div className="shrink-0 border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-Cr-text-subtle-v2">
          <Layers3 size={14} />
          Page Registry
        </div>
        <div className="flex max-w-full items-center gap-2 overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <Pill>{`${overview?.totals?.pages || overviewPages.length} pages`}</Pill>
          <Pill tone={overview?.totals?.issues ? 'danger' : 'default'}>{`${overview?.totals?.issues || 0} issues`}</Pill>
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
        {overviewPages.map((page) => {
          const overviewPage = page as StudioOverviewPage;
          const counts = overviewPage.jobCounts || {};
          const queued = counts.queued || 0;
          const running = counts.running || 0;
          const done = counts.done || 0;
          const issueCount = (counts.timeout || 0) + (counts.auth_missing || 0) + (counts.error || 0);
          const active = page.id === selectedPageId;
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => onSelectPage(page.id)}
              className={`grid min-w-[210px] gap-2 rounded-lg-v2 border p-2 text-left text-xs transition-colors ${
                active
                  ? 'border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/10'
                  : 'border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 active:bg-Cr-beta-white-8-v2'
              }`}
              aria-label={`Select ${page.name} page`}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0 truncate font-semibold text-Cr-text-default-v2">{page.name}</div>
                <Pill tone={healthPillTone(page.dispatchStatus)}>{page.dispatchStatus || 'unknown'}</Pill>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-Cr-text-subtler-v2">
                <span className="truncate">{page.executor}</span>
                <span className="shrink-0">{`Q${queued} R${running} D${done}`}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] text-Cr-text-subtlest-v2">
                <span className="truncate">{overviewPage.latestJob?.status || page.dispatchMode || page.authMode}</span>
                {issueCount > 0 && <span className="font-semibold text-Cr-text-critical-default-v2">{`${issueCount} issue`}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StudioDispatchQueuePanel({
  jobs,
  pageOptions,
  agentOptions,
  statusFilter,
  pageFilter,
  agentFilter,
  bulkActionRunning,
  onStatusFilterChange,
  onPageFilterChange,
  onAgentFilterChange,
  onBulkAction,
  onCancelJob,
  onRetryJob,
}: {
  jobs: StudioJob[];
  pageOptions: StudioPageAdapter[];
  agentOptions: StudioAgentCapability[];
  statusFilter: QueueStatusFilter;
  pageFilter: StudioApi | string | 'all';
  agentFilter: string;
  bulkActionRunning: 'cancel' | 'retry' | null;
  onStatusFilterChange: (status: QueueStatusFilter) => void;
  onPageFilterChange: (pageId: StudioApi | string | 'all') => void;
  onAgentFilterChange: (agentId: string) => void;
  onBulkAction: (action: 'cancel' | 'retry') => MaybePromise;
  onCancelJob: (jobId: string) => MaybePromise;
  onRetryJob: (jobId: string) => MaybePromise;
}) {
  return (
    <div className="shrink-0 border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-Cr-text-subtle-v2">
          <GitBranch size={14} />
          Dispatch Queue
        </div>
        <div className="flex items-center gap-2">
          <Pill>{`${jobs.length} jobs`}</Pill>
          <button
            type="button"
            disabled={!jobs.length || bulkActionRunning !== null}
            onClick={() => void onBulkAction('cancel')}
            className="inline-flex h-7 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:opacity-40"
          >
            <X size={12} />
            Bulk Cancel
          </button>
          <button
            type="button"
            disabled={!jobs.length || bulkActionRunning !== null}
            onClick={() => void onBulkAction('retry')}
            className="inline-flex h-7 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:opacity-40"
          >
            <RefreshCcw size={12} className={bulkActionRunning === 'retry' ? 'animate-spin' : ''} />
            Bulk Retry
          </button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <select
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value as QueueStatusFilter)}
          className="h-9 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2 outline-none"
          aria-label="Queue status filter"
        >
          {QUEUE_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>{status === 'all' ? 'All statuses' : status}</option>
          ))}
        </select>
        <select
          value={pageFilter}
          onChange={(event) => onPageFilterChange(event.target.value)}
          className="h-9 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2 outline-none"
          aria-label="Queue page filter"
        >
          <option value="all">All pages</option>
          {pageOptions.map((page) => (
            <option key={page.id} value={page.id}>{page.name}</option>
          ))}
        </select>
        <select
          value={agentFilter}
          onChange={(event) => onAgentFilterChange(event.target.value)}
          className="h-9 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2 outline-none"
          aria-label="Queue agent filter"
        >
          <option value="all">All agents</option>
          {agentOptions.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.label}</option>
          ))}
        </select>
      </div>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
        {jobs.slice(0, 6).map((job) => (
          <div
            key={job.jobId}
            className="grid min-w-[240px] gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 p-2 text-xs"
          >
            <div className="min-w-0">
              <div className="truncate font-semibold text-Cr-text-default-v2">{job.pageName}</div>
              <div className="truncate text-[11px] text-Cr-text-subtler-v2">{job.agentId} / {job.botName}</div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Pill tone={statusPillTone(job.status)}>{job.status}</Pill>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={job.status === 'cancelled'}
                  onClick={() => void onCancelJob(job.jobId)}
                  className="h-7 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void onRetryJob(job.jobId)}
                  className="h-7 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        ))}
        {!jobs.length && (
          <div className="flex h-16 min-w-[220px] items-center justify-center rounded-lg-v2 border border-dashed border-Cr-border-default-v2 text-xs text-Cr-text-subtler-v2">
            No jobs match filters
          </div>
        )}
      </div>
    </div>
  );
}
