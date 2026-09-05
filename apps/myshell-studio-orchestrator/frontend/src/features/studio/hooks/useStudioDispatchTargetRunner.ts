import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  fetchStudioDispatchSession,
  runStudioDispatchSessionTarget,
} from '../api';
import type {
  StudioAction,
  StudioDispatchBatchPlan,
  StudioDispatchBatchTarget,
  StudioDispatchSession,
  StudioDispatchSessionTarget,
  StudioExecutionRequest,
  StudioExecutor,
  StudioHandoffSnapshot,
  StudioJob,
  StudioProject,
  StudioSegment,
} from '../api';
import type {
  ChatItem,
  StudioDispatchRunOverride,
} from '../model/dreamyWorkspace';
import {
  makeId,
  nowIso,
} from '../model/dreamyWorkspace';

interface StudioDispatchTargetRunnerOptions {
  applyDispatchSession: (session: StudioDispatchSession) => void;
  changePage: (nextPageId: string) => void;
  dispatchSession: StudioDispatchSession | null;
  dispatchSessionRunning: boolean;
  mergeJob: (job: StudioJob) => void;
  mergeProject: (project: StudioProject) => void;
  openDispatchBatchTarget: (target: StudioDispatchBatchTarget | StudioDispatchSessionTarget) => Promise<void>;
  project: StudioProject | null;
  refreshHandoffSnapshot: (options?: {
    projectId?: string;
    sourceSegmentId?: string;
    interactive?: boolean;
  }) => Promise<StudioHandoffSnapshot | null>;
  registerClientExecution: (
    request: StudioExecutionRequest,
    projectId: string,
    fileForRequest: File | null,
    assistantId: string,
  ) => Promise<void>;
  runStudio: (
    action?: StudioAction,
    overridePrompt?: string,
    source?: StudioSegment | null,
    dispatchOverride?: StudioDispatchRunOverride,
  ) => Promise<void> | void;
  selectedSegment: StudioSegment | null;
  setDispatchBatchPlan: Dispatch<SetStateAction<StudioDispatchBatchPlan | null>>;
  setDispatchSessionRunning: Dispatch<SetStateAction<boolean>>;
  setMessages: Dispatch<SetStateAction<ChatItem[]>>;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  studioContextSourceSegmentId?: string | null;
  updateAssistant: (id: string, patch: Partial<ChatItem>) => void;
}

export function useStudioDispatchTargetRunner({
  applyDispatchSession,
  changePage,
  dispatchSession,
  dispatchSessionRunning,
  mergeJob,
  mergeProject,
  openDispatchBatchTarget,
  project,
  refreshHandoffSnapshot,
  registerClientExecution,
  runStudio,
  selectedSegment,
  setDispatchBatchPlan,
  setDispatchSessionRunning,
  setMessages,
  setSelectedAgentId,
  studioContextSourceSegmentId,
  updateAssistant,
}: StudioDispatchTargetRunnerOptions) {
  return useCallback(
    async (target: StudioDispatchBatchTarget | StudioDispatchSessionTarget) => {
      if (target.executor === 'navigation') {
        await openDispatchBatchTarget(target);
        return;
      }

      if (!('status' in target) || !dispatchSession?.sessionId) {
        changePage(String(target.pageId));
        if (target.agentId) setSelectedAgentId(target.agentId);
        void runStudio('generate', undefined, selectedSegment, {
          pageId: String(target.pageId),
          agentId: target.agentId || undefined,
          pageName: target.pageName,
          executor: target.executor as StudioExecutor,
        });
        return;
      }

      if (dispatchSessionRunning) return;
      const assistantId = makeId('assistant');
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: `Running queued ${target.pageName} target...`,
          pending: true,
          createdAt: nowIso(),
          steps: [{ step: 'dispatch-target', message: 'Materializing queued target', progress: 20 }],
        },
      ]);
      setDispatchSessionRunning(true);
      try {
        const result = await runStudioDispatchSessionTarget({
          sessionId: dispatchSession.sessionId,
          targetId: target.id,
        });
        applyDispatchSession(result.session);
        if (result.project) mergeProject(result.project);
        if (result.job) mergeJob(result.job);

        const request = result.executionRequest;
        if (request?.executor === 'client') {
          await registerClientExecution(
            request,
            result.project?.projectId || result.job?.projectId || dispatchSession.projectId || project?.projectId || '',
            null,
            assistantId,
          );
          const restored = await fetchStudioDispatchSession(dispatchSession.sessionId, { targetId: target.id }).catch(() => null);
          if (restored) applyDispatchSession(restored);
        } else if (request?.executor === 'server') {
          updateAssistant(assistantId, {
            pending: false,
            content: `Server dispatch target queued for ${target.pageName}.`,
            segmentId: request.segmentId,
          });
        } else {
          updateAssistant(assistantId, {
            pending: false,
            content: `${target.pageName} target is ready for operator review.`,
          });
        }

        const snapshot = await refreshHandoffSnapshot({
          projectId: result.session.projectId || project?.projectId,
          sourceSegmentId: result.session.sourceSegmentId || studioContextSourceSegmentId || undefined,
          interactive: false,
        });
        if (snapshot) {
          setDispatchBatchPlan((current) => (current ? { ...current, handoffSnapshot: snapshot } : current));
        }
      } catch (error) {
        updateAssistant(assistantId, {
          pending: false,
          content: 'Queued dispatch target could not run.',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setDispatchSessionRunning(false);
      }
    },
    [
      applyDispatchSession,
      changePage,
      dispatchSession,
      dispatchSessionRunning,
      mergeJob,
      mergeProject,
      openDispatchBatchTarget,
      project?.projectId,
      refreshHandoffSnapshot,
      registerClientExecution,
      runStudio,
      selectedSegment,
      setDispatchBatchPlan,
      setDispatchSessionRunning,
      setMessages,
      setSelectedAgentId,
      studioContextSourceSegmentId,
      updateAssistant,
    ],
  );
}
