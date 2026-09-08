// CanvasSurface — the session canvas (owner-directed rebuild, 2026-08).
//
// One infinite canvas whose nodes ARE agent sessions: each tile holds a live conversation that
// renders inside it, at a detail level driven by how big the tile actually is on screen. The
// previous surface fused three unrelated node families (fleet companies, creative media nodes,
// workflow nodes) and was rejected; this replaces it outright. What carried over is only what
// was verified in production: the pan/zoom math, typed ports and wiring, the topological run
// engine, and the gateway SSE transport.
//
// This file owns state and wiring only — every visual is a child component, every rule is a
// pure module (ports.ts, lod.ts, spatialOrder.ts, runGraph.ts). It keeps four things honest:
//   * the document is the single source of layout truth and is persisted on every change,
//     with edges reconciled against the CURRENT port specs so a stale wire can never survive a
//     node's kind changing;
//   * a run executes a SNAPSHOT of the graph, and structural edits are locked while it runs;
//   * a superseded run's trailing callbacks can never repaint the current run's badges;
//   * the corrupt-document backup and the empty-first-run rule are inherited from canvasDoc.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minus, Plus, Redo2, Undo2, Map, Play, LayoutGrid } from 'lucide-react';
import { AgentWorkspace } from './AgentWorkspace';
import { CanvasAssistant } from './CanvasAssistant';
import { applyCanvasPlan, canvasPlanRevision } from './canvasPlan';
import { loadPlanningConversation, savePlanningConversation, requestCanvasPlan, readPlannerStatus } from './canvasPlanning';
import { invalidateOutputs } from './invalidateOutputs';
import { prepareNodeConversation } from './nodeConversation';
import { createAgentTemplate, createDevelopmentTemplate, type AgentTemplateId } from './agentTemplates';
import { CanvasViewport } from './CanvasViewport';
import { SessionTile, type SelectMode } from './SessionTile';
import { TilePorts, useWiring } from './TilePorts';
import { WirePlane } from './WirePlane';
import { Marquee, useMarquee } from './Marquee';
import { AddNodeMenu, type AddNodeKind } from './AddNodeMenu';
import { InspectorPanel } from './InspectorPanel';
import { RunControls } from './RunControls';
import { GraphSettings } from './GraphSettings';
import { addReviewPartner } from './reviewPartner';
import { preflightReviewGraphIssue, runReviewGraph } from './reviewGraph';
import { beginReviewRound, prepareReviewTurn } from './reviewJournal';
import { RunTimeline, type RunView } from './RunTimeline';
import { Minimap } from './Minimap';
import { CommandBar, type CommandBarMode, type CanvasCommandActions } from './CommandBar';
import { useCanvasKeys, keyHintMap } from './useCanvasKeys';
import {
  CANVAS_STORAGE_KEY,
  createFormNode,
  createSessionNode,
  loadDocumentWithStatus,
  migrateFromLegacy,
  sanitizeDocument,
  saveDocument,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
  type SessionNode,
  type Waypoint,
} from './canvasDoc';
import { boundsOfNodes, canConnect, edgeId, portsFor, reconcileEdges, type PortRef, type DataType } from './ports';
import { nextIn, orderNodes, type WorldRect } from './spatialOrder';
import { preflightGraphIssue, runGraph, validateNodeOutput, type RunNodeStatus } from './runGraph';
import { createGatewayExecutor, cancelConversationRunViaGateway } from './runTransport';
import { settleExecutionResult, settleRecoveredJournal } from './runSettlement';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, saveRunJournal, clearRunJournal, patchRunJournalNode, reconcileRunJournal, journalSummary, type CanvasRunJournal } from './runJournal';
import { applyRecoveredDocument, prepareRunDocument, runInputFingerprint, recoveryJournalForDocument, mergeRecoveredManualConversation } from './runRecoveryDocument';
import { prepareManualHistoryCapacity, persistManualHistoryWithNativeProof } from './manualHistoryRetention';
import { withCanvasRunOwnership } from './runOwnership';
import { useCanvasI18n } from './i18n';
import { surfaceNotice, stopUnconfirmedMessage, planFailureMessage, plannerConnectionMessage, surfaceViewMessages, preflightIssueMessage } from './surfaceMessages';
import { getSnapshot as getSessionSnapshot, reset as resetSession, replaceTurns, patchPresentation } from './sessions';
import { forgetNode, restoreHistory } from './sessionTransport';
import { projectConversationTurns, updateConversationPresentation } from './conversationPresentation';
import { activeThreadId, boundAgentConfigurationChanged, getNodeThreads, preserveThreadRuntime, rebindNodeThread, sessionStoreKey,
  updateNodeDraft, updateThreadIssueId, updateThreadPreview } from './nodeThreads';
import { arrangeNodePositions, presentationNodes } from './nodePresentation';
import { fitBounds, fitOverview, focusWorld, type ViewportState } from './viewport';
import { paperclipApiBase } from '../paperclipBridge';
import { gatewayApiBase } from '../chatAutomations';
import './canvas.css';

/** How long patches sharing a label keep collapsing into one undo step (one drag = one step). */
const COALESCE_MS = 900;
/** Cap on remembered steps. Documents are small, but an unbounded stack is a leak. */
const HISTORY_LIMIT = 60;

/** Compact summaries remain readable at overview scale without the full-workbench fit floor. */
function fitNodeOverview(nodes: ReadonlyArray<CanvasNode>, size: { w: number; h: number }): ViewportState {
  const bounds = boundsOfNodes(presentationNodes(nodes, null));
  const maxScale = Math.max(.06, Math.min(1.05,
    (size.w - 96) / Math.max(1, bounds.maxX - bounds.minX),
    (size.h - 140) / Math.max(1, bounds.maxY - bounds.minY)));
  return fitBounds(bounds, size, { minScale: .06, maxScale }, { x: 48, top: 40, bottom: 100 });
}

function hasStreamingConversation(nodes: ReadonlyArray<CanvasNode>): boolean {
  return nodes.some(node => node.kind === 'session' && getNodeThreads(node)
    .some(thread => getSessionSnapshot(sessionStoreKey(node, thread.id)).streaming));
}

export interface CanvasSurfaceProps {
  /** Injectable planner transport; graph edits always pass the same validation pipeline. */
  planRequest?: typeof requestCanvasPlan;
  accountControl?: ReactNode;
  onOpenSettings?: () => void;
  /** Host inventory reader (App.readJson) for the inspector's contract-driven RuntimePicker.
   *  Absent → runtime selection is hidden, fail-closed. */
  runtimeReadJson?: (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;
  /** Take the user to where companies are created — binding needs one and the canvas makes none. */
  onCreateCompany?: () => void;
}

/** LIVE companies a bind can target. Read straight from the control plane — the canvas no longer
 *  projects a "world" of company cards, it only needs somewhere to put a newly hired agent. */
function useLiveCompanies(apiBase: string): { companies: Array<{ id: string; name: string }>; refresh: () => void } {
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let stale = false;
    const base = apiBase.replace(/\/+$/, '');
    void fetch(`${base}/companies`, { credentials: 'include', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (stale || !d) return;
        const list = Array.isArray(d) ? d : (d as { companies?: unknown }).companies;
        if (!Array.isArray(list)) return;
        setCompanies(
          list
            .map((c) => {
              const raw = c as { id?: unknown; name?: unknown; codeName?: unknown };
              const id = typeof raw.id === 'string' ? raw.id : '';
              const name =
                (typeof raw.name === 'string' && raw.name) ||
                (typeof raw.codeName === 'string' && raw.codeName) ||
                id;
              return id ? { id, name } : null;
            })
            .filter((c): c is { id: string; name: string } => c !== null),
        );
      })
      .catch(() => {
        // Unreachable control plane leaves the list empty; the inspector then says binding is
        // unavailable rather than offering a dropdown that would fail on submit.
      });
    return () => {
      stale = true;
    };
  }, [apiBase, nonce]);
  return { companies, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}

export function CanvasSurface({ runtimeReadJson, onCreateCompany, accountControl, onOpenSettings, planRequest = requestCanvasPlan }: CanvasSurfaceProps = {}) {
  const { locale, t } = useCanvasI18n();
  const viewText = surfaceViewMessages(t);
  const inspectorCloseLocked = useRef(false);
  const [bindingLocked, setBindingLocked] = useState(false);
  const onInspectorLockChange = useCallback((locked: boolean) => {
    inspectorCloseLocked.current = locked;
    setBindingLocked(locked);
  }, []);
  // ---- document -----------------------------------------------------------------------------
  const [doc, setDoc] = useState<CanvasDocument>(() => {
    const migrated = migrateFromLegacy();
    if (migrated) return migrated;
    return loadDocumentWithStatus().doc;
  });
  const nodes = doc.nodes;

  // Edges are reconciled against the CURRENT port specs before anything reads them: a wire whose
  // port vanished (an image agent switched to LLM) must not linger in the document, in the run
  // engine's dependency graph, or on screen.
  const edges = useMemo(() => reconcileEdges(nodes, doc.edges), [nodes, doc.edges]);

  // ---- history (undo / redo) ------------------------------------------------------------------
  //
  // Every document mutation funnels through patchDoc, which makes it the one place history can be
  // recorded honestly. Three rules decide what becomes an undo step:
  //
  //  * USER EDITS are steps: add, delete, connect, disconnect, move, resize, inspector save.
  //  * MACHINE WRITES are not: a server-minted issueId, a transcript-derived preview line, the
  //    debounced viewport save. Undoing "the agent replied" is meaningless, and letting those
  //    writes clear the redo stack would silently destroy a redo the user was about to use.
  //  * A CONTINUOUS GESTURE is ONE step. A drag emits a patch per pointer move; without
  //    coalescing, one drag would bury the stack and ⌘Z would rewind pixel by pixel. Patches
  //    sharing a label within COALESCE_MS collapse into the step the first one opened, and each
  //    patch refreshes the window — so a long drag stays one step and a later drag of the same
  //    node starts a new one.
  const docRef = useRef(doc);
  docRef.current = doc;
  // Compare revisions in the same normalized shape the loader returns. The last successful
  // local save is also the base of an edit whose autosave effect has not committed yet.
  const lastSavedRevision = useRef<string | null>(null);
  if (lastSavedRevision.current === null) lastSavedRevision.current = canvasPlanRevision(sanitizeDocument(doc));
  const saveLocalDocument = useCallback((next: CanvasDocument): boolean => {
    if (!saveDocument(next)) return false;
    lastSavedRevision.current = canvasPlanRevision(sanitizeDocument(next));
    return true;
  }, []);
  const undoStack = useRef<CanvasDocument[]>([]);
  const redoStack = useRef<CanvasDocument[]>([]);
  const lastCommit = useRef<{ label: string; at: number } | null>(null);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const syncHistory = useCallback(() => {
    setHistory((h) =>
      h.undo === undoStack.current.length && h.redo === redoStack.current.length
        ? h
        : { undo: undoStack.current.length, redo: redoStack.current.length },
    );
  }, []);

  /**
   * Apply a mutation to the document.
   *
   * `opts.label` names the gesture for coalescing; `opts.silent` marks a machine write that must
   * not become an undo step. The work is done OUTSIDE the setState updater deliberately: the
   * updater must stay pure (React may invoke it twice), and reading the live doc from a ref lets
   * several patches in one tick compose correctly.
   */
  const patchDoc = useCallback(
    (mut: (prev: CanvasDocument) => CanvasDocument, opts?: { label?: string; silent?: boolean; serverIdentity?: boolean }) => {
      if (!runAbort.current && loadRunJournal()) return;
      const prev = docRef.current;
      const proposed = mut(prev);
      const next = opts?.serverIdentity ? proposed : invalidateOutputs(prev, proposed);
      if (next === prev) return;

      if (!opts?.silent) {
        const label = opts?.label ?? 'edit';
        const now = Date.now();
        const within = lastCommit.current && lastCommit.current.label === label && now - lastCommit.current.at < COALESCE_MS;
        if (!within) {
          undoStack.current = [...undoStack.current, prev].slice(-HISTORY_LIMIT);
          redoStack.current = [];
        }
        lastCommit.current = { label, at: now };
      }

      const committed = { ...next, updatedAt: Date.now() };
      docRef.current = committed;
      setDoc(committed);
      if (!opts?.silent) syncHistory();
    },
    [syncHistory],
  );

  // User callbacks can outlive their idle render. The journal/ref checks also cover
  // acceptance before React commits `running`, waiting nodes, and terminal settlement.
  const canEditStructure = useCallback((allowBindingSave = false) => !(
    runAbort.current || journal.current || loadRunJournal() || recoveringRef.current
    || (inspectorCloseLocked.current && !allowBindingSave) || hasStreamingConversation(docRef.current.nodes)
  ), []);

  /** Step to a stored document without recording it as a new edit. */
  const restoreDoc = useCallback((target: CanvasDocument) => {
    if (loadRunJournal()) return;
    lastCommit.current = null;
    const live = docRef.current;
    const restored = invalidateOutputs(live, { ...target, nodes: target.nodes.map(node => {
      const current = live.nodes.find(n => n.id === node.id);
      if (node.kind !== 'session' || current?.kind !== 'session') return node;
      return preserveThreadRuntime(node, current);
    }) });
    docRef.current = restored;
    setDoc(restored);
  }, []);

  const undo = useCallback(() => {
    if (!canEditStructure()) return;
    const prevDoc = undoStack.current.at(-1);
    if (!prevDoc) return;
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, docRef.current].slice(-HISTORY_LIMIT);
    restoreDoc(prevDoc);
    syncHistory();
  }, [canEditStructure, restoreDoc, syncHistory]);

  const redo = useCallback(() => {
    if (!canEditStructure()) return;
    const nextDoc = redoStack.current.at(-1);
    if (!nextDoc) return;
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, docRef.current].slice(-HISTORY_LIMIT);
    restoreDoc(nextDoc);
    syncHistory();
  }, [canEditStructure, restoreDoc, syncHistory]);

  useEffect(() => {
    if (!runAbort.current && loadRunJournal()) return;
    saveLocalDocument({ ...doc, edges });
  }, [doc, edges, saveLocalDocument]);

  // ---- viewport / selection / focus ----------------------------------------------------------
  const [view, setView] = useState<ViewportState>(() => doc.view ?? { x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const rootRef = useRef<HTMLDivElement>(null);
  const [handoffNote, setHandoffNote] = useState('');

  const [selection, setSelection] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Read inside the drag so moving a group never depends on the callback identity at press time.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const renderNodes = useMemo(() => presentationNodes(nodes, focusedId), [nodes, focusedId]);
  const renderNodeById = useMemo(() => new globalThis.Map(renderNodes.map(node => [node.id, node])), [renderNodes]);
  // Focus pushes the pre-focus viewport so a second press returns exactly where you were.
  const focusReturn = useRef<ViewportState | null>(null);

  // Viewport size for the fit math. The reported size comes from the viewport's own measure +
  // ResizeObserver, but BOTH can still be 0 at the moment a fit is requested: the mount measure
  // runs before layout settles, and RO callbacks are delivered on frame boundaries, which stall in
  // a backgrounded/non-compositing tab. Falling back to a live measurement turns what would be a
  // silent no-op (press ⌘E, nothing happens, no way to tell why) into the action the user asked
  // for. Returns null only when there is genuinely nothing laid out to fit into.
  const viewportSize = useCallback((): { w: number; h: number } | null => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r && r.width > 0) return { w: r.width, h: r.height };
    return sizeRef.current.w > 0 ? sizeRef.current : null;
  }, []);

  const fitAll = useCallback(() => {
    const box = viewportSize();
    if (!nodes.length || !box || inspectorCloseLocked.current) return;
    setInspectorId(null);
    setFocusedId(null);
    setView(fitNodeOverview(nodes, box));
  }, [nodes, viewportSize]);

  // Fit once, after the first real size + nodes are known.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.w === 0 || nodes.length === 0) return;
    fitted.current = true;
    setView(fitNodeOverview(nodes, viewportSize() || size));
  }, [size, nodes, doc.view, viewportSize]);

  const focusNode = useCallback(
    (nodeId: string) => {
      if (inspectorCloseLocked.current) return;
      const node = presentationNodes(docRef.current.nodes, nodeId).find((n) => n.id === nodeId);
      const box = viewportSize();
      if (!node) return;
      if (focusedId !== nodeId) {
        if (!focusedId) focusReturn.current = viewRef.current;
        setInspectorId(current => current === nodeId ? current : null);
      }
      setFocusedId(nodeId);
      setSelection([nodeId]);
      if (!box) return;
      setView(fitBounds({ minX: node.x, minY: node.y, maxX: node.x + node.w, maxY: node.y + node.h }, box,
        { minScale: 0.2, maxScale: 1.25 }, { x: 28, top: 24, bottom: 82 }));
    },
    [focusedId, viewportSize],
  );

  const arrangeNodes = useCallback(() => {
    if (!canEditStructure()) return;
    const arranged = arrangeNodePositions(docRef.current.nodes, docRef.current.edges);
    patchDoc(previous => ({ ...previous, nodes: arranged }), { label: 'arrange:nodes' });
    setInspectorId(null);
    setFocusedId(null);
    const box = viewportSize();
    if (box) setView(fitNodeOverview(arranged, box));
  }, [canEditStructure, patchDoc, viewportSize]);

  const unfocus = useCallback(() => {
    if (inspectorCloseLocked.current) return;
    setInspectorId(null);
    setFocusedId(null);
    if (focusReturn.current) {
      setView(focusReturn.current);
      focusReturn.current = null;
    }
  }, []);

  const toggleFocus = useCallback(
    (nodeId?: string) => {
      const target = nodeId ?? selection[0] ?? null;
      if (focusedId && (!nodeId || nodeId === focusedId)) {
        unfocus();
        return;
      }
      if (target) focusNode(target);
    },
    [focusedId, selection, focusNode, unfocus],
  );

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const order = orderNodes(nodes);
      const nextId = nextIn(order, selection[0] ?? focusedId ?? null, dir);
      if (!nextId) return;
      if (focusedId) focusNode(nextId);
      else {
        setSelection([nextId]);
        const n = renderNodes.find((x) => x.id === nextId);
        if (n && sizeRef.current.w) {
          setView(focusWorld(viewRef.current, n.x + n.w / 2, n.y + n.h / 2, sizeRef.current));
        }
      }
    },
    [nodes, renderNodes, selection, focusedId, focusNode],
  );

  // ---- waypoints ----------------------------------------------------------------------------
  const saveWaypoint = useCallback(
    (slot: number) => {
      if (!canEditStructure()) return;
      patchDoc((prev) => ({
        ...prev,
        waypoints: [...prev.waypoints.filter((w) => w.slot !== slot), { slot, view: viewRef.current } as Waypoint],
      }), { label: `waypoint:${slot}` });
    },
    [canEditStructure, patchDoc],
  );
  const recallWaypoint = useCallback(
    (slot: number) => {
      const wp = doc.waypoints.find((w) => w.slot === slot);
      if (wp) setView(wp.view);
    },
    [doc.waypoints],
  );

  // ---- run state ----------------------------------------------------------------------------
  const [initialJournal] = useState(loadRunJournal);
  const journal = useRef<CanvasRunJournal | null>(initialJournal);
  const [recovering, setRecovering] = useState(Boolean(initialJournal));
  const recoveringRef = useRef(recovering);
  recoveringRef.current = recovering;
  const [runs, setRuns] = useState<Record<string, RunView>>(() => initialJournal?.nodes ?? {});
  const [running, setRunning] = useState(Boolean(initialJournal));
  const [reviewRound, setReviewRound] = useState(initialJournal?.review?.round ?? 0);
  const [runSummary, setRunSummary] = useState<Parameters<typeof RunControls>[0]['summary']>(null);
  const [stopped, setStopped] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const runAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const observeOtherTab = (event: StorageEvent) => {
      if (event.key !== CANVAS_RUN_JOURNAL_KEY || runAbort.current) return;
      const active = loadRunJournal();
      if (active) {
        journal.current = active; setRuns(active.nodes); setReviewRound(active.review?.round ?? 0); setRunning(true); setRecovering(true);
      }
    };
    window.addEventListener('storage', observeOtherTab);
    return () => window.removeEventListener('storage', observeOtherTab);
  }, []);
  // A page reload detaches observation; only an explicit Stop cancels native execution.
  const updateJournal = useCallback((nodeId: string, patch: Parameters<typeof patchRunJournalNode>[2]) => {
    if (!journal.current) return;
    journal.current = patchRunJournalNode(journal.current, nodeId, patch);
    if (!saveRunJournal(journal.current)) setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
  }, []);
  useEffect(() => {
    if (!recovering) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refreshedHistories = new Set<string>();
    setHandoffNote(surfaceNotice(t, 'recovering_run'));
    const poll = () => withCanvasRunOwnership(async () => {
      if (controller.signal.aborted) return;
      const durable = loadRunJournal();
      if (!durable) {
        // The tab that owned execution already persisted its final document and cleared the
        // journal. Its transcript store is not shared with this tab: even a loaded history
        // here may have been fetched before the final reply. Refresh only the observed
        // execution's exact sessions, without recreating a journal or dispatching a turn.
        const observed = journal.current;
        const retry = () => {
          setHandoffNote(surfaceNotice(t, 'recovery_pending'));
          timer = setTimeout(() => void poll(), 2500);
        };
        const current = loadDocumentWithStatus();
        if (current.status !== 'ok') { retry(); return; }
        for (const node of current.doc.nodes) {
          const entry = observed?.nodes[node.id];
          if (node.kind !== 'session' || !entry || entry.threadId !== activeThreadId(node)
              || entry.companyId !== node.binding?.companyId || entry.agentId !== node.binding?.agentId
              || !node.issueId || (entry.issueId && entry.issueId !== node.issueId)) continue;
          const storeKey = sessionStoreKey(node);
          if (getSessionSnapshot(storeKey).streaming) { retry(); return; }
          const identity = JSON.stringify([observed!.id, storeKey, entry.companyId, entry.agentId, node.issueId]);
          if (!refreshedHistories.has(identity)) {
            forgetNode(storeKey);
            await restoreHistory({ gatewayBase: gatewayApiBase(), node,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
            if (controller.signal.aborted) return;
            if (journal.current !== observed || loadRunJournal()) { retry(); return; }
            if (getSessionSnapshot(storeKey).history !== 'loaded') { retry(); return; }
            refreshedHistories.add(identity);
          }
        }
        // Structural/session edits in another tab are possible after it clears the journal.
        // Do not publish our pre-fetch document over those edits or unlock a newer run.
        if (journal.current !== observed || loadRunJournal()
            || JSON.stringify(loadDocumentWithStatus().doc) !== JSON.stringify(current.doc)) { retry(); return; }
        docRef.current = current.doc; setDoc(current.doc);
        journal.current = null; setRecovering(false); setRunning(false); setRuns({}); setReviewRound(0);
        setHandoffNote(surfaceNotice(t, 'recovery_complete'));
        return;
      }
      journal.current = durable;
      setReviewRound(durable.review?.round ?? 0);
      if (!journal.current) return;
      const observed = journal.current;
      const reconciled = await reconcileRunJournal(observed, docRef.current.nodes, gatewayApiBase(), controller.signal);
      if (controller.signal.aborted) return;
      // A Stop confirmation may have landed while this read was in flight. Never overwrite it
      // with a response based on the old snapshot; reconcile the new journal in the next pass.
      if (journal.current !== observed || JSON.stringify(loadRunJournal()) !== JSON.stringify(observed)) {
        timer = setTimeout(() => void poll(), 2500);
        return;
      }
      const next = await settleRecoveredJournal(gatewayApiBase(), recoveryJournalForDocument(docRef.current, reconciled), controller.signal);
      if (controller.signal.aborted) return;
      if (journal.current !== observed || JSON.stringify(loadRunJournal()) !== JSON.stringify(observed)) {
        timer = setTimeout(() => void poll(), 2500);
        return;
      }
      journal.current = next;
      saveRunJournal(next);
      setRuns(next.nodes);
      setReviewRound(next.review?.round ?? 0);
      setRunStartedAt(next.startedAt);
      setTimelineOpen(true);
      const recovered = applyRecoveredDocument(docRef.current, { ...next, inputFingerprint: next.inputFingerprint ?? '' });
      docRef.current = recovered; setDoc(recovered);
      // Persist the complete batch before deleting its recovery journal.
      const persisted = saveLocalDocument(recovered);
      const unresolved = Object.values(next.nodes).some(node => node.state === 'running');
      if (unresolved) {
        const missing = Object.values(next.nodes).some(node => node.detail === 'recovery_identity_missing');
        setHandoffNote(missing ? surfaceNotice(t, 'run_identity_unconfirmed') : surfaceNotice(t, 'recovery_pending'));
        timer = setTimeout(() => void poll(), 2500);
      } else if (!persisted) {
        setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
        timer = setTimeout(() => void poll(), 2500);
      } else {
        for (const node of docRef.current.nodes) {
          const entry = next.nodes[node.id];
          if (node.kind === 'session' && entry?.threadId === activeThreadId(node) && node.issueId
              && entry.companyId === node.binding?.companyId && entry.agentId === node.binding?.agentId) {
            if (entry.operationId) updateConversationPresentation(node, entry.operationId, {
              issueId: node.issueId, runId: entry.runId, outputText: entry.output ?? '',
              outputState: entry.state === 'done' ? 'final' : 'failed',
            });
            if (next.manual && !await persistManualHistoryWithNativeProof(gatewayApiBase(), node, next, controller.signal)) {
              if (controller.signal.aborted) return;
              setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
              timer = setTimeout(() => void poll(), 2500);
              return;
            }
            const storeKey = sessionStoreKey(node);
            forgetNode(storeKey);
            await restoreHistory({ gatewayBase: gatewayApiBase(), node,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
            if (controller.signal.aborted) return;
            if (next.manual) replaceTurns(storeKey, projectConversationTurns(node,
              mergeRecoveredManualConversation(getSessionSnapshot(storeKey).turns, next, node.id)));
          }
        }
        clearRunJournal(next.id); journal.current = null;
        setRecovering(false); setRunning(false);
        setRunSummary(journalSummary(next));
        setHandoffNote(surfaceNotice(t, Object.values(next.nodes).some(node => node.detail === 'recovery_input_changed') ? 'recovery_input_changed' : 'recovery_complete'));
      }
    }, () => {
      if (controller.signal.aborted) return;
      setHandoffNote(surfaceNotice(t, 'execution_owned_elsewhere'));
      timer = setTimeout(() => void poll(), 2500);
    });
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [recovering, patchDoc, saveLocalDocument, t]);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  /**
    * Run some or all of the graph.
    *
    * `scope` names the nodes allowed to EXECUTE; anything upstream of them contributes its stored
    * output instead of re-running. Omitted = the whole canvas, which is what 运行图 still does.
    */
  const startRun = useCallback((scope?: ReadonlyArray<string>, manualMessage?: string, onAccepted?: () => void, manualDisplayText?: string) => {
    // Ownership can arrive after another edit. A manual send belongs to the exact Session
    // and draft that initiated it, never whichever Session happens to be selected later.
    const submittedNode = manualMessage && scope?.length === 1
      ? docRef.current.nodes.find((node): node is SessionNode => node.id === scope[0] && node.kind === 'session')
      : undefined;
    const submittedThread = submittedNode
      ? getNodeThreads(submittedNode).find(thread => thread.id === activeThreadId(submittedNode))
      : undefined;
    return withCanvasRunOwnership(async () => {
    // Synchronous re-entrancy guard on the REF: React state commits asynchronously, so a double
    // click could otherwise start two overlapping runs whose callbacks interleave into one map.
    if (runAbort.current || journal.current) return;
    const durable = loadRunJournal();
    if (durable) {
      journal.current = durable;
      setRuns(durable.nodes); setReviewRound(durable.review?.round ?? 0); setRunning(true); setRecovering(true);
      return;
    }
    if (manualMessage && submittedNode && !await prepareManualHistoryCapacity(
      gatewayApiBase(), submittedNode, manualMessage, () => {
        const live = docRef.current.nodes.find(node => node.id === submittedNode.id);
        return live?.kind === 'session' && activeThreadId(live) === activeThreadId(submittedNode)
          && live.issueId === submittedNode.issueId && live.binding?.companyId === submittedNode.binding?.companyId
          && live.binding?.agentId === submittedNode.binding?.agentId && !runAbort.current && !journal.current && !loadRunJournal();
      },
    )) { setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return; }
    // A capacity read may yield while another tab acquires or restores a durable run.
    if (runAbort.current || journal.current || loadRunJournal()) return;
    const persistedCanvas = loadDocumentWithStatus();
    const persistedRevision = canvasPlanRevision(persistedCanvas.doc);
    if (persistedCanvas.status === 'ok'
        && persistedRevision !== canvasPlanRevision(sanitizeDocument(docRef.current))
        && persistedRevision !== lastSavedRevision.current) {
      docRef.current = persistedCanvas.doc; setDoc(persistedCanvas.doc);
      lastSavedRevision.current = persistedRevision;
      setHandoffNote(surfaceNotice(t, 'canvas_changed_elsewhere'));
      return;
    }
    // Freeze the current ref after acquiring ownership: a drag/edit may be newer than the
    // render that supplied this callback, even when its persistence base is still current.
    const nodes = docRef.current.nodes;
    const edges = reconcileEdges(nodes, docRef.current.edges);
    const manualNode = submittedNode && nodes.find(node => node.id === submittedNode.id);
    if (manualMessage && (!submittedNode || manualNode?.kind !== 'session'
        || activeThreadId(manualNode) !== submittedThread?.id
        || manualNode.issueId !== submittedNode.issueId
        || manualNode.binding?.companyId !== submittedNode.binding?.companyId
        || manualNode.binding?.agentId !== submittedNode.binding?.agentId)) {
      setHandoffNote(surfaceNotice(t, 'canvas_changed_elsewhere')); return;
    }
    if (inspectorCloseLocked.current) { setHandoffNote(surfaceNotice(t, 'bind_before_run')); return; }
    if (hasStreamingConversation(docRef.current.nodes)) { setHandoffNote(surfaceNotice(t, 'wait_conversation')); return; }
    const reviewPolicy = !manualMessage ? docRef.current.execution : undefined;
    const problem = preflightIssueMessage(t, reviewPolicy
      ? preflightReviewGraphIssue(nodes, edges, reviewPolicy, scope)
      : preflightGraphIssue(nodes, edges.filter(edge => edge.kind !== 'feedback'), scope), locale);
    if (problem) { setHandoffNote(problem); return; }
    setHandoffNote('');
    const ac = new AbortController();
    // A failed or stopped retry must never leave its previous success available to downstream nodes.
    const executing = new Set(scope ?? nodes.map(n => n.id));
    const pending: CanvasRunJournal = { version: 1, id: crypto.randomUUID(), startedAt: Date.now(), scope: [...executing], inputFingerprint: runInputFingerprint(docRef.current, [...executing]), ...(manualMessage ? { manual: true, manualMessage } : {}), nodes: Object.fromEntries(nodes.filter(n => executing.has(n.id)).map(n => [n.id, { nodeId: n.id, threadId: n.kind === 'session' ? activeThreadId(n) : 'form', operationId: n.kind === 'session' ? crypto.randomUUID() : null, companyId: n.kind === 'session' ? n.binding?.companyId ?? null : null, agentId: n.kind === 'session' ? n.binding?.agentId ?? null : null, issueId: n.kind === 'session' ? n.issueId ?? null : null, runId: null, state: 'waiting' as const }])) };
    if (reviewPolicy) pending.review = { round: 0, maxRounds: reviewPolicy.maxRounds, outcome: 'running', turns: [] };
    const prepared = prepareRunDocument(docRef.current, [...executing], Boolean(manualMessage));
    if (!saveLocalDocument(prepared)) { setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return; }
    if (!saveRunJournal(pending)) {
      // No dispatch happened: preserve the previous published results on a quota failure.
      saveLocalDocument(docRef.current);
      setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return;
    }
    // Draft consumption is part of durable acceptance, not a generic composer edit (which
    // is correctly blocked once running). Save only after the journal succeeds, so neither
    // storage failure can discard a request that has not been accepted or dispatched.
    const consumeDraft = manualNode?.kind === 'session' && submittedThread
      && getNodeThreads(manualNode).find(thread => thread.id === submittedThread.id)?.draft === submittedThread.draft;
    const acceptedDocument = consumeDraft ? { ...prepared, nodes: prepared.nodes.map(node =>
      node.id === manualNode.id && node.kind === 'session'
        ? updateNodeDraft(node, '', submittedThread.id) : node) } : prepared;
    if (acceptedDocument !== prepared && !saveLocalDocument(acceptedDocument)) {
      clearRunJournal(pending.id);
      setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return;
    }
    docRef.current = acceptedDocument; setDoc(acceptedDocument);
    journal.current = pending;
    runAbort.current = ac;
    if (consumeDraft) onAccepted?.();
    setRunning(true);
    setStopped(false);
    setRunSummary(null);
    setRuns({});
    setReviewRound(0);
    setRunStartedAt(Date.now());
    setNow(Date.now());
    setTimelineOpen(true);
    // Use the SHARED executor factory rather than re-deriving one here: it already owns the
    // per-agent serialization contract (two tiles bound to the same agent must not execute
    // concurrently — the gateway wakes one worker per agent, so parallel turns would
    // cross-attribute their output), and it is the version the tests exercise. A local copy
    // drifted from it once already, keying on agentId alone instead of company+agent.
    const nativeExec = createGatewayExecutor({
      gatewayBase: gatewayApiBase(),
      signal: ac.signal,
      deferFinalPresentation: true,
      operationIdForNode: nodeId => journal.current?.nodes[nodeId]?.operationId ?? undefined,
      // Display metadata is captured separately; the Agent receives the complete execution
      // request, including the inputs and output contract, without any display substitutions.
      presentationForNode: node => ({
        inputKind: manualMessage ? 'manual' : 'workflow',
        ...(manualMessage && manualDisplayText !== undefined ? { displayText: manualDisplayText } : {}),
        outputState: 'streaming',
        outputContract: node.contract ? { version: 1, inputs: [],
          outputs: node.contract.outputs.map(field => ({ ...field, value: '' })) } : undefined,
      }),
      onIssueId: (nodeId: string, issueId: string, threadId?: string) => {
        updateJournal(nodeId, { issueId });
        // The server minted this node's thread: persist it so the NEXT turn continues the same
        // conversation instead of forking a second one.
        patchDoc((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => (n.id === nodeId && n.kind === 'session'
            ? updateThreadIssueId(n, threadId ?? activeThreadId(n), issueId) : n)),
        }), { silent: true, serverIdentity: true });
      },
      onRunAccepted: (nodeId, identity) => updateJournal(nodeId, identity),
      onCancelFailure: (_nodeId, detail) => setHandoffNote(stopUnconfirmedMessage(t, detail)),
    });
    const exec = async (node: SessionNode, message: string) => {
      const result = await nativeExec(node, message);
      const entry = journal.current?.nodes[node.id];
      const settled = await settleExecutionResult(gatewayApiBase(), entry, result);
      const operationId = entry?.operationId;
      const outputState = settled.ok && !settled.unconfirmed ? 'final' : 'failed';
      if (operationId) {
        updateConversationPresentation(node, operationId, { issueId: entry?.issueId, runId: entry?.runId,
          outputText: settled.output, outputState });
        const key = sessionStoreKey(node);
        for (const turn of getSessionSnapshot(key).turns) {
          if (turn.role === 'agent' && turn.recoveryOperationId === operationId && turn.text === settled.output) {
            patchPresentation(key, turn.id, { ...turn.presentation, outputState });
          }
        }
      }
      return settled;
    };
    const onStatus = (nodeId: string, status: RunNodeStatus) => {
        // In review mode the fresh operation is saved by beforeTurn, before any dispatch.
        // A crash between this UI event and beforeTurn must leave a waiting, undispatched node.
        if (!reviewPolicy || status.state !== 'running' || journal.current?.nodes[nodeId]?.operationId) updateJournal(nodeId, status);
        if (runAbort.current !== ac) return;
        const stamp = Date.now();
        if (!manualMessage && !reviewPolicy && (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled') && status.output) {
          patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(n => n.id === nodeId ? { ...n, lastOutput: { text: status.output!, at: stamp, source: 'run' as const, ...(status.state !== 'done' ? { partial: true } : {}) } } : n) }), { silent: true });
        }
        setRuns(prev => ({ ...prev, [nodeId]: { ...status, startedAt: prev[nodeId]?.startedAt ?? stamp, ...(status.state !== 'waiting' && status.state !== 'running' ? { endedAt: stamp } : {}) } }));
    };
    const executeManual = async () => {
      const node = nodes.find(n => executing.has(n.id));
      if (!node || node.kind !== 'session') throw new Error('Conversation node is unavailable');
      onStatus(node.id, { state: 'running' });
      const result = await exec(node, manualMessage!);
      onStatus(node.id, { state: result.unconfirmed ? 'running' : result.ok ? 'done' : result.cancelled ? 'cancelled' : 'failed', output: result.output, detail: result.detail });
      return journalSummary(journal.current!);
    };
    const options = {
      nodes,
      edges: reviewPolicy ? edges : edges.filter(edge => edge.kind !== 'feedback'),
      scope,
      // An out-of-scope upstream contributes what it produced earlier rather than running again.
      storedOutput: (nodeId: string) => {
        const output = docRef.current.nodes.find((n) => n.id === nodeId)?.lastOutput;
        return output && !output.partial ? output.text : null;
      },
      execAgent: exec,
      onStatus,
      signal: ac.signal,
    };
    const summary = manualMessage ? await executeManual() : reviewPolicy ? await runReviewGraph({ ...options,
      policy: reviewPolicy,
      onRound: round => {
        const next = beginReviewRound(journal.current!, round);
        if (!saveRunJournal(next)) throw new Error(surfaceNotice(t, 'storage_write_failed'));
        journal.current = next;
        setRuns(next.nodes); setReviewRound(round);
      },
      beforeTurn: async node => {
        const live = docRef.current.nodes.find(item => item.id === node.id);
        if (live?.kind !== 'session') throw new Error('review_turn_identity_changed');
        const next = prepareReviewTurn(journal.current!, live, crypto.randomUUID());
        if (!saveRunJournal(next)) throw new Error(surfaceNotice(t, 'storage_write_failed'));
        journal.current = next;
        return { ...node, issueId: live.issueId, threads: live.threads };
      },
    }) : await runGraph(options);
    if (summary.review && journal.current?.review) {
      journal.current = { ...journal.current, review: { ...journal.current.review, outcome: summary.review.outcome } };
      if (!saveRunJournal(journal.current)) setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
    }
    if (runAbort.current === ac) {
      runAbort.current = null;
      if (Object.values(journal.current?.nodes ?? {}).some(node => node.state === 'running')) {
        setRecovering(true);
        return;
      }
      const persistedCanvas = loadDocumentWithStatus();
      let finalSummary = summary;
      if (reviewPolicy && journal.current) {
        // Publish one coherent batch; intermediate review outputs cannot invalidate each other around a loop.
        docRef.current = applyRecoveredDocument(docRef.current, { ...journal.current, inputFingerprint: pending.inputFingerprint! });
        setDoc(docRef.current);
      }
      if (persistedCanvas.status === 'ok' && pending.inputFingerprint !== runInputFingerprint(persistedCanvas.doc, pending.scope)) {
        const historical = recoveryJournalForDocument(persistedCanvas.doc, journal.current!);
        journal.current = historical; saveRunJournal(historical);
        docRef.current = applyRecoveredDocument(persistedCanvas.doc, { ...historical, inputFingerprint: pending.inputFingerprint! });
        setDoc(docRef.current); setRuns(historical.nodes); finalSummary = journalSummary(historical);
        setHandoffNote(surfaceNotice(t, 'recovery_input_changed'));
      }
      if (!saveLocalDocument(docRef.current)) { setRecovering(true); return; }
      if (journal.current?.manual) {
        for (const node of docRef.current.nodes) {
          if (node.kind === 'session' && pending.scope.includes(node.id)
              && !await persistManualHistoryWithNativeProof(gatewayApiBase(), node, journal.current)) {
            setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
            setRecovering(true); return;
          }
        }
      }
      clearRunJournal(pending.id); journal.current = null;
      setRunning(false);
      setStopped(finalSummary.cancelled > 0);
      setRunSummary(finalSummary);
    }
    }, () => setHandoffNote(surfaceNotice(t, 'execution_owned_elsewhere')));
  }, [patchDoc, saveLocalDocument, updateJournal, locale, t]);

  const stopRun = useCallback(() => {
    if (runAbort.current && !runAbort.current.signal.aborted) { runAbort.current.abort(); return; }
    // Also works after a refresh or a previous Stop failure; never invent an ID.
    const requestedJournal = journal.current;
    if (!requestedJournal) return;
    for (const item of Object.values(requestedJournal.nodes)) {
      if (item.state !== 'running' || !item.companyId || !item.agentId || !item.issueId) continue;
      void cancelConversationRunViaGateway(gatewayApiBase(), { companyId: item.companyId, agentId: item.agentId, agentName: '' }, item.issueId, item.runId).then(result => {
        if (!result.confirmed) setHandoffNote(stopUnconfirmedMessage(t, result.detail || result.status));
        else if (recovering && !item.runId) void withCanvasRunOwnership(async () => {
          const durable = loadRunJournal();
          const current = durable?.nodes[item.nodeId];
          if (!durable || durable.id !== requestedJournal.id || !current
              || current.operationId !== item.operationId || current.runId !== item.runId
              || current.issueId !== item.issueId || current.companyId !== item.companyId
              || current.agentId !== item.agentId || current.threadId !== item.threadId
              || current.state !== 'running') return;
          const confirmed = patchRunJournalNode(durable, item.nodeId, {
            state: result.cancelled ? 'cancelled' : 'failed', detail: result.status,
          });
          if (saveRunJournal(confirmed)) {
            journal.current = confirmed; setRuns(confirmed.nodes);
          } else setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
        }, () => setHandoffNote(surfaceNotice(t, 'execution_owned_elsewhere')), undefined, true);
      });
    }
  }, [recovering, updateJournal, t]);

  /**
   * Every node downstream of `roots`, plus the roots themselves — the set a change at `roots`
   * can still affect. Running this is "carry my edit forward" without re-running the work above
   * it, which is the loop the product exists for.
   */
  const downstreamClosure = useCallback(
    (roots: ReadonlyArray<string>): string[] => {
      const out = new Set(roots);
      let grew = true;
      while (grew) {
        grew = false;
        for (const e of edges) {
          // Scoped runs follow same-turn dependencies. Feedback belongs to the bounded
          // review scheduler and must not expand a Workflow run after switching modes.
          if (e.kind === 'feedback') continue;
          if (out.has(e.fromNode) && !out.has(e.toNode)) {
            out.add(e.toNode);
            grew = true;
          }
        }
      }
      return [...out];
    },
    [edges],
  );

  /** Re-run exactly one node, reusing every upstream's stored output. */
  const rerunNode = useCallback((nodeId: string) => void startRun([nodeId]), [startRun]);

  /** Run the selection and everything it feeds. */
  const runFromSelection = useCallback(
    () => void startRun(downstreamClosure(selectionRef.current)),
    [startRun, downstreamClosure],
  );

  // ---- node mutations -----------------------------------------------------------------------

  // The glance LOD can only render `node.preview` — a far-away tile has no transcript loaded — so
  // the last line has to be persisted onto the document when a tile's stream settles. Guarded to a
  // real change so it never re-saves the document on an identical value.
  const persistPreview = useCallback(
    (nodeId: string, preview: string, threadId?: string) => {
      // Recovery can briefly display a previously loaded transcript while another tab has
      // already saved the final document. Never write that stale tail back into its preview.
      if (recovering || (journal.current && !runAbort.current)) return;
      patchDoc((prev) => {
        const target = prev.nodes.find((n) => n.id === nodeId);
        if (!target || target.kind !== 'session') return prev;
        const next = updateThreadPreview(target, threadId ?? activeThreadId(target), preview);
        if (next === target) return prev;
        return {
          ...prev,
          nodes: prev.nodes.map((n) => n.id === nodeId ? next : n),
        };
      }, { silent: true });
    },
    [patchDoc, recovering],
  );

  const persistDraft = useCallback((nodeId: string, threadId: string, draft: string) => {
    if (runAbort.current || inspectorCloseLocked.current) return;
    patchDoc(prev => {
      const target = prev.nodes.find(node => node.id === nodeId);
      if (!target || target.kind !== 'session') return prev;
      const next = updateNodeDraft(target, draft, threadId);
      return next === target ? prev : { ...prev, nodes: prev.nodes.map(node => node.id === nodeId ? next : node) };
    }, { silent: true });
  }, [patchDoc]);

  const toggleDeliverables = useCallback((nodeId: string, open: boolean) => {
    if (!canEditStructure()) return;
    const target = docRef.current.nodes.find(node => node.id === nodeId);
    if (!target || target.kind !== 'session' || Boolean(target.deliverablesOpen) === open || hasStreamingConversation([target])) return;
    patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(node => {
      if (node.id !== nodeId || node.kind !== 'session') return node;
      const w = Math.max(220, node.w + (open ? 260 : -260));
      return { ...node, deliverablesOpen: open, w, x: node.x - (w - node.w) / 2 };
    }) }), { silent: true });
    requestAnimationFrame(() => focusNode(nodeId));
  }, [canEditStructure, patchDoc, focusNode]);

  const addNode = useCallback(
    (kind: AddNodeKind, world: { x: number; y: number }) => {
      if (!canEditStructure()) return;
      const node = kind === 'form' ? createFormNode(world)
        : kind === 'llm' || kind === 'coding' || kind === 'image'
          ? { ...createAgentTemplate('general', world, locale), agentKind: kind }
          : createAgentTemplate(kind, world, locale);
      patchDoc((prev) => ({ ...prev, nodes: [...prev.nodes, node] }), { label: `add:${node.id}` });
      setSelection([node.id]);
      focusNode(node.id);
      setInspectorId(node.id);
      return node;
    },
    [patchDoc, focusNode, locale, canEditStructure],
  );

  /**
   * Move the dragged node — and, when it is part of a multi-selection, everything selected with
   * it. The dragged node takes the ABSOLUTE position the gesture computed (authoritative, so it
   * can never drift away from the cursor); the rest of the group take that node's delta for this
   * frame, so the whole arrangement translates rigidly. One label, so the whole drag — group and
   * all — collapses into a single undo step.
   */
  const moveNode = useCallback(
    (nodeId: string, x: number, y: number) => {
      if (!canEditStructure()) return;
      patchDoc(
        (prev) => {
          const target = prev.nodes.find((n) => n.id === nodeId);
          if (!target) return prev;
          const dx = x - target.x;
          const dy = y - target.y;
          if (dx === 0 && dy === 0) return prev;
          const sel = selectionRef.current;
          const group = sel.length > 1 && sel.includes(nodeId) ? new Set(sel) : null;
          return {
            ...prev,
            nodes: prev.nodes.map((n) => {
              if (n.id === nodeId) return { ...n, x, y };
              if (group?.has(n.id)) return { ...n, x: n.x + dx, y: n.y + dy };
              return n;
            }),
          };
        },
        { label: `move:${nodeId}` },
      );
    },
    [canEditStructure, patchDoc],
  );

  /** Selection change from a tile press — see SessionTile's SelectMode. */
  const selectNode = useCallback((nodeId: string, mode: SelectMode) => {
    setSelection((prev) => {
      if (mode === 'additive') {
        return prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId];
      }
      if (mode === 'only') {
        return prev.length === 1 && prev[0] === nodeId ? prev : [nodeId];
      }
      // 'preserve': keep an existing group intact so the press can drag all of it.
      return prev.includes(nodeId) ? prev : [nodeId];
    });
  }, []);

  const resizeNode = useCallback(
    (nodeId: string, w: number, h: number) => {
      if (!canEditStructure()) return;
      patchDoc((prev) => ({ ...prev, nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, w, h } : n)) }), {
        label: `resize:${nodeId}`,
      });
    },
    [canEditStructure, patchDoc],
  );

  const deleteNodes = useCallback(
    (ids: ReadonlyArray<string>) => {
      if (!canEditStructure()) return;
      if (!ids.length) return;
      const kill = new Set(ids);
      const removed = docRef.current.nodes.filter(node => kill.has(node.id));
      patchDoc((prev) => ({
        ...prev,
        nodes: prev.nodes.filter((n) => !kill.has(n.id)),
        // Incident wires die with their node — a dangling edge would otherwise be reconciled
        // away silently on the next load, which reads as data loss rather than a deletion.
        edges: prev.edges.filter((e) => !kill.has(e.fromNode) && !kill.has(e.toNode)),
      }), { label: `delete:${ids.join(',')}` });
      for (const node of removed) {
        const keys = node.kind === 'session' ? getNodeThreads(node).map(thread => sessionStoreKey(node, thread.id)) : [node.id];
        for (const key of keys) { resetSession(key); forgetNode(key); }
      }
      setSelection((prev) => prev.filter((id) => !kill.has(id)));
      setFocusedId((prev) => (prev && kill.has(prev) ? null : prev));
      setInspectorId((prev) => (prev && kill.has(prev) ? null : prev));
    },
    [canEditStructure, patchDoc],
  );

  const saveNode = useCallback(
    (next: CanvasNode, allowBindingSave = false) => {
      if (!canEditStructure(allowBindingSave)) return;
      const current = docRef.current.nodes.find(n => n.id === next.id);
      if (current?.kind === 'session' && next.kind === 'session' &&
        activeThreadId(current) !== activeThreadId(next) && hasStreamingConversation([current])) return;
      const published = next.lastOutput?.source === 'manual' && next.lastOutput !== current?.lastOutput;
      if (published) {
        const errors = validateNodeOutput(next, next.lastOutput!.text);
        if (errors.length) { setHandoffNote(errors.join('；')); return; }
      }
      patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(n => n.id === next.id
        ? { ...next, x: n.x, y: n.y, w: n.w, h: n.h }
        : n) }), { label: `config:${next.id}` });
      setHandoffNote('');
    },
    [canEditStructure, patchDoc],
  );

  // The inspector owns configuration, while cards own contracts and the transport owns thread IDs.
  const saveInspector = useCallback((draft: CanvasNode) => {
    const live = docRef.current.nodes.find(n => n.id === draft.id);
    if (!live || !canEditStructure(true)) return;
    if (live.kind === 'session' && draft.kind === 'session') {
      const bindingChanged = live.binding?.companyId !== draft.binding?.companyId || live.binding?.agentId !== draft.binding?.agentId;
      const configChanged = !bindingChanged && boundAgentConfigurationChanged(live, draft);
      // Runtime/model/effort/persona are materialized on the native Agent when it is hired. Keep
      // the old bound Session intact and open an unbound Session for the changed configuration;
      // silently editing only the canvas would make later runs execute different settings than
      // the UI promises.
      const rebound = bindingChanged ? rebindNodeThread(live, draft.binding)
        : configChanged ? rebindNodeThread(live, null) : live;
      saveNode({ ...rebound, title: draft.title, agentKind: draft.agentKind, runtime: draft.runtime,
        model: draft.model, effort: draft.effort, persona: draft.persona,
        binding: configChanged ? null : draft.binding, bindAttempt: configChanged ? null : draft.bindAttempt,
        issueId: bindingChanged || configChanged ? null : live.issueId }, true);
      if (configChanged) setHandoffNote(surfaceNotice(t, 'config_forked'));
    } else if (live.kind === 'form' && draft.kind === 'form') {
      saveNode({ ...live, title: draft.title, fields: draft.fields });
    }
  }, [canEditStructure, saveNode]);
  const onConnect = useCallback(
    (from: PortRef, to: PortRef, dataType: DataType) => {
      if (!canEditStructure()) return;
      patchDoc((prev) => {
        const id = edgeId(from, to);
        if (prev.edges.some((e) => e.id === id)) return prev;
        const edge: CanvasEdge = {
          id,
          fromNode: from.nodeId,
          fromPort: from.portId,
          toNode: to.nodeId,
          toPort: to.portId,
          dataType,
        };
        return { ...prev, edges: [...prev.edges, edge] };
      }, { label: `connect:${edgeId(from, to)}` });
    },
    [canEditStructure, patchDoc],
  );

  const disconnect = useCallback(
    (edge: CanvasEdge) => {
      if (!canEditStructure()) return;
      patchDoc((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.id !== edge.id) }), {
        label: `disconnect:${edge.id}`,
      });
    },
    [canEditStructure, patchDoc],
  );

  // ---- overlays -----------------------------------------------------------------------------
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  const inspectorNode = inspectorId ? nodes.find((n) => n.id === inspectorId) ?? null : null;
  const [addMenu, setAddMenu] = useState<{ at: { x: number; y: number }; world: { x: number; y: number } } | null>(null);
  const [barMode, setBarMode] = useState<CommandBarMode | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(true);

  const { companies, refresh: refreshCompanies } = useLiveCompanies(paperclipApiBase());

  // Wiring is a STRUCTURAL edit and locks with the rest of them during a run. A run executes a
  // SNAPSHOT of the graph, so a wire cut mid-run would not change what is executing — the user
  // would be shown a graph that no longer matches the timeline describing the run. Omitting
  // onConnect leaves the ports visible but inert (they are the graph's structure, not a control).
  const wiring = useWiring({ nodes: renderNodes, edges, onConnect: running ? undefined : onConnect, rootRef, view });
  const marquee = useMarquee({
    nodes: renderNodes,
    rootRef,
    view,
    onSelect: (ids, additive) =>
      setSelection((prev) => (additive ? Array.from(new Set([...prev, ...ids])) : ids)),
  });

  const keyBindings = useCanvasKeys({
    onFocusToggle: () => toggleFocus(),
    onCycle: cycle,
    onPalette: () => setBarMode('commands'),
    onSearch: () => setBarMode('search'),
    onFitAll: fitAll,
    onDeleteSelection: running ? undefined : () => deleteNodes(selection),
    // Undo/redo are locked during a run for the same reason every other structural edit is: the
    // run executes a SNAPSHOT, so rewinding the graph under it would show the operator a document
    // that does not match the timeline describing what is executing.
    onUndo: running || !history.undo ? undefined : undo,
    onRedo: running || !history.redo ? undefined : redo,
    onSaveWaypoint: saveWaypoint,
    onRecallWaypoint: recallWaypoint,
    onEscape: () => {
      // Unwind outermost-first so one Escape never closes two things at once.
      if (addMenu) setAddMenu(null);
      else if (barMode) setBarMode(null);
      else if (inspectorId) { if (!inspectorCloseLocked.current) setInspectorId(null); }
      else if (focusedId) unfocus();
      else setSelection([]);
    },
  });

  /** A palette-created node lands in the middle of what the operator is looking at. */
  const addAtViewCenter = useCallback(
    (kind: AddNodeKind) => {
      const v = viewRef.current;
      const s = sizeRef.current;
      addNode(kind, {
        x: (-v.x + s.w / 2) / (v.scale || 1) - 170,
        y: (-v.y + s.h / 2) / (v.scale || 1) - 130,
      });
    },
    [addNode],
  );

  const canEdit = !running && !recovering && canEditStructure();
  const commandActions: CanvasCommandActions = useMemo(
    () => ({
      addSession: (kind) => addAtViewCenter(kind),
      canEdit,
      run: () => void startRun(),
      stop: stopRun,
      fitAll,
      toggleTimeline: () => setTimelineOpen((o) => !o),
      toggleMinimap: () => setMinimapOpen((o) => !o),
      // Slot 1 is the palette's default drawer for waypoints; the keyboard covers 1-9.
      saveWaypoint: () => saveWaypoint(1),
      recallWaypoint: () => recallWaypoint(1),
      deleteSelection: () => deleteNodes(selection),
      runSelection: runFromSelection,
      rerunNode: () => {
        const only = selectionRef.current[0];
        if (only) rerunNode(only);
      },
      undo,
      redo,
      canUndo: canEdit && history.undo > 0,
      canRedo: canEdit && history.redo > 0,
    }),
    [addAtViewCenter, canEdit, startRun, stopRun, fitAll, saveWaypoint, recallWaypoint, deleteNodes, selection, undo, redo, history.undo, history.redo],
  );

  const addAgent = useCallback((kind: AgentTemplateId) => addAtViewCenter(kind), [addAtViewCenter]);
  const createTemplate = useCallback(() => {
    if (!canEditStructure()) return;
    const currentNodes = docRef.current.nodes;
    const world = currentNodes.length ? { x: boundsOfNodes(presentationNodes(currentNodes, null)).maxX + 160, y: 60 } : { x: 0, y: 0 };
    const template = createDevelopmentTemplate(world, locale);
    patchDoc(prev => ({ ...prev, nodes: [...prev.nodes, ...template.nodes], edges: [...prev.edges, ...template.edges] }), { label: 'template:development' });
    setSelection([template.nodes[0].id]);
    setFocusedId(null);
    fitted.current = true;
    const box = viewportSize();
    if (box) setView(fitNodeOverview([...currentNodes, ...template.nodes], box));
  }, [canEditStructure, patchDoc, viewportSize, locale]);

  const zoomBy = (factor: number) => {
    const box = viewportSize();
    if (!box) return;
    setView(prev => {
      const scale = Math.max(.1, Math.min(2.5, prev.scale * factor));
      const ratio = scale / prev.scale;
      return { scale, x: box.w / 2 - (box.w / 2 - prev.x) * ratio, y: box.h / 2 - (box.h / 2 - prev.y) * ratio };
    });
  };

  // Persist the viewport so the canvas reopens where it was left (debounced by the doc save).
  useEffect(() => {
    // The viewport is not an edit: panning is navigation, and letting it clear the redo stack
    // would silently destroy a redo the user was about to reach for.
    const t = setTimeout(
      () => patchDoc((prev) => (prev.view === view ? prev : { ...prev, view }), { silent: true }),
      400,
    );
    return () => clearTimeout(t);
  }, [view, patchDoc]);

  // The planning conversation is local UI history, separate from node execution Sessions.
  const [planning, setPlanning] = useState(loadPlanningConversation);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [planningBusy, setPlanningBusy] = useState(false);
  const [planningError, setPlanningError] = useState('');
  const [plannerStatus, setPlannerStatus] = useState<{ available: boolean; provider: string; error?: string } | null>(null);
  const [lastPlanRevision, setLastPlanRevision] = useState<string | null>(null);
  const [planningFitId, setPlanningFitId] = useState('');
  const planningRequest = useRef<{ id: string; controller: AbortController; prompt: string } | null>(null);
  const planningSequence = useRef(0);
  // Measure after the welcome screen becomes a canvas with an assistant sidebar.
  // The previous ResizeObserver size still describes the full-width welcome at this point.
  useLayoutEffect(() => {
    if (!planningFitId) return;
    const box = viewportSize();
    if (box) setView(fitNodeOverview(docRef.current.nodes, box));
  }, [planningFitId, viewportSize]);
  useEffect(() => { savePlanningConversation(planning); }, [planning]);
  useEffect(() => {
    const controller = new AbortController();
    void readPlannerStatus(controller.signal, locale).then(status => { if (!controller.signal.aborted) setPlannerStatus(status); });
    return () => controller.abort();
  }, [locale]);
  useEffect(() => () => { planningRequest.current?.controller.abort(); planningRequest.current = null; }, []);
  const appendPlanningMessage = (id: string, content: string, status?: 'applied' | 'error' | 'stale') => {
    setPlanning(previous => ({ ...previous, messages: [...previous.messages,
      { id, role: 'assistant' as const, content, ...(status ? { status } : {}) }].slice(-60) }));
  };
  const sendPlanningMessage = async () => {
    const prompt = planning.draft.trim();
    if (!prompt || planningRequest.current) return;
    if (journal.current || journal.current || runAbort.current || inspectorCloseLocked.current || hasStreamingConversation(docRef.current.nodes)) {
      setPlanningError(surfaceNotice(t, 'planning_busy'));
      return;
    }
    const snapshot = docRef.current;
    const revision = canvasPlanRevision(snapshot);
    const id = `plan-${Date.now()}-${++planningSequence.current}`;
    const controller = new AbortController();
    planningRequest.current = { id, controller, prompt };
    setPlanningBusy(true);
    setPlanningError('');
    setPlanning(previous => ({ draft: '', messages: [...previous.messages, { id: `${id}-user`, role: 'user' as const, content: prompt }].slice(-60) }));
    try {
      const plan = await planRequest(prompt, snapshot, planning.messages, controller.signal, locale);
      if (controller.signal.aborted || planningRequest.current?.id !== id) return;
      if (canvasPlanRevision(docRef.current) !== revision || journal.current || runAbort.current || inspectorCloseLocked.current || hasStreamingConversation(docRef.current.nodes)) {
        appendPlanningMessage(`${id}-assistant`, surfaceNotice(t, 'plan_stale'), 'stale');
        setPlanning(previous => ({ ...previous, draft: previous.draft || prompt }));
        return;
      }
      const applied = applyCanvasPlan(docRef.current, plan, locale);
      if (plan.operations.length) {
        fitted.current = true;
        patchDoc(() => applied.doc, { label: `ai:${id}` });
        setLastPlanRevision(canvasPlanRevision(docRef.current));
        setFocusedId(null);
        setInspectorId(null);
        setSelection(applied.addedNodeIds);
        setAssistantOpen(true);
        setPlanningFitId(id);
      }
      appendPlanningMessage(`${id}-assistant`, applied.summary, plan.operations.length ? 'applied' : undefined);
      setPlannerStatus(previous => ({ available: true, provider: previous?.provider || 'AI' }));
    } catch (error) {
      if (controller.signal.aborted || planningRequest.current?.id !== id) return;
      const message = planFailureMessage(t, error);
      setPlanningError(message);
      appendPlanningMessage(`${id}-assistant`, message, 'error');
      setPlanning(previous => ({ ...previous, draft: previous.draft || prompt }));
    } finally {
      if (planningRequest.current?.id === id) { planningRequest.current = null; setPlanningBusy(false); }
    }
  };
  const cancelPlanning = () => {
    const request = planningRequest.current;
    if (!request) return;
    planningRequest.current = null;
    request.controller.abort();
    setPlanningBusy(false);
    setPlanningError('');
    appendPlanningMessage(`${request.id}-cancelled`, surfaceNotice(t, 'plan_cancelled'));
    setPlanning(previous => ({ ...previous, draft: previous.draft || request.prompt }));
  };
  const canUndoPlan = !planningBusy && !running && !bindingLocked && history.undo > 0
    && lastPlanRevision !== null && canvasPlanRevision(doc) === lastPlanRevision
    && Boolean(lastCommit.current?.label.startsWith('ai:'));
  const assistantProps = {
    messages: planning.messages, draft: planning.draft, busy: planningBusy, error: planningError,
    onDraftChange: (draft: string) => setPlanning(previous => ({ ...previous, draft })),
    onSend: () => { void sendPlanningMessage(); }, onCancel: cancelPlanning,
    onUndo: () => {
      if (!canUndoPlan) return;
      undo(); setLastPlanRevision(null);
      appendPlanningMessage(`undo-${Date.now()}`, surfaceNotice(t, 'plan_undone'));
    }, canUndo: canUndoPlan,
    runtimeControls: <div className="awwo-planner-connection"><span className={plannerStatus?.available ? 'is-ready' : ''} />
      {plannerConnectionMessage(t, plannerStatus)}
      {plannerStatus && !plannerStatus.available ? <button type="button" title={plannerStatus.error} onClick={() => { void readPlannerStatus(undefined, locale).then(setPlannerStatus); }}>{t('surface.retryPlanner')}</button> : null}
    </div>,
  };

  const renderInspector = (node: CanvasNode, inline = false) => (
    <InspectorPanel key={node.kind === 'session' ? `${node.id}:${activeThreadId(node)}` : node.id} node={node} liveCompanies={companies} apiBase={paperclipApiBase()}
      readJson={runtimeReadJson} onSave={saveInspector} readOnly={running}
      onCloseLockChange={onInspectorLockChange} onBound={() => refreshCompanies()}
      onCreateCompany={onCreateCompany ? () => {
        if (inspectorCloseLocked.current) return;
        setInspectorId(null);
        onCreateCompany();
      } : undefined}
      onClose={() => { if (!inspectorCloseLocked.current) setInspectorId(null); }}
      style={inline
        ? { position: 'relative', width: '100%', height: '100%', inset: 'auto', borderRadius: 0 }
        : { position: 'absolute', top: 12, right: 12, bottom: 12, width: 'min(360px, calc(100% - 24px))', borderRadius: 12 }}
    />
  );

  return (
    <AgentWorkspace nodes={nodes} edges={edges} selectedIds={selection} runs={runs} running={running}
      onFocusNode={focusNode} onAddAgent={addAgent} onCreateTemplate={createTemplate}
      onSearch={() => setBarMode('search')}
      assistant={nodes.length && assistantOpen ? <CanvasAssistant mode="panel" {...assistantProps} onClose={() => setAssistantOpen(false)} /> : undefined}
      welcome={<CanvasAssistant mode="welcome" {...assistantProps} />}
      assistantOpen={assistantOpen}
      onToggleAssistant={() => setAssistantOpen(value => !value)}
      onOpenSettings={onOpenSettings ? () => { if (!inspectorCloseLocked.current) onOpenSettings(); } : undefined}
      accountControl={<div className="awwo-account-controls" inert={bindingLocked}>{accountControl}</div>}
      toolbar={<><GraphSettings doc={doc} selectedNodeId={selection[0]} selectedEdgeId={selectedEdgeId}
        disabled={running || bindingLocked} onChange={next => { if (canEditStructure()) patchDoc(() => next, { label: 'graph-settings' }); }}
        onAddPartner={nodeId => {
          if (!canEditStructure()) return;
          const result = addReviewPartner(docRef.current, nodeId, locale);
          patchDoc(() => result.doc, { label: 'review-partner' });
          setSelection([result.reviewerId]); setFocusedId(null);
        }} />
      <RunControls nodes={nodes} edges={edges} execution={doc.execution} round={reviewRound} running={running} runs={runs} summary={runSummary}
        stopped={stopped} onStart={() => void startRun()} onStop={stopRun}
        onToggleTimeline={() => setTimelineOpen(o => !o)} timelineOpen={timelineOpen}
        style={{ position: 'static', maxWidth: 'none', flexWrap: 'nowrap' }} /></>}>
    <div className="canvas-root" ref={rootRef}>
      <CanvasViewport
        view={view}
        onViewChange={setView}
        onResize={setSize}
        onBackgroundPointerDown={(e) => {
          wiring.clearPending();
          // The marquee claims Shift-drags (returning true suppresses the viewport's pan); a
          // plain background press just clears the selection.
          if (marquee.onBackgroundPointerDown(e)) return true;
          setSelection([]);
          setSelectedEdgeId(null);
          return undefined;
        }}
        onBackgroundDoubleClick={running ? undefined : (world) => addNode('llm', world)}
        onBackgroundContextMenu={
          running
            ? undefined
            : (world, client) => {
                const rect = rootRef.current?.getBoundingClientRect();
                setAddMenu({
                  at: rect ? { x: client.x - rect.left, y: client.y - rect.top } : client,
                  world,
                });
              }
        }
      >
        <WirePlane nodes={renderNodes} edges={edges} runs={runs} running={running} round={doc.execution ? reviewRound : 0} scale={view.scale}
          selectedEdgeId={selectedEdgeId ?? undefined} onSelectEdge={setSelectedEdgeId}
          preview={wiring.wireDrag} onDisconnect={running ? undefined : disconnect} />
        {nodes.map((node) => (
          <SessionTile
            key={node.id}
            node={node}
            geometry={renderNodeById.get(node.id)}
            compact={node.kind === 'session' && focusedId !== node.id}
            scale={view.scale}
            focused={focusedId === node.id}
            selected={selection.includes(node.id)}
            run={runs[node.id] ?? null}
            gatewayBase={gatewayApiBase()}
            onSend={(node, message, accepted, displayText) => { void startRun([node.id], message, accepted, displayText); }}
            conversationContext={node.kind === 'session' ? prepareNodeConversation(node, nodes, edges.filter(edge => edge.kind !== 'feedback')) : undefined}
            onIssueId={(nodeId, issueId, threadId) =>
              // Server-minted, not a user edit — never an undo step.
              patchDoc(
                (prev) => ({
                  ...prev,
                  nodes: prev.nodes.map((n) => (n.id === nodeId && n.kind === 'session'
                    ? updateThreadIssueId(n, threadId ?? activeThreadId(n), issueId) : n)),
                }),
                { silent: true },
              )
            }
            onPreview={persistPreview}
            onDraftChange={persistDraft}
            onToggleDeliverables={toggleDeliverables}
            interactionLocked={running || bindingLocked}
            onMove={running ? undefined : moveNode}
            onResizeNode={running || (node.kind === 'session' && focusedId !== node.id) ? undefined : resizeNode}
            onSelect={selectNode}
            onToggleFocus={toggleFocus}
            onFitNode={focusNode}
            onConfigure={(id) => { if (!inspectorCloseLocked.current) { setInspectorId(id); focusNode(id); } }}
            configurationPanel={node.kind === 'session' && focusedId === node.id && inspectorId === node.id ? renderInspector(node, true) : null}
            onUpdateNode={running || bindingLocked ? undefined : saveNode}
            onRunNode={running ? undefined : rerunNode}
            onDelete={running ? undefined : (id) => deleteNodes([id])}
            wiring={wiring}
          />
        ))}
        <Marquee rect={marquee.rect as WorldRect | null} />
      </CanvasViewport>

      {handoffNote && <div className="awwo-handoff-note" role="alert">{handoffNote}</div>}
      <div className="awwo-view-tools" role="toolbar" aria-label={viewText.toolbar}>
        <button aria-label={viewText.zoomOut} title={viewText.zoomOut} onClick={() => zoomBy(1 / 1.2)}><Minus size={16} /></button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button aria-label={viewText.zoomIn} title={viewText.zoomIn} onClick={() => zoomBy(1.2)}><Plus size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.fitAll} title={viewText.fitAll} disabled={!nodes.length} onClick={fitAll}><Maximize2 size={16} /></button>
        <button aria-label={viewText.arrange} title={viewText.arrangeTitle} disabled={running || bindingLocked || !nodes.length} onClick={arrangeNodes}><LayoutGrid size={16} /></button>
        <button aria-label={viewText.showMinimap} title={viewText.showMinimap} aria-pressed={minimapOpen} onClick={() => setMinimapOpen(o => !o)}><Map size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.undo} title={viewText.undo} disabled={running || !history.undo} onClick={undo}><Undo2 size={16} /></button>
        <button aria-label={viewText.redo} title={viewText.redo} disabled={running || !history.redo} onClick={redo}><Redo2 size={16} /></button>
        {selection.length > 0 && <><span className="awwo-tool-separator" /><button aria-label={viewText.runSelection} title={viewText.runSelection} disabled={running} onClick={runFromSelection}><Play size={15} /></button></>}
      </div>

      {minimapOpen && nodes.length > 0 ? (
        <Minimap
          boxes={renderNodes}
          view={view}
          size={size}
          onCenter={(wx, wy) => setView(focusWorld(viewRef.current, wx, wy, sizeRef.current))}
        />
      ) : null}

      {timelineOpen && Object.keys(runs).length > 0 ? (
        <RunTimeline
          nodes={nodes}
          runs={runs}
          runStartedAt={runStartedAt}
          now={now}
          onClose={() => setTimelineOpen(false)}
        />
      ) : null}

      {inspectorNode?.kind === 'form' ? renderInspector(inspectorNode) : null}

      {addMenu ? (
        <AddNodeMenu
          at={addMenu.at}
          onPick={(kind) => {
            addNode(kind, addMenu.world);
            setAddMenu(null);
          }}
          onClose={() => setAddMenu(null)}
        />
      ) : null}

      {barMode ? (
        <CommandBar
          mode={barMode}
          nodes={nodes}
          actions={commandActions}
          onFocusNode={(id) => {
            setBarMode(null);
            focusNode(id);
          }}
          onClose={() => setBarMode(null)}
          running={running}
          timelineOpen={timelineOpen}
          minimapOpen={minimapOpen}
          selectionCount={selection.length}
          keyHints={keyHintMap(keyBindings)}
        />
      ) : null}
    </div>
    </AgentWorkspace>
  );
}

export { CANVAS_STORAGE_KEY };
