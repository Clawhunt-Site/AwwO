import {
  ArrowLeft,
  Captions,
  CaptionsOff,
  CircleStop,
  Clipboard,
  Columns3,
  Download,
  ExternalLink,
  GitBranch,
  GripVertical,
  Keyboard,
  ListVideo,
  RotateCcw,
  Rows3,
  Save,
  Upload,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react';

import { CANVASPRO_ENTRY } from '../model/canvasProWorkspace';

const TOOLBAR_OFFSET_STORAGE_KEY = 'myshell-studio:canvaspro-toolbar-offset:v1';
const TOOLBAR_LABELS_STORAGE_KEY = 'myshell-studio:canvaspro-toolbar-labels:v1';
const TOOLBAR_ORIENTATION_STORAGE_KEY = 'myshell-studio:canvaspro-toolbar-orientation:v1';
const TOOLBAR_VIEWPORT_MARGIN = 12;

type ToolbarOffset = {
  x: number;
  y: number;
};

type ToolbarOrientation = 'horizontal' | 'vertical';

type ToolbarDragState = {
  baseRect: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>;
  currentOffset: ToolbarOffset;
  pointerId: number;
  startOffset: ToolbarOffset;
  startX: number;
  startY: number;
};

interface CanvasProToolbarProps {
  apiReachable?: boolean | null;
  agentPanelOpen?: boolean;
  backLabel: string;
  bridgeReady: boolean;
  busyAction: string;
  cliAuthDetail: string;
  cliAuthDotClass: string;
  cliAuthLabel: string;
  cliLoginOpen: boolean;
  copySelectedContext: () => void;
  detailsPanelOpen: boolean;
  exportPackage: () => void;
  generationTaskCount: number;
  nodeCount?: number;
  onBack: () => void;
  openShortcuts: () => void;
  openPackageImport: () => void;
  reloadCanvas: () => void;
  cancelSuperClawRun?: () => void;
  refreshSuperClawStatus?: () => void;
  resumeSuperClawRun?: () => void;
  runSuperClawWorkflow?: () => void;
  saveSnapshot: () => void;
  savedLabel: string;
  setCliLoginOpen: Dispatch<SetStateAction<boolean>>;
  setDetailsPanelOpen: Dispatch<SetStateAction<boolean>>;
  showBackButton: boolean;
  statusLabel: string;
  superClawBusy?: boolean;
  superClawError?: string | null;
  superClawRunId?: string;
  superClawRunInFlight?: boolean;
  superClawRunStatus?: string;
  superClawStatusLabel?: string;
  superClawStatusLoading?: boolean;
}

function readStoredToolbarOffset(): ToolbarOffset {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TOOLBAR_OFFSET_STORAGE_KEY) || '{}') as Partial<ToolbarOffset>;
    return {
      x: Number.isFinite(Number(parsed.x)) ? Number(parsed.x) : 0,
      y: Number.isFinite(Number(parsed.y)) ? Number(parsed.y) : 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

function storeToolbarOffset(offset: ToolbarOffset): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOOLBAR_OFFSET_STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // 拖拽位置是体验增强项，存储不可用时不影响工具条功能。
  }
}

function readStoredToolbarOrientation(): ToolbarOrientation {
  if (typeof window === 'undefined') return 'horizontal';
  return window.localStorage.getItem(TOOLBAR_ORIENTATION_STORAGE_KEY) === 'vertical' ? 'vertical' : 'horizontal';
}

function storeToolbarOrientation(orientation: ToolbarOrientation): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOOLBAR_ORIENTATION_STORAGE_KEY, orientation);
  } catch {
    // 工具条方向属于界面偏好，存储失败不影响核心操作。
  }
}

function readStoredToolbarLabelsVisible(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(TOOLBAR_LABELS_STORAGE_KEY) !== 'hidden';
}

function storeToolbarLabelsVisible(visible: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOOLBAR_LABELS_STORAGE_KEY, visible ? 'shown' : 'hidden');
  } catch {
    // 工具条文字密度是界面偏好，存储失败不影响按钮能力。
  }
}

function clampToolbarOffset(
  offset: ToolbarOffset,
  baseRect: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>,
): ToolbarOffset {
  const minX = TOOLBAR_VIEWPORT_MARGIN - baseRect.left;
  const maxX = window.innerWidth - TOOLBAR_VIEWPORT_MARGIN - baseRect.right;
  const minY = TOOLBAR_VIEWPORT_MARGIN - baseRect.top;
  const maxY = window.innerHeight - TOOLBAR_VIEWPORT_MARGIN - baseRect.bottom;
  return {
    x: Math.min(maxX, Math.max(minX, offset.x)),
    y: Math.min(maxY, Math.max(minY, offset.y)),
  };
}

function isToolbarMoved(offset: ToolbarOffset): boolean {
  return Math.abs(offset.x) > 0.5 || Math.abs(offset.y) > 0.5;
}

function formatSuperClawToolbarStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case 'ready':
      return '已连接';
    case 'api-only':
      return 'API 已连';
    case 'default-local':
      return '未连接';
    case 'offline':
      return '未连接';
    case 'checking':
      return '检查中';
    case 'unknown':
      return '未连接';
    case 'created':
    case 'pending':
    case 'queued':
      return '排队中';
    case 'active':
    case 'in_progress':
    case 'running':
    case 'streaming':
      return '运行中';
    case 'needs_approval':
    case 'paused':
    case 'waiting_approval':
      return '待确认';
    case 'complete':
    case 'completed':
    case 'done':
    case 'success':
    case 'succeeded':
      return '已完成';
    case 'cancelled':
    case 'canceled':
      return '已取消';
    case 'failed':
    case 'error':
      return '失败';
    case 'timeout':
    case 'timed_out':
      return '超时';
    default:
      return status.trim() || '状态未知';
  }
}

export function CanvasProToolbar({
  apiReachable,
  agentPanelOpen = false,
  backLabel,
  bridgeReady,
  busyAction,
  cliAuthDetail,
  cliAuthDotClass,
  cliAuthLabel,
  cliLoginOpen,
  copySelectedContext,
  detailsPanelOpen,
  exportPackage,
  generationTaskCount,
  nodeCount,
  onBack,
  openShortcuts,
  openPackageImport,
  reloadCanvas,
  cancelSuperClawRun,
  refreshSuperClawStatus,
  resumeSuperClawRun,
  runSuperClawWorkflow,
  saveSnapshot,
  savedLabel,
  setCliLoginOpen,
  setDetailsPanelOpen,
  showBackButton,
  statusLabel,
  superClawBusy = false,
  superClawError = null,
  superClawRunId = '',
  superClawRunInFlight = false,
  superClawRunStatus = '',
  superClawStatusLabel = 'unknown',
  superClawStatusLoading = false,
}: CanvasProToolbarProps) {
  const disabled = !bridgeReady || Boolean(busyAction);
  const superClawDisabled = disabled || superClawBusy || !runSuperClawWorkflow;
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<ToolbarDragState | null>(null);
  const [toolbarOffset, setToolbarOffset] = useState<ToolbarOffset>(readStoredToolbarOffset);
  const [toolbarLabelsVisible, setToolbarLabelsVisible] = useState(readStoredToolbarLabelsVisible);
  const [toolbarOrientation, setToolbarOrientation] = useState<ToolbarOrientation>(readStoredToolbarOrientation);
  const [toolbarDragging, setToolbarDragging] = useState(false);
  const toolbarMoved = isToolbarMoved(toolbarOffset);
  const toolbarVertical = toolbarOrientation === 'vertical';
  const toolbarVerticalExpanded = toolbarVertical && toolbarLabelsVisible;
  const toolbarVerticalCompact = toolbarVertical && !toolbarLabelsVisible;
  const toolbarPointerEvents = agentPanelOpen && !toolbarMoved ? 'pointer-events-none' : 'pointer-events-auto';
  const separatorClass = toolbarVertical
    ? toolbarVerticalExpanded
      ? 'mx-2 h-px shrink-0 bg-Cr-border-default-v2'
      : 'h-px w-5 shrink-0 self-center bg-Cr-border-default-v2'
    : 'h-5 w-px shrink-0 bg-Cr-border-default-v2';
  const toolbarHandleClass = toolbarVerticalExpanded
    ? 'pointer-events-auto flex h-9 w-full shrink-0 items-center justify-start gap-2 rounded-full-v2 px-3 text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2'
    : 'pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full-v2 text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2';
  const toolbarActionClass = toolbarVerticalExpanded
    ? 'flex h-9 w-full shrink-0 items-center justify-start gap-2 rounded-full-v2 px-3 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2'
    : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2';
  const superClawDotClass = superClawBusy
    ? 'bg-emerald-300 animate-pulse'
    : superClawStatusLabel === 'ready' || superClawStatusLabel === 'api-only'
      ? 'bg-green-400'
      : superClawStatusLoading || superClawStatusLabel === 'checking' || superClawStatusLabel === 'unknown'
        ? 'bg-yellow-300'
        : 'bg-red-400';
  const superClawStatusText = formatSuperClawToolbarStatus(superClawRunStatus || superClawStatusLabel);
  const superClawTitle = superClawError
    ? `SuperClaw: ${superClawError}`
    : superClawRunId
      ? `SuperClaw ${superClawStatusText} · ${superClawRunId}`
      : `SuperClaw ${superClawStatusText}`;
  const toolbarStyle = useMemo<CSSProperties>(
    () => ({
      transform: `translate3d(${toolbarOffset.x}px, ${toolbarOffset.y}px, 0)`,
    }),
    [toolbarOffset.x, toolbarOffset.y],
  );

  const resetToolbarOffset = useCallback(() => {
    const nextOffset = { x: 0, y: 0 };
    setToolbarOffset(nextOffset);
    storeToolbarOffset(nextOffset);
  }, []);

  const toggleToolbarOrientation = useCallback(() => {
    setToolbarOrientation((current) => {
      const next = current === 'horizontal' ? 'vertical' : 'horizontal';
      storeToolbarOrientation(next);
      return next;
    });
  }, []);

  const toggleToolbarLabels = useCallback(() => {
    setToolbarLabelsVisible((current) => {
      const next = !current;
      storeToolbarLabelsVisible(next);
      return next;
    });
  }, []);

  const startToolbarDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const toolbar = toolbarRef.current;
      if (!toolbar) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = toolbar.getBoundingClientRect();
      const baseRect = {
        bottom: rect.bottom - toolbarOffset.y,
        left: rect.left - toolbarOffset.x,
        right: rect.right - toolbarOffset.x,
        top: rect.top - toolbarOffset.y,
      };
      const currentOffset = clampToolbarOffset(toolbarOffset, baseRect);
      dragStateRef.current = {
        baseRect,
        currentOffset,
        pointerId: event.pointerId,
        startOffset: currentOffset,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setToolbarDragging(true);
      setToolbarOffset(currentOffset);
    },
    [toolbarOffset],
  );

  const moveToolbar = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const nextOffset = clampToolbarOffset(
      {
        x: dragState.startOffset.x + event.clientX - dragState.startX,
        y: dragState.startOffset.y + event.clientY - dragState.startY,
      },
      dragState.baseRect,
    );
    dragState.currentOffset = nextOffset;
    setToolbarOffset(nextOffset);
  }, []);

  const stopToolbarDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setToolbarDragging(false);
    storeToolbarOffset(dragState.currentOffset);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const toolbar = toolbarRef.current;
      if (!toolbar) return;
      const rect = toolbar.getBoundingClientRect();
      setToolbarOffset((current) => {
        const baseRect = {
          bottom: rect.bottom - current.y,
          left: rect.left - current.x,
          right: rect.right - current.x,
          top: rect.top - current.y,
        };
        const nextOffset = clampToolbarOffset(current, baseRect);
        storeToolbarOffset(nextOffset);
        return nextOffset;
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const rect = toolbar.getBoundingClientRect();
    setToolbarOffset((current) => {
      const baseRect = {
        bottom: rect.bottom - current.y,
        left: rect.left - current.x,
        right: rect.right - current.x,
        top: rect.top - current.y,
      };
      const nextOffset = clampToolbarOffset(current, baseRect);
      storeToolbarOffset(nextOffset);
      return nextOffset;
    });
  }, [toolbarLabelsVisible, toolbarOrientation]);

  return (
    <div className="pointer-events-none absolute left-3 right-3 top-3 z-[130] flex items-center justify-between">
      {showBackButton ? (
        <button
          type="button"
          onClick={onBack}
          className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/90 px-3 text-sm font-semibold text-Cr-text-default-v2 shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-xl active:bg-Cr-beta-white-8-v2"
          aria-label="Back to Studio workspace"
          title="Back to Studio workspace"
        >
          <ArrowLeft size={16} />
          <span>{backLabel}</span>
        </button>
      ) : (
        <div />
      )}
      <div
        ref={toolbarRef}
        style={toolbarStyle}
        className={`flex border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/90 p-1 shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-xl ${toolbarPointerEvents} ${
          toolbarVertical
            ? toolbarVerticalExpanded
              ? 'max-h-[calc(100vh-24px)] w-48 max-w-[calc(100vw-24px)] flex-col items-stretch gap-1.5 overflow-y-auto rounded-[22px] p-1.5'
              : 'max-h-[calc(100vh-24px)] w-12 flex-col items-center gap-1 overflow-y-auto rounded-full-v2'
            : 'max-w-[calc(100vw-108px)] items-center gap-2 overflow-x-auto rounded-full-v2'
        } ${toolbarDragging ? 'select-none' : ''}`}
      >
        <button
          type="button"
          onPointerDown={startToolbarDrag}
          onPointerMove={moveToolbar}
          onPointerUp={stopToolbarDrag}
          onPointerCancel={stopToolbarDrag}
          onDoubleClick={resetToolbarOffset}
          className={`${toolbarHandleClass} ${toolbarDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          aria-label="Drag CanvasPro toolbar"
          title="拖动工具条，双击归位"
        >
          <GripVertical size={16} />
          {toolbarVerticalExpanded ? <span className="whitespace-nowrap">拖动</span> : null}
        </button>
        <button
          type="button"
          onClick={toggleToolbarOrientation}
          className={toolbarActionClass}
          aria-label={toolbarVertical ? 'Switch CanvasPro toolbar to horizontal layout' : 'Switch CanvasPro toolbar to vertical layout'}
          title={toolbarVertical ? '切换为横向工具条' : '切换为竖向工具条'}
        >
          {toolbarVertical ? <Rows3 size={16} /> : <Columns3 size={16} />}
          {toolbarVerticalExpanded ? <span className="whitespace-nowrap">横向</span> : null}
        </button>
        {toolbarVertical ? (
          <button
            type="button"
            onClick={toggleToolbarLabels}
            className={toolbarActionClass}
            aria-label={toolbarLabelsVisible ? 'Hide CanvasPro toolbar labels' : 'Show CanvasPro toolbar labels'}
            title={toolbarLabelsVisible ? '隐藏竖条文字' : '显示竖条文字'}
          >
            {toolbarLabelsVisible ? <CaptionsOff size={16} /> : <Captions size={16} />}
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">隐藏文字</span> : null}
          </button>
        ) : null}
        <div className={separatorClass} />
        <div className={`contents ${toolbarPointerEvents}`}>
          <div
            data-testid="canvaspro-bridge-status"
            className={`shrink-0 items-center rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 text-xs font-semibold text-Cr-text-subtler-v2 ${
              toolbarVerticalExpanded
                ? 'flex h-9 w-full justify-start gap-2 px-3'
                : toolbarVerticalCompact
                  ? 'flex h-9 w-9 justify-center'
                  : 'hidden h-9 gap-2 px-3 sm:inline-flex'
            }`}
            title={savedLabel ? `最近离线快照 ${savedLabel}` : statusLabel}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                bridgeReady
                  ? apiReachable === false
                    ? 'bg-yellow-400'
                    : 'bg-green-400'
                : 'bg-Cr-text-disabled-v2'
              }`}
            />
            <span
              className={
                toolbarVerticalExpanded ? 'min-w-0 flex-1 truncate' : toolbarVerticalCompact ? 'sr-only' : 'whitespace-nowrap'
              }
            >
              {statusLabel}
            </span>
            {typeof nodeCount === 'number' ? (
              <span
                className={
                  toolbarVerticalExpanded
                    ? 'shrink-0 whitespace-nowrap text-Cr-text-disabled-v2'
                    : toolbarVerticalCompact
                      ? 'sr-only'
                      : 'whitespace-nowrap text-Cr-text-disabled-v2'
                }
              >
                {nodeCount} nodes
              </span>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="canvaspro-cli-auth-status"
            onClick={() => {
              setDetailsPanelOpen(() => false);
              setCliLoginOpen((value) => !value);
            }}
            className={`inline-flex h-9 shrink-0 items-center rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 text-xs font-semibold text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2 ${
              toolbarVerticalExpanded ? 'w-full justify-start gap-2 px-3' : toolbarVerticalCompact ? 'w-9 justify-center' : 'gap-2 px-3'
            }`}
            title={cliAuthDetail}
            aria-pressed={cliLoginOpen}
            aria-label="MyShell CLI auth status"
          >
            <span className={`h-2 w-2 rounded-full ${cliAuthDotClass}`} />
            <span className={toolbarVerticalExpanded ? 'min-w-0 flex-1 truncate' : toolbarVerticalCompact ? 'sr-only' : 'whitespace-nowrap'}>
              {cliAuthLabel}
            </span>
          </button>
          {runSuperClawWorkflow ? (
            <>
              <button
                type="button"
                onClick={refreshSuperClawStatus}
                className={`inline-flex h-9 shrink-0 items-center rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 text-xs font-semibold text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2 ${
                  toolbarVerticalExpanded
                    ? 'w-full justify-start gap-2 px-3'
                    : toolbarVerticalCompact
                      ? 'w-9 justify-center'
                      : 'gap-2 px-3'
                }`}
                title={superClawTitle}
                aria-label="Refresh SuperClaw status"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${superClawDotClass}`} />
                <span
                  className={
                    toolbarVerticalExpanded
                      ? 'min-w-0 flex-1 truncate'
                      : toolbarVerticalCompact
                        ? 'sr-only'
                        : 'hidden whitespace-nowrap lg:inline'
                  }
                >
                  SuperClaw {superClawStatusText}
                </span>
              </button>
              <button
                type="button"
                onClick={runSuperClawWorkflow}
                disabled={superClawDisabled}
                className={toolbarActionClass}
                aria-label="Run current CanvasPro canvas with SuperClaw"
                title="交给 SuperClaw 运行当前画布"
              >
                <GitBranch size={16} />
                {toolbarVerticalExpanded ? <span className="whitespace-nowrap">SuperClaw</span> : null}
              </button>
              {superClawRunInFlight && cancelSuperClawRun ? (
                <button
                  type="button"
                  onClick={cancelSuperClawRun}
                  className={toolbarActionClass}
                  aria-label="Cancel SuperClaw run"
                  title="取消 SuperClaw 运行"
                >
                  <CircleStop size={16} />
                  {toolbarVerticalExpanded ? <span className="whitespace-nowrap">取消运行</span> : null}
                </button>
              ) : superClawRunId && resumeSuperClawRun ? (
                <button
                  type="button"
                  onClick={resumeSuperClawRun}
                  className={toolbarActionClass}
                  aria-label="Resume SuperClaw run"
                  title="继续 SuperClaw 运行"
                >
                  <RotateCcw size={16} />
                  {toolbarVerticalExpanded ? <span className="whitespace-nowrap">继续运行</span> : null}
                </button>
              ) : null}
            </>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setCliLoginOpen(() => false);
              setDetailsPanelOpen((value) => !value);
            }}
            className={`inline-flex h-9 shrink-0 items-center rounded-full-v2 text-xs font-semibold text-Cr-text-default-v2 active:bg-Cr-beta-white-8-v2 ${
              toolbarVerticalExpanded
                ? 'w-full justify-start gap-2 px-3'
                : toolbarVerticalCompact
                  ? 'relative w-9 justify-center'
                  : 'gap-2 px-3'
            }`}
            title="打开生成队列和任务参数"
            aria-pressed={detailsPanelOpen}
            aria-label="Open CanvasPro generation queue"
          >
            <ListVideo size={15} />
            <span
              className={
                toolbarVerticalExpanded
                  ? 'whitespace-nowrap'
                  : toolbarVerticalCompact
                    ? 'absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-Cr-Bg-soft-v2 px-1 text-center text-[9px] leading-4 text-Cr-text-subtler-v2'
                    : 'hidden whitespace-nowrap sm:inline'
              }
            >
              {toolbarVerticalExpanded ? `任务 ${generationTaskCount || 0}` : generationTaskCount || 0}
            </span>
          </button>
          <button
            type="button"
            onClick={saveSnapshot}
            disabled={disabled}
            className={toolbarActionClass}
            aria-label="Save offline snapshot"
            title="保存离线快照"
          >
            <Save size={16} />
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">保存</span> : null}
          </button>
          <button
            type="button"
            onClick={exportPackage}
            disabled={disabled}
            className={toolbarActionClass}
            aria-label="Export CanvasPro package"
            title="导出项目包"
          >
            <Download size={16} />
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">导出</span> : null}
          </button>
          <button
            type="button"
            onClick={openPackageImport}
            disabled={disabled}
            className={toolbarActionClass}
            aria-label="Import CanvasPro package"
            title="导入项目包或 JSON"
          >
            <Upload size={16} />
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">导入</span> : null}
          </button>
          <button
            type="button"
            onClick={copySelectedContext}
            disabled={disabled}
            className={toolbarActionClass}
            aria-label="Copy selected nodes context"
            title="复制选中节点上下文"
          >
            <Clipboard size={16} />
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">复制上下文</span> : null}
          </button>
          <button
            type="button"
            onClick={openShortcuts}
            disabled={disabled}
            className={toolbarActionClass}
            aria-label="Open CanvasPro shortcuts"
            title="打开快捷键设置"
          >
            <Keyboard size={16} />
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">快捷键</span> : null}
          </button>
          <div className={separatorClass} />
          <button
            type="button"
            onClick={reloadCanvas}
            className={toolbarActionClass}
            aria-label="Reload AI CanvasPro"
            title="Reload AI CanvasPro"
          >
            <RotateCcw size={16} />
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">刷新</span> : null}
          </button>
          <a
            href={CANVASPRO_ENTRY}
            target="_blank"
            rel="noreferrer"
            className={toolbarActionClass}
            aria-label="Open AI CanvasPro in a new tab"
            title="Open AI CanvasPro in a new tab"
          >
            <ExternalLink size={16} />
            {toolbarVerticalExpanded ? <span className="whitespace-nowrap">新窗口</span> : null}
          </a>
        </div>
      </div>
    </div>
  );
}
