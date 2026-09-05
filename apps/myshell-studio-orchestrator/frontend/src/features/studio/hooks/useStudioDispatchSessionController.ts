import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import {
  cancelStudioDispatchSession,
  createStudioDispatchSession,
  planStudioDispatchBatch,
  retryStudioDispatchSession,
  updateStudioDispatchSessionTarget,
} from '../api';
import type {
  StudioDispatchBatchPlan,
  StudioDispatchBatchTarget,
  StudioDispatchSession,
  StudioDispatchSessionTarget,
  StudioHandoffSnapshot,
  StudioProject,
} from '../api';
import {
  buildStudioDispatchNavigationPath,
  forgetLastStudioProjectId,
  normalizeStudioNavigationPath,
  readLastStudioProjectId,
  saveLastStudioProjectId,
  saveStudioDispatchSession,
} from '../session';
import { isMissingStudioProjectError } from '../model/dreamyWorkspace';

interface StudioDispatchSessionControllerOptions {
  appendAssistantMessage: (content: string, error?: unknown) => void;
  applyDispatchSession: (session: StudioDispatchSession) => void;
  applyHandoffSnapshot: (snapshot: StudioHandoffSnapshot) => void;
  dispatchBatchPlan: StudioDispatchBatchPlan | null;
  dispatchBatchPlanning: boolean;
  dispatchSession: StudioDispatchSession | null;
  dispatchSessionRunning: boolean;
  navigate: NavigateFunction;
  project: StudioProject | null;
  refreshHandoffSnapshot: (options?: {
    projectId?: string;
    sourceSegmentId?: string;
    interactive?: boolean;
  }) => Promise<StudioHandoffSnapshot | null>;
  setDispatchBatchPlan: Dispatch<SetStateAction<StudioDispatchBatchPlan | null>>;
  setDispatchBatchPlanning: Dispatch<SetStateAction<boolean>>;
  setDispatchSessionRunning: Dispatch<SetStateAction<boolean>>;
  studioContextSourceSegmentId?: string | null;
}

export function useStudioDispatchSessionController({
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
}: StudioDispatchSessionControllerOptions) {
  const planDispatchBatch = useCallback(
    async (options: { excludeCovered?: boolean; pageIds?: string[] } = {}) => {
      if (dispatchBatchPlanning) return;
      const pageIds = options.pageIds?.length ? options.pageIds : undefined;
      setDispatchBatchPlanning(true);
      try {
        const projectId = project?.projectId || readLastStudioProjectId() || undefined;
        let plan: StudioDispatchBatchPlan;
        try {
          plan = await planStudioDispatchBatch({
            projectId,
            sourceSegmentId: studioContextSourceSegmentId || undefined,
            pageIds,
            limit: 50,
            excludeCovered: options.excludeCovered,
          });
        } catch (error) {
          if (!projectId || !isMissingStudioProjectError(error)) throw error;
          forgetLastStudioProjectId();
          plan = await planStudioDispatchBatch({
            sourceSegmentId: studioContextSourceSegmentId || undefined,
            pageIds,
            limit: 50,
            excludeCovered: options.excludeCovered,
          });
        }
        setDispatchBatchPlan(plan);
        applyHandoffSnapshot(plan.handoffSnapshot);
        appendAssistantMessage(
          `${pageIds ? 'Selected batch' : options.excludeCovered ? 'Remaining batch' : 'Batch dispatch'} planned ${plan.summary.planned} target${plan.summary.planned === 1 ? '' : 's'}; skipped ${plan.summary.skipped}.`,
        );
      } catch (error) {
        appendAssistantMessage('Batch dispatch planning failed.', error);
      } finally {
        setDispatchBatchPlanning(false);
      }
    },
    [
      appendAssistantMessage,
      applyHandoffSnapshot,
      dispatchBatchPlanning,
      project?.projectId,
      setDispatchBatchPlan,
      setDispatchBatchPlanning,
      studioContextSourceSegmentId,
    ],
  );

  const startDispatchSession = useCallback(
    async (options: { pageIds?: string[] } = {}) => {
      if (dispatchSessionRunning) return;
      const pageIds = options.pageIds?.length ? options.pageIds : undefined;
      setDispatchSessionRunning(true);
      try {
        const projectId = project?.projectId || readLastStudioProjectId() || undefined;
        let session: StudioDispatchSession;
        try {
          session = await createStudioDispatchSession({
            projectId,
            sourceSegmentId: studioContextSourceSegmentId || undefined,
            pageIds,
            limit: 50,
            excludeCovered: Boolean(dispatchBatchPlan?.excludeCovered),
          });
        } catch (error) {
          if (!projectId || !isMissingStudioProjectError(error)) throw error;
          forgetLastStudioProjectId();
          session = await createStudioDispatchSession({
            sourceSegmentId: studioContextSourceSegmentId || undefined,
            pageIds,
            limit: 50,
            excludeCovered: Boolean(dispatchBatchPlan?.excludeCovered),
          });
        }
        applyDispatchSession(session);
        appendAssistantMessage(
          `${pageIds ? 'Selected dispatch queue' : 'Dispatch queue'} started with ${session.summary.pending} pending target${session.summary.pending === 1 ? '' : 's'}.`,
        );
      } catch (error) {
        appendAssistantMessage('Dispatch queue start failed.', error);
      } finally {
        setDispatchSessionRunning(false);
      }
    },
    [
      appendAssistantMessage,
      applyDispatchSession,
      dispatchBatchPlan?.excludeCovered,
      dispatchSessionRunning,
      project?.projectId,
      setDispatchSessionRunning,
      studioContextSourceSegmentId,
    ],
  );

  const cancelDispatchSession = useCallback(async () => {
    if (!dispatchSession?.sessionId || dispatchSessionRunning) return;
    setDispatchSessionRunning(true);
    try {
      const session = await cancelStudioDispatchSession(dispatchSession.sessionId);
      applyDispatchSession(session);
      const snapshot = await refreshHandoffSnapshot({
        projectId: session.projectId || project?.projectId,
        sourceSegmentId: session.sourceSegmentId || studioContextSourceSegmentId || undefined,
        interactive: false,
      });
      if (snapshot) {
        setDispatchBatchPlan((current) => (current ? { ...current, handoffSnapshot: snapshot } : current));
      }
      appendAssistantMessage(
        `Dispatch queue cancelled; ${session.summary.targetCancelled || 0} target${session.summary.targetCancelled === 1 ? '' : 's'} stopped.`,
      );
    } catch (error) {
      appendAssistantMessage('Dispatch queue cancel failed.', error);
    } finally {
      setDispatchSessionRunning(false);
    }
  }, [
    appendAssistantMessage,
    applyDispatchSession,
    dispatchSession?.sessionId,
    dispatchSessionRunning,
    project?.projectId,
    refreshHandoffSnapshot,
    setDispatchBatchPlan,
    setDispatchSessionRunning,
    studioContextSourceSegmentId,
  ]);

  const retryDispatchSession = useCallback(async () => {
    if (!dispatchSession?.sessionId || dispatchSessionRunning) return;
    setDispatchSessionRunning(true);
    try {
      const session = await retryStudioDispatchSession(dispatchSession.sessionId);
      applyDispatchSession(session);
      const snapshot = await refreshHandoffSnapshot({
        projectId: session.projectId || project?.projectId,
        sourceSegmentId: session.sourceSegmentId || studioContextSourceSegmentId || undefined,
        interactive: false,
      });
      if (snapshot) {
        setDispatchBatchPlan((current) => (current ? { ...current, handoffSnapshot: snapshot } : current));
      }
      appendAssistantMessage(
        `Dispatch queue retry opened ${session.summary.pending} pending target${session.summary.pending === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      appendAssistantMessage('Dispatch queue retry failed.', error);
    } finally {
      setDispatchSessionRunning(false);
    }
  }, [
    appendAssistantMessage,
    applyDispatchSession,
    dispatchSession?.sessionId,
    dispatchSessionRunning,
    project?.projectId,
    refreshHandoffSnapshot,
    setDispatchBatchPlan,
    setDispatchSessionRunning,
    studioContextSourceSegmentId,
  ]);

  const completeDispatchSessionTarget = useCallback(
    async (target: StudioDispatchSessionTarget) => {
      if (!dispatchSession?.sessionId || dispatchSessionRunning) return;
      setDispatchSessionRunning(true);
      try {
        const session = await updateStudioDispatchSessionTarget({
          sessionId: dispatchSession.sessionId,
          targetId: target.id,
          status: 'completed',
          evidence: {
            accepted: true,
            completedFrom: 'studio',
            pageId: target.pageId,
            navigationPath: target.navigationPath || '',
          },
        });
        applyDispatchSession(session);
        const snapshot = await refreshHandoffSnapshot({
          projectId: session.projectId || project?.projectId,
          sourceSegmentId: session.sourceSegmentId || studioContextSourceSegmentId || undefined,
          interactive: false,
        });
        if (snapshot) {
          setDispatchBatchPlan((current) => (current ? { ...current, handoffSnapshot: snapshot } : current));
        }
        appendAssistantMessage(
          `${target.pageName} marked done; ${session.summary.pending} target${session.summary.pending === 1 ? '' : 's'} pending.`,
        );
      } catch (error) {
        appendAssistantMessage('Dispatch queue update failed.', error);
      } finally {
        setDispatchSessionRunning(false);
      }
    },
    [
      appendAssistantMessage,
      applyDispatchSession,
      dispatchSession?.sessionId,
      dispatchSessionRunning,
      project?.projectId,
      refreshHandoffSnapshot,
      setDispatchBatchPlan,
      setDispatchSessionRunning,
      studioContextSourceSegmentId,
    ],
  );

  const reviewDispatchSessionTarget = useCallback(
    async (target: StudioDispatchSessionTarget, status: 'skipped' | 'error') => {
      if (!dispatchSession?.sessionId || dispatchSessionRunning) return;
      setDispatchSessionRunning(true);
      try {
        const isError = status === 'error';
        const session = await updateStudioDispatchSessionTarget({
          sessionId: dispatchSession.sessionId,
          targetId: target.id,
          status,
          evidence: isError
            ? {
                message: 'Operator marked this dispatch target as broken from Studio.',
                pageId: target.pageId,
                navigationPath: target.navigationPath || '',
              }
            : {
                reason: 'operator skipped from Studio dispatch queue',
                pageId: target.pageId,
                navigationPath: target.navigationPath || '',
              },
        });
        applyDispatchSession(session);
        const snapshot = await refreshHandoffSnapshot({
          projectId: session.projectId || project?.projectId,
          sourceSegmentId: session.sourceSegmentId || studioContextSourceSegmentId || undefined,
          interactive: false,
        });
        if (snapshot) {
          setDispatchBatchPlan((current) => (current ? { ...current, handoffSnapshot: snapshot } : current));
        }
        appendAssistantMessage(
          `${target.pageName} marked ${isError ? 'error' : 'skipped'}; ${session.summary.pending} target${session.summary.pending === 1 ? '' : 's'} pending.`,
        );
      } catch (error) {
        appendAssistantMessage('Dispatch queue review update failed.', error);
      } finally {
        setDispatchSessionRunning(false);
      }
    },
    [
      appendAssistantMessage,
      applyDispatchSession,
      dispatchSession?.sessionId,
      dispatchSessionRunning,
      project?.projectId,
      refreshHandoffSnapshot,
      setDispatchBatchPlan,
      setDispatchSessionRunning,
      studioContextSourceSegmentId,
    ],
  );

  const openDispatchBatchTarget = useCallback(
    async (target: StudioDispatchBatchTarget | StudioDispatchSessionTarget) => {
      const targetPath = normalizeStudioNavigationPath(target.navigationPath);
      if (!targetPath) return;
      const projectId = target.projectId || dispatchSession?.projectId || project?.projectId || '';
      if (projectId) saveLastStudioProjectId(projectId);
      if (dispatchSession?.sessionId && 'status' in target) {
        setDispatchSessionRunning(true);
        try {
          const session = await updateStudioDispatchSessionTarget({
            sessionId: dispatchSession.sessionId,
            targetId: target.id,
            status: 'visited',
            evidence: {
              openedFrom: 'studio',
              pageId: target.pageId,
              navigationPath: targetPath,
            },
          });
          applyDispatchSession(session);
        } catch (error) {
          appendAssistantMessage('Dispatch queue visit could not be saved.', error);
          setDispatchSessionRunning(false);
          return;
        }
        setDispatchSessionRunning(false);
      }
      saveStudioDispatchSession({
        projectId,
        sessionId: dispatchSession?.sessionId,
        targetId: target.id,
        pageId: String(target.pageId),
        pageName: target.pageName,
        navigationPath: targetPath,
        studioReturnPath: target.studioReturnPath || '/dreamy',
      });
      navigate(
        buildStudioDispatchNavigationPath(targetPath, {
          projectId,
          sessionId: dispatchSession?.sessionId,
          targetId: target.id,
          pageId: String(target.pageId),
          studioReturnPath: target.studioReturnPath || '/dreamy',
        }),
      );
    },
    [
      appendAssistantMessage,
      applyDispatchSession,
      dispatchSession?.projectId,
      dispatchSession?.sessionId,
      navigate,
      project?.projectId,
      setDispatchSessionRunning,
    ],
  );

  return {
    cancelDispatchSession,
    completeDispatchSessionTarget,
    openDispatchBatchTarget,
    planDispatchBatch,
    retryDispatchSession,
    reviewDispatchSessionTarget,
    startDispatchSession,
  };
}
