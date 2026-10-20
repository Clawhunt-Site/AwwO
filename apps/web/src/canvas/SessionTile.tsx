// THE tile. On this canvas the node IS the agent session, so this component is the product: a
// live agent conversation rendered inside a box on an infinite canvas.
//
// Three things make it work at canvas scale:
//
//  1. LEVEL OF DETAIL. The tile draws one of four faces chosen by ./lod from its EFFECTIVE pixel
//     height (node.h * scale), not from zoom alone:
//       glance — identity only: kind glyph, title, status dot, and the persisted preview line.
//       card   — the head plus the last 3 turns.
//       open   — the head, 12-turn tail, composer, contract tabs and actions.
//       focus  — the whole scrollback and composer, regardless of zoom (an explicit intent
//                outranks the size heuristic).
//
//  2. PER-NODE SUBSCRIPTION. The transcript lives in the module-level store (./sessions) and this
//     tile subscribes to ITS OWN node slice through useSyncExternalStore. One tile streaming must
//     never re-render the rest of the canvas — with hundreds of tiles that is the difference
//     between a live canvas and a slideshow. It also means a culled-and-remounted tile shows the
//     real transcript again instead of a blank box.
//
//  3. EVENT CLAIMING. Pointer presses inside a tile never reach the viewport (typing and dragging
//     must not pan the canvas), and wheel events over the tile's own scrollable regions scroll
//     them instead of zooming the canvas.
//
// Honesty invariants rendered here (do not weaken):
//  - The run badge shows a BLOCKED node's REASON, not the bucket word: "上游未完成" is what the
//    operator needs; "被阻断" alone hides which upstream failed.
//  - `bindAttempt === 'unknown'` renders as an amber 绑定待确认 chip — an attempt whose outcome was
//    lost must keep warning, because a blind retry could hire a duplicate agent.
//  - An unbound tile's composer is disabled with the reason stated, never a live-looking box.
//  - Unknown runtime/model/effort remain unset; a compact setup hint invents no selection.

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, ArrowDownToLine, BookOpen, Bot, Box, ChevronRight, Clapperboard, Clock, Code2, FileText, Image, Layers, Loader2, Maximize2, MessageSquare, Minimize2, MonitorPlay, MoreHorizontal, Music, PanelLeftClose, PanelLeftOpen, PanelRight, Play, Plus, Settings2, Square, SquareArrowOutUpRight, Trash2, Video, X } from 'lucide-react';
import { displayText } from './displayCopy';
import { parseMediaOutput } from './mediaOutput';
import { deliveryJsonSource } from './deliveryJson';
import { mediaOutputCount, mediaOutputSummaryKey } from './MediaResult';
import { mediaKindOf, type MediaKind } from './mediaCatalog';
import { nodeModelName, unlistedModelLabel, type ModelNameSources } from './modelNames';
import { AGENT_KIND_META, type CanvasNode, type SessionNode } from './canvasDoc';
import { TAIL_LINES, lodFor, type TileLod } from './lod';
import type { RunNodeStatus } from './runGraph';
import { getSnapshot, subscribe, type NodeSession, type Turn } from './sessions';
import { restoreHistory, sendMessage, statusLabel } from './sessionTransport';
import { mediaComposerInfo, TileComposer } from './TileComposer';
import type { UploadCounts } from './ComposerAttachments';
import { joinAttachments, splitAttachments } from './attachments';
import { TilePorts, type WiringApi } from './TilePorts';
import { TileTranscript } from './TileTranscript';
import { MediaWiringGuide } from './MediaWiringGuide';
import { collaborationInputSummary, htmlPreviewSummary } from './readableTranscript';
import { ContractFields } from './ContractFields';
import { emptyContract, type ContractField } from './nodeContracts';
import { NodeDeliverables } from './NodeDeliverables';
import { AssembleTileBody } from './AssembleTileBody';
import { EditTileBody, editPreview } from './EditTileBody';
import type { AssembleInputView } from './assembleNode';
import { ReworkFindingsNote } from './ReworkFindingsNote';
import { NodeBrief, NodeFailure } from './NodeBrief';
import { useShortColumn } from './useShortColumn';
import { getAgentTemplateForNode } from './agentTemplates';
import { AgentGlyph, AgentTemplateDetails } from './AgentTemplateDetails';
import { activeNodeThread, getNodeThreads, createNodeThread, selectNodeThread, updateNodeDraft, sessionStoreKey } from './nodeThreads';
import { prepareNodeConversation, type NodeConversationContext } from './nodeConversation';
import './awwo-node.css';
import { NodeViewStylePicker } from './NodeViewStylePicker';
import { currentChoiceKey, modelChoiceKey, NodeModelPicker, type NodeModelChoice } from './NodeModelPicker';
import { useSimpleCanvas } from './uiMode';
import { CardPreview } from './CardPreview';
import { showsPreview } from './cardFrames';
import type { StudioEntry } from './studio/studioModel';
import { canvasText, useCanvasI18n, type CanvasTextKey, type CanvasTranslate } from './i18n';
import { recoveryDetailMessage } from './surfaceMessages';
import { deliverablesShown, openContentOf, type OpenContent } from './nodePresentation';
import { nodeTeamModeLabel } from './NodeTeamEditor';
import type { UiLocale } from '../locale';

/** Smallest a tile may be dragged to. Below this the head itself stops being readable. */
/** Below this much travel a press is a click, not a drag (in SCREEN px, before scale). */
const DRAG_THRESHOLD_PX = 3;

/** A conversation's title in the reader's words: the server names the ones it makes "Session 2", "Session 3" … */
function threadTitle(title: string | undefined, t: CanvasTranslate): string {
  const numbered = /^Session (\d+)$/.exec(title?.trim() ?? '');
  return numbered ? t('tile.threadNumber', { count: Number(numbered[1]) }) : title?.trim() || t('tile.threadNumber', { count: 1 });
}

/** The share of an opened node's width its delivery drawer takes, by what the node mostly shows (openContentOf). */
const DRAWER_WIDTH: Record<OpenContent, string> = { page: '62%', media: '48%', delivery: '52%', chat: '38%' };

/** What a node's output form holds, field by field: the same for the node this page edited and for one read back from
 *  elsewhere (the server's store orders an object's keys its own way). */
const outputFormKey = (node: SessionNode) => JSON.stringify((node.contract?.outputs ?? [])
  .map(field => [field.id, field.label, field.type, field.required, field.value, field.help ?? '', field.placeholder ?? '']));

/** What an image, video or 3D node that has not generated yet asks for (its empty state's title). */
const MEDIA_EMPTY_TITLE: Record<MediaKind, CanvasTextKey> = {
  image: 'media.emptyImage', video: 'media.emptyVideo', model3d: 'media.emptyModel3d', audio: 'media.emptyAudio',
};

/** How a press on a tile changes the selection — see SessionTileProps.onSelect. */
export type SelectMode = 'only' | 'additive' | 'preserve';

export const MIN_TILE_W = 220;
export const MIN_TILE_H = 140;

/** Below this zoom a compact card's state chip is too small to read (see `data-zoom` on the tile). */
export const COMPACT_CHIP_MIN_SCALE = 0.8;

export const TILE_COPY = {
  bound: '已连接',
  bindPending: '绑定待确认',
  unbound: '草稿',
  runWaiting: '排队',
  runRunning: '运行中',
  runDone: '✓完成',
  runFailed: '失败',
  runBlocked: '被阻断',
  unset: '未选择',
  configure: '配置',
  focus: '聚焦',
  remove: '删除',
  formGlyph: 'F',
  formLabel: '表单',
  emptyField: '（未填写）',
  output: '产出',
  outputPartial: '产出（未完成，仅部分）',
  outputManual: '手动采用 · ',
} as const;

/** "just now" / "3 分钟前" / "2 小时前" — enough to tell a fresh result from a stale one. */
function relativeAge(at: number, now: number, locale: UiLocale = 'zh'): string {
  if (!at) return '';
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return canvasText(locale, 'time.justNow');
  const mins = Math.round(secs / 60);
  if (mins < 60) return canvasText(locale, 'time.minutesAgo', { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return canvasText(locale, 'time.hoursAgo', { count: hours });
  return canvasText(locale, 'time.daysAgo', { count: Math.round(hours / 24) });
}

type DotState = 'idle' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';

function dotStateFor(session: NodeSession, run: RunNodeStatus | null): DotState {
  if (session.streaming) return 'running';
  if (!run) return 'idle';
  if (run.state === 'running') return 'running';
  if (run.state === 'done') return 'done';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'blocked') return 'blocked';
  if ((run.state as string) === 'cancelled') return 'cancelled';
  return 'idle';
}

/** The run badge's visible text. A blocked node shows its REASON, never the bucket word. */
export function runBadgeText(
  run: RunNodeStatus,
  locale: UiLocale = 'zh',
  translate: CanvasTranslate = (key, values) => canvasText(locale, key, values),
): string {
  const detail = recoveryDetailMessage(translate, run.detail);
  if ((run.state as string) === 'cancelled') return detail || canvasText(locale, 'tile.cancelled');
  switch (run.state) {
    case 'waiting':
      // A cloud node waiting for its next automatic attempt after a transient failure says which one it is.
      if (run.detail === 'retrying') {
        return run.attempts && run.retryLimit ? translate('tile.retrying', { attempt: run.attempts, limit: run.retryLimit }) : detail || canvasText(locale, 'tile.queued');
      }
      return canvasText(locale, 'tile.queued');
    case 'running':
      return canvasText(locale, 'tile.running');
    case 'done':
      return canvasText(locale, 'tile.completed');
    case 'failed':
      return canvasText(locale, 'tile.failed');
    case 'blocked':
      return detail || canvasText(locale, 'tile.blocked');
    case 'cached':
      return canvasText(locale, 'tile.cached');
    default:
      return '';
  }
}

/** An image or video result reads as what it is, in the reader's language. */
function mediaPreview(raw: string, locale: UiLocale): string | null {
  const media = parseMediaOutput(raw);
  return media ? canvasText(locale, mediaOutputSummaryKey(media), { count: mediaOutputCount(media) }) : null;
}

/** Summarize declared JSON delivery values; ordinary transcript text keeps its last line. A media
 *  locale is given only for an image or video node, whose results read as generated files. */
function livePreview(turns: ReadonlyArray<Turn>, outputs: ReadonlyArray<Pick<ContractField, 'id'>> = [], displayLocale?: UiLocale, mediaLocale?: UiLocale): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const raw = turns[i].text;
    if (!raw) continue;
    const media = turns[i].role === 'agent' && mediaLocale ? mediaPreview(raw, displayLocale || mediaLocale) : null;
    if (media) return media;
    if (displayLocale) {
      const summary = collaborationInputSummary(turns[i], displayLocale)
        || (turns[i].role === 'agent' ? htmlPreviewSummary(raw, displayLocale) : null);
      if (summary) return summary;
    }
    if (turns[i].role === 'agent' && outputs.length) {
      try {
        const parsed: unknown = JSON.parse(deliveryJsonSource(raw));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const values = parsed as Record<string, unknown>;
          for (const field of outputs) {
            if (!Object.hasOwn(values, field.id)) continue;
            const value = values[field.id];
            if (displayLocale && typeof value === 'string') {
              const summary = htmlPreviewSummary(value, displayLocale);
              if (summary) return summary;
            }
            if (typeof value !== 'string' && typeof value !== 'boolean'
              && !(typeof value === 'number' && Number.isFinite(value))) continue;
            const line = String(value).split('\n').map(part => part.trim()).find(Boolean);
            if (line) return line;
          }
        }
      } catch {
        // Plain Markdown and incomplete JSON retain the existing transcript preview.
      }
    }
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) return lines[lines.length - 1];
  }
  return '';
}

/** The overview shows a published result before any newer chat snippet. */
function firstMeaningfulLine(value: string): string {
  // A fenced code delivery opens with its fence and often a lone brace; neither says anything about it.
  const code = /^\s*(?:```|~~~)/.test(value);
  const lines = value.split(/\\n|\r?\n/).map(line => line.trim())
    .filter(line => line && !(code && (/^(?:```|~~~)/.test(line) || /^[[\]{}(),;]+$/.test(line))));
  // Section labels are useful in the full delivery, but the overview should lead with its
  // content. Keep a readable title as the fallback when no body has arrived yet.
  const body = lines.filter(line => !/^#{1,6}(?:\s|$)/.test(line) && !/^\*\*[^*]+\*\*[:：]?$/.test(line));
  const candidates = body.length ? body : lines;
  const first = candidates[0] || '';
  const selected = /[:：]$/.test(first) ? (candidates[1] || first) : first;
  const text = /^#{1,6}(?:\s|$)/.test(selected)
    ? selected.replace(/^#{1,6}(?:\s+|$)/, '').replace(/\s+#+\s*$/, '') : selected;
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}

function publishedPreview(raw: string, outputs: ReadonlyArray<Pick<ContractField, 'id'>>, locale: UiLocale, media = false): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const generated = media ? mediaPreview(trimmed, locale) : null;
  if (generated) return generated;
  try {
    const parsed: unknown = JSON.parse(deliveryJsonSource(trimmed));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = parsed as Record<string, unknown>;
      for (const id of outputs.length ? outputs.map(field => field.id) : ['result', 'output', 'text']) {
        const value = values[id];
        if (typeof value !== 'string') continue;
        const summary = htmlPreviewSummary(value, locale) || firstMeaningfulLine(value);
        if (summary) return summary;
      }
    }
  } catch {
    // Historical results can contain JSON-shaped text with unescaped quotes inside the value.
    // Only extract its first visible line for the card; the full raw payload stays in Deliverables.
    const looseField = trimmed.match(/^\s*\{\s*"(?:result|output|text)"\s*:\s*"([\s\S]*)$/);
    if (looseField) {
      const first = firstMeaningfulLine(looseField[1]).replace(/"\s*\}\s*$/, '');
      if (first) return first;
    }
  }
  return htmlPreviewSummary(trimmed, locale) || firstMeaningfulLine(trimmed);
}

function glyphOf(node: CanvasNode, locale: UiLocale): { glyph: string; kindClass: string; label: string } {
  if (node.kind === 'form') return { glyph: TILE_COPY.formGlyph, kindClass: 'form', label: canvasText(locale, 'tile.form') };
  if (node.kind === 'assemble') return { glyph: '⧉', kindClass: 'assemble', label: canvasText(locale, 'tile.assemble') };
  if (node.kind === 'edit') return { glyph: '✂', kindClass: 'edit', label: canvasText(locale, 'tile.edit') };
  const meta = AGENT_KIND_META[node.agentKind];
  const label = canvasText(locale, node.agentKind === 'coding' ? 'node.coding' : node.agentKind === 'image' ? 'node.image' : node.agentKind === 'video' ? 'node.video' : node.agentKind === 'model3d' ? 'node.model3d'
    : node.agentKind === 'audio' ? 'node.audio' : 'node.llm');
  return { glyph: meta.glyph, kindClass: node.agentKind, label };
}

export interface SessionTileProps {
  /** SaaS host prepares draft nodes before accepting their first turn. */
  initializeOnSend?: boolean;
  /** SaaS chat sends the current message; task execution uses the separate contract action. */
  freeConversation?: boolean;
  renderTurnDetails?: (node: CanvasNode, turn: Turn, latest: boolean) => ReactNode;
  /** A currently admitted graph run has its own identity, independent of historical messages. */
  renderCurrentRunDetails?: (node: CanvasNode) => ReactNode;
  node: CanvasNode;
  /** View geometry stays separate from persisted workspace dimensions. */
  geometry?: { x: number; y: number; w: number; h: number };
  compact?: boolean;
  /** Current viewport scale — half of the LOD input (the other half is the node's own height). */
  scale: number;
  focused: boolean;
  selected?: boolean;
  /** This node's state in the current graph run, if any. */
  run?: RunNodeStatus | null;
  /** Wiring API from `useWiring` — omitted leaves the port handles visible but inert. */
  wiring?: WiringApi;
  /** Gateway base for the DEFAULT send path (sessionTransport.sendMessage). */
  gatewayBase?: string;
  /** Persist a server-minted issueId onto this node (the next turn must continue the thread). */
  onIssueId?: (nodeId: string, issueId: string, threadId?: string) => void;
  /**
   * Persist the transcript preview onto the node. The glance LOD renders `node.preview`,
   * which is the ONLY thing a far-away tile can show before its history is fetched — so it has
   * to be written when the transcript settles, or every tile reads blank after a reload.
   */
  onPreview?: (nodeId: string, preview: string, threadId?: string) => void;
  onDraftChange?: (nodeId: string, threadId: string, draft: string) => void;
  configurationPanel?: ReactNode;
  interactionLocked?: boolean;
  /** Viewing history does not grant edit, send, or publication permission. */
  readOnly?: boolean;
  /** Cloud execution prerequisite: preserve the editable draft, but prevent sending. */
  sendUnavailableReason?: string;
  onFitNode?: (nodeId: string) => void;
  onToggleDeliverables?: (nodeId: string, open: boolean) => void;
  /** Override the send path (tests / a host that owns the transport). */
  onSend?: (node: SessionNode, text: string, onAccepted?: () => void, displayText?: string) => void;
  /** Current graph-resolved inputs; absent uses this node's local contract values only. */
  conversationContext?: NodeConversationContext;
  /** An assemble node's inputs as its slots will read them now (assembleInputViews). */
  assembleInputs?: ReadonlyArray<AssembleInputView>;
  onMove?: (nodeId: string, x: number, y: number) => void;
  onResizeNode?: (nodeId: string, w: number, h: number) => void;
  /**
    * How a press on this tile should change the selection.
    *  - 'additive'  shift/meta-click: toggle this node in or out of the group.
    *  - 'preserve'  a plain press on a node that is ALREADY selected: keep the group, because the
    *                press might be the start of dragging all of it.
    *  - 'only'      that press turned out to be a click, not a drag: collapse to this node.
    * Without 'preserve' a group can never be dragged — pressing any member would collapse the
    * selection to it before the drag even began.
    */
   onSelect?: (nodeId: string, mode: SelectMode) => void;
  /** Double-click / the action row's 聚焦 button. */
  onToggleFocus?: (nodeId: string) => void;
  onConfigure?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  /** The document owner records edits and preserves undo/redo and run locks. */
  onUpdateNode?: (node: CanvasNode) => void;
  /** A part of the node this card changed (its inputs, its outputs, a result published by hand), which the document owner
   *  applies to the node as its document holds it and records as onUpdateNode does. */
  onPatchNode?: (nodeId: string, change: (node: SessionNode) => SessionNode) => void;
  onRunNode?: (nodeId: string) => void;
  /** Models this node's chat can switch to, shown as a picker in its composer (a stable array per node kind). */
  modelChoices?: ReadonlyArray<NodeModelChoice>;
  /** Switch the node to the model with this choice key; the host applies its configuration rules. */
  onChangeModel?: (nodeId: string, key: string) => void;
  /** Resize the card on the board (a view preference, allowed while the canvas runs and for readers). */
  onResizeCard?: (nodeId: string, w: number, h: number) => void;
  /** Enlarge the card to preview its deliverable, or shrink it back. */
  onToggleCardPreview?: (nodeId: string) => void;
  /** Open the results studio on this node's deliverables (optionally on one file). */
  onOpenStudio?: (nodeId: string, entryId?: string) => void;
  /** Show this node's deliverables in a 预览展示 window on the board (the one already showing it, or a new one). */
  onShowInDisplay?: (nodeId: string) => void;
  /** Every file of the canvas, so a previewed page can show what other nodes made. */
  canvasEntries?: ReadonlyArray<StudioEntry>;
  /** Stop this node's own run (its lane), leaving every other running node alone. */
  onStopNode?: (nodeId: string) => void;
  /** Bumped to open this node's input drawer (the assistant's 「去填写」 step), in either mode. */
  inputRequest?: number;
  /** Hand this node to the canvas assistant: 'edit' starts a request to change it, 'fix' asks it to make a failed node
   *  finish. The simple view's way to change a node, without its settings. */
  onAskAssistant?: (nodeId: string, kind: 'edit' | 'fix') => void;
  /** Whether the opened node's delivery drawer sits beside its conversation (it opens by itself only then). */
  deliveryBeside?: boolean;
  /** What the canvas names models by, for a node whose model its choices do not list (a read-only canvas). */
  modelNames?: ModelNameSources;
}

/**
 * Memoised: the tile's props are all referentially stable across an unrelated node's update
 * (the canvas keeps node objects immutable — a moved or edited node is a NEW object, untouched
 * nodes keep their reference). Without this, every keystroke in one tile's composer would
 * re-render every other tile on the canvas.
 */
export const SessionTile = memo(function SessionTile({
  node: sourceNode,
  initializeOnSend = false,
  geometry,
  compact = false,
  scale,
  focused,
  selected = false,
  run = null,
  wiring,
  gatewayBase,
  onIssueId,
  onPreview,
  onDraftChange,
  configurationPanel,
  interactionLocked = false,
  readOnly: viewOnly = false,
  sendUnavailableReason,
  onToggleDeliverables,
  onSend,
  conversationContext,
  freeConversation = false,
  renderTurnDetails,
  renderCurrentRunDetails,
  onMove,
  onResizeNode,
  onSelect,
  onToggleFocus,
  onConfigure,
  onDelete,
  onUpdateNode,
  onPatchNode,
  onRunNode,
  modelChoices,
  onChangeModel,
  onResizeCard,
  onToggleCardPreview,
  onOpenStudio,
  onShowInDisplay,
  canvasEntries,
  onStopNode,
  inputRequest = 0,
  onAskAssistant,
  deliveryBeside = true,
  modelNames,
  assembleInputs,
}: SessionTileProps) {
  const { locale, t } = useCanvasI18n();
  const simple = useSimpleCanvas();
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  // History selection is an in-memory projection, never a document or draft write.
  const [viewThreadId, setViewThreadId] = useState<string | null>(null);
  const node = useMemo(() => viewOnly && sourceNode.kind === 'session' && viewThreadId
    ? selectNodeThread(sourceNode, viewThreadId) : sourceNode, [sourceNode, viewOnly, viewThreadId]);
  const nodeId = node.id;
  const frame = geometry ?? node;
  const currentThread = node.kind === 'session' ? activeNodeThread(node) : null;
  const storeKey = node.kind === 'session' ? sessionStoreKey(node) : nodeId;
  const sub = useCallback((cb: () => void) => subscribe(storeKey, cb), [storeKey]);
  const snap = useCallback(() => getSnapshot(storeKey), [storeKey]);
  const session = useSyncExternalStore(sub, snap, snap);
  // A copied case node not yet set up has said and run nothing: open, it leads with what it was asked and received.
  const [inputOpen, setInputOpen] = useState(node.kind === 'session' && node.lastOutput?.source === 'case' && !node.binding);
  const [templateOpen, setTemplateOpen] = useState(false);
  // The node's own work: a run of it, or a reply streaming in (`busy` below adds a lock the canvas holds for all nodes).
  const active = session.streaming || run?.state === 'running' || run?.state === 'waiting';
  // Opened inputs take the conversation's room only until the node starts or ends some work: what a run or a message
  // brings is read in the conversation, which keeps the column beside the inputs until they are opened again (review
  // 2026-10-18: a run's reply vanished as it finished). Before paint, so the end of a run never shows the inputs a frame.
  const [inputsTakeColumn, setInputsTakeColumn] = useState(true);
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    if (wasActive.current !== active) setInputsTakeColumn(false);
    wasActive.current = active;
  }, [active]);
  // Asked to show the inputs (a run still needs some filled in): the drawer opens on their values.
  useEffect(() => {
    if (!inputRequest) return;
    setTemplateOpen(false); setInputSchemaOpen(false); setInputOpen(true); setInputsTakeColumn(true);
  }, [inputRequest]);
  // Opened from the template guide's 编辑: the input drawer starts on its field structure, the deliverables drawer on
  // its form editor. Each resets when its drawer closes, so opening it the ordinary way shows values as before. The
  // drawer's own structure toggle sets inputSchemaOpen too: the fields change mode without being mounted anew.
  const [inputSchemaOpen, setInputSchemaOpen] = useState(false);
  // Uploads in the inputs' fields that are not files in them yet (going, waiting to be added, or failed). Closed inputs
  // that still hold some only hide their fields: unmounted, the fields would end those uploads (ComposerAttachments).
  const [inputUploads, setInputUploads] = useState<UploadCounts>({ pending: 0, waiting: 0, failed: 0 });
  const onInputUploads = useCallback((next: UploadCounts) => setInputUploads(previous =>
    previous.pending === next.pending && previous.waiting === next.waiting && previous.failed === next.failed ? previous : next), []);
  const inputDrawerRef = useRef<HTMLElement>(null);
  const inputHeldNoteId = useId();
  const inputToggleRef = useRef<HTMLButtonElement>(null);
  const sessionInputRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [deliverablesEditorOpen, setDeliverablesEditorOpen] = useState(false);
  // Each press of the template guide's 编辑 opens the editor, also after the reader collapsed it.
  const [deliverablesEditorRequest, setDeliverablesEditorRequest] = useState(0);
  const template = node.kind === 'session' ? getAgentTemplateForNode(node, locale) : undefined;
  // A node that has delivered opens with its delivery beside the conversation unless the reader closed it there
  // (deliverablesShown).
  const drawerShown = deliverablesShown(node, deliveryBeside);
  const [deliverablesOpen, setDeliverablesOpen] = useState(drawerShown);
  // An edit of the drawer's form in progress (updateDeliverables) since the node last showed a delivery, which an edit of
  // it takes back until the form is published again (invalidateOutputs): the output form it left, its conversation, and
  // whether the node showed a delivery when it began, whose share of the width it keeps (below). It ends when a delivery
  // is back, when the form or the conversation changes under it (an undo, a new conversation, an edit the canvas refused),
  // and when the node closes or starts work (below).
  const [formEdit, setFormEdit] = useState<{ form: string; thread: string; share: boolean } | null>(null);
  const editing = formEdit && node.kind === 'session' && !node.lastOutput && currentThread?.id === formEdit.thread
    && outputFormKey(node) === formEdit.form ? formEdit : null;
  // Before paint: a drawer that should not show on this stage must not flash open for a frame. Nor does an edit of its
  // form close it: a drawer that opened by itself for the delivery the edit took back would close under the reader's
  // keystroke, its form editor with it. It stays open as the reader has it, and nothing is recorded, so the drawer's own
  // rule is unchanged for the publication and after it.
  useLayoutEffect(() => {
    if (!drawerShown && editing) return;
    setDeliverablesOpen(drawerShown);
    if (!drawerShown) setDeliverablesEditorOpen(false);
  }, [drawerShown]);
  // The Session list starts collapsed so an opened node leads with its conversation; the chat
  // heading keeps the expand control and the list keeps its collapse control.
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const composerDraft = localDrafts[storeKey] ?? currentThread?.draft ?? '';
  const setComposerDraft = (value: string) => {
    if (viewOnlyRef.current) return;
    setLocalDrafts(previous => ({ ...previous, [storeKey]: value }));
    if (node.kind !== 'session' || !currentThread) return;
    if (onDraftChange) onDraftChange(nodeId, currentThread.id, value);
    else onUpdateNode?.(updateNodeDraft(node, value));
  };
  const lod: TileLod = compact ? 'card' : lodFor(frame, scale, focused);
  // Zoomed out past this, a compact card's 11px state chip is under 9px on screen: `data-zoom="far"` lets the
  // card hide the chips its dot, ring and border already show and give the row to the title.
  const zoomedOut = compact && scale < COMPACT_CHIP_MIN_SCALE;
  const rootRef = useRef<HTMLDivElement>(null);
  // The overflow menu closes when the pointer goes down anywhere outside its card (the canvas, another
  // card, a rail). Pressing inside the card, e.g. to drag it, leaves the menu open. Capture phase, because
  // canvas gestures stop propagation before the event would bubble to the document.
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [menuOpen]);
  // The live view scale, read inside pointer gestures so a mid-drag zoom stays correct.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Wheel claiming. Scrolling inside the tile's own scrollable regions (the transcript, the
  // composer) must scroll THEM, not zoom the canvas; the viewport's native wheel listener would
  // otherwise swallow it, since the tile is its descendant. Over the tile's chrome the canvas
  // still zooms — a canvas you cannot zoom over its own contents is worse than one you can.
  // A focused tile claims every wheel: focus is an explicit "I am working in here".
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      const inScroller = Boolean(t?.closest?.('.canvas-transcript-scroll, .canvas-composer-input, .awwo-node-panel, .awwo-contract-fields, .awwo-session-list, .awwo-deliverables, .canvas-inspector, .awwo-card-preview-doc, .awwo-card-preview-text, .awwo-model-stage'));
      if (inScroller || focusedRef.current) e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag-to-move. Window listeners (so the drag survives the pointer leaving the tile) and the
  // new position reported in WORLD coords (screen delta / live scale).
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Always claim left presses on a tile, even when it is not draggable: letting the press
      // reach the viewport would setPointerCapture there and retarget this tile's own
      // click/dblclick to the background in a real browser.
      if (e.button === 0) e.stopPropagation();
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      onSelect?.(nodeId, additive ? 'additive' : 'preserve');
      if (viewOnlyRef.current || e.button !== 0 || !onMove) return;
      // A press that lands on a control or a scrollable region is that control's, not a drag.
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('button, textarea, input, select, a, summary, .canvas-transcript-scroll, .awwo-contract-fields, .awwo-deliverables, .canvas-inspector, .awwo-card-preview-body')) return;
      const px = e.clientX;
      const py = e.clientY;
      const ox = node.x;
      const oy = node.y;
      // A press is only a DRAG once it travels past a small threshold; below it the gesture is
      // a click, and a click on a member of a group collapses the selection to that member (the
      // behaviour every canvas tool has: press-to-drag-the-group, click-to-pick-one).
      let dragged = false;
      const move = (pe: PointerEvent) => {
        if (!dragged && (Math.abs(pe.clientX - px) > DRAG_THRESHOLD_PX || Math.abs(pe.clientY - py) > DRAG_THRESHOLD_PX)) {
          dragged = true;
        }
        if (viewOnlyRef.current || !dragged) return;
        const s = scaleRef.current || 1;
        onMove(nodeId, ox + (pe.clientX - px) / s, oy + (pe.clientY - py) / s);
      };
      const up = () => {
        if (!dragged && !additive) onSelect?.(nodeId, 'only');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [nodeId, node.x, node.y, onMove, onSelect],
  );

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      if (viewOnlyRef.current || e.button !== 0 || !onResizeNode) return;
      const px = e.clientX;
      const py = e.clientY;
      const ow = frame.w;
      const oh = frame.h;
      const move = (pe: PointerEvent) => {
        if (viewOnlyRef.current) return;
        const s = scaleRef.current || 1;
        onResizeNode(
          nodeId,
          Math.max(MIN_TILE_W, ow + (pe.clientX - px) / s),
          Math.max(MIN_TILE_H, oh + (pe.clientY - py) / s),
        );
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [nodeId, frame.w, frame.h, onResizeNode],
  );

  // Resizing a CARD (not an opened node) is a view preference: it works for readers and while the canvas runs.
  const onCardResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      if (e.button !== 0 || !onResizeCard) return;
      e.preventDefault();
      const px = e.clientX;
      const py = e.clientY;
      const ow = frame.w;
      const oh = frame.h;
      const move = (pe: PointerEvent) => {
        const s = scaleRef.current || 1;
        onResizeCard(nodeId, ow + (pe.clientX - px) / s, oh + (pe.clientY - py) / s);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [nodeId, frame.w, frame.h, onResizeCard],
  );

  // Restore THIS node's own stored thread, once, as soon as the tile is showing a transcript at
  // all. Without this a bound node with a real server-side conversation renders "还没有对话" after
  // every reload — an absent history presented as "nothing was ever said", which is the one thing
  // this canvas is not allowed to do. Guarded on the STORE's history state, not component state,
  // so panning a tile out of view and back does not refetch, and two tiles never race.
  const sessionNode = node.kind === 'session' ? node : null;
  const currentRunDetails = renderCurrentRunDetails?.(node);
  const boundAgentId = sessionNode?.binding?.agentId ?? null;
  const threadId = sessionNode?.issueId ?? null;
  const sessionRef = useRef(sessionNode);
  sessionRef.current = sessionNode;
  // The "already fetched?" guard is read through a REF, never a dependency: restoreHistory's first
  // act is to set history='loading', which would re-run an effect that depended on it — and the
  // re-run's cleanup would abort the very fetch it just started, stranding history at 'loading'
  // with nothing to retry.
  const historyRef = useRef(session.history);
  historyRef.current = session.history;
  useEffect(() => {
    const target = sessionRef.current;
    if (!target || lod === 'glance') return;
    if (!gatewayBase || !boundAgentId || !threadId) return;
    if (historyRef.current !== 'unloaded') return;
    // Deliberately NOT abortable. The transcript store outlives this component by design (tiles
    // are culled and remounted by the viewport), so letting an in-flight restore finish is the
    // correct behaviour — and cancelling it on unmount would leave history stuck at 'loading'
    // for a tile the user merely panned away from.
    void restoreHistory({ gatewayBase, node: target });
    // The node object itself is deliberately not a dependency: only the identity fields below
    // matter, and re-running on every position change would refetch during a drag.
  }, [boundAgentId, threadId, storeKey, gatewayBase, lod]);

  // Persist the transcript preview for the glance LOD, but only once the stream has settled —
  // writing mid-stream would put a document save on every delta frame.
  const mediaNode = Boolean(sessionNode && mediaKindOf(sessionNode.agentKind));
  // An image, video or 3D node that has not generated yet says what to write and how to wire it.
  const mediaKind = sessionNode && !sessionNode.contract ? mediaKindOf(sessionNode.agentKind) ?? null : null;
  const liveTail = livePreview(session.turns, sessionNode?.contract?.outputs, undefined, mediaNode ? locale : undefined);
  const storedPreview = sessionNode?.preview ?? null;
  useEffect(() => {
    if (viewOnlyRef.current || storedPreview === null || !onPreview) return;
    if (session.streaming) return;
    if (!liveTail || liveTail === storedPreview) return;
    onPreview(nodeId, liveTail, currentThread?.id);
  }, [nodeId, onPreview, session.streaming, liveTail, storedPreview, currentThread?.id]);

  const preparedConversation = useMemo<NodeConversationContext>(
    () => node.kind === 'session' && node.contract
      ? conversationContext ?? prepareNodeConversation(node)
      : { messagePrefix: '' },
    [node, conversationContext],
  );
  const conversationError = freeConversation ? undefined : preparedConversation.error;
  const send = useCallback(
    (text: string, onAccepted?: () => void) => {
      if (viewOnlyRef.current || node.kind !== 'session' || interactionLocked || sendUnavailableReason?.trim()) return;
      if (conversationError) {
        // The composer normally blocks before clearing. Retain the user's text if readiness
        // changes at the send boundary or a host invokes the callback directly.
        setComposerDraft(text);
        return;
      }
      const message = !freeConversation && preparedConversation.messagePrefix
        ? `${preparedConversation.messagePrefix}\n\n${t('conversation.userMessageHeader')}\n${text}`
        : text;
      if (onSend) {
        onSend(node, message, onAccepted, text);
        return;
      }
      // Default path: one turn on THIS node's own thread, streamed into the shared store.
      if (!gatewayBase) return;
      void sendMessage({
        gatewayBase,
        node,
        text: message,
        onIssueId: onIssueId ? (issueId) => onIssueId(nodeId, issueId, currentThread?.id) : undefined,
      });
      onAccepted?.();
    },
    [node, nodeId, onSend, gatewayBase, onIssueId, preparedConversation, conversationError, freeConversation, currentThread?.id, interactionLocked, sendUnavailableReason, t],
  );

  const { kindClass, label } = glyphOf(node, locale);
  const dot = dotStateFor(session, run);
  // A card that finishes or fails while you watch answers once (`is-just-done` / `is-just-failed`, a
  // short ripple in the hosted skin). Only a change from running seen while mounted counts: a card that
  // loads or re-mounts already finished stays still (one restored as running ripples when it settles).
  // The mark is read through `dot`, so it can never outlast the state it marks, even for the frame
  // before the effect clears it.
  const [justSettled, setJustSettled] = useState<'done' | 'failed' | null>(null);
  const previousDot = useRef(dot);
  useEffect(() => {
    const before = previousDot.current;
    previousDot.current = dot;
    if (before !== 'running' || (dot !== 'done' && dot !== 'failed')) { setJustSettled(null); return; }
    setJustSettled(dot);
    const timer = setTimeout(() => setJustSettled(null), 1000);
    return () => clearTimeout(timer);
  }, [dot]);
  const settledMark = justSettled === dot ? justSettled : null;
  const preview = useMemo(() => {
    if (node.kind === 'form') {
      const filled = node.fields.find((f) => f.value.trim());
      return filled ? `${filled.label || t('common.field')}: ${filled.value.trim()}` : t('tile.emptyField');
    }
    if (node.kind === 'assemble') {
      const outputs = node.contract.outputs.map(field => field.label || field.id).join(' + ');
      return t('tile.assembleSummary', { inputs: node.contract.inputs.length, outputs });
    }
    if (node.kind === 'edit') return editPreview(node, t);
    return livePreview(session.turns, node.contract?.outputs, locale, mediaKindOf(node.agentKind) ? locale : undefined) || htmlPreviewSummary(node.preview, locale) || node.preview;
  }, [node, session.turns, locale, t]);
  const compactPreview = node.kind === 'session'
    ? node.lastOutput
      ? `${node.lastOutput.partial ? `${t('tile.partialOutput')} · ` : node.lastOutput.source === 'case' ? `${t('tile.caseOutput')} · ` : ''}${publishedPreview(node.lastOutput.text, node.contract?.outputs ?? [], locale, Boolean(mediaKindOf(node.agentKind))) || t('tile.deliveryUpdated')}`
      : currentThread?.lastOutput ? t('tile.historicalAvailable')
        : publishedPreview(preview, node.contract?.outputs ?? [], locale, Boolean(mediaKindOf(node.agentKind))) || t('tile.noDeliverables')
    : preview;

  const bind =
    node.kind === 'session'
      ? node.bindAttempt === 'unknown'
        ? { cls: 'pending', text: t('tile.bindPending') }
        : node.binding
          ? { cls: 'bound', text: t('tile.bound') }
          : { cls: 'unbound', text: t('tile.draft') }
      : null;

  const output = node.lastOutput ?? null;
  // Computed at render rather than ticked: the tile already re-renders on every run status change
  // and on every transcript frame, which is far more often than this string needs to move.
  const outputAge = output ? relativeAge(output.at, Date.now(), locale) : '';

  const runDetail = run ? recoveryDetailMessage(t, run.detail) : undefined;
  // The model the node runs, as its picker names it (the task card says it); none when it runs the workspace default.
  const modelLabel = sessionNode?.model
    ? modelChoices?.find(choice => choice.key === currentChoiceKey(sessionNode, modelChoices))?.label || nodeModelName(sessionNode, modelNames ?? {}, locale)
    : undefined;
  const badge = run ? runBadgeText(run, locale, t) : '';
  const showBody = lod !== 'glance';
  const tail = TAIL_LINES[lod];
  const expanded = !compact && (Boolean(configurationPanel) || lod === 'open' || lod === 'focus');
  // A menu opened in one layout does not follow the card into another (opening or collapsing the node).
  useEffect(() => { setMenuOpen(false); }, [compact, expanded]);
  // An opened node's chat column too short to read in draws its message box and task card compact.
  const chatRef = useRef<HTMLDivElement>(null);
  const shortColumn = useShortColumn(chatRef, expanded);
  const busy = interactionLocked || active;
  useLayoutEffect(() => { if (formEdit && (!expanded || active || !editing)) setFormEdit(null); }, [formEdit, expanded, active, editing]);
  // A delivery that edit took back keeps the share of the node's width its drawer had (DRAWER_WIDTH) while the edit
  // lasts, so the form does not narrow under the reader's keystroke, as the canvas keeps the delivery's room in the node's
  // frame (CanvasSurface openFit.content).
  const shownContent = openContentOf(node);
  const drawerContent = editing?.share && shownContent === 'chat' ? 'delivery' : shownContent;
  const toggleInputs = () => { if (!inputOpen) setInputsTakeColumn(true); setInputOpen(!inputOpen); setInputSchemaOpen(false); setTemplateOpen(false); };
  const readOnly = viewOnly || busy || !onUpdateNode;
  const contract = sessionNode?.contract ?? emptyContract();
  const NodeIcon = node.kind === 'form' ? FileText : node.kind === 'assemble' ? Layers : node.kind === 'edit' ? Clapperboard : node.agentKind === 'coding' ? Code2 : node.agentKind === 'image' ? Image : node.agentKind === 'video' ? Video
    : node.agentKind === 'model3d' ? Box : node.agentKind === 'audio' ? Music : Bot;
  // The inputs and the deliverables change their own part of the node, which the document owner applies to the node as
  // its document holds it (onPatchNode), not to this render's copy. So two changes made before the next render (an
  // input's file and an output's landing at once, as closed inputs go on uploading) put back neither what the other
  // changed nor what the canvas cleared in between (a result an input change made stale, which would come back as if
  // published by hand).
  const writeNode = (change: (current: SessionNode) => SessionNode) => {
    if (node.kind !== 'session') return;
    if (onPatchNode) onPatchNode(nodeId, change);
    else onUpdateNode?.(change(node));
  };
  const updateFields = (fields: ContractField[]) => {
    if (viewOnlyRef.current || node.kind !== 'session' || readOnly) return;
    writeNode(current => ({ ...current, contract: { ...(current.contract ?? emptyContract()), inputs: fields } }));
  };
  // What the deliverables change, against this render's node: their outputs, or a result published by hand. A change of
  // the drawer's form (an edit of NodeDeliverables' fields, or the publication that ends them) also starts or carries the
  // edit in progress, which keeps the drawer open while it has taken the delivery back (above).
  const updateDeliverables = (next: CanvasNode) => {
    if (next.kind === 'session' && currentThread) {
      setFormEdit({ form: outputFormKey(next), thread: currentThread.id, share: editing ? editing.share : shownContent === 'delivery' });
    }
    if (next.kind !== 'session' || node.kind !== 'session') { onUpdateNode?.(next); return; }
    writeNode(current => ({
      ...current,
      ...(next.contract?.outputs !== node.contract?.outputs ? { contract: { ...(current.contract ?? emptyContract()), outputs: next.contract?.outputs ?? [] } } : {}),
      ...(next.lastOutput !== node.lastOutput ? { lastOutput: next.lastOutput } : {}),
    }));
  };
  const changeThread = (id?: string) => {
    if (node.kind !== 'session' || busy) return;
    if (viewOnlyRef.current) {
      if (id && getNodeThreads(node).some(thread => thread.id === id)) setViewThreadId(id);
      return;
    }
    if (readOnly) return;
    const withDraft = updateNodeDraft(node, composerDraft);
    onUpdateNode?.(id ? selectNodeThread(withDraft, id) : createNodeThread(withDraft));
  };
  const toggleDeliverables = () => {
    if (node.kind !== 'session') return;
    const next = !deliverablesOpen;
    setDeliverablesOpen(next);
    if (!next) setDeliverablesEditorOpen(false);
    // Reading a prior delivery does not alter execution. During a run, keep disclosure
    // local so opening the drawer cannot write the locked document or resize its node.
    if (busy || viewOnlyRef.current) return;
    if (onToggleDeliverables) onToggleDeliverables(nodeId, next);
    else onUpdateNode?.({ ...node, deliverablesOpen: next });
  };
  const editInputStructure = () => { setTemplateOpen(false); setInputSchemaOpen(true); setInputOpen(true); setInputsTakeColumn(true); };
  const editDeliverableForm = () => {
    setTemplateOpen(false);
    setDeliverablesEditorOpen(true);
    setDeliverablesEditorRequest(count => count + 1);
    if (!deliverablesOpen) toggleDeliverables();
  };
  // Closed from its own button, the drawer would take the keyboard's focus with it to the page's body: the focus goes to
  // the control that opens the inputs again, where there is none to the message box or the first control below them
  // that takes it (the opened inputs hide the conversation's own, and a hidden control takes no focus), else to the
  // node's own menu button. Only a focus inside the drawer moves (a click that focused nothing, as in Safari, leaves it
  // where it was), and nothing scrolls for it (the canvas root clips, so a scroll would shift it).
  const closeInput = () => {
    if (inputDrawerRef.current?.contains(document.activeElement)) {
      const below = chatRef.current?.querySelector('.awwo-node-panel--conversation');
      const targets = [inputToggleRef.current, sessionInputRef.current, below?.querySelector<HTMLElement>('.canvas-composer-input:enabled'),
        ...(below?.querySelectorAll<HTMLElement>(':is(button, textarea, select):enabled:not([tabindex="-1"])') ?? []), moreRef.current];
      for (const target of targets) {
        if (!target) continue;
        target.focus({ preventScroll: true });
        if (document.activeElement === target) break;
      }
    }
    setInputOpen(false); setInputSchemaOpen(false);
  };
  // The opened inputs take the column while no run is going (has-inputs): the replies wait, and a rework note's findings
  // in a short column, or in a taller one where they would push the message box out (ReworkFindingsNote).
  const inputsHaveColumn = expanded && inputOpen && inputsTakeColumn && !active;
  // Closed inputs whose fields still hold uploads keep the fields, hidden, until the last one is a file or dismissed. The
  // toggle's description names each state they hold, its icon the one that most needs the reader (a failure, then a file
  // waiting for its 加入, then an upload going); the live region below speaks the waiting files and failures as they come.
  const inputsHeld = expanded && !inputOpen && inputUploads.pending + inputUploads.waiting + inputUploads.failed > 0;
  const heldStates = (withPending: boolean) => t('tile.inputHeld', { states: [
    ...(withPending && inputUploads.pending ? [t('tile.inputHeldUploading')] : []),
    ...(inputUploads.waiting ? [t('tile.inputHeldWaiting')] : []),
    ...(inputUploads.failed ? [t('tile.inputHeldFailed')] : []),
  ].join(locale === 'zh' ? '，' : ', ') });
  const inputsHeldNote = inputsHeld ? heldStates(true) : undefined;
  const inputsHeldNews = inputsHeld && (inputUploads.waiting || inputUploads.failed) ? heldStates(false) : '';
  const inputToggleIcon = !inputsHeld ? <ArrowDownToLine size={14} /> : inputUploads.failed ? <AlertCircle size={14} className="awwo-input-upload-failed" />
    : inputUploads.waiting ? <Clock size={14} /> : <Loader2 size={14} className="awwo-attachment-spin" />;
  const emptyConversation = session.turns.length === 0 && !currentRunDetails && session.history !== 'loading' && session.history !== 'unreadable' && !session.streaming;
  // An enlarged card shows its deliverable instead of its one-line summary, once it is readable on screen. Only the
  // card's presented size counts: a node's own w/h is the size it opens at, not how large its card is drawn.
  const previewing = compact && node.kind === 'session' && Boolean(geometry) && showsPreview(geometry) && (geometry?.h ?? 0) * scale >= 110;
  const previewLiveText = previewing && (session.streaming || run?.state === 'running')
    ? [...session.turns].reverse().find(turn => turn.role === 'agent')?.text : undefined;
  // A copied case node with nothing said or run yet opens on its inputs (what it was asked and received).
  const caseIntro = node.kind === 'session' && node.lastOutput?.source === 'case' && emptyConversation && !(templateOpen && template);
  const outputView = output ? <div className="canvas-tile-output" data-testid={`canvas-tile-output-${nodeId}`}>
    <div className="canvas-tile-output-head">
      <span className="canvas-tile-output-label">{t(output.partial ? 'tile.partialOutput' : 'tile.lastPublished')}</span>
      <span className="canvas-tile-output-meta">{output.source === 'manual' ? t('tile.manualOutput') : ''}{outputAge}</span>
    </div>
    <div className="canvas-tile-output-body" title={output.text}>{output.text}</div>
  </div> : null;

  // `lod` is already 'focus' whenever `focused` is set (lodFor short-circuits on it), so the level
  // class alone carries focus — emitting a separate focus class was pure duplication.
  return (
    <div
      ref={rootRef}
      // `is-${dot}` puts the run state on the tile's OWN skin. It used to be spent entirely on a
      // 7px dot and a 9px badge, which at overview zoom render around 2px — so the view that
      // exists to answer "which node failed" could not answer it.
      className={`canvas-tile awwo-node canvas-tile--${kindClass} canvas-tile--${lod}${
        selected ? ' canvas-tile--selected' : ''
      } is-${dot}${settledMark ? ` is-just-${settledMark}` : ''}${compact ? ' is-compact' : ''}${previewing ? ' has-preview' : ''}`}
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h,
        // An opened node gives its delivery the share of its width that delivery needs (a page most of it).
        ...(expanded ? { '--awwo-drawer-width': DRAWER_WIDTH[drawerContent] } as CSSProperties : {}) }}
      data-content={expanded ? drawerContent : undefined}
      data-testid={`canvas-tile-${nodeId}`}
      data-lod={lod}
      data-zoom={zoomedOut ? 'far' : undefined}
      data-presentation={compact ? "compact" : "workbench"}
      data-node-id={nodeId}
      data-template={template?.id}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement)?.closest?.('button, textarea, input, select, a, .awwo-node-panel, .awwo-card-preview-body')) return;
        onToggleFocus?.(nodeId);
      }}
    >
      <div className="canvas-tile-head">
        <span className={`canvas-tile-glyph canvas-tile-glyph--${kindClass}`} title={label} aria-hidden="true">
          <>{template ? <AgentGlyph templateId={template.id} size={18} /> : <NodeIcon size={18} aria-hidden="true" />}</>
        </span>
        <span
          className={`canvas-tile-dot canvas-tile-dot--${dot}`}
          data-testid={`canvas-tile-dot-${nodeId}`}
          data-dot={dot}
          aria-hidden="true"
        />
        {/* Zoomed out, the title keeps 13px on screen down to scale .5; below that a compact card caps it
            (about 11px at the default fit zoom of .43) so a short title and a state chip still fit. */}
        <span className="canvas-tile-title" title={node.title}
          style={lod === 'card' || lod === 'glance' ? { fontSize: Math.min(compact ? 26 : 32, 13 / Math.max(.1, scale)) } : undefined}>
          {node.title}
        </span>
        {node.kind === 'session' && node.runtime === 'sandbox' ? <span className="awwo-sandbox-badge" data-testid={`sandbox-badge-${nodeId}`}
          title={t('inspector.sandbox')}>{t('tile.sandbox')}</span> : null}
        {!compact && node.kind === 'session' && node.team ? <span className="node-team-badge" data-testid={`node-team-badge-${nodeId}`}>
          {node.team.members.length} Agent · {nodeTeamModeLabel(node.team.mode, locale)}
        </span> : null}
        {badge ? (
          <span
            className={`canvas-tile-badge canvas-tile-badge--${run!.state}`}
            data-testid={`canvas-tile-run-${nodeId}`}
            // A note on the run (why a run that lost its stream still shows as running) keeps the chip in view, its title.
            data-detail={runDetail ? 'true' : undefined}
            title={runDetail || badge}
          >
            {badge}
          </span>
        ) : null}
        {bind && (!compact || bind.cls !== 'bound') ? (
          <span className={`canvas-tile-bind canvas-tile-bind--${bind.cls}`} data-testid={`canvas-tile-bind-${nodeId}`} title={bind.text}>
            {bind.text}
          </span>
        ) : null}
        {expanded && node.kind === 'session' ? <div className="awwo-node-tools">
          {onStopNode && (run?.state === 'running' || run?.state === 'waiting') ? <button type="button" className="awwo-card-stop" aria-label={t('run.stopNode')} title={t('run.stopNode')}
            onClick={() => onStopNode(nodeId)}><Square size={12} /><span>{t('run.stopNode')}</span></button> : null}
          {onConfigure ? <button type="button" aria-label={t('tile.configure')} title={t('tile.configure')} disabled={busy} onClick={() => onConfigure(nodeId)}><Settings2 size={15} /></button> : null}
          <button type="button" aria-label={t(deliverablesOpen ? 'tile.collapseDeliverables' : 'tile.expandDeliverables')} title={t('tile.deliverables')} aria-expanded={deliverablesOpen} onClick={toggleDeliverables}><PanelRight size={15} /><span>{t('tile.deliverables')}</span></button>
          {onOpenStudio && node.lastOutput ? <button type="button" aria-label={t('studio.open')} title={t('studio.open')} onClick={() => onOpenStudio(nodeId)}><SquareArrowOutUpRight size={15} /></button> : null}
          {!simple && <NodeViewStylePicker />}
          {onToggleFocus ? <button type="button" aria-label={t('tile.collapseNode')} title={t('tile.collapseNode')} disabled={Boolean(configurationPanel) && interactionLocked} onClick={() => onToggleFocus(nodeId)}><X size={15} /></button> : null}
          <button ref={moreRef} type="button" aria-label={t('tile.moreActions')} title={t('tile.more')} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={16} /></button>
          {menuOpen ? <div className="awwo-node-menu" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); } }}>
            {onToggleFocus ? <button type="button" onClick={() => { onToggleFocus(nodeId); setMenuOpen(false); }}><Maximize2 size={14} />{t('tile.focus')}</button> : null}
            {onRunNode ? <button type="button" disabled={viewOnly || busy || (!node.binding && !initializeOnSend)} onClick={() => { if (!viewOnlyRef.current) onRunNode(nodeId); setMenuOpen(false); }}><Play size={14} />{t('tile.runNode')}</button> : null}
            {onDelete ? <button type="button" disabled={viewOnly || busy} onClick={() => { if (!viewOnlyRef.current) onDelete(nodeId); }}><Trash2 size={14} />{t('tile.delete')}</button> : null}
          </div> : null}
        </div> : null}
        {compact ? <div className="awwo-node-tools">
          {onStopNode && (run?.state === 'running' || run?.state === 'waiting') ? <button type="button" className="awwo-card-stop" aria-label={t('run.stopNode')} title={t('run.stopNode')}
            onClick={() => onStopNode(nodeId)}><Square size={11} /></button> : null}
          {onToggleCardPreview && node.kind === 'session' ? <button type="button" className="awwo-card-expand" aria-label={t(previewing ? 'card.shrink' : 'card.enlarge')} title={t(previewing ? 'card.shrink' : 'card.enlarge')}
            onClick={() => onToggleCardPreview(nodeId)}>{previewing ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button> : null}
          <button type="button" aria-label={t('tile.moreActions')} title={t('tile.more')} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={16} /></button>
          {menuOpen ? <div className="awwo-node-menu">
            {onOpenStudio && node.kind === 'session' && node.lastOutput ? <button type="button" onClick={() => { onOpenStudio(nodeId); setMenuOpen(false); }}><SquareArrowOutUpRight size={14} />{t('studio.open')}</button> : null}
            {onShowInDisplay && node.kind === 'session' ? <button type="button" onClick={() => { setMenuOpen(false); onShowInDisplay(nodeId); }}><MonitorPlay size={14} />{displayText(locale, 'display.showNode')}</button> : null}
            {onConfigure ? <button type="button" disabled={busy} onClick={() => { onConfigure(nodeId); setMenuOpen(false); }}><Settings2 size={14} />{t('tile.configure')}</button> : null}
            {onRunNode ? <button type="button" disabled={viewOnly || busy || (node.kind === 'session' && !node.binding && !initializeOnSend)} onClick={() => { if (!viewOnlyRef.current) onRunNode(nodeId); setMenuOpen(false); }}><Play size={14} />{t('tile.runNode')}</button> : null}
            {onDelete ? <button type="button" disabled={viewOnly || busy} onClick={() => { if (!viewOnlyRef.current) onDelete(nodeId); }}><Trash2 size={14} />{t('tile.delete')}</button> : null}
          </div> : null}
        </div> : null}
      </div>

      {compact && node.kind === 'session' && previewing ? <CardPreview node={node} canvasEntries={canvasEntries} running={busy} liveText={previewLiveText}
        onOpenStudio={onOpenStudio ? entryId => onOpenStudio(nodeId, entryId) : undefined} onOpenChat={onToggleFocus ? () => onToggleFocus(nodeId) : undefined} />
      : compact && node.kind === 'session' ? <button className="awwo-compact-open" style={{ fontSize: Math.min(16, 11 / Math.max(.4, scale)) }} type="button" aria-label={t('tile.openSession', { title: node.title })} onClick={event => {
        // The tile's pointerdown already toggled additive selection. Opening here would replace
        // that group with this one focused node immediately after the user's modifier-click.
        if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        onToggleFocus?.(nodeId);
      }}>
        {node.team && <span className="node-team-count" data-testid={`node-team-badge-${nodeId}`}
          title={`${node.team.members.length} Agent · ${nodeTeamModeLabel(node.team.mode, locale)}`}
          aria-label={`${node.team.members.length} Agent · ${nodeTeamModeLabel(node.team.mode, locale)}`}>
          {node.team.members.length} Agent
        </span>}
        <span className="awwo-compact-summary" title={compactPreview}>{compactPreview}</span>
        <ChevronRight className="awwo-compact-chevron" size={16} aria-hidden="true" />
      </button> : !showBody && !configurationPanel ? (
        // glance: identity only. The preview line is PERSISTED on the node, so a freshly reloaded
        // canvas reads correctly before any history has been fetched.
        <div className="canvas-tile-preview" data-testid={`canvas-tile-preview-${nodeId}`}>
          {preview}
        </div>
      ) : (
        <div className="canvas-tile-body">
          {node.kind === 'form' ? (
            <div className="canvas-form-fields">
              {node.fields.map((f) => (
                <div className="canvas-form-field" key={f.id}>
                  <span className="canvas-form-field-label">{f.label || t('common.field')}</span>
                  <span className={`canvas-form-field-value${f.value.trim() ? '' : ' canvas-form-field-value--empty'}`}>
                    {f.value.trim() || t('tile.emptyField')}
                  </span>
                </div>
              ))}
            </div>
          ) : node.kind === 'assemble' ? (
            <AssembleTileBody node={node} expanded={expanded} canvasEntries={canvasEntries}
              inputs={assembleInputs ?? node.contract.inputs.map(field => ({ id: field.id, label: field.label || field.id, required: field.required, source: null, bytes: 0, used: true }))} />
          ) : node.kind === 'edit' ? (
            <>
              {/* What stopped the film (often the render worker's words about the timeline) is what fixing it needs. */}
              {expanded && run?.state === 'failed' ? <NodeFailure detail={runDetail ?? ''}
                onRerun={onRunNode && !viewOnly && !busy ? () => onRunNode(nodeId) : undefined} /> : null}
              <EditTileBody node={node} expanded={expanded} />
            </>
          ) : (
            <div className={`awwo-node-workbench${deliverablesOpen || configurationPanel ? ' has-deliverables' : ''}${caseIntro ? ' is-case-intro' : ''}`}>
              {expanded && sessionsOpen ? <nav className="awwo-session-sidebar" aria-label={t('tile.sessionManagement')}>
                <div className="awwo-session-heading"><span>{t('tile.sessions')}</span><button type="button" aria-label={t('tile.collapseSessions')} title={t('tile.collapseList')} onClick={() => setSessionsOpen(false)}><PanelLeftClose size={14} /></button></div>
                <button className="awwo-session-new" type="button" aria-label={t('tile.newSession')} disabled={readOnly} onClick={() => changeThread()}><Plus size={14} />{t('tile.new')}</button>
                <div className="awwo-session-list">{getNodeThreads(node).map(thread => <button key={thread.id} type="button" className={thread.id === currentThread?.id ? 'is-active' : ''}
                  aria-label={t('tile.openSession', { title: threadTitle(thread.title, t) })} aria-current={thread.id === currentThread?.id ? 'page' : undefined}
                  disabled={busy || (!viewOnly && !onUpdateNode)} onClick={() => changeThread(thread.id)} title={thread.preview || threadTitle(thread.title, t)}>
                  <MessageSquare size={13} /><span>{threadTitle(thread.title, t)}</span>
                </button>)}</div>
                <button ref={sessionInputRef} className="awwo-session-input" type="button" aria-describedby={inputsHeld ? inputHeldNoteId : undefined} title={inputsHeldNote} aria-expanded={inputOpen} onClick={toggleInputs}>{inputToggleIcon}{t('tile.input')}</button>
              </nav> : null}
              <div ref={chatRef} className={`awwo-node-chat${shortColumn ? ' is-short' : ''}${inputsHaveColumn ? ' has-inputs' : ''}`}>
                {expanded ? <div className="awwo-chat-heading">
                  {!sessionsOpen && !simple ? <button type="button" aria-label={t('tile.expandSessions')} title={t('tile.sessions')} onClick={() => setSessionsOpen(true)}><PanelLeftOpen size={15} /></button> : null}
                  <span title={threadTitle(currentThread?.title, t)}>{threadTitle(currentThread?.title, t)}</span>
                  {freeConversation && onRunNode ? <button type="button" className="awwo-chat-task-action" disabled={viewOnly || busy || interactionLocked} onClick={() => onRunNode(nodeId)}><Play size={13} />{t('conversation.executeTask')}</button> : null}
                  {template && !simple ? <button className="awwo-template-toggle" type="button" aria-label={t('tile.templateGuide')} aria-expanded={templateOpen} onClick={() => { setTemplateOpen(!templateOpen); setInputOpen(false); }}><BookOpen size={13} />{t('tile.template')}</button> : null}
                  {/* What the node receives: always in developer mode, where its fields are added, and in the simple view once it has inputs to fill. */}
                  {/* What closed inputs come to hold, said to a screen reader (their chips' own alerts are hidden with them): a
                      failed upload or a file waiting for its 加入, whatever else still uploads. Mounted with the node, so a change
                      of its words is spoken; an upload still going is not said here. The toggles keep their name and describe
                      what the inputs hold (a change there is not spoken), so nothing is said twice. */}
                  <p className="sr-only" aria-live="polite">{inputsHeldNews}</p>
                  {inputsHeld ? <p id={inputHeldNoteId} hidden>{inputsHeldNote}</p> : null}
                  {!sessionsOpen && (!simple || (node.kind === 'session' && (node.contract?.inputs.length ?? 0) > 0)) ? <button ref={inputToggleRef} className="awwo-input-toggle" type="button" aria-label={t('tile.input')} aria-describedby={inputsHeld ? inputHeldNoteId : undefined} title={inputsHeldNote ?? t('tile.inputForm')} aria-expanded={inputOpen} onClick={toggleInputs}>{inputToggleIcon}{simple ? <span>{t('tile.input')}</span> : null}</button> : null}
                </div> : null}
                {expanded && sessionNode && run?.state === 'failed' ? <NodeFailure detail={runDetail ?? ''}
                  onRerun={onRunNode && !viewOnly && !busy && (sessionNode.binding || initializeOnSend) ? () => onRunNode(nodeId) : undefined}
                  onAskAssistant={onAskAssistant && !viewOnly ? () => onAskAssistant(nodeId, 'fix') : undefined} /> : null}
                {/* Beside the inputs or above a conversation the task card is one line until expanded, so what is being read keeps the column. */}
                {expanded && sessionNode && !mediaNode && !(templateOpen && template) ? <NodeBrief key={nodeId} node={sessionNode} template={template}
                  modelLabel={modelLabel} compact={inputOpen || !emptyConversation} onAskAssistant={onAskAssistant && !viewOnly ? () => onAskAssistant(nodeId, 'edit') : undefined} /> : null}
                {/* Held (closed with uploads in it), the same section keeps its fields hidden under another class, so none of
                    the drawer's layout rules apply. */}
                {(expanded && inputOpen) || inputsHeld ? <section ref={inputDrawerRef} className={inputsHeld ? 'awwo-input-held' : 'awwo-input-drawer awwo-node-panel'} hidden={inputsHeld} aria-label={t('tile.inputForm')}>
                  {inputsHeld ? null : <header><strong>{t('tile.input')}</strong><button type="button" aria-label={t('tile.collapseInput')} onClick={closeInput}><X size={14} /></button></header>}
                  <ContractFields valuesFirst editingSchema={inputSchemaOpen} onEditingSchemaChange={setInputSchemaOpen} structureEditable={!simple} fields={contract.inputs} resolvedFields={preparedConversation.inputs} sources={preparedConversation.sources} recorded={preparedConversation.recorded} mediaMissing={preparedConversation.mediaMissing} label={t('tile.input')} readOnly={readOnly} onChange={updateFields} onUploadsChange={onInputUploads} holdUploads />
                </section> : null}
                <div className={`awwo-node-panel awwo-node-panel--conversation${!emptyConversation && !(expanded && templateOpen && template) ? ' has-turns' : ''}`}>
                  {expanded && node.kind === 'session' ? <ReworkFindingsNote node={node} waiting={shortColumn && inputsHaveColumn} column={inputsHaveColumn ? chatRef : undefined} /> : null}
                  {expanded && templateOpen && template ? <section className="awwo-node-template-guide" aria-label={t('tile.templateGuide')}>
                    <header><div><strong>{template.title}</strong><span>{t('tile.templateReference')}</span></div><button type="button" aria-label={t('tile.collapseTemplate')} onClick={() => setTemplateOpen(false)}><X size={14} /></button></header>
                    <AgentTemplateDetails template={template} contract={contract}
                      onEditInputs={readOnly ? undefined : editInputStructure} onEditOutputs={readOnly ? undefined : editDeliverableForm} />
                  </section> : emptyConversation ?
                    <div className="awwo-node-empty" data-template={template?.id} data-media={!template && mediaKind ? mediaKind : undefined}>
                      {template ? <span className="awwo-node-empty-glyph"><AgentGlyph templateId={template.id} size={22} /></span> : null}
                      <strong>{template?.emptyTitle ?? (mediaKind ? t(MEDIA_EMPTY_TITLE[mediaKind]) : t('tile.startHere'))}</strong><span>{template?.emptyDescription ?? (mediaKind ? t('media.emptyDescription') : t(node.binding || initializeOnSend ? 'tile.startBound' : 'tile.startUnbound'))}</span>
                      {expanded && template ? <div className="awwo-starter-prompts">{template.starterPrompts.map(starter => <button key={starter.label} type="button" disabled={readOnly} title={t('tile.addStarter')} onClick={() => { const parts = splitAttachments(composerDraft); setComposerDraft(joinAttachments(parts.body ? `${parts.body}\n\n${starter.prompt}` : starter.prompt, parts.attachments, locale)); }}>{starter.label}<ChevronRight size={12} /></button>)}</div> : null}
                      {expanded && !template && mediaKind && !viewOnly ? <MediaWiringGuide kind={mediaKind} simple={simple} /> : null}
                    </div>
                    : <TileTranscript key={storeKey} turns={session.turns} history={session.history} streaming={session.streaming} streamingSince={session.streamingSince}
                      currentRunDetails={currentRunDetails} mediaResults={node.kind === 'session' && Boolean(mediaKindOf(node.agentKind))}
                      limit={tail} status={session.status ? statusLabel(session.status) : null} autoScroll={expanded} renderTurnDetails={renderTurnDetails ? (turn, latest) => renderTurnDetails(node, turn, latest) : undefined} />}
                  {expanded ? <TileComposer deferClear draft={composerDraft} onDraftChange={setComposerDraft} streaming={busy}
                    attachNodeId={nodeId} mediaNode={mediaComposerInfo(node, modelChoices)}
                    notice={freeConversation ? t(node.team ? 'conversation.teamNotice' : 'conversation.chatNotice') : undefined}
                    sendUnavailableReason={sendUnavailableReason}
                    accessory={node.kind === 'session' && modelChoices?.length && onChangeModel && !viewOnly && !node.team
                      ? <NodeModelPicker choices={modelChoices} value={currentChoiceKey(node, modelChoices)} currentLabel={unlistedModelLabel(node, locale)}
                        disabled={busy || readOnly} disabledReason={busy ? t('tile.taskRunning') : undefined} onChange={key => onChangeModel(nodeId, key)} /> : undefined}
                    blocked={viewOnly || interactionLocked || (!node.binding && !initializeOnSend) || (!onSend && !gatewayBase) || Boolean(conversationError)}
                    blockedReason={viewOnly ? t('common.readOnly') : interactionLocked ? t('tile.taskRunning') : !node.binding && !initializeOnSend ? undefined : conversationError || (!onSend && !gatewayBase ? t('tile.conversationUnavailable') : undefined)} onSend={send} /> : null}
                </div>
              </div>
              {expanded && (deliverablesOpen || configurationPanel) ? <section className="awwo-node-delivery-drawer" role="region" aria-label={t(configurationPanel ? 'tile.nodeConfiguration' : 'tile.deliverables')}>
                {configurationPanel || <><header><span><FileText size={14} />{t('tile.deliverables')}</span>{onOpenStudio && node.lastOutput ? <button type="button" className="awwo-drawer-studio" aria-label={t('studio.open')} title={t('studio.open')} onClick={() => onOpenStudio(nodeId)}><SquareArrowOutUpRight size={14} /></button> : null}<button type="button" aria-label={t('tile.closeDeliverables')} onClick={toggleDeliverables}><X size={15} /></button></header><NodeDeliverables key={storeKey} node={node} readOnly={readOnly} onUpdateNode={onUpdateNode ? updateDeliverables : undefined}
                  editorOpen={deliverablesEditorOpen}
                  editorRequest={deliverablesEditorRequest}
                  canvasEntries={canvasEntries}
                  onRerun={onRunNode && !viewOnly && !busy && (node.kind !== 'session' || Boolean(node.binding) || initializeOnSend) ? () => { if (!viewOnlyRef.current) onRunNode(nodeId); } : undefined} /></>}
              </section> : null}
            </div>
          )}

          {/* WHAT THIS NODE PRODUCED — the exact text a downstream node receives.
              Until now the canvas rendered a run's output nowhere at all, so the operator could
              watch a graph execute and never see the thing it made. A partial captured off a
              FAILED node is shown, because partial evidence beats a blank, but it is labelled:
              it is not a result. */}
          {node.kind === 'form' && expanded ? outputView : null}

          {/* Actions ride BOTH the open and focus levels. Focus is the level where you actually
              work in a tile, and it is where an unbound node has to be bound — hiding 配置 there
              would leave a focused, unbound node with no route to the inspector at all. */}
          {node.kind !== 'session' && expanded ? (
            <div className="canvas-tile-actions">
              {onConfigure ? (
                <button type="button" className="canvas-tile-action" disabled={busy} onClick={() => onConfigure(nodeId)}>
                  <Settings2 size={14} aria-hidden="true" />{t('tile.configure')}
                </button>
              ) : null}
              {onToggleFocus ? (
                <button type="button" className="canvas-tile-action" onClick={() => onToggleFocus(nodeId)}>
                  <Maximize2 size={14} aria-hidden="true" />{t('tile.focus')}
                </button>
              ) : null}
              {onDelete ? (
                <button type="button" className="canvas-tile-action" disabled={viewOnly || busy} onClick={() => { if (!viewOnlyRef.current) onDelete(nodeId); }}>
                  <Trash2 size={14} aria-hidden="true" />{t('tile.delete')}
                </button>
              ) : null}

            </div>
          ) : null}

        </div>
      )}

      <TilePorts node={geometry ? { ...node, ...geometry } : node} wiring={viewOnly || simple || interactionLocked ? undefined : wiring}
        // The reference guide says what the node's own model does with a picture only once the catalogue lists that
        // model; until then it speaks in general terms rather than guess.
        media={node.kind === 'session' && modelChoices?.some(choice => choice.key === modelChoiceKey(node)) ? mediaComposerInfo(node, modelChoices) : undefined}
        scale={scale} />

      {!viewOnly && onResizeNode && !compact ? (
        <button
          type="button"
          className="canvas-tile-resize"
          data-testid={`canvas-tile-resize-${nodeId}`}
          aria-label={t('tile.resize', { title: node.title })}
          onPointerDown={onResizePointerDown}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : null}
      {compact && node.kind === 'session' && onResizeCard ? (
        <button
          type="button"
          className="awwo-card-resize"
          data-testid={`canvas-card-resize-${nodeId}`}
          aria-label={t('card.resize', { title: node.title })}
          title={t('card.resize', { title: node.title })}
          onPointerDown={onCardResizePointerDown}
          onDoubleClick={(e) => { e.stopPropagation(); onToggleCardPreview?.(nodeId); }}
        />
      ) : null}
    </div>
  );
});
