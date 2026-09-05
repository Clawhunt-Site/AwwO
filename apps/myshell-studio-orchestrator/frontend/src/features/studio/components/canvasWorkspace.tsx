import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import {
  Activity,
  Bot,
  CircleStop,
  Copy,
  Download,
  Film,
  GitBranch,
  Hand,
  ImagePlus,
  Link2,
  MousePointer2,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { StudioAction, StudioProject, StudioSegment, SuperClawCanvasRunRequest, SuperClawRunEvent } from '../api';
import { useSuperClawCanvasController } from '../hooks/useSuperClawCanvasController';
import {
  AI_CANVAS_NODE_LIBRARY,
  CANVAS_COMMAND_PRESETS,
  CANVAS_FLOW_PRESETS,
  DEFAULT_DREAMY_SLUG,
  DREAMY_STARTER_PRESETS,
  buildCanvasGraph,
  clamp,
  downloadJsonText,
  getCanvasDefaultBoard,
  getCanvasNodeIcon,
  getCanvasNodeLibraryItem,
  getCanvasNodeMediaMode,
  getInitialCanvasView,
  getStarterPresetAction,
  getTimelineDisplaySegments,
  makeId,
  normalizeCanvasNodeKind,
  statusTone,
} from '../model/dreamyWorkspace';
import type {
  CanvasBoardId,
  CanvasConnection,
  CanvasContextMenuState,
  CanvasFlowPreset,
  CanvasNode,
  CanvasNodeKind,
  CanvasSnapshot,
  CanvasSourceType,
  CanvasTool,
  StudioStarterPreset,
} from '../model/dreamyWorkspace';
import {
  CanvasBotCatalogModal,
  CanvasInputsDrawer,
  CanvasInspectorDrawer,
} from './canvasSidePanels';

function superClawEventText(event: SuperClawRunEvent): string {
  const message = event.message || event.detail || event.type || event.event || 'SuperClaw event';
  return String(message);
}

export function CanvasWorkspace({
  project,
  selectedSegment,
  selectedStarterPreset,
  allBotPresets,
  onSelectSegment,
  onDeleteSegment,
  onAction,
  onRunPreset,
  submitting,
}: {
  project: StudioProject | null;
  selectedSegment?: StudioSegment | null;
  selectedStarterPreset?: StudioStarterPreset | null;
  allBotPresets?: StudioStarterPreset[];
  onSelectSegment: (segmentId: string) => void;
  onDeleteSegment: (segmentId: string) => void;
  onAction: (action: StudioAction, prompt?: string, source?: StudioSegment | null) => void;
  onRunPreset?: (preset: StudioStarterPreset) => void;
  submitting: boolean;
}) {
  const canvasSurfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasFileInputRef = useRef<HTMLInputElement | null>(null);
  const [tool, setTool] = useState<CanvasTool>('select');
  const [initialView] = useState(getInitialCanvasView);
  const [zoom, setZoom] = useState(initialView.zoom);
  const [pan, setPan] = useState(initialView.pan);
  const [activeBoardId, setActiveBoardId] = useState<CanvasBoardId>('timeline');
  const [activeFlowPresetId, setActiveFlowPresetId] = useState(CANVAS_FLOW_PRESETS[0]?.id || '');
  const [selectedNodeId, setSelectedNodeId] = useState(CANVAS_FLOW_PRESETS[0]?.nodes[0]?.id || 'prompt-root');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([CANVAS_FLOW_PRESETS[0]?.nodes[0]?.id || 'prompt-root']);
  const [canvasAction, setCanvasAction] = useState<StudioAction>('generate');
  const [canvasCommand, setCanvasCommand] = useState('');
  const [positionOverrides, setPositionOverrides] = useState<Record<string, { x: number; y: number }>>({});
  const [customNodes, setCustomNodes] = useState<CanvasNode[]>(() => CANVAS_FLOW_PRESETS[0]?.nodes.map((node) => ({ ...node })) || []);
  const [customConnections, setCustomConnections] = useState<CanvasConnection[]>(
    () => CANVAS_FLOW_PRESETS[0]?.connections.map((connection) => ({ ...connection })) || [],
  );
  const [history, setHistory] = useState<CanvasSnapshot[]>([]);
  const [future, setFuture] = useState<CanvasSnapshot[]>([]);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [connectFromNodeId, setConnectFromNodeId] = useState<string | null>(null);
  const [isDropActive, setIsDropActive] = useState(false);
  const [spacePanning, setSpacePanning] = useState(false);
  const [showBotCatalog, setShowBotCatalog] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragState, setDragState] = useState<{
    id: string;
    clientX: number;
    clientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [panState, setPanState] = useState<{
    clientX: number;
    clientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const {
    statusLabel: superClawStatusLabel,
    activeRunId: superClawRunId,
    activeRunStatus: superClawRunStatus,
    activeRunEvents: superClawRunEvents,
    lastResult: superClawLastResult,
    submitting: superClawSubmitting,
    activeRunInFlight: superClawRunInFlight,
    busy: superClawBusy,
    error: superClawError,
    runCanvas: runSuperClawCanvas,
    cancelActiveRun: cancelSuperClawRun,
    resumeActiveRun: resumeSuperClawRun,
    refreshStatus: refreshSuperClawStatus,
  } = useSuperClawCanvasController();

  const baseCanvas = useMemo(() => buildCanvasGraph(project, positionOverrides), [positionOverrides, project]);
  const selectedStarterNode = useMemo<CanvasNode | null>(() => {
    if (!selectedStarterPreset) return null;
    return {
      id: `selected-dreamy-bot-${selectedStarterPreset.id}`,
      kind: 'agent',
      title: `Selected Bot · ${selectedStarterPreset.title}`,
      subtitle: selectedStarterPreset.recommendation,
      x: 154,
      y: 52,
      width: 264,
      height: 138,
      status: 'ready',
      action: getStarterPresetAction(selectedStarterPreset, selectedSegment),
      prompt: selectedStarterPreset.prompt,
      botSlug: selectedStarterPreset.botSlug,
      botName: selectedStarterPreset.title,
      mediaUrl: selectedStarterPreset.visualUrl,
    };
  }, [selectedSegment, selectedStarterPreset]);
  const nodes = useMemo(
    () => (selectedStarterNode ? [selectedStarterNode, ...baseCanvas.nodes, ...customNodes] : [...baseCanvas.nodes, ...customNodes]),
    [baseCanvas.nodes, customNodes, selectedStarterNode],
  );
  const connections = useMemo(
    () => (
      selectedStarterNode
        ? [
            { id: `${selectedStarterNode.id}-to-prompt-root`, from: selectedStarterNode.id, to: 'prompt-root', label: 'selected bot' },
            ...baseCanvas.connections,
            ...customConnections,
          ]
        : [...baseCanvas.connections, ...customConnections]
    ),
    [baseCanvas.connections, customConnections, selectedStarterNode],
  );
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = nodeMap.get(selectedNodeId) || nodes[0] || null;
  const displaySegments = useMemo(() => getTimelineDisplaySegments(project?.segments || []), [project?.segments]);
  const selectedNodeSegment = selectedNode?.segmentId
    ? displaySegments.find((segment) => segment.id === selectedNode.segmentId) || null
    : selectedSegment || null;
  const isCustomSelected = Boolean(selectedNode && customNodes.some((node) => node.id === selectedNode.id));
  const activeFlowPreset = CANVAS_FLOW_PRESETS.find((preset) => preset.id === activeFlowPresetId) || CANVAS_FLOW_PRESETS[0];
  const activeSelectedNodeIds = selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
  const superClawContextNodeIds = useMemo(() => {
    const ids = new Set<string>();
    superClawLastResult?.context.selectedNodeIds?.forEach((id) => ids.add(id));
    if (superClawLastResult?.context.selectedNodeId) ids.add(superClawLastResult.context.selectedNodeId);
    return ids;
  }, [superClawLastResult]);
  const latestSuperClawEvents = superClawRunEvents.slice(-3).reverse();
  const superClawStatusTone =
    superClawStatusLabel === 'ready'
      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
      : superClawStatusLabel === 'api-only'
        ? 'border-amber-300/30 bg-amber-300/10 text-amber-100'
        : 'border-white/10 bg-white/[0.06] text-Cr-text-subtler-v2';
  const superClawFlowStatus = superClawSubmitting ? 'submitting' : superClawRunStatus || (superClawRunId ? 'running' : '');
  const boardNodes = useMemo(
    () => nodes.filter((node) => (node.boardId || getCanvasDefaultBoard(node.kind)) === activeBoardId),
    [activeBoardId, nodes],
  );
  const canUndo = history.length > 0;
  const canRedo = future.length > 0;
  const canvasBotCatalogPresets = allBotPresets?.length ? allBotPresets : DREAMY_STARTER_PRESETS;

  const createCanvasSnapshot = useCallback<() => CanvasSnapshot>(
    () => ({
      customNodes: customNodes.map((node) => ({ ...node })),
      customConnections: customConnections.map((connection) => ({ ...connection })),
      positionOverrides: { ...positionOverrides },
    }),
    [customConnections, customNodes, positionOverrides],
  );

  const restoreCanvasSnapshot = useCallback((snapshot: CanvasSnapshot) => {
    setCustomNodes(snapshot.customNodes.map((node) => ({ ...node })));
    setCustomConnections(snapshot.customConnections.map((connection) => ({ ...connection })));
    setPositionOverrides({ ...snapshot.positionOverrides });
  }, []);

  const commitCanvasSnapshot = useCallback(() => {
    const snapshot = createCanvasSnapshot();
    setHistory((prev) => [...prev.slice(-29), snapshot]);
    setFuture([]);
  }, [createCanvasSnapshot]);

  const undoCanvas = useCallback(() => {
    setHistory((prev) => {
      const snapshot = prev[prev.length - 1];
      if (!snapshot) return prev;
      setFuture((next) => [createCanvasSnapshot(), ...next].slice(0, 30));
      restoreCanvasSnapshot(snapshot);
      return prev.slice(0, -1);
    });
  }, [createCanvasSnapshot, restoreCanvasSnapshot]);

  const redoCanvas = useCallback(() => {
    setFuture((prev) => {
      const snapshot = prev[0];
      if (!snapshot) return prev;
      setHistory((next) => [...next.slice(-29), createCanvasSnapshot()]);
      restoreCanvasSnapshot(snapshot);
      return prev.slice(1);
    });
  }, [createCanvasSnapshot, restoreCanvasSnapshot]);

  const getCanvasPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasSurfaceRef.current?.getBoundingClientRect();
      if (!rect) return { x: 480, y: 260 };
      return {
        x: Math.round((clientX - rect.left - pan.x) / zoom),
        y: Math.round((clientY - rect.top - pan.y) / zoom),
      };
    },
    [pan.x, pan.y, zoom],
  );

  useEffect(() => {
    if (nodes.length && !nodes.some((node) => node.id === selectedNodeId)) {
      const nextId = selectedSegment?.id ? `segment-${selectedSegment.id}` : nodes[0].id;
      const resolvedId = nodes.some((node) => node.id === nextId) ? nextId : nodes[0].id;
      setSelectedNodeId(resolvedId);
      setSelectedNodeIds([resolvedId]);
    }
  }, [nodes, selectedNodeId, selectedSegment?.id]);

  useEffect(() => {
    if (!selectedStarterNode) return;
    setSelectedNodeId(selectedStarterNode.id);
    setSelectedNodeIds([selectedStarterNode.id]);
    setCanvasAction(selectedStarterNode.action || 'generate');
    setCanvasCommand(selectedStarterNode.prompt || '');
  }, [selectedStarterNode?.id]);

  useEffect(() => {
    if (!selectedNode) return;
    setCanvasAction(selectedNode.action || (selectedNode.kind === 'segment' ? 'extend' : 'generate'));
    setCanvasCommand(selectedNode.prompt || '');
  }, [selectedNode?.id]);

  const selectCanvasNode = useCallback(
    (node: CanvasNode, additive = false) => {
      setSelectedNodeId(node.id);
      setSelectedNodeIds((prev) => {
        if (!additive) return [node.id];
        if (prev.includes(node.id)) {
          const next = prev.filter((id) => id !== node.id);
          return next.length ? next : [node.id];
        }
        return [...prev, node.id];
      });
      if (node.segmentId) onSelectSegment(node.segmentId);
    },
    [onSelectSegment],
  );

  const applyNodePosition = useCallback(
    (id: string, x: number, y: number) => {
      if (customNodes.some((node) => node.id === id)) {
        setCustomNodes((prev) => prev.map((node) => (node.id === id ? { ...node, x, y } : node)));
        return;
      }
      setPositionOverrides((prev) => ({ ...prev, [id]: { x, y } }));
    },
    [customNodes],
  );

  useEffect(() => {
    if (!dragState && !panState) return;

    const handleMove = (event: PointerEvent) => {
      if (dragState) {
        const x = dragState.originX + (event.clientX - dragState.clientX) / zoom;
        const y = dragState.originY + (event.clientY - dragState.clientY) / zoom;
        applyNodePosition(dragState.id, Math.round(x), Math.round(y));
      }
      if (panState) {
        setPan({
          x: panState.originX + event.clientX - panState.clientX,
          y: panState.originY + event.clientY - panState.clientY,
        });
      }
    };

    const handleUp = () => {
      setDragState(null);
      setPanState(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = dragState ? 'grabbing' : 'grab';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [applyNodePosition, dragState, panState, zoom]);

  const connectCanvasNodes = useCallback(
    (fromId: string, toId: string, label = 'route') => {
      if (!fromId || !toId || fromId === toId) return;
      if (connections.some((connection) => connection.from === fromId && connection.to === toId)) {
        setConnectFromNodeId(null);
        setTool('select');
        return;
      }
      commitCanvasSnapshot();
      setCustomConnections((prev) => [
        ...prev,
        {
          id: `${fromId}-to-${toId}-${Date.now()}`,
          from: fromId,
          to: toId,
          label,
          sourceHandle: 'out',
          targetHandle: 'in',
        },
      ]);
      setConnectFromNodeId(null);
      setTool('select');
    },
    [commitCanvasSnapshot, connections],
  );

  const addCanvasNode = useCallback(
    (
      kind: CanvasNodeKind,
      point?: { x: number; y: number },
      options: { linkFromSelected?: boolean; overrides?: Partial<CanvasNode> } = {},
    ) => {
      const anchor = selectedNode || nodes[nodes.length - 1];
      const libraryItem = getCanvasNodeLibraryItem(kind);
      const sourceType = options.overrides?.sourceType || libraryItem?.sourceType || getCanvasNodeMediaMode(kind);
      const id = options.overrides?.id || makeId(`canvas_${kind.replace(/[^a-z0-9]+/gi, '_')}`);
      const x = point?.x ?? (anchor?.x || 480) + 270;
      const y = point?.y ?? (anchor?.y || 180) + (kind === 'agent' || kind.startsWith('ai-') ? 26 : 132);
      const node: CanvasNode = {
        id,
        kind,
        title: options.overrides?.title || libraryItem?.title || (kind === 'segment' ? 'Draft Segment' : 'Custom Agent'),
        subtitle:
          options.overrides?.subtitle ||
          libraryItem?.subtitle ||
          (kind === 'segment' ? 'Staged media slot' : 'Manual chain step'),
        x,
        y,
        width: options.overrides?.width || libraryItem?.width || (kind === 'agent' ? 228 : 252),
        height: options.overrides?.height || libraryItem?.height || (kind === 'agent' ? 104 : 122),
        status: options.overrides?.status || 'idle',
        action:
          options.overrides?.action ||
          libraryItem?.action ||
          (kind === 'segment' ? 'generate' : kind === 'ai-video' ? 'extend' : undefined),
        prompt: (options.overrides?.prompt ?? canvasCommand) || anchor?.prompt || '',
        botName:
          options.overrides?.botName ||
          (kind === 'agent'
            ? 'Unassigned agent'
            : kind === 'ai-video'
              ? '3D Futa Porn'
              : kind === 'ai-image'
                ? '3D Anime Porn'
                : 'Dreamy canvas'),
        botSlug: options.overrides?.botSlug || libraryItem?.botSlug || (kind === 'agent' ? 'manual-agent' : DEFAULT_DREAMY_SLUG),
        sourceType,
        fileName: options.overrides?.fileName,
        mediaUrl: options.overrides?.mediaUrl,
        outputText: options.overrides?.outputText,
        boardId: options.overrides?.boardId || activeBoardId || getCanvasDefaultBoard(kind),
      };
      commitCanvasSnapshot();
      setCustomNodes((prev) => [...prev, node]);
      if (anchor && options.linkFromSelected !== false) {
        const label = kind.startsWith('source-') ? 'source' : kind.startsWith('ai-') ? 'input' : 'manual';
        setCustomConnections((prev) => [
          ...prev,
          { id: `${anchor.id}-to-${id}`, from: anchor.id, to: id, label, sourceHandle: 'out', targetHandle: 'in' },
        ]);
      }
      setSelectedNodeId(id);
      setSelectedNodeIds([id]);
      setContextMenu(null);
    },
    [activeBoardId, canvasCommand, commitCanvasSnapshot, nodes, selectedNode],
  );

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: CanvasNode) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    if (tool === 'connect') {
      if (connectFromNodeId && connectFromNodeId !== node.id) {
        connectCanvasNodes(connectFromNodeId, node.id);
      } else {
        setConnectFromNodeId(node.id);
      }
      selectCanvasNode(node, event.shiftKey);
      return;
    }
    if (tool !== 'select') return;
    selectCanvasNode(node, event.shiftKey);
    commitCanvasSnapshot();
    setDragState({
      id: node.id,
      clientX: event.clientX,
      clientY: event.clientY,
      originX: node.x,
      originY: node.y,
    });
  };

  const handleSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    setContextMenu(null);
    if (tool === 'connect') {
      setConnectFromNodeId(null);
      return;
    }
    if (tool !== 'pan' && event.button !== 1 && !spacePanning) return;
    event.preventDefault();
    setPanState({
      clientX: event.clientX,
      clientY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    });
  };

  const applyFlowPreset = (preset: CanvasFlowPreset) => {
    commitCanvasSnapshot();
    setActiveFlowPresetId(preset.id);
    setCustomNodes(preset.nodes.map((node) => ({ ...node })));
    setCustomConnections(preset.connections.map((connection) => ({ ...connection })));
    setCanvasAction(preset.action);
    setCanvasCommand(preset.prompt);
    setSelectedNodeId(preset.nodes[0]?.id || 'prompt-root');
    setSelectedNodeIds([preset.nodes[0]?.id || 'prompt-root']);
    setPositionOverrides({});
  };

  const duplicateSelected = () => {
    if (!selectedNode) return;
    commitCanvasSnapshot();
    const id = makeId(`copy_${selectedNode.kind}`);
    const copy: CanvasNode = {
      ...selectedNode,
      id,
      title: `${selectedNode.title} copy`,
      x: selectedNode.x + 36,
      y: selectedNode.y + 36,
      segmentId: undefined,
      agentId: undefined,
      status: 'idle',
    };
    setCustomNodes((prev) => [...prev, copy]);
    setCustomConnections((prev) => [...prev, { id: `${selectedNode.id}-to-${id}`, from: selectedNode.id, to: id, label: 'copy' }]);
    setSelectedNodeId(id);
    setSelectedNodeIds([id]);
  };

  const deleteSelected = () => {
    if (!selectedNode || selectedNode.id === 'prompt-root' || selectedNode.id === 'timeline-output') return;
    const protectedIds = new Set(['prompt-root', 'timeline-output', selectedStarterNode?.id].filter(Boolean) as string[]);
    const idsToDelete = (activeSelectedNodeIds.length ? activeSelectedNodeIds : [selectedNode.id]).filter((id) => !protectedIds.has(id));
    if (!idsToDelete.length) return;
    commitCanvasSnapshot();
    idsToDelete.forEach((id) => {
      const node = nodeMap.get(id);
      if (node?.segmentId && !customNodes.some((customNode) => customNode.id === id)) {
        onDeleteSegment(node.segmentId);
      }
    });
    setCustomNodes((prev) => prev.filter((node) => !idsToDelete.includes(node.id)));
    setCustomConnections((prev) => prev.filter((connection) => !idsToDelete.includes(connection.from) && !idsToDelete.includes(connection.to)));
    setSelectedNodeId('prompt-root');
    setSelectedNodeIds(['prompt-root']);
  };

  const resolveCanvasCommand = useCallback(
    (value: string) => {
      const withoutSlashPreset = value.replace(/^\/[a-z-]+\s*/i, '');
      return withoutSlashPreset.replace(/@([a-zA-Z0-9:_-]+)/g, (_match, id: string) => {
        const node = nodeMap.get(id);
        if (!node) return `@${id}`;
        return [node.title, node.prompt || node.outputText || node.subtitle].filter(Boolean).join(': ');
      });
    },
    [nodeMap],
  );

  const resolveSelectedPrompt = useCallback(() => {
    return resolveCanvasCommand(canvasCommand.trim()) || selectedNode?.prompt || `Run ${selectedNode?.title || 'selected node'}`;
  }, [canvasCommand, resolveCanvasCommand, selectedNode?.prompt, selectedNode?.title]);

  const buildSuperClawCanvasPayload = useCallback((): SuperClawCanvasRunRequest => {
    const selectedIds = selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
    return {
      projectId: project?.projectId || null,
      action: canvasAction,
      prompt: resolveSelectedPrompt(),
      selectedNodeId,
      selectedNodeIds: selectedIds,
      viewport: { zoom, pan },
      nodes: nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        title: node.title,
        subtitle: node.subtitle,
        status: node.status,
        action: node.action,
        prompt: node.prompt,
        segmentId: node.segmentId,
        agentId: node.agentId,
        outputText: node.outputText,
        botSlug: node.botSlug,
        botName: node.botName,
        sourceType: node.sourceType,
        fileName: node.fileName,
        mediaUrl: node.mediaUrl,
        boardId: node.boardId,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      })),
      connections: connections.map((connection) => ({
        id: connection.id,
        from: connection.from,
        to: connection.to,
        label: connection.label,
      })),
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
  }, [canvasAction, connections, nodes, pan, project?.projectId, resolveSelectedPrompt, selectedNodeId, selectedNodeIds, zoom]);

  const runSelected = () => {
    if (selectedStarterPreset && selectedNode?.id === selectedStarterNode?.id) {
      onRunPreset?.(selectedStarterPreset);
      return;
    }
    onAction(canvasAction, resolveSelectedPrompt(), selectedNodeSegment);
  };

  const runSelectedWithSuperClaw = () => {
    void runSuperClawCanvas(buildSuperClawCanvasPayload());
  };

  const canvasStateJson = () =>
    JSON.stringify(
      {
        projectId: project?.projectId || null,
        selectedNodeId,
        viewport: { zoom, pan },
        nodes,
        connections,
      },
      null,
      2,
    );

  const copyJson = async () => {
    await navigator.clipboard?.writeText(canvasStateJson()).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const downloadJson = () => {
    downloadJsonText(canvasStateJson(), `${project?.projectId || 'dreamy-canvas'}.json`);
  };

  const resetView = () => {
    const nextView = getInitialCanvasView();
    setZoom(nextView.zoom);
    setPan(nextView.pan);
  };

  const commandTail = canvasCommand.trimEnd();
  const showReferenceMenu = commandTail.endsWith('@');
  const showPresetMenu = commandTail.endsWith('/');
  const referenceNodes = nodes.filter((node) => node.id !== selectedNode?.id).slice(0, 6);
  const insertCanvasCommandToken = (token: string) => {
    setCanvasCommand((prev) => {
      const trimmed = prev.trimEnd();
      const withoutTrigger = trimmed.endsWith('@') || trimmed.endsWith('/') ? trimmed.slice(0, -1).trimEnd() : trimmed;
      return `${withoutTrigger}${withoutTrigger ? ' ' : ''}${token} `;
    });
  };

  const importCanvasState = useCallback(
    (rawJson: string, point?: { x: number; y: number }) => {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const readRecord = (value: unknown): Record<string, unknown> =>
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const readArrayOrObject = (value: unknown): Record<string, unknown>[] => {
        if (Array.isArray(value)) return value.map(readRecord);
        if (value && typeof value === 'object') {
          return Object.entries(value as Record<string, unknown>).map(([id, item]) => ({ id, ...readRecord(item) }));
        }
        return [];
      };
      const numeric = (value: unknown, fallback: number) => {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
      };

      const rawNodes = readArrayOrObject(parsed.customNodes || parsed.nodes);
      const rawConnections = readArrayOrObject(parsed.customConnections || parsed.connections || parsed.edges);
      const basePoint = point || getCanvasPoint((canvasSurfaceRef.current?.getBoundingClientRect().left || 0) + 420, 260);
      const existingIds = new Set(nodes.map((node) => node.id));
      const importedIdMap = new Map<string, string>();
      const protectedImportIds = new Set(['prompt-root', 'timeline-output']);
      const importedNodes: CanvasNode[] = rawNodes
        .map((rawNode, index) => {
          const sourceId = String(rawNode.id || rawNode.nodeId || rawNode.key || `imported-${index}`);
          if (
            protectedImportIds.has(sourceId) ||
            sourceId.startsWith('agent-') ||
            sourceId.startsWith('segment-') ||
            sourceId.startsWith('selected-dreamy-bot')
          ) {
            return null;
          }
          const kind = normalizeCanvasNodeKind(rawNode.kind || rawNode.type || rawNode.nodeType);
          const libraryItem = getCanvasNodeLibraryItem(kind);
          const id = existingIds.has(sourceId) ? makeId(`import_${sourceId.replace(/[^a-z0-9]+/gi, '_')}`) : sourceId;
          importedIdMap.set(sourceId, id);
          existingIds.add(id);
          const position = readRecord(rawNode.position);
          const data = readRecord(rawNode.data);
          const sourceType =
            (String(rawNode.sourceType || data.sourceType || '').toLowerCase() as CanvasSourceType) ||
            getCanvasNodeMediaMode(kind) ||
            libraryItem?.sourceType;
          return {
            id,
            kind,
            title: String(rawNode.title || rawNode.name || data.title || data.name || libraryItem?.title || 'Imported Node'),
            subtitle: String(
              rawNode.subtitle ||
                rawNode.description ||
                data.subtitle ||
                data.description ||
                rawNode.prompt ||
                data.prompt ||
                libraryItem?.subtitle ||
                'Imported from canvas JSON',
            ),
            x: numeric(rawNode.x ?? position.x, basePoint.x + index * 34),
            y: numeric(rawNode.y ?? position.y, basePoint.y + index * 34),
            width: numeric(rawNode.width, libraryItem?.width || 244),
            height: numeric(rawNode.height, libraryItem?.height || 120),
            status: String(rawNode.status || data.status || 'imported'),
            action: (rawNode.action || data.action || libraryItem?.action) as StudioAction | undefined,
            prompt: String(rawNode.prompt || data.prompt || rawNode.text || data.text || ''),
            botSlug: String(rawNode.botSlug || data.botSlug || libraryItem?.botSlug || DEFAULT_DREAMY_SLUG),
            botName: String(rawNode.botName || data.botName || ''),
            mediaUrl: String(rawNode.mediaUrl || rawNode.url || data.mediaUrl || data.url || rawNode.thumbnail || ''),
            outputText: String(rawNode.outputText || data.outputText || rawNode.text || data.text || ''),
            fileName: String(rawNode.fileName || data.fileName || ''),
            sourceType,
            boardId: activeBoardId,
          } satisfies CanvasNode;
        })
        .filter(Boolean) as CanvasNode[];

      const importedConnections: CanvasConnection[] = rawConnections
        .map((rawConnection, index) => {
          const source = String(rawConnection.from || rawConnection.source || rawConnection.sourceId || rawConnection.start || '');
          const target = String(rawConnection.to || rawConnection.target || rawConnection.targetId || rawConnection.end || '');
          const from = importedIdMap.get(source) || source;
          const to = importedIdMap.get(target) || target;
          if (!from || !to || from === to || !existingIds.has(from) || !existingIds.has(to)) return null;
          return {
            id: String(rawConnection.id || `${from}-to-${to}-import-${index}`),
            from,
            to,
            label: String(rawConnection.label || rawConnection.type || 'import'),
            sourceHandle: String(rawConnection.sourceHandle || 'out'),
            targetHandle: String(rawConnection.targetHandle || 'in'),
          };
        })
        .filter(Boolean) as CanvasConnection[];

      if (!importedNodes.length && !importedConnections.length) return;
      commitCanvasSnapshot();
      setCustomNodes((prev) => [...prev, ...importedNodes]);
      setCustomConnections((prev) => [...prev, ...importedConnections]);
      if (importedNodes[0]) {
        setSelectedNodeId(importedNodes[0].id);
        setSelectedNodeIds([importedNodes[0].id]);
      }
    },
    [activeBoardId, commitCanvasSnapshot, getCanvasPoint, nodes],
  );

  const handleCanvasWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = canvasSurfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextZoom = clamp(zoom - event.deltaY * 0.001, 0.35, 1.8);
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const canvasX = (cursorX - pan.x) / zoom;
    const canvasY = (cursorY - pan.y) / zoom;
    setZoom(nextZoom);
    setPan({
      x: Math.round(cursorX - canvasX * nextZoom),
      y: Math.round(cursorY - canvasY * nextZoom),
    });
  };

  const handleCanvasDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-canvas-node="true"], [data-canvas-floating="true"]')) return;
    const point = getCanvasPoint(event.clientX, event.clientY);
    addCanvasNode(activeBoardId === 'timeline' ? 'ai-video' : 'ai-image', point, { linkFromSelected: Boolean(selectedNode) });
  };

  const handleCanvasContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-canvas-floating="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    const point = getCanvasPoint(event.clientX, event.clientY);
    setContextMenu({ screenX: event.clientX, screenY: event.clientY, canvasX: point.x, canvasY: point.y });
  };

  const handleCanvasDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDropActive(false);
    const point = getCanvasPoint(event.clientX, event.clientY);
    const files = Array.from(event.dataTransfer.files || []);
    for (const [index, file] of files.entries()) {
      const dropPoint = { x: point.x + index * 36, y: point.y + index * 36 };
      if (file.name.toLowerCase().endsWith('.json')) {
        try {
          importCanvasState(await file.text(), dropPoint);
        } catch {
          addCanvasNode('annotation', dropPoint, {
            linkFromSelected: false,
            overrides: {
              title: 'JSON import failed',
              subtitle: file.name,
              outputText: 'The dropped JSON could not be parsed as a canvas project.',
            },
          });
        }
        continue;
      }
      const mime = file.type || '';
      const isImage = mime.startsWith('image/');
      const isVideo = mime.startsWith('video/');
      const isAudio = mime.startsWith('audio/');
      const kind: CanvasNodeKind = isImage ? 'source-image' : isVideo ? 'source-video' : isAudio ? 'source-audio' : 'source-text';
      const outputText = kind === 'source-text' ? (await file.text().catch(() => '')).slice(0, 1200) : '';
      addCanvasNode(kind, dropPoint, {
        linkFromSelected: false,
        overrides: {
          title: file.name.replace(/\.[^.]+$/, '') || file.name,
          subtitle: `${mime || 'file'} · ${(file.size / 1024).toFixed(1)} KB`,
          fileName: file.name,
          mediaUrl: kind === 'source-text' ? '' : URL.createObjectURL(file),
          outputText,
          prompt: outputText.slice(0, 360),
          sourceType: getCanvasNodeMediaMode(kind),
        },
      });
    }
  };

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null;
      if (!element) return false;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setSpacePanning(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        downloadJson();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoCanvas();
        else undoCanvas();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoCanvas();
      }
      if (event.key.toLowerCase() === 'd' || event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        resetView();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpacePanning(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [deleteSelected, redoCanvas, undoCanvas]);

  const renderConnection = (connection: CanvasConnection) => {
    const from = nodeMap.get(connection.from);
    const to = nodeMap.get(connection.to);
    if (!from || !to) return null;
    const startX = from.x + from.width;
    const startY = from.y + from.height / 2;
    const endX = to.x;
    const endY = to.y + to.height / 2;
    const handle = Math.max(70, Math.abs(endX - startX) * 0.45);
    const path = `M ${startX} ${startY} C ${startX + handle} ${startY}, ${endX - handle} ${endY}, ${endX} ${endY}`;
    const active = activeSelectedNodeIds.includes(from.id) || activeSelectedNodeIds.includes(to.id);
    const accent =
      connection.label === 'fallback'
        ? '#8b949e'
        : connection.label === 'primary'
          ? '#f31272'
          : connection.label === 'route'
            ? '#14b8d4'
            : connection.label === 'source'
              ? '#a855f7'
            : '#22c55e';

    return (
      <g key={connection.id}>
        <path
          d={path}
          fill="none"
          stroke={active ? accent : 'rgba(148, 163, 184, 0.36)'}
          strokeWidth={active ? 2.4 : 1.5}
          strokeLinecap="round"
          strokeDasharray={connection.label === 'fallback' ? '6 5' : undefined}
        />
        {connection.label && (
          <text
            x={(startX + endX) / 2}
            y={(startY + endY) / 2 - 8}
            fill={active ? '#f8a6ca' : 'rgba(203, 213, 225, 0.62)'}
            fontSize="11"
            fontWeight="600"
          >
            {connection.label}
          </text>
        )}
      </g>
    );
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#090a0f] text-Cr-text-default-v2">
      <div className="hidden h-11 shrink-0 items-center justify-between border-b border-white/10 bg-[#101118] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md-v2 bg-dreamy-brand-hot-v2/15 text-dreamy-brand-hot-v2">
            <Link2 size={16} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Canvas orchestration</div>
            <div className="truncate text-[11px] text-Cr-text-subtler-v2">
              {nodes.length} nodes / {connections.length} routes
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyJson}
            className="hidden h-8 items-center gap-1.5 rounded-md-v2 border border-white/10 bg-white/5 px-2 text-xs font-semibold text-Cr-text-subtle-v2 active:bg-white/10 sm:inline-flex"
          >
            <Copy size={14} />
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
          <button
            type="button"
            onClick={downloadJson}
            className="flex h-8 items-center gap-1.5 rounded-md-v2 border border-white/10 bg-white/5 px-2 text-xs font-semibold text-Cr-text-subtle-v2 active:bg-white/10"
          >
            <Download size={14} />
            Export
          </button>
        </div>
      </div>

      <div className="relative min-h-[560px] flex-1 overflow-hidden xl:min-h-0">
        <CanvasInputsDrawer
          open={leftPanelOpen}
          selectedStarterPreset={selectedStarterPreset}
          boardNodes={boardNodes}
          nodes={nodes}
          activeBoardId={activeBoardId}
          activeSelectedNodeIds={activeSelectedNodeIds}
          selectedNodeId={selectedNodeId}
          selectedSegment={selectedSegment}
          submitting={submitting}
          onClose={() => setLeftPanelOpen(false)}
          onOpenBotCatalog={() => setShowBotCatalog(true)}
          onAddAgent={() => addCanvasNode('agent')}
          onUseSelectedStarter={() => {
            if (!selectedStarterPreset) return;
            if (selectedStarterNode) selectCanvasNode(selectedStarterNode);
            setCanvasCommand(selectedStarterPreset.prompt);
            setCanvasAction(getStarterPresetAction(selectedStarterPreset, selectedSegment));
          }}
          onRunStarterPreset={onRunPreset}
          onBoardChange={setActiveBoardId}
          onSelectNode={selectCanvasNode}
        />

        <div className="absolute inset-0 overflow-hidden">
          <input
            ref={canvasFileInputRef}
            type="file"
            className="hidden"
            multiple
            accept="image/*,video/*,audio/*,.txt,.md,.json"
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              const rect = canvasSurfaceRef.current?.getBoundingClientRect();
              if (!files.length || !rect) return;
              const syntheticPoint = getCanvasPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
              void Promise.all(
                files.map(async (file, index) => {
                  const point = { x: syntheticPoint.x + index * 36, y: syntheticPoint.y + index * 36 };
                  if (file.name.toLowerCase().endsWith('.json')) {
                    importCanvasState(await file.text(), point);
                    return;
                  }
                  const mime = file.type || '';
                  const kind: CanvasNodeKind = mime.startsWith('image/')
                    ? 'source-image'
                    : mime.startsWith('video/')
                      ? 'source-video'
                      : mime.startsWith('audio/')
                        ? 'source-audio'
                        : 'source-text';
                  const outputText = kind === 'source-text' ? (await file.text().catch(() => '')).slice(0, 1200) : '';
                  addCanvasNode(kind, point, {
                    linkFromSelected: false,
                    overrides: {
                      title: file.name.replace(/\.[^.]+$/, '') || file.name,
                      subtitle: `${mime || 'file'} · ${(file.size / 1024).toFixed(1)} KB`,
                      fileName: file.name,
                      mediaUrl: kind === 'source-text' ? '' : URL.createObjectURL(file),
                      outputText,
                      prompt: outputText.slice(0, 360),
                      sourceType: getCanvasNodeMediaMode(kind),
                    },
                  });
                }),
              );
              event.target.value = '';
            }}
          />
          <div data-canvas-floating="true" className="absolute left-4 top-4 z-30 flex items-center gap-1 rounded-md-v2 border border-white/10 bg-[#171821]/90 p-1 shadow-xl">
            <button
              type="button"
              data-testid="ai-canvas-open-inputs"
              onClick={() => setLeftPanelOpen(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md-v2 bg-white/[0.06] px-2 text-xs font-semibold text-Cr-text-subtle-v2 active:bg-white/[0.1]"
            >
              <PanelRightOpen size={15} className="rotate-180" />
              Inputs
            </button>
            <button
              type="button"
              onClick={() => setShowBotCatalog(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md-v2 bg-white/[0.06] px-2 text-xs font-semibold text-Cr-text-subtle-v2 active:bg-white/[0.1]"
            >
              <Bot size={15} />
              Bots
            </button>
          </div>

          <div data-canvas-floating="true" className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1 rounded-md-v2 border border-white/10 bg-[#171821]/90 p-1 shadow-xl">
            <button
              type="button"
              onClick={() => setTool('select')}
              className={`flex h-9 w-9 items-center justify-center rounded-md-v2 ${tool === 'select' ? 'bg-dreamy-brand-hot-v2 text-white' : 'text-Cr-text-subtler-v2 active:bg-white/[0.08]'}`}
              aria-label="Select nodes"
            >
              <MousePointer2 size={17} />
            </button>
            <button
              type="button"
              onClick={() => setTool('pan')}
              className={`flex h-9 w-9 items-center justify-center rounded-md-v2 ${tool === 'pan' ? 'bg-dreamy-brand-hot-v2 text-white' : 'text-Cr-text-subtler-v2 active:bg-white/[0.08]'}`}
              aria-label="Pan canvas"
            >
              <Hand size={17} />
            </button>
            <button
              type="button"
              data-testid="ai-canvas-connect-mode"
              onClick={() => {
                setTool('connect');
                setConnectFromNodeId(selectedNode?.id || null);
              }}
              className={`flex h-9 w-9 items-center justify-center rounded-md-v2 ${tool === 'connect' ? 'bg-dreamy-brand-hot-v2 text-white' : 'text-Cr-text-subtler-v2 active:bg-white/[0.08]'}`}
              aria-label="Connect nodes"
            >
              <Link2 size={17} />
            </button>
            <div className="mx-1 h-6 w-px bg-white/10" />
            <button type="button" onClick={() => addCanvasNode('agent')} className="flex h-9 w-9 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08]" aria-label="Add agent">
              <Bot size={17} />
            </button>
            <button type="button" onClick={() => addCanvasNode('segment')} className="flex h-9 w-9 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08]" aria-label="Add segment">
              <Film size={17} />
            </button>
            <button type="button" onClick={() => addCanvasNode('source-image')} className="flex h-9 w-9 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08]" aria-label="Add source image">
              <ImagePlus size={17} />
            </button>
            <button type="button" onClick={() => canvasFileInputRef.current?.click()} className="flex h-9 w-9 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08]" aria-label="Import file">
              <Download size={17} className="rotate-180" />
            </button>
          </div>

          <div data-canvas-floating="true" className="absolute right-4 top-4 z-30 flex items-center gap-1 rounded-md-v2 border border-white/10 bg-[#171821]/90 p-1 shadow-xl">
            <button
              type="button"
              onClick={() => void refreshSuperClawStatus()}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md-v2 border px-2 text-[11px] font-semibold ${superClawStatusTone}`}
              aria-label="Refresh SuperClaw status"
            >
              <Activity size={13} />
              SuperClaw {superClawStatusLabel}
            </button>
            <button
              type="button"
              data-testid="ai-canvas-open-inspector"
              onClick={() => setInspectorOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md-v2 bg-white/[0.06] px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 active:bg-white/10"
            >
              <SlidersHorizontal size={13} />
              Inspector
            </button>
            <button
              type="button"
              onClick={undoCanvas}
              disabled={!canUndo}
              className="flex h-8 w-8 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08] disabled:opacity-35"
              aria-label="Undo canvas"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              onClick={redoCanvas}
              disabled={!canRedo}
              className="flex h-8 w-8 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08] disabled:opacity-35"
              aria-label="Redo canvas"
            >
              <RefreshCcw size={14} />
            </button>
            <button
              type="button"
              onClick={downloadJson}
              className="inline-flex h-8 items-center gap-1.5 rounded-md-v2 bg-white/[0.06] px-2 text-[11px] font-semibold active:bg-white/10"
            >
              <Download size={13} />
              JSON
            </button>
          </div>

          <div
            ref={canvasSurfaceRef}
            data-testid="ai-canvas-surface"
            className={`absolute inset-0 cursor-grab overflow-hidden bg-[#0d0e13] active:cursor-grabbing ${isDropActive ? 'ring-2 ring-inset ring-dreamy-brand-hot-v2' : ''}`}
            onPointerDown={handleSurfacePointerDown}
            onWheel={handleCanvasWheel}
            onDoubleClick={handleCanvasDoubleClick}
            onContextMenu={handleCanvasContextMenu}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropActive(true);
            }}
            onDragLeave={() => setIsDropActive(false)}
            onDrop={handleCanvasDrop}
            style={{
              backgroundImage:
                'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.11) 1px, transparent 0)',
              backgroundSize: '24px 24px',
            }}
          >
            <div
              className="absolute left-0 top-0 h-[860px] w-[1420px]"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
            >
              <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 1420 860" aria-hidden="true">
                {connections.map(renderConnection)}
              </svg>

              {nodes.map((node) => {
                const Icon = getCanvasNodeIcon(node.kind);
                const active = activeSelectedNodeIds.includes(node.id);
                const superClawNodeActive =
                  superClawContextNodeIds.has(node.id) ||
                  (!superClawContextNodeIds.size && superClawRunInFlight && activeSelectedNodeIds.includes(node.id));
                const nodeStatus = superClawNodeActive && superClawRunStatus ? superClawRunStatus : node.status;
                return (
                  <button
                    key={node.id}
                    type="button"
                    data-canvas-node="true"
                    onPointerDown={(event) => handleNodePointerDown(event, node)}
                    onClick={(event) => selectCanvasNode(node, event.shiftKey)}
                    className={`absolute overflow-hidden rounded-md-v2 border text-left shadow-2xl transition-colors ${
                      active
                        ? 'border-dreamy-brand-hot-v2 bg-[#1d1722] shadow-dreamy-brand-hot-v2/20'
                        : 'border-white/10 bg-[#171821] active:border-white/25'
                    }`}
                    style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                  >
                    <span
                      className={`absolute -left-1 top-1/2 z-10 h-4 w-4 -translate-y-1/2 rounded-full border border-white/20 ${
                        tool === 'connect' && connectFromNodeId && connectFromNodeId !== node.id
                          ? 'bg-dreamy-brand-hot-v2'
                          : 'bg-[#0d0e13]'
                      }`}
                    />
                    <span
                      className={`absolute -right-1 top-1/2 z-10 h-4 w-4 -translate-y-1/2 rounded-full border border-white/20 ${
                        connectFromNodeId === node.id ? 'bg-dreamy-brand-hot-v2' : 'bg-[#0d0e13]'
                      }`}
                    />
                    <div className="flex h-full">
                      {node.mediaUrl && (
                        <div className="h-full w-[86px] shrink-0 bg-black/30">
                          {node.sourceType === 'video' ? (
                            <video src={node.mediaUrl} muted playsInline className="h-full w-full object-contain opacity-80" />
                          ) : node.sourceType === 'audio' ? (
                            <div className="grid h-full place-items-center text-dreamy-brand-hot-v2">
                              <Play size={20} />
                            </div>
                          ) : (
                            <img src={node.mediaUrl} alt="" className="h-full w-full object-contain opacity-80" />
                          )}
                        </div>
                      )}
                      <div className="flex min-w-0 flex-1 flex-col p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md-v2 bg-white/[0.08] text-dreamy-brand-hot-v2">
                              <Icon size={15} />
                            </span>
                            <span className="truncate text-xs font-semibold">{node.title}</span>
                          </div>
                          <span className={`text-[10px] font-semibold ${statusTone(nodeStatus)}`}>{nodeStatus || 'idle'}</span>
                        </div>
                        <div className="line-clamp-2 text-[11px] leading-4 text-Cr-text-subtler-v2">{node.subtitle}</div>
                        {!node.mediaUrl && node.outputText && (
                          <div className="mt-2 line-clamp-2 rounded-md-v2 bg-black/20 px-2 py-1 text-[10px] leading-4 text-Cr-text-subtlest-v2">
                            {node.outputText}
                          </div>
                        )}
                        {node.botSlug && (
                          <div className="mt-auto truncate text-[10px] font-semibold text-Cr-text-subtlest-v2">{node.botSlug}</div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {isDropActive && (
            <div
              data-canvas-floating="true"
              data-testid="ai-canvas-drop-import"
              className="pointer-events-none absolute inset-6 z-30 grid place-items-center rounded-lg-v2 border border-dreamy-brand-hot-v2/70 bg-dreamy-brand-hot-v2/10 text-sm font-semibold text-white"
            >
              Drop media or canvas JSON
            </div>
          )}

          {contextMenu && (
            <div
              data-canvas-floating="true"
              data-testid="ai-canvas-context-menu"
              className="fixed z-50 w-52 overflow-hidden rounded-md-v2 border border-white/10 bg-[#171821] p-1 text-xs shadow-2xl"
              style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
            >
              {AI_CANVAS_NODE_LIBRARY.map((item) => {
                const Icon = getCanvasNodeIcon(item.kind);
                return (
                  <button
                    key={item.kind}
                    type="button"
                    onClick={() => addCanvasNode(item.kind, { x: contextMenu.canvasX, y: contextMenu.canvasY })}
                    className="flex h-9 w-full items-center gap-2 rounded-md-v2 px-2 text-left font-semibold text-Cr-text-subtler-v2 active:bg-white/[0.08]"
                  >
                    <Icon size={14} className="text-dreamy-brand-hot-v2" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="absolute bottom-6 left-5 right-5 z-20 grid gap-2 md:left-[70px] md:right-[70px]">
            <div
              data-testid="canvas-auto-flow-presets"
              className="flex flex-wrap items-center gap-2 rounded-md-v2 border border-white/10 bg-[#171821]/95 p-2 shadow-xl"
            >
              <div data-testid="canvas-material-flow-ready" className="mr-1 inline-flex min-w-0 items-center gap-2 rounded-md-v2 bg-white/[0.06] px-2 py-1 text-[11px] font-semibold text-Cr-text-subtle-v2">
                <Link2 size={13} className="shrink-0 text-dreamy-brand-hot-v2" />
                <span className="truncate">{activeFlowPreset?.summary || 'Material flow ready'}</span>
              </div>
              {CANVAS_FLOW_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyFlowPreset(preset)}
                  aria-pressed={activeFlowPresetId === preset.id}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md-v2 px-2 text-[11px] font-semibold ${
                    activeFlowPresetId === preset.id
                      ? 'bg-dreamy-brand-hot-v2 text-white'
                      : 'bg-white/[0.06] text-Cr-text-subtler-v2 active:bg-white/10'
                  }`}
                >
                  <Wand2 size={13} />
                  {preset.title}
                </button>
              ))}
            </div>
            {(superClawRunId || superClawError) && (
              <div
                data-testid="superclaw-run-status"
                className="flex flex-wrap items-center gap-2 rounded-md-v2 border border-white/10 bg-[#171821]/95 p-2 text-[11px] shadow-xl"
              >
                <div className="inline-flex min-w-0 items-center gap-2 rounded-md-v2 bg-white/[0.06] px-2 py-1 font-semibold text-Cr-text-subtle-v2">
                  <GitBranch size={13} className="shrink-0 text-dreamy-brand-hot-v2" />
                  <span className="truncate">SuperClaw {superClawFlowStatus || 'ready'}</span>
                  {superClawRunId && <span className="max-w-[150px] truncate text-Cr-text-subtlest-v2">{superClawRunId}</span>}
                </div>
                {superClawError && (
                  <div className="min-w-[180px] flex-1 truncate rounded-md-v2 bg-red-500/10 px-2 py-1 font-semibold text-red-200">
                    {superClawError}
                  </div>
                )}
                {latestSuperClawEvents.map((event, index) => (
                  <div
                    key={`${event.type || event.event || 'event'}-${index}`}
                    className="max-w-[260px] truncate rounded-md-v2 bg-black/20 px-2 py-1 text-Cr-text-subtler-v2"
                  >
                    {superClawEventText(event)}
                  </div>
                ))}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void cancelSuperClawRun()}
                    disabled={!superClawRunInFlight}
                    className="flex h-7 w-7 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08] disabled:opacity-35"
                    aria-label="Cancel SuperClaw run"
                  >
                    <CircleStop size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void resumeSuperClawRun()}
                    disabled={!superClawRunId || superClawRunInFlight}
                    className="flex h-7 w-7 items-center justify-center rounded-md-v2 text-Cr-text-subtler-v2 active:bg-white/[0.08] disabled:opacity-35"
                    aria-label="Resume SuperClaw run"
                  >
                    <RefreshCcw size={14} />
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex min-w-[260px] flex-1 items-center gap-2 rounded-md-v2 border border-white/10 bg-[#171821]/95 p-2 shadow-xl">
              {(showReferenceMenu || showPresetMenu) && (
                <div
                  data-testid="ai-canvas-reference-menu"
                  className="absolute bottom-[calc(100%+8px)] left-0 right-0 flex flex-wrap gap-1 rounded-md-v2 border border-white/10 bg-[#171821] p-2 shadow-2xl"
                >
                  {showReferenceMenu
                    ? referenceNodes.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          onClick={() => insertCanvasCommandToken(`@${node.id}`)}
                          className="inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-md-v2 bg-white/[0.06] px-2 text-[11px] font-semibold active:bg-white/10"
                        >
                          <Link2 size={12} className="shrink-0 text-dreamy-brand-hot-v2" />
                          <span className="truncate">{node.title}</span>
                        </button>
                      ))
                    : CANVAS_COMMAND_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => insertCanvasCommandToken(preset.value)}
                          className="inline-flex h-7 items-center gap-1.5 rounded-md-v2 bg-white/[0.06] px-2 text-[11px] font-semibold active:bg-white/10"
                        >
                          <Wand2 size={12} className="text-dreamy-brand-hot-v2" />
                          {preset.label}
                        </button>
                      ))}
                </div>
              )}
              <input
                value={canvasCommand}
                onChange={(event) => setCanvasCommand(event.target.value)}
                className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-Cr-text-subtlest-v2"
                placeholder="Modify this material flow: text to image, image to video, extend, or restyle..."
              />
              <button
                type="button"
                onClick={runSelected}
                disabled={submitting || !selectedNode}
                className="inline-flex h-9 items-center gap-2 rounded-md-v2 bg-dreamy-brand-hot-v2 px-4 text-xs font-semibold text-white disabled:bg-white/[0.06] disabled:text-Cr-text-subtlest-v2"
              >
                <Send size={14} />
                Generate
              </button>
              <button
                type="button"
                onClick={runSelectedWithSuperClaw}
                disabled={superClawBusy || !selectedNode}
                className="inline-flex h-9 items-center gap-2 rounded-md-v2 bg-emerald-400 px-3 text-xs font-semibold text-black disabled:bg-white/[0.06] disabled:text-Cr-text-subtlest-v2"
              >
                <GitBranch size={14} />
                Run Flow
              </button>
            </div>
            <div className="flex items-center gap-1 rounded-md-v2 border border-white/10 bg-[#171821]/95 p-1 shadow-xl">
              <button type="button" onClick={() => setZoom((value) => clamp(value - 0.08, 0.48, 1.4))} className="flex h-8 w-8 items-center justify-center rounded-md-v2 active:bg-white/[0.08]" aria-label="Zoom out">
                <ZoomOut size={15} />
              </button>
              <button type="button" onClick={resetView} className="h-8 min-w-12 rounded-md-v2 px-2 text-[11px] font-semibold active:bg-white/[0.08]">
                {Math.round(zoom * 100)}%
              </button>
              <button type="button" onClick={() => setZoom((value) => clamp(value + 0.08, 0.48, 1.4))} className="flex h-8 w-8 items-center justify-center rounded-md-v2 active:bg-white/[0.08]" aria-label="Zoom in">
                <ZoomIn size={15} />
              </button>
            </div>
            </div>
          </div>
        </div>

        <CanvasInspectorDrawer
          open={inspectorOpen}
          selectedNode={selectedNode}
          selectedNodeSegment={selectedNodeSegment}
          canvasAction={canvasAction}
          canvasCommand={canvasCommand}
          submitting={submitting}
          onClose={() => setInspectorOpen(false)}
          onActionChange={setCanvasAction}
          onCommandChange={setCanvasCommand}
          onRunSelected={runSelected}
          onDuplicateSelected={duplicateSelected}
          onAddAgent={() => addCanvasNode('agent')}
          onDeleteSelected={deleteSelected}
        />
      </div>
      <CanvasBotCatalogModal
        open={showBotCatalog}
        presets={canvasBotCatalogPresets}
        onClose={() => setShowBotCatalog(false)}
        onSelectPreset={(preset) => {
          addCanvasNode('agent', undefined, {
            overrides: {
              title: preset.title,
              subtitle: preset.recommendation,
              status: preset.previewStatus,
              action: getStarterPresetAction(preset, selectedSegment),
              prompt: preset.prompt,
              botSlug: preset.botSlug,
              botName: preset.title,
              mediaUrl: preset.visualUrl,
              boardId: activeBoardId,
            },
          });
          setShowBotCatalog(false);
        }}
      />
    </section>
  );
}
