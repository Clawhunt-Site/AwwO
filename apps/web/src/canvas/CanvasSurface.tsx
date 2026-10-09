import { canvasStorage, canvasStorageKey } from './canvasStorage';
import { accountURL } from '../saas/PersonalAccount';
import { canvasFetch } from '../saas/canvasBridge';
import { workspaceAgentCatalog } from '../saas/workspaceAgentCatalog';
import { createMarketplaceRoleNode, type TeamMarketAgent } from './teamMarketAgents';
import { createWorkspaceAgentNode, type WorkspaceAgent } from './workspaceAgents';
import { saasErrorMessage } from '../saas/api';
import { canonicalCanvasDocumentJSON } from '../saas/canvasDraft';
import { TeamRunDetails } from '../saas/TeamRunDetails';
import { unsupportedSaaSGraph } from '../saas/graphCapabilities';
import { currentSaaSCanvas, initializeSaaSCanvas, subscribeCanvasKnowledge, confirmSaaSPlanningCancellation } from '../saas/canvasBridge';
import { submitCloudGraph, mergeGraphSnapshot, cancelCloudGraph, graphAdmissionRejected, type GraphCollaborationPolicy } from '../saas/graphRuns';
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type DragEvent } from 'react';
import { Maximize2, Minus, Plus, Redo2, Undo2, Map, Play, LayoutGrid, MousePointer2 } from 'lucide-react';
import { SelectionCollaboration, CollaborationFlow, CollaborationStatus } from './SelectionCollaboration';
import { AgentWorkspace } from './AgentWorkspace';
import { CanvasAssistant, type UnifiedAssistant } from './CanvasAssistant';
import { assistantRouteRequest, TaskStartUnconfirmed, type AssistantExecutionHost, type AssistantPending, type AssistantRoute,
  type RouteAssistant } from './assistantRouting';
import { CanvasResults } from './CanvasResults';
import { ModelPersonaControls, ModelPersonaShelf } from './ModelPersonaShelf';
import { readModelPalette, type ModelPaletteSelection } from './modelPalette';
import { createModelNode, MODEL_DRAG_MIME, modelDragPayload, resolveModelDrop } from './canvasModelDrop';
import { applyJevPlan, readJevPlannerStatus, requestJevPlan } from './jevPlanning';
import { applyCanvasPlan, canvasPlanRevision, onlyAddedNodes } from './canvasPlan';
import { loadLastPlanDuration, loadPlanningConversation, savePlanningConversation, saveLastPlanDuration, requestCanvasPlan, readPlannerStatus,
  readCanvasPlanRecovery, cancelCanvasPlanRecovery, planningTurns, type PlanProgress, type PlanningMessage } from './canvasPlanning';
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
import { mediaCatalogueOf, type MediaCatalogueState } from './MediaNodeSettings';
import { mediaKindOf, mediaModelsOf, readMediaCatalogue } from './mediaCatalog';
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
import { currentGraphRunEntry } from './currentGraphRun';
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
import { boundsWithinViewport, fitBounds, fitOverview, focusWorld, MIN_READABLE_FIT_SCALE, openInPlace, visibleBoxIds, type ViewportState } from './viewport';
import { RAIL_MODEL_KEY, isDesktopStage, readRailCollapsed, useDesktopStage, writeRailCollapsed } from './railState';
import { paperclipApiBase } from '../paperclipBridge';
import { gatewayApiBase } from '../chatAutomations';
import './canvas.css';
import './node-view-styles.css';
import { nodeViewRootProps, useNodeViewPreference } from './nodeViewStyle';

/** How long patches sharing a label keep collapsing into one undo step (one drag = one step). */
const COALESCE_MS = 900;
/** Cap on remembered steps. Documents are small, but an unbounded stack is a leak. */
const HISTORY_LIMIT = 60;
/** Stage padding reserved around a focused node (room for the composer and the delivery drawer). */
const FOCUS_FIT_PADDING = { x: 28, top: 24, bottom: 82 } as const;
/** How long opening or closing a node glides the camera. */
const CAMERA_GLIDE_MS = 260;
/** The inspector overlay (cloud canvases, forms): inset from the stage, width cap, and the clear space
 *  a node opened for configuration keeps beside it. Below the 760 px breakpoint it spans the stage. */
const INSPECTOR_OVERLAY = { inset: 12, width: 360, gap: 16 } as const;
// The focused delivery overlays the conversation whenever the usable stage cannot fit both
// panes at a readable scale, including laptops with both rails visible.
const narrowFocusWidth = (stageWidth: number) => stageWidth > 0 && stageWidth <= 900 ? Math.max(280, stageWidth - FOCUS_FIT_PADDING.x * 2) : undefined;
/** Stage changes (window resize, rail toggles) settle for this long before the overview refits. */
const REFIT_DEBOUNCE_MS = 150;
/** A camera within this many pixels of the one the app fitted, at the same scale, is still the app's.
 * A click or tap on the background wobbles a few pixels (the viewport's own tap slop is 3px for a mouse
 * and 10px for touch) and a wheel tick at a clamped scale returns the same camera: neither is the
 * operator taking the camera. */
const CAMERA_SLOP_PX = 10;

function isFittedCamera(view: ViewportState, fitted: ViewportState | null): boolean {
  return fitted !== null
    && Math.abs(view.scale - fitted.scale) <= 1e-9 * Math.max(1, fitted.scale)
    && Math.abs(view.x - fitted.x) <= CAMERA_SLOP_PX
    && Math.abs(view.y - fitted.y) <= CAMERA_SLOP_PX;
}

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
  /** View the cloud snapshot without editing, persistence, planning, or run recovery. */
  readOnly?: boolean;
  workspaceName?: string;
  workspaceCaption?: string;
  /** Storage destination shown in the footer; the host owns cloud sync status. */
  storageMode?: 'local' | 'cloud';
  /** Injectable planner transport; graph edits always pass the same validation pipeline. */
  planRequest?: typeof requestCanvasPlan;
  accountControl?: ReactNode;
  headerTitle?: ReactNode;
  headerActions?: ReactNode;
  canvasTools?: ReactNode;
  /** The hosted app's managed execution. With it the assistant is one conversation whose messages the server
   *  routes (routeAssistant) to the canvas or to a task; absent (the desktop app) the assistant only plans. On a
   *  read-only canvas it shows the canvas's tasks. */
  assistantExecution?: AssistantExecutionHost;
  /** Asks the server how to handle one assistant message (POST …/assistant/route). */
  routeAssistant?: RouteAssistant;
  /** The hosted app's 成果 view: the canvas's result large, the steps that made it, and the host's run
   *  receipt. Absent (the desktop app) leaves the canvas without it. */
  results?: CanvasResultsOptions;
  /** A new external draft, never sent without the normal planning action. */
  taskDraft?: { id: string; prompt: string } | null;
  onOpenSettings?: () => void;
  /** Hosted accounts either supply their own model credential or use a platform-managed one. */
  personalCredentialsRequired?: boolean;
  /** A host-provided reason execution is unavailable. Cloud canvases remain editable. */
  executionUnavailableReason?: string;
  /** Preserve the latest in-memory edits when even the local working cache cannot be written. */
  onLocalDocumentSaveFailed?: (document: CanvasDocument) => void;
  /** Host inventory reader (App.readJson) for the inspector's contract-driven RuntimePicker.
   *  Absent → runtime selection is hidden, fail-closed. */
  runtimeReadJson?: (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;
  /** Take the user to where companies are created — binding needs one and the canvas makes none. */
  onCreateCompany?: () => void;
  /** A request the host carried here for this canvas (the hosted workspace home). The surface puts
   *  it in the planning prompt box and, when `start` holds, plans it once. Native never passes it. */
  initialPlan?: InitialPlanRequest | null;
}

/** A planning request handed over by the host, with the host's own record of whether it was sent. */
export interface InitialPlanRequest {
  prompt: string;
  /** Plan it as soon as the canvas can. False only restores the prompt to the box. */
  start: boolean;
  /** An earlier page sent this request and never reported back, so it was not applied. */
  interrupted: boolean;
  /** Records the request as sent, just before sending. False means it must not be sent from here. */
  claim: () => boolean;
  /** The request is settled: planned, restored to the box, or refused with a reason shown. */
  done: () => void;
}

/** LIVE companies a bind can target. Read straight from the control plane — the canvas no longer
 *  projects a "world" of company cards, it only needs somewhere to put a newly hired agent. */
function useLiveCompanies(apiBase: string): { companies: Array<{ id: string; name: string }>; refresh: () => void } {
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let stale = false;
    const base = apiBase.replace(/\/+$/, '');
    void canvasFetch(`${base}/companies`, { credentials: 'include', headers: { accept: 'application/json' } })
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

export interface CanvasResultsOptions {
  /** The host's record of the run behind the result. */
  receipt?: (final: CanvasNode | null) => ReactNode;
  /** Open in the 成果 view (a link to a canvas's results). */
  initialView?: 'canvas' | 'results';
  /** The view changed; a host can keep it in the address. */
  onViewChange?: (view: 'canvas' | 'results') => void;
}

export function CanvasSurface({ readOnly = false, workspaceName, workspaceCaption, storageMode = 'local', runtimeReadJson, onCreateCompany, accountControl, headerTitle, headerActions, canvasTools, assistantExecution, routeAssistant, results, taskDraft = null, onOpenSettings, personalCredentialsRequired = false, executionUnavailableReason, onLocalDocumentSaveFailed, planRequest = requestCanvasPlan, initialPlan = null }: CanvasSurfaceProps = {}) {
  const { locale, t } = useCanvasI18n();
  const viewText = surfaceViewMessages(t);
  // The opened-node look is a viewer preference: it styles focused tiles only and never the document.
  const [nodeViewPreference] = useNodeViewPreference();
  const nodeViewRoot = useMemo(() => nodeViewRootProps(nodeViewPreference), [nodeViewPreference]);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const setupRequest = useRef<AbortController | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [agentLibraryRequest, setAgentLibraryRequest] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; setupRequest.current?.abort(); }; }, []);
  const cloudScope = currentSaaSCanvas();
  const loadWorkspaceAgents = useMemo(() => storageMode === 'cloud' && cloudScope ? workspaceAgentCatalog(cloudScope.tenant.id) : undefined, [storageMode, cloudScope?.tenant.id]);
  const [storage] = useState(canvasStorage);
  const canInitialize = storageMode === 'cloud' && Boolean(cloudScope);
  const runUnavailableReason = storageMode === 'cloud' ? executionUnavailableReason?.trim() || '' : '';
  const [palette, setPalette] = useState<Awaited<ReturnType<typeof readModelPalette>> | null>(null);
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [paletteError, setPaletteError] = useState('');
  const [paletteRefresh, setPaletteRefresh] = useState(0);
  const [palettePersona, setPalettePersona] = useState<AgentTemplateId | null>(null);
  // The model rail starts collapsed on a desktop stage (the canvas gets the width) and remembers
  // the operator's choice per browser. Below the desktop width the rail is a drawer that always
  // opens on the full shelf, whatever was stored, exactly like the Bot drawer.
  const [shelfCollapsed, setShelfCollapsedState] = useState(() => readRailCollapsed(RAIL_MODEL_KEY, isDesktopStage()));
  const desktopStage = useDesktopStage();
  const modelRailCollapsed = shelfCollapsed && desktopStage;
  const setShelfCollapsed = useCallback((collapsed: boolean) => {
    setShelfCollapsedState(collapsed);
    writeRailCollapsed(RAIL_MODEL_KEY, collapsed);
  }, []);
  // Bumped by the workspace when a rail toggles; the refit effect below listens to it.
  const [railsVersion, setRailsVersion] = useState(0);
  const onRailsChange = useCallback(() => setRailsVersion(value => value + 1), []);
  useEffect(() => {
    setPalette(null); setPaletteError('');
    if (!canInitialize || readOnly) return;
    const controller = new AbortController();
    const scope = cloudScope;
    setPaletteLoading(true);
    void readModelPalette(controller.signal, locale).then(value => {
      if (!controller.signal.aborted && currentSaaSCanvas() === scope) setPalette(value);
    }).catch(error => {
      if (!controller.signal.aborted && currentSaaSCanvas() === scope) setPaletteError(saasErrorMessage(error, locale));
    }).finally(() => { if (!controller.signal.aborted && currentSaaSCanvas() === scope) setPaletteLoading(false); });
    return () => controller.abort();
  }, [canInitialize, cloudScope, readOnly, locale, paletteRefresh]);
  // The workspace's image and video models. A failed read is reported in the inspector, never
  // shown as a workspace without media models.
  const [mediaState, setMediaState] = useState<MediaCatalogueState | undefined>(undefined);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  useEffect(() => {
    setMediaState(undefined);
    if (!canInitialize || readOnly) return;
    const controller = new AbortController();
    const scope = cloudScope;
    setMediaState({ status: 'loading' });
    void readMediaCatalogue(controller.signal).then(catalogue => {
      if (!controller.signal.aborted && currentSaaSCanvas() === scope) setMediaState({ status: 'ready', catalogue });
    }).catch(() => {
      if (!controller.signal.aborted && currentSaaSCanvas() === scope) setMediaState({ status: 'error' });
    });
    return () => controller.abort();
  }, [canInitialize, cloudScope, readOnly, mediaRefresh]);
  const mediaKinds = useMemo(() => (['image', 'video'] as const).filter(kind => mediaModelsOf(mediaCatalogueOf(mediaState), kind).length > 0), [mediaState]);
  const inspectorCloseLocked = useRef(false);
  const [bindingLocked, setBindingLocked] = useState(false);
  const onInspectorLockChange = useCallback((locked: boolean) => {
    inspectorCloseLocked.current = locked;
    setBindingLocked(locked);
  }, []);
  // ---- document -----------------------------------------------------------------------------
  const [doc, setDoc] = useState<CanvasDocument>(() => {
    if (readOnly) return loadDocumentWithStatus({ readOnly: true }).doc;
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
  const outdatedObserver = useRef(false);
  const lastSavedDocument = useRef<string | null>(null);
  const pendingRecoveryDocument = useRef<{ storageKey: string; journalId: string; document: string } | null>(null);
  if (lastSavedDocument.current === null) lastSavedDocument.current = canonicalCanvasDocumentJSON(doc);
  // Compare revisions in the same normalized shape the loader returns. The last successful
  // local save is also the base of an edit whose autosave effect has not committed yet.
  const lastSavedRevision = useRef<string | null>(null);
  const localSaveFailure = useRef(onLocalDocumentSaveFailed);
  localSaveFailure.current = onLocalDocumentSaveFailed;
  if (lastSavedRevision.current === null) lastSavedRevision.current = canvasPlanRevision(sanitizeDocument(doc));
  const saveLocalDocument = useCallback((next: CanvasDocument): boolean => {
    if (outdatedObserver.current) return false;
    if (!saveDocument(next)) {
      localSaveFailure.current?.(next);
      return false;
    }
    lastSavedRevision.current = canvasPlanRevision(sanitizeDocument(next));
    lastSavedDocument.current = canonicalCanvasDocumentJSON(next);
    pendingRecoveryDocument.current = null;
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
      if (readOnlyRef.current || outdatedObserver.current || setupRequest.current
          || (!runAbort.current && (journal.current || recoveringRef.current || loadRunJournal()))) return;
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
    readOnlyRef.current || outdatedObserver.current || setupRequest.current || runAbort.current || journal.current || loadRunJournal() || recoveringRef.current
    || (inspectorCloseLocked.current && !allowBindingSave) || hasStreamingConversation(docRef.current.nodes)
  ), []);

  /**
   * Step to a stored document without recording it as a new edit. The camera is not history (its
   * save is a machine write): the canvas keeps the camera it has now, not the one saved when that
   * step was taken, which the screen would not show and a reopen would land on.
   */
  const restoreDoc = useCallback((target: CanvasDocument) => {
    if (readOnlyRef.current || outdatedObserver.current || setupRequest.current || loadRunJournal()) return;
    lastCommit.current = null;
    const live = docRef.current;
    const restored = invalidateOutputs(live, { ...target, view: live.view, nodes: target.nodes.map(node => {
      const current = live.nodes.find(n => n.id === node.id);
      if (node.kind !== 'session' || current?.kind !== 'session') return node;
      return preserveThreadRuntime(node, current);
    }) });
    docRef.current = restored;
    setDoc(restored);
  }, []);

  // The planning section says which step is its plan's, and hears when an undo steps back over it (by the
  // assistant's 撤销, a hand-over to a task, or Ctrl+Z alike) and when a redo brings that very document back.
  const planStep = useRef<{ isPlan: () => boolean; undone: (planDoc: CanvasDocument) => void; redone: (doc: CanvasDocument) => void;
    reset: () => void } | null>(null);
  // The undo entry the latest plan's commit pushed (the document before it): undoing back over it undoes the plan,
  // however many later steps were undone first.
  const planUndoEntry = useRef<CanvasDocument | null>(null);
  // Says whether it stepped back: a canvas that cannot be edited now (a node talking, a run) keeps its document.
  const undo = useCallback(() => {
    if (!canEditStructure()) return false;
    const prevDoc = undoStack.current.at(-1);
    if (!prevDoc) return false;
    const overPlan = planStep.current?.isPlan() ?? false;
    const current = docRef.current;
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, current].slice(-HISTORY_LIMIT);
    restoreDoc(prevDoc);
    syncHistory();
    if (overPlan) planStep.current?.undone(current);
    return true;
  }, [canEditStructure, restoreDoc, syncHistory]);

  const redo = useCallback(() => {
    if (!canEditStructure()) return;
    const nextDoc = redoStack.current.at(-1);
    if (!nextDoc) return;
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, docRef.current].slice(-HISTORY_LIMIT);
    restoreDoc(nextDoc);
    syncHistory();
    planStep.current?.redone(nextDoc);
  }, [canEditStructure, restoreDoc, syncHistory]);

  useEffect(() => {
    // Another tab can clear the durable journal before this observer adopts its final
    // document. Keep queued ordinary saves from publishing our previous canvas in that gap.
    if (readOnlyRef.current || outdatedObserver.current || setupRequest.current
        || (!runAbort.current && (journal.current || recoveringRef.current || loadRunJournal()))) return;
    saveLocalDocument({ ...doc, edges });
  }, [doc, edges, readOnly, saveLocalDocument]);

  // ---- viewport / selection / focus ----------------------------------------------------------
  const [view, setView] = useState<ViewportState>(() => doc.view ?? { x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  // Opening and closing a node glide the camera, so the card is seen to grow out of where it sat and to
  // shrink back into it. Every other camera change goes through moveCamera, which ends a glide first, so
  // a pan, zoom, fit or waypoint during one is never overwritten by its next frame. Reduced motion jumps.
  const glide = useRef<number | null>(null);
  // Where a glide in progress will land: the camera to reason about while it moves.
  const glideTarget = useRef<ViewportState | null>(null);
  const stopGlide = useCallback(() => {
    if (glide.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(glide.current);
    glide.current = null;
    glideTarget.current = null;
  }, []);
  const moveCamera = useCallback((next: ViewportState | ((previous: ViewportState) => ViewportState)) => {
    stopGlide();
    setView(next);
  }, [stopGlide]);
  /** Glides to `target`; the world point `anchor` travels in a straight line on screen while the zoom
   *  changes geometrically (a node's corner, so the card stays under the eye). */
  const glideTo = useCallback((target: ViewportState, anchor: { x: number; y: number }) => {
    stopGlide();
    const from = viewRef.current;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof requestAnimationFrame !== 'function' || !(from.scale > 0) || !(target.scale > 0)) { setView(target); return; }
    glideTarget.current = target;
    const fromX = anchor.x * from.scale + from.x, fromY = anchor.y * from.scale + from.y;
    const toX = anchor.x * target.scale + target.x, toY = anchor.y * target.scale + target.y;
    // Elapsed time is read from one clock: the frame timestamp's origin is not guaranteed to match.
    const started = performance.now();
    const frame = () => {
      const t = Math.min(1, Math.max(0, (performance.now() - started) / CAMERA_GLIDE_MS));
      const k = 1 - (1 - t) ** 3;
      const scale = from.scale * (target.scale / from.scale) ** k;
      setView(t >= 1 ? target : { scale, x: fromX + (toX - fromX) * k - anchor.x * scale, y: fromY + (toY - fromY) * k - anchor.y * scale });
      glide.current = t >= 1 ? null : requestAnimationFrame(frame);
      if (t >= 1) glideTarget.current = null;
    };
    glide.current = requestAnimationFrame(frame);
  }, [stopGlide]);
  useEffect(() => stopGlide, [stopGlide]);
  // The camera the app itself last fitted to the overview. While the live view is still that camera
  // (within tap slop, same scale) the operator has not taken it, so a stage change may refit it; a real
  // pan, a zoom, a focus or a waypoint moves it further and the camera is the operator's from then on.
  const lastAutoView = useRef<ViewportState | null>(null);
  // A camera the app placed on its own (on open, or after the stage changed shape) is a fit to this screen,
  // not where the operator left the canvas, so it is not saved: opening a canvas on another screen must not
  // rewrite, and save, the camera they left. A requested fit (Fit All, an arrangement, a plan) is theirs, and
  // so is a recalled waypoint. A canvas with no saved camera starts on the app's default one.
  const unsavedCamera = useRef<ViewportState | null>(doc.view ? null : view);
  // The operator's camera waiting out the save debounce (see the viewport persistence below).
  const pendingCameraSave = useRef<{ timer: ReturnType<typeof setTimeout>; camera: ViewportState; save: () => void } | null>(null);
  const autoFit = useCallback((fitNodes: ReadonlyArray<CanvasNode>, box: { w: number; h: number }, automatic = false) => {
    const next = fitNodeOverview(fitNodes, box);
    lastAutoView.current = next;
    // The app refits only a camera it may take over (a requested fit, say): the operator's camera still waiting to be
    // saved is saved now, before the refit replaces it, if it is still the live one (not a frame the camera has left).
    const pending = automatic ? pendingCameraSave.current : null;
    if (pending) {
      clearTimeout(pending.timer); pendingCameraSave.current = null;
      const live = viewRef.current;
      if (pending.camera.x === live.x && pending.camera.y === live.y && pending.camera.scale === live.scale) pending.save();
    }
    unsavedCamera.current = automatic ? next : null;
    moveCamera(next);
  }, [moveCamera]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const rootRef = useRef<HTMLDivElement>(null);
  const [handoffNote, setHandoffNote] = useState('');
  const refusedRevision = useRef<string | null>(null);
  useEffect(() => {
    if (refusedRevision.current && refusedRevision.current !== canvasPlanRevision(doc)) {
      refusedRevision.current = null;
      setHandoffNote('');
    }
  }, [doc]);

  const [selection, setSelection] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Read inside the drag so moving a group never depends on the callback identity at press time.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const renderNodes = useMemo(() => presentationNodes(nodes, focusedId, narrowFocusWidth(size.w)), [nodes, focusedId, size.w]);
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
    focusReturn.current = null;
    autoFit(nodes, box);
  }, [nodes, viewportSize, autoFit]);

  // The saved view owns the initial position only while it still shows the whole graph on THIS
  // stage; a view persisted on a wider screen (or none at all) fits once the first real size is
  // known. Explicit Fit and newly generated plans still fit on request.
  const savedView = useRef(doc.view);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.w === 0) return;
    const saved = savedView.current;
    // An empty graph has nothing to fit; a saved view keeps owning the camera, an unpositioned
    // canvas waits for its first node.
    if (nodes.length === 0) { if (saved) fitted.current = true; return; }
    fitted.current = true;
    const box = viewportSize() || size;
    // A kept saved view already shows the whole graph, so it counts as fitted: a later stage change
    // may refit it, exactly as it would the overview computed below.
    if (saved && boundsWithinViewport(boundsOfNodes(presentationNodes(nodes, null)), saved, box)) { lastAutoView.current = viewRef.current; return; }
    autoFit(nodes, box, true);
  }, [size, nodes, viewportSize, autoFit]);

  // Refit the overview when the stage itself changes shape — a window resize, a rail collapsing
  // or expanding, the planning assistant opening — so the whole graph stays on screen at the real
  // stage size. Only a camera the app fitted is refitted: never while a node is focused and never
  // once the operator has zoomed, panned or recalled a view (that camera is theirs until Fit All),
  // never on the first measurement (the open logic above owns that), never for a repeated
  // identical measurement, and debounced so a live window drag is not fought frame by frame.
  const focusedRef = useRef<string | null>(null);
  focusedRef.current = focusedId;
  const stageSignature = useRef<string | null>(null);
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    const signature = `${size.w}x${size.h}:${railsVersion}:${modelRailCollapsed ? 1 : 0}`;
    const previous = stageSignature.current;
    stageSignature.current = signature;
    if (previous === null || previous === signature) return;
    const timer = setTimeout(() => {
      if (focusedRef.current !== null || inspectorCloseLocked.current || !isFittedCamera(viewRef.current, lastAutoView.current)) return;
      const current = docRef.current.nodes;
      const box = viewportSize();
      if (!current.length || !box) return;
      autoFit(current, box, true);
    }, REFIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [size, railsVersion, modelRailCollapsed, viewportSize, autoFit]);

  // What the stage shows: the board, or (where the host offers it) the canvas's 成果. The board stays
  // mounted under the results, so its camera, runs and open node are as they were on the way back.
  const [stageView, setStageView] = useState<'canvas' | 'results'>(() => results?.initialView === 'results' ? 'results' : 'canvas');
  const stageViewRef = useRef(stageView);
  const onStageViewChange = useRef(results?.onViewChange);
  onStageViewChange.current = results?.onViewChange;
  const changeStageView = useCallback((next: 'canvas' | 'results') => {
    if (stageViewRef.current === next) return;
    stageViewRef.current = next; setStageView(next); onStageViewChange.current?.(next);
  }, []);
  // The 成果 view needs something to show the steps of; an emptied canvas returns to the board.
  const showingResults = Boolean(results) && stageView === 'results' && nodes.length > 0;
  useEffect(() => { if (stageView === 'results' && !nodes.length) changeStageView('canvas'); }, [stageView, nodes.length, changeStageView]);
  // After a control that had focus goes away (it unmounted or its view closed), focus moves to `selector`.
  const refocus = useCallback((selector: string) => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      rootRef.current?.closest('.awwo-workspace')?.querySelector<HTMLElement>(selector)?.focus();
    });
  }, []);

  const focusNode = useCallback(
    (nodeId: string, options: { configure?: boolean } = {}) => {
      if (inspectorCloseLocked.current) return;
      // Opening a node always shows the board.
      changeStageView('canvas');
      const box = viewportSize();
      const node = presentationNodes(docRef.current.nodes, nodeId, narrowFocusWidth(box?.w ?? sizeRef.current.w)).find((n) => n.id === nodeId);
      if (!node) return;
      // The camera as it will be once a glide in progress lands: reopening mid-glide must not take a
      // passing frame for the operator's camera.
      const current = glideTarget.current ?? viewRef.current;
      // The operator's camera is kept from the first open until the node is left: every way out clears
      // it, so an empty one means nothing is open, whatever render this callback came from.
      if (focusReturn.current === null) focusReturn.current = current;
      if (focusedId !== nodeId) setInspectorId(current => current === nodeId ? current : null);
      setFocusedId(nodeId);
      setSelection([nodeId]);
      if (!box) return;
      // Cap the focus scale so the whole node — delivery drawer included — fits the stage inside
      // the focus padding.
      const pad = FOCUS_FIT_PADDING;
      const availH = Math.max(120, box.h - pad.top - pad.bottom);
      // Opened to be configured (or re-fitted while its inspector is open) where the inspector floats
      // over the stage (cloud canvases, forms), the node keeps clear of it, as far as it can while
      // staying readable: the reserve shrinks before the node would drop below the readable scale.
      // Where the inspector spans the stage instead (the hosted app at 760 px and below), nothing is
      // reserved.
      const spansStage = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 760px)').matches)
        && Boolean(rootRef.current?.closest('.saas-canvas-shell'));
      const inspectorRoom = INSPECTOR_OVERLAY.inset + Math.min(INSPECTOR_OVERLAY.width, box.w - INSPECTOR_OVERLAY.inset * 2) + INSPECTOR_OVERLAY.gap;
      const readable = Math.min(MIN_READABLE_FIT_SCALE, availH / Math.max(1, node.h));
      const configuring = options.configure || inspectorRef.current === nodeId;
      const right = configuring && (canInitialize || node.kind === 'form') && !spansStage
        ? Math.max(pad.x, Math.min(inspectorRoom, box.w - pad.x - node.w * readable)) : pad.x;
      const availW = Math.max(120, box.w - pad.x - right);
      const maxScale = Math.min(1.25, availW / Math.max(1, node.w), availH / Math.max(1, node.h));
      // Open the node where it is, never re-centred: the operator's own zoom when it is readable and the
      // node fits, the card's corner kept where it sat on screen, moved only as far as the stage needs.
      const scale = current.scale >= 1 && current.scale <= maxScale ? current.scale : maxScale;
      glideTo(openInPlace(current, { minX: node.x, minY: node.y, maxX: node.x + node.w, maxY: node.y + node.h }, box, scale, { ...pad, right }),
        { x: node.x, y: node.y });
    },
    [focusedId, viewportSize, glideTo, canInitialize, changeStageView],
  );
  // The latest focusNode, for a focus deferred to the next frame (an older one judges a stale render).
  const focusNodeRef = useRef(focusNode);
  focusNodeRef.current = focusNode;

  const arrangeNodes = useCallback(() => {
    if (!canEditStructure()) return;
    const arranged = arrangeNodePositions(docRef.current.nodes, docRef.current.edges);
    patchDoc(previous => ({ ...previous, nodes: arranged }), { label: 'arrange:nodes' });
    setInspectorId(null);
    setFocusedId(null);
    focusReturn.current = null;
    const box = viewportSize();
    if (box) autoFit(arranged, box);
  }, [canEditStructure, patchDoc, viewportSize, autoFit]);

  /** The camera the operator had before opening a node, glided back to (and forgotten), so leaving a
   *  node — closing it, deleting it, adding a review partner from it — lands where they were. */
  const restoreFocusCamera = useCallback(() => {
    const back = focusReturn.current;
    focusReturn.current = null;
    // Only an open node has a camera to return from; with none open, a leftover one is just forgotten.
    if (!back || !focusedRef.current) return;
    const node = docRef.current.nodes.find(candidate => candidate.id === focusedRef.current);
    if (node) glideTo(back, { x: node.x, y: node.y });
    else moveCamera(back);
  }, [glideTo, moveCamera]);

  const unfocus = useCallback(() => {
    if (inspectorCloseLocked.current) return;
    setInspectorId(null);
    restoreFocusCamera();
    setFocusedId(null);
  }, [restoreFocusCamera]);

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
          moveCamera(focusWorld(viewRef.current, n.x + n.w / 2, n.y + n.h / 2, sizeRef.current));
        }
      }
    },
    [nodes, renderNodes, selection, focusedId, focusNode, moveCamera],
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
      if (!wp) return;
      // The operator's choice, even where it matches the app's own fit.
      unsavedCamera.current = null;
      moveCamera(wp.view);
    },
    [doc.waypoints],
  );

  // ---- run state ----------------------------------------------------------------------------
  const [initialJournal] = useState(() => readOnly ? null : loadRunJournal());
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
    if (readOnly) return;
    const observeOtherTab = (event: StorageEvent) => {
      if (readOnlyRef.current || outdatedObserver.current) return;
      if (event.key !== canvasStorageKey(CANVAS_RUN_JOURNAL_KEY) || runAbort.current) return;
      const active = loadRunJournal();
      if (active) {
        journal.current = active; setRuns(active.nodes); setReviewRound(active.review?.round ?? 0); setRunning(true); setRecovering(true);
      }
    };
    window.addEventListener('storage', observeOtherTab);
    return () => window.removeEventListener('storage', observeOtherTab);
  }, [readOnly]);
  // A page reload detaches observation; only an explicit Stop cancels native execution.
  const updateJournal = useCallback((nodeId: string, patch: Parameters<typeof patchRunJournalNode>[2]) => {
    if (readOnlyRef.current || outdatedObserver.current || !journal.current) return;
    journal.current = patchRunJournalNode(journal.current, nodeId, patch);
    if (!saveRunJournal(journal.current)) setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
  }, []);
  useEffect(() => {
    if (readOnly || !recovering || outdatedObserver.current) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const capturedDocumentKey = canvasStorageKey(CANVAS_STORAGE_KEY);
    const observerIsActive = () => !controller.signal.aborted && !outdatedObserver.current && mounted.current
      && currentSaaSCanvas() === cloudScope && canvasStorageKey(CANVAS_STORAGE_KEY) === capturedDocumentKey;
    const pauseOutdatedObserver = () => {
      outdatedObserver.current = true;
      setRecovering(false);
      setHandoffNote(locale === 'zh'
        ? '当前页面的画布已过期，已暂停恢复。请先保留本页未保存内容，再重新加载；原运行记录未更改。'
        : 'This page has an older canvas, so recovery is paused. Preserve any unsaved work before reloading. The original run record is unchanged.');
      return false;
    };
    const hasNoUnsavedSourceEdits = () => {
      const live = canonicalCanvasDocumentJSON(docRef.current);
      const pending = pendingRecoveryDocument.current;
      return live === lastSavedDocument.current || Boolean(pending && pending.document === live
        && pending.storageKey === capturedDocumentKey && pending.journalId === (loadRunJournal()?.id ?? journal.current?.id));
    };
    const canWriteRecovery = () => {
      if (!observerIsActive()) return false;
      const cached = loadDocumentWithStatus({ readOnly: true });
      // Scoped fingerprints omit unrelated nodes, drafts and history. Protect the complete
      // durable base AND any unsaved source edits in this page before rewriting the cache.
      // Only an exact recovery result that this observer failed to save may be retried.
      return cached.status === 'ok' && canonicalCanvasDocumentJSON(cached.doc) === lastSavedDocument.current
        && hasNoUnsavedSourceEdits() ? true : pauseOutdatedObserver();
    };
    const refreshedHistories = new Set<string>();
    setHandoffNote(surfaceNotice(t, 'recovering_run'));
    const poll = () => withCanvasRunOwnership(async () => {
      if (!observerIsActive()) return;
      const durable = loadRunJournal();
      if (!durable) {
        if (!hasNoUnsavedSourceEdits()) { pauseOutdatedObserver(); return; }
        // The tab that owned execution already persisted its final document and cleared the
        // journal. Its transcript store is not shared with this tab: even a loaded history
        // here may have been fetched before the final reply. Refresh only the observed
        // execution's exact sessions, without recreating a journal or dispatching a turn.
        const observed = journal.current;
        const retry = () => {
          setHandoffNote(surfaceNotice(t, 'recovery_pending'));
          timer = setTimeout(() => void poll(), 2500);
        };
        const current = loadDocumentWithStatus({ readOnly: true });
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
        if (!observerIsActive()) return;
        if (!hasNoUnsavedSourceEdits()) { pauseOutdatedObserver(); return; }
        docRef.current = current.doc; setDoc(current.doc);
        lastSavedDocument.current = canonicalCanvasDocumentJSON(current.doc);
        lastSavedRevision.current = canvasPlanRevision(sanitizeDocument(current.doc));
        pendingRecoveryDocument.current = null;
        journal.current = null; setRecovering(false); setRunning(false); setRuns({}); setReviewRound(0);
        setHandoffNote(surfaceNotice(t, 'recovery_complete'));
        return;
      }
      if (!canWriteRecovery()) return;
      journal.current = durable;
      setReviewRound(durable.review?.round ?? 0);
      if (!journal.current) return;
      const observed = journal.current;
      const reconciled = await reconcileRunJournal(observed, docRef.current.nodes, gatewayApiBase(), controller.signal);
      if (!observerIsActive()) return;
      // A Stop confirmation may have landed while this read was in flight. Never overwrite it
      // with a response based on the old snapshot; reconcile the new journal in the next pass.
      if (journal.current !== observed || JSON.stringify(loadRunJournal()) !== JSON.stringify(observed)) {
        timer = setTimeout(() => void poll(), 2500);
        return;
      }
      if (!canWriteRecovery()) return;
      const recoveredJournal = recoveryJournalForDocument(docRef.current, reconciled);
      // SaaS runs are settled durably by Go; only native gateway runs own a native hold.
      const next = cloudScope || recoveredJournal.serverGraph ? recoveredJournal
        : await settleRecoveredJournal(gatewayApiBase(), recoveredJournal, controller.signal);
      if (!observerIsActive()) return;
      if (journal.current !== observed || JSON.stringify(loadRunJournal()) !== JSON.stringify(observed)) {
        timer = setTimeout(() => void poll(), 2500);
        return;
      }
      if (!canWriteRecovery()) return;
      journal.current = next;
      saveRunJournal(next);
      setRuns(next.nodes);
      setReviewRound(next.review?.round ?? 0);
      setRunStartedAt(next.startedAt);
      if (!next.collaboration) setTimelineOpen(true);
      const recovered = applyRecoveredDocument(docRef.current, { ...next, inputFingerprint: next.inputFingerprint ?? '' });
      docRef.current = recovered; setDoc(recovered);
      // Persist the complete batch before deleting its recovery journal.
      const persisted = saveLocalDocument(recovered);
      pendingRecoveryDocument.current = persisted ? null
        : { storageKey: capturedDocumentKey, journalId: next.id, document: canonicalCanvasDocumentJSON(recovered) };
      const unresolved = Object.values(next.nodes).some(node => node.state === 'running' || (next.serverGraph && node.state === 'waiting'));
      if (unresolved) {
        const missing = Object.values(next.nodes).some(node => node.detail === 'recovery_identity_missing');
        setHandoffNote(missing ? surfaceNotice(t, 'run_identity_unconfirmed') : surfaceNotice(t, next.serverGraph ? 'graph_recovery_pending' : 'recovery_pending'));
        timer = setTimeout(() => void poll(), 2500);
      } else if (!persisted) {
        setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
        timer = setTimeout(() => void poll(), 2500);
      } else {
        const stillCurrent = () => {
          if (!canWriteRecovery()) return false;
          if (journal.current === next && storage.getItem(CANVAS_RUN_JOURNAL_KEY) === JSON.stringify(next)) return true;
          timer = setTimeout(() => void poll(), 2500);
          return false;
        };
        for (const node of docRef.current.nodes) {
          const entry = next.nodes[node.id];
          if (node.kind === 'session' && entry?.threadId === activeThreadId(node) && node.issueId
              && entry.companyId === node.binding?.companyId && entry.agentId === node.binding?.agentId) {
            if (entry.operationId) updateConversationPresentation(node, entry.operationId, {
              issueId: node.issueId, runId: entry.runId, outputText: entry.output ?? '',
              outputState: entry.state === 'done' ? 'final' : 'failed',
            }, storage);
            if (next.manual && !await persistManualHistoryWithNativeProof(gatewayApiBase(), node, next, controller.signal)) {
              if (controller.signal.aborted) return;
              setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
              timer = setTimeout(() => void poll(), 2500);
              return;
            }
            if (!stillCurrent()) return;
            const storeKey = sessionStoreKey(node);
            forgetNode(storeKey);
            await restoreHistory({ gatewayBase: gatewayApiBase(), node,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
            if (!stillCurrent()) return;
            if (next.manual) replaceTurns(storeKey, projectConversationTurns(node,
              mergeRecoveredManualConversation(getSessionSnapshot(storeKey).turns, next, node.id), storage));
          }
        }
        if (!stillCurrent()) return;
        clearRunJournal(next.id); journal.current = null;
        setRecovering(false); setRunning(false);
        setRunSummary(journalSummary(next));
        if (next.collaboration && next.serverGraph?.status === 'completed') {
          const leadId = next.collaboration.synthesizerNodeId;
          const result = docRef.current.nodes.find(node => node.id === leadId);
          if (result?.kind === 'session' && result.lastOutput && !result.lastOutput.partial) {
            const opened = { ...docRef.current, nodes: docRef.current.nodes.map(node => node.id === leadId ? { ...node, deliverablesOpen: true } : node) };
            if (saveLocalDocument(opened)) { docRef.current = opened; setDoc(opened); }
            // Someone watching the 成果 view already sees the result there; it stays open.
            if (stageViewRef.current !== 'results') focusNode(leadId);
          }
        }
        setHandoffNote(surfaceNotice(t, Object.values(next.nodes).some(node => node.detail === 'recovery_input_changed') ? 'recovery_input_changed' : next.serverGraph ? 'graph_recovery_complete' : 'recovery_complete'));
      }
    }, () => {
      if (controller.signal.aborted) return;
      setHandoffNote(surfaceNotice(t, 'execution_owned_elsewhere'));
      timer = setTimeout(() => void poll(), 2500);
    });
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [readOnly, recovering, patchDoc, saveLocalDocument, t, locale, focusNode]);
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
  const prepareNodes = useCallback(async (scope?: readonly string[]): Promise<CanvasDocument> => {
    // This is the shared cloud initialization path (graph, node, conversation and inspector).
    // Missing user credentials must never reach POST /initialize, even via a hidden shortcut.
    if (runUnavailableReason) throw new Error(runUnavailableReason);
    if (!currentSaaSCanvas()) return docRef.current;
    const sessionScope = scope?.filter(id => docRef.current.nodes.some(node => node.id === id && node.kind === 'session'));
    if (sessionScope?.length === 0) return docRef.current;
    if (setupRequest.current) throw new Error(locale === 'zh' ? '节点正在准备，请稍候。' : 'Nodes are being prepared. Please wait.');
    const controller = new AbortController();
    setupRequest.current = controller; setInitializing(true); setHandoffNote('');
    try {
      // Save the synchronous ref now: React's document effect has not necessarily committed yet.
      if (!saveLocalDocument(docRef.current)) throw new Error(surfaceNotice(t, 'storage_unavailable'));
      const document = await initializeSaaSCanvas(sessionScope, controller.signal);
      if (!mounted.current || controller.signal.aborted || readOnlyRef.current) throw new Error(locale === 'zh' ? '节点准备已取消。' : 'Node setup was cancelled.');
      docRef.current = document; setDoc(document);
      lastSavedRevision.current = canvasPlanRevision(sanitizeDocument(document));
      lastSavedDocument.current = canonicalCanvasDocumentJSON(document);
      return document;
    } finally {
      if (setupRequest.current === controller) setupRequest.current = null;
      if (mounted.current) setInitializing(false);
    }
  }, [locale, t, saveLocalDocument, runUnavailableReason]);

  const startRun = useCallback((scope?: ReadonlyArray<string>, manualMessage?: string, onAccepted?: () => void, manualDisplayText?: string, collaboration?: GraphCollaborationPolicy) => {
    if (readOnlyRef.current || outdatedObserver.current) return Promise.resolve();
    if (runUnavailableReason) { setHandoffNote(runUnavailableReason); return Promise.resolve(); }
    const collaborationRevision = collaboration ? canvasPlanRevision(docRef.current) : undefined;
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
    if (!mounted.current || currentSaaSCanvas() !== cloudScope || readOnlyRef.current || outdatedObserver.current || setupRequest.current || runAbort.current || journal.current) return;
    if (collaboration && (!cloudScope || manualMessage || !scope || scope.length < 2 || scope.length > 6
      || !scope.includes(collaboration.synthesizerNodeId)
      || collaborationRevision !== canvasPlanRevision(docRef.current)
      || scope.some(id => { const node = docRef.current.nodes.find(n => n.id === id); return node?.kind !== 'session' || Boolean(node.team); }))) {
      setHandoffNote(locale === 'zh' ? '选区已变化或不能互审，请重新选择 2–6 个独立 Agent。' : 'The selection changed or cannot be reviewed. Select 2–6 individual Agents again.'); return;
    }
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
    if (!mounted.current || currentSaaSCanvas() !== cloudScope || readOnlyRef.current || runAbort.current || journal.current || loadRunJournal()) return;
    const persistedCanvas = loadDocumentWithStatus();
    const persistedRevision = canvasPlanRevision(persistedCanvas.doc);
    if (persistedCanvas.status === 'ok'
        && persistedRevision !== canvasPlanRevision(sanitizeDocument(docRef.current))
        && persistedRevision !== lastSavedRevision.current) {
      docRef.current = persistedCanvas.doc; setDoc(persistedCanvas.doc);
      // Another tab's document: what this page's undo knew about the plan no longer describes it.
      planStep.current?.reset();
      lastSavedRevision.current = persistedRevision;
      lastSavedDocument.current = canonicalCanvasDocumentJSON(persistedCanvas.doc);
      setHandoffNote(surfaceNotice(t, 'canvas_changed_elsewhere'));
      return;
    }
    // Freeze the current ref after acquiring ownership: a drag/edit may be newer than the
    // render that supplied this callback, even when its persistence base is still current.
    const nodes = docRef.current.nodes;
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
    if (!currentSaaSCanvas() && nodes.some(node => node.kind === 'session' && node.team && (!scope || scope.includes(node.id)))) {
      setHandoffNote(locale === 'zh' ? '此工作区未提供节点团队执行能力，请使用 SaaS 工作区运行。' : 'This workspace cannot execute node teams. Run this canvas in a SaaS workspace.'); return;
    }
    const refuseUnsupportedGraph = (document: CanvasDocument) => {
      if (!currentSaaSCanvas() || manualMessage || collaboration || !unsupportedSaaSGraph(document)) return false;
      setHandoffNote(locale === 'zh' ? '此工作区支持框选组件后互审优化；已有原生互审策略及反馈连线请在原生工作区运行。配置已保留。' : 'Select components to review and improve them here. Existing native review policies and feedback connections require a native workspace. Their configuration is preserved.');
      return true;
    };
    if (refuseUnsupportedGraph(docRef.current)) return;
    let runDocument = docRef.current;
    try {
      if (currentSaaSCanvas()) {
        runDocument = await prepareNodes(scope);
        // Keep the live document in sync with the prepared one: the recovery poll re-computes
        // the input fingerprint from docRef.current, so a stale ref would fail the match and
        // silently drop every recovered output.
        docRef.current = runDocument;
        setDoc(runDocument);
      }
    }
    catch (error) { if (mounted.current) setHandoffNote(saasErrorMessage(error, locale)); return; }
    if (!mounted.current || readOnlyRef.current) return;
    if (refuseUnsupportedGraph(runDocument)) return;
    const runNodes = runDocument.nodes;
    const runEdges = reconcileEdges(runNodes, runDocument.edges);
    const reviewPolicy = !manualMessage && !collaboration ? runDocument.execution : undefined;
    const problem = collaboration ? '' : preflightIssueMessage(t, reviewPolicy
      ? preflightReviewGraphIssue(runNodes, runEdges, reviewPolicy, scope)
      : preflightGraphIssue(runNodes, runEdges.filter(edge => edge.kind !== 'feedback'), scope, { conversation: Boolean(currentSaaSCanvas() && manualMessage) }), locale);
    if (problem) { refusedRevision.current = canvasPlanRevision(runDocument); setHandoffNote(problem); return; }
    setHandoffNote('');
    const ac = new AbortController();
    // A failed or stopped retry must never leave its previous success available to downstream nodes.
    const executing = new Set(scope ?? runNodes.map(n => n.id));
    const pending: CanvasRunJournal = { version: 1, id: crypto.randomUUID(), startedAt: Date.now(), scope: [...executing], inputFingerprint: runInputFingerprint(runDocument, [...executing]), ...(manualMessage ? { manual: true, manualMessage } : {}), nodes: Object.fromEntries(runNodes.filter(n => executing.has(n.id)).map(n => [n.id, { nodeId: n.id, threadId: n.kind === 'session' ? activeThreadId(n) : 'form', operationId: n.kind === 'session' ? crypto.randomUUID() : null, companyId: n.kind === 'session' ? n.binding?.companyId ?? null : null, agentId: n.kind === 'session' ? n.binding?.agentId ?? null : null, issueId: n.kind === 'session' ? n.issueId ?? null : null, runId: null, state: 'waiting' as const }])) };
    if (reviewPolicy) pending.review = { round: 0, maxRounds: reviewPolicy.maxRounds, outcome: 'running', turns: [] };
    if (collaboration) pending.collaboration = { ...collaboration, maxModelCalls: 2 * executing.size * collaboration.rounds + 1, phase: 'proposal', round: 0, turns: [] };
    const cloud = currentSaaSCanvas();
    if (cloud && !manualMessage) pending.serverGraph = { tenantId: cloud.tenant.id, canvasId: cloud.canvasId };
    // Collaboration admission needs the exact saved upstream candidates, including selected peers.
    // The shared execution lock prevents consuming them while the server is accepting the run.
    const prepared = collaboration ? runDocument : prepareRunDocument(runDocument, [...executing], Boolean(manualMessage));
    const acceptedManualNode = manualMessage ? runNodes.find(node => executing.has(node.id)) : undefined;
    if (!saveLocalDocument(prepared)) { setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return; }
    if (!saveRunJournal(pending)) {
      // No dispatch happened: preserve the previous published results on a quota failure.
      saveLocalDocument(docRef.current);
      setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return;
    }
    // Draft consumption is part of durable acceptance, not a generic composer edit (which
    // is correctly blocked once running). Save only after the journal succeeds, so neither
    // storage failure can discard a request that has not been accepted or dispatched.
    const acceptedThreadId = acceptedManualNode?.kind === 'session' ? activeThreadId(acceptedManualNode) : undefined;
    const consumeDraft = acceptedManualNode?.kind === 'session' && submittedThread
      && getNodeThreads(acceptedManualNode).find(thread => thread.id === acceptedThreadId)?.draft === submittedThread.draft;
    const acceptedDocument = consumeDraft ? { ...prepared, nodes: prepared.nodes.map(node =>
      node.id === acceptedManualNode.id && node.kind === 'session'
        ? updateNodeDraft(node, '', acceptedThreadId) : node) } : prepared;
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
    setTimelineOpen(!collaboration);
    if (pending.serverGraph) {
      const submissionStorage = canvasStorage();
      let admitted = false;
      try {
        const accepted = await submitCloudGraph(pending.id, pending.scope, collaboration);
        admitted = true;
        const stored = loadRunJournal(submissionStorage);
        const recovered = mergeGraphSnapshot(stored?.id === pending.id ? stored : pending, accepted);
        saveRunJournal(recovered, submissionStorage);
        if (currentSaaSCanvas() !== cloud) return;
        journal.current = recovered;
        setRuns(recovered.nodes);
        if (ac.signal.aborted) await cancelCloudGraph(journal.current);
      } catch (error) {
        if (!admitted && graphAdmissionRejected(error)) {
          // This request was rejected before admission; retain the user's inputs and
          // show the rejection. A lost response keeps its operation journal instead.
          clearRunJournal(submissionStorage, pending.id);
          if (currentSaaSCanvas() !== cloud) return;
          journal.current = null; setRunning(false);
          setHandoffNote(saasErrorMessage(error, locale)); runAbort.current = null; return;
        }
        if (currentSaaSCanvas() !== cloud) return;
        setHandoffNote(error instanceof Error ? error.message : surfaceNotice(t, 'run_identity_unconfirmed'));
      }
      runAbort.current = null; setRecovering(true);
      return;
    }
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
        outputContract: !(cloud && manualMessage) && node.contract ? { version: 1, inputs: [],
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
      const settled = cloud ? result : await settleExecutionResult(gatewayApiBase(), entry, result);
      const operationId = entry?.operationId;
      const outputState = settled.ok && !settled.unconfirmed ? 'final' : 'failed';
      if (operationId) {
        updateConversationPresentation(node, operationId, { issueId: entry?.issueId, runId: entry?.runId,
          outputText: settled.output, outputState }, storage);
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
      const node = runNodes.find(n => executing.has(n.id));
      if (!node || node.kind !== 'session') throw new Error('Conversation node is unavailable');
      onStatus(node.id, { state: 'running' });
      const result = await exec(node, manualMessage!);
      onStatus(node.id, { state: result.unconfirmed ? 'running' : result.ok ? 'done' : result.cancelled ? 'cancelled' : 'failed', output: result.output, detail: result.detail });
      return journalSummary(journal.current!);
    };
    const options = {
      nodes: runNodes,
      edges: reviewPolicy ? runEdges : runEdges.filter(edge => edge.kind !== 'feedback'),
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
  }, [patchDoc, saveLocalDocument, updateJournal, prepareNodes, locale, t, runUnavailableReason]);

  const stopRun = useCallback(() => {
    if (readOnlyRef.current || outdatedObserver.current) return;
    if (journal.current?.serverGraph) {
      journal.current = { ...journal.current, serverGraph: { ...journal.current.serverGraph, cancelRequested: true } };
      if (!saveRunJournal(journal.current)) setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
      if (runAbort.current) runAbort.current.abort();
      void cancelCloudGraph(journal.current).catch(error => setHandoffNote(stopUnconfirmedMessage(t, error instanceof Error ? error.message : '')));
      return;
    }
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
    if (readOnlyRef.current || runAbort.current || inspectorCloseLocked.current) return;
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
    requestAnimationFrame(() => focusNodeRef.current(nodeId));
  }, [canEditStructure, patchDoc]);

  const addNode = useCallback(
    (kind: AddNodeKind, world: { x: number; y: number }) => {
      if (!canEditStructure()) return;
      const media = canInitialize ? mediaKindOf(kind) : null;
      // A cloud image or video node is a plain generator: no role template, delivery format or
      // team. The first catalog model is shown, and runs only once the operator saves it.
      const node = kind === 'form' ? createFormNode(world)
        : media ? { ...createSessionNode(media, world), title: t(media === 'video' ? 'node.video' : 'node.image'),
          model: mediaModelsOf(mediaCatalogueOf(mediaState), media)[0]?.id ?? '' }
        : kind === 'llm' || kind === 'coding' || kind === 'image' || kind === 'video'
          ? { ...createAgentTemplate('general', world, locale), agentKind: kind }
          : createAgentTemplate(kind, world, locale);
      patchDoc((prev) => ({ ...prev, nodes: [...prev.nodes, node] }), { label: `add:${node.id}` });
      setSelection([node.id]);
      focusNode(node.id, { configure: true });
      setInspectorId(node.id);
      return node;
    },
    [patchDoc, focusNode, locale, canEditStructure, canInitialize, mediaState, t],
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
      if (focusedRef.current && kill.has(focusedRef.current)) restoreFocusCamera();
      setFocusedId((prev) => (prev && kill.has(prev) ? null : prev));
      setInspectorId((prev) => (prev && kill.has(prev) ? null : prev));
    },
    [canEditStructure, patchDoc, restoreFocusCamera],
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
      if (current?.kind === 'session' && next.kind === 'session' && (JSON.stringify(current.team) !== JSON.stringify(next.team)
        || JSON.stringify(current.taskFrame) !== JSON.stringify(next.taskFrame))) {
        const affected = new Set(downstreamClosure([next.id]));
        setRuns(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !affected.has(id))));
        setRunSummary(null);
      }
      setHandoffNote('');
    },
    [canEditStructure, patchDoc, downstreamClosure],
  );

  // The inspector owns configuration, while cards own contracts and the transport owns thread IDs.
  const saveInspector = useCallback((draft: CanvasNode) => {
    if (readOnlyRef.current) return;
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
        : configChanged ? rebindNodeThread(live, null) : { ...live, threads: getNodeThreads(live) };
      saveNode({ ...rebound, title: draft.title, agentKind: draft.agentKind, runtime: draft.runtime,
        model: draft.model, effort: draft.effort, persona: draft.persona, team: draft.team, agentRef: draft.agentRef,
        ...(Object.hasOwn(draft, 'taskFrame') ? { taskFrame: draft.taskFrame } : {}),
        binding: configChanged ? null : draft.binding, bindAttempt: configChanged ? null : draft.bindAttempt,
        issueId: bindingChanged || configChanged ? null : live.issueId }, true);
      if (configChanged) setHandoffNote(surfaceNotice(t, 'config_forked'));
    } else if (live.kind === 'form' && draft.kind === 'form') {
      saveNode({ ...live, title: draft.title, fields: draft.fields });
    }
  }, [canEditStructure, saveNode]);
  const initializeInspector = useCallback(async (draft: SessionNode) => {
    let completed = false;
    await withCanvasRunOwnership(async () => {
      if (readOnlyRef.current || setupRequest.current || runAbort.current || journal.current || loadRunJournal()) throw new Error(locale === 'zh' ? '请等待当前任务结束后再保存配置。' : 'Wait for the current task before saving configuration.');
      saveInspector(draft);
      await prepareNodes([draft.id]);
      completed = true;
    }, () => { throw new Error(surfaceNotice(t, 'execution_owned_elsewhere')); });
    if (!completed) throw new Error(locale === 'zh' ? '配置尚未保存，请重试。' : 'Configuration was not saved. Please try again.');
  }, [saveInspector, prepareNodes, locale, t]);

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
  // Live, for a focus that re-fits a node while it is being configured (focusNode reads it).
  const inspectorRef = useRef<string | null>(null);
  inspectorRef.current = inspectorId;
  // A node can leave the document without being closed: undoing its addition, a redo, an edit in
  // another tab. It closes then as deleting it would (back to the operator's camera), and an
  // inspector left on a missing node closes too.
  useEffect(() => {
    if (focusedId && !nodes.some(node => node.id === focusedId)) { restoreFocusCamera(); setFocusedId(null); }
    if (inspectorId && !nodes.some(node => node.id === inspectorId) && !inspectorCloseLocked.current) setInspectorId(null);
  }, [nodes, focusedId, inspectorId, restoreFocusCamera]);
  const inspectorNode = inspectorId ? nodes.find((n) => n.id === inspectorId) ?? null : null;
  // Viewport culling: tiles outside the visible world rect (plus margin) are not mounted.
  // SessionTile's header contract assumes this — a culled-and-remounted tile must not lose
  // state, and the sessions store exists exactly for that.
  const visibleIds = useMemo(() => {
    const ids = new Set(visibleBoxIds(renderNodes, view, size));
    // A focused or inspected node is always mounted, even if the operator has panned it off
    // screen — the inspector keeps describing a tile that is still "yours".
    if (focusedId) ids.add(focusedId);
    if (inspectorId) ids.add(inspectorId);
    return ids;
  }, [renderNodes, view, size, focusedId, inspectorId]);
  // Stable tile callbacks: SessionTile is memoised, and an inline arrow recreated on every
  // render would defeat it — every keystroke in one tile's composer would re-render the
  // rest of the canvas.
  const tileRenderTurnDetails = useCallback(
    (node: CanvasNode, turn: { runId?: string }, latest: boolean) => {
      // Graph retries have not yet appeared in transcript history. Do not combine a
      // historical message's run ID with the current graph's status or duplicate it.
      if (currentGraphRunEntry(node, journal.current)) return null;
      return turn.runId ? (
        <TeamRunDetails key={turn.runId} tenantId={cloudScope!.tenant.id} runId={turn.runId} defaultOpen={latest}
          runStatus={latest ? runs[node.id]?.state : undefined} />
      ) : null;
    },
    [cloudScope, runs],
  );
  const tileCurrentRunDetails = useCallback((node: CanvasNode) => {
    const active = journal.current;
    const entry = currentGraphRunEntry(node, active);
    if (!cloudScope || !entry) return undefined;
    const pendingText = entry.state === 'blocked' ? (locale === 'zh' ? '本次任务未执行此节点。' : 'This node was not executed in the current task.')
      : entry.state === 'cancelled' ? (locale === 'zh' ? '节点任务已停止，未开始执行。' : 'The node task was stopped before execution.')
        : entry.state === 'failed' ? (locale === 'zh' ? '节点任务未能开始。' : 'The node task could not start.')
          : !active?.serverGraph?.id ? (locale === 'zh' ? '正在提交节点任务…' : 'Submitting the node task…')
            : (locale === 'zh' ? '等待节点执行…' : 'Waiting for node execution…');
    return <section aria-label={locale === 'zh' ? '本次节点任务' : 'Current node task'}>
      {entry.runId ? <TeamRunDetails key={entry.runId} tenantId={cloudScope.tenant.id} runId={entry.runId} runStatus={entry.state} defaultOpen />
        : <p role="status">{pendingText}</p>}
    </section>;
  }, [cloudScope, runs, running, locale]);
  const tileOnSend = useCallback(
    (node: CanvasNode, message: string, onAccepted?: () => void, displayText?: string) => { void startRun([node.id], message, onAccepted, displayText); },
    [startRun],
  );
  const tileOnIssueId = useCallback(
    (nodeId: string, issueId: string, threadId: string | undefined) =>
      // Server-minted, not a user edit — never an undo step.
      patchDoc(
        (prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => (n.id === nodeId && n.kind === 'session'
            ? updateThreadIssueId(n, threadId ?? activeThreadId(n), issueId) : n)),
        }),
        { silent: true },
      ),
    [patchDoc],
  );
  const tileOnConfigure = useCallback(
    (id: string) => { if (!inspectorCloseLocked.current) { setInspectorId(id); focusNode(id, { configure: true }); } },
    [focusNode],
  );
  const tileDelete = useCallback(
    (id: string) => deleteNodes([id]),
    [deleteNodes],
  );
  const [addMenu, setAddMenu] = useState<{ at: { x: number; y: number }; world: { x: number; y: number } } | null>(null);
  const [barMode, setBarMode] = useState<CommandBarMode | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [selectionTool, setSelectionTool] = useState(false);

  const { companies, refresh: refreshCompanies } = useLiveCompanies(paperclipApiBase());

  // Wiring is a STRUCTURAL edit and locks with the rest of them during a run. A run executes a
  // SNAPSHOT of the graph, so a wire cut mid-run would not change what is executing — the user
  // would be shown a graph that no longer matches the timeline describing the run. Omitting
  // onConnect leaves the ports visible but inert (they are the graph's structure, not a control).
  const wiring = useWiring({ nodes: renderNodes, edges, onConnect: readOnly || running || initializing ? undefined : onConnect, rootRef, view });
  const marquee = useMarquee({
    enabled: selectionTool,
    nodes: renderNodes,
    rootRef,
    view,
    onSelect: (ids, additive) =>
      setSelection((prev) => (additive ? Array.from(new Set([...prev, ...ids])) : ids)),
  });

  // The board's shortcuts (delete, undo, run, …) pause while the 成果 view covers it.
  const keyBindings = useCanvasKeys({
    onFocusToggle: () => toggleFocus(),
    onCycle: cycle,
    onPalette: () => setBarMode('commands'),
    onSearch: () => setBarMode('search'),
    onFitAll: fitAll,
    onDeleteSelection: readOnly || running || initializing ? undefined : () => deleteNodes(selection),
    // Undo/redo are locked during a run for the same reason every other structural edit is: the
    // run executes a SNAPSHOT, so rewinding the graph under it would show the operator a document
    // that does not match the timeline describing what is executing.
    onUndo: readOnly || running || initializing || !history.undo ? undefined : undo,
    onRedo: readOnly || running || initializing || !history.redo ? undefined : redo,
    onSaveWaypoint: readOnly ? undefined : saveWaypoint,
    onRecallWaypoint: recallWaypoint,
    onEscape: () => {
      // Unwind outermost-first so one Escape never closes two things at once.
      if (addMenu) setAddMenu(null);
      else if (barMode) setBarMode(null);
      else if (selectionTool) setSelectionTool(false);
      else if (inspectorId) { if (!inspectorCloseLocked.current) setInspectorId(null); }
      else if (focusedId) unfocus();
      else setSelection([]);
    },
  }, !showingResults);

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
    () => readOnly ? ({
      fitAll, toggleTimeline: focusedId ? undefined : () => setTimelineOpen(o => !o),
      toggleMinimap: focusedId ? undefined : () => setMinimapOpen(o => !o), recallWaypoint: () => recallWaypoint(1),
    }) : ({
      addSession: (kind) => addAtViewCenter(kind),
      canEdit,
      run: runUnavailableReason ? undefined : () => void startRun(),
      stop: stopRun,
      fitAll,
      // While a node is open the timeline and the minimap step aside, so they are not offered then (as in
      // the run controls and the toolbar).
      toggleTimeline: focusedId ? undefined : () => setTimelineOpen((o) => !o),
      toggleMinimap: focusedId ? undefined : () => setMinimapOpen((o) => !o),
      // Slot 1 is the palette's default drawer for waypoints; the keyboard covers 1-9.
      saveWaypoint: () => saveWaypoint(1),
      recallWaypoint: () => recallWaypoint(1),
      deleteSelection: () => deleteNodes(selection),
      runSelection: runUnavailableReason ? undefined : runFromSelection,
      rerunNode: runUnavailableReason ? undefined : () => {
        const only = selectionRef.current[0];
        if (only) rerunNode(only);
      },
      undo,
      redo,
      canUndo: canEdit && history.undo > 0,
      canRedo: canEdit && history.redo > 0,
    }),
    [readOnly, addAtViewCenter, canEdit, startRun, stopRun, fitAll, saveWaypoint, recallWaypoint, deleteNodes, selection, undo, redo, history.undo, history.redo, runUnavailableReason, focusedId],
  );

  const addAgent = useCallback((kind: AgentTemplateId) => addAtViewCenter(kind), [addAtViewCenter]);
  const addWorkspaceAgent = useCallback((agent: WorkspaceAgent) => {
    if (!canEditStructure()) return;
    const v = viewRef.current;
    const s = sizeRef.current;
    const node = createWorkspaceAgentNode(agent, { x: (-v.x + s.w / 2) / (v.scale || 1) - 170, y: (-v.y + s.h / 2) / (v.scale || 1) - 130 }, locale);
    patchDoc(previous => ({ ...previous, nodes: [...previous.nodes, node] }), { label: `add:${node.id}` });
    // The node opens focused, not configured: the inspector stays reachable from the tile menu.
    setSelection([node.id]); focusNode(node.id);
  }, [canEditStructure, patchDoc, focusNode, locale]);
  const addMarketAgent = useCallback((agent: TeamMarketAgent) => {
    if (!canEditStructure()) return;
    const v = viewRef.current;
    const s = sizeRef.current;
    const node = createMarketplaceRoleNode(agent, { x: (-v.x + s.w / 2) / (v.scale || 1) - 170, y: (-v.y + s.h / 2) / (v.scale || 1) - 130 }, locale);
    patchDoc(previous => ({ ...previous, nodes: [...previous.nodes, node] }), { label: `add:${node.id}` });
    setSelection([node.id]); focusNode(node.id);
  }, [canEditStructure, patchDoc, focusNode, locale]);
  const createTemplate = useCallback(() => {
    if (!canEditStructure()) return;
    const currentNodes = docRef.current.nodes;
    const world = currentNodes.length ? { x: boundsOfNodes(presentationNodes(currentNodes, null)).maxX + 160, y: 60 } : { x: 0, y: 0 };
    const template = createDevelopmentTemplate(world, locale);
    patchDoc(prev => ({ ...prev, nodes: [...prev.nodes, ...template.nodes], edges: [...prev.edges, ...template.edges] }), { label: 'template:development' });
    setSelection([template.nodes[0].id]);
    setFocusedId(null);
    focusReturn.current = null;
    fitted.current = true;
    const box = viewportSize();
    if (box) autoFit([...currentNodes, ...template.nodes], box);
  }, [canEditStructure, patchDoc, viewportSize, locale, autoFit]);

  const zoomBy = (factor: number) => {
    const box = viewportSize();
    if (!box) return;
    moveCamera(prev => {
      const scale = Math.max(.1, Math.min(2.5, prev.scale * factor));
      const ratio = scale / prev.scale;
      return { scale, x: box.w / 2 - (box.w / 2 - prev.x) * ratio, y: box.h / 2 - (box.h / 2 - prev.y) * ratio };
    });
  };

  // Persist the viewport so the canvas reopens where it was left (debounced by the doc save).
  useEffect(() => () => { if (pendingCameraSave.current) clearTimeout(pendingCameraSave.current.timer); }, []);
  useEffect(() => {
    if (readOnly) return;
    // The viewport is not an edit: panning is navigation, and letting it clear the redo stack
    // would silently destroy a redo the user was about to reach for.
    // While a node is open the camera is the node's; save the operator's, so leaving the canvas from an
    // open node reopens where they were.
    const kept = focusedRef.current && focusReturn.current ? focusReturn.current : view;
    // A newer camera replaces one still waiting, so a glide or a gesture never saves an in-between frame.
    if (pendingCameraSave.current) { clearTimeout(pendingCameraSave.current.timer); pendingCameraSave.current = null; }
    // Still the app's own camera, a click's wobble included: nothing of the operator's to save (see unsavedCamera).
    if (isFittedCamera(kept, unsavedCamera.current)) return;
    const save = () => patchDoc((prev) => (prev.view === kept || (prev.view?.x === kept.x && prev.view?.y === kept.y && prev.view?.scale === kept.scale)
      ? prev : { ...prev, view: kept }), { silent: true });
    const timer = setTimeout(() => { pendingCameraSave.current = null; save(); }, 400);
    pendingCameraSave.current = { timer, camera: kept, save };
  }, [view, patchDoc, readOnly]);

  // The planning conversation is local UI history, separate from node execution Sessions.
  const [planning, setPlanning] = useState(() => readOnly ? { draft: '', messages: [] } as ReturnType<typeof loadPlanningConversation> : loadPlanningConversation());
  // A message being handled before it joins the conversation (assistantRouting.ts): the server is routing it, it is
  // becoming a task, or the task it replaces is stopping. The ref answers a second click in the same tick.
  const [assistantPending, setAssistantPending] = useState<AssistantPending | null>(null);
  const pendingRef = useRef<{ pending: AssistantPending; controller?: AbortController } | null>(null);
  const setPending = (pending: AssistantPending | null, controller?: AbortController) => {
    pendingRef.current = pending ? { pending, ...(controller ? { controller } : {}) } : null;
    setAssistantPending(pending);
  };
  // Read through a call: a check earlier in the same handler would otherwise narrow it for good.
  const pendingId = () => pendingRef.current?.pending.id;
  const appliedTaskDraft = useRef('');
  useEffect(() => {
    // A task draft waits for a message being handled: joined to it in the box, it would be sent with it again.
    if (!taskDraft || readOnly || appliedTaskDraft.current === taskDraft.id || assistantPending) return;
    appliedTaskDraft.current = taskDraft.id;
    setPlanning(previous => ({ ...previous, draft: [previous.draft.trim(), taskDraft.prompt].filter(Boolean).join('\n\n') }));
    setAssistantOpen(true);
  }, [taskDraft, readOnly, assistantPending]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [planningBusy, setPlanningBusy] = useState(false);
  const [planningError, setPlanningError] = useState('');
  const [planningRecovery, setPlanningRecovery] = useState<Awaited<ReturnType<typeof readCanvasPlanRecovery>> | null>(null);
  const [recoveryLoaded, setRecoveryLoaded] = useState(!canInitialize);
  const [recoveryChecking, setRecoveryChecking] = useState(false);
  const [recoveryStopping, setRecoveryStopping] = useState(false);
  const recoveryCheckSequence = useRef(0);
  const recoveryReadError = useRef('');
  const recoveryStopInFlight = useRef(false);
  // Progress observed for the in-flight plan only; cleared with every new request so a finished
  // run never leaves stale counts next to the next one.
  const [planningProgress, setPlanningProgress] = useState<PlanProgress | undefined>(undefined);
  // How long the last successful plan took here: a measurement shown as the next one's expectation.
  const [lastPlanSeconds, setLastPlanSeconds] = useState<number | undefined>(() => readOnly ? undefined : loadLastPlanDuration());
  const [plannerStatus, setPlannerStatus] = useState<{ available: boolean; provider: string; error?: string } | null>(null);
  const [jevStatus, setJevStatus] = useState<Awaited<ReturnType<typeof readJevPlannerStatus>> | null>(null);
  const [plannerProvider, setPlannerProvider] = useState<'pi' | 'jev'>(() => {
    try { return canInitialize && canvasStorage().getItem('awwo.canvas.planner-provider.v1') === 'jev' ? 'jev' : 'pi'; }
    catch { return 'pi'; }
  });
  const [lastPlanRevision, setLastPlanRevision] = useState<string | null>(null);
  const [planningFitId, setPlanningFitId] = useState('');
  const [modelFocusId, setModelFocusId] = useState<string | null>(null);
  const planningRequest = useRef<{ id: string; controller: AbortController; prompt: string } | null>(null);
  const planningSequence = useRef(0);
  const planRevision = canvasPlanRevision(doc);
  const refreshPlanningRecovery = useCallback(async (signal?: AbortSignal) => {
    if (!canInitialize || !mounted.current || readOnlyRef.current || currentSaaSCanvas() !== cloudScope) return;
    const sequence = ++recoveryCheckSequence.current;
    const stillCurrent = () => mounted.current && !signal?.aborted && !readOnlyRef.current
      && currentSaaSCanvas() === cloudScope && sequence === recoveryCheckSequence.current;
    setRecoveryChecking(true);
    try {
      const recovery = await readCanvasPlanRecovery(docRef.current, signal);
      if (!stillCurrent()) return;
      setPlanningRecovery(recovery);
      setRecoveryLoaded(true);
      if (recoveryReadError.current) {
        const recoveredError = recoveryReadError.current;
        setPlanningError(previous => previous === recoveredError ? '' : previous);
        recoveryReadError.current = '';
      }
      if (recovery.pending) setAssistantOpen(true);
    } catch (error) {
      if (!stillCurrent()) return;
      setRecoveryLoaded(false);
      recoveryReadError.current = planFailureMessage(t, error);
      setPlanningError(recoveryReadError.current);
    } finally { if (stillCurrent()) setRecoveryChecking(false); }
  }, [canInitialize, cloudScope, t]);
  useEffect(() => {
    if (!canInitialize || readOnly || planningBusy) return;
    const controller = new AbortController();
    const refresh = () => { void refreshPlanningRecovery(controller.signal); };
    const unsubscribe = subscribeCanvasKnowledge(refresh);
    refresh();
    return () => { controller.abort(); unsubscribe(); };
  }, [canInitialize, readOnly, planningBusy, planRevision, refreshPlanningRecovery]);
  // Measure after the welcome screen becomes a canvas with an assistant sidebar.
  // The previous ResizeObserver size still describes the full-width welcome at this point.
  useLayoutEffect(() => {
    if (!planningFitId) return;
    const box = viewportSize();
    if (box) autoFit(docRef.current.nodes, box);
  }, [planningFitId, viewportSize, autoFit]);
  useLayoutEffect(() => {
    if (!modelFocusId) return;
    // Focus against the committed layout after the welcome/assistant panels change.
    focusNode(modelFocusId);
    setModelFocusId(null);
  }, [modelFocusId, focusNode]);
  // While a message becomes a task the store holds it as an unconfirmed request, not in the box: leaving the page
  // before the outcome is known can then neither lose it nor leave it to be sent a second time.
  useEffect(() => {
    if (readOnly) return;
    const starting = assistantPending?.phase === 'starting' ? assistantPending : null;
    savePlanningConversation(starting ? {
      draft: planning.draft.trim() === starting.prompt ? '' : planning.draft,
      messages: [...planning.messages, { id: `${starting.id}-user`, role: 'user' as const, content: starting.prompt, route: 'execute' as const },
        { id: `${starting.id}-task`, role: 'assistant' as const, content: t('assistant.startUnconfirmed'), status: 'unconfirmed' as const,
          route: 'execute' as const, ...(starting.operationId ? { operationId: starting.operationId } : {}) }].slice(-60),
    } : planning);
  }, [planning, readOnly, assistantPending, t]);
  useEffect(() => {
    const controller = new AbortController();
    if (readOnly) return;
    void readPlannerStatus(controller.signal, locale).then(status => { if (!controller.signal.aborted) setPlannerStatus(status); });
    return () => controller.abort();
  }, [locale, readOnly]);
  useEffect(() => {
    if (!canInitialize || readOnly) return;
    const controller = new AbortController();
    setJevStatus(null);
    void readJevPlannerStatus(controller.signal, locale).then(value => {
      if (!controller.signal.aborted) setJevStatus(value);
    });
    return () => controller.abort();
  }, [canInitialize, cloudScope, locale, readOnly, paletteRefresh]);
  useEffect(() => () => { planningRequest.current?.controller.abort(); planningRequest.current = null; }, []);
  const appendPlanningMessage = (id: string, content: string, status?: 'applied' | 'error' | 'stale', route?: AssistantRoute, nodes?: string[]) => {
    setPlanning(previous => ({ ...previous, messages: [...previous.messages,
      { id, role: 'assistant' as const, content, ...(status ? { status } : {}), ...(route ? { route } : {}), ...(nodes?.length ? { nodes } : {}) }].slice(-60) }));
  };
  // The planner is a model call too. In a hosted personal account it needs the same ready
  // execution engine as graph runs; an explicit unavailable planner status also blocks Pi.
  // A pending status check is not a permanent lock: the host's runtime readiness gate still
  // applies while its credential check is in flight.
  const planningUnavailableReason = runUnavailableReason || (plannerProvider === 'jev' && !jevStatus?.available
    ? jevStatus?.error || (locale === 'zh' ? '编排模型暂不可用，请重试。' : 'The orchestration model is unavailable. Please retry.')
    : canInitialize && plannerProvider === 'pi' && plannerStatus?.available === false
      ? plannerStatus.error || (locale === 'zh' ? '画布助手暂不可用，请重试。' : 'The canvas assistant is unavailable. Please retry.')
      : '');
  // Why a plan cannot start now: null when it can, '' where the composer already shows why (a check or a stop in
  // flight, an earlier plan to resume, one under way), else the reason to show.
  const planBlocker = (resume = false): string | null => {
    // A message being handled (routed, becoming a task) is the one request in flight; nothing else plans meanwhile.
    if (readOnlyRef.current || pendingRef.current) return '';
    if (!resume && planningUnavailableReason) return planningUnavailableReason;
    if (recoveryStopInFlight.current || (canInitialize && (!recoveryLoaded || recoveryChecking))) return '';
    if (resume && !planningRecovery?.operationId) return '';
    if (planningRecovery?.pending && (!resume || !planningRecovery.matches)) return '';
    if (planningRequest.current) return '';
    if (journal.current || runAbort.current || inspectorCloseLocked.current || hasStreamingConversation(docRef.current.nodes)) {
      return surfaceNotice(t, 'planning_busy');
    }
    return null;
  };
  // `request` plans a prompt handed over (a carried-over request, a routed message) rather than the box's draft;
  // the box is emptied only where it holds that prompt.
  const sendPlanningMessage = async (request?: string, resume = false) => {
    // Keep the draft untouched and refuse before allocating a request or calling either planner.
    const blocked = planBlocker(resume);
    if (blocked !== null) { if (blocked) setPlanningError(blocked); return; }
    const prompt = (request ?? planning.draft).trim();
    if (!prompt) return;
    const snapshot = docRef.current;
    const revision = canvasPlanRevision(snapshot);
    const id = `plan-${Date.now()}-${++planningSequence.current}`;
    const startedAt = Date.now();
    const controller = new AbortController();
    planningRequest.current = { id, controller, prompt };
    setPlanningBusy(true);
    setPlanningError('');
    setPlanningProgress(undefined);
    // Where the host also does tasks, every turn says how it was handled.
    const route = assistantExecution ? 'plan' as const : undefined;
    setPlanning(previous => resume
      ? { ...previous, draft: previous.draft.trim() === prompt ? '' : previous.draft }
      : { draft: request === undefined || previous.draft.trim() === prompt ? '' : previous.draft,
        messages: [...previous.messages, { id: `${id}-user`, role: 'user' as const, content: prompt, ...(route ? { route } : {}) }].slice(-60) });
    try {
      const reportProgress = (progress: PlanProgress) => {
        // A superseded or cancelled request must not repaint the current one's progress.
        if (readOnlyRef.current || controller.signal.aborted || planningRequest.current?.id !== id) return;
        setPlanningProgress(progress);
      };
      const jev = !resume && plannerProvider === 'jev'
        ? await requestJevPlan(prompt, snapshot, planningTurns(planning.messages), controller.signal, locale, reportProgress) : null;
      const plan = jev?.plan ?? await planRequest(prompt, snapshot, planningTurns(planning.messages), controller.signal, locale, reportProgress,
        resume ? { recoveryOperationId: planningRecovery!.operationId } : undefined);
      if (readOnlyRef.current || controller.signal.aborted || planningRequest.current?.id !== id) return;
      if (canvasPlanRevision(docRef.current) !== revision || journal.current || runAbort.current || inspectorCloseLocked.current || hasStreamingConversation(docRef.current.nodes)) {
        appendPlanningMessage(`${id}-assistant`, surfaceNotice(t, 'plan_stale'), 'stale', route);
        setPlanning(previous => ({ ...previous, draft: previous.draft || prompt }));
        return;
      }
      const before = docRef.current;
      const applied = jev ? applyJevPlan(before, jev, locale, prompt) : applyCanvasPlan(before, plan, locale, prompt);
      if (plan.operations.length) {
        fitted.current = true;
        patchDoc(() => applied.doc, { label: `ai:${id}` });
        planUndoEntry.current = undoStack.current.at(-1) ?? null;
        setLastPlanRevision(canvasPlanRevision(docRef.current));
        setFocusedId(null);
        focusReturn.current = null;
        setInspectorId(null);
        setSelection(applied.addedNodeIds);
        setAssistantOpen(true);
        setPlanningFitId(id);
      }
      // A plan that changed nothing else keeps the nodes it added, which tell whether it is still on the canvas.
      appendPlanningMessage(`${id}-assistant`, applied.summary, plan.operations.length ? 'applied' : undefined, route,
        plan.operations.length && applied.addedNodeIds.length <= 200 && onlyAddedNodes(before, applied.doc, applied.addedNodeIds)
          ? applied.addedNodeIds : undefined);
      if (!jev) setPlannerStatus(previous => ({ available: true, provider: previous?.provider || 'AI' }));
      // Only a plan that arrived and was accepted is a measurement worth setting expectations with,
      // and only for the same planner: Jev decides differently and takes a different time.
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (!jev && !resume && seconds > 0) { saveLastPlanDuration(seconds); setLastPlanSeconds(seconds); }
    } catch (error) {
      if (readOnlyRef.current || controller.signal.aborted || planningRequest.current?.id !== id) return;
      const message = planFailureMessage(t, error);
      setPlanningError(message);
      appendPlanningMessage(`${id}-assistant`, message, 'error', route);
      setPlanning(previous => ({ ...previous, draft: previous.draft || prompt }));
    } finally {
      if (planningRequest.current?.id === id) {
        planningRequest.current = null;
        if (canInitialize) { setRecoveryLoaded(false); void refreshPlanningRecovery(); }
        setPlanningBusy(false); setPlanningProgress(undefined);
      }
    }
  };
  const cancelPlanning = async () => {
    if (readOnlyRef.current || recoveryStopInFlight.current) return;
    const request = planningRequest.current;
    const prompt = request?.prompt ?? planningRecovery?.prompt;
    if (!request && !planningRecovery?.pending) return;
    planningRequest.current = null;
    request?.controller.abort();
    setPlanningBusy(false);
    setPlanningProgress(undefined);
    if (prompt) setPlanning(previous => ({ ...previous, draft: previous.draft || prompt }));
    recoveryStopInFlight.current = true;
    setRecoveryStopping(true);
    try {
      if (canInitialize) {
        if (request) {
          // The abort handler owns this request's captured entry. Never issue a second, generic
          // cancel that could target a different operation another page has since started.
          if (!await confirmSaaSPlanningCancellation(request.controller.signal)) {
            const recovery = await readCanvasPlanRecovery(docRef.current);
            if (recovery.pending) throw new Error(locale === 'zh'
              ? '停止尚未确认，请核对本次规划状态后再操作。'
              : 'Stopping is not confirmed. Check this planning run before continuing.');
          }
        } else await cancelCanvasPlanRecovery(planningRecovery?.operationId ?? '');
      }
      if (!mounted.current || readOnlyRef.current || currentSaaSCanvas() !== cloudScope) return;
      setPlanningError('');
      appendPlanningMessage(`${request?.id ?? `plan-${Date.now()}`}-cancelled`, surfaceNotice(t, 'plan_cancelled'));
    } catch (error) {
      if (mounted.current && !readOnlyRef.current && currentSaaSCanvas() === cloudScope) setPlanningError(planFailureMessage(t, error));
    } finally {
      recoveryStopInFlight.current = false;
      if (mounted.current && currentSaaSCanvas() === cloudScope) {
        setRecoveryStopping(false);
        await refreshPlanningRecovery();
      }
    }
  };
  // A request carried over from the workspace home. The canvas opens with it in the prompt box, so
  // the operator sees what is being planned, and plans it exactly once: only on an empty canvas,
  // only while the box still holds it unchanged, and only once the planner's status is known. It is
  // sent from a timer cleared on cleanup, so a remount (StrictMode's simulated one included) can
  // neither abort it nor send it twice; the host's claim is the durable guard against a reload.
  const initialPlanSettled = useRef(false);
  const initialPlanShown = useRef(false);
  const plannerStatusKnown = plannerProvider === 'jev' ? jevStatus !== null : plannerStatus !== null;
  useEffect(() => {
    const request = initialPlan;
    if (!request || readOnly || initialPlanSettled.current) return;
    if (canInitialize && (!recoveryLoaded || recoveryChecking)) return;
    const settle = () => { initialPlanSettled.current = true; request.done(); };
    if (planningRecovery?.pending) { settle(); return; }
    // Content already on the canvas came from an earlier plan or from the operator: never plan over it.
    if (docRef.current.nodes.length) { settle(); return; }
    if (planning.draft !== request.prompt) {
      // Once the prompt has been shown, any change is the operator's edit and theirs to send.
      if (initialPlanShown.current) { settle(); return; }
      // An unrelated draft already waiting in the box is kept rather than overwritten.
      if (planning.draft.trim()) { settle(); return; }
      setPlanning(previous => previous.draft.trim() ? previous : { ...previous, draft: request.prompt });
      return;
    }
    initialPlanShown.current = true;
    if (!request.start) {
      if (request.interrupted) appendPlanningMessage(`plan-interrupted-${Date.now()}`, surfaceNotice(t, 'plan_interrupted'));
      settle();
      return;
    }
    if (runUnavailableReason) { setPlanningError(runUnavailableReason); settle(); return; }
    if (!plannerStatusKnown) return;
    if (planningUnavailableReason) { setPlanningError(planningUnavailableReason); settle(); return; }
    const timer = setTimeout(() => {
      initialPlanSettled.current = true;
      if (!request.claim()) { request.done(); return; }
      // An unmount mid-plan leaves the claim in place, so the next page says the plan was interrupted.
      void sendPlanningMessage(request.prompt).finally(() => { if (mounted.current) request.done(); });
    }, 0);
    return () => clearTimeout(timer);
  }, [initialPlan, readOnly, planning.draft, plannerStatusKnown, planningUnavailableReason, runUnavailableReason,
    canInitialize, recoveryLoaded, recoveryChecking, planningRecovery?.pending]);
  // ---- one conversation, routed by the server (assistantRouting.ts) -----------------------------------
  // Where the host also does tasks, each message goes to the server first, which says whether it arranges the
  // canvas or becomes a task. A message the router cannot answer for is planned: a plan is undone in one step
  // and makes one call, where a task makes up to sixteen and acts in a workspace.
  // A message joins the conversation once it is handled. Until then the box keeps it and the conversation shows it
  // pending, so a stop, a refusal or leaving the page never strands it.
  const unifiedHost = assistantExecution && routeAssistant ? assistantExecution : undefined;
  const executionRef = useRef(assistantExecution);
  executionRef.current = assistantExecution;
  // Handlers resume after awaiting the server; what they read then is the latest render's (set below).
  const assistantLatest = useRef<{ planBlocker: typeof planBlocker; sendPlanningMessage: typeof sendPlanningMessage;
    canUndoPlan: boolean; undo: typeof undo } | null>(null);
  // Routing needs to know whether a task can start, so a canvas that routes has the service read once it opens.
  useEffect(() => { if (!readOnly && routeAssistant) executionRef.current?.activate(); }, [readOnly, routeAssistant]);
  // The unconfirmed turn a settled submission belongs to: the one carrying its identity. None may be here (another
  // tab's submission), and a turn without one (saved before identities were kept) has no submission waiting for it.
  const unconfirmedTurn = (messages: PlanningMessage[], operationId: string) =>
    messages.findIndex(message => message.status === 'unconfirmed' && message.operationId === operationId);
  // The request a reply answers.
  const requestBefore = (messages: PlanningMessage[], index: number) =>
    messages.slice(0, index).reverse().find(message => message.role === 'user')?.content ?? '';
  // A submission settled with no task (a reconcile refused in a way that proves the start never happened, or given up)
  // settles its request: it says why, and a refused one is offered again in the box (a given-up one is not: the task it
  // may have started is listed only once read). Settled once: the turn is no longer unconfirmed, and never while the
  // same submission waits again (another tab stored it back).
  const startRefusal = assistantExecution?.startRefusal;
  const waitingOperation = assistantExecution?.pendingOperation;
  const waitingAgain = startRefusal !== undefined && waitingOperation === startRefusal.operationId;
  useLayoutEffect(() => {
    if (!startRefusal || readOnly || waitingAgain) return;
    setPlanning(previous => {
      const index = unconfirmedTurn(previous.messages, startRefusal.operationId);
      if (index < 0) return previous;
      const messages = [...previous.messages];
      messages[index] = { ...messages[index], status: 'error', content: startRefusal.reason };
      return { draft: previous.draft || (startRefusal.givenUp ? '' : requestBefore(messages, index)), messages };
    });
  }, [startRefusal, readOnly, waitingAgain]);
  // A settled submission waiting again (the page that sent it stored it back: its send ended unconfirmed after it was
  // given up here) is unconfirmed again: its request is reconciled, never handed to the canvas or sent from the box.
  useLayoutEffect(() => {
    if (!waitingOperation || readOnly) return;
    setPlanning(previous => {
      const index = previous.messages.findIndex(message => message.status === 'error' && message.operationId === waitingOperation);
      if (index < 0) return previous;
      const messages = [...previous.messages];
      messages[index] = { ...messages[index], status: 'unconfirmed', content: t('assistant.startUnconfirmed') };
      const request = requestBefore(messages, index);
      return { draft: request && previous.draft.trim() === request ? '' : previous.draft, messages };
    });
  }, [waitingOperation, readOnly]);
  // A start confirmed by a reconcile here, or announced by another page of this canvas, names its task: the request
  // recorded for it, unconfirmed or settled with no task (given up), becomes that task's turn, and leaves the box.
  const confirmedTask = assistantExecution?.confirmedTask;
  useLayoutEffect(() => {
    if (!confirmedTask || readOnly) return;
    setPlanning(previous => {
      if (previous.messages.some(message => message.taskId === confirmedTask.taskId)) return previous;
      const index = previous.messages.findIndex(message => (message.status === 'unconfirmed' || message.status === 'error')
        && message.operationId === confirmedTask.operationId);
      if (index < 0) return previous;
      const { status, operationId: _operation, ...reply } = previous.messages[index];
      const messages = [...previous.messages];
      messages[index] = { ...reply, content: '', taskId: confirmedTask.taskId };
      const request = status === 'error' ? requestBefore(messages, index) : '';
      return { draft: request && previous.draft.trim() === request ? '' : previous.draft, messages };
    });
  }, [confirmedTask, readOnly]);
  useEffect(() => () => { pendingRef.current?.controller?.abort(); pendingRef.current = null; }, []);
  const planAvailable = !readOnly && !planningUnavailableReason;
  const assistantRoutes = (): AssistantRoute[] => {
    const routes: AssistantRoute[] = [];
    if (planAvailable) routes.push('plan');
    if (assistantExecution?.ready && !assistantExecution.readOnly) routes.push('execute');
    return routes;
  };
  const failureText = (error: unknown) => error instanceof Error && error.message ? error.message : t('assistant.unavailable');
  const userTurn = (id: string, prompt: string, route: AssistantRoute) => ({ id: `${id}-user`, role: 'user' as const, content: prompt, route });
  // The identity a task is sent under, chosen here so its turn can carry it.
  const submissionId = () => `execution-${crypto.randomUUID()}`;
  // A message routed to a task. Started, it joins the conversation with its task; refused, with the reason, and the
  // box keeps it; unconfirmed, the host offers to reconcile it and the box lets it go, so it is not sent twice.
  const startAssistantTask = async (prompt: string, id: string) => {
    const host = executionRef.current;
    if (!host) return;
    const operationId = submissionId();
    setPending({ id, prompt, phase: 'starting', operationId });
    try {
      const taskId = await host.start(prompt, operationId);
      if (!mounted.current) return;
      setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
        userTurn(id, prompt, 'execute'), { id: `${id}-task`, role: 'assistant' as const, content: '', route: 'execute' as const, taskId }].slice(-60) }));
      setAssistantOpen(true);
      refocus('.awwo-canvas-assistant--panel textarea');
    } catch (error) {
      if (!mounted.current) return;
      const unconfirmed = error instanceof TaskStartUnconfirmed;
      const reason = unconfirmed ? t('assistant.startUnconfirmed') : failureText(error);
      if (!unconfirmed) setPlanningError(reason);
      setPlanning(previous => ({ draft: unconfirmed && previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
        userTurn(id, prompt, 'execute'), { id: `${id}-task`, role: 'assistant' as const, content: reason,
          status: unconfirmed ? 'unconfirmed' as const : 'error' as const, route: 'execute' as const, ...(unconfirmed ? { operationId } : {}) }].slice(-60) }));
    } finally { if (pendingId() === id) setPending(null); }
  };
  // A message routed to the canvas: refused with the reason (the box keeps it), or planned.
  const planRouted = (prompt: string, id: string) => {
    // The planner takes at most 8000 bytes. A longer message is not turned into a task for its length: the
    // reply says so, the box keeps it, and 「换一种方式」 offers the task.
    if (new TextEncoder().encode(prompt).length > 8000) {
      setPlanning(previous => ({ ...previous, messages: [...previous.messages, userTurn(id, prompt, 'plan'),
        { id: `${id}-assistant`, role: 'assistant' as const, content: t('assistant.tooLongToPlan'), status: 'error' as const, route: 'plan' as const }].slice(-60) }));
      return;
    }
    const blocked = assistantLatest.current!.planBlocker();
    if (blocked !== null) { setPlanningError(blocked || t('assistant.notNow')); return; }
    void assistantLatest.current!.sendPlanningMessage(prompt);
  };
  const sendAssistantMessage = async () => {
    if (!unifiedHost || !routeAssistant) { void sendPlanningMessage(); return; }
    if (readOnlyRef.current || pendingRef.current || planningRequest.current) return;
    const prompt = planning.draft.trim();
    if (!prompt) return;
    const routes = assistantRoutes();
    if (!routes.length) { setPlanningError(planningUnavailableReason || t('assistant.unavailable')); return; }
    const id = `turn-${Date.now()}-${++planningSequence.current}`;
    setPlanningError('');
    let route: AssistantRoute = routes.includes('plan') ? 'plan' : routes[0];
    if (routes.length > 1) {
      const controller = new AbortController();
      const request = assistantRouteRequest(prompt, routes, docRef.current, planning.messages);
      setPending({ id, prompt, phase: 'routing' }, controller);
      try { route = await routeAssistant(request, controller.signal); }
      catch { /* The router did not answer: the message is handled the default way rather than lost. */ }
      // Stopped while it was routed (the box still holds it), or the page has gone.
      if (pendingId() !== id || controller.signal.aborted || !mounted.current) return;
      setPending(null);
    }
    if (route === 'execute') await startAssistantTask(prompt, id);
    else planRouted(prompt, id);
  };
  /** Stops a message being routed; the box still holds it. False when none is. */
  const cancelRouting = () => {
    const current = pendingRef.current;
    if (current?.pending.phase !== 'routing') return false;
    current.controller?.abort();
    setPending(null);
    return true;
  };

  const canUndoPlan = !readOnly && !planningBusy && !running && !bindingLocked && history.undo > 0
    && lastPlanRevision !== null && canvasPlanRevision(doc) === lastPlanRevision
    && Boolean(lastCommit.current?.label.startsWith('ai:')) && canEditStructure();
  assistantLatest.current = { planBlocker, sendPlanningMessage, canUndoPlan, undo };
  // The plan reply whose change was undone in this page (its stored reply still says applied). It stays undone
  // through later edits; only a redo of the plan's own document (kept on the redo stack) has the change again.
  const [undonePlan, setUndonePlan] = useState<{ reply: string; planDoc: CanvasDocument } | null>(null);
  const undonePlanRef = useRef(undonePlan);
  undonePlanRef.current = undonePlan;
  // A plan that only added nodes is undone exactly while none of them is on the canvas, by whatever path (an undo, a
  // deletion, another tab's document, after a reload). One that changed existing nodes keeps the mark above.
  const undoneHere = (reply: PlanningMessage) => reply.nodes?.length
    ? !nodes.some(node => reply.nodes!.includes(node.id)) : undonePlan?.reply === reply.id;
  const latestAppliedReply = () => {
    for (let index = planning.messages.length - 1; index >= 0; index--) {
      const message = planning.messages[index];
      if (message.role === 'assistant' && message.status === 'applied') return message.id;
    }
    return null;
  };
  planStep.current = {
    // The next undo steps back over the plan when the entry on top of the undo stack is the one its commit pushed.
    isPlan: () => planUndoEntry.current !== null && undoStack.current.at(-1) === planUndoEntry.current,
    undone: planDoc => {
      setLastPlanRevision(null);
      const reply = latestAppliedReply();
      if (reply) setUndonePlan({ reply, planDoc });
    },
    // Redoing the plan's own document has it back, and its step is undoable again under the entry the redo pushed.
    redone: doc => {
      if (undonePlanRef.current?.planDoc !== doc) return;
      setUndonePlan(null);
      planUndoEntry.current = undoStack.current.at(-1) ?? null;
    },
    reset: () => { setUndonePlan(null); planUndoEntry.current = null; },
  };
  // Only the latest unconfirmed request can still be reconciled, and only while the host keeps its submission (it
  // survives a reload); any other says where to look instead of pointing at a button that is not there.
  const reconcilable = waitingOperation ? unconfirmedTurn(planning.messages, waitingOperation) : -1;
  const shownMessages = assistantExecution ? planning.messages.map((message, index) => message.status === 'unconfirmed' && index !== reconcilable
    ? { ...message, content: t('assistant.startUnconfirmedLost') } : message) : planning.messages;
  const assistantProps = {
    // A message being handled shows pending in the conversation; the box keeps it, out of sight, until it is.
    messages: shownMessages, draft: assistantPending && planning.draft.trim() === assistantPending.prompt ? '' : planning.draft,
    busy: planningBusy, error: planningError,
    ...(plannerProvider === 'jev' && !unifiedHost ? { submitLabel: locale === 'zh' ? '新增工作流' : 'Add workflow' } : {}),
    // Where messages are routed, a closed planner still leaves tasks: the composer waits only when neither is open.
    submitDisabled: (unifiedHost ? !assistantRoutes().length : Boolean(planningUnavailableReason))
      || (canInitialize && (!recoveryLoaded || recoveryChecking)) || recoveryStopping,
    ...(planningRecovery?.pending && !planningBusy ? { recovery: {
      prompt: planningRecovery.prompt || '', canResume: planningRecovery.matches === true && Boolean(planningRecovery.operationId),
      busy: !recoveryLoaded || recoveryChecking || recoveryStopping,
      onResume: () => { void sendPlanningMessage(planningRecovery.prompt, true); },
      onStop: () => { void cancelPlanning(); },
    } } : {}),
    progress: planningProgress, expectedSeconds: plannerProvider === 'jev' ? undefined : lastPlanSeconds,
    onDraftChange: (draft: string) => { if (!readOnlyRef.current) setPlanning(previous => ({ ...previous, draft })); },
    onSend: () => { void sendAssistantMessage(); }, onCancel: () => { if (!cancelRouting()) void cancelPlanning(); },
    onUndo: () => {
      // undo() can still decline (a node began talking since this render); only an undo that happened is said.
      if (!canUndoPlan || !undo()) return;
      appendPlanningMessage(`undo-${Date.now()}`, surfaceNotice(t, 'plan_undone'));
    }, canUndo: canUndoPlan,
    runtimeControls: <div className="awwo-planner-connection"><span className={(plannerProvider === 'jev' ? jevStatus?.available : plannerStatus?.available) ? 'is-ready' : ''} />
      {plannerProvider === 'jev' ? jevStatus?.error || (locale === 'zh' ? 'Jev · 选择人设与模型，新增工作流' : 'Jev · Select personas and models for a new workflow') : plannerConnectionMessage(t, plannerStatus)}
      {plannerProvider === 'pi' && plannerStatus && !plannerStatus.available ? <button type="button" title={plannerStatus.error} onClick={() => { void readPlannerStatus(undefined, locale).then(setPlannerStatus); }}>{t('surface.retryPlanner')}</button> : null}
      {canInitialize && !recoveryLoaded ? <button type="button" disabled={recoveryChecking || recoveryStopping} onClick={() => { void refreshPlanningRecovery(); }}>{locale === 'zh' ? '检查上次规划' : 'Check earlier plan'}</button> : null}
    </div>,
  };

  // The latest request and its reply, which 「换一种方式」 hands over to the other way. A hand-over that fails
  // changes nothing but says why: a plan on the canvas is undone only once its task exists, and a running task is
  // stopped only where the canvas can take the request.
  let lastRequestIndex = -1;
  planning.messages.forEach((message, index) => { if (message.role === 'user') lastRequestIndex = index; });
  const lastRequest = lastRequestIndex >= 0 ? planning.messages[lastRequestIndex] : undefined;
  const lastReply = lastRequest ? planning.messages.slice(lastRequestIndex + 1).find(message => message.role === 'assistant' && message.route) : undefined;
  const switchToTask = async (prompt: string, planOnCanvas: boolean) => {
    const host = executionRef.current;
    if (!host) return;
    const id = `turn-${Date.now()}-${++planningSequence.current}`;
    const operationId = submissionId();
    setPlanningError('');
    setPending({ id, prompt, phase: 'starting', operationId });
    try {
      const taskId = await host.start(prompt, operationId);
      if (!mounted.current) return;
      // A canvas edited since the plan, or busy now, keeps it, and the conversation says so: only an undo that
      // happened is reported as one.
      const latest = assistantLatest.current!;
      const undone = planOnCanvas && latest.canUndoPlan && latest.undo();
      setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
        ...(planOnCanvas ? [{ id: `${id}-undo`, role: 'assistant' as const, content: undone ? surfaceNotice(t, 'plan_undone') : t('assistant.planKept') }] : []),
        userTurn(id, prompt, 'execute'), { id: `${id}-task`, role: 'assistant' as const, content: '', route: 'execute' as const, taskId }].slice(-60) }));
      setAssistantOpen(true);
      refocus('.awwo-canvas-assistant--panel textarea');
    } catch (error) {
      if (!mounted.current) return;
      // A task that may exist joins the conversation as unconfirmed (out of the box, as it may not be sent again),
      // and the plan stays until it is known.
      if (error instanceof TaskStartUnconfirmed) {
        setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
          ...(planOnCanvas ? [{ id: `${id}-undo`, role: 'assistant' as const, content: t('assistant.planKept') }] : []), userTurn(id, prompt, 'execute'),
          { id: `${id}-task`, role: 'assistant' as const, content: t('assistant.startUnconfirmed'), status: 'unconfirmed' as const, route: 'execute' as const,
            operationId }].slice(-60) }));
      } else setPlanningError(failureText(error));
    } finally { if (pendingId() === id) setPending(null); }
  };
  const switchToCanvas = async (prompt: string, taskId?: string) => {
    const blocked = planBlocker();
    if (blocked !== null) { setPlanningError(blocked || t('assistant.canvasBusy')); return; }
    const host = executionRef.current;
    if (taskId && host && !host.finished(taskId)) {
      const id = `turn-${Date.now()}-${++planningSequence.current}`;
      setPlanningError('');
      setPending({ id, prompt, phase: 'stopping' });
      try { await host.stop(taskId); }
      catch (error) { if (mounted.current) setPlanningError(failureText(error)); return; }
      finally { if (pendingId() === id) setPending(null); }
      if (!mounted.current) return;
      // The canvas may have become busy while the task stopped.
      const again = assistantLatest.current!.planBlocker();
      if (again !== null) { setPlanningError(`${t('assistant.taskStopped')}${again || t('assistant.canvasBusy')}`); return; }
    }
    void assistantLatest.current!.sendPlanningMessage(prompt);
  };
  const switchLastRequest = (to: AssistantRoute) => {
    if (!lastRequest || !lastReply || pendingRef.current || planningRequest.current) return;
    if (to === 'plan') { void switchToCanvas(lastRequest.content, lastReply.taskId); return; }
    const planOnCanvas = lastReply.status === 'applied' && !undoneHere(lastReply);
    if (planOnCanvas && !canUndoPlan) return;
    // A node that began talking since this render would keep the plan from being undone once the task exists.
    if (planOnCanvas && !canEditStructure()) { setPlanningError(surfaceNotice(t, 'planning_busy')); return; }
    void switchToTask(lastRequest.content, planOnCanvas);
  };
  const switchRoute = unifiedHost && !readOnly && lastRequest?.route && lastReply && !assistantPending && !planningBusy
    ? lastRequest.route === 'plan'
      ? (unifiedHost.ready && (lastReply.status !== 'applied' || undoneHere(lastReply) || canUndoPlan)
        ? { to: 'execute' as const, onSwitch: () => switchLastRequest('execute') } : undefined)
      // A task whose start is unconfirmed may exist: it is reconciled, never planned over.
      : (planAvailable && lastReply.status !== 'unconfirmed' ? { to: 'plan' as const, onSwitch: () => switchLastRequest('plan') } : undefined)
    : undefined;
  // Tasks the conversation mentions; the host lists the canvas's others (earlier ones, other devices') at its top.
  const mentionedTasks = useMemo(() => new Set(planning.messages.flatMap(message => message.taskId ? [message.taskId] : [])), [planning.messages]);
  // With the planner closed, tasks are the one way left, and the composer says so.
  const routeNotice = unifiedHost && planningUnavailableReason && unifiedHost.ready ? t('assistant.executeOnly') : undefined;
  const unified: UnifiedAssistant | undefined = assistantExecution ? {
    ...(assistantPending ? { pending: assistantPending } : {}),
    renderTask: assistantExecution.renderTask,
    earlier: assistantExecution.renderEarlier(mentionedTasks, readOnly),
    notices: assistantExecution.renderNotices(planAvailable),
    settings: assistantExecution.settings,
    ...(switchRoute ? { switchRoute } : {}),
    ...(routeNotice ? { notice: routeNotice } : {}),
    readOnly,
  } : undefined;
  // A read-only canvas shows its tasks; an editable one draws the panel for a canvas to work on or a conversation
  // with tasks, which needs no canvas.
  const viewerTasks = readOnly && Boolean(assistantExecution);
  // Closing the panel can take the pressed control with it (its close button; on an empty canvas the toggle).
  const closeAssistant = () => {
    setAssistantOpen(false);
    refocus(nodes.length || viewerTasks || mentionedTasks.size ? '.awwo-assistant-toggle' : '.awwo-canvas-assistant--welcome textarea');
  };
  const assistantPanel = assistantOpen && (viewerTasks || (!readOnly && (nodes.length > 0 || mentionedTasks.size > 0)))
    ? <CanvasAssistant mode="panel" {...assistantProps} unified={unified} onClose={() => closeAssistant()} /> : undefined;
  const panelShown = Boolean(assistantPanel);
  // Tasks are read while the conversation is on screen: in the side panel, or in the welcome of an empty canvas,
  // which draws it (its tasks and the canvas's earlier ones) once there is one. A viewer's host reads nothing before.
  const tasksShown = panelShown || (!readOnly && !nodes.length && planning.messages.length > 0);
  useEffect(() => {
    if (tasksShown) executionRef.current?.activate();
    executionRef.current?.setVisible(tasksShown);
  }, [tasksShown]);
  useEffect(() => () => executionRef.current?.setVisible(false), []);

  const addPaletteModel = (model: ModelPaletteSelection, personaId: AgentTemplateId | null, world?: { x: number; y: number }) => {
    if (!canEditStructure() || planningBusy || paletteLoading || paletteError || !cloudScope
      || palette?.tenantId !== cloudScope.tenant.id || palette.canvasId !== cloudScope.canvasId) return;
    const current = palette.models.find(item => item.key === model.key && item.available);
    if (!current) return;
    const v = viewRef.current;
    const s = sizeRef.current;
    const node = createModelNode(current, personaId, world ?? { x: (-v.x + s.w / 2) / (v.scale || 1) - 170, y: (-v.y + s.h / 2) / (v.scale || 1) - 130 }, locale);
    // This explicit focus owns the initial viewport; a delayed ResizeObserver must
    // not replace it with an overview fit for the smaller, collapsed card.
    fitted.current = true;
    patchDoc(previous => ({ ...previous, nodes: [...previous.nodes, node] }), { label: `add:${node.id}` });
    setAssistantOpen(false);
    setSelection([node.id]); setInspectorId(null); setModelFocusId(node.id);
  };
  const onModelDragStart = (event: DragEvent<HTMLButtonElement>, model: ModelPaletteSelection, personaId: AgentTemplateId | null) => {
    if (!canEditStructure() || planningBusy || !cloudScope || paletteLoading || paletteError || !model.available) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(MODEL_DRAG_MIME, modelDragPayload(cloudScope.tenant.id, model, personaId));
  };
  const onModelDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes(MODEL_DRAG_MIME)) return;
    event.preventDefault();
    if (!cloudScope || !canEditStructure() || planningBusy || !palette) return;
    const chosen = resolveModelDrop(event.dataTransfer.getData(MODEL_DRAG_MIME), cloudScope.tenant.id, palette.models);
    const rect = rootRef.current?.getBoundingClientRect();
    if (!chosen || !rect) return;
    const v = viewRef.current;
    addPaletteModel(chosen.model, chosen.personaId, { x: (event.clientX - rect.left - v.x) / (v.scale || 1), y: (event.clientY - rect.top - v.y) / (v.scale || 1) });
  };
  const modelShelf = canInitialize && !readOnly ? <ModelPersonaShelf modelsOnly
    configureModelsHref={personalCredentialsRequired ? accountURL('engines') : undefined}
    operatorManaged={!personalCredentialsRequired} groups={palette?.groups ?? []}
    loading={paletteLoading} error={paletteError} disabled={!canEdit || planningBusy || initializing || bindingLocked}
    personaId={palettePersona} onPersonaChange={setPalettePersona} onAddModel={addPaletteModel} onModelDragStart={onModelDragStart}
    onOpenWorkspaceAgents={() => setAgentLibraryRequest(value => value + 1)} onRetry={() => setPaletteRefresh(value => value + 1)}
    collapsed={modelRailCollapsed} onCollapsedChange={setShelfCollapsed}
    orchestrationControls={<div className="awwo-orchestration-choice"><label>
      <span>{locale === 'zh' ? '编排模型' : 'Orchestration model'}</span>
      <select aria-label={locale === 'zh' ? '编排模型' : 'Orchestration model'} value={plannerProvider} disabled={planningBusy}
        onChange={event => { const next = event.target.value === 'jev' ? 'jev' : 'pi'; setPlannerProvider(next); try { canvasStorage().setItem('awwo.canvas.planner-provider.v1', next); } catch { /* In-memory selection remains available. */ } }}>
        <option value="jev" disabled={!jevStatus?.available}>{`Jev${jevStatus && !jevStatus.available ? (locale === 'zh' ? ' · 未就绪' : ' · Unavailable') : ''}`}</option>
        <option value="pi">{locale === 'zh' ? '工作区默认模型' : 'Workspace default'}</option>
      </select></label>
      {plannerProvider === 'jev' ? <small>{jevStatus?.error || (locale === 'zh' ? '选择人设与执行模型，新增最多 3 个节点。' : 'Select personas and models for up to 3 new nodes.')}</small> : null}
      {nodes.length > 0 && <button type="button" disabled={planningBusy} onClick={() => setAssistantOpen(true)}>{locale === 'zh' ? '开始编排' : 'Start planning'}</button>}
    </div>} /> : undefined;

  const currentModelCatalogue = cloudScope && palette?.tenantId === cloudScope.tenant.id && palette.canvasId === cloudScope.canvasId
    ? palette.models : undefined;

  const renderInspector = (node: CanvasNode, inline = false) => (
    <InspectorPanel key={!canInitialize && node.kind === 'session' ? `${node.id}:${activeThreadId(node)}` : node.id} node={node} liveCompanies={companies} apiBase={paperclipApiBase()}
      readJson={runtimeReadJson} onSave={saveInspector} onInitialize={canInitialize && !runUnavailableReason ? initializeInspector : undefined} readOnly={readOnly || running} readOnlyMessage={readOnly ? t('common.readOnly') : undefined}
      media={canInitialize ? mediaState : undefined} onRetryMedia={() => setMediaRefresh(value => value + 1)}
      onCloseLockChange={onInspectorLockChange} onBound={() => refreshCompanies()}
      onCreateCompany={!readOnly && onCreateCompany ? () => {
        if (inspectorCloseLocked.current) return;
        setInspectorId(null);
        onCreateCompany();
      } : undefined}
      onClose={() => { if (!inspectorCloseLocked.current) setInspectorId(null); }}
      style={inline
        ? { position: 'relative', width: '100%', height: '100%', inset: 'auto', borderRadius: 0 }
        : { position: 'absolute', top: INSPECTOR_OVERLAY.inset, right: INSPECTOR_OVERLAY.inset, bottom: INSPECTOR_OVERLAY.inset,
          width: `min(${INSPECTOR_OVERLAY.width}px, calc(100% - ${INSPECTOR_OVERLAY.inset * 2}px))`, borderRadius: 12 }}
    />
  );

  return (
    <AgentWorkspace readOnly={readOnly} storageMode={storageMode} workspaceName={workspaceName} workspaceCaption={workspaceCaption} nodes={nodes} edges={edges} selectedIds={selection} runs={runs} running={running}
      modelShelf={modelShelf}
      modelCatalogue={currentModelCatalogue}
      personaControls={modelShelf ? <ModelPersonaControls personaId={palettePersona} onPersonaChange={setPalettePersona}
        disabled={!canEdit || planningBusy || initializing || bindingLocked} /> : undefined}
      onModelDrop={showingResults ? undefined : onModelDrop} onModelDragOver={event => {
        if (!showingResults && Array.from(event.dataTransfer?.types ?? []).includes(MODEL_DRAG_MIME) && canEditStructure() && !planningBusy) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
      }}
      onFocusNode={focusNode} onAddAgent={addAgent} loadWorkspaceAgents={loadWorkspaceAgents} agentLibraryRequest={agentLibraryRequest} onAddWorkspaceAgent={addWorkspaceAgent} onAddMarketAgent={loadWorkspaceAgents ? addMarketAgent : undefined} onCreateTemplate={createTemplate}
      onSearch={() => { changeStageView('canvas'); setBarMode('search'); }}
      assistant={assistantPanel}
      // One composer at a time: on an empty canvas whose conversation is in the side panel, the welcome steps aside.
      welcome={readOnly || assistantPanel ? undefined : <CanvasAssistant mode="welcome" {...assistantProps} unified={unified} />}
      // The toggle reports the panel as it is drawn; tasks need no canvas, so it is offered on an empty one with them.
      assistantOpen={panelShown} assistantAvailable={viewerTasks || mentionedTasks.size > 0}
      onToggleAssistant={readOnly && !assistantExecution ? undefined : () => { if (assistantPanel) closeAssistant(); else setAssistantOpen(true); }}
      onRailsChange={onRailsChange} modelRailCollapsed={modelRailCollapsed} onExpandModelRail={() => setShelfCollapsed(false)}
      onOpenSettings={onOpenSettings ? () => { if (!inspectorCloseLocked.current) onOpenSettings(); } : undefined}
      headerTitle={headerTitle} headerActions={headerActions} canvasTools={canvasTools}
      view={showingResults ? 'results' : 'canvas'} onViewChange={results ? changeStageView : undefined}
      results={showingResults ? <CanvasResults nodes={nodes} edges={edges} execution={doc.execution} runs={runs} running={running} readOnly={readOnly}
        runUnavailableReason={runUnavailableReason} onRun={readOnly ? undefined : () => void startRun()}
        notice={initializing ? { kind: 'status', text: locale === 'zh' ? '正在准备节点，首次运行会自动使用工作区默认配置…' : 'Preparing nodes with the workspace defaults…' }
          : handoffNote ? { kind: 'alert', text: handoffNote, onDismiss: () => setHandoffNote('') } : undefined}
        onOpenNode={id => { focusNode(id); refocus('.awwo-view-switch button'); }}
        onBack={() => { changeStageView('canvas'); refocus('.awwo-view-switch button'); }} receipt={results?.receipt} /> : undefined}
      accountControl={<div className="awwo-account-controls" inert={bindingLocked || initializing}>{accountControl}</div>}
      toolbar={<>{!cloudScope && <GraphSettings doc={doc} selectedNodeId={selection[0]} selectedEdgeId={selectedEdgeId}
        disabled={readOnly || running || initializing || bindingLocked} onChange={next => { if (canEditStructure()) patchDoc(() => next, { label: 'graph-settings' }); }}
        onAddPartner={nodeId => {
          if (!canEditStructure()) return;
          const result = addReviewPartner(docRef.current, nodeId, locale);
          patchDoc(() => result.doc, { label: 'review-partner' });
          setSelection([result.reviewerId]); restoreFocusCamera(); setFocusedId(null);
        }} />}
      <RunControls initializeOnRun={canInitialize} runUnavailableReason={runUnavailableReason} onConfigureNode={(id) => { focusNode(id, { configure: true }); setInspectorId(id); }} readOnly={readOnly || initializing || bindingLocked} nodes={nodes} edges={edges} execution={doc.execution} round={reviewRound} running={running} runs={runs} summary={runSummary}
        onViewOutput={id => { toggleDeliverables(id, true); focusNode(id); setTimelineOpen(false); }}
        stopped={stopped} onStart={() => void startRun()} onStop={stopRun}
        onToggleTimeline={() => { const fromResults = stageViewRef.current === 'results'; changeStageView('canvas'); setTimelineOpen(o => fromResults || !o); }} timelineOpen={timelineOpen && !showingResults}
        timelineUnavailableReason={focusedId ? t('run.timelineWhileOpen') : undefined}
        style={{ position: 'static', maxWidth: 'none', flexWrap: 'nowrap' }} /></>}>
    {/* Under the 成果 view the board is out of reach (the shortcuts pause too) but stays as it was. */}
    <div className="canvas-root" inert={showingResults || undefined} data-read-only={readOnly || undefined} data-selection-tool={selectionTool || undefined} data-narrow-focus={narrowFocusWidth(size.w) ? true : undefined} data-node-open={focusedId ? true : undefined} ref={rootRef} {...nodeViewRoot}>
      <CanvasViewport
        view={view}
        onViewChange={moveCamera}
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
        onBackgroundDoubleClick={readOnly || running || initializing ? undefined : (world) => addNode('llm', world)}
        onBackgroundContextMenu={
          readOnly || running
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
        <WirePlane nodes={renderNodes} edges={edges} runs={journal.current?.collaboration ? {} : runs} running={running && !journal.current?.collaboration} round={doc.execution ? reviewRound : 0} scale={view.scale}
          selectedEdgeId={selectedEdgeId ?? undefined} onSelectEdge={readOnly || running || initializing ? undefined : setSelectedEdgeId}
          preview={wiring.wireDrag} onDisconnect={readOnly || running || initializing ? undefined : disconnect} />
        <CollaborationFlow nodes={renderNodes} collaboration={journal.current?.collaboration} running={running} scale={view.scale} />
        {nodes.map((node) => (
          visibleIds.has(node.id) && (
          <SessionTile
            key={node.id}
            node={node}
            readOnly={readOnly}
            sendUnavailableReason={runUnavailableReason || undefined}
            initializeOnSend={canInitialize}
            freeConversation={Boolean(cloudScope)}
            renderTurnDetails={cloudScope ? tileRenderTurnDetails : undefined}
            renderCurrentRunDetails={cloudScope ? tileCurrentRunDetails : undefined}
            geometry={renderNodeById.get(node.id)}
            compact={node.kind === 'session' && focusedId !== node.id}
            scale={view.scale}
            focused={focusedId === node.id}
            selected={selection.includes(node.id)}
            run={runs[node.id] ?? null}
            gatewayBase={gatewayApiBase()}
            onSend={tileOnSend}
            conversationContext={node.kind === 'session' ? prepareNodeConversation(node, nodes, edges.filter(edge => edge.kind !== 'feedback')) : undefined}
            onIssueId={tileOnIssueId}
            onPreview={readOnly ? undefined : persistPreview}
            onDraftChange={readOnly ? undefined : persistDraft}
            onToggleDeliverables={readOnly ? undefined : toggleDeliverables}
            interactionLocked={running || initializing || bindingLocked}
            onMove={readOnly || running || initializing ? undefined : moveNode}
            onResizeNode={readOnly || running || initializing || (node.kind === 'session' && focusedId !== node.id) ? undefined : resizeNode}
            onSelect={selectNode}
            onToggleFocus={toggleFocus}
            onFitNode={focusNode}
            onConfigure={tileOnConfigure}
            configurationPanel={!canInitialize && node.kind === 'session' && focusedId === node.id && inspectorId === node.id ? renderInspector(node, true) : null}
            onUpdateNode={readOnly || running || initializing || bindingLocked ? undefined : saveNode}
            onRunNode={readOnly || running || initializing || runUnavailableReason ? undefined : rerunNode}
            onDelete={readOnly || running || initializing ? undefined : tileDelete}
            wiring={wiring}
          />
          )
        ))}
        <Marquee rect={marquee.rect as WorldRect | null} />
      </CanvasViewport>

      {!running && <SelectionCollaboration key={`selection:${JSON.stringify(selection)}`} nodes={nodes.filter(node => selection.includes(node.id))}
        disabled={readOnly || initializing || bindingLocked || Boolean(runUnavailableReason)} available={Boolean(cloudScope)}
        onStart={(ids, policy) => { void startRun(ids, undefined, undefined, undefined, policy); }} />}
      {running && journal.current?.collaboration && <CollaborationStatus nodes={nodes} collaboration={journal.current.collaboration} />}

      {initializing && <div className="awwo-handoff-note" role="status">{locale === 'zh' ? '正在准备节点，首次运行会自动使用工作区默认配置…' : 'Preparing nodes with the workspace defaults…'}</div>}
      {!initializing && handoffNote && <div className="awwo-handoff-note" role="alert"><span>{handoffNote}</span><button type="button" aria-label={locale === 'zh' ? '关闭提示' : 'Dismiss notice'} onClick={() => setHandoffNote('')}>×</button></div>}
      {/* Same guard as the minimap: the view tools never paint over the opaque welcome overlay of a
          fresh canvas. An empty canvas that still has something to undo or redo keeps them, or a
          deleted last node or an undone plan could only come back through a keyboard shortcut. */}
      {(nodes.length > 0 || history.undo > 0 || history.redo > 0) && <div className="awwo-view-tools" role="toolbar" aria-label={viewText.toolbar}>
        <button type="button" aria-label={locale === 'zh' ? '框选组件' : 'Select components'} title={locale === 'zh' ? '框选组件（也可按住 Shift 拖动）' : 'Select components (or Shift + drag)'} aria-pressed={selectionTool}
          onClick={() => setSelectionTool(value => !value)}><MousePointer2 size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.zoomOut} title={viewText.zoomOut} onClick={() => zoomBy(1 / 1.2)}><Minus size={16} /></button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button aria-label={viewText.zoomIn} title={viewText.zoomIn} onClick={() => zoomBy(1.2)}><Plus size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.fitAll} title={viewText.fitAll} disabled={!nodes.length} onClick={fitAll}><Maximize2 size={16} /></button>
        <button aria-label={viewText.arrange} title={viewText.arrangeTitle} disabled={readOnly || running || initializing || bindingLocked || !nodes.length} onClick={arrangeNodes}><LayoutGrid size={16} /></button>
        <button className="awwo-minimap-toggle" aria-label={viewText.showMinimap} title={focusedId ? t('surface.minimapWhileOpen') : viewText.showMinimap} aria-pressed={minimapOpen} disabled={Boolean(focusedId)} onClick={() => setMinimapOpen(o => !o)}><Map size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.undo} title={viewText.undo} disabled={readOnly || running || initializing || !history.undo} onClick={undo}><Undo2 size={16} /></button>
        <button aria-label={viewText.redo} title={viewText.redo} disabled={readOnly || running || initializing || !history.redo} onClick={redo}><Redo2 size={16} /></button>
        {selection.length > 0 && <><span className="awwo-tool-separator" /><button aria-label={viewText.runSelection} title={runUnavailableReason || viewText.runSelection} disabled={readOnly || running || Boolean(runUnavailableReason)} onClick={runFromSelection}><Play size={15} /></button></>}
      </div>}

      {minimapOpen && nodes.length > 0 ? (
        <Minimap
          boxes={renderNodes}
          view={view}
          size={size}
          onCenter={(wx, wy) => moveCamera(focusWorld(viewRef.current, wx, wy, sizeRef.current))}
        />
      ) : null}

      {timelineOpen && Object.keys(runs).length > 0 ? (
        <RunTimeline
          nodes={nodes}
          runs={runs}
          modelCatalogue={currentModelCatalogue}
          runStartedAt={runStartedAt}
          now={now}
          onClose={() => setTimelineOpen(false)}
          onOpenNode={id => { focusNode(id); setTimelineOpen(false); }}
        />
      ) : null}

      {inspectorNode && (inspectorNode.kind === 'form' || canInitialize) ? renderInspector(inspectorNode) : null}

      {!readOnly && addMenu ? (
        <AddNodeMenu
          onOpenModelShelf={modelShelf ? () => setShelfCollapsed(false) : undefined}
          mediaKinds={canInitialize ? mediaKinds : undefined}
          onOpenAgentLibrary={loadWorkspaceAgents ? () => { setAddMenu(null); setAgentLibraryRequest(value => value + 1); } : undefined}
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
