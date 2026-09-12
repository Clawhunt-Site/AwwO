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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDownToLine, BookOpen, Bot, ChevronRight, Code2, FileText, Image, Maximize2, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight, Play, Plus, Settings2, Trash2, X } from 'lucide-react';
import { AGENT_KIND_META, type CanvasNode, type SessionNode } from './canvasDoc';
import { TAIL_LINES, lodFor, type TileLod } from './lod';
import type { RunNodeStatus } from './runGraph';
import { getSnapshot, subscribe, type NodeSession, type Turn } from './sessions';
import { restoreHistory, sendMessage, statusLabel } from './sessionTransport';
import { TileComposer } from './TileComposer';
import { TilePorts, type WiringApi } from './TilePorts';
import { TileTranscript } from './TileTranscript';
import { collaborationInputSummary, htmlPreviewSummary } from './readableTranscript';
import { ContractFields } from './ContractFields';
import { emptyContract, type ContractField } from './nodeContracts';
import { NodeDeliverables } from './NodeDeliverables';
import { getAgentTemplateForNode } from './agentTemplates';
import { AgentGlyph, AgentTemplateDetails } from './AgentTemplateDetails';
import { activeNodeThread, getNodeThreads, createNodeThread, selectNodeThread, updateNodeDraft, sessionStoreKey } from './nodeThreads';
import { prepareNodeConversation, type NodeConversationContext } from './nodeConversation';
import './awwo-node.css';
import { canvasText, useCanvasI18n, type CanvasTranslate } from './i18n';
import { recoveryDetailMessage } from './surfaceMessages';
import { nodeTeamModeLabel } from './NodeTeamEditor';
import type { UiLocale } from '../locale';

/** Smallest a tile may be dragged to. Below this the head itself stops being readable. */
/** Below this much travel a press is a click, not a drag (in SCREEN px, before scale). */
const DRAG_THRESHOLD_PX = 3;

/** How a press on a tile changes the selection — see SessionTileProps.onSelect. */
export type SelectMode = 'only' | 'additive' | 'preserve';

export const MIN_TILE_W = 220;
export const MIN_TILE_H = 140;

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

/** Summarize declared JSON delivery values; ordinary transcript text keeps its last line. */
function livePreview(turns: ReadonlyArray<Turn>, outputs: ReadonlyArray<Pick<ContractField, 'id'>> = [], displayLocale?: UiLocale): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const raw = turns[i].text;
    if (!raw) continue;
    if (displayLocale) {
      const summary = collaborationInputSummary(turns[i], displayLocale)
        || (turns[i].role === 'agent' ? htmlPreviewSummary(raw, displayLocale) : null);
      if (summary) return summary;
    }
    if (turns[i].role === 'agent' && outputs.length) {
      const trimmed = raw.trim();
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      try {
        const parsed: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
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

function glyphOf(node: CanvasNode, locale: UiLocale): { glyph: string; kindClass: string; label: string } {
  if (node.kind === 'form') return { glyph: TILE_COPY.formGlyph, kindClass: 'form', label: canvasText(locale, 'tile.form') };
  const meta = AGENT_KIND_META[node.agentKind];
  const label = canvasText(locale, node.agentKind === 'coding' ? 'node.coding' : node.agentKind === 'image' ? 'node.image' : 'node.llm');
  return { glyph: meta.glyph, kindClass: node.agentKind, label };
}

export interface SessionTileProps {
  /** SaaS host prepares draft nodes before accepting their first turn. */
  initializeOnSend?: boolean;
  /** SaaS chat sends the current message; task execution uses the separate contract action. */
  freeConversation?: boolean;
  renderTurnDetails?: (turn: Turn, latest: boolean) => ReactNode;
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
  onFitNode?: (nodeId: string) => void;
  onToggleDeliverables?: (nodeId: string, open: boolean) => void;
  /** Override the send path (tests / a host that owns the transport). */
  onSend?: (node: SessionNode, text: string, onAccepted?: () => void, displayText?: string) => void;
  /** Current graph-resolved inputs; absent uses this node's local contract values only. */
  conversationContext?: NodeConversationContext;
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
  onRunNode?: (nodeId: string) => void;
}

export function SessionTile({
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
  onToggleDeliverables,
  onSend,
  conversationContext,
  freeConversation = false,
  renderTurnDetails,
  onMove,
  onResizeNode,
  onSelect,
  onToggleFocus,
  onConfigure,
  onDelete,
  onUpdateNode,
  onRunNode,
}: SessionTileProps) {
  const { locale, t } = useCanvasI18n();
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
  const [inputOpen, setInputOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const template = node.kind === 'session' ? getAgentTemplateForNode(node, locale) : undefined;
  const [deliverablesOpen, setDeliverablesOpen] = useState(node.kind === 'session' && Boolean(node.deliverablesOpen));
  useEffect(() => { setDeliverablesOpen(node.kind === 'session' && Boolean(node.deliverablesOpen)); }, [node.kind, node.kind === 'session' && node.deliverablesOpen]);
  const [sessionsOpen, setSessionsOpen] = useState(true);
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
  const rootRef = useRef<HTMLDivElement>(null);
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
      const inScroller = Boolean(t?.closest?.('.canvas-transcript-scroll, .canvas-composer-input, .awwo-node-panel, .awwo-contract-fields, .awwo-session-list, .awwo-deliverables, .canvas-inspector'));
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
      if (t?.closest?.('button, textarea, input, select, a, summary, .canvas-transcript-scroll, .awwo-contract-fields, .awwo-deliverables, .canvas-inspector')) return;
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

  // Restore THIS node's own stored thread, once, as soon as the tile is showing a transcript at
  // all. Without this a bound node with a real server-side conversation renders "还没有对话" after
  // every reload — an absent history presented as "nothing was ever said", which is the one thing
  // this canvas is not allowed to do. Guarded on the STORE's history state, not component state,
  // so panning a tile out of view and back does not refetch, and two tiles never race.
  const sessionNode = node.kind === 'session' ? node : null;
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
  const liveTail = livePreview(session.turns, sessionNode?.contract?.outputs);
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
      if (viewOnlyRef.current || node.kind !== 'session' || interactionLocked) return;
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
    [node, nodeId, onSend, gatewayBase, onIssueId, preparedConversation, conversationError, freeConversation, currentThread?.id, interactionLocked, t],
  );

  const { kindClass, label } = glyphOf(node, locale);
  const dot = dotStateFor(session, run);
  const preview = useMemo(() => {
    if (node.kind === 'form') {
      const filled = node.fields.find((f) => f.value.trim());
      return filled ? `${filled.label || t('common.field')}: ${filled.value.trim()}` : t('tile.emptyField');
    }
    return livePreview(session.turns, node.contract?.outputs, locale) || htmlPreviewSummary(node.preview, locale) || node.preview;
  }, [node, session.turns, locale, t]);

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
  const badge = run ? runBadgeText(run, locale, t) : '';
  const showBody = lod !== 'glance';
  const tail = TAIL_LINES[lod];
  const expanded = !compact && (Boolean(configurationPanel) || lod === 'open' || lod === 'focus');
  const busy = interactionLocked || session.streaming || run?.state === 'running' || run?.state === 'waiting';
  const readOnly = viewOnly || busy || !onUpdateNode;
  const contract = sessionNode?.contract ?? emptyContract();
  const NodeIcon = node.kind === 'form' ? FileText : node.agentKind === 'coding' ? Code2 : node.agentKind === 'image' ? Image : Bot;
  const updateFields = (fields: ContractField[]) => {
    if (viewOnlyRef.current || node.kind !== 'session' || readOnly) return;
    onUpdateNode?.({ ...node, contract: { ...contract, inputs: fields } });
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
    // Reading a prior delivery does not alter execution. During a run, keep disclosure
    // local so opening the drawer cannot write the locked document or resize its node.
    if (busy || viewOnlyRef.current) return;
    if (onToggleDeliverables) onToggleDeliverables(nodeId, next);
    else onUpdateNode?.({ ...node, deliverablesOpen: next });
  };
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
      } is-${dot}${compact ? ' is-compact' : ''}`}
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
      data-testid={`canvas-tile-${nodeId}`}
      data-lod={lod}
      data-presentation={compact ? "compact" : "workbench"}
      data-node-id={nodeId}
      data-template={template?.id}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement)?.closest?.('button, textarea, input, select, a, .awwo-node-panel')) return;
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
        <span className="canvas-tile-title" title={node.title}
          style={lod === 'card' || lod === 'glance' ? { fontSize: Math.min(compact ? 20 : 32, 13 / Math.max(.1, scale)) } : undefined}>
          {node.title}
        </span>
        {!compact && node.kind === 'session' && node.team ? <span className="node-team-badge" data-testid={`node-team-badge-${nodeId}`}>
          {node.team.members.length} Agent · {nodeTeamModeLabel(node.team.mode, locale)}
        </span> : null}
        {badge ? (
          <span
            className={`canvas-tile-badge canvas-tile-badge--${run!.state}`}
            data-testid={`canvas-tile-run-${nodeId}`}
            title={runDetail || badge}
          >
            {badge}
          </span>
        ) : null}
        {bind ? (
          <span className={`canvas-tile-bind canvas-tile-bind--${bind.cls}`} data-testid={`canvas-tile-bind-${nodeId}`}>
            {bind.text}
          </span>
        ) : null}
        {expanded && node.kind === 'session' ? <div className="awwo-node-tools">
          {onConfigure ? <button type="button" aria-label={t('tile.configure')} title={t('tile.configure')} disabled={busy} onClick={() => onConfigure(nodeId)}><Settings2 size={15} /></button> : null}
          <button type="button" aria-label={t(deliverablesOpen ? 'tile.collapseDeliverables' : 'tile.expandDeliverables')} title={t('tile.deliverables')} aria-expanded={deliverablesOpen} onClick={toggleDeliverables}><PanelRight size={15} /><span>{t('tile.deliverables')}</span></button>
          {onToggleFocus ? <button type="button" aria-label={t('tile.collapseNode')} title={t('tile.collapseNode')} disabled={Boolean(configurationPanel) && interactionLocked} onClick={() => onToggleFocus(nodeId)}><X size={15} /></button> : null}
          <button type="button" aria-label={t('tile.moreActions')} title={t('tile.more')} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={16} /></button>
          {menuOpen ? <div className="awwo-node-menu" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); } }}>
            {onToggleFocus ? <button type="button" onClick={() => { onToggleFocus(nodeId); setMenuOpen(false); }}><Maximize2 size={14} />{t('tile.focus')}</button> : null}
            {onRunNode ? <button type="button" disabled={viewOnly || busy || (!node.binding && !initializeOnSend)} onClick={() => { if (!viewOnlyRef.current) onRunNode(nodeId); setMenuOpen(false); }}><Play size={14} />{t('tile.runNode')}</button> : null}
            {onDelete ? <button type="button" disabled={viewOnly || busy} onClick={() => { if (!viewOnlyRef.current) onDelete(nodeId); }}><Trash2 size={14} />{t('tile.delete')}</button> : null}
          </div> : null}
        </div> : null}
        {compact ? <div className="awwo-node-tools">
          <button type="button" aria-label={t('tile.moreActions')} title={t('tile.more')} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={16} /></button>
          {menuOpen ? <div className="awwo-node-menu">
            {onConfigure ? <button type="button" disabled={busy} onClick={() => { onConfigure(nodeId); setMenuOpen(false); }}><Settings2 size={14} />{t('tile.configure')}</button> : null}
            {onRunNode ? <button type="button" disabled={viewOnly || busy || (node.kind === 'session' && !node.binding && !initializeOnSend)} onClick={() => { if (!viewOnlyRef.current) onRunNode(nodeId); setMenuOpen(false); }}><Play size={14} />{t('tile.runNode')}</button> : null}
            {onDelete ? <button type="button" disabled={viewOnly || busy} onClick={() => { if (!viewOnlyRef.current) onDelete(nodeId); }}><Trash2 size={14} />{t('tile.delete')}</button> : null}
          </div> : null}
        </div> : null}
      </div>

      {compact && node.kind === 'session' ? <button className="awwo-compact-open" style={{ fontSize: Math.min(16, 11 / Math.max(.4, scale)) }} type="button" aria-label={t('tile.openSession', { title: node.title })} onClick={event => {
        // The tile's pointerdown already toggled additive selection. Opening here would replace
        // that group with this one focused node immediately after the user's modifier-click.
        if (event.shiftKey || event.metaKey || event.ctrlKey) return;
        onToggleFocus?.(nodeId);
      }}>
        <span className="awwo-compact-summary">{preview || (node.lastOutput ? t('tile.deliveryUpdated') : currentThread?.lastOutput ? t('tile.historicalAvailable') : node.contract?.outputs.length ? t('tile.deliverySummary', { fields: node.contract.outputs.map(field => field.label).join(' / ') }) : t('tile.noDeliverables'))}</span>
        <span className="awwo-compact-footer"><span>{node.team ? <span className="node-team-badge" data-testid={`node-team-badge-${nodeId}`}>{node.team.members.length} Agent · {nodeTeamModeLabel(node.team.mode, locale)}</span>
          : <>{getNodeThreads(node).length} Session{node.lastOutput || currentThread?.lastOutput ? t('tile.hasDeliverables') : ''}</>}</span><span>{t('tile.open')}<ChevronRight size={13} /></span></span>
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
          ) : (
            <div className={`awwo-node-workbench${deliverablesOpen || configurationPanel ? ' has-deliverables' : ''}`}>
              {expanded && sessionsOpen ? <nav className="awwo-session-sidebar" aria-label={t('tile.sessionManagement')}>
                <div className="awwo-session-heading"><span>{t('tile.sessions')}</span><button type="button" aria-label={t('tile.collapseSessions')} title={t('tile.collapseList')} onClick={() => setSessionsOpen(false)}><PanelLeftClose size={14} /></button></div>
                <button className="awwo-session-new" type="button" aria-label={t('tile.newSession')} disabled={readOnly} onClick={() => changeThread()}><Plus size={14} />{t('tile.new')}</button>
                <div className="awwo-session-list">{getNodeThreads(node).map(thread => <button key={thread.id} type="button" className={thread.id === currentThread?.id ? 'is-active' : ''}
                  aria-label={t('tile.openSession', { title: thread.title })} aria-current={thread.id === currentThread?.id ? 'page' : undefined}
                  disabled={busy || (!viewOnly && !onUpdateNode)} onClick={() => changeThread(thread.id)} title={thread.preview || thread.title}>
                  <MessageSquare size={13} /><span>{thread.title}</span>
                </button>)}</div>
                <button className="awwo-session-input" type="button" aria-expanded={inputOpen} onClick={() => { setInputOpen(!inputOpen); setTemplateOpen(false); }}><ArrowDownToLine size={14} />{t('tile.input')}</button>
              </nav> : null}
              <div className="awwo-node-chat">
                {expanded ? <div className="awwo-chat-heading">
                  {!sessionsOpen ? <button type="button" aria-label={t('tile.expandSessions')} title={t('tile.sessions')} onClick={() => setSessionsOpen(true)}><PanelLeftOpen size={15} /></button> : null}
                  <span>{currentThread?.title || 'Session 1'}</span>
                  {freeConversation && onRunNode ? <button type="button" className="awwo-chat-task-action" disabled={viewOnly || busy || interactionLocked} onClick={() => onRunNode(nodeId)}><Play size={13} />{t('conversation.executeTask')}</button> : null}
                  {template ? <button className="awwo-template-toggle" type="button" aria-label={t('tile.templateGuide')} aria-expanded={templateOpen} onClick={() => { setTemplateOpen(!templateOpen); setInputOpen(false); }}><BookOpen size={13} />{t('tile.template')}</button> : null}
                  {!sessionsOpen ? <button className="awwo-input-toggle" type="button" aria-label={t('tile.input')} title={t('tile.inputForm')} aria-expanded={inputOpen} onClick={() => { setInputOpen(!inputOpen); setTemplateOpen(false); }}><ArrowDownToLine size={14} /></button> : null}
                </div> : null}
                {expanded && inputOpen ? <section className="awwo-input-drawer awwo-node-panel" aria-label={t('tile.inputForm')}>
                  <header><strong>{t('tile.input')}</strong><button type="button" aria-label={t('tile.collapseInput')} onClick={() => setInputOpen(false)}><X size={14} /></button></header>
                  <ContractFields fields={contract.inputs} resolvedFields={preparedConversation.inputs} sources={preparedConversation.sources} label={t('tile.input')} readOnly={readOnly} onChange={updateFields} />
                </section> : null}
                <div className="awwo-node-panel awwo-node-panel--conversation">
                  {expanded && templateOpen && template ? <section className="awwo-node-template-guide" aria-label={t('tile.templateGuide')}>
                    <header><div><strong>{template.title}</strong><span>{t('tile.templateReference')}</span></div><button type="button" aria-label={t('tile.collapseTemplate')} onClick={() => setTemplateOpen(false)}><X size={14} /></button></header>
                    <AgentTemplateDetails template={template} contract={contract} />
                  </section> : session.turns.length === 0 && session.history !== 'loading' && session.history !== 'unreadable' && !session.streaming ?
                    <div className="awwo-node-empty" data-template={template?.id}>
                      {template ? <span className="awwo-node-empty-glyph"><AgentGlyph templateId={template.id} size={22} /></span> : null}
                      <strong>{template?.emptyTitle ?? t('tile.startHere')}</strong><span>{template?.emptyDescription ?? t(node.binding || initializeOnSend ? 'tile.startBound' : 'tile.startUnbound')}</span>
                      {expanded && template ? <div className="awwo-starter-prompts">{template.starterPrompts.map(starter => <button key={starter.label} type="button" disabled={readOnly} title={t('tile.addStarter')} onClick={() => setComposerDraft(composerDraft ? `${composerDraft}\n\n${starter.prompt}` : starter.prompt)}>{starter.label}<ChevronRight size={12} /></button>)}</div> : null}
                    </div>
                    : <TileTranscript turns={session.turns} history={session.history} streaming={session.streaming}
                      limit={tail} status={session.status ? statusLabel(session.status) : null} autoScroll={expanded} renderTurnDetails={renderTurnDetails} />}
                  {expanded ? <TileComposer deferClear draft={composerDraft} onDraftChange={setComposerDraft} streaming={busy}
                    notice={freeConversation ? t(node.team ? 'conversation.teamNotice' : 'conversation.chatNotice') : undefined}
                    blocked={viewOnly || interactionLocked || (!node.binding && !initializeOnSend) || (!onSend && !gatewayBase) || Boolean(conversationError)}
                    blockedReason={viewOnly ? t('common.readOnly') : interactionLocked ? t('tile.taskRunning') : !node.binding && !initializeOnSend ? undefined : conversationError || (!onSend && !gatewayBase ? t('tile.conversationUnavailable') : undefined)} onSend={send} /> : null}
                </div>
              </div>
              {expanded && (deliverablesOpen || configurationPanel) ? <section className="awwo-node-delivery-drawer" role="region" aria-label={t(configurationPanel ? 'tile.nodeConfiguration' : 'tile.deliverables')}>
                {configurationPanel || <><header><span><FileText size={14} />{t('tile.deliverables')}</span><button type="button" aria-label={t('tile.closeDeliverables')} onClick={toggleDeliverables}><X size={15} /></button></header><NodeDeliverables key={storeKey} node={node} readOnly={readOnly} onUpdateNode={onUpdateNode} /></>}
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
          {node.kind === 'form' && expanded ? (
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

      <TilePorts node={geometry ? { ...node, ...geometry } : node} wiring={viewOnly ? undefined : wiring} />

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
    </div>
  );
}
