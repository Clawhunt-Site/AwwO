import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { streamStudioRun } from '../api';
import type {
  StudioAction,
  StudioApi,
  StudioExecutionRequest,
  StudioJob,
  StudioMode,
  StudioPageAdapter,
  StudioProject,
  StudioProgressEvent,
  StudioRunEvent,
  StudioSegment,
} from '../api';
import {
  buildStudioDispatchNavigationPath,
  normalizeStudioNavigationPath,
  saveLastStudioProjectId,
  saveStudioDispatchSession,
} from '../session';
import { trackEvent } from '../../../services/tracking';
import type {
  ChatItem,
  ManualBotEntry,
  StudioDispatchRunOverride,
  StudioStarterPreset,
  TabKey,
} from '../model/dreamyWorkspace';
import {
  botTypeForStarterPreset,
  createLocalProject,
  EMPTY_GRAPH,
  makeId,
  nowIso,
} from '../model/dreamyWorkspace';

interface StudioRunControllerOptions {
  abortRef: MutableRefObject<AbortController | null>;
  appendAssistantStep: (id: string, step: StudioProgressEvent) => void;
  clearFile: () => void;
  mergeJob: (job: StudioJob) => void;
  mergeProject: (project: StudioProject) => void;
  mode: StudioMode;
  navigate: NavigateFunction;
  pages: StudioPageAdapter[];
  project: StudioProject | null;
  prompt: string;
  registerClientExecution: (
    request: StudioExecutionRequest,
    projectId: string,
    fileForRequest: File | null,
    assistantId: string,
  ) => Promise<void>;
  selectedAgentId: string;
  selectedFile: File | null;
  selectedManualBotEntry: ManualBotEntry | null;
  selectedPage: StudioPageAdapter | null;
  selectedPageId: StudioApi | string;
  selectedSegment: StudioSegment | null;
  selectedStarterPreset: StudioStarterPreset | null;
  setActiveTab: Dispatch<SetStateAction<TabKey>>;
  setMessages: Dispatch<SetStateAction<ChatItem[]>>;
  setProject: Dispatch<SetStateAction<StudioProject | null>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  submitting: boolean;
  updateAssistant: (id: string, patch: Partial<ChatItem>) => void;
}

export function useStudioRunController({
  abortRef,
  appendAssistantStep,
  clearFile,
  mergeJob,
  mergeProject,
  mode,
  navigate,
  pages,
  project,
  prompt,
  registerClientExecution,
  selectedAgentId,
  selectedFile,
  selectedManualBotEntry,
  selectedPage,
  selectedPageId,
  selectedSegment,
  selectedStarterPreset,
  setActiveTab,
  setMessages,
  setProject,
  setPrompt,
  setSubmitting,
  submitting,
  updateAssistant,
}: StudioRunControllerOptions) {
  const runStudio = useCallback(
    async (
      action: StudioAction = 'generate',
      overridePrompt?: string,
      source?: StudioSegment | null,
      dispatchOverride?: StudioDispatchRunOverride,
    ) => {
      if (submitting) return;
      const text = (overridePrompt || prompt).trim();
      const targetMode = dispatchOverride?.mode || mode;
      const targetPage = dispatchOverride?.pageId
        ? pages.find((page) => page.id === dispatchOverride.pageId) || selectedPage
        : selectedPage;
      const targetPageId = dispatchOverride?.pageId || selectedPageId;
      const targetAgentId = dispatchOverride?.agentId || selectedAgentId;
      const targetPageName = dispatchOverride?.pageName || targetPage?.name || String(targetPageId);
      const targetExecutor = dispatchOverride?.executor || targetPage?.executor;
      const targetBotId = dispatchOverride?.botId || (targetPageId === 'dreamy-miniapp' ? selectedManualBotEntry?.botId : undefined);
      const targetArticleId = dispatchOverride?.articleId || (targetPageId === 'dreamy-miniapp' ? selectedManualBotEntry?.articleId : undefined);
      const targetBotSequence = dispatchOverride?.botSequence;
      const targetBotSlug = dispatchOverride?.botSlug || (
        targetPageId === 'dreamy-miniapp' ? selectedManualBotEntry?.botSlug || selectedStarterPreset?.botSlug : undefined
      );
      const targetBotName = dispatchOverride?.botName || (
        targetPageId === 'dreamy-miniapp' ? selectedManualBotEntry?.botName || selectedStarterPreset?.title : undefined
      );
      const targetBotType = dispatchOverride?.botType || (
        targetPageId === 'dreamy-miniapp'
          ? selectedManualBotEntry?.botType || (selectedStarterPreset ? botTypeForStarterPreset(selectedStarterPreset) : undefined)
          : undefined
      );
      const isNavigationDispatch = targetExecutor === 'navigation';
      const isMatrixDispatch = Boolean(dispatchOverride);
      if (!text && action === 'generate' && !isNavigationDispatch && !isMatrixDispatch) return;

      const runPrompt = text || {
        extend: 'Extend this into the next shot',
        restyle: 'Restyle this segment',
        'retry-agent': 'Try another agent for this segment',
        generate: isNavigationDispatch ? `Open ${targetPageName}` : `Dispatch ${targetPageName}`,
      }[action];
      const fileForRequest = selectedFile;
      const userId = makeId('user');
      const assistantId = makeId('assistant');
      const sourceSegment = source || selectedSegment;

      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', content: runPrompt, action, createdAt: nowIso(), hasImage: Boolean(fileForRequest) },
        { id: assistantId, role: 'assistant', content: 'Routing next segment...', pending: true, createdAt: nowIso(), action },
      ]);
      setSubmitting(true);
      setActiveTab('preview');
      trackEvent('dreamy_studio_run', {
        action,
        mode: targetMode,
        page_id: targetPageId,
        agent_id: targetAgentId,
        bot_id: targetBotId || '',
        bot_slug: targetBotSlug || '',
        bot_type: targetBotType || '',
        bot_sequence_count: targetBotSequence?.length || 0,
        has_image: Boolean(fileForRequest),
        source_segment_id: sourceSegment?.id || '',
      });

      const controller = new AbortController();
      abortRef.current = controller;
      let currentProjectId = project?.projectId || '';

      try {
        await streamStudioRun({
          message: runPrompt,
          mode: targetMode,
          action,
          projectId: project?.projectId,
          sourceSegmentId: sourceSegment?.id,
          pageId: targetPageId,
          agentId: targetAgentId,
          botId: targetBotId,
          articleId: targetArticleId,
          botSlug: targetBotSlug,
          botName: targetBotName,
          botType: targetBotType,
          botSequence: targetBotSequence,
          agentGraph: project?.agentGraph,
          imageFile: fileForRequest,
          signal: controller.signal,
          onEvent: async (event: StudioRunEvent, rawEventName: string) => {
            if (rawEventName === 'meta' && 'projectId' in event && 'conversationId' in event && 'mode' in event) {
              const metaEvent = event as Extract<StudioRunEvent, { conversationId: string }>;
              currentProjectId = metaEvent.projectId;
              setProject((prev) =>
                prev || {
                  projectId: metaEvent.projectId,
                  conversationId: metaEvent.conversationId,
                  mode: metaEvent.mode,
                  messages: [],
                  segments: [],
                  selectedSegmentId: null,
                  agentGraph: EMPTY_GRAPH,
                  jobs: [],
                  updatedAt: nowIso(),
                },
              );
              return;
            }
            if (rawEventName === 'route' && 'bot' in event) {
              updateAssistant(assistantId, {
                route: event,
                content:
                  event.executor === 'navigation' && event.page?.name
                    ? `Matched ${event.page.name}.`
                    : `Matched ${event.bot.name}.`,
              });
              return;
            }
            if (rawEventName === 'progress' && 'step' in event) {
              appendAssistantStep(assistantId, event);
              return;
            }
            if (rawEventName === 'execution_request' && 'segmentId' in event && 'segment' in event) {
              const executionEvent = event as StudioExecutionRequest;
              setProject((prev) => {
                if (!prev) return prev;
                const exists = prev.segments.some((segment) => segment.id === executionEvent.segment.id);
                return {
                  ...prev,
                  agentGraph: executionEvent.agentGraph || prev.agentGraph,
                  selectedSegmentId: executionEvent.segmentId,
                  segments: exists ? prev.segments : [...prev.segments, executionEvent.segment],
                };
              });
              updateAssistant(assistantId, {
                segmentId: executionEvent.segmentId,
                content: `Queued ${executionEvent.botName}.`,
              });
              if (executionEvent.executor === 'client') {
                await registerClientExecution(executionEvent, currentProjectId, fileForRequest, assistantId);
              } else if (executionEvent.executor === 'navigation') {
                const targetPath = normalizeStudioNavigationPath(executionEvent.navigationPath);
                const missingRouteParams = executionEvent.missingRouteParams || [];
                if (missingRouteParams.length) {
                  updateAssistant(assistantId, {
                    pending: false,
                    segmentId: executionEvent.segmentId,
                    content: `Missing ${missingRouteParams.join(', ')} for ${executionEvent.page?.name || executionEvent.api}.`,
                    error: executionEvent.evidence?.message || `Missing route parameters: ${missingRouteParams.join(', ')}`,
                  });
                  return;
                }
                updateAssistant(assistantId, {
                  pending: false,
                  segmentId: executionEvent.segmentId,
                  content: targetPath
                    ? `Opening ${executionEvent.page?.name || executionEvent.api}.`
                    : `Dispatch target ready: ${executionEvent.page?.name || executionEvent.api}.`,
                });
                if (targetPath) {
                  saveLastStudioProjectId(currentProjectId);
                  saveStudioDispatchSession({
                    projectId: currentProjectId,
                    pageId: executionEvent.page?.id || executionEvent.api,
                    pageName: executionEvent.page?.name || executionEvent.api,
                    navigationPath: targetPath,
                    studioReturnPath: executionEvent.studioReturnPath || '/dreamy',
                  });
                  navigate(buildStudioDispatchNavigationPath(targetPath, {
                    projectId: currentProjectId,
                    pageId: executionEvent.page?.id || executionEvent.api,
                    studioReturnPath: executionEvent.studioReturnPath || '/dreamy',
                  }));
                }
              } else {
                updateAssistant(assistantId, {
                  pending: false,
                  segmentId: executionEvent.segmentId,
                  content:
                    executionEvent.authStatus?.status === 'auth_missing'
                      ? 'MyShell Art needs browser cookies before it can run.'
                      : `Server adapter queued ${executionEvent.botName}.`,
                  error: executionEvent.authStatus?.status === 'auth_missing' ? executionEvent.authStatus.message : undefined,
                });
              }
              return;
            }
            if (rawEventName === 'job' && 'job' in event) {
              mergeJob(event.job);
              return;
            }
            if (rawEventName === 'project' && 'project' in event) {
              mergeProject(event.project);
              return;
            }
            if (rawEventName === 'error' && 'message' in event) {
              updateAssistant(assistantId, { pending: false, error: event.message });
            }
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          updateAssistant(assistantId, { pending: false, content: 'Stopped.' });
        } else {
          const fallback = createLocalProject(targetMode, runPrompt, action, sourceSegment || undefined, project);
          mergeProject(fallback);
          updateAssistant(assistantId, {
            pending: false,
            segmentId: fallback.selectedSegmentId || undefined,
            content: 'Local draft segment added.',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        abortRef.current = null;
        setSubmitting(false);
        setPrompt('');
        clearFile();
      }
    },
    [
      abortRef,
      appendAssistantStep,
      clearFile,
      mergeJob,
      mergeProject,
      mode,
      navigate,
      pages,
      project,
      prompt,
      registerClientExecution,
      selectedAgentId,
      selectedFile,
      selectedManualBotEntry,
      selectedPage,
      selectedPageId,
      selectedSegment,
      selectedStarterPreset,
      setActiveTab,
      setMessages,
      setProject,
      setPrompt,
      setSubmitting,
      submitting,
      updateAssistant,
    ],
  );

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSubmitting(false);
  }, [abortRef, setSubmitting]);

  return {
    runStudio,
    stopRun,
  };
}
