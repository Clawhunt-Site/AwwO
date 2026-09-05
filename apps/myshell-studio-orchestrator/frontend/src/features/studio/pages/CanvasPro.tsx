import {
  Download,
  Image as ImageIcon,
  Link2,
  ListVideo,
  Paintbrush,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CANVASPRO_ENTRY,
  CANVASPRO_BRIDGE_SRC,
  BRIDGE_REQUEST,
  BRIDGE_RESPONSE,
  BRIDGE_READY,
  BRIDGE_AUTOSAVE,
  BRIDGE_AGENT_PANEL,
  GENERATION_AUTO_SYNC_INTERVAL_MS,
  GENERATION_AUTO_SYNC_MIN_INTERVAL_MS,
  GENERATION_ASPECT_RATIO_OPTIONS,
  GENERATION_QUALITY_OPTIONS,
  createRequestId,
  formatSavedAt,
  formatGenerationTaskKind,
  formatGenerationTaskStatus,
  formatGenerationTaskAtom,
  formatGenerationTaskAtomHint,
  isCliAuthReady,
  formatCliAuthLabel,
  formatCliAuthDetail,
  formatCliDefaultLabel,
  formatGenerationOutputStatus,
  formatGenerationSourceInputStatus,
  getGenerationModeOptions,
  getGenerationModelOptions,
  getGenerationResolutionOptions,
  getGenerationTaskProgress,
  getGenerationTaskKey,
  hasUnmaterializedGenerationOutput,
  isAutoSyncGenerationTask,
  getGenerationTaskCompletedOutputCount,
  getGenerationTaskOutputCount,
  parseQuickCreateCommand,
  buildAddMenuDraftContent,
} from '../model/canvasProWorkspace';
import type {
  QuickCreateKind,
  GenerationOutputContinuationAction,
  GenerationTaskRerunAction,
  AddMenuItem,
  CreateNodeOptions,
  CreateFlowOptions,
  BridgeStats,
  GenerationTaskOutput,
  CanvasProCliAuthStatus,
  CliLoginMethod,
  GenerationTask,
  GenerationAutoSyncState,
  GenerationTasksResult,
  FocusGenerationTaskResult,
  UpdateGenerationTaskResult,
  SubmitGenerationTaskResult,
  SyncGenerationTaskResult,
  MaterializeGenerationOutputResult,
  ContinueGenerationOutputResult,
  RerunGenerationTaskResult,
  RestoreGenerationTaskNodeResult,
  RemoveGenerationTaskResult,
  CreateNodeResult,
  ImportMediaFilesResult,
  CreateFlowResult,
  CreateStoryboardResult,
  CreateVariantsResult,
  OrganizeCanvasResult,
  BridgeStatus,
  AutosavePayload,
  BridgeResponseMessage,
  PendingBridgeRequest,
  CanvasProProps,
} from '../model/canvasProWorkspace';
import { CanvasProQuickCreate } from '../components/canvasProQuickCreate';
import { CanvasProToolbar } from '../components/canvasProToolbar';
import type { SuperClawCanvasRunRequest, SuperClawRunEvent } from '../api';
import { useCanvasProGenerationDrafts } from '../hooks/useCanvasProGenerationDrafts';
import { useCanvasProQuickCommands } from '../hooks/useCanvasProQuickCommands';
import { useSuperClawCanvasController } from '../hooks/useSuperClawCanvasController';

const CANVASPRO_NOTICE_AUTO_DISMISS_MS = 4200;

type CanvasProSuperClawContext = {
  activeCanvasId?: string;
  activeCanvasName?: string;
  connections?: SuperClawCanvasRunRequest['connections'];
  nodes?: SuperClawCanvasRunRequest['nodes'];
  project?: {
    id?: string;
    name?: string;
  };
  projectId?: string;
  selectedNode?: SuperClawCanvasRunRequest['nodes'][number] | null;
  selectedNodeId?: string;
  selectedNodeIds?: string[];
  stats?: BridgeStats;
  viewport?: SuperClawCanvasRunRequest['viewport'];
};

function formatSuperClawEvent(event?: SuperClawRunEvent): string {
  if (!event) return '';
  const message = event.message || event.detail || event.type || event.event || event.status || '';
  return String(message || '').trim();
}

export default function CanvasPro({ embeddedInStudio = false, onBackToStudio }: CanvasProProps) {
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mediaFileInputRef = useRef<HTMLInputElement | null>(null);
  const packageFileInputRef = useRef<HTMLInputElement | null>(null);
  const quickPromptInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRequests = useRef<Map<string, PendingBridgeRequest>>(new Map());
  const autoSyncInFlight = useRef<Set<string>>(new Set());
  const autoSyncLastRun = useRef<Map<string, number>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ ready: false });
  const [generationTasks, setGenerationTasks] = useState<GenerationTask[]>([]);
  const [generationAutoSync, setGenerationAutoSync] = useState<GenerationAutoSyncState>({ active: false });
  const [lastAutosave, setLastAutosave] = useState<AutosavePayload | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [cliAuthStatus, setCliAuthStatus] = useState<CanvasProCliAuthStatus | null>(null);
  const [cliAuthLoading, setCliAuthLoading] = useState(false);
  const [cliLoginOpen, setCliLoginOpen] = useState(false);
  const [cliLoginMethod, setCliLoginMethod] = useState<CliLoginMethod>('token');
  const [cliLoginSecret, setCliLoginSecret] = useState('');
  const [cliLoginMessage, setCliLoginMessage] = useState('');
  const [detailsPanelOpen, setDetailsPanelOpen] = useState(false);
  const {
    addMenuOpen,
    insertQuickCommand,
    quickCommandIndex,
    quickCommandOpen,
    quickPrompt,
    setAddMenuOpen,
    setQuickCommandIndex,
    setQuickCommandOpen,
    setQuickPrompt,
    visibleQuickCommands,
  } = useCanvasProQuickCommands({ quickPromptInputRef });
  const {
    selectedGenerationTask,
    selectedGenerationTaskAtomCommand,
    selectedGenerationTaskId,
    selectedGenerationTaskKey,
    setSelectedGenerationTaskId,
    setTaskAspectRatioDraft,
    setTaskDurationDraft,
    setTaskModeDraft,
    setTaskModelDraft,
    setTaskOutputCountDraft,
    setTaskPromptDraft,
    setTaskQualityDraft,
    setTaskResolutionDraft,
    taskAspectRatioDraft,
    taskCostEstimate,
    taskDurationDraft,
    taskModeDraft,
    taskModelDraft,
    taskOutputCountDraft,
    taskParamSummary,
    taskPromptDraft,
    taskQualityDraft,
    taskResolutionDraft,
  } = useCanvasProGenerationDrafts(generationTasks, reloadKey);
  const {
    activeRunEvents: superClawRunEvents,
    activeRunId: superClawRunId,
    activeRunInFlight: superClawRunInFlight,
    activeRunStatus: superClawRunStatus,
    busy: superClawBusy,
    cancelActiveRun: cancelSuperClawRun,
    error: superClawError,
    refreshStatus: refreshSuperClawStatus,
    resumeActiveRun: resumeSuperClawRun,
    runCanvas: runSuperClawCanvas,
    statusLabel: superClawStatusLabel,
    statusLoading: superClawStatusLoading,
  } = useSuperClawCanvasController();
  const src = useMemo(
    () => `${CANVASPRO_ENTRY}?embedded=studio&reload=${reloadKey}`,
    [reloadKey],
  );

  useEffect(() => {
    setBridgeStatus({ ready: false });
    setGenerationTasks([]);
    setLastAutosave(null);
    setAgentPanelOpen(false);
  }, [reloadKey]);

  useEffect(() => {
    return () => {
      pendingRequests.current.forEach((request) => {
        window.clearTimeout(request.timeout);
        request.reject(new Error('CanvasPro page was closed'));
      });
      pendingRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current === notice ? '' : current));
    }, CANVASPRO_NOTICE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const sendCanvasCommand = useCallback(
    <T,>(action: string, payload?: Record<string, unknown>, timeoutMs = 30000) => {
      const target = iframeRef.current?.contentWindow;
      if (!target) return Promise.reject(new Error('CanvasPro iframe is not ready'));
      const id = createRequestId();
      return new Promise<T>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pendingRequests.current.delete(id);
          reject(new Error(`CanvasPro bridge timed out: ${action}`));
        }, timeoutMs);
        pendingRequests.current.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
        });
        target.postMessage(
          {
            action,
            id,
            payload: payload || {},
            type: BRIDGE_REQUEST,
          },
          window.location.origin,
        );
      });
    },
    [],
  );

  const injectStudioBridge = useCallback(() => {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!doc) return;
    if (doc.querySelector('[data-canvaspro-placeholder="1"]')) return;
    if (doc.getElementById('myshell-studio-canvaspro-bridge')) return;
    const script = doc.createElement('script');
    script.id = 'myshell-studio-canvaspro-bridge';
    script.type = 'module';
    script.src = CANVASPRO_BRIDGE_SRC;
    doc.head.appendChild(script);
  }, []);

  const refreshGenerationTasks = useCallback(async () => {
    const result = await sendCanvasCommand<GenerationTasksResult>('getGenerationTasks', { limit: 8 }, 15000);
    setGenerationTasks(result.tasks || []);
    setBridgeStatus((current) => ({
      ...current,
      apiReachable: result.apiReachable ?? current.apiReachable,
      stats: result.stats || current.stats,
    }));
    return result;
  }, [sendCanvasCommand]);

  const refreshCliAuthStatus = useCallback(async () => {
    setCliAuthLoading(true);
    try {
      const response = await fetch('/api/studio/canvaspro/cli-auth');
      const payload = (await response.json().catch(() => ({}))) as CanvasProCliAuthStatus;
      if (!response.ok) {
        throw new Error(payload.message || `CLI auth status failed: ${response.status}`);
      }
      setCliAuthStatus(payload);
      setCliLoginMessage(payload.message || '');
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload: CanvasProCliAuthStatus = {
        message,
        ready: false,
        status: 'error',
      };
      setCliAuthStatus(payload);
      setCliLoginMessage(message);
      return payload;
    } finally {
      setCliAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCliAuthStatus();
  }, [refreshCliAuthStatus]);

  const submitCliLogin = useCallback(async () => {
    const secret = cliLoginSecret.trim();
    if (!secret) {
      setCliLoginMessage(cliLoginMethod === 'token' ? '需要 MyShell token' : '需要 MyShell cookie');
      return;
    }
    setCliAuthLoading(true);
    setCliLoginMessage('登录中');
    try {
      const response = await fetch('/api/studio/canvaspro/cli-auth/login', {
        body: JSON.stringify({
          method: cliLoginMethod,
          [cliLoginMethod]: secret,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const payload = (await response.json().catch(() => ({}))) as CanvasProCliAuthStatus;
      if (!response.ok) {
        throw new Error(payload.message || `CLI login failed: ${response.status}`);
      }
      setCliAuthStatus(payload);
      setCliLoginSecret('');
      setCliLoginMessage(payload.message || (isCliAuthReady(payload) ? 'CLI 已登录' : '登录结果待确认'));
      void refreshGenerationTasks().catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCliAuthStatus((current) => ({
        ...(current || {}),
        message,
        ready: false,
        status: 'error',
      }));
      setCliLoginMessage(message);
    } finally {
      setCliAuthLoading(false);
    }
  }, [cliLoginMethod, cliLoginSecret, refreshGenerationTasks]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<BridgeResponseMessage>) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data || {};
      if (message.type === BRIDGE_READY) {
        setBridgeStatus((current) => ({
          ...current,
          ...((message.payload as BridgeStatus | undefined) || {}),
          ready: Boolean((message.payload as BridgeStatus | undefined)?.ready),
        }));
        return;
      }
      if (message.type === BRIDGE_AUTOSAVE) {
        const payload = (message.payload as AutosavePayload | undefined) || {};
        setLastAutosave(payload);
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: payload.apiReachable,
          lastAutosave: payload,
          stats: payload.stats || current.stats,
        }));
        return;
      }
      if (message.type === BRIDGE_AGENT_PANEL) {
        setAgentPanelOpen(message.open === true);
        return;
      }
      if (message.type !== BRIDGE_RESPONSE || !message.id) return;
      const pending = pendingRequests.current.get(message.id);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pendingRequests.current.delete(message.id);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error || 'CanvasPro bridge request failed'));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (!bridgeStatus.ready) return;
    void refreshGenerationTasks().catch(() => undefined);
  }, [bridgeStatus.ready, refreshGenerationTasks]);

  useEffect(() => {
    if (!bridgeStatus.ready || !generationTasks.length) {
      setGenerationAutoSync((current) => (current.active ? { ...current, active: false } : current));
      return;
    }

    let cancelled = false;
    const syncNextTask = async () => {
      const candidates = generationTasks.filter(isAutoSyncGenerationTask);
      if (!candidates.length) {
        setGenerationAutoSync((current) => (current.active ? { ...current, active: false } : current));
        return;
      }

      const now = Date.now();
      const task = candidates.find((candidate) => {
        const taskKey = getGenerationTaskKey(candidate);
        if (!taskKey || autoSyncInFlight.current.has(taskKey)) return false;
        const lastRun = autoSyncLastRun.current.get(taskKey) || 0;
        return now - lastRun >= GENERATION_AUTO_SYNC_MIN_INTERVAL_MS;
      });
      if (!task) return;

      const taskKey = getGenerationTaskKey(task);
      autoSyncLastRun.current.set(taskKey, now);
      autoSyncInFlight.current.add(taskKey);
      setGenerationAutoSync({
        active: true,
        message: '自动同步中',
        taskId: taskKey,
      });

      try {
        const result = await sendCanvasCommand<SyncGenerationTaskResult>(
          'syncGenerationTask',
          {
            focus: false,
            materialize: true,
            nodeId: task.nodeId,
            taskId: task.id,
            toast: false,
          },
          20000,
        );
        if (cancelled) return;
        const materializedCount = result.materializedOutputs?.length || 0;
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: result.apiReachable ?? current.apiReachable,
          stats: result.stats || current.stats,
        }));
        setGenerationAutoSync({
          active: false,
          materialized: materializedCount,
          message: materializedCount ? `${materializedCount} 个结果已自动落画布` : '自动同步已检查',
          syncedAt: result.syncedAt || result.task?.updatedAt,
          taskId: taskKey,
        });
        if (materializedCount) {
          setNotice(`生成完成，${materializedCount} 个结果已自动落画布`);
        }
        void refreshGenerationTasks().catch(() => undefined);
      } catch (error) {
        if (!cancelled) {
          setGenerationAutoSync({
            active: false,
            message: error instanceof Error ? error.message : String(error),
            taskId: taskKey,
          });
        }
      } finally {
        autoSyncInFlight.current.delete(taskKey);
      }
    };

    void syncNextTask();
    const interval = window.setInterval(syncNextTask, GENERATION_AUTO_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [bridgeStatus.ready, generationTasks, refreshGenerationTasks, sendCanvasCommand]);

  const runBridgeAction = useCallback(
    async <T,>(
      action: string,
      work: () => Promise<T>,
      successMessage: (result: T) => string,
    ) => {
      setBusyAction(action);
      setNotice('');
      try {
        const result = await work();
        if (
          action.startsWith('create') ||
          action === 'importPackage' ||
          action === 'importMediaFiles' ||
          action === 'updateGenerationTask' ||
          action === 'submitGenerationTask' ||
          action === 'syncGenerationTask' ||
          action === 'materializeGenerationOutput' ||
          action === 'rerunGenerationTask' ||
          action === 'restoreGenerationTaskNode' ||
          action === 'removeGenerationTask'
        ) {
          void refreshGenerationTasks().catch(() => undefined);
        }
        setNotice(successMessage(result));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction('');
      }
    },
    [refreshGenerationTasks],
  );

  const buildSuperClawCanvasPayload = useCallback(
    (context: CanvasProSuperClawContext): SuperClawCanvasRunRequest => {
      const nodes = context.nodes || [];
      const connections = context.connections || [];
      const selectedNodeId = context.selectedNodeId || context.selectedNodeIds?.[0] || null;
      const selectedNodeTitle = context.selectedNode?.title || context.selectedNode?.prompt || '';
      const canvasName = context.activeCanvasName || context.project?.name || 'AI CanvasPro';
      const prompt =
        quickPrompt.trim() ||
        [
          `通过 SuperClaw 执行 AI CanvasPro 画布「${canvasName}」的当前工作流。`,
          selectedNodeTitle ? `当前选中节点：${selectedNodeTitle}。` : '',
          '请根据节点、连线、素材和生成任务上下文完成调度、执行与验证。',
        ]
          .filter(Boolean)
          .join('\n');
      return {
        projectId: context.projectId || context.project?.id || null,
        action: 'canvaspro-workflow',
        prompt,
        selectedNodeId,
        selectedNodeIds: context.selectedNodeIds || (selectedNodeId ? [selectedNodeId] : []),
        viewport: context.viewport,
        nodes,
        connections,
        run: {
          dryRun: false,
          backendPolicy: 'claude',
          harnessPolicy: 'codex',
          repoPath: '.',
          budgetSeconds: 600,
          verificationPolicy: 'adversarial',
          permissionPreset: 'ask',
        },
      };
    },
    [quickPrompt],
  );

  const runCanvasProWithSuperClaw = useCallback(async () => {
    if (!bridgeStatus.ready) {
      setNotice('AI CanvasPro Bridge 还未就绪');
      return;
    }
    setBusyAction('superclaw:canvaspro-run');
    setNotice('');
    try {
      const context = await sendCanvasCommand<CanvasProSuperClawContext>('getSuperClawCanvasContext', {}, 15000);
      const nodeCount = context.nodes?.length || 0;
      if (!nodeCount) {
        throw new Error('AI CanvasPro 画布里还没有可交给 SuperClaw 调度的节点');
      }
      if (context.stats) {
        setBridgeStatus((current) => ({ ...current, stats: context.stats || current.stats }));
      }
      const result = await runSuperClawCanvas(buildSuperClawCanvasPayload(context));
      if (!result) {
        throw new Error('SuperClaw 调度失败，请检查服务配置和运行状态');
      }
      setNotice(`SuperClaw 已接管 CanvasPro 工作流 · ${result.execution.runId}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction('');
    }
  }, [bridgeStatus.ready, buildSuperClawCanvasPayload, runSuperClawCanvas, sendCanvasCommand]);

  useEffect(() => {
    const latestEventText = formatSuperClawEvent(superClawRunEvents[superClawRunEvents.length - 1]);
    if (!latestEventText || !superClawRunInFlight) return;
    setNotice(`SuperClaw：${latestEventText}`);
  }, [superClawRunEvents, superClawRunInFlight]);

  const saveSnapshot = useCallback(() => {
    void runBridgeAction(
      'saveSnapshot',
      () => sendCanvasCommand<AutosavePayload>('saveSnapshot', { reason: 'manual' }),
      (result) => `离线快照已保存${formatSavedAt(result.savedAt) ? ` · ${formatSavedAt(result.savedAt)}` : ''}`,
    );
  }, [runBridgeAction, sendCanvasCommand]);

  const exportPackage = useCallback(() => {
    void runBridgeAction(
      'exportPackage',
      () =>
        sendCanvasCommand<{ assets?: number; filename?: string; skippedAssets?: number }>(
          'exportPackage',
          {},
          90000,
        ),
      (result) =>
        `项目包已导出 · ${result.assets || 0} 个资产${result.skippedAssets ? `，${result.skippedAssets} 个保留引用` : ''}`,
    );
  }, [runBridgeAction, sendCanvasCommand]);

  const copySelectedContext = useCallback(() => {
    void runBridgeAction(
      'copySelectedContext',
      async () => {
        const context = await sendCanvasCommand<{ nodes?: unknown[] }>('getSelectedContext');
        const text = JSON.stringify(context, null, 2);
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.left = '-9999px';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
        return context;
      },
      (context) => `已复制 ${context.nodes?.length || 0} 个选中节点上下文`,
    );
  }, [runBridgeAction, sendCanvasCommand]);

  const focusGenerationTask = useCallback(
    (task: GenerationTask) => {
      const taskId = getGenerationTaskKey(task);
      if (!taskId) return;
      setSelectedGenerationTaskId(taskId);
      setTaskPromptDraft(task.prompt || '');
      void sendCanvasCommand<FocusGenerationTaskResult>(
        'focusGenerationTask',
        { nodeId: task.nodeId, taskId: task.id },
        10000,
      )
        .then((result) => {
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: result.apiReachable ?? current.apiReachable,
            stats: result.stats || current.stats,
          }));
          if (result.task) {
            const nextTaskKey = getGenerationTaskKey(result.task);
            if (nextTaskKey) {
              setGenerationTasks((current) =>
                current.map((item) => (getGenerationTaskKey(item) === nextTaskKey ? result.task || item : item)),
              );
            }
          }
          if (result.missingNode) {
            setNotice(result.message || '关联节点已删除，可恢复到画布');
            void refreshGenerationTasks().catch(() => undefined);
          }
        })
        .catch((error) => {
          setNotice(error instanceof Error ? error.message : String(error));
        });
    },
    [refreshGenerationTasks, sendCanvasCommand],
  );

  const restoreSelectedGenerationTaskNode = useCallback(() => {
    if (!selectedGenerationTask) return;
    void runBridgeAction(
      'restoreGenerationTaskNode',
      async () => {
        const result = await sendCanvasCommand<RestoreGenerationTaskNodeResult>(
          'restoreGenerationTaskNode',
          { nodeId: selectedGenerationTask.nodeId, taskId: selectedGenerationTask.id },
          15000,
        );
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: result.apiReachable ?? current.apiReachable,
          stats: result.stats || current.stats,
        }));
        const restoredTaskKey = getGenerationTaskKey(result.task);
        if (restoredTaskKey) setSelectedGenerationTaskId(restoredTaskKey);
        return result;
      },
      (result) => (result.restored ? '已恢复任务节点到画布' : '任务节点仍在画布上'),
    );
  }, [runBridgeAction, selectedGenerationTask, sendCanvasCommand, setSelectedGenerationTaskId]);

  const removeSelectedGenerationTask = useCallback(() => {
    if (!selectedGenerationTask) return;
    void runBridgeAction(
      'removeGenerationTask',
      async () => {
        const result = await sendCanvasCommand<RemoveGenerationTaskResult>(
          'removeGenerationTask',
          { nodeId: selectedGenerationTask.nodeId, taskId: selectedGenerationTask.id },
          10000,
        );
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: result.apiReachable ?? current.apiReachable,
          stats: result.stats || current.stats,
        }));
        setSelectedGenerationTaskId('');
        return result;
      },
      () => '已移除队列任务',
    );
  }, [runBridgeAction, selectedGenerationTask, sendCanvasCommand, setSelectedGenerationTaskId]);

  const updateSelectedGenerationTask = useCallback(() => {
    if (!selectedGenerationTask) return;
    void runBridgeAction(
      'updateGenerationTask',
      async () => {
        const result = await sendCanvasCommand<UpdateGenerationTaskResult>(
          'updateGenerationTask',
          {
            nodeId: selectedGenerationTask.nodeId,
            execute: true,
            prompt: taskPromptDraft,
            settings: {
              aspectRatio: taskAspectRatioDraft,
              durationSeconds: taskDurationDraft,
              mode: taskModeDraft,
              model: taskModelDraft,
              outputCount: taskOutputCountDraft,
              quality: taskQualityDraft,
              resolution: taskResolutionDraft,
            },
            taskId: selectedGenerationTask.id,
          },
          120000,
        );
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: result.apiReachable ?? current.apiReachable,
          stats: result.stats || current.stats,
        }));
        return result;
      },
      () => '已更新生成任务',
    );
  }, [
    runBridgeAction,
    selectedGenerationTask,
    sendCanvasCommand,
    taskAspectRatioDraft,
    taskDurationDraft,
    taskModeDraft,
    taskModelDraft,
    taskOutputCountDraft,
    taskPromptDraft,
    taskQualityDraft,
    taskResolutionDraft,
  ]);

  const submitSelectedGenerationTask = useCallback(() => {
    if (!selectedGenerationTask) return;
    if (cliAuthStatus && !isCliAuthReady(cliAuthStatus)) {
      setCliLoginOpen(true);
    }
    void runBridgeAction(
      'submitGenerationTask',
      async () => {
        const result = await sendCanvasCommand<SubmitGenerationTaskResult>(
          'submitGenerationTask',
          {
            nodeId: selectedGenerationTask.nodeId,
            prompt: taskPromptDraft,
            settings: {
              aspectRatio: taskAspectRatioDraft,
              durationSeconds: taskDurationDraft,
              mode: taskModeDraft,
              model: taskModelDraft,
              outputCount: taskOutputCountDraft,
              quality: taskQualityDraft,
              resolution: taskResolutionDraft,
            },
            taskId: selectedGenerationTask.id,
          },
          15000,
        );
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: result.apiReachable ?? current.apiReachable,
          stats: result.stats || current.stats,
        }));
        return result;
      },
      (result) =>
        result.task?.status === 'done'
          ? 'CLI 已返回结果'
          : result.task?.status === 'running'
            ? '已通过 CLI 提交生成'
            : result.task?.status === 'auth_missing'
              ? 'CLI 凭证未就绪'
              : result.task?.status === 'ready'
                ? '已保存，等待 CLI 配置'
                : '已加入生成队列',
    );
  }, [
    runBridgeAction,
    selectedGenerationTask,
    sendCanvasCommand,
    cliAuthStatus,
    taskAspectRatioDraft,
    taskDurationDraft,
    taskModeDraft,
    taskModelDraft,
    taskOutputCountDraft,
    taskPromptDraft,
    taskQualityDraft,
    taskResolutionDraft,
  ]);

  const syncSelectedGenerationTask = useCallback(() => {
    if (!selectedGenerationTask) return;
    void runBridgeAction(
      'syncGenerationTask',
      async () => {
        const result = await sendCanvasCommand<SyncGenerationTaskResult>(
          'syncGenerationTask',
          {
            nodeId: selectedGenerationTask.nodeId,
            prompt: taskPromptDraft,
            settings: {
              aspectRatio: taskAspectRatioDraft,
              durationSeconds: taskDurationDraft,
              mode: taskModeDraft,
              model: taskModelDraft,
              outputCount: taskOutputCountDraft,
              quality: taskQualityDraft,
              resolution: taskResolutionDraft,
            },
            taskId: selectedGenerationTask.id,
          },
          15000,
        );
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: result.apiReachable ?? current.apiReachable,
          stats: result.stats || current.stats,
        }));
        return result;
      },
      (result) =>
        result.materializedOutputs?.length
          ? `已同步生成任务，${result.materializedOutputs.length} 个结果已落画布`
          : '已同步生成任务',
    );
  }, [
    runBridgeAction,
    selectedGenerationTask,
    sendCanvasCommand,
    taskAspectRatioDraft,
    taskDurationDraft,
    taskModeDraft,
    taskModelDraft,
    taskOutputCountDraft,
    taskPromptDraft,
    taskQualityDraft,
    taskResolutionDraft,
  ]);

  const materializeGenerationOutput = useCallback(
    (task: GenerationTask, output: GenerationTaskOutput) => {
      const taskId = getGenerationTaskKey(task);
      const outputId = output.id || '';
      if (!taskId || (!outputId && !output.index)) return;
      void runBridgeAction(
        'materializeGenerationOutput',
        async () => {
          const result = await sendCanvasCommand<MaterializeGenerationOutputResult>(
            'materializeGenerationOutput',
            {
              nodeId: task.nodeId,
              outputId,
              outputIndex: output.index,
              taskId: task.id,
            },
            15000,
          );
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: result.apiReachable ?? current.apiReachable,
            stats: result.stats || current.stats,
          }));
          return result;
        },
        (result) => (result.created ? '生成结果已落到画布' : '已定位生成结果节点'),
      );
    },
    [runBridgeAction, sendCanvasCommand],
  );

  const continueFromGenerationOutput = useCallback(
    (task: GenerationTask, output: GenerationTaskOutput, action: GenerationOutputContinuationAction) => {
      const taskId = getGenerationTaskKey(task);
      const outputId = output.id || '';
      if (!taskId || (!outputId && !output.index)) return;
      const prompt = task.prompt || task.nodeName || '';
      void runBridgeAction(
        `createFromGenerationOutput:${action}`,
        async () => {
          const materialized = await sendCanvasCommand<ContinueGenerationOutputResult>(
            'continueGenerationOutput',
            {
              action,
              nodeId: task.nodeId,
              outputId,
              outputIndex: output.index,
              prompt,
              taskId: task.id,
            },
            15000,
          );
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: materialized.apiReachable ?? current.apiReachable,
            stats: materialized.stats || current.stats,
          }));
          return materialized;
        },
        () =>
          action === 'variants'
            ? '已从生成结果创建三版变体'
            : action === 'reference'
              ? '已从生成结果创建引用说明'
              : '已从生成结果接续视频',
      );
    },
    [runBridgeAction, sendCanvasCommand],
  );

  const rerunGenerationTask = useCallback(
    (task: GenerationTask, action: GenerationTaskRerunAction, output?: GenerationTaskOutput) => {
      const taskId = getGenerationTaskKey(task);
      if (!taskId) return;
      const outputId = output?.id || '';
      void runBridgeAction(
        'rerunGenerationTask',
        async () => {
          const result = await sendCanvasCommand<RerunGenerationTaskResult>(
            'rerunGenerationTask',
            {
              action,
              nodeId: task.nodeId,
              outputId,
              outputIndex: output?.index,
              prompt: taskPromptDraft || task.prompt || '',
              settings: {
                aspectRatio: taskAspectRatioDraft,
                durationSeconds: taskDurationDraft,
                mode: taskModeDraft,
                model: taskModelDraft,
                outputCount: taskOutputCountDraft,
                quality: taskQualityDraft,
                resolution: taskResolutionDraft,
              },
              taskId: task.id,
            },
            15000,
          );
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: result.apiReachable ?? current.apiReachable,
            stats: result.stats || current.stats,
          }));
          return result;
        },
        (result) =>
          action === 'model'
            ? `已创建换模型重跑任务${result.model ? ` · ${result.model}` : ''}`
            : '已复用参数创建重跑任务',
      );
    },
    [
      runBridgeAction,
      sendCanvasCommand,
      taskAspectRatioDraft,
      taskDurationDraft,
      taskModeDraft,
      taskModelDraft,
      taskOutputCountDraft,
      taskPromptDraft,
      taskQualityDraft,
      taskResolutionDraft,
    ],
  );

  const createCanvasNode = useCallback(
    (kind: QuickCreateKind, promptOverride = quickPrompt, options: CreateNodeOptions = {}) => {
      const selectedSource = options.source === 'selected';
      void runBridgeAction(
        selectedSource ? `createNode:${kind}:selected` : `createNode:${kind}`,
        async () => {
          const result = await sendCanvasCommand<CreateNodeResult>('createNode', {
            kind,
            prompt: promptOverride,
            source: selectedSource ? 'selected' : undefined,
          });
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: result.apiReachable ?? current.apiReachable,
            stats: result.stats || current.stats,
          }));
          return result;
        },
        (result) => {
          const label = kind === 'image' ? '图像' : kind === 'video' ? '视频' : '文本';
          const promptLabel = result.promptSeeded || result.contentSeeded ? '，已带入内容' : '';
          const sourceLabel = result.edgeId ? '，已连接选中素材' : '';
          const prepareLabel =
            kind !== 'note'
              ? result.autoPrepared
                ? '，已准备生成'
                : result.prepareMessage
                  ? '，生成准备待重试'
                  : ''
              : '';
          return `已新建${label}节点${promptLabel}${sourceLabel}${prepareLabel}`;
        },
      );
    },
    [quickPrompt, runBridgeAction, sendCanvasCommand],
  );

  const runAddMenuItem = useCallback(
    (item: AddMenuItem) => {
      setAddMenuOpen(false);
      setQuickCommandOpen(false);
      if (item.action === 'text') {
        createCanvasNode('note');
        return;
      }
      if (item.action === 'image') {
        createCanvasNode('image');
        return;
      }
      if (item.action === 'video') {
        createCanvasNode('video');
        return;
      }
      if (item.action === 'upload') {
        mediaFileInputRef.current?.click();
        return;
      }
      createCanvasNode('note', buildAddMenuDraftContent(item.action, quickPrompt));
    },
    [createCanvasNode, quickPrompt],
  );

  const createCanvasFlow = useCallback(
    (promptOverride = quickPrompt, options: CreateFlowOptions = {}) => {
      const selectedSource = options.source === 'selected';
      void runBridgeAction(
        selectedSource ? 'createFlow:image-video:selected' : 'createFlow:image-video',
        async () => {
          const result = await sendCanvasCommand<CreateFlowResult>('createFlow', {
            prompt: promptOverride,
            source: selectedSource ? 'selected' : undefined,
          });
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: result.apiReachable ?? current.apiReachable,
            stats: result.stats || current.stats,
          }));
          return result;
        },
        (result) => {
          const promptLabel = result.promptSeeded ? '，已带入描述' : '';
          const sourceLabel = result.sourceNodeId ? '，已纳入选中素材' : '';
          return `已新建图片到视频创作流${promptLabel}${sourceLabel}`;
        },
      );
    },
    [quickPrompt, runBridgeAction, sendCanvasCommand],
  );

  const createCanvasStoryboard = useCallback(
    (promptOverride = quickPrompt) => {
      void runBridgeAction(
        'createStoryboard',
        async () => {
          const result = await sendCanvasCommand<CreateStoryboardResult>('createStoryboard', {
            prompt: promptOverride,
          });
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: result.apiReachable ?? current.apiReachable,
            stats: result.stats || current.stats,
          }));
          return result;
        },
        (result) => {
          const shotCount = result.videoNodeIds?.length || 3;
          const promptLabel = result.promptSeeded ? '，已带入描述' : '';
          return `已新建 ${shotCount} 镜头分镜创作流${promptLabel}`;
        },
      );
    },
    [quickPrompt, runBridgeAction, sendCanvasCommand],
  );

  const createCanvasVariants = useCallback(
    (promptOverride = quickPrompt) => {
      void runBridgeAction(
        'createVariants:selected',
        async () => {
          const result = await sendCanvasCommand<CreateVariantsResult>('createVariants', {
            prompt: promptOverride,
            source: 'selected',
          });
          setBridgeStatus((current) => ({
            ...current,
            apiReachable: result.apiReachable ?? current.apiReachable,
            stats: result.stats || current.stats,
          }));
          return result;
        },
        (result) => {
          const count = result.outputNodeIds?.length || 3;
          const mediaLabel = result.sourceMediaKind === 'video' ? '视频' : '图像';
          const promptLabel = result.promptSeeded ? '，已带入描述' : '';
          return `已新建 ${count} 个${mediaLabel}变体${promptLabel}`;
        },
      );
    },
    [quickPrompt, runBridgeAction, sendCanvasCommand],
  );

  const organizeCanvas = useCallback(() => {
    void runBridgeAction(
      'organizeCanvas',
      async () => {
        const result = await sendCanvasCommand<OrganizeCanvasResult>('organizeCanvas');
        setBridgeStatus((current) => ({
          ...current,
          apiReachable: result.apiReachable ?? current.apiReachable,
          stats: result.stats || current.stats,
        }));
        return result;
      },
      (result) => `已整理 ${result.unitCount || result.arrangedNodeCount || 0} 组画布内容`,
    );
  }, [runBridgeAction, sendCanvasCommand]);

  const submitQuickPrompt = useCallback(
    (defaultKind: QuickCreateKind) => {
      const command = parseQuickCreateCommand(quickPrompt);
      setAddMenuOpen(false);
      setQuickCommandOpen(false);
      if (command?.action === 'organize') {
        organizeCanvas();
        return;
      }
      if (command?.action === 'variants') {
        createCanvasVariants(command.prompt);
        return;
      }
      if (command?.action === 'storyboard') {
        createCanvasStoryboard(command.prompt);
        return;
      }
      if (command?.action === 'flow') {
        createCanvasFlow(command.prompt, command.source ? { source: command.source } : {});
        return;
      }
      createCanvasNode(
        command?.kind || defaultKind,
        command ? command.prompt : quickPrompt,
        command?.source ? { source: command.source } : {},
      );
    },
    [createCanvasFlow, createCanvasNode, createCanvasStoryboard, createCanvasVariants, organizeCanvas, quickPrompt],
  );

  const openShortcuts = useCallback(() => {
    void runBridgeAction(
      'openShortcuts',
      () => sendCanvasCommand<{ opened?: boolean }>('openShortcuts'),
      (result) => (result.opened ? '已打开快捷键设置' : '快捷键设置暂不可用'),
    );
  }, [runBridgeAction, sendCanvasCommand]);

  const importPackageFile = useCallback(
    (file: File) => {
      void runBridgeAction(
        'importPackage',
        () =>
          sendCanvasCommand<{ projectName?: string; stats?: BridgeStats }>(
            'importPackage',
            { file },
            90000,
          ),
        (result) => `已导入 ${result.projectName || 'CanvasPro 项目'}`,
      );
    },
    [runBridgeAction, sendCanvasCommand],
  );

  const importMediaFiles = useCallback(
    (files: FileList | File[]) => {
      const mediaFiles = Array.from(files || []);
      if (!mediaFiles.length) return;
      void runBridgeAction(
        'importMediaFiles',
        () =>
          sendCanvasCommand<ImportMediaFilesResult>(
            'importMediaFiles',
            { files: mediaFiles },
            90000,
          ),
        (result) => {
          const imported = result.imported || result.nodeIds?.length || 0;
          const skipped = result.skipped?.length ? `，跳过 ${result.skipped.length} 个` : '';
          return `已上传 ${imported} 个素材${skipped}`;
        },
      );
    },
    [runBridgeAction, sendCanvasCommand],
  );

  const bridgeReady = Boolean(bridgeStatus.ready);
  const apiReachable = bridgeStatus.apiReachable;
  const statusLabel = !bridgeReady
    ? 'Bridge 启动中'
    : apiReachable === false
      ? '离线快照'
      : apiReachable === true
        ? '本地服务已连'
        : 'Studio Bridge';
  const savedLabel = formatSavedAt(lastAutosave?.savedAt || bridgeStatus.lastAutosave?.savedAt);
  const nodeCount = bridgeStatus.stats?.nodeCount ?? lastAutosave?.stats?.nodeCount;
  const showBackButton = Boolean(onBackToStudio) || !embeddedInStudio;
  const backLabel = 'Studio';
  const creatingImage = busyAction === 'createNode:image';
  const creatingImageFromSelection = busyAction === 'createNode:image:selected';
  const creatingVideo = busyAction === 'createNode:video';
  const creatingNote = busyAction === 'createNode:note';
  const creatingNoteFromSelection = busyAction === 'createNode:note:selected';
  const creatingVideoFromSelection = busyAction === 'createNode:video:selected';
  const creatingFlow = busyAction === 'createFlow:image-video';
  const creatingSelectedFlow = busyAction === 'createFlow:image-video:selected';
  const creatingStoryboard = busyAction === 'createStoryboard';
  const creatingVariants = busyAction === 'createVariants:selected';
  const recentGenerationTasks = generationTasks.slice(0, 4);
  const autoSyncQueueCount = generationTasks.filter(isAutoSyncGenerationTask).length;
  const selectedGenerationTaskMissingNode = Boolean(selectedGenerationTask?.missingNode);
  const selectedGenerationTaskMutable = bridgeReady && !busyAction && !selectedGenerationTaskMissingNode;
  const autoSyncLabel = generationAutoSync.active
    ? '自动同步中'
    : generationAutoSync.materialized
      ? '已自动落画布'
      : autoSyncQueueCount
        ? '自动同步待命'
        : '自动同步';
  const cliReady = isCliAuthReady(cliAuthStatus);
  const cliInstalled = cliAuthStatus?.cliStatus?.ready ?? cliAuthStatus?.status !== 'not_installed';
  const cliAuthLabel = formatCliAuthLabel(cliAuthStatus, cliAuthLoading);
  const cliAuthDetail = formatCliAuthDetail(cliAuthStatus);
  const cliAuthDotClass = !cliInstalled
    ? 'bg-red-400'
    : cliReady
      ? 'bg-green-400'
      : cliAuthLoading
        ? 'bg-yellow-300'
        : 'bg-orange-400';
  const cliAuthRaw = cliAuthStatus?.raw || {};
  const cliCookieCount = Number(cliAuthRaw.cookie_count || cliAuthRaw.cookieCount || 0);
  const cliHasToken = Boolean(cliAuthRaw.has_token || cliAuthRaw.hasToken);
  const cliHasBrowserState = Boolean(cliAuthRaw.browser_state_exists || cliAuthRaw.browserStateExists);
  const cliDefaultsLabel = formatCliDefaultLabel(cliAuthStatus?.cliStatus?.defaults);
  const detailsPanelVisible = detailsPanelOpen || cliLoginOpen;

  return (
    <main
      data-testid="canvaspro-workspace"
      className="relative h-full w-full overflow-hidden bg-Cr-Bg-soft-v2"
    >
      <iframe
        ref={iframeRef}
        key={reloadKey}
        data-testid="canvaspro-iframe"
        title="AI CanvasPro"
        src={src}
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write; fullscreen; web-share"
        onLoad={injectStudioBridge}
      />
      <input
        ref={packageFileInputRef}
        type="file"
        data-testid="canvaspro-package-import-input"
        accept=".canvaspro.zip,.zip,.json,application/json,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) importPackageFile(file);
        }}
      />
      <input
        ref={mediaFileInputRef}
        type="file"
        data-testid="canvaspro-media-upload-input"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files || []);
          event.currentTarget.value = '';
          if (files.length) importMediaFiles(files);
        }}
      />
      <CanvasProToolbar
        apiReachable={apiReachable}
        agentPanelOpen={agentPanelOpen}
        backLabel={backLabel}
        bridgeReady={bridgeReady}
        busyAction={busyAction}
        cliAuthDetail={cliAuthDetail}
        cliAuthDotClass={cliAuthDotClass}
        cliAuthLabel={cliAuthLabel}
        cliLoginOpen={cliLoginOpen}
        copySelectedContext={copySelectedContext}
        detailsPanelOpen={detailsPanelOpen}
        exportPackage={exportPackage}
        generationTaskCount={generationTasks.length}
        nodeCount={nodeCount}
        onBack={() => {
          if (onBackToStudio) {
            onBackToStudio();
          } else {
            navigate('/dreamy');
          }
        }}
        openPackageImport={() => packageFileInputRef.current?.click()}
        openShortcuts={openShortcuts}
        refreshSuperClawStatus={() => void refreshSuperClawStatus()}
        reloadCanvas={() => setReloadKey((value) => value + 1)}
        resumeSuperClawRun={() => void resumeSuperClawRun()}
        runSuperClawWorkflow={() => void runCanvasProWithSuperClaw()}
        saveSnapshot={saveSnapshot}
        savedLabel={savedLabel}
        setCliLoginOpen={setCliLoginOpen}
        setDetailsPanelOpen={setDetailsPanelOpen}
        showBackButton={showBackButton}
        statusLabel={statusLabel}
        superClawBusy={superClawBusy || busyAction === 'superclaw:canvaspro-run'}
        superClawError={superClawError}
        superClawRunId={superClawRunId}
        superClawRunInFlight={superClawRunInFlight}
        superClawRunStatus={superClawRunStatus}
        superClawStatusLabel={superClawStatusLabel}
        superClawStatusLoading={superClawStatusLoading}
        cancelSuperClawRun={() => void cancelSuperClawRun()}
      />
      <aside
        data-testid="canvaspro-context-assistant"
        className={`pointer-events-auto absolute bottom-[88px] right-3 top-[64px] z-[135] min-h-0 w-[min(340px,calc(100vw-24px))] flex-col gap-2 overflow-y-auto rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/94 p-2 shadow-[0_16px_44px_rgba(0,0,0,0.34)] backdrop-blur-xl ${
          detailsPanelVisible ? 'flex' : 'hidden'
        }`}
        aria-label="CanvasPro context assistant"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-Cr-text-default-v2">
            {cliLoginOpen ? <Sparkles size={15} className="shrink-0 text-Cr-text-subtler-v2" /> : <ListVideo size={15} className="shrink-0 text-Cr-text-subtler-v2" />}
            <span className="truncate">{cliLoginOpen ? 'MyShell CLI' : '生成队列'}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setCliLoginOpen(false);
              setDetailsPanelOpen(false);
            }}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md-v2 text-Cr-text-default-v2 active:bg-Cr-beta-white-8-v2"
            aria-label="Close CanvasPro side panel"
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>
        {cliLoginOpen ? (
        <div
          data-testid="canvaspro-cli-auth-card"
          className="flex flex-col gap-2 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2/75 p-2"
          aria-label="MyShell CLI auth"
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold text-Cr-text-default-v2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${cliAuthDotClass}`} />
              <span className="truncate">{cliAuthLabel}</span>
            </div>
            <button
              type="button"
              onClick={refreshCliAuthStatus}
              disabled={cliAuthLoading}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
              aria-label="Refresh MyShell CLI auth status"
              title="刷新 CLI 状态"
            >
              <RefreshCw size={13} className={cliAuthLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-[10px] font-semibold">
            <div className="min-w-0 rounded-md-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1.5">
              <div className="truncate text-Cr-text-disabled-v2">Token</div>
              <div className="truncate text-Cr-text-default-v2">{cliHasToken ? 'ready' : 'empty'}</div>
            </div>
            <div className="min-w-0 rounded-md-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1.5">
              <div className="truncate text-Cr-text-disabled-v2">Cookies</div>
              <div className="truncate text-Cr-text-default-v2">{cliCookieCount || 0}</div>
            </div>
            <div className="min-w-0 rounded-md-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1.5">
              <div className="truncate text-Cr-text-disabled-v2">Browser</div>
              <div className="truncate text-Cr-text-default-v2">{cliHasBrowserState ? 'ready' : 'empty'}</div>
            </div>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-[10px] font-semibold">
            <span className="min-w-0 truncate text-Cr-text-disabled-v2">{cliAuthDetail}</span>
            <span className="shrink-0 text-Cr-text-subtler-v2">{cliDefaultsLabel}</span>
          </div>
          {cliLoginOpen ? (
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setCliLoginMethod('token')}
                  aria-pressed={cliLoginMethod === 'token'}
                  className={`h-7 rounded-md-v2 px-2 text-[11px] font-semibold ${
                    cliLoginMethod === 'token'
                      ? 'bg-Cr-Bg-inverse-v2 text-Cr-text-inverse-v2'
                      : 'bg-Cr-Bg-surface-default-v2/80 text-Cr-text-default-v2 active:bg-Cr-beta-white-8-v2'
                  }`}
                >
                  Token
                </button>
                <button
                  type="button"
                  onClick={() => setCliLoginMethod('cookie')}
                  aria-pressed={cliLoginMethod === 'cookie'}
                  className={`h-7 rounded-md-v2 px-2 text-[11px] font-semibold ${
                    cliLoginMethod === 'cookie'
                      ? 'bg-Cr-Bg-inverse-v2 text-Cr-text-inverse-v2'
                      : 'bg-Cr-Bg-surface-default-v2/80 text-Cr-text-default-v2 active:bg-Cr-beta-white-8-v2'
                  }`}
                >
                  Cookie
                </button>
              </div>
              <textarea
                data-testid="canvaspro-cli-login-secret"
                value={cliLoginSecret}
                onChange={(event) => setCliLoginSecret(event.currentTarget.value)}
                placeholder={cliLoginMethod === 'token' ? 'MyShell token' : 'cookie=value; ...'}
                className="min-h-[58px] resize-none rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-2 py-1.5 text-xs font-medium text-Cr-text-default-v2 outline-none placeholder:text-Cr-text-disabled-v2"
                aria-label="MyShell CLI login secret"
                spellCheck={false}
              />
              <div className="grid grid-cols-[1fr_auto] gap-1.5">
                <button
                  data-testid="canvaspro-cli-login-submit"
                  type="button"
                  onClick={submitCliLogin}
                  disabled={cliAuthLoading || !cliLoginSecret.trim()}
                  className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-inverse-v2 px-2 text-xs font-semibold text-Cr-text-inverse-v2 disabled:opacity-45 active:opacity-80"
                >
                  <Sparkles size={13} />
                  <span className="truncate">登录 CLI</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCliLoginSecret('');
                    setCliLoginOpen(false);
                  }}
                  className="h-8 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 active:bg-Cr-beta-white-8-v2"
                >
                  收起
                </button>
              </div>
              {cliLoginMessage ? (
                <div className="min-w-0 truncate text-[10px] font-semibold text-Cr-text-disabled-v2" title={cliLoginMessage}>
                  {cliLoginMessage}
                </div>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCliLoginOpen(true)}
              className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 active:bg-Cr-beta-white-8-v2"
            >
              <Sparkles size={13} />
              <span className="truncate">{cliReady ? '更新登录' : '登录 MyShell CLI'}</span>
            </button>
          )}
        </div>
        ) : null}
        {detailsPanelOpen ? (
        <>
        <div
          data-testid="canvaspro-generation-queue"
          className="flex flex-col gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2/70 p-2"
          aria-label="CanvasPro generation queue"
        >
          <div className="flex items-center justify-between gap-2 px-0.5 text-[11px] font-semibold text-Cr-text-disabled-v2">
            <span className="truncate">生成队列</span>
            <div className="flex shrink-0 items-center gap-1.5">
              <span
                data-testid="canvaspro-generation-auto-sync"
                className={`inline-flex h-5 items-center gap-1 rounded-full-v2 border border-Cr-border-default-v2 px-1.5 ${
                  generationAutoSync.active ? 'text-green-300' : 'text-Cr-text-disabled-v2'
                }`}
                title={generationAutoSync.message || '生成任务会自动同步外部结果'}
              >
                <RefreshCw size={10} className={generationAutoSync.active ? 'animate-spin' : ''} />
                <span>{autoSyncLabel}</span>
              </span>
              <span>{generationTasks.length ? `${generationTasks.length} tasks` : 'empty'}</span>
            </div>
          </div>
          {recentGenerationTasks.length ? (
            recentGenerationTasks.map((task, index) => {
              const progress = getGenerationTaskProgress(task);
              const taskKind = formatGenerationTaskKind(task.kind);
              const prompt = task.prompt || task.nodeName || '未命名生成';
              const taskKey = getGenerationTaskKey(task);
              const selected = taskKey === selectedGenerationTaskKey;
              return (
                <button
                  key={taskKey || `${taskKind}-${index}`}
                  data-testid="canvaspro-generation-queue-item"
                  type="button"
                  onClick={() => focusGenerationTask(task)}
                  aria-pressed={selected}
                  title={task.missingNode ? '关联节点已删除，可在任务参数中恢复' : undefined}
                  className={`min-w-0 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 py-1.5 text-left active:bg-Cr-beta-white-8-v2 ${
                    selected ? 'ring-1 ring-Cr-border-default-v2' : ''
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-subtler-v2">
                      {task.kind === 'video' ? (
                        <Video size={13} />
                      ) : task.kind === 'image' ? (
                        <ImageIcon size={13} />
                      ) : (
                        <Sparkles size={13} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-Cr-text-default-v2">
                        <span className="shrink-0">{taskKind}</span>
                        {task.missingNode ? (
                          <span className="shrink-0 rounded-full-v2 border border-Cr-border-default-v2 px-1 text-[9px] text-Cr-text-disabled-v2">
                            已脱离
                          </span>
                        ) : null}
                        <span className="min-w-0 truncate text-Cr-text-subtler-v2">{prompt}</span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] font-semibold text-Cr-text-disabled-v2">
                        <span className="truncate">{formatGenerationTaskStatus(task)}</span>
                        <span className="shrink-0">{Math.round(progress)}%</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full-v2 bg-Cr-border-default-v2/70">
                    <div className="h-full rounded-full-v2 bg-green-400" style={{ width: `${progress}%` }} />
                  </div>
                </button>
              );
            })
          ) : (
            <div className="rounded-md-v2 bg-Cr-Bg-surface-default-v2/60 px-2 py-2 text-xs font-semibold text-Cr-text-disabled-v2">
              暂无任务
            </div>
          )}
        </div>
        {selectedGenerationTask ? (
          <div
            data-testid="canvaspro-generation-task-detail"
            className="flex flex-col gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2/70 p-2"
            aria-label="CanvasPro generation task detail"
          >
            <div className="flex items-center justify-between gap-2 px-0.5">
              <div className="min-w-0 text-xs font-semibold text-Cr-text-default-v2">
                <span className="truncate">{formatGenerationTaskKind(selectedGenerationTask.kind)}任务</span>
              </div>
              <span className="shrink-0 text-[10px] font-semibold text-Cr-text-disabled-v2">
                {formatGenerationTaskStatus(selectedGenerationTask)}
              </span>
            </div>
            <div
              data-testid="canvaspro-generation-task-auto-sync"
              className="flex min-w-0 items-center justify-between gap-2 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1 text-[10px] font-semibold"
              title={generationAutoSync.message || '提交后自动轮询外部生成状态，并把完成结果落到画布'}
            >
              <span className="inline-flex min-w-0 items-center gap-1 text-Cr-text-default-v2">
                <RefreshCw size={11} className={generationAutoSync.active ? 'animate-spin text-green-300' : 'text-Cr-text-subtler-v2'} />
                <span className="truncate">{autoSyncLabel}</span>
              </span>
              <span className="shrink-0 text-Cr-text-disabled-v2">
                {getGenerationTaskCompletedOutputCount(selectedGenerationTask)}/{getGenerationTaskOutputCount(selectedGenerationTask)}
              </span>
            </div>
            {selectedGenerationTaskMissingNode ? (
              <div
                data-testid="canvaspro-generation-task-missing-node"
                className="rounded-md-v2 border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-[11px] font-semibold leading-4 text-amber-100"
              >
                关联节点已删除，任务参数和结果仍保留。恢复到画布后可继续同步、落图或重跑。
              </div>
            ) : null}
            <textarea
              data-testid="canvaspro-generation-task-prompt"
              value={taskPromptDraft}
              onChange={(event) => setTaskPromptDraft(event.currentTarget.value)}
              readOnly={selectedGenerationTaskMissingNode}
              className="min-h-[74px] resize-none rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-2 py-1.5 text-xs font-medium text-Cr-text-default-v2 outline-none placeholder:text-Cr-text-disabled-v2"
              placeholder="补充生成描述"
              aria-label="Edit CanvasPro generation task prompt"
            />
            <div
              data-testid="canvaspro-generation-task-param-summary"
              className="flex min-w-0 items-center justify-between gap-2 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1.5 text-[11px] font-semibold"
              title={taskParamSummary}
            >
              <span className="shrink-0 text-Cr-text-disabled-v2">节点参数</span>
              <span className="min-w-0 truncate text-Cr-text-default-v2">{taskParamSummary}</span>
            </div>
            {selectedGenerationTask.sourceInputs?.length ? (
              <div
                data-testid="canvaspro-generation-task-source-inputs"
                className="grid grid-cols-2 gap-1.5"
                aria-label="CanvasPro generation task source inputs"
              >
                {selectedGenerationTask.sourceInputs.map((input, index) => (
                  <div
                    key={input.nodeId || `${selectedGenerationTaskKey}-source-${index}`}
                    className="min-w-0 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1.5"
                    title={input.inputValue || input.value || undefined}
                  >
                    <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-Cr-text-default-v2">
                      {input.kind === 'video' ? (
                        <Video size={12} className="shrink-0 text-Cr-text-subtler-v2" />
                      ) : (
                        <ImageIcon size={12} className="shrink-0 text-Cr-text-subtler-v2" />
                      )}
                      <span className="truncate">{input.nodeName || `输入 ${input.index || index + 1}`}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] font-semibold text-Cr-text-disabled-v2">
                      {formatGenerationSourceInputStatus(input)}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div
              data-testid="canvaspro-generation-task-atom"
              className="min-w-0 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1.5"
              title={selectedGenerationTaskAtomCommand || undefined}
            >
              <div className="flex min-w-0 items-center justify-between gap-2 text-[10px] font-semibold text-Cr-text-disabled-v2">
                <span className="shrink-0">原子能力</span>
                <span className="min-w-0 truncate">{formatGenerationTaskAtomHint(selectedGenerationTask)}</span>
              </div>
              <div className="mt-0.5 min-w-0 truncate text-[11px] font-semibold text-Cr-text-default-v2">
                {formatGenerationTaskAtom(selectedGenerationTask)}
              </div>
              {selectedGenerationTaskAtomCommand ? (
                <div
                  data-testid="canvaspro-generation-task-atom-command"
                  className="mt-0.5 min-w-0 truncate font-mono text-[10px] font-semibold text-Cr-text-disabled-v2"
                >
                  {selectedGenerationTaskAtomCommand}
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <label className="min-w-0">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">模式</span>
                <select
                  data-testid="canvaspro-generation-task-mode"
                  value={taskModeDraft}
                  onChange={(event) => setTaskModeDraft(event.currentTarget.value)}
                  disabled={selectedGenerationTaskMissingNode}
                  className="h-8 w-full rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-1.5 text-xs font-semibold text-Cr-text-default-v2 outline-none"
                  aria-label="CanvasPro generation task mode"
                >
                  {getGenerationModeOptions(selectedGenerationTask.kind).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">模型</span>
                <select
                  data-testid="canvaspro-generation-task-model"
                  value={taskModelDraft}
                  onChange={(event) => setTaskModelDraft(event.currentTarget.value)}
                  disabled={selectedGenerationTaskMissingNode}
                  className="h-8 w-full rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-1.5 text-xs font-semibold text-Cr-text-default-v2 outline-none"
                  aria-label="CanvasPro generation task model"
                >
                  {getGenerationModelOptions(selectedGenerationTask.kind).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">质量</span>
                <select
                  data-testid="canvaspro-generation-task-quality"
                  value={taskQualityDraft}
                  onChange={(event) => setTaskQualityDraft(event.currentTarget.value)}
                  disabled={selectedGenerationTaskMissingNode}
                  className="h-8 w-full rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-1.5 text-xs font-semibold text-Cr-text-default-v2 outline-none"
                  aria-label="CanvasPro generation task quality"
                >
                  {GENERATION_QUALITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="min-w-0">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">比例</span>
                <select
                  data-testid="canvaspro-generation-task-aspect-ratio"
                  value={taskAspectRatioDraft}
                  onChange={(event) => setTaskAspectRatioDraft(event.currentTarget.value)}
                  disabled={selectedGenerationTaskMissingNode}
                  className="h-8 w-full rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-1.5 text-xs font-semibold text-Cr-text-default-v2 outline-none"
                  aria-label="CanvasPro generation task aspect ratio"
                >
                  {GENERATION_ASPECT_RATIO_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">分辨率</span>
                <select
                  data-testid="canvaspro-generation-task-resolution"
                  value={taskResolutionDraft}
                  onChange={(event) => setTaskResolutionDraft(event.currentTarget.value)}
                  disabled={selectedGenerationTaskMissingNode}
                  className="h-8 w-full rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-1.5 text-xs font-semibold text-Cr-text-default-v2 outline-none"
                  aria-label="CanvasPro generation task resolution"
                >
                  {getGenerationResolutionOptions(selectedGenerationTask.kind).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <label className="min-w-0">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">数量</span>
                <input
                  data-testid="canvaspro-generation-task-output-count"
                  type="number"
                  min={1}
                  max={4}
                  value={taskOutputCountDraft}
                  onChange={(event) =>
                    setTaskOutputCountDraft(Math.max(1, Math.min(Number(event.currentTarget.value) || 1, 4)))
                  }
                  disabled={selectedGenerationTaskMissingNode}
                  className="h-8 w-full rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 outline-none"
                  aria-label="CanvasPro generation task output count"
                />
              </label>
              <label className="min-w-0">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">秒数</span>
                <input
                  data-testid="canvaspro-generation-task-duration"
                  type="number"
                  min={2}
                  max={12}
                  value={taskDurationDraft}
                  onChange={(event) =>
                    setTaskDurationDraft(Math.max(2, Math.min(Number(event.currentTarget.value) || 5, 12)))
                  }
                  disabled={selectedGenerationTask.kind !== 'video' || selectedGenerationTaskMissingNode}
                  className="h-8 w-full rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 outline-none disabled:opacity-45"
                  aria-label="CanvasPro generation task duration"
                />
              </label>
              <div className="min-w-0" data-testid="canvaspro-generation-task-cost">
                <span className="mb-1 block truncate text-[10px] font-semibold text-Cr-text-disabled-v2">点数</span>
                <div
                  className="flex h-8 min-w-0 items-center rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2"
                  aria-label="CanvasPro generation task estimated credits"
                >
                  <span className="truncate">{taskCostEstimate.label || '约 0 点'}</span>
                </div>
              </div>
            </div>
            {selectedGenerationTask.outputs?.length ? (
              <div
                data-testid="canvaspro-generation-task-output-slots"
                className="grid grid-cols-2 gap-1.5"
                aria-label="CanvasPro generation task output slots"
              >
                {selectedGenerationTask.outputs.map((output, index) => (
                  <div
                    key={output.id || `${selectedGenerationTaskKey}-output-${index}`}
                    data-testid="canvaspro-generation-task-output-slot"
                    className="min-w-0 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/70 px-2 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-Cr-text-default-v2">
                      {output.kind === 'video' ? (
                        <Video size={12} className="shrink-0 text-Cr-text-subtler-v2" />
                      ) : (
                        <ImageIcon size={12} className="shrink-0 text-Cr-text-subtler-v2" />
                      )}
                      <span className="truncate">结果 {output.index || index + 1}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] font-semibold text-Cr-text-disabled-v2">
                      {formatGenerationOutputStatus(output)}
                    </div>
                    <button
                      data-testid="canvaspro-generation-task-output-materialize"
                      type="button"
                      onClick={() => materializeGenerationOutput(selectedGenerationTask, output)}
                      disabled={!selectedGenerationTaskMutable || !output.mediaUrl}
                      className="mt-1 inline-flex h-6 w-full min-w-0 items-center justify-center gap-1 rounded-md-v2 bg-Cr-Bg-base-v2 px-1.5 text-[10px] font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                      title={output.nodeId ? '定位生成结果节点' : output.mediaUrl ? '将生成结果落到画布' : '等待生成结果'}
                    >
                      {output.nodeId ? <Search size={11} /> : <Download size={11} />}
                      <span className="truncate">{output.nodeId ? '已落' : '落画布'}</span>
                    </button>
                    <div className="mt-1 grid grid-cols-5 gap-1">
                      <button
                        data-testid="canvaspro-generation-task-output-continue-video"
                        type="button"
                        onClick={() => continueFromGenerationOutput(selectedGenerationTask, output, 'video')}
                        disabled={!selectedGenerationTaskMutable || !output.mediaUrl}
                        className="inline-flex h-6 min-w-0 items-center justify-center rounded-md-v2 bg-Cr-Bg-base-v2 px-1 text-[10px] font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                        title={output.mediaUrl ? '用生成结果接续视频' : '等待生成结果'}
                      >
                        <Video size={10} className="shrink-0" />
                      </button>
                      <button
                        data-testid="canvaspro-generation-task-output-continue-variants"
                        type="button"
                        onClick={() => continueFromGenerationOutput(selectedGenerationTask, output, 'variants')}
                        disabled={!selectedGenerationTaskMutable || !output.mediaUrl}
                        className="inline-flex h-6 min-w-0 items-center justify-center rounded-md-v2 bg-Cr-Bg-base-v2 px-1 text-[10px] font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                        title={output.mediaUrl ? '用生成结果做三版变体' : '等待生成结果'}
                      >
                        <Sparkles size={10} className="shrink-0" />
                      </button>
                      <button
                        data-testid="canvaspro-generation-task-output-continue-reference"
                        type="button"
                        onClick={() => continueFromGenerationOutput(selectedGenerationTask, output, 'reference')}
                        disabled={!selectedGenerationTaskMutable || !output.mediaUrl}
                        className="inline-flex h-6 min-w-0 items-center justify-center rounded-md-v2 bg-Cr-Bg-base-v2 px-1 text-[10px] font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                        title={output.mediaUrl ? '用生成结果创建引用说明' : '等待生成结果'}
                      >
                        <Link2 size={10} className="shrink-0" />
                      </button>
                      <button
                        data-testid="canvaspro-generation-task-output-rerun"
                        type="button"
                        onClick={() => rerunGenerationTask(selectedGenerationTask, 'same', output)}
                        disabled={!selectedGenerationTaskMutable}
                        className="inline-flex h-6 min-w-0 items-center justify-center rounded-md-v2 bg-Cr-Bg-base-v2 px-1 text-[10px] font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                        title="复用这个结果的任务参数重跑"
                      >
                        <RotateCcw size={10} className="shrink-0" />
                      </button>
                      <button
                        data-testid="canvaspro-generation-task-output-rerun-model"
                        type="button"
                        onClick={() => rerunGenerationTask(selectedGenerationTask, 'model', output)}
                        disabled={!selectedGenerationTaskMutable}
                        className="inline-flex h-6 min-w-0 items-center justify-center rounded-md-v2 bg-Cr-Bg-base-v2 px-1 text-[10px] font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                        title="换一个模型复用参数重跑"
                      >
                        <Paintbrush size={10} className="shrink-0" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {selectedGenerationTaskMissingNode ? (
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  data-testid="canvaspro-generation-task-restore-node"
                  type="button"
                  onClick={restoreSelectedGenerationTaskNode}
                  disabled={!bridgeReady || Boolean(busyAction)}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-inverse-v2 px-2 text-xs font-semibold text-Cr-text-inverse-v2 disabled:opacity-45 active:opacity-80"
                  title="按任务快照恢复画布节点"
                >
                  <RotateCcw size={13} />
                  <span className="truncate">恢复到画布</span>
                </button>
                <button
                  data-testid="canvaspro-generation-task-remove"
                  type="button"
                  onClick={removeSelectedGenerationTask}
                  disabled={!bridgeReady || Boolean(busyAction)}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                  title="从生成队列移除这个任务"
                >
                  <X size={13} />
                  <span className="truncate">移除任务</span>
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    data-testid="canvaspro-generation-task-focus"
                    type="button"
                    onClick={() => focusGenerationTask(selectedGenerationTask)}
                    disabled={!bridgeReady || Boolean(busyAction)}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                    title="定位任务节点"
                  >
                    <Search size={13} />
                    <span className="truncate">定位</span>
                  </button>
                  <button
                    data-testid="canvaspro-generation-task-save"
                    type="button"
                    onClick={updateSelectedGenerationTask}
                    disabled={!selectedGenerationTaskMutable}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-inverse-v2 px-2 text-xs font-semibold text-Cr-text-inverse-v2 disabled:opacity-45 active:opacity-80"
                    title="保存任务描述"
                  >
                    <Save size={13} />
                    <span className="truncate">保存</span>
                  </button>
                  <button
                    data-testid="canvaspro-generation-task-submit"
                    type="button"
                    onClick={submitSelectedGenerationTask}
                    disabled={!selectedGenerationTaskMutable}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-green-500 px-2 text-xs font-semibold text-white disabled:opacity-45 active:opacity-80"
                    title="通过 MyShell Art CLI 提交生成任务"
                  >
                    <Sparkles size={13} />
                    <span className="truncate">CLI 生成</span>
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    data-testid="canvaspro-generation-task-sync"
                    type="button"
                    onClick={syncSelectedGenerationTask}
                    disabled={!selectedGenerationTaskMutable}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                    title="同步外部生成状态并回填结果"
                  >
                    <RefreshCw size={13} />
                    <span className="truncate">同步</span>
                  </button>
                  <button
                    data-testid="canvaspro-generation-task-rerun"
                    type="button"
                    onClick={() => rerunGenerationTask(selectedGenerationTask, 'same')}
                    disabled={!selectedGenerationTaskMutable}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                    title="复用当前任务参数创建重跑分支"
                  >
                    <RotateCcw size={13} />
                    <span className="truncate">重跑</span>
                  </button>
                  <button
                    data-testid="canvaspro-generation-task-rerun-model"
                    type="button"
                    onClick={() => rerunGenerationTask(selectedGenerationTask, 'model')}
                    disabled={!selectedGenerationTaskMutable}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-Bg-surface-default-v2/80 px-2 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                    title="换一个模型复用当前任务参数重跑"
                  >
                    <Paintbrush size={13} />
                    <span className="truncate">换模型</span>
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
        </>
        ) : null}
      </aside>
      <CanvasProQuickCreate
        addMenuOpen={addMenuOpen}
        bridgeReady={bridgeReady}
        busyAction={busyAction}
        createCanvasFlow={createCanvasFlow}
        createCanvasNode={createCanvasNode}
        createCanvasStoryboard={createCanvasStoryboard}
        createCanvasVariants={createCanvasVariants}
        creatingFlow={creatingFlow}
        creatingImage={creatingImage}
        creatingImageFromSelection={creatingImageFromSelection}
        creatingNote={creatingNote}
        creatingNoteFromSelection={creatingNoteFromSelection}
        creatingSelectedFlow={creatingSelectedFlow}
        creatingStoryboard={creatingStoryboard}
        creatingVariants={creatingVariants}
        creatingVideo={creatingVideo}
        creatingVideoFromSelection={creatingVideoFromSelection}
        insertQuickCommand={insertQuickCommand}
        quickCommandIndex={quickCommandIndex}
        quickCommandOpen={quickCommandOpen}
        quickPrompt={quickPrompt}
        quickPromptInputRef={quickPromptInputRef}
        runAddMenuItem={runAddMenuItem}
        setAddMenuOpen={setAddMenuOpen}
        setQuickCommandIndex={setQuickCommandIndex}
        setQuickCommandOpen={setQuickCommandOpen}
        setQuickPrompt={setQuickPrompt}
        submitQuickPrompt={submitQuickPrompt}
        visibleQuickCommands={visibleQuickCommands}
      />
      {notice ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute bottom-[92px] left-1/2 z-[130] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/92 px-4 py-2 text-sm font-semibold text-Cr-text-default-v2 shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-xl"
        >
          {notice}
        </div>
      ) : null}
    </main>
  );
}
