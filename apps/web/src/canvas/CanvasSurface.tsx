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
import { currentSaaSCanvas, flushSaaSCanvas, initializeSaaSCanvas, subscribeCanvasKnowledge, confirmSaaSPlanningCancellation } from '../saas/canvasBridge';
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
import { Maximize2, Minus, Plus, Redo2, Undo2, Map, Play, LayoutGrid, MousePointer2, MonitorPlay } from 'lucide-react';
import { SelectionCollaboration, CollaborationFlow, CollaborationStatus } from './SelectionCollaboration';
import { AgentWorkspace } from './AgentWorkspace';
import { CanvasAssistant, type AssistantNextSteps, type UnifiedAssistant } from './CanvasAssistant';
import { nextSteps as canvasNextSteps, failureRequestKind, isNextStepsQuestion, isOutcomeQuestion, runRequestKind, type NextStep, type NextSteps } from './nextSteps';
import { reviewVerdict, reworkRequirements } from './reviewVerdict';
import { runErrorText } from '../saas/canvasErrors';
import { fetchRouteUsage, recordUpgradeInterest, type RouteAllowance } from '../saas/routeUsage';
import { recordCanvasEvent, type CanvasUiEvent } from '../saas/uiEvents';
import { assistantCostNote } from './assistantCost';
import { assistantRouteRequest, TaskStartUnconfirmed, type AssistantExecutionHost, type AssistantPending, type AssistantRoute,
  type RouteAssistant } from './assistantRouting';
import { CanvasResults } from './CanvasResults';
import { ModelPersonaControls, ModelPersonaShelf } from './ModelPersonaShelf';
import { automaticGroups, paletteEfforts, readModelPalette, type ModelPaletteSelection } from './modelPalette';
import { createModelNode, MODEL_DRAG_MIME, modelDragPayload, resolveModelDrop } from './canvasModelDrop';
import { applyJevPlan, readJevPlannerStatus, requestJevPlan } from './jevPlanning';
import { applyCanvasPlan, canvasPlanRevision, onlyAddedNodes, type CanvasPlanMedia, type CanvasPlanModelChoice } from './canvasPlan';
import { withAssistantModel } from './assistantModel';
import { describePlanChanges } from './planChanges';
import { automaticEntries, withAutomaticRuntimes } from './nodeRuntime';
import { loadLastPlanDuration, loadPlanningConversation, savePlanningConversation, saveLastPlanDuration, requestCanvasPlan, readPlannerStatus,
  readCanvasPlanRecovery, cancelCanvasPlanRecovery, planningTurns, type PlanProgress, type PlanningMessage } from './canvasPlanning';
import { invalidateOutputs } from './invalidateOutputs';
import { prepareNodeConversation } from './nodeConversation';
import { followupDeliveryContract } from './followupDelivery';
import { createAgentTemplate, createDevelopmentTemplate, type AgentTemplateId } from './agentTemplates';
import { CanvasViewport } from './CanvasViewport';
import { SessionTile, type SelectMode } from './SessionTile';
import { TilePorts, useWiring } from './TilePorts';
import { WirePlane } from './WirePlane';
import { Marquee, useMarquee } from './Marquee';
import { AddNodeMenu, type AddNodeKind } from './AddNodeMenu';
import { InspectorPanel } from './InspectorPanel';
import { mediaCatalogueOf, type MediaCatalogueState } from './MediaNodeSettings';
import { mediaGroupLabel, mediaKindOf, mediaModelLabel, mediaModelsOf, readMediaCatalogue, type MediaKind } from './mediaCatalog';
import type { ModelNameSources } from './modelNames';
import { replaceRetiredMediaModels } from './retiredMediaModels';
import { runScopeWithoutMedia } from './runScope';
import type { NodeModelChoice } from './NodeModelPicker';
import { inspectorSavedNode } from './inspectorSave';
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
import { CANVAS_RUN_JOURNAL_KEY as RUN_JOURNAL_KEY, loadRunJournal as loadJournal, saveRunJournal as saveJournal, clearRunJournal as clearJournal } from './runJournal';
import { RUN_LANES, exclusiveJournal, laneJournalKey, laneOfStorageKey, laneStorage, loadLaneJournals, withLaneOwnership } from './runLanes';
import { canvasStorage as baseCanvasStorage } from './canvasStorage';
import { currentGraphRunEntry } from './currentGraphRun';
import { applyRecoveredDocument, prepareRunDocument, runInputFingerprint, recoveryJournalForDocument, mergeRecoveredManualConversation } from './runRecoveryDocument';
import { prepareManualHistoryCapacity, persistManualHistoryWithNativeProof } from './manualHistoryRetention';
import { subscribePageErrors, type PageErrorReport } from './pageErrors';
import { deferPageRepair, isPageRepairMessage, loadPageRepairRecords, pageRepairDecision, pageRepairDisplayText, pageRepairMessage, pageRepairMessageKey, pageRepairRecordKey, pageRepairRetryAfter, pageRepairTarget, savePageRepairRecord } from './pageRepair';
import { withCanvasRunOwnership } from './runOwnership';
import { useCanvasI18n } from './i18n';
import { surfaceNotice, stopUnconfirmedMessage, planFailureMessage, plannerConnectionMessage, surfaceViewMessages, preflightIssueMessage, recoveryDetailMessage } from './surfaceMessages';
import { getSnapshot as getSessionSnapshot, reset as resetSession, replaceTurns, patchPresentation } from './sessions';
import { forgetNode, restoreHistory } from './sessionTransport';
import { projectConversationTurns, updateConversationPresentation } from './conversationPresentation';
import { activeThreadId, boundAgentConfigurationChanged, getNodeThreads, preserveThreadRuntime, rebindNodeThread, sessionStoreKey,
  updateNodeDraft, updateThreadIssueId, updateThreadPreview } from './nodeThreads';
import { arrangeNodePositions, nodeDepths, presentationNodes } from './nodePresentation';
import { boundsOfBoxes, boundsWithinViewport, fitBounds, fitOverview, focusWorld, MIN_READABLE_FIT_SCALE, openInPlace, visibleBoxIds, type ViewportState } from './viewport';
import { RAIL_MODEL_KEY, isDesktopStage, readRailCollapsed, useDesktopStage, writeRailCollapsed } from './railState';
import { paperclipApiBase } from '../paperclipBridge';
import { gatewayApiBase } from '../chatAutomations';
import './canvas.css';
import './node-view-styles.css';
import { nodeViewRootProps, useNodeViewPreference } from './nodeViewStyle';
import { useSimpleCanvas } from './uiMode';
import { CARD_PREVIEW_DEFAULT, clampCard, loadCardFrames, saveCardFrames, showsPreview, type CardFrames } from './cardFrames';
import { DeliverableStudio } from './studio/DeliverableStudio';
import { studioGroups } from './studio/studioModel';
import { DisplayLinks, DisplayTile, type DisplayChoice } from './DisplayTile';
import { clampDisplaySize, createDisplayNode, displayBounds, MAX_DISPLAYS, placeDisplayAfter, placeDisplayBeside, sameDisplaySource, type DisplayNode, type DisplaySource } from './displayNodes';
import { displayText } from './displayCopy';
/** A document with no 预览展示 windows (displayNodes.ts): one shared empty list, so memoised readers see no change. */
const NO_DISPLAYS: ReadonlyArray<DisplayNode> = [];
/** A node failure refused by the free premium allowance reads as that error's own copy, in either language. */
const refusalTexts = (codes: ReadonlyArray<string>) => codes
  .flatMap(code => (['zh', 'en'] as const).map(language => runErrorText(code, language) ?? '')).filter(Boolean);
const PREMIUM_REFUSALS = refusalTexts(['premium_quota_exceeded', 'premium_capacity_exceeded']);
/** And one refused because the workspace's own run allowance is full (today's calls, or runs at once). */
const QUOTA_REFUSALS = refusalTexts(['quota_exceeded']);

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

/** Compact summaries remain readable at overview scale without the full-workbench fit floor. Displays (preview
 *  windows beside the graph) are part of the board, so a fit shows them too. */
function fitNodeOverview(nodes: ReadonlyArray<CanvasNode>, size: { w: number; h: number }, cardFrames?: CardFrames,
  displays: ReadonlyArray<DisplayNode> = NO_DISPLAYS): ViewportState {
  const cards = presentationNodes(nodes, null, undefined, cardFrames);
  const bounds = displays.length ? boundsOfBoxes([...cards, ...displays]) : boundsOfNodes(cards);
  const maxScale = Math.max(.06, Math.min(1.05,
    (size.w - 96) / Math.max(1, bounds.maxX - bounds.minX),
    (size.h - 140) / Math.max(1, bounds.maxY - bounds.minY)));
  return fitBounds(bounds, size, { minScale: .06, maxScale }, { x: 48, top: 40, bottom: 100 });
}

function hasStreamingConversation(nodes: ReadonlyArray<CanvasNode>): boolean {
  return nodes.some(node => node.kind === 'session' && getNodeThreads(node)
    .some(thread => getSessionSnapshot(sessionStoreKey(node, thread.id)).streaming));
}

/** A saved document's canonical text without its camera and save time: what a run's recovery has to preserve. */
function sansCamera(json: string | null): string | null {
  if (json === null) return null;
  try {
    const { view: _view, updatedAt: _updatedAt, ...rest } = JSON.parse(json) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch { return json; }
}

/** Where a node sits, how large it is drawn and the next message being typed into it are not part of what a run executes. */
function nodeSubstance(node: CanvasNode): string {
  const { x: _x, y: _y, w: _w, h: _h, ...rest } = node as CanvasNode & { deliverablesOpen?: boolean };
  delete (rest as { deliverablesOpen?: boolean }).deliverablesOpen;
  // People write their next message while the node works; the run already holds the one it was sent.
  if (node.kind === 'session') (rest as { threads?: unknown }).threads = getNodeThreads(node).map(({ draft: _draft, ...thread }) => thread);
  return JSON.stringify(rest);
}

/** Whether an edit changes a node a lane is executing, adds or removes one, or rewires one. */
export function touchesBusyNodes(prev: Pick<CanvasDocument, 'nodes' | 'edges'>, next: Pick<CanvasDocument, 'nodes' | 'edges'>, busy: ReadonlySet<string>): boolean {
  for (const id of busy) {
    const before = prev.nodes.find(node => node.id === id);
    const after = next.nodes.find(node => node.id === id);
    if (!before && !after) continue;
    if (!before || !after) return true;
    if (before !== after && nodeSubstance(before) !== nodeSubstance(after)) return true;
  }
  const wires = (doc: Pick<CanvasDocument, 'edges'>) => doc.edges.filter(edge => busy.has(edge.fromNode) || busy.has(edge.toNode))
    .map(edge => JSON.stringify(edge)).sort().join('\n');
  return prev.edges !== next.edges && wires(prev) !== wires(next);
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
  /** The host's record of the run behind the result, given what this canvas can name models with. */
  receipt?: (final: CanvasNode | null, names: ModelNameSources) => ReactNode;
  /** Open in the 成果 view (a link to a canvas's results). */
  initialView?: 'canvas' | 'results';
  /** The view changed; a host can keep it in the address. */
  onViewChange?: (view: 'canvas' | 'results') => void;
  /** Show the results in the deliverable studio (file tree, search, live pages). */
  studio?: boolean;
}

export function CanvasSurface({ readOnly = false, workspaceName, workspaceCaption, storageMode = 'local', runtimeReadJson, onCreateCompany, accountControl, headerTitle, headerActions, canvasTools, assistantExecution, routeAssistant, results, taskDraft = null, onOpenSettings, personalCredentialsRequired = false, executionUnavailableReason, onLocalDocumentSaveFailed, planRequest = requestCanvasPlan, initialPlan = null }: CanvasSurfaceProps = {}) {
  const { locale, t } = useCanvasI18n();
  // 普通用户模式: the conversations, each node's chat and model, and what the canvas made; nothing that configures by hand.
  const simple = useSimpleCanvas();
  const simpleRef = useRef(simple);
  simpleRef.current = simple;
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
  const baseStorage = storage;
  // Cards enlarged to show their deliverable (a view preference, never the document): see cardFrames.ts.
  const [cardFrames, setCardFrames] = useState<CardFrames>(() => loadCardFrames());
  const cardFramesRef = useRef(cardFrames);
  cardFramesRef.current = cardFrames;
  const canInitialize = storageMode === 'cloud' && Boolean(cloudScope);
  const runUnavailableReason = storageMode === 'cloud' ? executionUnavailableReason?.trim() || '' : '';
  const [palette, setPalette] = useState<Awaited<ReturnType<typeof readModelPalette>> | null>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [paletteError, setPaletteError] = useState('');
  const [paletteRefresh, setPaletteRefresh] = useState(0);
  const [palettePersona, setPalettePersona] = useState<AgentTemplateId | null>(null);
  // Each press of a 「去填写」 step opens that node on its input drawer (SessionTile inputRequest).
  const [inputRequests, setInputRequests] = useState<Record<string, number>>({});
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
  const mediaKinds = useMemo(() => (['image', 'video', 'model3d'] as const).filter(kind => mediaModelsOf(mediaCatalogueOf(mediaState), kind).length > 0), [mediaState]);
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
  const lastSavedRaw = useRef<string | null>(null);
  if (lastSavedRaw.current === null) { try { lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY); } catch { /* read again after the first save */ } }
  const saveLocalDocument = useCallback((next: CanvasDocument): boolean => {
    if (outdatedObserver.current) return false;
    if (!saveDocument(next)) {
      localSaveFailure.current?.(next);
      return false;
    }
    lastSavedRevision.current = canvasPlanRevision(sanitizeDocument(next));
    lastSavedDocument.current = canonicalCanvasDocumentJSON(next);
    try { lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY); } catch { lastSavedRaw.current = null; }
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
  // Runs are fenced off node by node (runLanes.ts): an edit may change anything except a node some lane is executing
  // (its wires included). Moving, resizing or opening that node is presentation and stays free. The guard is filled
  // in once the lanes below exist; until then nothing runs.
  const laneGuard = useRef<{ busy: (exceptLane?: number) => Set<string>; active: () => boolean; exclusive: () => boolean }>({
    busy: () => new Set(), active: () => false, exclusive: () => false,
  });
  const laneGuardLaneActive = useRef<(lane: number) => boolean>(() => false);
  const patchDoc = useCallback(
    (mut: (prev: CanvasDocument) => CanvasDocument, opts?: { label?: string; silent?: boolean; serverIdentity?: boolean; lane?: number }) => {
      if (readOnlyRef.current || outdatedObserver.current || setupRequest.current) return;
      // A review loop or a collaboration holds the whole canvas, as every run once did.
      if (opts?.lane === undefined && laneGuard.current.exclusive()) return;
      const prev = docRef.current;
      const proposed = mut(prev);
      const next = opts?.serverIdentity ? proposed : invalidateOutputs(prev, proposed);
      if (next === prev) return;
      const busy = laneGuard.current.busy(opts?.lane);
      if (busy.size && touchesBusyNodes(prev, next, busy)) {
        if (!opts?.silent) setHandoffNote(surfaceNotice(t, 'node_busy_edit'));
        return;
      }

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

  // What a plan needs to add media nodes: the model each kind starts on (the add menu's first one) and each model's
  // longest prompt. Without a catalogue the planner is offered no media nodes at all.
  const planMedia = useMemo<CanvasPlanMedia | undefined>(() => {
    const catalogue = mediaCatalogueOf(mediaState);
    if (!catalogue?.available) return undefined;
    const models: CanvasPlanMedia['models'] = {};
    for (const kind of ['image', 'video', 'model3d'] as const) {
      const first = mediaModelsOf(catalogue, kind)[0];
      if (first) models[kind] = first.id;
    }
    return { models, promptMax: model => catalogue.models.find(item => item.id === model)?.prompt.maxLength };
  }, [mediaState]);
  // A media node still set to a retired generator's model moves to the model offered now, with nothing said about it
  // (owner decision 2026-10-11). Its results stay: the move is not an edit that makes them stale.
  useEffect(() => {
    if (readOnly) return;
    const moved = replaceRetiredMediaModels(docRef.current, mediaCatalogueOf(mediaState));
    if (moved) patchDoc(() => moved, { silent: true, serverIdentity: true });
  }, [doc, mediaState, readOnly, patchDoc]);

  // User callbacks can outlive their idle render. The journal/ref checks also cover
  // acceptance before React commits `running`, waiting nodes, and terminal settlement.
  // `touching` names the nodes an edit changes: such an edit may go ahead while other nodes run. Without it the
  // canvas must be idle (undo, a plan, settings that reach every node).
  const canEditStructure = useCallback((allowBindingSave = false, touching?: ReadonlyArray<string>) => {
    if (readOnlyRef.current || outdatedObserver.current || setupRequest.current || (inspectorCloseLocked.current && !allowBindingSave)) return false;
    if (touching) {
      if (laneGuard.current.exclusive()) return false;
      const busy = laneGuard.current.busy();
      return !touching.some(id => busy.has(id)) && !hasStreamingConversation(docRef.current.nodes.filter(node => touching.includes(node.id)));
    }
    return !laneGuard.current.active() && !recoveringRef.current && !hasStreamingConversation(docRef.current.nodes);
  }, []);

  /**
   * Step to a stored document without recording it as a new edit. The camera is not history (its
   * save is a machine write): the canvas keeps the camera it has now, not the one saved when that
   * step was taken, which the screen would not show and a reopen would land on.
   */
  const restoreDoc = useCallback((target: CanvasDocument) => {
    if (readOnlyRef.current || outdatedObserver.current || setupRequest.current || laneGuard.current.active()) return;
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
    if (readOnlyRef.current || outdatedObserver.current || setupRequest.current) return;
    // Lanes keep the canvas editable while they run, so ordinary saves go on, but only over the document this page
    // wrote last: a different one is another tab's (a run it finished), which this page's observer adopts instead.
    if (laneGuard.current.active() || recoveringRef.current) {
      let cached: string | null = null;
      try { cached = canvasStorage().getItem(CANVAS_STORAGE_KEY); } catch { return; }
      if (cached !== lastSavedRaw.current) return;
    }
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
    const next = fitNodeOverview(fitNodes, box, cardFramesRef.current, docRef.current.displays);
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
  // A selected 预览展示 window. Its own state, beside the node selection: a display is never a node, so nothing that
  // acts on selected nodes (runs, collaboration, group moves) can reach it.
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null);
  const selectedDisplayRef = useRef(selectedDisplayId);
  selectedDisplayRef.current = selectedDisplayId;
  const displays = doc.displays ?? NO_DISPLAYS;
  useEffect(() => { if (selection.length) setSelectedDisplayId(null); }, [selection]);
  useEffect(() => {
    if (selectedDisplayId && !displays.some(display => display.id === selectedDisplayId)) setSelectedDisplayId(null);
  }, [displays, selectedDisplayId]);
  // Read inside the drag so moving a group never depends on the callback identity at press time.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const renderNodes = useMemo(() => presentationNodes(nodes, focusedId, narrowFocusWidth(size.w), cardFrames), [nodes, focusedId, size.w, cardFrames]);
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
    if (!canEditStructure(false, [])) return;
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
  // Runs happen in lanes (runLanes.ts): a node's chat or one component's task runs beside the others instead of
  // holding the whole canvas. Each lane has its own durable journal, abort controller and recovery observer; the
  // board reads the aggregate (every lane's badges, whether anything runs, which nodes are busy).
  type RunLane = {
    journal: { current: CanvasRunJournal | null };
    abort: { current: AbortController | null };
    /** Claimed by a start that has not written its journal yet (so two quick starts never share a lane). */
    reserved: Set<string> | null;
  };
  const [initialJournals] = useState(() => readOnly ? [] : loadLaneJournals());
  const initialOf = (lane: number) => initialJournals.find(item => item.lane === lane)?.journal ?? null;
  const lanes = useRef<RunLane[] | null>(null);
  if (!lanes.current) lanes.current = RUN_LANES.map(lane => ({ journal: { current: initialOf(lane) }, abort: { current: null }, reserved: null }));
  const laneList = lanes.current;
  // Two nodes bound to one agent take turns, even when they run in different lanes.
  const agentQueue = useRef(new globalThis.Map<string, Promise<unknown>>());
  const [laneRuns, setLaneRuns] = useState<Array<Record<string, RunView>>>(() => RUN_LANES.map(lane => initialOf(lane)?.nodes ?? {}));
  const [laneRunning, setLaneRunning] = useState<boolean[]>(() => RUN_LANES.map(lane => Boolean(initialOf(lane))));
  const [laneRecovering, setLaneRecovering] = useState<boolean[]>(() => RUN_LANES.map(lane => Boolean(initialOf(lane))));
  const laneRecoveringRef = useRef(laneRecovering);
  laneRecoveringRef.current = laneRecovering;
  // Lanes never share a node, so their badges merge without conflict; a lane that starts takes its nodes' badges.
  const runs = useMemo(() => Object.assign({}, ...laneRuns) as Record<string, RunView>, [laneRuns]);
  const running = laneRunning.some(Boolean);
  const recovering = laneRecovering.some(Boolean);
  const recoveringRef = useRef(recovering);
  recoveringRef.current = recovering;
  const laneSetters = useMemo(() => RUN_LANES.map(lane => ({
    setRuns: (value: Record<string, RunView> | ((previous: Record<string, RunView>) => Record<string, RunView>)) => setLaneRuns(previous => {
      const next = [...previous];
      next[lane] = typeof value === 'function' ? value(previous[lane]) : value;
      return next;
    }),
    setRunning: (value: boolean) => setLaneRunning(previous => previous[lane] === value ? previous : previous.map((item, index) => index === lane ? value : item)),
    setRecovering: (value: boolean) => setLaneRecovering(previous => previous[lane] === value ? previous : previous.map((item, index) => index === lane ? value : item)),
  })), []);
  /** Clear badges across every lane (an edit that makes earlier results no longer describe the canvas). */
  const setAllRuns = useCallback((update: (previous: Record<string, RunView>) => Record<string, RunView>) => setLaneRuns(previous => previous.map(update)), []);
  /** A lane holds work: its journal (here or written by another tab), a live executor, or a start in progress. A reader
   *  never runs or recovers, so another tab's stored journal does not lock its view. */
  const laneActive = useCallback((lane: number) => {
    const state = laneList[lane];
    return Boolean(state.journal.current || state.abort.current || state.reserved || (!readOnly && canvasStorage().getItem(laneJournalKey(lane))));
  }, [laneList, readOnly]);
  const laneJournal = useCallback((lane: number) => laneList[lane].journal.current ?? (readOnly ? null : loadRunJournal(laneStorage(lane))), [laneList, readOnly]);
  const anyLaneActive = useCallback(() => RUN_LANES.some(laneActive), [laneActive]);
  /** A review loop or a collaboration runs alone: while one is active nothing else starts or changes. */
  const exclusiveLaneActive = useCallback(() => RUN_LANES.some(lane => exclusiveJournal(laneJournal(lane))), [laneJournal]);
  /** The nodes lanes are executing (optionally leaving one lane out: a lane may change its own nodes). A start that has
   *  not been accepted yet only reserves its nodes against a second start (`forAdmission`); until its journal exists
   *  they stay editable, and its acceptance refuses a canvas that changed meanwhile, exactly as a single run did. */
  const busyNodeIds = useCallback((exceptLane?: number, forAdmission = false): Set<string> => {
    const busy = new Set<string>();
    for (const lane of RUN_LANES) {
      if (lane === exceptLane) continue;
      const state = laneList[lane];
      if (forAdmission) for (const id of state.reserved ?? []) busy.add(id);
      const active = state.journal.current ?? (!readOnly && canvasStorage().getItem(laneJournalKey(lane)) ? loadRunJournal(laneStorage(lane)) : null);
      for (const id of active?.scope ?? []) busy.add(id);
    }
    return busy;
  }, [laneList, readOnly]);
  const laneOfNode = useCallback((nodeId: string) => RUN_LANES.find(lane => laneJournal(lane)?.scope.includes(nodeId)), [laneJournal]);
  laneGuard.current = { busy: busyNodeIds, active: anyLaneActive, exclusive: exclusiveLaneActive };
  laneGuardLaneActive.current = laneActive;
  // A collaboration runs alone, so at most one lane holds one.
  const collaborationJournal = RUN_LANES.map(lane => laneList[lane].journal.current).find(item => item?.collaboration) ?? null;
  // What the board locks this render: the nodes lanes execute, or everything while a review/collaboration runs.
  const busyNow = busyNodeIds();
  const exclusiveNow = exclusiveLaneActive();
  // A node running on its own (a chat, or 运行节点) can be stopped from its card without touching the other lanes.
  // A node that is one step of a larger run is stopped with that run, from the toolbar.
  const soloRunning = new Set<string>();
  RUN_LANES.forEach(lane => {
    const scope = laneRunning[lane] ? laneList[lane].journal.current?.scope : undefined;
    if (scope?.length === 1 && !laneList[lane].journal.current?.collaboration) soloRunning.add(scope[0]);
  });
  const [reviewRound, setReviewRound] = useState(initialJournals.find(item => item.journal.review)?.journal.review?.round ?? 0);
  const [runSummary, setRunSummary] = useState<Parameters<typeof RunControls>[0]['summary']>(null);
  const [stopped, setStopped] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (readOnly) return;
    const observeOtherTab = (event: StorageEvent) => {
      if (readOnlyRef.current || outdatedObserver.current) return;
      const lane = laneOfStorageKey(event.key);
      if (lane === null || laneList[lane].abort.current) return;
      const active = loadRunJournal(laneStorage(lane));
      if (active) {
        const { setRuns, setRunning, setRecovering } = laneSetters[lane];
        laneList[lane].journal.current = active; setRuns(active.nodes); setReviewRound(active.review?.round ?? 0); setRunning(true); setRecovering(true);
      }
    };
    window.addEventListener('storage', observeOtherTab);
    return () => window.removeEventListener('storage', observeOtherTab);
  }, [readOnly]);
  // A page reload detaches observation; only an explicit Stop cancels native execution.
  const updateJournalFor = useCallback((lane: number) => (nodeId: string, patch: Parameters<typeof patchRunJournalNode>[2]) => {
    const journal = laneList[lane].journal;
    if (readOnlyRef.current || outdatedObserver.current || !journal.current) return;
    journal.current = patchRunJournalNode(journal.current, nodeId, patch);
    if (!saveRunJournal(journal.current, laneStorage(lane))) setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
  }, [laneList]);
  // One lane's recovery observer (a server graph being watched, a detached chat, another tab's run). The body below
  // is the single-run observer, bound to its lane: `journal`, the lane's storage and lock, and its badge setters.
  const observeLane = useCallback((lane: number): (() => void) => {
    const journal = laneList[lane].journal;
    const { setRuns, setRunning, setRecovering } = laneSetters[lane];
    const storage = laneStorage(lane, baseStorage);
    const CANVAS_RUN_JOURNAL_KEY = RUN_JOURNAL_KEY;
    const loadRunJournal = (from: Pick<Storage, 'getItem'> = storage) => loadJournal(from);
    const saveRunJournal = (value: CanvasRunJournal, to: Pick<Storage, 'setItem'> = storage) => saveJournal(value, to);
    const clearRunJournal = (target: Parameters<typeof clearJournal>[0] | string, expected?: string) =>
      typeof target === 'string' ? clearJournal(storage, target) : clearJournal(target, expected);
    const withCanvasRunOwnership = (run: () => Promise<void>, refused: () => void) => withLaneOwnership(lane, run, refused);
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
      // Where someone is looking (the camera, saved as they pan) is not an edit a recovery could lose.
      return live === lastSavedDocument.current || sansCamera(live) === sansCamera(lastSavedDocument.current)
        || Boolean(pending && pending.document === live
        && pending.storageKey === capturedDocumentKey && pending.journalId === (loadRunJournal()?.id ?? journal.current?.id));
    };
    const canWriteRecovery = () => {
      if (!observerIsActive()) return false;
      const cached = loadDocumentWithStatus({ readOnly: true });
      // Scoped fingerprints omit unrelated nodes, drafts and history. Protect the complete
      // durable base AND any unsaved source edits in this page before rewriting the cache.
      // Only an exact recovery result that this observer failed to save may be retried.
      if (cached.status !== 'ok' || canonicalCanvasDocumentJSON(cached.doc) !== lastSavedDocument.current) return pauseOutdatedObserver();
      if (hasNoUnsavedSourceEdits()) return true;
      // Lanes leave the canvas editable while they run: an edit this page made a moment ago (a card moved, another
      // node's chat) is this page's newest document over the cache it last wrote. Save it first, then recover over it.
      return saveLocalDocument(docRef.current) || pauseOutdatedObserver();
    };
    // Node preparation (another lane starting) rewrites the document through the server: wait for it.
    const preparing = () => Boolean(setupRequest.current);
    const refreshedHistories = new Set<string>();
    setHandoffNote(surfaceNotice(t, 'recovering_run'));
    const poll = () => withCanvasRunOwnership(async () => {
      if (!observerIsActive()) return;
      if (preparing()) { timer = setTimeout(() => void poll(), 600); return; }
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
        lastSavedDocument.current = canonicalCanvasDocumentJSON(current.doc); lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY);
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
      let next = cloudScope || recoveredJournal.serverGraph ? recoveredJournal
        : await settleRecoveredJournal(gatewayApiBase(), recoveredJournal, controller.signal);
      // A graph admitted on this acknowledged version cannot have seen this revision.
      // Keep the boundary stable across retries, including retries after a rejected cloud CAS.
      if (next.manual && cloudScope && next.supersedesThroughGraphVersion === undefined
          && !Object.values(next.nodes).some(node => node.state === 'running' || node.state === 'waiting')) {
        try {
          const version = await flushSaaSCanvas();
          if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error('Cloud version unavailable');
          next = { ...next, supersedesThroughGraphVersion: Number(version), supersedesGraphCanvasId: cloudScope.canvasId };
        } catch {
          if (!observerIsActive()) return;
          setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
          timer = setTimeout(() => void poll(), 2500); return;
        }
      }
      if (!observerIsActive()) return;
      if (journal.current !== observed || JSON.stringify(loadRunJournal()) !== JSON.stringify(observed)) {
        timer = setTimeout(() => void poll(), 2500);
        return;
      }
      if (!canWriteRecovery()) return;
      if (!saveRunJournal(next)) {
        setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
        timer = setTimeout(() => void poll(), 2500); return;
      }
      journal.current = next;
      setRuns(next.nodes);
      setReviewRound(next.review?.round ?? 0);
      setRunStartedAt(next.startedAt);
      if (!next.collaboration && next.scope.length > 1 && !simpleRef.current) setTimelineOpen(true);
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
              ...(next.manual && entry.state === 'done' && !entry.partial
                && next.inputFingerprint === runInputFingerprint(docRef.current, next.scope)
                ? { outputContract: followupDeliveryContract(node, entry.output ?? '') } : {}),
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
        if (next.manual && cloudScope) {
          try { await flushSaaSCanvas(); }
          catch {
            if (!stillCurrent()) return;
            setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
            timer = setTimeout(() => void poll(), 2500); return;
          }
          if (!stillCurrent()) return;
        }
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
  }, [laneList, laneSetters, patchDoc, saveLocalDocument, t, locale, focusNode]);
  // Each recovering lane has its own observer; it stops when the lane settles.
  const laneObservers = useRef(new globalThis.Map<number, () => void>());
  useEffect(() => {
    if (readOnly || outdatedObserver.current) return;
    for (const lane of RUN_LANES) {
      const stop = laneObservers.current.get(lane);
      if (laneRecovering[lane] && !stop) laneObservers.current.set(lane, observeLane(lane));
      else if (!laneRecovering[lane] && stop) { stop(); laneObservers.current.delete(lane); }
    }
  }, [readOnly, laneRecovering, observeLane]);
  useEffect(() => () => { for (const stop of laneObservers.current.values()) stop(); laneObservers.current.clear(); }, []);
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
      lastSavedDocument.current = canonicalCanvasDocumentJSON(document); lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY);
      return document;
    } finally {
      if (setupRequest.current === controller) setupRequest.current = null;
      if (mounted.current) setInitializing(false);
    }
  }, [locale, t, saveLocalDocument, runUnavailableReason]);

  const startRun = useCallback((requestedScope?: ReadonlyArray<string>, manualMessage?: string, onAccepted?: () => void, manualDisplayText?: string, collaboration?: GraphCollaborationPolicy) => {
    if (readOnlyRef.current || outdatedObserver.current) return Promise.resolve();
    if (runUnavailableReason) { setHandoffNote(runUnavailableReason); return Promise.resolve(); }
    // Image, video and 3D nodes generate in a canvas or component run like any other node (graph_media.go on the
    // server), each one generation on today's allowance. A collaboration discusses in text, so it still leaves them
    // out (runScopeWithoutMedia). A whole-canvas run stays one: `whole`.
    const whole = !requestedScope;
    let scope = requestedScope;
    if (!manualMessage && collaboration) {
      const runnable = runScopeWithoutMedia(docRef.current.nodes, requestedScope);
      if (!runnable) { setHandoffNote(surfaceNotice(t, 'media_runs_alone')); return Promise.resolve(); }
      scope = runnable.scope;
    }
    // ---- admission: a free lane whose nodes no running work touches ----
    const executingIds = new Set(scope ?? docRef.current.nodes.map(node => node.id));
    // A whole-canvas run, a review loop and a collaboration run alone; so does anything while one of them runs.
    const alone = whole || Boolean(collaboration) || (!manualMessage && Boolean(docRef.current.execution));
    const activeLanes = RUN_LANES.filter(laneActive);
    if (activeLanes.length && (alone || exclusiveLaneActive())) { setHandoffNote(surfaceNotice(t, 'run_wait_others')); return Promise.resolve(); }
    const busyIds = busyNodeIds(undefined, true);
    if ([...executingIds].some(id => busyIds.has(id))) { setHandoffNote(surfaceNotice(t, 'node_already_running')); return Promise.resolve(); }
    const lane = RUN_LANES.find(candidate => !laneActive(candidate));
    if (lane === undefined) { setHandoffNote(surfaceNotice(t, 'run_lanes_full')); return Promise.resolve(); }
    // Claimed until this start writes its journal or gives up, so a second quick start picks another lane.
    laneList[lane].reserved = executingIds;
    // ---- the run itself, bound to its lane ----
    const journal = laneList[lane].journal;
    const runAbort = laneList[lane].abort;
    const { setRuns: setLaneOwnRuns, setRunning, setRecovering } = laneSetters[lane];
    // A lane that starts takes its nodes' badges from earlier runs in other lanes; its own earlier badges go.
    const setRuns = (value: Record<string, RunView> | ((previous: Record<string, RunView>) => Record<string, RunView>)) => {
      if (typeof value !== 'function' && !Object.keys(value).length) {
        setLaneRuns(previous => previous.map((item, index) => index === lane ? {} : Object.fromEntries(Object.entries(item).filter(([id]) => !executingIds.has(id)))));
        return;
      }
      setLaneOwnRuns(value);
    };
    const updateJournal = updateJournalFor(lane);
    const canvasStorage = () => laneStorage(lane, baseCanvasStorage());
    const loadRunJournal = (from: Pick<Storage, 'getItem'> = laneStorage(lane)) => loadJournal(from);
    const saveRunJournal = (value: CanvasRunJournal, to: Pick<Storage, 'setItem'> = laneStorage(lane)) => saveJournal(value, to);
    const clearRunJournal = (target: Parameters<typeof clearJournal>[0] | string, expected?: string) =>
      typeof target === 'string' ? clearJournal(laneStorage(lane), target) : clearJournal(target, expected);
    const withCanvasRunOwnership = (run: () => Promise<void>, refused: () => void) => withLaneOwnership(lane, run, refused);
    const release = () => { if (laneList[lane].reserved === executingIds) laneList[lane].reserved = null; };
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
    try {
    // Another lane may be preparing its nodes (that rewrites the document through the server): wait for it.
    for (let waited = 0; setupRequest.current && waited < 30_000; waited += 150) await new Promise(resolve => setTimeout(resolve, 150));
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
      lastSavedDocument.current = canonicalCanvasDocumentJSON(persistedCanvas.doc); lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY);
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
    if (hasStreamingConversation(docRef.current.nodes.filter(node => executingIds.has(node.id)))) { setHandoffNote(surfaceNotice(t, 'wait_conversation')); return; }
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
        // Every node this run executes runs its model where AwwO runs that model (nodeRuntime.ts), whatever runtime an
        // older canvas saved: the node is set up again on it as part of this run's preparation. A message typed to a node
        // keeps its conversation where it is.
        const live = paletteRef.current; const here = currentSaaSCanvas();
        const models = live && here && live.tenantId === here.tenant.id && live.canvasId === here.canvasId ? live.models : [];
        const automatic = manualMessage ? docRef.current : withAutomaticRuntimes(docRef.current, scope, models, paletteEfforts(models));
        if (automatic !== docRef.current) { docRef.current = automatic; setDoc(automatic); }
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
    // A component running on its own shows its progress on its card, so the timeline (which would cover the board other
    // components keep working on) opens only for a run of several steps, and never on the chat-first surface.
    if (!collaboration && pending.scope.length > 1 && !simpleRef.current) setTimelineOpen(true);
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
      // One queue for every lane: two nodes bound to one agent take turns even across side-by-side runs.
      agentQueue: agentQueue.current,
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
        }), { silent: true, serverIdentity: true, lane });
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
      const outputContract = manualMessage && outputState === 'final' ? followupDeliveryContract(node, settled.output) : undefined;
      if (operationId) {
        updateConversationPresentation(node, operationId, { issueId: entry?.issueId, runId: entry?.runId,
          outputText: settled.output, outputState, ...(outputContract ? { outputContract } : {}) }, storage);
        const key = sessionStoreKey(node);
        for (const turn of getSessionSnapshot(key).turns) {
          if (turn.role === 'agent' && turn.recoveryOperationId === operationId && turn.text === settled.output) {
            patchPresentation(key, turn.id, { ...turn.presentation, outputState, ...(outputContract ? { outputContract } : {}) });
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
          patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(n => n.id === nodeId ? { ...n, lastOutput: { text: status.output!, at: stamp, source: 'run' as const, ...(status.state !== 'done' ? { partial: true } : {}) } } : n) }), { silent: true, lane });
        }
        setRuns(prev => ({ ...prev, [nodeId]: { ...status, startedAt: prev[nodeId]?.startedAt ?? stamp, ...(status.state !== 'waiting' && status.state !== 'running' ? { endedAt: stamp } : {}) } }));
    };
    const executeManual = async () => {
      const node = runNodes.find(n => executing.has(n.id));
      if (!node || node.kind !== 'session') throw new Error('Conversation node is unavailable');
      onStatus(node.id, { state: 'running' });
      const result = await exec(node, manualMessage!);
      onStatus(node.id, { state: result.unconfirmed ? 'running' : result.ok ? 'done' : result.cancelled ? 'cancelled' : 'failed', output: result.output, detail: result.detail });
      // A page repair the service refused before it ran (today's calls used up, every run slot busy) was no repair: its
      // delivery may go back again later (pageRepair.ts), in this canvas's own storage, where repairPage recorded it.
      const retryAfter = result.refusedCode && isPageRepairMessage(manualMessage) ? pageRepairRetryAfter(result.refusedCode, Date.now()) : null;
      if (retryAfter !== null) deferPageRepair(baseCanvasStorage(), pageRepairMessageKey(node.id, manualMessage), retryAfter);
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
      if (cloud && manualMessage && journal.current && journal.current.supersedesThroughGraphVersion === undefined) {
        try {
          // Flush interim identity/transcript autosaves before choosing the causal boundary.
          // Admission and canvas PUT both lock the cloud document version. Persist the boundary
          // before publishing so a reload after a failed final CAS cannot advance it.
          const version = await flushSaaSCanvas();
          if (!mounted.current || currentSaaSCanvas() !== cloud) return;
          if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error('Cloud version unavailable');
          const publication = { ...journal.current, supersedesThroughGraphVersion: Number(version), supersedesGraphCanvasId: cloud.canvasId };
          if (!saveRunJournal(publication)) throw new Error('Recovery storage unavailable');
          journal.current = publication;
        } catch {
          if (!mounted.current || currentSaaSCanvas() !== cloud) return;
          setHandoffNote(surfaceNotice(t, 'storage_write_failed')); setRecovering(true); return;
        }
      }
      const persistedCanvas = loadDocumentWithStatus();
      let finalSummary = summary;
      if ((reviewPolicy || manualMessage) && journal.current) {
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
      if (cloud && manualMessage) {
        try { await flushSaaSCanvas(); }
        catch {
          if (currentSaaSCanvas() !== cloud) return;
          setHandoffNote(surfaceNotice(t, 'storage_write_failed')); setRecovering(true); return;
        }
        if (currentSaaSCanvas() !== cloud) return;
      }
      clearRunJournal(pending.id); journal.current = null;
      setRunning(false);
      setStopped(finalSummary.cancelled > 0);
      setRunSummary(finalSummary);
    }
    } finally { release(); }
    }, () => { release(); setHandoffNote(surfaceNotice(t, 'execution_owned_elsewhere')); });
  }, [patchDoc, saveLocalDocument, updateJournalFor, prepareNodes, locale, t, runUnavailableReason, laneActive, exclusiveLaneActive, busyNodeIds, laneList, laneSetters]);

  const stopLane = useCallback((lane: number) => {
    if (readOnlyRef.current || outdatedObserver.current) return;
    const journal = laneList[lane].journal;
    const runAbort = laneList[lane].abort;
    const { setRuns } = laneSetters[lane];
    const recovering = laneRecoveringRef.current[lane];
    const loadRunJournal = () => loadJournal(laneStorage(lane));
    const saveRunJournal = (value: CanvasRunJournal) => saveJournal(value, laneStorage(lane));
    const withCanvasRunOwnership = (run: () => Promise<void>, refused: () => void, _locks?: undefined, wait = false) => withLaneOwnership(lane, run, refused, undefined, wait);
    if (!journal.current && !runAbort.current) journal.current = loadRunJournal();
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
  }, [laneList, laneSetters, t]);
  /** Stop: every lane that holds work (the toolbar and the palette). A node stops only its own lane (stopNode). */
  const stopRun = useCallback(() => { for (const lane of RUN_LANES) if (laneActive(lane)) stopLane(lane); }, [laneActive, stopLane]);
  const stopNode = useCallback((nodeId: string) => { const lane = laneOfNode(nodeId); if (lane !== undefined) stopLane(lane); }, [laneOfNode, stopLane]);

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
      // With lanes, only the nodes a run executes are recovering; every other node keeps its preview.
      if (laneGuard.current.busy().has(nodeId)) return;
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
    [patchDoc],
  );

  const persistDraft = useCallback((nodeId: string, threadId: string, draft: string) => {
    // Once a node's own run executes, its draft belongs to that run's acceptance (as with the single run before lanes);
    // a draft typed while the run still waits for ownership is kept, and every other node's draft saves while others run.
    const executing = RUN_LANES.some(lane => laneList[lane].abort.current && laneList[lane].journal.current?.scope.includes(nodeId));
    if (readOnlyRef.current || inspectorCloseLocked.current || executing) return;
    patchDoc(prev => {
      const target = prev.nodes.find(node => node.id === nodeId);
      if (!target || target.kind !== 'session') return prev;
      const next = updateNodeDraft(target, draft, threadId);
      return next === target ? prev : { ...prev, nodes: prev.nodes.map(node => node.id === nodeId ? next : node) };
    }, { silent: true });
  }, [patchDoc, laneList]);

  const toggleDeliverables = useCallback((nodeId: string, open: boolean) => {
    if (!canEditStructure(false, [])) return;
    const target = docRef.current.nodes.find(node => node.id === nodeId);
    if (!target || target.kind !== 'session' || Boolean(target.deliverablesOpen) === open || hasStreamingConversation([target])) return;
    patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(node => {
      if (node.id !== nodeId || node.kind !== 'session') return node;
      const w = Math.max(220, node.w + (open ? 260 : -260));
      return { ...node, deliverablesOpen: open, w, x: node.x - (w - node.w) / 2 };
    }) }), { silent: true });
    requestAnimationFrame(() => focusNodeRef.current(nodeId));
  }, [canEditStructure, patchDoc]);

  // ---- 预览展示 windows (displayNodes.ts) ---------------------------------------------------------
  // Each change is an ordinary document edit (an undo step, a cloud save) beside the graph. It touches no node, so a
  // display moves, resizes and switches what it shows while components run, and no run ever sees it.
  const renderNodesRef = useRef(renderNodes);
  renderNodesRef.current = renderNodes;
  const patchDisplays = useCallback((label: string, update: (list: ReadonlyArray<DisplayNode>) => ReadonlyArray<DisplayNode>) => {
    patchDoc(prev => {
      const current = prev.displays ?? NO_DISPLAYS;
      const next = update(current);
      if (next === current) return prev;
      const { displays: _displays, ...rest } = prev;
      return next.length ? { ...rest, displays: [...next] } : rest;
    }, { label });
  }, [patchDoc]);
  const selectDisplay = useCallback((id: string) => {
    setSelection(previous => previous.length ? [] : previous);
    setSelectedEdgeId(null);
    setSelectedDisplayId(id);
  }, []);
  const addDisplay = useCallback((world: { x: number; y: number }, source: DisplaySource = { type: 'canvas' }): DisplayNode | null => {
    if (readOnlyRef.current) return null;
    if ((docRef.current.displays?.length ?? 0) >= MAX_DISPLAYS) {
      setHandoffNote(displayText(locale, 'display.tooMany', { count: MAX_DISPLAYS }));
      return null;
    }
    const display = createDisplayNode(world, source);
    patchDisplays(`display-add:${display.id}`, list => [...list, display]);
    // A review loop or a collaboration holds the whole canvas; then nothing was added.
    if (!docRef.current.displays?.some(item => item.id === display.id)) return null;
    selectDisplay(display.id);
    return display;
  }, [locale, patchDisplays, selectDisplay]);
  const moveDisplay = useCallback((id: string, x: number, y: number) => patchDisplays(`display-move:${id}`, list =>
    list.some(item => item.id === id && (item.x !== x || item.y !== y)) ? list.map(item => item.id === id ? { ...item, x, y } : item) : list), [patchDisplays]);
  const resizeDisplay = useCallback((id: string, w: number, h: number) => {
    const size = clampDisplaySize(w, h);
    patchDisplays(`display-resize:${id}`, list => list.some(item => item.id === id && (item.w !== size.w || item.h !== size.h))
      ? list.map(item => item.id === id ? { ...item, ...size } : item) : list);
  }, [patchDisplays]);
  const changeDisplaySource = useCallback((id: string, source: DisplaySource) => patchDisplays(`display-source:${id}`, list =>
    list.some(item => item.id === id && !sameDisplaySource(item.source, source)) ? list.map(item => item.id === id ? { ...item, source } : item) : list), [patchDisplays]);
  const deleteDisplay = useCallback((id: string) => {
    patchDisplays(`display-delete:${id}`, list => list.some(item => item.id === id) ? list.filter(item => item.id !== id) : list);
    setSelectedDisplayId(previous => previous === id ? null : previous);
  }, [patchDisplays]);
  /** Bring a display into view when it is not: centred, at a zoom where it fits (never closer than the camera now). */
  const revealDisplay = useCallback((display: DisplayNode) => {
    const box = viewportSize();
    if (!box) return;
    const current = glideTarget.current ?? viewRef.current;
    if (boundsWithinViewport(displayBounds(display), current, box)) return;
    const fits = Math.min((box.w - 96) / Math.max(1, display.w), (box.h - 140) / Math.max(1, display.h));
    const scale = Math.max(0.06, Math.min(current.scale, fits));
    moveCamera(focusWorld({ ...current, scale }, display.x + display.w / 2, display.y + display.h / 2, box));
  }, [viewportSize, moveCamera]);
  /** The view tools' 预览展示: everything the canvas made, live, at the end of the board (the one already there, if any). */
  const showCanvasDisplay = useCallback(() => {
    const existing = docRef.current.displays?.find(item => item.source.type === 'canvas');
    if (existing) { selectDisplay(existing.id); revealDisplay(existing); return; }
    const added = addDisplay(placeDisplayAfter([...renderNodesRef.current, ...(docRef.current.displays ?? NO_DISPLAYS)]));
    if (added) fitAll();
  }, [selectDisplay, revealDisplay, addDisplay, fitAll]);
  /** A card's 在预览展示中查看: the display already showing that component, or a new one beside it. */
  const showNodeInDisplay = useCallback((nodeId: string) => {
    const existing = docRef.current.displays?.find(item => item.source.type === 'node' && item.source.nodeId === nodeId);
    if (existing) { selectDisplay(existing.id); revealDisplay(existing); return; }
    const card = renderNodesRef.current.find(node => node.id === nodeId);
    if (!card) return;
    const added = addDisplay(placeDisplayBeside(card, [...renderNodesRef.current, ...(docRef.current.displays ?? NO_DISPLAYS)]), { type: 'node', nodeId });
    if (added) revealDisplay(added);
  }, [selectDisplay, revealDisplay, addDisplay]);

  const addNode = useCallback(
    (kind: AddNodeKind, world: { x: number; y: number }) => {
      if (kind === 'display') { addDisplay(world); return; }
      if (!canEditStructure(false, [])) return;
      const media = canInitialize ? mediaKindOf(kind) : null;
      // A cloud image or video node is a plain generator: no role template, delivery format or
      // team. The first catalog model is shown, and runs only once the operator saves it.
      const node = kind === 'form' ? createFormNode(world)
        : media ? { ...createSessionNode(media, world), title: t(media === 'video' ? 'node.video' : media === 'model3d' ? 'node.model3d' : 'node.image'),
          model: mediaModelsOf(mediaCatalogueOf(mediaState), media)[0]?.id ?? '' }
        : kind === 'llm' || kind === 'coding' || kind === 'image' || kind === 'video' || kind === 'model3d'
          ? { ...createAgentTemplate('general', world, locale), agentKind: kind }
          : createAgentTemplate(kind, world, locale);
      patchDoc((prev) => ({ ...prev, nodes: [...prev.nodes, node] }), { label: `add:${node.id}` });
      setSelection([node.id]);
      focusNode(node.id, { configure: true });
      setInspectorId(node.id);
      return node;
    },
    [patchDoc, focusNode, locale, canEditStructure, canInitialize, mediaState, t, addDisplay],
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
      if (!canEditStructure(false, [])) return;
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
      if (!canEditStructure(false, [])) return;
      patchDoc((prev) => ({ ...prev, nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, w, h } : n)) }), {
        label: `resize:${nodeId}`,
      });
    },
    [canEditStructure, patchDoc],
  );

  const deleteNodes = useCallback(
    (ids: ReadonlyArray<string>) => {
      if (!canEditStructure(false, ids)) return;
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
      if (!canEditStructure(allowBindingSave, [next.id])) return;
      const current = docRef.current.nodes.find(n => n.id === next.id);
      if (current?.kind === 'session' && next.kind === 'session' &&
        activeThreadId(current) !== activeThreadId(next) && hasStreamingConversation([current])) return;
      const published = next.lastOutput?.source === 'manual' && next.lastOutput !== current?.lastOutput;
      if (published) {
        const errors = validateNodeOutput(next, next.lastOutput!.text);
        if (errors.length) { setHandoffNote(errors.join('；')); return; }
      }
      patchDoc(prev => {
        const nodes = prev.nodes.map(n => n.id === next.id ? { ...next, x: n.x, y: n.y, w: n.w, h: n.h } : n);
        // A field deleted or retyped here takes its wires with it, as the board already shows: a wire left in the
        // document is not drawn, cannot be disconnected, and would make every later plan fail.
        return { ...prev, nodes, edges: reconcileEdges(nodes, prev.edges) };
      }, { label: `config:${next.id}` });
      if (current?.kind === 'session' && next.kind === 'session' && (JSON.stringify(current.team) !== JSON.stringify(next.team)
        || JSON.stringify(current.taskFrame) !== JSON.stringify(next.taskFrame))) {
        const affected = new Set(downstreamClosure([next.id]));
        setAllRuns(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !affected.has(id))));
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
    if (!live || !canEditStructure(true, [draft.id])) return;
    if (live.kind === 'session' && draft.kind === 'session') {
      const bindingChanged = live.binding?.companyId !== draft.binding?.companyId || live.binding?.agentId !== draft.binding?.agentId;
      const configChanged = !bindingChanged && boundAgentConfigurationChanged(live, draft);
      // Runtime/model/effort/persona are materialized on the native Agent when it is hired. Keep
      // the old bound Session intact and open an unbound Session for the changed configuration;
      // silently editing only the canvas would make later runs execute different settings than
      // the UI promises.
      const rebound = bindingChanged ? rebindNodeThread(live, draft.binding)
        : configChanged ? rebindNodeThread(live, null) : { ...live, threads: getNodeThreads(live) };
      saveNode(inspectorSavedNode(rebound, draft, live, { binding: bindingChanged, config: configChanged }), true);
      if (configChanged) setHandoffNote(surfaceNotice(t, 'config_forked'));
    } else if (live.kind === 'form' && draft.kind === 'form') {
      saveNode({ ...live, title: draft.title, fields: draft.fields });
    }
  }, [canEditStructure, saveNode]);
  const initializeInspector = useCallback(async (draft: SessionNode) => {
    let completed = false;
    // Any free lane's lock: preparing one node never waits for another node's chat or task.
    const lane = RUN_LANES.find(candidate => !laneGuardLaneActive.current(candidate)) ?? 0;
    await withLaneOwnership(lane, async () => {
      if (readOnlyRef.current || setupRequest.current || laneGuard.current.exclusive() || laneGuard.current.busy().has(draft.id)) throw new Error(locale === 'zh' ? '请等待当前任务结束后再保存配置。' : 'Wait for the current task before saving configuration.');
      saveInspector(draft);
      await prepareNodes([draft.id]);
      completed = true;
    }, () => { throw new Error(surfaceNotice(t, 'execution_owned_elsewhere')); });
    if (!completed) throw new Error(locale === 'zh' ? '配置尚未保存，请重试。' : 'Configuration was not saved. Please try again.');
  }, [saveInspector, prepareNodes, locale, t]);

  const onConnect = useCallback(
    (from: PortRef, to: PortRef, dataType: DataType) => {
      if (!canEditStructure(false, [from.nodeId, to.nodeId])) return;
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
      if (!canEditStructure(false, [edge.fromNode, edge.toNode])) return;
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
      const lane = laneOfNode(node.id);
      if (currentGraphRunEntry(node, lane === undefined ? null : laneJournal(lane))) return null;
      return turn.runId ? (
        <TeamRunDetails key={turn.runId} tenantId={cloudScope!.tenant.id} runId={turn.runId} defaultOpen={latest}
          runStatus={latest ? runs[node.id]?.state : undefined} />
      ) : null;
    },
    [cloudScope, runs, laneOfNode, laneJournal],
  );
  const tileCurrentRunDetails = useCallback((node: CanvasNode) => {
    const lane = laneOfNode(node.id);
    const active = lane === undefined ? null : laneJournal(lane);
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
  }, [cloudScope, runs, running, locale, laneOfNode, laneJournal]);
  const tileOnSend = useCallback(
    (node: CanvasNode, message: string, onAccepted?: () => void, displayText?: string) => { void startRun([node.id], message, onAccepted, displayText); },
    [startRun],
  );
  // A delivered page that fails when it runs goes back to its node once, with the error, as a message in the node's
  // own chat (pageRepair.ts); so does a figure that never moves, once of its own. Nothing starts while a run is active:
  // the request waits here and starts once the canvas is idle, unless the node has delivered something else by then.
  const waitingRepairs = useRef(new globalThis.Map<string, PageErrorReport>());
  const repairPage = useCallback((report: PageErrorReport) => {
    if (readOnlyRef.current || outdatedObserver.current || runUnavailableReason) return;
    const target = pageRepairTarget(docRef.current.nodes, report.page);
    if (!target) return;
    const storage = canvasStorage();
    const key = pageRepairRecordKey(target.node.id, report.kind);
    if (pageRepairDecision(loadPageRepairRecords(storage)[key], target.output) !== 'repair') return;
    if (anyLaneActive() || setupRequest.current || busyNodeIds(undefined, true).has(target.node.id)) {
      waitingRepairs.current.set(key, report);
      return;
    }
    waitingRepairs.current.delete(key);
    // Recorded before the start: every other view of this page, and every other tab of this canvas, leaves it alone.
    if (!savePageRepairRecord(storage, key, { from: target.output.at, at: Date.now() })) return;
    void startRun([target.node.id], pageRepairMessage(target, report), undefined, pageRepairDisplayText(report, locale));
  }, [startRun, anyLaneActive, busyNodeIds, runUnavailableReason, locale]);
  useEffect(() => subscribePageErrors(repairPage), [repairPage]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!waitingRepairs.current.size) return;
      const waiting = [...waitingRepairs.current.values()];
      waitingRepairs.current.clear();
      // The first one starts; the others wait again behind it.
      for (const report of waiting) repairPage(report);
    }, 3000);
    return () => clearInterval(timer);
  }, [repairPage]);
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
  // Cards resized on the board (a view preference: allowed while running and for readers; never an undo step).
  const resizeCard = useCallback((nodeId: string, w: number, h: number) => {
    setCardFrames(previous => ({ ...previous, [nodeId]: clampCard(w, h) }));
  }, []);
  const toggleCardPreview = useCallback((nodeId: string) => {
    setCardFrames(previous => {
      if (showsPreview(previous[nodeId])) { const { [nodeId]: _shrunk, ...rest } = previous; return rest; }
      return { ...previous, [nodeId]: clampCard(CARD_PREVIEW_DEFAULT.w, CARD_PREVIEW_DEFAULT.h) };
    });
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => saveCardFrames(cardFrames, new Set(docRef.current.nodes.map(node => node.id))), 300);
    return () => clearTimeout(timer);
  }, [cardFrames]);
  // The results studio (成果工作台), over the board: one node's deliverables or the whole canvas's.
  const [studio, setStudio] = useState<{ nodeId?: string; entryId?: string } | null>(null);
  const openStudio = useCallback((nodeId?: string, entryId?: string) => setStudio({ nodeId, entryId }), []);
  // Every file the canvas made, for previews that show what another node generated. Keyed on outputs only, so a
  // moved card does not hand every card a new array (cards are memoised).
  const outputsKey = nodes.map(node => node.kind === 'session'
    ? `${node.id}\u0001${node.title}\u0001${node.lastOutput?.at ?? ''}\u0001${node.lastOutput?.text.length ?? 0}` : node.id).join('\u0002');
  const canvasEntries = useMemo(() => studioGroups({ nodes: docRef.current.nodes, edges: docRef.current.edges }).flatMap(group => group.entries), [outputsKey]);
  // What the 预览展示 windows read, keyed so a moved card hands them nothing new (they are memoised and run pages).
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const edgesKey = edges.map(edge => `${edge.id}\u0001${edge.kind ?? ''}`).join('\u0002');
  const executionKey = doc.execution ? JSON.stringify(doc.execution) : '';
  const displayGroups = useMemo(() => studioGroups({ nodes: docRef.current.nodes, edges: edgesRef.current, execution: docRef.current.execution }),
    [outputsKey, edgesKey, executionKey]);
  const choicesKey = nodes.map(node => node.kind === 'session' ? `${node.id}\u0001${node.title}` : '').join('\u0002');
  const displayChoices = useMemo<DisplayChoice[]>(() => {
    const depths = nodeDepths(docRef.current.nodes, edgesRef.current.filter(edge => edge.kind !== 'feedback'));
    return docRef.current.nodes.flatMap((node, index) => node.kind === 'session' ? [{ id: node.id, title: node.title.trim() || node.id, depth: depths.get(node.id) ?? 0, index }] : [])
      .sort((a, b) => a.depth - b.depth || a.index - b.index).map(({ id, title }) => ({ id, title }));
  }, [choicesKey, edgesKey]);
  const runningKey = [...new Set([...busyNow, ...Object.entries(runs).filter(([, run]) => run.state === 'running').map(([id]) => id)])].sort().join('\u0001');
  const runningIds = useMemo<ReadonlySet<string>>(() => new Set(runningKey ? runningKey.split('\u0001') : []), [runningKey]);
  const visibleDisplayIds = useMemo(() => {
    const ids = new Set(visibleBoxIds(displays, view, size));
    if (selectedDisplayId) ids.add(selectedDisplayId);
    return ids;
  }, [displays, view, size, selectedDisplayId]);
  const [addMenu, setAddMenu] = useState<{ at: { x: number; y: number }; world: { x: number; y: number } } | null>(null);
  const [barMode, setBarMode] = useState<CommandBarMode | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [selectionTool, setSelectionTool] = useState(false);

  const { companies, refresh: refreshCompanies } = useLiveCompanies(paperclipApiBase());

  // Wiring is a STRUCTURAL edit and locks with the rest of them during a run. A run executes a
  // SNAPSHOT of the graph, so a wire cut mid-run would not change what is executing — the user
  // would be shown a graph that no longer matches the timeline describing the run. Omitting
  // onConnect leaves the ports visible but inert (they are the graph's structure, not a control).
  const wiring = useWiring({ nodes: renderNodes, edges, onConnect: readOnly || exclusiveNow || initializing || simple ? undefined : onConnect, rootRef, view });
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
    onDeleteSelection: readOnly || running || initializing ? undefined : () => {
      // A selected display (never selected together with nodes) goes the way a selected node does.
      if (!selection.length && selectedDisplayRef.current) deleteDisplay(selectedDisplayRef.current);
      else deleteNodes(selection);
    },
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

  const canEdit = !exclusiveNow && canEditStructure(false, []);
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
    if (!canEditStructure(false, [])) return;
    const v = viewRef.current;
    const s = sizeRef.current;
    const node = createWorkspaceAgentNode(agent, { x: (-v.x + s.w / 2) / (v.scale || 1) - 170, y: (-v.y + s.h / 2) / (v.scale || 1) - 130 }, locale);
    patchDoc(previous => ({ ...previous, nodes: [...previous.nodes, node] }), { label: `add:${node.id}` });
    // The node opens focused, not configured: the inspector stays reachable from the tile menu.
    setSelection([node.id]); focusNode(node.id);
  }, [canEditStructure, patchDoc, focusNode, locale]);
  const addMarketAgent = useCallback((agent: TeamMarketAgent) => {
    if (!canEditStructure(false, [])) return;
    const v = viewRef.current;
    const s = sizeRef.current;
    const node = createMarketplaceRoleNode(agent, { x: (-v.x + s.w / 2) / (v.scale || 1) - 170, y: (-v.y + s.h / 2) / (v.scale || 1) - 130 }, locale);
    patchDoc(previous => ({ ...previous, nodes: [...previous.nodes, node] }), { label: `add:${node.id}` });
    setSelection([node.id]); focusNode(node.id);
  }, [canEditStructure, patchDoc, focusNode, locale]);
  const createTemplate = useCallback(() => {
    if (!canEditStructure(false, [])) return;
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
  // Simple mode is chat-first: on a desktop stage the assistant's conversation is open beside the canvas from the start.
  const [assistantOpen, setAssistantOpen] = useState(() => simple && !readOnly && isDesktopStage());
  const [planningBusy, setPlanningBusy] = useState(false);
  // The assistant's canvas changes on the operator's model are outside today's calls up to a daily number (the server's
  // route usage says how many are left); read again whenever a plan settles, so the composer's note stays true.
  const [plannerAllowance, setPlannerAllowance] = useState<RouteAllowance | null>(null);
  const cloudTenantId = cloudScope?.tenant.id;
  useEffect(() => {
    if (!cloudTenantId || planningBusy) return;
    const controller = new AbortController();
    fetchRouteUsage(cloudTenantId, controller.signal)
      .then(usage => { if (!controller.signal.aborted) setPlannerAllowance(usage.planner ?? null); })
      .catch(() => { /* The note then keeps its general wording. */ });
    return () => controller.abort();
  }, [cloudTenantId, planningBusy]);
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
    if (laneGuard.current.active() || inspectorCloseLocked.current || hasStreamingConversation(docRef.current.nodes)) {
      return surfaceNotice(t, 'planning_busy');
    }
    return null;
  };
  // `request` plans a prompt handed over (a carried-over request, a routed message) rather than the box's draft;
  // the box is emptied only where it holds that prompt.
  // The chat models a plan may put a node on: this canvas's palette, each entry with its name and effort levels.
  const planningModelChoices = (): Array<CanvasPlanModelChoice & { requiresUpgrade?: boolean }> => {
    const live = paletteRef.current; const here = currentSaaSCanvas();
    if (!live || !here || live.tenantId !== here.tenant.id || live.canvasId !== here.canvasId) return [];
    return live.models.map(entry => ({ runtime: entry.runtime, model: entry.model, available: entry.available, name: entry.displayName || entry.label,
      ...(entry.efforts ? { efforts: entry.efforts } : {}), ...(entry.requiresUpgrade ? { requiresUpgrade: true } : {}) }));
  };
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
      // The planner sees the models a node can run (each once, where AwwO runs it) and how each node's last run ended,
      // so it can change a node's model and act on a failure the reader asks it to fix.
      const planModels = planningModelChoices();
      const planRuns = Object.fromEntries(Object.entries(runs).map(([id, run]) => [id,
        { state: run.state, ...(run.detail ? { detail: recoveryDetailMessage(t, run.detail) || run.detail } : {}) }]));
      const jev = !resume && plannerProvider === 'jev'
        ? await requestJevPlan(prompt, snapshot, planningTurns(planning.messages), controller.signal, locale, reportProgress) : null;
      const plan = jev?.plan ?? await planRequest(prompt, snapshot, planningTurns(planning.messages), controller.signal, locale, reportProgress,
        { ...(resume ? { recoveryOperationId: planningRecovery!.operationId } : {}), mediaKinds,
          models: automaticEntries(planModels).filter(entry => entry.available).map(entry => ({ id: entry.model, name: entry.name || entry.model,
            ...(entry.efforts?.length ? { efforts: entry.efforts } : {}), ...(entry.requiresUpgrade ? { paid: true } : {}) })),
          runs: planRuns });
      if (readOnlyRef.current || controller.signal.aborted || planningRequest.current?.id !== id) return;
      if (canvasPlanRevision(docRef.current) !== revision || laneGuard.current.active() || inspectorCloseLocked.current || hasStreamingConversation(docRef.current.nodes)) {
        appendPlanningMessage(`${id}-assistant`, surfaceNotice(t, 'plan_stale'), 'stale', route);
        setPlanning(previous => ({ ...previous, draft: previous.draft || prompt }));
        return;
      }
      const before = docRef.current;
      const planned = jev ? applyJevPlan(before, jev, locale, prompt) : applyCanvasPlan(before, plan, locale, prompt, planMedia, { choices: planModels });
      // The components a plan adds start on the model the reader chose for the canvas assistant (Jev picks its own).
      const applied = jev ? planned : { ...planned, doc: withAssistantModel(planned.doc, planned.addedNodeIds, assistantExecution?.componentModel, paletteRef.current?.models ?? []) };
      // Every step skipped (each one said in the adjustments) leaves the canvas as it was: nothing to patch, undo
      // or select, and the reply says so instead of calling it applied.
      const changed = canvasPlanRevision(applied.doc) !== canvasPlanRevision(before);
      if (changed) {
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
      // What was applied differently from how the plan wrote it is said with its summary, never hidden.
      const shownAdjustments = applied.adjustments.slice(0, 6);
      // Media nodes a plan added: said once, so the user knows a canvas run generates them and Send makes one alone.
      const addedMedia = changed ? applied.doc.nodes.filter(node => applied.addedNodeIds.includes(node.id) && node.kind === 'session' && mediaKindOf(node.agentKind)).length : 0;
      // What the canvas now holds, node by node, under the model's own summary of what it meant to do.
      const modelName = (id: string) => planModels.find(entry => entry.model === id)?.name || id;
      const changes = changed ? describePlanChanges(before, applied.doc, locale, t, modelName) : [];
      const lead = [...(!changed && plan.operations.length ? [applied.summary, t('planning.nothingApplied')] : [applied.summary]),
        ...(addedMedia ? [t('planning.mediaAdded', { count: addedMedia })] : []),
        ...(changes.length ? [t('planning.changesHeader'), ...changes.map(line => `· ${line}`)] : [])];
      const reply = applied.adjustments.length ? [...lead, ...(changed ? [t('planning.adjusted', { count: applied.adjustments.length })] : []),
        ...shownAdjustments.map(item => `· ${item}`),
        ...(applied.adjustments.length > shownAdjustments.length ? [t('planning.adjustedMore', { count: applied.adjustments.length - shownAdjustments.length })] : [])].join('\n')
        : lead.join('\n');
      appendPlanningMessage(`${id}-assistant`, reply, changed ? 'applied' : undefined, route,
        changed && applied.addedNodeIds.length <= 200 && onlyAddedNodes(before, applied.doc, applied.addedNodeIds)
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
    // A question about what the canvas still needs is answered here, from the canvas, before it could cost a call; so
    // is a message about the last run's failure, which only the canvas can see.
    if (!readOnlyRef.current && !pendingRef.current && !planningRequest.current
      && (answerLocally(planning.draft.trim()) || repairLocally(planning.draft.trim()) || runLocally(planning.draft.trim()))) return;
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
  // What to do next, offered by the assistant unasked: worked out from the canvas and the latest run, and carried out
  // here with the same controls the canvas already has (the run button, a node's settings, the results view).
  const suggested: NextSteps | null = readOnly || initializing || bindingLocked ? null : canvasNextSteps({
    nodes, edges, runs, running, canRun: !runUnavailableReason, resultsAvailable: Boolean(results), upgradeAvailable: Boolean(cloudScope),
    // A refusal's text is the run error's own copy (canvasErrors), in whichever language the run was read in.
    isPremiumRefusal: detail => PREMIUM_REFUSALS.some(text => detail.includes(text)),
    isQuotaRefusal: detail => QUOTA_REFUSALS.some(text => detail.includes(text)),
    // Only the hosted workspace puts a node's task requirements into its prompt, which is how a rework carries the
    // review's findings.
    reworkAvailable: Boolean(cloudScope),
    // The assistant can be asked to fix a failure or fill in inputs only while it can plan.
    canPlan: !planningUnavailableReason && plannerProvider !== 'jev' && plannerStatus?.available !== false,
  });
  // Only the hosted app counts calls, so only it says what a step costs (and that this advice cost none).
  const countsCalls = Boolean(cloudScope);
  const withCalls = (label: string, calls: number) => countsCalls ? t('assistant.nextWithCalls', { label, calls }) : label;
  const listSeparator = locale === 'zh' ? '、' : ', ';
  const titleOf = (id: string) => nodes.find(node => node.id === id)?.title ?? '';
  const configureNode = (id: string) => { if (!inspectorCloseLocked.current) { focusNode(id, { configure: true }); setInspectorId(id); } };
  // Opens a node on its input drawer, in either mode: where a run's missing inputs are filled in.
  const openNodeInputs = (id: string) => {
    if (inspectorCloseLocked.current) return;
    setInputRequests(previous => ({ ...previous, [id]: (previous[id] ?? 0) + 1 }));
    focusNode(id);
  };
  // A step the assistant takes from the conversation, said as the reader's own message so the turn reads as asked.
  const askAssistant = (prompt: string) => { setAssistantOpen(true); void sendPlanningMessage(prompt); };
  const fixRequest = (ids: ReadonlyArray<string>) => {
    const failedNodes = ids.map(titleOf).filter(Boolean);
    const detail = recoveryDetailMessage(t, runs[ids[0]]?.detail)?.trim();
    return t('assistant.fixRequest', { nodes: failedNodes.map(name => locale === 'zh' ? `「${name}」` : `“${name}”`).join(listSeparator),
      reason: detail || t('assistant.repairNoReason') });
  };
  const fillRequest = (ids: ReadonlyArray<string>) => {
    const rows = fillSteps.filter(step => ids.includes(step.nodeId))
      .map(step => t('assistant.fillRequestRow', { node: titleOf(step.nodeId), fields: step.fields.join(listSeparator) }));
    return t('assistant.fillRequest', { rows: rows.join(locale === 'zh' ? '；' : '; ') });
  };
  // A review that found the delivery wanting is acted on in one click: its findings become one of the reviewed Agent's
  // task requirements (shown, and editable, in that node's settings), then the Agent and everything it feeds run
  // again, the review included. A later rework from the same review replaces that requirement instead of adding one.
  const reworkFromReview = (producerId: string, reviewerId: string) => {
    if (!canEditStructure()) return;
    const current = docRef.current;
    const producer = current.nodes.find((node): node is SessionNode => node.id === producerId && node.kind === 'session');
    const reviewer = current.nodes.find((node): node is SessionNode => node.id === reviewerId && node.kind === 'session');
    const verdict = reviewer ? reviewVerdict(reviewer) : null;
    if (!producer || !reviewer || !verdict || verdict.approved) return;
    const frame = reworkRequirements(producer.taskFrame, t('assistant.reworkMarker', { node: reviewer.title }),
      t('assistant.reworkHeader', { verdict: verdict.verdict || t('assistant.nextVerdictRejected') }), verdict.findings);
    if (!frame) { setHandoffNote(t('assistant.reworkNoRoom', { node: producer.title })); configureNode(producerId); return; }
    patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(node => node.id === producerId && node.kind === 'session' ? { ...node, taskFrame: frame } : node) }),
      { label: 'rework' });
    void startRun(downstreamClosure([producerId]));
  };
  // The hosted app counts a few presses for the operator, to see which of these buttons people use; the desktop shell
  // has no one to tell.
  const countPress = (name: CanvasUiEvent) => { if (cloudScope) recordCanvasEvent(cloudScope.tenant.id, cloudScope.canvasId, name); };
  const nextAction = (step: NextStep, primary: boolean): AssistantNextSteps['actions'][number] => {
    switch (step.kind) {
      case 'upgrade': return { id: 'upgrade', primary, label: t('assistant.nextUpgrade'), href: accountURL('plans'),
        onSelect: () => { if (cloudScope) void recordUpgradeInterest(cloudScope.tenant.id).catch(() => {}); } };
      case 'switch-model': return { id: `switch-${step.nodeId}`, primary, label: t('assistant.nextSwitchModel'), onSelect: () => configureNode(step.nodeId) };
      case 'open-failed': return { id: `open-${step.nodeId}`, primary, label: t('assistant.nextOpenFailed'), onSelect: () => focusNode(step.nodeId) };
      case 'rerun-failed': return { id: 'rerun-failed', primary, label: t('assistant.nextRerunFailed'), onSelect: () => void startRun(downstreamClosure(step.nodeIds)) };
      // The inputs are filled in where they are: the node opens on its input drawer (Configure has no input fields).
      case 'fill-inputs': return { id: `fill-${step.nodeId}`, primary, label: t('assistant.nextFillShort'), ariaLabel: t('assistant.nextFill', { node: titleOf(step.nodeId) }),
        onSelect: () => openNodeInputs(step.nodeId) };
      case 'assistant-fix': return { id: 'assistant-fix', primary, label: t('assistant.nextAssistantFix'), onSelect: () => askAssistant(fixRequest(step.nodeIds)) };
      case 'assistant-fill': return { id: 'assistant-fill', primary, label: t('assistant.nextAssistantFill'), onSelect: () => askAssistant(fillRequest(step.nodeIds)) };
      case 'run-all': return { id: 'run-all', primary, label: withCalls(t('assistant.nextRunAll'), step.calls), onSelect: () => void startRun() };
      // One node, alone: an out-of-scope upstream would contribute what it produced earlier, and a first node has none.
      case 'try-first': return { id: `try-${step.nodeId}`, primary, label: withCalls(t('assistant.nextTryFirst', { node: titleOf(step.nodeId) }), step.calls),
        onSelect: () => void startRun([step.nodeId]) };
      case 'run-rest': return { id: 'run-rest', primary, label: withCalls(t('assistant.nextRunRest', { count: step.nodeIds.length }), step.calls),
        onSelect: () => void startRun(downstreamClosure(step.nodeIds)) };
      case 'rework': return { id: `rework-${step.nodeId}`, primary, label: withCalls(t('assistant.nextRework', { node: titleOf(step.nodeId) }), step.calls),
        onSelect: () => reworkFromReview(step.nodeId, step.reviewerId) };
      case 'open-review': return { id: `review-${step.nodeId}`, primary, label: t('assistant.nextOpenReview'),
        onSelect: () => { toggleDeliverables(step.nodeId, true); focusNode(step.nodeId); setTimelineOpen(false); countPress('review.open_report'); } };
      case 'results': return { id: 'results', primary, label: t('assistant.nextResults'), onSelect: () => changeStageView('results') };
    }
  };
  const nextLead = (situation: NextSteps['situation'], tryFirst: boolean): string => {
    switch (situation.kind) {
      case 'quota': return t('assistant.nextLeadQuota', { node: situation.nodeTitle });
      case 'premium': return t('assistant.nextLeadPremium', { node: situation.nodeTitle });
      case 'failed': return situation.count > 1 ? t('assistant.nextLeadFailedMany', { node: situation.nodeTitle, count: situation.count })
        : t('assistant.nextLeadFailed', { node: situation.nodeTitle });
      case 'inputs': return t('assistant.nextLeadInputs', { count: situation.fields });
      case 'rejected': {
        const verdict = situation.verdict || t('assistant.nextVerdictRejected');
        return situation.reason ? t('assistant.nextLeadRejected', { node: situation.nodeTitle, verdict, reason: situation.reason })
          : t('assistant.nextLeadRejectedBare', { node: situation.nodeTitle, verdict });
      }
      case 'fresh': return t(tryFirst ? 'assistant.nextLeadFreshTry' : 'assistant.nextLeadFresh');
      case 'partial': return t('assistant.nextLeadPartial', { count: situation.count });
      case 'complete': return situation.approvedBy ? t('assistant.nextLeadCompleteApproved', { node: situation.approvedBy }) : t('assistant.nextLeadComplete');
    }
  };
  const fillSteps = suggested?.steps.flatMap(step => step.kind === 'fill-inputs' ? [step] : []) ?? [];
  const assistantNextSteps: AssistantNextSteps | undefined = suggested ? {
    lead: nextLead(suggested.situation, suggested.steps.some(step => step.kind === 'try-first')),
    // What a run still needs is a checklist with a step per node (and the assistant to fill it all in); every other
    // situation is a few buttons.
    actions: suggested.situation.kind === 'inputs' ? suggested.steps.filter(step => step.kind !== 'fill-inputs').map(step => nextAction(step, false))
      : suggested.steps.map((step, index) => nextAction(step, index === 0)),
    ...(fillSteps.length ? {
      items: fillSteps.map((step, index) => ({ id: step.nodeId, title: t('assistant.nextItemNode', { node: titleOf(step.nodeId) }),
        detail: step.fields.join(listSeparator), action: nextAction(step, index === 0) })),
      footnote: suggested.situation.kind === 'inputs' && countsCalls
        ? t('assistant.nextAfterInputsCalls', { calls: suggested.situation.calls }) : t('assistant.nextAfterInputs'),
    } : {}),
    ...(countsCalls ? { note: t('assistant.nextFree') } : {}),
  } : undefined;
  // A problem the assistant can help with marks its closed toggle; a canvas that merely has not run does not.
  const assistantHint = Boolean(suggested && ['quota', 'premium', 'failed', 'rejected', 'inputs'].includes(suggested.situation.kind));
  // The run's own summary says "7/7 succeeded"; when a review found the delivery wanting it says that too.
  const situation = suggested?.situation;
  const reviewNote = situation?.kind === 'rejected'
    ? t('run.reviewRejected', { node: situation.nodeTitle, verdict: situation.verdict || t('assistant.nextVerdictRejected') }) : undefined;
  // "What's missing?", "what now?": answered here from the same advice, so the question costs no call. The reply
  // says so; the 「接下来」 block under it has the buttons.
  const localAnswer = (): string => {
    const free = countsCalls ? t('assistant.answerFree') : '';
    if (running) return t('assistant.answerRunning') + free;
    if (!nodes.length) return t('assistant.answerEmpty') + free;
    if (!suggested || !assistantNextSteps) return t('assistant.answerNothing') + free;
    if (fillSteps.length) {
      const rows = fillSteps.map(step => t('assistant.answerRow', { node: titleOf(step.nodeId), fields: step.fields.join(listSeparator) }));
      return `${assistantNextSteps.lead}${locale === 'zh' ? '' : ' '}${rows.join(locale === 'zh' ? '；' : '; ')}${locale === 'zh' ? '。' : '. '}${assistantNextSteps.footnote ?? ''}${free}`;
    }
    const first = assistantNextSteps.actions[0]?.label;
    const lead = suggested.steps[0];
    const rework = lead?.kind === 'rework' ? t('assistant.answerRework', { node: titleOf(lead.nodeId), reviewer: titleOf(lead.reviewerId) }) : '';
    return `${assistantNextSteps.lead}${first ? t('assistant.answerSuggest', { action: first }) : ''}${rework}${free}`;
  };
  const answerLocally = (prompt: string): boolean => {
    // "What now?" at any time; "the review failed, what do I do?" while the canvas has such an outcome to act on.
    const outcome = Boolean(suggested && ['rejected', 'failed', 'premium', 'quota'].includes(suggested.situation.kind)) && isOutcomeQuestion(prompt);
    if (!isNextStepsQuestion(prompt) && !outcome) return false;
    const id = `turn-${Date.now()}-${++planningSequence.current}`;
    const content = localAnswer();
    setPlanningError('');
    setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
      { id: `${id}-user`, role: 'user' as const, content: prompt }, { id: `${id}-assistant`, role: 'assistant' as const, content }].slice(-60) }));
    if (nodes.length) setAssistantOpen(true);
    countPress('assistant.local_answer');
    return true;
  };
  // 「画布的最后一个节点运行失败了」「处理失败」 (a user, 2026-10-11): the planner and a direct task cannot see the run, so a
  // short message about its failure is handled here, by the canvas that ran it. The reply says what failed and why;
  // unless it only asks why, the failed nodes and everything they feed run again, as 「重新运行失败的节点」 does. The
  // allowance refusals (quota, premium) get the advice instead: running again would be refused the same way.
  const repairLocally = (prompt: string): boolean => {
    if (!suggested || !['failed', 'quota', 'premium'].includes(suggested.situation.kind)) return false;
    const kind = failureRequestKind(prompt);
    const failed = nodes.filter(node => runs[node.id]?.state === 'failed' && !(node.kind === 'session' && node.lastOutput?.source === 'manual'));
    if (!kind || !failed.length) return false;
    let content: string;
    let scope: string[] | undefined;
    if (suggested.situation.kind === 'failed') {
      const first = failed[0];
      const detail = recoveryDetailMessage(t, runs[first.id]?.detail)?.trim();
      const reason = !detail ? t('assistant.repairNoReason') : /[。.!?！？]$/.test(detail) ? detail : `${detail}${locale === 'zh' ? '。' : '.'}`;
      content = failed.length > 1 ? t('assistant.repairFailedMany', { node: first.title, count: failed.length, reason })
        : t('assistant.repairFailed', { node: first.title, reason });
      const rerun = kind === 'fix' ? suggested.steps.find(step => step.kind === 'rerun-failed') : undefined;
      if (rerun?.kind === 'rerun-failed') {
        scope = downstreamClosure(rerun.nodeIds);
        const after = scope.length - rerun.nodeIds.length;
        content += after > 0 ? t('assistant.repairRerun', { count: after }) : t('assistant.repairRerunAlone');
      } else {
        const action = assistantNextSteps?.actions[0]?.label;
        if (action) content += t('assistant.answerSuggest', { action });
      }
    } else content = localAnswer();
    const id = `turn-${Date.now()}-${++planningSequence.current}`;
    setPlanningError('');
    setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
      { id: `${id}-user`, role: 'user' as const, content: prompt }, { id: `${id}-assistant`, role: 'assistant' as const, content }].slice(-60) }));
    setAssistantOpen(true);
    if (scope) void startRun(scope);
    countPress('assistant.local_answer');
    return true;
  };
  // 「运行」「跑一下」「run it」 (owner request 2026-10-15): the canvas runs itself, as its run button would; the planner
  // cannot run anything. What a run would refuse (inputs nobody filled in) is said instead, with the checklist under it.
  const runLocally = (prompt: string): boolean => {
    const kind = runRequestKind(prompt);
    if (!kind || !nodes.some(node => node.kind === 'session' && !mediaKindOf(node.agentKind))) return false;
    let content: string;
    let scope: string[] | undefined;
    let start = false;
    if (running) content = t('assistant.runBusy');
    else if (runUnavailableReason) content = t('assistant.runUnavailable', { reason: runUnavailableReason });
    else if (suggested?.situation.kind === 'inputs') content = localAnswer();
    else {
      const rest = kind === 'rest' ? suggested?.steps.find(step => step.kind === 'run-rest') : undefined;
      const all = suggested?.steps.find(step => step.kind === 'run-all');
      if (rest?.kind === 'run-rest') {
        scope = downstreamClosure(rest.nodeIds);
        content = t('assistant.runStartingRest', { count: rest.nodeIds.length });
      } else content = t('assistant.runStarting');
      const calls = rest?.kind === 'run-rest' ? rest.calls : all?.kind === 'run-all' ? all.calls : undefined;
      if (countsCalls && calls) content += t('assistant.runCalls', { calls });
      start = true;
    }
    const id = `turn-${Date.now()}-${++planningSequence.current}`;
    setPlanningError('');
    setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
      { id: `${id}-user`, role: 'user' as const, content: prompt }, { id: `${id}-assistant`, role: 'assistant' as const, content }].slice(-60) }));
    setAssistantOpen(true);
    if (start) void startRun(scope);
    countPress('assistant.local_answer');
    return true;
  };
  const costNote = assistantCostNote(t, countsCalls, Boolean(unifiedHost), plannerAllowance);
  // The planner's line only when it needs the reader: connecting, closed (with its retry), an earlier plan to check, or
  // the Jev planner, whose line says what it does. A ready planner says nothing, like a chat app (owner request 2026-10-12).
  const plannerReady = plannerProvider === 'jev' ? Boolean(jevStatus?.available) : Boolean(plannerStatus?.available);
  const showPlannerLine = plannerProvider === 'jev' || !plannerReady || (canInitialize && !recoveryLoaded);
  const assistantProps = {
    nextSteps: assistantNextSteps,
    ...(costNote ? { costNote } : {}),
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
    ...(showPlannerLine ? { runtimeControls: <div className="awwo-planner-connection"><span className={plannerReady ? 'is-ready' : ''} />
      {plannerProvider === 'jev' ? jevStatus?.error || (locale === 'zh' ? 'Jev · 选择人设与模型，新增工作流' : 'Jev · Select personas and models for a new workflow') : plannerConnectionMessage(t, plannerStatus)}
      {plannerProvider === 'pi' && plannerStatus && !plannerStatus.available ? <button type="button" title={plannerStatus.error} onClick={() => { void readPlannerStatus(undefined, locale).then(setPlannerStatus); }}>{t('surface.retryPlanner')}</button> : null}
      {canInitialize && !recoveryLoaded ? <button type="button" disabled={recoveryChecking || recoveryStopping} onClick={() => { void refreshPlanningRecovery(); }}>{locale === 'zh' ? '检查上次规划' : 'Check earlier plan'}</button> : null}
    </div> } : {}),
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
  // The model rail lists each model once, on the runtime AwwO runs it on (nodeRuntime.ts).
  const shelfGroups = useMemo(() => automaticGroups(palette?.groups ?? []), [palette?.groups]);
  const modelShelf = canInitialize && !readOnly && !simple ? <ModelPersonaShelf modelsOnly
    configureModelsHref={personalCredentialsRequired ? accountURL('engines') : undefined}
    operatorManaged={!personalCredentialsRequired} groups={shelfGroups}
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
  // What a run report names models with (the 成果 view's receipt): this workspace's chat models and media catalogue.
  const modelNames = useMemo<ModelNameSources>(() => ({ models: currentModelCatalogue, media: mediaCatalogueOf(mediaState) }),
    [currentModelCatalogue, mediaState]);
  // The models a node's own chat can switch to, in its composer: the workspace's chat models for an agent, the
  // media catalogue's models of its kind for an image, video or 3D node. Stable arrays, so cards stay memoised.
  // Each chat model is offered once, on the runtime AwwO runs it on (nodeRuntime.ts): the reader picks a model, never a
  // runtime.
  const chatModelChoices = useMemo<NodeModelChoice[]>(() => automaticEntries(currentModelCatalogue ?? []).map(model => ({
    key: model.key, label: model.displayName || model.label, available: model.available, reason: model.reason, model: model.model,
    group: palette?.groups.find(group => group.id === model.providerGroup)?.label,
  })), [currentModelCatalogue, palette?.groups]);
  const mediaModelChoices = useMemo<Record<MediaKind, NodeModelChoice[]>>(() => {
    const catalogue = mediaCatalogueOf(mediaState);
    const of = (kind: MediaKind) => mediaModelsOf(catalogue, kind).map(model => ({ key: model.id, label: mediaModelLabel(model, locale), group: mediaGroupLabel(locale), available: true, references: model.references }));
    return { image: of('image'), video: of('video'), model3d: of('model3d') };
  }, [mediaState, locale]);
  const modelChoicesRef = useRef({ chat: chatModelChoices, media: mediaModelChoices });
  modelChoicesRef.current = { chat: chatModelChoices, media: mediaModelChoices };
  const changeNodeModel = useCallback((nodeId: string, key: string) => {
    const live = docRef.current.nodes.find(node => node.id === nodeId);
    if (!live || live.kind !== 'session' || live.team) return;
    const media = mediaKindOf(live.agentKind);
    if (media) {
      if (!modelChoicesRef.current.media[media].some(choice => choice.key === key)) return;
      // Another model has other settings: its own defaults apply until they are set again.
      const { mediaParams: _previous, ...rest } = live;
      saveInspector({ ...rest, model: key });
      return;
    }
    const choice = paletteRef.current?.models.find(model => model.key === key && model.available);
    if (!choice) return;
    saveInspector({ ...live, runtime: choice.runtime, model: choice.model, effort: choice.effort ?? '' });
  }, [saveInspector]);
  const tileModelChoices = (node: CanvasNode): ReadonlyArray<NodeModelChoice> | undefined => {
    if (node.kind !== 'session' || readOnly || !canInitialize) return undefined;
    const media = mediaKindOf(node.agentKind);
    return media ? mediaModelChoices[media] : chatModelChoices;
  };

  const renderInspector = (node: CanvasNode, inline = false) => (
    <InspectorPanel key={!canInitialize && node.kind === 'session' ? `${node.id}:${activeThreadId(node)}` : node.id} node={node} liveCompanies={companies} apiBase={paperclipApiBase()}
      readJson={runtimeReadJson} onSave={saveInspector} onInitialize={canInitialize && !runUnavailableReason ? initializeInspector : undefined} readOnly={readOnly || busyNow.has(node.id) || exclusiveNow} readOnlyMessage={readOnly ? t('common.readOnly') : undefined}
      media={canInitialize ? mediaState : undefined} onRetryMedia={() => setMediaRefresh(value => value + 1)}
      modelGroups={canInitialize ? shelfGroups : undefined} modelsLoading={paletteLoading} modelsError={paletteError}
      onRetryModels={() => setPaletteRefresh(value => value + 1)}
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
    <AgentWorkspace simple={simple} readOnly={readOnly} storageMode={storageMode} workspaceName={workspaceName} workspaceCaption={workspaceCaption} nodes={nodes} edges={edges} selectedIds={selection} runs={runs} running={exclusiveNow}
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
      assistantOpen={panelShown} assistantAvailable={viewerTasks || mentionedTasks.size > 0} assistantHint={assistantHint}
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
        onBack={() => { changeStageView('canvas'); refocus('.awwo-view-switch button'); }} receipt={results?.receipt} modelNames={modelNames}
        studio={results?.studio} studioTitle={t('studio.heading')} /> : undefined}
      accountControl={<div className="awwo-account-controls" inert={bindingLocked || initializing}>{accountControl}</div>}
      toolbar={<>{!cloudScope && <GraphSettings doc={doc} selectedNodeId={selection[0]} selectedEdgeId={selectedEdgeId}
        disabled={readOnly || running || initializing || bindingLocked} onChange={next => { if (canEditStructure()) patchDoc(() => next, { label: 'graph-settings' }); }}
        onAddPartner={nodeId => {
          if (!canEditStructure()) return;
          const result = addReviewPartner(docRef.current, nodeId, locale);
          patchDoc(() => result.doc, { label: 'review-partner' });
          setSelection([result.reviewerId]); restoreFocusCamera(); setFocusedId(null);
        }} />}
      <RunControls initializeOnRun={canInitialize} runUnavailableReason={runUnavailableReason} onConfigureNode={(id) => { focusNode(id, { configure: true }); setInspectorId(id); }} readOnly={readOnly || initializing || bindingLocked} nodes={nodes} edges={edges} execution={doc.execution} round={reviewRound} running={running} runs={runs} lanes={laneRunning.filter(Boolean).length} summary={runSummary}
        onViewOutput={id => { toggleDeliverables(id, true); focusNode(id); setTimelineOpen(false); }}
        reviewNote={reviewNote} onReviewNext={() => { setAssistantOpen(true); countPress('review.next_steps'); }}
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
          setSelectedDisplayId(null);
          return undefined;
        }}
        onBackgroundDoubleClick={readOnly || exclusiveNow || initializing || simple ? undefined : (world) => addNode('llm', world)}
        onBackgroundContextMenu={
          readOnly || exclusiveNow || simple
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
        <WirePlane nodes={renderNodes} edges={edges} runs={collaborationJournal ? {} : runs} running={running && !collaborationJournal} round={doc.execution ? reviewRound : 0} scale={view.scale}
          selectedEdgeId={selectedEdgeId ?? undefined} onSelectEdge={readOnly || exclusiveNow || initializing || simple ? undefined : setSelectedEdgeId}
          preview={wiring.wireDrag} onDisconnect={readOnly || exclusiveNow || initializing || simple ? undefined : disconnect} />
        <CollaborationFlow nodes={renderNodes} collaboration={collaborationJournal?.collaboration} running={running} scale={view.scale} />
        <DisplayLinks displays={displays} boxes={renderNodeById} />
        {displays.map(display => visibleDisplayIds.has(display.id) && (
          <DisplayTile
            key={display.id}
            display={display}
            groups={displayGroups}
            choices={displayChoices}
            canvasEntries={canvasEntries}
            running={runningIds}
            scale={view.scale}
            selected={selectedDisplayId === display.id}
            onSelect={selectDisplay}
            onMove={readOnly ? undefined : moveDisplay}
            onResize={readOnly ? undefined : resizeDisplay}
            onChangeSource={readOnly ? undefined : changeDisplaySource}
            onDelete={readOnly ? undefined : deleteDisplay}
            onOpenStudio={openStudio}
          />
        ))}
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
            interactionLocked={busyNow.has(node.id) || exclusiveNow || initializing || bindingLocked}
            onMove={readOnly || exclusiveNow || initializing ? undefined : moveNode}
            onResizeNode={readOnly || exclusiveNow || initializing || (node.kind === 'session' && focusedId !== node.id) ? undefined : resizeNode}
            onSelect={selectNode}
            onToggleFocus={toggleFocus}
            onFitNode={focusNode}
            onConfigure={simple ? undefined : tileOnConfigure}
            configurationPanel={!canInitialize && node.kind === 'session' && focusedId === node.id && inspectorId === node.id ? renderInspector(node, true) : null}
            onUpdateNode={readOnly || busyNow.has(node.id) || exclusiveNow || initializing || bindingLocked ? undefined : saveNode}
            onRunNode={readOnly || busyNow.has(node.id) || exclusiveNow || initializing || runUnavailableReason ? undefined : rerunNode}
            onDelete={readOnly || busyNow.has(node.id) || exclusiveNow || initializing ? undefined : tileDelete}
            modelChoices={tileModelChoices(node)}
            inputRequest={inputRequests[node.id]}
            onChangeModel={readOnly || busyNow.has(node.id) || exclusiveNow || initializing ? undefined : changeNodeModel}
            onResizeCard={resizeCard}
            onToggleCardPreview={toggleCardPreview}
            onOpenStudio={openStudio}
            onShowInDisplay={readOnly ? undefined : showNodeInDisplay}
            canvasEntries={canvasEntries}
            onStopNode={!readOnly && soloRunning.has(node.id) ? stopNode : undefined}
            wiring={wiring}
          />
          )
        ))}
        <Marquee rect={marquee.rect as WorldRect | null} />
      </CanvasViewport>

      {!running && !simple && <SelectionCollaboration key={`selection:${JSON.stringify(selection)}`} nodes={nodes.filter(node => selection.includes(node.id))}
        disabled={readOnly || initializing || bindingLocked || Boolean(runUnavailableReason)} available={Boolean(cloudScope)}
        onStart={(ids, policy) => { void startRun(ids, undefined, undefined, undefined, policy); }} />}
      {running && collaborationJournal?.collaboration && <CollaborationStatus nodes={nodes} collaboration={collaborationJournal.collaboration} />}

      {initializing && <div className="awwo-handoff-note" role="status">{locale === 'zh' ? '正在准备节点，首次运行会自动使用工作区默认配置…' : 'Preparing nodes with the workspace defaults…'}</div>}
      {!initializing && handoffNote && <div className="awwo-handoff-note" role="alert"><span>{handoffNote}</span><button type="button" aria-label={locale === 'zh' ? '关闭提示' : 'Dismiss notice'} onClick={() => setHandoffNote('')}>×</button></div>}
      {/* Same guard as the minimap: the view tools never paint over the opaque welcome overlay of a
          fresh canvas. An empty canvas that still has something to undo or redo keeps them, or a
          deleted last node or an undone plan could only come back through a keyboard shortcut. */}
      {(nodes.length > 0 || history.undo > 0 || history.redo > 0) && <div className={`awwo-view-tools${simple ? ' is-simple' : ''}`} role="toolbar" aria-label={viewText.toolbar}>
        {!simple && <><button type="button" aria-label={locale === 'zh' ? '框选组件' : 'Select components'} title={locale === 'zh' ? '框选组件（也可按住 Shift 拖动）' : 'Select components (or Shift + drag)'} aria-pressed={selectionTool}
          onClick={() => setSelectionTool(value => !value)}><MousePointer2 size={16} /></button>
        <span className="awwo-tool-separator" /></>}
        <button aria-label={viewText.zoomOut} title={viewText.zoomOut} onClick={() => zoomBy(1 / 1.2)}><Minus size={16} /></button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button aria-label={viewText.zoomIn} title={viewText.zoomIn} onClick={() => zoomBy(1.2)}><Plus size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.fitAll} title={viewText.fitAll} disabled={!nodes.length} onClick={fitAll}><Maximize2 size={16} /></button>
        <button className="awwo-display-tool" aria-label={displayText(locale, 'display.showCanvas')} title={displayText(locale, 'display.showCanvas')}
          disabled={!nodes.length || (readOnly && !displays.some(display => display.source.type === 'canvas'))} onClick={showCanvasDisplay}><MonitorPlay size={16} /></button>
        {!simple && <><button aria-label={viewText.arrange} title={viewText.arrangeTitle} disabled={readOnly || exclusiveNow || initializing || bindingLocked || !nodes.length} onClick={arrangeNodes}><LayoutGrid size={16} /></button>
        <button className="awwo-minimap-toggle" aria-label={viewText.showMinimap} title={focusedId ? t('surface.minimapWhileOpen') : viewText.showMinimap} aria-pressed={minimapOpen} disabled={Boolean(focusedId)} onClick={() => setMinimapOpen(o => !o)}><Map size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.undo} title={viewText.undo} disabled={readOnly || running || initializing || !history.undo} onClick={undo}><Undo2 size={16} /></button>
        <button aria-label={viewText.redo} title={viewText.redo} disabled={readOnly || running || initializing || !history.redo} onClick={redo}><Redo2 size={16} /></button>
        {selection.length > 0 && <><span className="awwo-tool-separator" /><button aria-label={viewText.runSelection} title={runUnavailableReason || viewText.runSelection} disabled={readOnly || exclusiveNow || Boolean(runUnavailableReason)} onClick={runFromSelection}><Play size={15} /></button></>}</>}
      </div>}

      {minimapOpen && !simple && nodes.length > 0 ? (
        <Minimap
          boxes={displays.length ? [...renderNodes, ...displays] : renderNodes}
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
          mediaCatalogue={mediaCatalogueOf(mediaState)}
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
          withDisplay
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
      {studio ? <DeliverableStudio variant="dialog" nodes={nodes} edges={edges} execution={doc.execution} nodeId={studio.nodeId}
        initialEntryId={studio.entryId} assetEntries={canvasEntries}
        title={studio.nodeId ? t('studio.titleNode', { title: nodes.find(node => node.id === studio.nodeId)?.title || '—' }) : t('studio.titleCanvas', { title: workspaceName || 'AwwO' })}
        onClose={() => setStudio(null)} onOpenNode={id => { setStudio(null); changeStageView('canvas'); focusNode(id); }} /> : null}
    </div>
    </AgentWorkspace>
  );
}

export { CANVAS_STORAGE_KEY };
