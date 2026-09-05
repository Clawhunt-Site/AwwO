import {
  Bot,
  Clapperboard,
  Copy,
  Maximize2,
  Plus,
  SlidersHorizontal,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import type { StudioAction, StudioSegment } from '../api';
import {
  CANVAS_BOARDS,
  clamp,
  getCanvasNodeIcon,
  getStarterPresetRunLabel,
  statusTone,
} from '../model/dreamyWorkspace';
import type {
  CanvasBoardId,
  CanvasNode,
  StudioStarterPreset,
} from '../model/dreamyWorkspace';

export function CanvasInputsDrawer({
  open,
  selectedStarterPreset,
  boardNodes,
  nodes,
  activeBoardId,
  activeSelectedNodeIds,
  selectedNodeId,
  selectedSegment,
  submitting,
  onClose,
  onOpenBotCatalog,
  onAddAgent,
  onUseSelectedStarter,
  onRunStarterPreset,
  onBoardChange,
  onSelectNode,
}: {
  open: boolean;
  selectedStarterPreset?: StudioStarterPreset | null;
  boardNodes: CanvasNode[];
  nodes: CanvasNode[];
  activeBoardId: CanvasBoardId;
  activeSelectedNodeIds: string[];
  selectedNodeId?: string;
  selectedSegment?: StudioSegment | null;
  submitting: boolean;
  onClose: () => void;
  onOpenBotCatalog: () => void;
  onAddAgent: () => void;
  onUseSelectedStarter: () => void;
  onRunStarterPreset?: (preset: StudioStarterPreset) => void;
  onBoardChange: (boardId: CanvasBoardId) => void;
  onSelectNode: (node: CanvasNode) => void;
}) {
  return (
    <aside
      data-testid="ai-canvas-left-drawer"
      className={`absolute inset-y-3 left-3 z-40 w-[min(360px,calc(100%-24px))] min-h-0 flex-col overflow-hidden rounded-lg-v2 border border-white/10 bg-[#111219]/98 shadow-2xl backdrop-blur ${
        open ? 'flex' : 'hidden'
      }`}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-4">
        <div>
          <div className="text-sm font-semibold text-Cr-text-default-v2">Canvas Inputs</div>
          <div className="text-[11px] text-Cr-text-subtler-v2">{boardNodes.length} visible in {activeBoardId}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenBotCatalog}
            className="inline-flex h-8 items-center gap-1.5 rounded-md-v2 bg-white/[0.06] px-2 text-[11px] font-semibold active:bg-white/10"
          >
            <Bot size={13} />
            Bots
          </button>
          <button type="button" onClick={onAddAgent} className="flex h-8 w-8 items-center justify-center rounded-md-v2 bg-white/[0.06]">
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md-v2 bg-white/[0.06] active:bg-white/10"
            aria-label="Close canvas inputs"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {selectedStarterPreset && (
        <div
          data-testid="canvas-selected-dreamy-bot"
          className="m-3 mb-0 grid gap-2 rounded-md-v2 border border-dreamy-brand-hot-v2/40 bg-dreamy-brand-hot-v2/10 p-3"
        >
          <button
            type="button"
            onClick={onUseSelectedStarter}
            className="grid grid-cols-[56px_minmax(0,1fr)] gap-2 text-left"
          >
            <span className="relative h-14 overflow-hidden rounded-md-v2 bg-black/30">
              {selectedStarterPreset.visualUrl ? (
                <img src={selectedStarterPreset.visualUrl} alt="" className="h-full w-full object-contain" />
              ) : (
                <span className="grid h-full place-items-center text-Cr-text-subtler-v2">
                  <Bot size={18} />
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-Cr-text-default-v2">{selectedStarterPreset.title}</span>
              <span className="mt-1 block truncate text-[11px] text-Cr-text-subtler-v2">{selectedStarterPreset.workflow}</span>
              <span className="mt-1 block truncate text-[10px] font-semibold text-Cr-text-subtlest-v2">{selectedStarterPreset.botSlug}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => onRunStarterPreset?.(selectedStarterPreset)}
            disabled={submitting || !onRunStarterPreset}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-dreamy-brand-hot-v2 px-2 text-[11px] font-semibold text-white disabled:bg-white/[0.06] disabled:text-Cr-text-subtlest-v2"
          >
            <Clapperboard size={12} />
            {getStarterPresetRunLabel(selectedStarterPreset, selectedSegment)}
          </button>
        </div>
      )}
      <div className="mx-4 my-3 flex h-10 shrink-0 items-center gap-2 rounded-md-v2 border border-white/10 bg-black/20 px-3 text-xs text-Cr-text-subtlest-v2">
        <SlidersHorizontal size={14} />
        <span>Search layers...</span>
        <span className="ml-auto">Cmd K</span>
      </div>
      <div data-testid="ai-canvas-board-tabs" className="mx-4 mb-3 grid grid-cols-3 gap-1 rounded-md-v2 border border-white/10 bg-black/20 p-1">
        {CANVAS_BOARDS.map((board) => (
          <button
            key={board.id}
            type="button"
            onClick={() => onBoardChange(board.id)}
            className={`h-8 rounded-md-v2 text-[11px] font-semibold ${
              activeBoardId === board.id ? 'bg-dreamy-brand-hot-v2 text-white' : 'text-Cr-text-subtler-v2 active:bg-white/[0.08]'
            }`}
          >
            {board.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="mb-2 flex items-center justify-between px-1 text-[11px] font-semibold text-Cr-text-subtler-v2">
          <span>{CANVAS_BOARDS.find((board) => board.id === activeBoardId)?.label || 'Canvas'} Nodes</span>
          <span>{boardNodes.length}/{nodes.length}</span>
        </div>
        {boardNodes.map((node) => {
          const Icon = getCanvasNodeIcon(node.kind);
          const active = activeSelectedNodeIds.includes(node.id);
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectNode(node)}
              className={`mb-1 flex w-full min-w-0 items-center gap-2 rounded-md-v2 px-2 py-2 text-left text-xs transition-colors ${
                active ? 'bg-dreamy-brand-hot-v2/15 text-Cr-text-default-v2' : 'text-Cr-text-subtler-v2 active:bg-white/[0.06]'
              }`}
            >
              <Icon size={14} className="shrink-0 text-dreamy-brand-hot-v2" />
              <span className="min-w-0 flex-1 truncate">{node.title}</span>
              <span className={`shrink-0 text-[10px] ${statusTone(node.status)}`}>{node.status || 'idle'}</span>
            </button>
          );
        })}
      </div>
      <div className="m-4 mt-0 rounded-md-v2 border border-white/10 bg-black/20 p-3">
        <div className="mb-2 flex items-center justify-between text-xs font-semibold">
          <span>Mini Map</span>
          <Maximize2 size={13} className="text-Cr-text-subtlest-v2" />
        </div>
        <div className="relative h-36 overflow-hidden rounded-md-v2 border border-white/10 bg-[#0d0e13]">
          {nodes.map((node) => (
            <span
              key={`mini-${node.id}`}
              className={`absolute rounded-sm border ${
                selectedNodeId === node.id ? 'border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/30' : 'border-white/20 bg-white/10'
              }`}
              style={{
                left: `${clamp((node.x / 1200) * 100, 2, 92)}%`,
                top: `${clamp((node.y / 900) * 100, 2, 90)}%`,
                width: `${clamp((node.width / 1200) * 100, 6, 26)}%`,
                height: `${clamp((node.height / 900) * 100, 5, 18)}%`,
              }}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

export function CanvasInspectorDrawer({
  open,
  selectedNode,
  selectedNodeSegment,
  canvasAction,
  canvasCommand,
  submitting,
  onClose,
  onActionChange,
  onCommandChange,
  onRunSelected,
  onDuplicateSelected,
  onAddAgent,
  onDeleteSelected,
}: {
  open: boolean;
  selectedNode: CanvasNode | null;
  selectedNodeSegment?: StudioSegment | null;
  canvasAction: StudioAction;
  canvasCommand: string;
  submitting: boolean;
  onClose: () => void;
  onActionChange: (action: StudioAction) => void;
  onCommandChange: (command: string) => void;
  onRunSelected: () => void;
  onDuplicateSelected: () => void;
  onAddAgent: () => void;
  onDeleteSelected: () => void;
}) {
  return (
    <aside
      data-testid="ai-canvas-inspector-drawer"
      className={`absolute inset-y-3 right-3 z-40 w-[min(300px,calc(100%-24px))] min-h-0 flex-col overflow-hidden rounded-lg-v2 border border-white/10 bg-[#111219]/98 shadow-2xl backdrop-blur ${
        open ? 'flex' : 'hidden'
      }`}
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SlidersHorizontal size={14} />
          <div className="truncate text-sm font-semibold">Inspector</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md-v2 bg-white/[0.06] active:bg-white/10"
          aria-label="Close inspector"
        >
          <X size={14} />
        </button>
      </div>
      {selectedNode ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="rounded-md-v2 border border-white/10 bg-white/[0.03] p-3">
            <div className="text-sm font-semibold">{selectedNode.title}</div>
            <div className="mt-1 text-xs capitalize text-Cr-text-subtler-v2">{selectedNode.kind}</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-lg-v2 bg-white/5 p-2">
                <div className="text-Cr-text-subtlest-v2">X</div>
                <div className="mt-1 font-semibold">{Math.round(selectedNode.x)}</div>
              </div>
              <div className="rounded-lg-v2 bg-white/5 p-2">
                <div className="text-Cr-text-subtlest-v2">Y</div>
                <div className="mt-1 font-semibold">{Math.round(selectedNode.y)}</div>
              </div>
            </div>
          </div>

          <label className="mt-3 block text-[11px] font-semibold text-Cr-text-subtler-v2">Action</label>
          <select
            value={canvasAction}
            onChange={(event) => onActionChange(event.target.value as StudioAction)}
            className="mt-1 h-9 w-full rounded-lg-v2 border border-white/10 bg-[#171821] px-2 text-xs outline-none"
          >
            <option value="generate">Generate</option>
            <option value="extend">Extend</option>
            <option value="restyle">Restyle</option>
            <option value="retry-agent">Try another agent</option>
          </select>

          <label className="mt-3 block text-[11px] font-semibold text-Cr-text-subtler-v2">Prompt / instruction</label>
          <textarea
            value={canvasCommand}
            onChange={(event) => onCommandChange(event.target.value)}
            rows={5}
            className="mt-1 w-full resize-none rounded-lg-v2 border border-white/10 bg-[#171821] p-2 text-xs leading-5 outline-none placeholder:text-Cr-text-subtlest-v2"
            placeholder="Describe how this selected node should change"
          />

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onRunSelected}
              disabled={submitting}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-dreamy-brand-hot-v2 px-2 text-xs font-semibold text-white disabled:bg-white/[0.06] disabled:text-Cr-text-subtlest-v2"
            >
              <Wand2 size={14} />
              Run
            </button>
            <button
              type="button"
              onClick={onDuplicateSelected}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-white/[0.06] px-2 text-xs font-semibold active:bg-white/10"
            >
              <Copy size={14} />
              Duplicate
            </button>
            <button
              type="button"
              onClick={onAddAgent}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-white/[0.06] px-2 text-xs font-semibold active:bg-white/10"
            >
              <Plus size={14} />
              Agent
            </button>
            <button
              type="button"
              onClick={onDeleteSelected}
              disabled={selectedNode.id === 'prompt-root' || selectedNode.id === 'timeline-output'}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-white/[0.06] px-2 text-xs font-semibold text-Cr-text-critical-default-v2 active:bg-white/10 disabled:opacity-40"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>

          <div className="mt-3 rounded-xl-v2 border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-Cr-text-subtler-v2">
            <div className="font-semibold text-Cr-text-subtle-v2">Selected route</div>
            <div className="mt-1">Bot: {selectedNode.botName || selectedNode.title}</div>
            <div>Slug: {selectedNode.botSlug || selectedNode.agentId || 'canvas-node'}</div>
            <div>Source: {selectedNodeSegment?.id || 'none'}</div>
          </div>
        </div>
      ) : (
        <div className="p-3 text-xs text-Cr-text-subtler-v2">Select a node to edit it.</div>
      )}
    </aside>
  );
}

export function CanvasBotCatalogModal({
  open,
  presets,
  onClose,
  onSelectPreset,
}: {
  open: boolean;
  presets: StudioStarterPreset[];
  onClose: () => void;
  onSelectPreset: (preset: StudioStarterPreset) => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5" role="dialog" aria-modal="true">
      <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg-v2 border border-white/10 bg-[#111219] shadow-2xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <div>
            <div className="text-sm font-semibold">Dreamy Bot Catalog</div>
            <div className="text-[11px] text-Cr-text-subtler-v2">{presets.length} selectable Dreamy bots</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md-v2 bg-white/[0.06] active:bg-white/10"
            aria-label="Close bot catalog"
          >
            <X size={15} />
          </button>
        </div>
        <div className="grid gap-3 overflow-y-auto p-4 sm:grid-cols-2">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelectPreset(preset)}
              className="grid min-h-[132px] grid-cols-[118px_minmax(0,1fr)] overflow-hidden rounded-md-v2 border border-white/10 bg-white/[0.03] text-left active:bg-white/[0.08]"
            >
              <span className="relative h-full min-h-[132px] bg-black/30">
                <img src={preset.visualUrl} alt="" className="h-full w-full object-contain" />
                <span className="absolute bottom-2 left-2 rounded-md-v2 bg-black/70 px-2 py-1 text-[10px] font-semibold text-white">
                  {preset.workflow}
                </span>
              </span>
              <span className="flex min-w-0 flex-col p-3">
                <span className="truncate text-sm font-semibold">{preset.title}</span>
                <span className="mt-1 line-clamp-2 text-xs leading-5 text-Cr-text-subtler-v2">{preset.recommendation}</span>
                <span className="mt-auto truncate text-[11px] font-semibold text-dreamy-brand-hot-v2">{preset.botSlug}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
