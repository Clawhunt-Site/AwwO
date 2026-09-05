import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  GitBranch,
  Loader2,
  Play,
  RefreshCcw,
  SlidersHorizontal,
} from 'lucide-react';
import type {
  StudioCoverageReport,
  StudioDeliveryAudit,
  StudioDeliveryBundle,
  StudioDispatchBatchPlan,
  StudioDispatchMatrix,
  StudioDispatchSession,
  StudioHandoffAction,
  StudioHandoffArtifact,
  StudioHandoffSnapshot,
  StudioOverview,
  StudioProjectDeliveryReport,
} from '../../api';
import { handoffItemPriority, handoffPillTone, healthPillTone } from '../../model/dreamyWorkspace';
import { Pill } from '../studioStatus';
import { actionUiHref, artifactHref } from './utils';

export function StudioArtifactLinks({
  artifacts,
  limit = 4,
}: {
  artifacts?: StudioHandoffArtifact[];
  limit?: number;
}) {
  const visibleArtifacts = (artifacts || []).filter((artifact) => artifact.url || artifact.endpoint).slice(0, limit);
  if (!visibleArtifacts.length) return null;

  return (
    <>
      {visibleArtifacts.map((artifact) => (
        <a
          key={`${artifact.id}:${artifact.url || artifact.endpoint}`}
          data-testid="studio-artifact-link"
          href={artifactHref(artifact)}
          target="_blank"
          rel="noreferrer"
          title={artifact.uiUrl || artifact.url || artifact.endpoint}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2 hover:bg-Cr-beta-white-8-v2"
        >
          <ExternalLink size={12} className="text-Cr-text-subtlest-v2" />
          <span className="max-w-[130px] truncate">{artifact.label || artifact.id}</span>
        </a>
      ))}
      {(artifacts || []).length > visibleArtifacts.length && <Pill>{`+${(artifacts || []).length - visibleArtifacts.length} artifacts`}</Pill>}
    </>
  );
}

export function StudioDeliveryCommandCenter({
  audit,
  coverage,
  snapshot,
  bundle,
  matrix,
  plan,
  session,
  overview,
  refreshingAudit,
  verifyingCoverage,
  planningDispatch,
  sessionRunning,
  bundling,
  onRefreshAudit,
  onVerifyCoverage,
  onPlanRemaining,
  onStartQueue,
  onBundle,
}: {
  audit: StudioDeliveryAudit | null;
  coverage: StudioCoverageReport | null;
  snapshot: StudioHandoffSnapshot | null;
  bundle: StudioDeliveryBundle | null;
  matrix: StudioDispatchMatrix | null;
  plan: StudioDispatchBatchPlan | null;
  session: StudioDispatchSession | null;
  overview: StudioOverview | null;
  refreshingAudit: boolean;
  verifyingCoverage: boolean;
  planningDispatch: boolean;
  sessionRunning: boolean;
  bundling: boolean;
  onRefreshAudit: () => void;
  onVerifyCoverage: () => void;
  onPlanRemaining: () => void;
  onStartQueue: () => void;
  onBundle: () => void;
}) {
  const coverageSummary = coverage?.summary;
  const matrixSummary = matrix?.summary;
  const snapshotSummary = snapshot?.summary;
  const sessionSummary = session?.summary;
  const totalPages =
    coverageSummary?.total ||
    matrixSummary?.total ||
    snapshotSummary?.pages ||
    audit?.summary?.pages ||
    overview?.totals?.pages ||
    0;
  const coveredPages = coverageSummary?.covered || snapshotSummary?.covered || 0;
  const readyTargets = matrixSummary?.ready || audit?.summary?.readyTargets || 0;
  const pendingTargets = sessionSummary?.pending ?? plan?.summary?.planned ?? 0;
  const visitedTargets = sessionSummary?.visited || bundle?.summary?.visitedTargets || 0;
  const actionCount = audit?.summary?.actions ?? snapshotSummary?.unresolvedActions ?? bundle?.summary?.actions ?? 0;
  const issueCount =
    (coverageSummary?.blocked || 0) +
    (coverageSummary?.issues || 0) +
    (overview?.totals?.issues || 0) +
    (bundle?.summary?.errorTargets || 0);
  const coveragePercent = totalPages ? Math.round((coveredPages / totalPages) * 100) : 0;
  const readyPercent = totalPages ? Math.round((readyTargets / totalPages) * 100) : 0;
  const canVerify = Boolean(coverageSummary?.readyUnverified);
  const canStartQueue = Boolean(plan && !sessionRunning);

  return (
    <section
      data-testid="delivery-command-center"
      className="grid gap-3 border-b border-Cr-border-default-v2 bg-[#0d1018] p-3"
      aria-label="Delivery Command Center"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-Cr-text-default-v2">
            <SlidersHorizontal size={15} className="text-dreamy-brand-hot-v2" />
            Delivery Command Center
          </div>
          <div className="text-[11px] text-Cr-text-subtler-v2">
            {`${totalPages || 0} pages / ${readyTargets} ready / ${actionCount} actions`}
          </div>
        </div>
        <div className="flex max-w-full gap-2 overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <button
            type="button"
            disabled={refreshingAudit}
            onClick={onRefreshAudit}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md-v2 border border-white/10 bg-white/[0.05] px-2.5 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:opacity-50"
          >
            <RefreshCcw size={12} className={refreshingAudit ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            disabled={!canVerify || verifyingCoverage}
            onClick={onVerifyCoverage}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md-v2 border border-white/10 bg-white/[0.05] px-2.5 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:opacity-50"
          >
            <CheckCircle2 size={12} className={verifyingCoverage ? 'animate-pulse' : ''} />
            Verify Ready
          </button>
          <button
            type="button"
            disabled={planningDispatch}
            onClick={onPlanRemaining}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md-v2 border border-white/10 bg-white/[0.05] px-2.5 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:opacity-50"
          >
            <GitBranch size={12} className={planningDispatch ? 'animate-pulse' : ''} />
            Plan Remaining
          </button>
          <button
            type="button"
            disabled={!canStartQueue}
            onClick={onStartQueue}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md-v2 border border-dreamy-brand-hot-v2/50 bg-dreamy-brand-hot-v2/15 px-2.5 text-[11px] font-semibold text-dreamy-brand-hot-v2 disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-Cr-text-subtlest-v2"
          >
            <Play size={12} />
            Start Queue
          </button>
          <button
            type="button"
            disabled={bundling}
            onClick={onBundle}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md-v2 border border-white/10 bg-white/[0.05] px-2.5 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:opacity-50"
          >
            <Download size={12} className={bundling ? 'animate-pulse' : ''} />
            Bundle
          </button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="grid gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase text-Cr-text-subtlest-v2">Delivery</span>
            <Pill tone={handoffPillTone(snapshot?.status || audit?.status)}>{snapshot?.status || audit?.status || 'checking'}</Pill>
          </div>
          <div className="text-2xl font-semibold text-Cr-text-default-v2">{coveragePercent}%</div>
          <div className="text-[11px] text-Cr-text-subtler-v2">{`${coveredPages}/${totalPages || 0} pages covered`}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-Cr-text-success-default-v2" style={{ width: `${Math.min(100, coveragePercent)}%` }} />
          </div>
        </div>

        <div className="grid gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase text-Cr-text-subtlest-v2">Dispatch Matrix</span>
            <Pill tone={readyTargets === totalPages && totalPages ? 'success' : 'hot'}>{`${readyTargets}/${totalPages || 0}`}</Pill>
          </div>
          <div className="text-2xl font-semibold text-Cr-text-default-v2">{readyPercent}%</div>
          <div className="text-[11px] text-Cr-text-subtler-v2">{`${matrixSummary?.navigation || 0} nav / ${matrixSummary?.client || 0} client / ${matrixSummary?.server || 0} server`}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-dreamy-brand-hot-v2" style={{ width: `${Math.min(100, readyPercent)}%` }} />
          </div>
        </div>

        <div className="grid gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase text-Cr-text-subtlest-v2">Queue</span>
            <Pill tone={session?.status === 'active' ? 'success' : plan ? 'hot' : 'default'}>{session?.status || plan?.status || 'idle'}</Pill>
          </div>
          <div className="text-2xl font-semibold text-Cr-text-default-v2">{pendingTargets}</div>
          <div className="text-[11px] text-Cr-text-subtler-v2">{`${visitedTargets} visited / ${sessionSummary?.completed || bundle?.summary?.completedTargets || 0} done`}</div>
          <div className="flex gap-1">
            <Pill tone={sessionSummary?.targetErrors || bundle?.summary?.errorTargets ? 'danger' : 'default'}>
              {`${sessionSummary?.targetErrors || bundle?.summary?.errorTargets || 0} errors`}
            </Pill>
            <Pill tone={sessionSummary?.targetSkipped || bundle?.summary?.skippedTargets ? 'hot' : 'default'}>
              {`${sessionSummary?.targetSkipped || bundle?.summary?.skippedTargets || 0} skipped`}
            </Pill>
          </div>
        </div>

        <div className="grid gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase text-Cr-text-subtlest-v2">Operator Actions</span>
            <Pill tone={issueCount ? 'danger' : actionCount ? 'hot' : 'success'}>{issueCount ? `${issueCount} issues` : `${actionCount} actions`}</Pill>
          </div>
          <div className="text-2xl font-semibold text-Cr-text-default-v2">{actionCount}</div>
          <div className="text-[11px] text-Cr-text-subtler-v2">{`${audit?.summary?.artifacts || snapshot?.artifacts.length || bundle?.summary?.artifacts || 0} artifacts ready`}</div>
          <div className="flex gap-1">
            <Pill tone={snapshot?.readyForDelivery ? 'success' : 'default'}>{snapshot?.readyForDelivery ? 'deliverable' : 'review'}</Pill>
            <Pill tone={bundle?.readyForDelivery ? 'success' : 'default'}>{bundle ? `bundle ${bundle.status}` : 'bundle pending'}</Pill>
          </div>
        </div>
      </div>
    </section>
  );
}

export function StudioDeliveryAuditStrip({
  audit,
  refreshing,
  resolvingActionId,
  resolvingBatch,
  onRefresh,
  onDownload,
  onResolveAction,
  onResolveSafeActions,
}: {
  audit: StudioDeliveryAudit | null;
  refreshing: boolean;
  resolvingActionId: string | null;
  resolvingBatch: boolean;
  onRefresh: () => void;
  onDownload: () => void;
  onResolveAction: (action: StudioHandoffAction) => void;
  onResolveSafeActions: () => void;
}) {
  const summary = audit?.summary;
  const gaps = (audit?.requirements || []).filter((item) => item.status !== 'ready');
  const actions = audit?.actions || [];
  const visibleActions = [...actions].sort((first, second) => handoffItemPriority(first) - handoffItemPriority(second)).slice(0, 3);
  const safeActionCount = actions.filter(
    (action) => action.action === 'verify-ready' || action.action === 'run-target' || action.action === 'retry-queue',
  ).length;

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-2 [-webkit-overflow-scrolling:touch]">
      <Pill tone={healthPillTone(audit?.status)}>
        {audit ? `Audit ${audit.status}` : 'Audit checking'}
      </Pill>
      <button
        type="button"
        disabled={refreshing}
        onClick={onRefresh}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <RefreshCcw size={12} className={refreshing ? 'animate-spin' : ''} />
        Refresh Audit
      </button>
      <button
        type="button"
        disabled={!audit}
        onClick={onDownload}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <Download size={12} />
        Audit JSON
      </button>
      <button
        type="button"
        disabled={!safeActionCount || resolvingBatch || Boolean(resolvingActionId)}
        onClick={onResolveSafeActions}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        {resolvingBatch ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
        Resolve Safe
      </button>
      {summary && (
        <>
          <Pill tone={summary.missingCorePages || summary.missingCoreAgents ? 'danger' : 'success'}>{`${summary.pages} pages`}</Pill>
          <Pill tone={summary.missingCoreAgents ? 'danger' : 'success'}>{`${summary.agents} agents`}</Pill>
          <Pill tone={summary.readyTargets === summary.pages ? 'success' : 'hot'}>{`${summary.readyTargets}/${summary.pages} ready`}</Pill>
          <Pill tone={summary.missingParams ? 'hot' : 'default'}>{`${summary.missingParams} missing params`}</Pill>
          <Pill tone={summary.actions ? 'hot' : 'success'}>{`${summary.actions || 0} actions`}</Pill>
          <Pill>{`${summary.artifacts} artifacts`}</Pill>
          <StudioArtifactLinks artifacts={audit?.artifacts} limit={4} />
        </>
      )}
      {visibleActions.map((action) => {
        const resolving = resolvingActionId === action.id;
        const uiHref = actionUiHref(action);
        return (
          <span
            key={action.id}
            className="inline-flex h-6 shrink-0 items-center gap-1"
          >
            <button
              type="button"
              title={action.message || action.reason || action.action}
              disabled={Boolean(resolvingActionId) || resolvingBatch}
              onClick={() => onResolveAction(action)}
              className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2 disabled:opacity-60"
            >
              {resolving ? (
                <Loader2 size={12} className="animate-spin text-dreamy-brand-hot-v2" />
              ) : (
                <GitBranch size={12} className="text-dreamy-brand-hot-v2" />
              )}
              <span className="max-w-[130px] truncate">{action.targetName || action.targetId || action.kind}</span>
              <span className="text-Cr-text-subtlest-v2">{action.action}</span>
            </button>
            {uiHref && (
              <a
                data-testid="studio-action-ui-link"
                href={uiHref}
                target="_blank"
                rel="noreferrer"
                title={uiHref}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-1.5 text-[11px] font-semibold text-Cr-text-subtler-v2 hover:bg-Cr-beta-white-8-v2"
              >
                <ExternalLink size={12} className="text-Cr-text-subtlest-v2" />
                Open
              </a>
            )}
          </span>
        );
      })}
      {gaps.slice(0, 5).map((item) => {
        const tone = healthPillTone(item.status);
        const Icon = tone === 'success' ? CheckCircle2 : AlertTriangle;
        return (
          <span
            key={item.id}
            title={item.message || item.id}
            className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
          >
            <Icon
              size={12}
              className={
                tone === 'danger'
                  ? 'text-Cr-text-critical-default-v2'
                  : tone === 'success'
                    ? 'text-Cr-text-success-default-v2'
                    : 'text-dreamy-brand-hot-v2'
              }
            />
            <span className="max-w-[130px] truncate">{item.label}</span>
            <span className="text-Cr-text-subtlest-v2">{item.status}</span>
          </span>
        );
      })}
      {actions.length > 3 && <Pill tone="hot">{`+${actions.length - 3} actions`}</Pill>}
    </div>
  );
}

export function StudioDeliveryReportStrip({
  projectId,
  report,
}: {
  projectId?: string;
  report: StudioProjectDeliveryReport | null;
}) {
  if (!projectId) return null;
  const summary = report?.summary;
  const actions = report?.unresolvedActions || [];

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-2 [-webkit-overflow-scrolling:touch]">
      <Pill tone={handoffPillTone(report?.handoffStatus)}>
        {report ? `Project ${report.handoffStatus}` : 'Project checking'}
      </Pill>
      {summary && (
        <>
          <Pill tone={summary.acceptedEvidence ? 'success' : 'default'}>{`${summary.acceptedEvidence} accepted`}</Pill>
          <Pill tone={summary.pendingEvidence ? 'hot' : 'default'}>{`${summary.pendingEvidence} pending`}</Pill>
          <Pill tone={summary.issueCount ? 'danger' : 'default'}>{`${summary.issueCount} issues`}</Pill>
        </>
      )}
      {actions.slice(0, 4).map((action) => (
        <span
          key={`${action.segmentId || action.jobId || action.action}_${action.action}`}
          title={action.message || action.action}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
        >
          <AlertTriangle size={12} className="text-dreamy-brand-hot-v2" />
          <span className="max-w-[130px] truncate">{action.action}</span>
          <span className="text-Cr-text-subtlest-v2">{action.status}</span>
        </span>
      ))}
      {actions.length > 4 && <Pill tone="hot">{`+${actions.length - 4} actions`}</Pill>}
    </div>
  );
}

export function StudioCoverageStrip({
  coverage,
  verifying,
  onVerify,
}: {
  coverage: StudioCoverageReport | null;
  verifying: boolean;
  onVerify: () => void;
}) {
  const summary = coverage?.summary;
  const gaps = (coverage?.pages || []).filter((page) => page.coverageStatus !== 'covered');
  const canVerify = Boolean(summary?.readyUnverified);

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-2 [-webkit-overflow-scrolling:touch]">
      <Pill tone={coverage?.status === 'blocked' ? 'danger' : coverage?.status === 'ready' ? 'success' : 'hot'}>
        {coverage ? `Coverage ${coverage.status}` : 'Coverage checking'}
      </Pill>
      <button
        type="button"
        disabled={!canVerify || verifying}
        onClick={onVerify}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <RefreshCcw size={12} className={verifying ? 'animate-spin' : ''} />
        Verify Ready
      </button>
      {summary && (
        <>
          <Pill tone={summary.covered === summary.total ? 'success' : 'hot'}>{`${summary.covered}/${summary.total} covered`}</Pill>
          <Pill tone={summary.pending ? 'hot' : 'default'}>{`${summary.pending} pending`}</Pill>
          <Pill tone={summary.readyUnverified ? 'hot' : 'default'}>{`${summary.readyUnverified} unverified`}</Pill>
          <Pill tone={summary.blocked ? 'danger' : 'default'}>{`${summary.blocked} blocked`}</Pill>
        </>
      )}
      {gaps.slice(0, 6).map((page) => (
        <span
          key={page.pageId}
          title={page.dispatchMessage || page.latestEvidence?.message || page.coverageStatus}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
        >
          <AlertTriangle
            size={12}
            className={page.coverageStatus === 'blocked' ? 'text-Cr-text-critical-default-v2' : 'text-dreamy-brand-hot-v2'}
          />
          <span className="max-w-[120px] truncate">{page.pageName}</span>
          <span className="text-Cr-text-subtlest-v2">{page.coverageStatus}</span>
        </span>
      ))}
      {gaps.length > 6 && <Pill tone="hot">{`+${gaps.length - 6} gaps`}</Pill>}
    </div>
  );
}

export function StudioHandoffSnapshotStrip({
  snapshot,
  bundle,
  refreshing,
  bundling,
  onRefresh,
  onBundle,
}: {
  snapshot: StudioHandoffSnapshot | null;
  bundle: StudioDeliveryBundle | null;
  refreshing: boolean;
  bundling: boolean;
  onRefresh: () => void;
  onBundle: () => void;
}) {
  const summary = snapshot?.summary;
  const gaps = snapshot?.gaps || [];
  const actions = snapshot?.actions || [];
  const visibleGaps = [...gaps].sort((first, second) => handoffItemPriority(first) - handoffItemPriority(second)).slice(0, 4);
  const visibleActions = [...actions].sort((first, second) => handoffItemPriority(first) - handoffItemPriority(second)).slice(0, 4);

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-2 [-webkit-overflow-scrolling:touch]">
      <Pill tone={handoffPillTone(snapshot?.status)}>
        {snapshot ? `Handoff ${snapshot.status}` : 'Handoff checking'}
      </Pill>
      <button
        type="button"
        disabled={refreshing}
        onClick={onRefresh}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <RefreshCcw size={12} className={refreshing ? 'animate-spin' : ''} />
        Refresh Handoff
      </button>
      <button
        type="button"
        disabled={bundling}
        onClick={onBundle}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
      >
        <Download size={12} className={bundling ? 'animate-pulse' : ''} />
        Bundle
      </button>
      {summary && (
        <>
          <Pill tone={snapshot?.readyForDelivery ? 'success' : 'default'}>
            {snapshot?.readyForDelivery ? 'deliverable' : 'not deliverable'}
          </Pill>
          <Pill tone={summary.covered === summary.pages ? 'success' : 'hot'}>{`${summary.covered}/${summary.pages} pages`}</Pill>
          <Pill tone={summary.gaps ? 'danger' : 'default'}>{`${summary.gaps} gaps`}</Pill>
          <Pill tone={summary.unresolvedActions ? 'hot' : 'default'}>{`${summary.unresolvedActions} actions`}</Pill>
          <Pill tone={summary.deliveryAcceptedEvidence || summary.acceptedEvidence ? 'success' : 'default'}>
            {`${summary.deliveryAcceptedEvidence || summary.acceptedEvidence} evidence`}
          </Pill>
          <Pill>{`${summary.jobs} jobs`}</Pill>
          <Pill>{`${snapshot?.artifacts.length || 0} artifacts`}</Pill>
          <StudioArtifactLinks artifacts={bundle?.artifacts || snapshot?.artifacts} limit={4} />
        </>
      )}
      {bundle && (
        <>
          <Pill tone={bundle.summary.acceptedJobs ? 'success' : 'default'}>{`${bundle.summary.acceptedJobs} accepted jobs`}</Pill>
          <Pill tone={bundle.summary.remainingTargets ? 'hot' : 'success'}>{`${bundle.summary.remainingTargets || 0} remaining`}</Pill>
          <Pill tone={bundle.summary.errorTargets ? 'danger' : 'default'}>{`${bundle.summary.errorTargets || 0} errors`}</Pill>
          <Pill>{`${bundle.summary.artifacts} bundle artifacts`}</Pill>
        </>
      )}
      {visibleGaps.map((gap) => (
        <span
          key={gap.id}
          title={gap.message || gap.reason}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
        >
          <AlertTriangle size={12} className={gap.status === 'blocked' ? 'text-Cr-text-critical-default-v2' : 'text-dreamy-brand-hot-v2'} />
          <span className="max-w-[120px] truncate">{gap.pageName || gap.pageId || gap.id}</span>
          <span className="text-Cr-text-subtlest-v2">{gap.reason}</span>
        </span>
      ))}
      {visibleActions.map((action) => {
        const uiHref = actionUiHref(action);
        return (
          <span
            key={action.id}
            className="inline-flex h-6 shrink-0 items-center gap-1"
          >
            <span
              title={action.message || action.reason || action.action}
              className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
            >
              <GitBranch size={12} className="text-dreamy-brand-hot-v2" />
              <span className="max-w-[130px] truncate">{action.targetName || action.targetId || action.kind}</span>
              <span className="text-Cr-text-subtlest-v2">{action.action}</span>
            </span>
            {uiHref && (
              <a
                data-testid="studio-action-ui-link"
                href={uiHref}
                target="_blank"
                rel="noreferrer"
                title={uiHref}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-1.5 text-[11px] font-semibold text-Cr-text-subtler-v2 hover:bg-Cr-beta-white-8-v2"
              >
                <ExternalLink size={12} className="text-Cr-text-subtlest-v2" />
                Open
              </a>
            )}
          </span>
        );
      })}
    </div>
  );
}
