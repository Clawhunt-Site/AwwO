import { useCallback } from 'react';

import {
  fetchGenerateResult,
  hasTelegramInitData,
} from '../../../services/api';
import {
  extractGenerateTaskMedia,
  postStudioClientResult,
  submitDreamyMiniappJob,
} from '../api';
import type {
  StudioExecutionRequest,
  StudioProgressEvent,
  StudioProject,
  StudioSegment,
} from '../api';
import type { ChatItem } from '../model/dreamyWorkspace';
import {
  DEFAULT_DREAMY_SLUG,
  nowIso,
  withTimeout,
} from '../model/dreamyWorkspace';

interface StudioClientExecutionOptions {
  appendAssistantStep: (id: string, step: StudioProgressEvent) => void;
  mergeProject: (project: StudioProject) => void;
  refreshEnergy: () => void | Promise<void>;
  updateAssistant: (id: string, patch: Partial<ChatItem>) => void;
}

export function useStudioClientExecution({
  appendAssistantStep,
  mergeProject,
  refreshEnergy,
  updateAssistant,
}: StudioClientExecutionOptions) {
  return useCallback(
    async (request: StudioExecutionRequest, projectId: string, fileForRequest: File | null, assistantId: string) => {
      const sourceUrl = request.sourceSegment?.url || request.sourceSegment?.posterUrl;
      const expectedType: StudioSegment['type'] = request.botType === 'image-to-video' ? 'video' : 'image';
      await postStudioClientResult(projectId, {
        segmentId: request.segmentId,
        jobId: request.jobId,
        status: 'running',
        type: expectedType,
        prompt: request.prompt,
        botId: request.botId,
        articleId: request.articleId,
        botSlug: request.botSlug,
        botName: request.botName,
        action: request.action,
        parentSegmentId: request.sourceSegment?.id,
        posterUrl: request.segment.posterUrl,
        authStatus: request.authStatus,
        source: request.api,
        dispatchSessionId: request.dispatchSessionId,
        dispatchTargetId: request.dispatchTargetId,
      }).then((result) => mergeProject(result.project));
      appendAssistantStep(assistantId, {
        step: 'handoff',
        message: 'Queued locally; media result will attach when ready',
        progress: 38,
      });
      updateAssistant(assistantId, {
        pending: true,
        segmentId: request.segmentId,
        content: 'Segment accepted locally; Dreamy media is being prepared.',
      });

      if (!hasTelegramInitData()) {
        const authStatus = {
          status: 'auth_missing',
          mode: 'telegram-init-data',
          message: 'Open Dreamy inside Telegram or provide init data before running the miniapp.',
        };
        const update = await postStudioClientResult(projectId, {
          segmentId: request.segmentId,
          jobId: request.jobId,
          status: 'auth_missing',
          type: expectedType,
          prompt: request.prompt,
          botId: request.botId,
          articleId: request.articleId,
          botSlug: request.botSlug,
          botName: request.botName,
          action: request.action,
          parentSegmentId: request.sourceSegment?.id,
          posterUrl: request.segment.posterUrl,
          authStatus,
          evidence: {
            status: 'auth_missing',
            source: request.api,
            accepted: false,
            message: 'Dreamy Miniapp auth is missing; no external generation request was sent.',
            checkedAt: nowIso(),
          },
          source: request.api,
          dispatchSessionId: request.dispatchSessionId,
          dispatchTargetId: request.dispatchTargetId,
        });
        mergeProject(update.project);
        updateAssistant(assistantId, {
          pending: false,
          segmentId: request.segmentId,
          content: 'Dreamy Miniapp needs Telegram auth before it can run.',
          error: authStatus.message,
        });
        return;
      }

      try {
        appendAssistantStep(assistantId, {
          step: 'miniapp',
          message: `Submitting ${request.botName}`,
          progress: 52,
        });
        const job = await withTimeout(
          submitDreamyMiniappJob({
            slugId: request.botSlug || DEFAULT_DREAMY_SLUG,
            botId: request.botId,
            articleId: request.articleId,
            prompt: request.prompt,
            imageFile: fileForRequest,
            imageUrl: fileForRequest ? undefined : sourceUrl,
          }),
          10000,
          'Dreamy miniapp submit',
        );

        let media: { url?: string; posterUrl?: string; status?: string } = {};
        try {
          const result = await withTimeout(fetchGenerateResult(job.response.outputJobId), 5000, 'Dreamy result poll');
          media = extractGenerateTaskMedia(result);
        } catch {
          media = {};
        }

        const status = media.status === 'completed' || media.status === 'success' || media.status === 'done' ? 'done' : 'running';
        const update = await postStudioClientResult(projectId, {
          segmentId: request.segmentId,
          jobId: request.jobId,
          status,
          type: expectedType,
          url: media.url,
          posterUrl: media.posterUrl || request.segment.posterUrl,
          prompt: request.prompt,
          botId: request.botId,
          articleId: request.articleId,
          botSlug: request.botSlug,
          botName: request.botName,
          action: request.action,
          parentSegmentId: request.sourceSegment?.id,
          taskId: job.response.outputJobId,
          source: request.api,
          dispatchSessionId: request.dispatchSessionId,
          dispatchTargetId: request.dispatchTargetId,
        });
        mergeProject(update.project);
        updateAssistant(assistantId, {
          pending: false,
          segmentId: request.segmentId,
          content: status === 'done' ? 'Segment is ready.' : 'Segment is running in Dreamy.',
        });
        void refreshEnergy();
      } catch (error) {
        const update = await postStudioClientResult(projectId, {
          segmentId: request.segmentId,
          jobId: request.jobId,
          status: 'error',
          type: expectedType,
          posterUrl: request.segment.posterUrl,
          prompt: request.prompt,
          botId: request.botId,
          articleId: request.articleId,
          botSlug: request.botSlug,
          botName: request.botName,
          action: request.action,
          parentSegmentId: request.sourceSegment?.id,
          source: request.api,
          dispatchSessionId: request.dispatchSessionId,
          dispatchTargetId: request.dispatchTargetId,
        }).catch(() => null);
        if (update) mergeProject(update.project);
        updateAssistant(assistantId, {
          pending: false,
          segmentId: request.segmentId,
          content: 'Segment was queued, but client execution needs attention.',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [appendAssistantStep, mergeProject, refreshEnergy, updateAssistant],
  );
}
