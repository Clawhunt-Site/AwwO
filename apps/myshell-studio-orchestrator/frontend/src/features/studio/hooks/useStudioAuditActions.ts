import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  fetchStudioDeliveryAudit,
  fetchStudioDispatchSession,
  resolveStudioAction,
  resolveStudioActionsBatch,
} from '../api';
import type {
  StudioDeliveryAudit,
  StudioDispatchSession,
  StudioExecutionRequest,
  StudioHandoffAction,
  StudioJob,
  StudioProject,
} from '../api';
import {
  isDispatchSessionRetryResult,
  isDispatchTargetRunResult,
} from '../components/delivery';
import type { ChatItem } from '../model/dreamyWorkspace';
import {
  formatStudioActionNext,
  makeId,
  nowIso,
} from '../model/dreamyWorkspace';

interface StudioAuditActionsOptions {
  applyDeliveryAudit: (audit: StudioDeliveryAudit) => void;
  applyDispatchSession: (session: StudioDispatchSession) => void;
  deliveryAudit: StudioDeliveryAudit | null;
  mergeJob: (job: StudioJob) => void;
  mergeProject: (project: StudioProject) => void;
  project: StudioProject | null;
  registerClientExecution: (
    request: StudioExecutionRequest,
    projectId: string,
    fileForRequest: File | null,
    assistantId: string,
  ) => Promise<void>;
  resolvingAuditActionId: string | null;
  resolvingAuditBatch: boolean;
  setMessages: Dispatch<SetStateAction<ChatItem[]>>;
  setResolvingAuditActionId: Dispatch<SetStateAction<string | null>>;
  setResolvingAuditBatch: Dispatch<SetStateAction<boolean>>;
  studioContextSourceSegmentId?: string | null;
  updateAssistant: (id: string, patch: Partial<ChatItem>) => void;
}

export function useStudioAuditActions({
  applyDeliveryAudit,
  applyDispatchSession,
  deliveryAudit,
  mergeJob,
  mergeProject,
  project,
  registerClientExecution,
  resolvingAuditActionId,
  resolvingAuditBatch,
  setMessages,
  setResolvingAuditActionId,
  setResolvingAuditBatch,
  studioContextSourceSegmentId,
  updateAssistant,
}: StudioAuditActionsOptions) {
  const resolveAuditAction = useCallback(async (action: StudioHandoffAction) => {
    if (resolvingAuditActionId) return;
    const targetId = action.targetId || action.pageId || action.segmentId || action.jobId || action.id;
    if (!targetId) return;
    setResolvingAuditActionId(action.id);
    try {
      const result = await resolveStudioAction({
        action: action.action,
        targetId,
        sessionId: action.sessionId,
        projectId: project?.projectId || deliveryAudit?.projectId || undefined,
        sourceSegmentId: studioContextSourceSegmentId || deliveryAudit?.sourceSegmentId || undefined,
      });

      if (isDispatchTargetRunResult(result.result)) {
        const targetRun = result.result;
        applyDispatchSession(targetRun.session);
        if (targetRun.project) mergeProject(targetRun.project);
        if (targetRun.job) mergeJob(targetRun.job);
        applyDeliveryAudit(result.audit);

        const assistantId = makeId('assistant');
        setMessages((prev) => [
          ...prev,
          {
            id: assistantId,
            role: 'assistant',
            content: `Running audit dispatch target ${targetRun.target.pageName || targetRun.target.pageId || targetRun.target.id}...`,
            pending: true,
            createdAt: nowIso(),
            steps: [{ step: 'dispatch-target', message: 'Audit action materialized queued target', progress: 35 }],
          },
        ]);

        const request = targetRun.executionRequest;
        if (request?.executor === 'client') {
          await registerClientExecution(
            request,
            targetRun.project?.projectId || targetRun.job?.projectId || targetRun.session.projectId || project?.projectId || '',
            null,
            assistantId,
          );
          const restored = await fetchStudioDispatchSession(targetRun.session.sessionId, { targetId: targetRun.target.id }).catch(() => null);
          if (restored) applyDispatchSession(restored);
        } else if (request?.executor === 'server') {
          updateAssistant(assistantId, {
            pending: false,
            content: `Audit dispatch target queued for ${targetRun.target.pageName || targetRun.target.pageId}.`,
            segmentId: request.segmentId,
          });
        } else {
          updateAssistant(assistantId, {
            pending: false,
            content: `Audit dispatch target ${targetRun.target.pageName || targetRun.target.pageId || targetRun.target.id} is ready for operator review.`,
          });
        }

        const refreshedAudit = await fetchStudioDeliveryAudit({
          projectId: targetRun.session.projectId || result.projectId || project?.projectId || undefined,
          sourceSegmentId: targetRun.session.sourceSegmentId || result.sourceSegmentId || studioContextSourceSegmentId || undefined,
        }).catch(() => null);
        if (refreshedAudit) applyDeliveryAudit(refreshedAudit);
        return;
      }

      if (isDispatchSessionRetryResult(result.result)) {
        const retrySession = result.result.session;
        applyDispatchSession(retrySession);
        applyDeliveryAudit(result.audit);
        setMessages((prev) => [
          ...prev,
          {
            id: makeId('assistant'),
            role: 'assistant',
            content: `Dispatch queue retried; ${retrySession.summary.pending} target${retrySession.summary.pending === 1 ? '' : 's'} pending.`,
            createdAt: nowIso(),
          },
        ]);
        return;
      }

      if (result.result && 'project' in result.result && result.result.project) mergeProject(result.result.project);
      if (result.result && 'jobs' in result.result) result.result.jobs?.forEach((job) => mergeJob(job));
      applyDeliveryAudit(result.audit);
      const nextMessage = formatStudioActionNext(result.next);
      const created = result.result && 'createdCount' in result.result ? result.result.createdCount ?? 0 : 0;
      setMessages((prev) => [
        ...prev,
        {
          id: makeId('assistant'),
          role: 'assistant',
          content:
            result.resultType === 'coverage-verify'
              ? `Audit action ${result.action} resolved for ${result.targetId}; verified ${created} target${created === 1 ? '' : 's'}.`
              : `Audit action ${result.action} needs operator follow-up.${nextMessage}`,
          createdAt: nowIso(),
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId('assistant'),
          role: 'assistant',
          content: `Audit action ${action.action} could not be resolved.`,
          error: error instanceof Error ? error.message : String(error),
          createdAt: nowIso(),
        },
      ]);
    } finally {
      setResolvingAuditActionId(null);
    }
  }, [
    applyDeliveryAudit,
    applyDispatchSession,
    deliveryAudit?.projectId,
    deliveryAudit?.sourceSegmentId,
    mergeJob,
    mergeProject,
    project?.projectId,
    registerClientExecution,
    resolvingAuditActionId,
    setMessages,
    setResolvingAuditActionId,
    studioContextSourceSegmentId,
    updateAssistant,
  ]);

  const resolveSafeAuditActions = useCallback(async () => {
    if (resolvingAuditBatch || resolvingAuditActionId || !deliveryAudit) return;
    const safeActions = deliveryAudit.actions
      .filter((action) => action.action === 'verify-ready' || action.action === 'run-target' || action.action === 'retry-queue')
      .map((action) => ({
        action: action.action,
        targetId: action.targetId || action.pageId || action.segmentId || action.jobId || action.id,
        sessionId: action.sessionId,
      }))
      .filter((action) => Boolean(action.targetId));
    if (!safeActions.length) return;
    setResolvingAuditBatch(true);
    try {
      const result = await resolveStudioActionsBatch({
        projectId: project?.projectId || deliveryAudit.projectId || undefined,
        sourceSegmentId: studioContextSourceSegmentId || deliveryAudit.sourceSegmentId || undefined,
        actions: safeActions,
      });
      if (result.result?.project) mergeProject(result.result.project);
      result.result?.jobs?.forEach((job) => mergeJob(job));
      applyDeliveryAudit(result.audit);
      let dispatchedTargets = 0;
      for (const executedAction of result.executedActions) {
        if (!isDispatchTargetRunResult(executedAction.result)) continue;
        const targetRun = executedAction.result;
        dispatchedTargets += 1;
        applyDispatchSession(targetRun.session);
        if (targetRun.project) mergeProject(targetRun.project);
        if (targetRun.job) mergeJob(targetRun.job);

        const assistantId = makeId('assistant');
        setMessages((prev) => [
          ...prev,
          {
            id: assistantId,
            role: 'assistant',
            content: `Running batch audit target ${targetRun.target.pageName || targetRun.target.pageId || targetRun.target.id}...`,
            pending: true,
            createdAt: nowIso(),
            steps: [{ step: 'dispatch-target', message: 'Batch audit action materialized queued target', progress: 35 }],
          },
        ]);

        const request = targetRun.executionRequest;
        if (request?.executor === 'client') {
          await registerClientExecution(
            request,
            targetRun.project?.projectId || targetRun.job?.projectId || targetRun.session.projectId || project?.projectId || '',
            null,
            assistantId,
          );
          const restored = await fetchStudioDispatchSession(targetRun.session.sessionId, { targetId: targetRun.target.id }).catch(() => null);
          if (restored) applyDispatchSession(restored);
        } else if (request?.executor === 'server') {
          updateAssistant(assistantId, {
            pending: false,
            content: `Batch audit target queued for ${targetRun.target.pageName || targetRun.target.pageId}.`,
            segmentId: request.segmentId,
          });
        } else {
          updateAssistant(assistantId, {
            pending: false,
            content: `Batch audit target ${targetRun.target.pageName || targetRun.target.pageId || targetRun.target.id} is ready for operator review.`,
          });
        }
      }
      for (const executedAction of result.executedActions) {
        if (!isDispatchSessionRetryResult(executedAction.result)) continue;
        applyDispatchSession(executedAction.result.session);
      }
      if (dispatchedTargets) {
        const refreshedAudit = await fetchStudioDeliveryAudit({
          projectId: project?.projectId || result.projectId || deliveryAudit.projectId || undefined,
          sourceSegmentId: studioContextSourceSegmentId || result.sourceSegmentId || deliveryAudit.sourceSegmentId || undefined,
        }).catch(() => null);
        if (refreshedAudit) applyDeliveryAudit(refreshedAudit);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: makeId('assistant'),
          role: 'assistant',
          content: `Resolved ${result.summary.executed} safe audit action${result.summary.executed === 1 ? '' : 's'}; ${dispatchedTargets} dispatch target${dispatchedTargets === 1 ? '' : 's'} ran.`,
          createdAt: nowIso(),
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId('assistant'),
          role: 'assistant',
          content: 'Safe audit actions could not be resolved.',
          error: error instanceof Error ? error.message : String(error),
          createdAt: nowIso(),
        },
      ]);
    } finally {
      setResolvingAuditBatch(false);
    }
  }, [
    applyDeliveryAudit,
    applyDispatchSession,
    deliveryAudit,
    mergeJob,
    mergeProject,
    project?.projectId,
    registerClientExecution,
    resolvingAuditActionId,
    resolvingAuditBatch,
    setMessages,
    setResolvingAuditBatch,
    studioContextSourceSegmentId,
    updateAssistant,
  ]);

  return {
    resolveAuditAction,
    resolveSafeAuditActions,
  };
}
