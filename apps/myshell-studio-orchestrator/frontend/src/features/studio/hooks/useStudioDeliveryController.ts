import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import {
  fetchStudioCoverage,
  fetchStudioDeliveryAudit,
  fetchStudioDispatchMatrix,
  fetchStudioDispatchSession,
  fetchStudioDispatchSessions,
  fetchStudioHandoffSnapshot,
  fetchStudioHealth,
  fetchStudioOverview,
  fetchStudioProjectDeliveryBundle,
  fetchStudioProjectDeliveryReport,
  fetchStudioReadiness,
} from '../api';
import type {
  StudioDeliveryAudit,
  StudioDispatchSession,
  StudioHandoffSnapshot,
  StudioProject,
} from '../api';
import {
  readLastStudioProjectId,
  readStudioDispatchSession,
} from '../session';
import { readDispatchSessionRestoreParams } from '../components/delivery';
import type { ChatItem } from '../model/dreamyWorkspace';
import {
  deliveryAuditFilename,
  deliveryBundleFilename,
  downloadJsonPayload,
  makeId,
  nowIso,
} from '../model/dreamyWorkspace';
import { useStudioDeliveryState } from './useStudioDeliveryState';
import { useStudioDispatchSessionController } from './useStudioDispatchSessionController';

interface StudioDeliveryControllerOptions {
  hubJobsVersion: string;
  navigate: NavigateFunction;
  project: StudioProject | null;
  selectedSegment: { id: string } | null;
  setMessages: Dispatch<SetStateAction<ChatItem[]>>;
}

export function useStudioDeliveryController({
  hubJobsVersion,
  navigate,
  project,
  selectedSegment,
  setMessages,
}: StudioDeliveryControllerOptions) {
  const restoredDispatchUrlRef = useRef('');
  const {
    applyDeliveryAudit,
    applyDispatchSession,
    applyHandoffSnapshot,
    clearDispatchBatchPages,
    copyMatrixEntryLink,
    coverageReport,
    coverageVerifyRunning,
    deliveryAudit,
    deliveryAuditRefreshing,
    deliveryBundle,
    deliveryBundleLoading,
    deliveryReport,
    dispatchBatchPlan,
    dispatchBatchPlanning,
    dispatchMatrix,
    dispatchSession,
    dispatchSessionRunning,
    handoffRefreshing,
    handoffSnapshot,
    resetDeliveryState,
    resolvingAuditActionId,
    resolvingAuditBatch,
    selectDispatchBatchPages,
    selectedDispatchBatchPageIds,
    setCoverageReport,
    setCoverageVerifyRunning,
    setDeliveryAuditRefreshing,
    setDeliveryBundle,
    setDeliveryBundleLoading,
    setDeliveryReport,
    setDispatchBatchPlan,
    setDispatchBatchPlanning,
    setDispatchMatrix,
    setDispatchSessionRunning,
    setHandoffRefreshing,
    setResolvingAuditActionId,
    setResolvingAuditBatch,
    setStudioHealth,
    setStudioOverview,
    setStudioReadiness,
    studioContextSourceSegmentId,
    studioHealth,
    studioOverview,
    studioReadiness,
    toggleDispatchBatchPage,
  } = useStudioDeliveryState({ project, selectedSegment });

  const appendAssistantMessage = useCallback(
    (content: string, error?: unknown) => {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId('assistant'),
          role: 'assistant',
          content,
          error: error instanceof Error ? error.message : typeof error === 'string' ? error : undefined,
          createdAt: nowIso(),
        },
      ]);
    },
    [setMessages],
  );

  const refreshDeliveryAudit = useCallback(
    async (options: { projectId?: string; sourceSegmentId?: string; interactive?: boolean } = {}) => {
      const interactive = options.interactive ?? true;
      if (interactive) setDeliveryAuditRefreshing(true);
      try {
        const audit = await fetchStudioDeliveryAudit({
          projectId: options.projectId ?? project?.projectId,
          sourceSegmentId: options.sourceSegmentId ?? studioContextSourceSegmentId,
        });
        applyDeliveryAudit(audit);
        return audit;
      } catch (error) {
        if (interactive) appendAssistantMessage('Delivery audit refresh failed.', error);
        return null;
      } finally {
        if (interactive) setDeliveryAuditRefreshing(false);
      }
    },
    [appendAssistantMessage, applyDeliveryAudit, project?.projectId, studioContextSourceSegmentId],
  );

  const downloadDeliveryAudit = useCallback(() => {
    if (!deliveryAudit) return;
    const filename = deliveryAuditFilename(deliveryAudit);
    downloadJsonPayload(deliveryAudit, filename);
    appendAssistantMessage(`Delivery audit downloaded ${filename}.`);
  }, [appendAssistantMessage, deliveryAudit]);

  const refreshHandoffSnapshot = useCallback(
    async (options: { projectId?: string; sourceSegmentId?: string; interactive?: boolean } = {}) => {
      const interactive = options.interactive ?? true;
      if (interactive) setHandoffRefreshing(true);
      try {
        const snapshot = await fetchStudioHandoffSnapshot({
          projectId: options.projectId ?? project?.projectId,
          sourceSegmentId: options.sourceSegmentId ?? studioContextSourceSegmentId,
        });
        applyHandoffSnapshot(snapshot);
        return snapshot;
      } catch (error) {
        if (interactive) appendAssistantMessage('Handoff snapshot refresh failed.', error);
        return null;
      } finally {
        if (interactive) setHandoffRefreshing(false);
      }
    },
    [appendAssistantMessage, applyHandoffSnapshot, project?.projectId, studioContextSourceSegmentId],
  );

  const refreshDeliveryBundle = useCallback(async () => {
    if (deliveryBundleLoading) return null;
    const projectId = project?.projectId || readLastStudioProjectId() || undefined;
    if (!projectId) {
      appendAssistantMessage('Delivery bundle needs a restored Studio project first.');
      return null;
    }
    setDeliveryBundleLoading(true);
    try {
      const bundle = await fetchStudioProjectDeliveryBundle({
        projectId,
        sourceSegmentId: studioContextSourceSegmentId,
      });
      setDeliveryBundle(bundle);
      applyHandoffSnapshot(bundle.reports.handoffSnapshot);
      setDeliveryReport(bundle.reports.deliveryReport);
      setCoverageReport(bundle.reports.coverage);
      const filename = deliveryBundleFilename(bundle);
      downloadJsonPayload(bundle, filename);
      appendAssistantMessage(
        `Delivery bundle ${bundle.status}: ${bundle.summary.acceptedJobs} accepted jobs, ${bundle.summary.completedTargets} completed targets, ${bundle.summary.artifacts} artifacts. Downloaded ${filename}.`,
      );
      return bundle;
    } catch (error) {
      appendAssistantMessage('Delivery bundle refresh failed.', error);
      return null;
    } finally {
      setDeliveryBundleLoading(false);
    }
  }, [
    appendAssistantMessage,
    applyHandoffSnapshot,
    deliveryBundleLoading,
    project?.projectId,
    studioContextSourceSegmentId,
  ]);

  const {
    cancelDispatchSession,
    completeDispatchSessionTarget,
    openDispatchBatchTarget,
    planDispatchBatch,
    retryDispatchSession,
    reviewDispatchSessionTarget,
    startDispatchSession,
  } = useStudioDispatchSessionController({
    appendAssistantMessage,
    applyDispatchSession,
    applyHandoffSnapshot,
    dispatchBatchPlan,
    dispatchBatchPlanning,
    dispatchSession,
    dispatchSessionRunning,
    navigate,
    project,
    refreshHandoffSnapshot,
    setDispatchBatchPlan,
    setDispatchBatchPlanning,
    setDispatchSessionRunning,
    studioContextSourceSegmentId,
  });

  const refreshDeliveryContext = useCallback(
    async (options: { projectId?: string; sourceSegmentId?: string } = {}) => {
      const projectId = options.projectId ?? project?.projectId;
      const sourceSegmentId = options.sourceSegmentId ?? selectedSegment?.id;
      const [overview, readiness, matrix, coverage, handoff, audit] = await Promise.all([
        fetchStudioOverview().catch(() => null),
        fetchStudioReadiness().catch(() => null),
        fetchStudioDispatchMatrix({ projectId, sourceSegmentId }).catch(() => null),
        fetchStudioCoverage({ projectId, sourceSegmentId }).catch(() => null),
        fetchStudioHandoffSnapshot({ projectId, sourceSegmentId }).catch(() => null),
        fetchStudioDeliveryAudit({ projectId, sourceSegmentId }).catch(() => null),
      ]);
      if (audit) {
        applyDeliveryAudit(audit);
        return;
      }
      if (handoff) {
        applyHandoffSnapshot(handoff);
        return;
      }
      if (overview) setStudioOverview(overview);
      if (readiness) setStudioReadiness(readiness);
      if (matrix) setDispatchMatrix(matrix);
      if (coverage) setCoverageReport(coverage);
    },
    [applyDeliveryAudit, applyHandoffSnapshot, project?.projectId, selectedSegment?.id],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchStudioHealth().catch(() => null),
      fetchStudioOverview().catch(() => null),
      fetchStudioReadiness().catch(() => null),
      fetchStudioDeliveryAudit().catch(() => null),
      fetchStudioDispatchMatrix().catch(() => null),
      fetchStudioCoverage().catch(() => null),
    ]).then(([nextHealth, nextOverview, nextReadiness, nextAudit, nextMatrix, nextCoverage]) => {
      if (cancelled) return;
      setStudioHealth(nextHealth);
      setStudioOverview(nextOverview);
      setStudioReadiness(nextReadiness);
      if (nextAudit) applyDeliveryAudit(nextAudit);
      setDispatchMatrix(nextMatrix);
      setCoverageReport(nextCoverage);
    });
    return () => {
      cancelled = true;
    };
  }, [applyDeliveryAudit]);

  useEffect(() => {
    let cancelled = false;
    const restoreParams = readDispatchSessionRestoreParams();
    const savedSession = readStudioDispatchSession();
    const projectId = project?.projectId || savedSession?.projectId || readLastStudioProjectId() || undefined;
    const restore = async () => {
      const restoreCandidates: Array<{ sessionId: string; targetId: string | undefined; announce: boolean }> = [];
      if (restoreParams.sessionId) {
        restoreCandidates.push({ sessionId: restoreParams.sessionId, targetId: restoreParams.targetId, announce: true });
      }
      if (savedSession?.sessionId) {
        restoreCandidates.push({ sessionId: savedSession.sessionId, targetId: savedSession.targetId, announce: false });
      }

      for (const candidate of restoreCandidates) {
        const session = await fetchStudioDispatchSession(candidate.sessionId, { targetId: candidate.targetId }).catch(() => null);
        if (!session) continue;
        if (!cancelled) {
          applyDispatchSession(session);
          if (candidate.announce) {
            const restoreKey = `${session.sessionId}:${session.focusedTargetId || candidate.targetId || ''}`;
            if (restoredDispatchUrlRef.current !== restoreKey) {
              restoredDispatchUrlRef.current = restoreKey;
              const focusedTarget = session.focusedTarget || session.targets.find((target) => target.id === session.focusedTargetId);
              appendAssistantMessage(
                focusedTarget
                  ? `Dispatch queue restored at ${focusedTarget.pageName} (${focusedTarget.status}).`
                  : `Dispatch queue restored for ${session.sessionId}.`,
              );
            }
          }
        }
        return;
      }
      if (!projectId) return;
      const [latestSession] = await fetchStudioDispatchSessions({ projectId, limit: 1 });
      if (!cancelled && latestSession) applyDispatchSession(latestSession);
    };
    void restore().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [appendAssistantMessage, applyDispatchSession, project?.projectId]);

  useEffect(() => {
    void refreshDeliveryContext().catch(() => undefined);
  }, [hubJobsVersion, project?.projectId, refreshDeliveryContext, selectedSegment?.id]);

  useEffect(() => {
    if (!project?.projectId) {
      setDeliveryReport(null);
      return;
    }
    let cancelled = false;
    void fetchStudioProjectDeliveryReport(project.projectId).then((report) => {
      if (!cancelled) setDeliveryReport(report);
    }).catch(() => {
      if (!cancelled) setDeliveryReport(null);
    });
    return () => {
      cancelled = true;
    };
  }, [hubJobsVersion, project?.projectId]);

  return {
    applyDeliveryAudit,
    applyDispatchSession,
    cancelDispatchSession,
    clearDispatchBatchPages,
    completeDispatchSessionTarget,
    copyMatrixEntryLink,
    coverageReport,
    coverageVerifyRunning,
    deliveryAudit,
    deliveryAuditRefreshing,
    deliveryBundle,
    deliveryBundleLoading,
    deliveryReport,
    dispatchBatchPlan,
    dispatchBatchPlanning,
    dispatchMatrix,
    dispatchSession,
    dispatchSessionRunning,
    downloadDeliveryAudit,
    handoffRefreshing,
    handoffSnapshot,
    openDispatchBatchTarget,
    planDispatchBatch,
    refreshDeliveryAudit,
    refreshDeliveryBundle,
    refreshDeliveryContext,
    refreshHandoffSnapshot,
    resetDeliveryState,
    retryDispatchSession,
    reviewDispatchSessionTarget,
    resolvingAuditActionId,
    resolvingAuditBatch,
    selectDispatchBatchPages,
    selectedDispatchBatchPageIds,
    setCoverageReport,
    setCoverageVerifyRunning,
    setDispatchBatchPlan,
    setDispatchSessionRunning,
    setResolvingAuditActionId,
    setResolvingAuditBatch,
    startDispatchSession,
    studioContextSourceSegmentId,
    studioHealth,
    studioOverview,
    studioReadiness,
    toggleDispatchBatchPage,
  };
}
