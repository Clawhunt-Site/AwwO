import { canvasStorage, canvasStorageKey } from './canvasStorage';
import { accountURL } from '../saas/PersonalAccount';
import { canvasFetch } from '../saas/canvasBridge';
import { workspaceAgentCatalog } from '../saas/workspaceAgentCatalog';
import { createMarketplaceRoleNode, type TeamMarketAgent } from './teamMarketAgents';
import { paletteRunsTeams } from './nodeTeam';
import { createWorkspaceAgentNode, type WorkspaceAgent } from './workspaceAgents';
import { saasErrorMessage } from '../saas/api';
import { canvasLocale, isFreePlanEnded } from '../saas/canvasErrors';
import { useLocalEdition } from '../saas/edition';
import { canonicalCanvasDocumentJSON } from '../saas/canvasDraft';
import { TeamRunDetails } from '../saas/TeamRunDetails';
import { unsupportedSaaSGraph } from '../saas/graphCapabilities';
import { readCapabilities } from '../saas/capabilitiesApi';
import { marketSettingsOf, type MarketSettings } from '../saas/marketApi';
import { useCanvasMarket } from './canvasMarket';
import { keepMarketMark, MarketPagesContext, marketPageNodes, unmarkedMarketNodes } from './marketPages';
import { AgentPagesContext, agentPageHolds, handedInBy, keepAgentWritten, recordAgentPages, sameAgentInputs, type AgentPageHold } from './agentPages';
import { currentSaaSCanvas, flushSaaSCanvas, initializeSaaSCanvas, subscribeCanvasKnowledge, confirmSaaSPlanningCancellation } from '../saas/canvasBridge';
import { submitCloudGraph, mergeGraphSnapshot, cancelCloudGraph, graphAdmissionRejected, graphIdOfOperation, graphRefusedNodeId, type GraphCollaborationPolicy, type GraphObservation } from '../saas/graphRuns';
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type DragEvent, type FocusEvent as ReactFocusEvent } from 'react';
import { Maximize2, Minus, Plus, Redo2, Undo2, Map, Play, LayoutGrid, MousePointer2, MonitorPlay, Orbit, Bot } from 'lucide-react';
import { SelectionCollaboration, CollaborationFlow, CollaborationStatus } from './SelectionCollaboration';
import { AgentWorkspace } from './AgentWorkspace';
import { CanvasAssistant, type AssistantNextSteps, type UnifiedAssistant } from './CanvasAssistant';
import { StageActivity, showsStageLine, type StageActivityState } from './StageActivity';
import { nextSteps as canvasNextSteps, failureRequestKind, isNextStepsQuestion, isOutcomeQuestion, nodesLeft, runCost, runRequestKind, sameWholeRunChoice,
  wholeRunChoice, type NextStep, type NextSteps, type WholeRunChoice } from './nextSteps';
import { RerunConfirm } from './RerunConfirm';
import { reviewVerdict, reworkRequirements } from './reviewVerdict';
import { isPremiumRefusal, isQuotaRefusal, modelSwitchHelps, refusalReason, upgradeHelps } from './runRefusals';
import { announceRouteUsageChanged, fetchRouteUsage, recordUpgradeInterest, type RouteAllowance } from '../saas/routeUsage';
import { recordCanvasEvent, type CanvasUiEvent } from '../saas/uiEvents';
import { assistantCostNote } from './assistantCost';
import { liveDataNeed } from './liveDataNeed';
import { assistantRouteRequest, TaskStartUnconfirmed, type AssistantExecutionHost, type AssistantPending, type AssistantRoute,
  type RouteAssistant } from './assistantRouting';
import { messageLinks, typedPages, typeWords, type MessagePage, type MessagePagesOutcome, type ReadMessagePages, type TypedEdit, type TypedWords } from './messagePages';
import { CanvasResults } from './CanvasResults';
import { ModelPersonaControls, ModelPersonaShelf } from './ModelPersonaShelf';
import { automaticGroups, paletteEfforts, readModelPalette, sandboxGroups, type ModelPaletteSelection } from './modelPalette';
import { createModelNode, MODEL_DRAG_MIME, modelDragPayload, resolveModelDrop } from './canvasModelDrop';
import { applyJevPlan, readJevPlannerStatus, requestJevPlan } from './jevPlanning';
import { applyCanvasPlan, canvasPlanRevision, onlyAddedNodes, PLAN_NOTES_SHOWN, planContextCondensed, planNewNodeModel, type CanvasPlan, type CanvasPlanMedia } from './canvasPlan';
import { componentModelEntry, planComponentModel, withAssistantModel } from './assistantModel';
import { DEFAULT_NEW_NODE_MODEL } from './planNewNodeModel';
import { describePlanChanges } from './planChanges';
import { automaticEntries, BLENDER_RUNTIME, pickedModelEntry, SANDBOX_RUNTIME, withAutomaticRuntimes } from './nodeRuntime';
import { planModelsOf } from './userChosenModels';
import { loadLastPlanDuration, loadPlanningConversation, savePlanningConversation, saveLastPlanDuration, requestCanvasPlan, readPlannerStatus,
  readCanvasPlanRecovery, cancelCanvasPlanRecovery, planningTurns, planSeedRequest, type PlanProgress, type PlanningMessage } from './canvasPlanning';
import { invalidateOutputs } from './invalidateOutputs';
import { prepareNodeConversation } from './nodeConversation';
import { assembleInputViews } from './assembleNode';
import { editWiredFiles } from './editNode';
import { followupDeliveryContract } from './followupDelivery';
import { createAgentTemplate, createDevelopmentTemplate, type AgentTemplateId } from './agentTemplates';
import { CanvasViewport } from './CanvasViewport';
import { SessionTile, type SelectMode } from './SessionTile';
import { watchReaderAway, type ComposerStatus } from './TileComposer';
import { TilePorts, useWiring } from './TilePorts';
import { WirePlane } from './WirePlane';
import { Marquee, useMarquee } from './Marquee';
import { AddNodeMenu, type AddNodeKind } from './AddNodeMenu';
import { InspectorPanel } from './InspectorPanel';
import { mediaCatalogueOf, type MediaCatalogueState } from './MediaNodeSettings';
import { mediaGroupLabel, mediaKindOf, mediaModelLabel, mediaModelsOf, readMediaCatalogue, type MediaKind } from './mediaCatalog';
import { nodeModelName, type ModelNameSources } from './modelNames';
import { replaceRetiredMediaModels } from './retiredMediaModels';
import { runScopeWithoutMedia } from './runScope';
import type { NodeModelChoice } from './NodeModelPicker';
import { inspectorSavedNode } from './inspectorSave';
import { RunControls } from './RunControls';
import { GraphSettings } from './GraphSettings';
import { addReviewPartner } from './reviewPartner';
import { preflightReviewGraphIssue, runReviewGraph } from './reviewGraph';
import { beginReviewRound, prepareReviewTurn } from './reviewJournal';
import { RunTimeline, timelineRuns, type RunView } from './RunTimeline';
import { Minimap } from './Minimap';
import { CommandBar, type CommandBarMode, type CanvasCommandActions } from './CommandBar';
import { useCanvasKeys, keyHintMap, isTypingTarget, formatChord } from './useCanvasKeys';
import {
  CANVAS_STORAGE_KEY,
  createFormNode,
  createAssembleNode,
  createEditNode,
  createSessionNode,
  dropOverriddenEvolutionMarks,
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
import { carryWiresIntoContract, droppedWiresNote } from './deliverableWires';
import { nextIn, orderNodes, type WorldRect } from './spatialOrder';
import { preflightGraphIssue, runGraph, serializeFormOutput, validateNodeOutput, type RunNodeStatus } from './runGraph';
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
import { surfaceNotice, stopUnconfirmedMessage, planFailureMessage, plannerConnectionMessage, surfaceViewMessages, preflightIssueMessage, recoveryDetailMessage, refusedNodeMessage, failureReason } from './surfaceMessages';
import { getSnapshot as getSessionSnapshot, reset as resetSession, replaceTurns, patchPresentation, appendTurn as appendSessionTurn,
  removeTurns as removeSessionTurns } from './sessions';
import { forgetNode, restoreHistory } from './sessionTransport';
import { forgetConversationPresentation, projectConversationTurns, updateConversationPresentation } from './conversationPresentation';
import { activeThreadId, boundAgentConfigurationChanged, getNodeThreads, preserveThreadRuntime, rebindNodeThread, sessionStoreKey,
  updateNodeDraft, updateThreadIssueId, updateThreadPreview, withoutThreadDrafts } from './nodeThreads';
import { draftIsShared, readComposerDraft, writeComposerDraft } from './composerDrafts';
import { arrangeNodePositions, deliverablesShown, DRAWER_BESIDE_MIN_WIDTH, FOCUSED_SESSION_MIN_SIZE, nodeDepths, openContentOf, openFrameFor, presentationNodes,
  type OpenContent } from './nodePresentation';
import { boundsOfBoxes, boundsWithinViewport, fitBounds, fitOverview, focusWorld, MIN_READABLE_FIT_SCALE, openInPlace, screenToWorld, visibleBoxIds, type ViewportState } from './viewport';
import { RAIL_MODEL_KEY, isDesktopStage, readRailCollapsed, useDesktopStage, writeRailCollapsed } from './railState';
import { paperclipApiBase } from '../paperclipBridge';
import { gatewayApiBase } from '../chatAutomations';
import './canvas.css';
import './node-view-styles.css';
import { nodeViewRootProps, useNodeViewPreference } from './nodeViewStyle';
import { useSimpleCanvas } from './uiMode';
import { CARD_PREVIEW_DEFAULT, clampCard, loadCardFrames, saveCardFrames, showsPreview, type CardFrames } from './cardFrames';
import {
  CANVAS_GROUP_ID, CONVERGED_ICON_WORLD, convergeView, countSteps, drawnGroups, editReachesHidden, expandForNode, loadConvergedState, MIN_GROUP_MEMBERS,
  NOTHING_CONVERGED, saveConvergedState, type ConvergedState, type ConvergedView,
} from './convergedGroups';
import { ConvergedIcon } from './ConvergedIcon';
import { loadIconView, nodeIconBox, saveIconView, withIconGeometry } from './nodeIcons';
import { NodeIconTile } from './NodeIconTile';
import type { CanvasMultiplayerHost, CanvasMultiplayerRebase } from './multiplayer/host';
import { withOthersEdits, withOthersPaths, type OthersPaths } from './multiplayer/history';
import { DeliverableStudio } from './studio/DeliverableStudio';
import { studioGroups } from './studio/studioModel';
import { DisplayLinks, DisplayTile, type DisplayChoice } from './DisplayTile';
import { clampDisplaySize, createDisplayNode, displayBounds, MAX_DISPLAYS, placeDisplayAfter, placeDisplayBeside, sameDisplaySource, type DisplayNode, type DisplaySource } from './displayNodes';
import { displayText } from './displayCopy';
/** A document with no 预览展示 windows (displayNodes.ts): one shared empty list, so memoised readers see no change. */
const NO_DISPLAYS: ReadonlyArray<DisplayNode> = [];
/** An icon whose members are not all loaded yet: one shared empty list, so the memoised icon sees no change. */
const NO_MEMBERS: ReadonlyArray<CanvasNode> = [];
const NO_DEPTHS: ReadonlyMap<string, number> = new globalThis.Map();
/** Whether the keyboard's focus is lost: on the page itself, on a control gone or hidden, or on one greyed out while it
 *  had it (the browser takes that to the page a moment later). */
function focusIsLost(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return !active || active === document.body || !active.isConnected || Boolean(active.closest('[hidden]')) || active.matches(':disabled');
}
/** A card's first control, for the focus taken into a card opened from its icon that has no close button (a form): never
 *  one of its ports. */
const CARD_CONTROLS = 'button:not(:disabled):not(.canvas-port), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
/** How long patches sharing a label keep collapsing into one undo step (one drag = one step). */
const COALESCE_MS = 900;
/** Cap on remembered steps. Documents are small, but an unbounded stack is a leak. */
const HISTORY_LIMIT = 60;
/** Stage padding reserved around a focused node (room for the composer and the delivery drawer). */
const FOCUS_FIT_PADDING = { x: 28, top: 24, bottom: 82 } as const;
/** How long opening or closing a node glides the camera. */
const CAMERA_GLIDE_MS = 260;
/** How long the converged icons' status region keeps what it said, before it is emptied. */
const ANNOUNCEMENT_KEPT_MS = 8000;
/** The inspector overlay (cloud canvases, forms): inset from the stage, width cap, and the clear space
 *  a node opened for configuration keeps beside it. Below the 760 px breakpoint it spans the stage. */
const INSPECTOR_OVERLAY = { inset: 12, width: 360, gap: 16 } as const;
// The focused delivery overlays the conversation whenever the usable stage cannot fit both
// panes at a readable scale, including laptops with both rails visible.
/** The narrowest an open node gets in the narrow layout. */
const NARROW_FOCUS_MIN_WIDTH = 280;
const narrowFocusWidth = (stageWidth: number) => stageWidth > 0 && stageWidth <= 900 ? Math.max(NARROW_FOCUS_MIN_WIDTH, stageWidth - FOCUS_FIT_PADDING.x * 2) : undefined;
/** Whether an opened node of this drawn width holds its delivery drawer beside its conversation on this stage: not on a
 *  narrow stage, nor in a frame too narrow for both (deliverablesShown, DRAWER_BESIDE_MIN_WIDTH). */
const drawerBeside = (narrow: number | undefined, nodeWidth: number) => !narrow && nodeWidth >= DRAWER_BESIDE_MIN_WIDTH;
/** The world pixels an opened node may fill at 100 % zoom on a stage of this size: the stage less the focus padding,
 *  and less the Configure panel's room while it floats beside the node (a stage narrow enough for the panel to span it
 *  opens nodes in its narrow layout, without a frame). */
const openRoom = (stage: { w: number; h: number }, configuring: boolean) => ({
  w: stage.w - FOCUS_FIT_PADDING.x * 2 - (configuring ? INSPECTOR_OVERLAY.inset + INSPECTOR_OVERLAY.width + INSPECTOR_OVERLAY.gap : 0),
  h: stage.h - FOCUS_FIT_PADDING.top - FOCUS_FIT_PADDING.bottom,
});
/** The stage as the fit math measures it; `cover` is the width of its left edge under a sidebar that floats over it. */
type StageBox = { w: number; h: number; cover?: number };
/** The assistant sidebar where the workspace lays it over the board (absolutely positioned, from the stage's left
 *  edge): how much of the stage's left edge it covers (its layout width), and whether it leaves no room for an open
 *  node at a readable scale (`cramped`: a narrow window, or a phone, where it spans the stage). Null where it takes its
 *  own room beside the stage or is closed. Measured without the sidebar's own entrance slide (`translate`), so a fit
 *  taken while it slides in is not short by a few pixels. */
function floatingSidebar(root: HTMLElement, stage: DOMRect): { cover: number; cramped: boolean } | null {
  const side = root.closest('.awwo-workspace')?.querySelector<HTMLElement>('.awwo-planner-sidebar');
  if (!side) return null;
  const box = side.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const slide = Number.parseFloat(getComputedStyle(side).translate || '0') || 0;
  const left = box.left - slide;
  const right = left + side.offsetWidth;
  if (left > stage.left + 1 || right <= stage.left) return null;
  const cover = Math.min(stage.width, right - stage.left);
  const room = stage.width - cover - FOCUS_FIT_PADDING.x * 2;
  return { cover: Math.round(cover), cramped: room < NARROW_FOCUS_MIN_WIDTH * MIN_READABLE_FIT_SCALE };
}
/** How much of the stage's left edge the assistant sidebar covers, in pixels (floatingSidebar); 0 where it takes its
 *  own room, is closed, or leaves no readable room: the board is then laid out as without it (an open node there has
 *  the assistant step aside, focusNode). */
function sidebarCover(root: HTMLElement, stage: DOMRect): number {
  const side = floatingSidebar(root, stage);
  return side && !side.cramped ? side.cover : 0;
}
/** The least of the stage a floating sidebar leaves for the stage's notes, its selection bar and the 成果 view to move
 *  into (about a 150 px note between the note's own margins); with less, they stay where they are, under it. */
const STAGE_OVERLAY_MIN_ROOM = 200;
/** The side panel's message box: its composer's, not a box that a task card above it holds (a question's answer). */
const PANEL_BOX = '.awwo-canvas-assistant--panel .awwo-assistant-composer textarea';
/** An empty canvas's welcome's message box, as PANEL_BOX. */
const WELCOME_BOX = '.awwo-canvas-assistant--welcome .awwo-assistant-composer textarea';
/** The message box of whichever holds the conversation, the side panel or the welcome: one is drawn at a time. */
const MESSAGE_BOX = '.awwo-canvas-assistant .awwo-assistant-composer textarea';
/** What the rerun question (RerunConfirm.tsx) asks of this canvas as it stands, the way this host runs it. */
function rerunQuestionOf(doc: CanvasDocument): WholeRunChoice | null {
  return wholeRunChoice({ nodes: doc.nodes, edges: doc.edges, cloudRuns: Boolean(currentSaaSCanvas()), scopedRuns: !doc.execution });
}

/** Whether `target` is in `scope`, or in a layer one of its controls opened elsewhere on the page and names with
 *  aria-controls (a composer's 用户须知 is a portal into the body): the reader is with that part of the page there too.
 *  Such a layer is a child of the body other than the one holding `scope`; anything else (the board) is answered without
 *  looking through `scope`, and so is anything once `scope` is off the page (a panel closed meanwhile). */
function inOrOwnedBy(scope: Element, target: Node): boolean {
  if (!scope.isConnected) return false;
  if (scope.contains(target)) return true;
  const start = target instanceof Element ? target : target.parentElement;
  let layer = start;
  while (layer?.parentElement && layer.parentElement !== document.body) layer = layer.parentElement;
  if (!layer || layer.parentElement !== document.body || layer.contains(scope)) return false;
  const owned = new Set([...scope.querySelectorAll('[aria-controls]')].flatMap(control => (control.getAttribute('aria-controls') ?? '').split(/\s+/)));
  owned.delete('');
  for (let element = start; element && owned.size; element = element === layer ? null : element.parentElement) {
    if (element.id && owned.has(element.id)) return true;
  }
  return false;
}
/** Whether Configure, open on this stage, raises the board above the assistant sidebar: the hosted app at 900 px and
 *  below does (awwo-workspace.css), so while it is open the sidebar covers nothing of the board. */
const configureRaisesBoard = (root: HTMLElement) => Boolean(root.closest('.saas-canvas-shell'))
  && typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 900px)').matches);
/** A view fitted on the stage right of `cover` (computed as if that part were the whole stage), back on the stage. */
const shiftView = (view: ViewportState, by: number): ViewportState => by ? { ...view, x: view.x + by } : view;
/** A changed document's planning recovery is read again once the document has not changed for this long. */
const PLAN_RECOVERY_SETTLE_MS = 300;
/** A request carried over from the workspace home waits at most this long for the model its plan's new nodes take
 *  (the palette and the reader's choice, planNewNodeChoice), so a read that fails never holds it. */
export const HAND_OVER_MODEL_WAIT_MS = 4000;
/** An opened node's frame and the camera the app placed for it, from one measurement of the stage (openPlacement). */
type OpenFit = { id: string; frame?: { w: number; h: number }; view: ViewportState; narrow?: number; content: OpenContent; resized?: boolean };
/** Stage changes (window resize, rail toggles) settle for this long before the overview refits. */
const REFIT_DEBOUNCE_MS = 150;
/** Tile previews (persistPreview) are written together once their reports pause this long, and at least this often. */
const PREVIEW_QUIET_MS = 120;
const PREVIEW_MAX_WAIT_MS = 600;
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
 *  windows beside the graph) and converged icons are part of the board, so a fit shows them too (`displays`: any boxes
 *  drawn beside the cards). */
function fitNodeOverview(nodes: ReadonlyArray<CanvasNode>, size: { w: number; h: number }, cardFrames?: CardFrames,
  displays: ReadonlyArray<{ x: number; y: number; w: number; h: number }> = NO_DISPLAYS): ViewportState {
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

/** A lane's badges without these nodes' badges: the very same map when it shows none of them, so a lane that lost
 *  nothing keeps its identity (a page repair refused before it ran gives its node's badge back only to a lane nothing
 *  has changed since it started: endRefusedRepair). */
function withoutBadges(badges: Record<string, RunView>, ids: ReadonlySet<string>): Record<string, RunView> {
  return Object.keys(badges).some(id => ids.has(id))
    ? Object.fromEntries(Object.entries(badges).filter(([id]) => !ids.has(id))) : badges;
}

/** A saved document's canonical text without its camera and save time: what a run's recovery has to preserve. */
function sansCamera(json: string | null): string | null {
  if (json === null) return null;
  try {
    const { view: _view, updatedAt: _updatedAt, ...rest } = JSON.parse(json) as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch { return json; }
}

/** A saved document and what a run's recovery or start compares with it, each worked out when first asked for: its
 *  canonical text and its plan revision in the normalized shape the loader returns. Documents are never changed in place,
 *  so both are what they would have been at the save. */
interface SavedDocument { readonly doc: CanvasDocument; canonical(): string; planRevision(): string }
function savedDocument(doc: CanvasDocument, revision?: string): SavedDocument {
  let json: string | undefined;
  return { doc, canonical: () => json ??= canonicalCanvasDocumentJSON(doc), planRevision: () => revision ??= canvasPlanRevision(sanitizeDocument(doc)) };
}

/** Whether two versions of a node read the same as a wire's source: prepareNodeConversation and assembleInputViews read
 *  nothing of where it sits or how large it is drawn, so a card being dragged is the same source on every frame. */
function sameAsSource(a: CanvasNode | undefined, b: CanvasNode | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key !== 'x' && key !== 'y' && key !== 'w' && key !== 'h' && left[key] !== right[key]) return false;
  }
  return true;
}

/** Where a node sits, how large it is drawn and the next message being typed into it are not part of what a run executes. */
function nodeSubstance(node: CanvasNode): string {
  const { x: _x, y: _y, w: _w, h: _h, ...rest } = node as CanvasNode & { deliverablesOpen?: boolean };
  delete (rest as { deliverablesOpen?: boolean }).deliverablesOpen;
  // Marking a node as fed by a market Agent (marketPages.ts) changes nothing it runs, nor do the server's fingerprints of
  // what invited Agents wrote (agentPages.ts).
  delete (rest as { marketFed?: true }).marketFed;
  delete (rest as { agentWritten?: unknown }).agentWritten;
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
  /** 多人同屏: the host's live connection (multiplayer/host.ts): others' changes come in through it, this page's
   *  selection, open node and pointer go out, and others' rings, claims and pointers are drawn over the board. */
  multiplayer?: CanvasMultiplayerHost;
  /** 多人同屏 is on for this canvas: its host (`multiplayer`) connects a moment after the canvas opens, and a canvas run's
   *  journal this page finds ended, or another tab let go, waits for it (the host lands such a run). */
  multiplayerExpected?: boolean;
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
  /** Reads the web pages a message names before it is handled, the assistant's and a node's (messagePages.ts): the
   *  hosted app, where the server reads the web. Absent, an address in a message is only text. */
  readMessagePages?: ReadMessagePages;
  /** The hosted app's 成果 view: the canvas's result large, the steps that made it, and the host's run
   *  receipt. Absent (the desktop app) leaves the canvas without it. */
  results?: CanvasResultsOptions;
  /** A new external draft, never sent without the normal planning action. */
  taskDraft?: { id: string; prompt: string } | null;
  /** A change the host's lessons suggest for one node (the 经验 panel's 应用), applied once per id as a plan of the
   *  canvas plan protocol, through the same validation as any plan and undoable as one; its outcome goes back to
   *  onEvolutionSettled. */
  evolution?: CanvasEvolution | null;
  onEvolutionSettled?: (id: string, result: CanvasEvolutionResult) => void;
  /** A run the host's canvas evolution asks for (saas/canvasEvolution.ts): its nodes, run once as a run of their own
   *  under the operation id the server admits it by, its `note` said in the assistant's panel when it starts. Whether
   *  it started goes back to onAutoRunSettled. */
  autoRun?: CanvasAutoRun | null;
  onAutoRunSettled?: (id: string, result: { started: boolean }) => void;
  onOpenSettings?: () => void;
  /** A run or a plan this page was watching has ended (the host may tell a reader who is away). `graphIds` names the
   *  cloud canvas runs this page started that it saw end (absent for a node's own message, a native run, a run refused
   *  at admission, or one found in a journal another load or tab left). */
  onWorkSettled?: (event: { kind: 'run' | 'plan'; failed: boolean; graphIds?: string[] }) => void;
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

/** A lesson's suggestion for one node: run it at `effort`, on the model it runs (or `model`, the one its lesson's runs
 *  ran with, where it takes the workspace's default). `note` is the assistant's reply saying why, in the reader's words.
 *  `expect`, where given, is the node's own effort the change was claimed from: a node at another (a person changed it
 *  since) is left as it is. `wanted`, where given, says whether the host still wants it as the surface comes to take it:
 *  one it took back meanwhile is dropped unsaid (settled as not applied). `change`, where given, is the id of the change
 *  of the canvas's evolution it makes: the node it changes carries it (SessionNode.evolution), which is how the server
 *  knows the canvas, not a person, made it. `expectMark`, where given, is the mark the node must still carry (a revert's:
 *  the change it takes back, which a person's own edit since has taken away). `since`, where given, is when the change
 *  was claimed, on this page's monotonic clock (performance.now(), which a system clock set back does not move): a node
 *  whose effort anything set after that, even back to the same value, is left as it is. */
export interface CanvasEvolution { id: string; nodeId: string; effort: string; model: string; note: string; expect?: string; wanted?: () => boolean; change?: string; expectMark?: string; since?: number }
/** How a suggestion went: `applied` when its plan changed the node, `satisfied` when the node already ran that way, and
 *  otherwise why it was not taken (said in the assistant's panel too). */
export interface CanvasEvolutionResult { applied: boolean; satisfied?: boolean; reason?: string }
/** A run the canvas's evolution asks for: `scope` run once under `operationId`. */
export interface CanvasAutoRun { id: string; scope: string[]; operationId: string; note: string }

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
  /** It comes from a draft the old home box saved, which could cut an address: none of its addresses is the person's
   *  until they paste it again. */
  untrusted?: boolean;
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

// A message that only asks to go on with the turn before it (the router is told of such words too: assistant_route.go).
const FOLLOW_UP = /^(继续|重试|再试一次|再来一次|接着做|继续执行|continue|retry|try again|go on)[\s。.!！]*$/i;

export function CanvasSurface({ readOnly = false, multiplayer, multiplayerExpected = false, workspaceName, workspaceCaption, storageMode = 'local', runtimeReadJson, onCreateCompany, accountControl, headerTitle, headerActions, canvasTools, assistantExecution, routeAssistant, readMessagePages, results, taskDraft = null, evolution = null, onEvolutionSettled, autoRun = null, onAutoRunSettled, onOpenSettings, onWorkSettled, personalCredentialsRequired = false, executionUnavailableReason, onLocalDocumentSaveFailed, planRequest = requestCanvasPlan, initialPlan = null }: CanvasSurfaceProps = {}) {
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
  // The local edition sells no plan, so a refusal there never offers one.
  const localEdition = useLocalEdition();
  const loadWorkspaceAgents = useMemo(() => storageMode === 'cloud' && cloudScope ? workspaceAgentCatalog(cloudScope.tenant.id) : undefined, [storageMode, cloudScope?.tenant.id]);
  const [storage] = useState(canvasStorage);
  const baseStorage = storage;
  // Cards enlarged to show their deliverable (a view preference, never the document): see cardFrames.ts.
  const [cardFrames, setCardFrames] = useState<CardFrames>(() => loadCardFrames());
  const cardFramesRef = useRef(cardFrames);
  cardFramesRef.current = cardFrames;
  // Components drawn converged into one live icon (收敛; a view preference too, never the document): convergedGroups.ts.
  const [converged, setConverged] = useState<ConvergedState>(() => loadConvergedState());
  const convergedNowRef = useRef(converged);
  convergedNowRef.current = converged;
  // The board as drawn with converged icons (set below, once it is worked out): fits frame what is drawn, and an edit
  // that reaches a member inside an icon draws the cards again (patchDoc).
  const convergedViewRef = useRef<ConvergedView | null>(null);
  const [selectedIconId, setSelectedIconId] = useState<string | null>(null);
  // The camera before the canvas converged, to return to when it is drawn as cards again.
  const convergeReturn = useRef<ViewportState | null>(null);
  // Every component drawn as its own live icon, wired as the cards are (图标视图; a view preference too, never the
  // document): nodeIcons.ts and NodeIconTile.tsx.
  const [iconView, setIconView] = useState<boolean>(() => loadIconView());
  const iconViewRef = useRef(iconView);
  iconViewRef.current = iconView;
  // The icon the keyboard's focus goes to in the commit that draws it (a cycle moved the selection on from the one the
  // focus was on; the next icon after the focused one went, drawn from off screen first); the toggle if it is not drawn.
  const [iconFocusRequest, setIconFocusRequest] = useState<{ id: string } | null>(null);
  // The icon that has the focus (its button or a port of it), until the focus is taken elsewhere on the page: it stays
  // mounted while the camera moves it off screen, and when it goes (deleted here or by someone else, an undo, a plan)
  // the focus goes on to the next icon. A blur to nothing (a press on the board) lets it go too.
  const [keyIcon, setKeyIcon] = useState<string | null>(null);
  const keyIconRef = useRef(keyIcon);
  keyIconRef.current = keyIcon;
  // The board's one polite status region for converged icons: converging and expanding, a member failing while the rest
  // still run, and why Delete, undo or redo does nothing while converged. Changes only; the run note keeps speaking for
  // the run.
  const [announcement, setAnnouncement] = useState({ text: '', nonce: 0 });
  // Said, then let go after a while, so reading the page later never meets a stale "…the others keep running".
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((text: string) => {
    setAnnouncement(previous => ({ text, nonce: previous.nonce + 1 }));
    clearTimeout(announcementTimer.current);
    announcementTimer.current = setTimeout(() => setAnnouncement(previous => previous.text ? { text: '', nonce: previous.nonce } : previous), ANNOUNCEMENT_KEPT_MS);
  }, []);
  useEffect(() => () => clearTimeout(announcementTimer.current), []);
  const tLatest = useRef(t);
  tLatest.current = t;
  // Gives a focus the icon took with it to the toggle (set below, once refocusInCommit exists): never to the page.
  const refocusToggle = useRef<() => void>(() => {});
  // Draws converged components as cards again without the toggle (a node opened from anywhere, an edit or a plan that
  // reaches one, the assistant's undo, the icon dissolving), and says so. The camera stays where that change puts it.
  const showConverged = useCallback((next: ConvergedState, said: string) => {
    if (next === convergedNowRef.current) return;
    convergedNowRef.current = next;
    setConverged(next);
    if (!next.canvas) convergeReturn.current = null;
    setSelectedIconId(null);
    refocusToggle.current();
    announce(said);
  }, [announce]);
  // Another tab's document taken in while components are inside an icon (at a run's start, or a run's end there): a
  // change to the canvas itself draws the cards again, as an edit on this page does. `structureOnly` keeps the icon for
  // a document that only brings another tab's run outputs, told apart by which nodes and wires there are.
  const showAdopted = useCallback((from: CanvasDocument, to: CanvasDocument, structureOnly = false) => {
    if (!convergedViewRef.current?.hidden.size && !convergedNowRef.current.canvas) return;
    const shape = (doc: CanvasDocument) => `${doc.nodes.map(node => node.id).join('\u0001')}\u0002${doc.edges.map(edge => edge.id).join('\u0001')}`;
    if (structureOnly && shape(from) === shape(to)) return;
    showConverged(NOTHING_CONVERGED, tLatest.current('converge.announce.shownForChange'));
  }, [showConverged]);
  const canInitialize = storageMode === 'cloud' && Boolean(cloudScope);
  const runUnavailableReason = storageMode === 'cloud' ? executionUnavailableReason?.trim() || '' : '';
  const [palette, setPalette] = useState<Awaited<ReturnType<typeof readModelPalette>> | null>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  // The latest render's host, for handlers that resume after awaiting the server (a plan applied, a routed message).
  const executionRef = useRef(assistantExecution);
  executionRef.current = assistantExecution;
  // The host's reader of the web pages a message names (messagePages.ts), read when a message is sent.
  const readPagesRef = useRef(readMessagePages);
  readPagesRef.current = readMessagePages;
  // Which words of each box the person typed or pasted (messagePages.ts TypedWords): only an address they typed or
  // pasted is read, never one the canvas wrote there (a task's draft, a node's fix lead, a starter prompt, a page's
  // title, a draft restored after the page was opened again). Keyed 'assistant', or a node's id and conversation.
  const typedWords = useRef(new globalThis.Map<string, TypedWords>());
  const noteTyped = useCallback((box: string, previous: string, next: string, typed = true, edit?: TypedEdit) => {
    if (!readOnlyRef.current) typedWords.current.set(box, typeWords(typedWords.current.get(box), previous, next, typed, edit));
  }, []);
  const noteNodeTyped = useCallback((node: SessionNode, threadId: string, previous: string, next: string, typed: boolean, edit?: TypedEdit) =>
    noteTyped(`node:${node.id}:${threadId}`, previous, next, typed, edit), [noteTyped]);
  // A message read is on its way: what its box held is the box's no longer, so nothing typed in it carries over to the
  // words the canvas puts in the box next.
  const forgetTyped = useCallback((box: string) => { typedWords.current.delete(box); }, []);
  const typedIn = useCallback((box: string, text: string) => typedPages(typedWords.current.get(box), text), []);
  /** Whether a message waits for the web pages it names: the host reads them and it names one. */
  const namesPages = (text: string) => Boolean(readPagesRef.current) && messageLinks(text).length > 0;
  /** The pages a message named that were not read, each with why, as one list for the box's notice. */
  const unreadPages = useCallback((pages: ReadonlyArray<MessagePage>) => pages.filter(page => page.error).map(page => {
    // The reason's own full stop would end the sentence inside the brackets.
    const reason = page.error!.replace(/[。.]\s*$/u, '');
    return locale === 'zh' ? `${page.host}（${reason}）` : `${page.host} (${reason})`;
  }).join(locale === 'zh' ? '；' : '; '), [locale]);
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [paletteError, setPaletteError] = useState('');
  const [paletteRefresh, setPaletteRefresh] = useState(0);
  const [palettePersona, setPalettePersona] = useState<AgentTemplateId | null>(null);
  // Each press of a 「去填写」 step opens that node on its input drawer (SessionTile inputRequest).
  const [inputRequests, setInputRequests] = useState<Record<string, number>>({});
  // A node's own view hands it to the assistant (SessionTile onAskAssistant): one stable callback for every card, which
  // calls the latest render's handler, so the memoised cards do not all re-render.
  const askAboutNodeRef = useRef<(nodeId: string, kind: 'edit' | 'fix') => void>(() => {});
  const askAboutNode = useCallback((nodeId: string, kind: 'edit' | 'fix') => askAboutNodeRef.current(nodeId, kind), []);
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
  // A run's own callback does not re-create itself when the catalogue arrives, and must still judge a media node's
  // saved settings by the catalogue as it is now, as it reads the model palette through paletteRef.
  const mediaStateRef = useRef(mediaState);
  mediaStateRef.current = mediaState;
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
  const mediaKinds = useMemo(() => (['image', 'video', 'model3d', 'audio'] as const).filter(kind => mediaModelsOf(mediaCatalogueOf(mediaState), kind).length > 0), [mediaState]);
  // Whether this server renders edit nodes (capabilities.go): null until read, or when it does not say. Only a server
  // that says no hides the edit node; otherwise a run that cannot make the film says why on the node.
  const [editEnabled, setEditEnabled] = useState<boolean | null>(null);
  // The Agent market (canvasMarket.tsx), where this workspace's capabilities say it is on; null hides every control of it.
  const [marketSettings, setMarketSettings] = useState<MarketSettings | null>(null);
  useEffect(() => {
    setEditEnabled(null); setMarketSettings(null);
    if (!canInitialize || readOnly || !cloudScope) return;
    const controller = new AbortController();
    void readCapabilities(cloudScope.tenant.id, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (typeof value.edit?.enabled === 'boolean') setEditEnabled(value.edit.enabled);
      setMarketSettings(marketSettingsOf(value));
    }, () => undefined);
    return () => controller.abort();
  }, [canInitialize, cloudScope, readOnly]);
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
  // canvasPlanRevision hashes a document's whole canonical text, megabytes for a large canvas. It reads four fields, so
  // it is worked out once for each state of them, not on every render (each camera frame and each tile's update).
  const revisionCache = useRef<{ of: Pick<CanvasDocument, 'version' | 'nodes' | 'edges' | 'execution'>; revision: string } | null>(null);
  const revisionOf = useCallback((document: CanvasDocument): string => {
    const held = revisionCache.current;
    if (held && held.of.version === document.version && held.of.nodes === document.nodes && held.of.edges === document.edges
      && held.of.execution === document.execution) return held.revision;
    const revision = canvasPlanRevision(document);
    revisionCache.current = { of: { version: document.version, nodes: document.nodes, edges: document.edges, execution: document.execution }, revision };
    return revision;
  }, []);
  const planRevision = revisionOf(doc);

  // Edges are reconciled against the CURRENT port specs before anything reads them: a wire whose
  // port vanished (an image agent switched to LLM) must not linger in the document, in the run
  // engine's dependency graph, or on screen.
  const edges = useMemo(() => reconcileEdges(nodes, doc.edges), [nodes, doc.edges]);
  // The nodes whose pages hold a market Agent's words, for every view below that shows a page (marketPages.ts).
  const marketPages = useMemo(() => marketPageNodes(nodes, edges), [nodes, edges]);
  // The results held for an invited Agent, handed in or made from its words (agentPages.ts), for the same views: the
  // same map while they are the same, so a moved card hands the views nothing new.
  const agentPagesSeen = useRef<{ key: string; holds: ReadonlyMap<string, AgentPageHold>; read: Pick<CanvasDocument, 'nodes' | 'edges'> | null }>(
    { key: '[]', holds: new globalThis.Map(), read: null });
  const agentPages = useMemo(() => {
    const seen = agentPagesSeen.current;
    // A drag moves nodes on every frame: what is held is worked out again only when what it is read from changes.
    if (seen.read && sameAgentInputs(seen.read, { nodes, edges })) return seen.holds;
    const holds = agentPageHolds(nodes, edges);
    const key = JSON.stringify([...holds]);
    agentPagesSeen.current = key === seen.key ? { ...seen, read: { nodes, edges } } : { key, holds, read: { nodes, edges } };
    return agentPagesSeen.current.holds;
  }, [nodes, edges]);
  // Read by callbacks that must keep their identity (the tiles are memoised on them) and by what the displays read.
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

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
  // The document this page saved (or adopted) last. Its canonical text and its revision are compared only by a run's
  // recovery and a run's start, so each is worked out from it when first asked for: a large canvas's take a second or
  // more on a slow computer, and a drag saves on every frame.
  const lastSaved = useRef<SavedDocument | null>(null);
  const pendingRecoveryDocument = useRef<{ storageKey: string; journalId: string; document: string } | null>(null);
  if (lastSaved.current === null) lastSaved.current = savedDocument(doc);
  const localSaveFailure = useRef(onLocalDocumentSaveFailed);
  localSaveFailure.current = onLocalDocumentSaveFailed;
  const lastSavedRaw = useRef<string | null>(null);
  if (lastSavedRaw.current === null) { try { lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY); } catch { /* read again after the first save */ } }
  const saveLocalDocument = useCallback((next: CanvasDocument): boolean => {
    if (outdatedObserver.current) return false;
    if (!saveDocument(next)) {
      localSaveFailure.current?.(next);
      return false;
    }
    lastSaved.current = savedDocument(next);
    try { lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY); } catch { lastSavedRaw.current = null; }
    pendingRecoveryDocument.current = null;
    return true;
  }, []);
  const undoStack = useRef<CanvasDocument[]>([]);
  const redoStack = useRef<CanvasDocument[]>([]);
  // 多人同屏: for each undo and redo step, the paths others changed since it was taken (multiplayerRebase): an undo or redo
  // leaves those as they made them (multiplayer/history.ts).
  const othersSince = useRef(new WeakMap<CanvasDocument, OthersPaths>());
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
      // A node's effort set by anything but the change whose mark it carries takes the mark away. A node keeps the
      // server's fingerprints of what invited Agents wrote, and a result held for an Agent's words is fingerprinted here
      // as the server does it, so it stays held before the server answers (agentPages.ts).
      const next = recordAgentPages(prev, keepAgentWritten(prev,
        dropOverriddenEvolutionMarks(prev, opts?.serverIdentity ? proposed : invalidateOutputs(prev, proposed))));
      if (next === prev) return;
      const busy = laneGuard.current.busy(opts?.lane);
      if (busy.size && touchesBusyNodes(prev, next, busy)) {
        if (!opts?.silent) setHandoffNote(surfaceNotice(t, 'node_busy_edit'));
        return;
      }
      // Nothing changes inside a converged icon unseen: an edit that reaches what the board does not draw (a node added
      // to a converged canvas, a member changed or removed, a wire of one) draws the cards again first. Machine writes
      // (silent: a run's output, the camera) leave the icon as it is; the icon shows a run.
      const drawn = convergedViewRef.current;
      if (!opts?.silent && drawn && editReachesHidden(prev, next, drawn.hidden, convergedNowRef.current.canvas)) {
        showConverged(NOTHING_CONVERGED, tLatest.current('converge.announce.shownForChange'));
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
    [syncHistory, showConverged],
  );
  // When each node's effort last changed in this page, whatever changed it (an edit, an undo, a plan, a recovery), for a
  // change of the canvas's evolution claimed before that (CanvasEvolution.since), which then leaves the node as it is.
  const effortsSeen = useRef<globalThis.Map<string, string> | null>(null);
  const effortChangedAt = useRef(new globalThis.Map<string, number>());
  useEffect(() => {
    const now = performance.now();
    const efforts = new globalThis.Map<string, string>(doc.nodes.flatMap(node => node.kind === 'session' ? [[node.id, node.effort ?? ''] as const] : []));
    const seen = effortsSeen.current;
    if (seen) for (const [id, effort] of efforts) if (seen.has(id) && seen.get(id) !== effort) effortChangedAt.current.set(id, now);
    effortsSeen.current = efforts;
  }, [doc]);
  // A node a market Agent's text reaches is marked once (marketFed), so that what it delivered keeps the stricter
  // preview after it is wired otherwise; the mark is no edit, and makes nothing stale.
  useEffect(() => {
    if (readOnly) return;
    const unmarked = new Set(unmarkedMarketNodes(nodes, marketPages));
    if (!unmarked.size) return;
    patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(node => unmarked.has(node.id) && !node.marketFed ? { ...node, marketFed: true as const } : node) }),
      { silent: true, serverIdentity: true });
  }, [nodes, marketPages, readOnly, patchDoc]);

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
  // Settings a node's model no longer accepts are NOT dropped here: this catalogue is read once when the canvas
  // opens, so a tab left open across a release that widened a model's choices holds a stale, narrower one, and
  // deleting by it would silently and permanently lose a choice the server accepts (a silent patch leaves no undo
  // entry, and the autosave carries it to the workspace). Such a node is named before its run instead
  // (preflightGraphIssue), and the reader re-picks in its settings, where the offending parameter is already marked.
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
    const restored = invalidateOutputs(live, { ...target, view: live.view, nodes: target.nodes.map(restoredNode => {
      const current = live.nodes.find(n => n.id === restoredNode.id);
      // A node marked as fed by a market Agent stays marked (marketPages.ts).
      const node = keepMarketMark(restoredNode, current);
      if (node.kind !== 'session' || current?.kind !== 'session') return node;
      const kept = preserveThreadRuntime(node, current);
      // A step from before the node had skills names none; say so with an empty list, which the server keeps,
      // rather than leaving the key out, which it reads as an older client's save and answers with the skills.
      return !Object.hasOwn(kept, 'skills') && current.skills?.length ? { ...kept, skills: [] } : kept;
    }) });
    // The step keeps every fingerprint of what invited Agents wrote that the canvas has now (agentPages.ts): an undo may
    // bring an Agent's text back, which then shows held again.
    const marked = recordAgentPages(live, keepAgentWritten(live, restored));
    docRef.current = marked;
    setDoc(marked);
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
    // What someone else changed since the step stays theirs (multiplayer/history.ts).
    const { doc: target, kept } = withOthersEdits(current, prevDoc, othersSince.current.get(prevDoc));
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, current].slice(-HISTORY_LIMIT);
    restoreDoc(target);
    syncHistory();
    if (kept) setHandoffNote(surfaceNotice(t, 'undo_kept_others'));
    if (overPlan) planStep.current?.undone(current);
    return true;
  }, [canEditStructure, restoreDoc, syncHistory, t]);

  const redo = useCallback(() => {
    if (!canEditStructure()) return;
    const nextDoc = redoStack.current.at(-1);
    if (!nextDoc) return;
    const { doc: target, kept } = withOthersEdits(docRef.current, nextDoc, othersSince.current.get(nextDoc));
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, docRef.current].slice(-HISTORY_LIMIT);
    restoreDoc(target);
    syncHistory();
    if (kept) setHandoffNote(surfaceNotice(t, 'redo_kept_others'));
    planStep.current?.redone(nextDoc);
  }, [canEditStructure, restoreDoc, syncHistory, t]);

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
  // The camera the canvas opened on, before any fit or the operator moved it.
  const startupCamera = useRef(view);
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
      // Landed: the camera is the target from now on, also for a check that runs before the render showing it (it
      // would otherwise meet no target and the last passing frame).
      if (t >= 1) { glideTarget.current = null; viewRef.current = target; }
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
  /** The overview of these nodes on this stage, fitted in the part right of a sidebar that floats over its left edge.
   *  Converged members are framed by their icon, not by the cards they would be. */
  const overviewCamera = useCallback((fitNodes: ReadonlyArray<CanvasNode>, box: StageBox) => {
    const cover = box.cover ?? 0;
    const drawn = convergedViewRef.current;
    const displays = docRef.current.displays ?? NO_DISPLAYS;
    const shown = drawn?.hidden.size ? fitNodes.filter(node => !drawn.hidden.has(node.id)) : fitNodes;
    const beside = drawn?.icons.length ? [...displays, ...drawn.icons] : displays;
    return shiftView(fitNodeOverview(shown, { w: box.w - cover, h: box.h }, cardFramesRef.current, beside), cover);
  }, []);
  // The canvas's first fit, put off while a node opened before the stage's first size arrived is open (the opening
  // fit below): closing that node lands on the overview instead of the camera the canvas started with.
  const overviewOnReturn = useRef(false);
  // The saved view owns the initial position only while it still shows the whole graph on THIS
  // stage; a view persisted on a wider screen (or none at all) fits once the first real size is
  // known. Explicit Fit and newly generated plans still fit on request, and take the first fit's place.
  const savedView = useRef(doc.view);
  const fitted = useRef(false);
  const autoFit = useCallback((fitNodes: ReadonlyArray<CanvasNode>, box: StageBox, automatic = false) => {
    const next = overviewCamera(fitNodes, box);
    overviewOnReturn.current = false;
    if (!automatic) fitted.current = true;
    lastAutoView.current = next;
    // The app refits only a camera it may take over (a requested fit, say): the operator's camera still waiting to be
    // saved is saved now, before the refit replaces it.
    const pending = automatic ? pendingCameraSave.current : null;
    if (pending) {
      clearTimeout(pending.timer); pendingCameraSave.current = null;
      // The operator's camera now, which is what is saved, kept as the viewport persistence below keeps it: an open
      // node's return camera; else where a glide lands (the one a closed node returns to), or its last frame before the
      // render showing it, never a frame on the way that waits to be saved; not the app's own camera.
      const now = focusedRef.current && focusReturn.current ? focusReturn.current : glideTarget.current ?? viewRef.current;
      if (!isFittedCamera(now, unsavedCamera.current)) {
        patchDoc(prev => (prev.view?.x === now.x && prev.view?.y === now.y && prev.view?.scale === now.scale)
          ? prev : { ...prev, view: now }, { silent: true });
      }
    }
    unsavedCamera.current = automatic ? next : null;
    moveCamera(next);
  }, [moveCamera, patchDoc, overviewCamera]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // A stage that has not measured itself yet has no size, and a stage without one culls nothing (visibleBoxIds): every
  // tile of a large canvas would mount, and start reading its history, before the camera that decides which of them show.
  // Tiles mount once the viewport has measured the stage (a stage that measures 0, with nothing laid out, still shows all).
  const [stageMeasured, setStageMeasured] = useState(false);
  const onStageResize = useCallback((next: { w: number; h: number }) => { setStageMeasured(true); setSize(next); }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const [handoffNote, setHandoffNote] = useState('');
  const refusedRevision = useRef<string | null>(null);
  useEffect(() => {
    if (refusedRevision.current && refusedRevision.current !== planRevision) {
      refusedRevision.current = null;
      setHandoffNote('');
    }
  }, [doc, planRevision]);

  const [selection, setSelection] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // A selected 预览展示 window. Its own state, beside the node selection: a display is never a node, so nothing that
  // acts on selected nodes (runs, collaboration, group moves) can reach it.
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null);
  const selectedDisplayRef = useRef(selectedDisplayId);
  selectedDisplayRef.current = selectedDisplayId;
  const displays = doc.displays ?? NO_DISPLAYS;
  // Selecting nodes lets a selected display go, in the commit that draws the selection: a passive effect can run a task
  // after its draw (one no input of this page asked for, as someone else's deletion of a selected node), still judging
  // that draw's selection, and so undo a display pressed in between.
  useLayoutEffect(() => { if (selection.length && selectedDisplayRef.current) setSelectedDisplayId(null); }, [selection]);
  // A selected display that went away (someone else deleted it) is forgotten. Asked, as before, only when this draw's
  // display is gone (a drag's moves make a new list each frame and queue no update), but judged on the display selected
  // as React applies the reset: a display pressed after the draw that took it away is the reader's.
  useEffect(() => {
    const gone = (id: string | null) => Boolean(id) && !displays.some(display => display.id === id);
    if (gone(selectedDisplayId)) setSelectedDisplayId(current => gone(current) ? null : current);
  }, [displays, selectedDisplayId]);
  // Read inside the drag so moving a group never depends on the callback identity at press time.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [inspectorId, setInspectorId] = useState<string | null>(null);
  // Live, for a focus that re-fits a node while it is being configured (focusNode reads it).
  const inspectorRef = useRef<string | null>(null);
  inspectorRef.current = inspectorId;

  // ---- 多人同屏 (multiplayer/host.ts) ----------------------------------------------------------
  // Others' changes come in as a rebase the host works out: applied to the document and carried over every undo and redo
  // step (so an undo never takes back someone else's edit), as no step of its own and with no output made stale here:
  // whatever their edit made stale came with it. What is gone is no longer selected, open or configured.
  const multiplayerRef = useRef(multiplayer);
  multiplayerRef.current = multiplayer;
  const multiplayerExpectedRef = useRef(multiplayerExpected);
  multiplayerExpectedRef.current = multiplayerExpected;
  const multiplayerRebase = useCallback((rebase: CanvasMultiplayerRebase) => {
    const prev = docRef.current;
    const next = rebase.working(prev);
    // Undo and redo steps take others' changes only: this page's own saved edit stays theirs to take back. Each step also
    // keeps the paths others changed (multiplayer/history.ts): one the page's own edit had changed too still holds the
    // page's older value, which its undo must not put back over theirs.
    const others = rebase.othersPaths ?? [];
    const carried = new globalThis.Map<CanvasDocument, CanvasDocument>();
    const carry = (step: CanvasDocument) => {
      let out = carried.get(step);
      if (!out) {
        out = rebase.history(step); carried.set(step, out);
        if (others.length) othersSince.current.set(out, withOthersPaths(othersSince.current.get(step), others));
      }
      return out;
    };
    undoStack.current = undoStack.current.map(carry);
    redoStack.current = redoStack.current.map(carry);
    if (planUndoEntry.current) planUndoEntry.current = carried.get(planUndoEntry.current) ?? planUndoEntry.current;
    if (next === prev) return;
    // A converged icon stays an icon for others' edits of its members' content; nodes or wires coming or going draw
    // the cards again, as another tab's document does.
    showAdopted(prev, next, true);
    docRef.current = next;
    setDoc(next);
    const kept = new Set(next.nodes.map(node => node.id));
    setSelection(previous => previous.some(id => !kept.has(id)) ? previous.filter(id => kept.has(id)) : previous);
    setFocusedId(previous => previous && !kept.has(previous) ? null : previous);
    setInspectorId(previous => previous && !kept.has(previous) ? null : previous);
  }, [showAdopted]);
  // Whether a run another page started may land its results here now, and the line that says it did (both set once the
  // lanes exist, below them): the host lands it (saas/runAdoption.ts) as a change no page of its own made.
  const canLandRef = useRef<(operationId: string, nodes: readonly string[]) => boolean>(() => false);
  const landedRef = useRef<(nodes: readonly string[], say: boolean) => void>(() => {});
  useEffect(() => {
    if (!multiplayer || readOnly) return;
    multiplayer.connect({ rebase: multiplayerRebase, ready: () => !setupRequest.current && !outdatedObserver.current,
      focus: nodeId => focusNodeRef.current(nodeId), document: () => docRef.current,
      canLand: (operationId, nodes) => canLandRef.current(operationId, nodes), landed: (nodes, say = true) => landedRef.current(nodes, say) });
    return () => multiplayer.connect(null);
  }, [multiplayer, multiplayerRebase, readOnly]);
  // This page's selection and open node, for everyone else on the canvas; its pointer goes from the board below.
  useEffect(() => { multiplayer?.presence({ selection }); }, [multiplayer, selection]);
  useEffect(() => { multiplayer?.presence({ focus: focusedId }); }, [multiplayer, focusedId]);
  // An opened node takes as much of the stage as its content can use (openFrameFor), less the Configure panel's room
  // while that floats beside it. Its frame and the camera that shows it come from one measurement of the stage
  // (openPlacement), so the card drawn is the card the camera framed, even before the stage's own measurement arrives;
  // `view` is that camera, which tells the app's camera from one the operator has taken since.
  // `narrow` is the narrow layout's width from that same measurement, `content` what the node showed, and `resized` a
  // frame the reader dragged to another size, which is theirs as a camera they moved is.
  const [openFit, setOpenFit] = useState<OpenFit | null>(null);
  const openFitRef = useRef(openFit);
  openFitRef.current = openFit;
  const focusedFit = openFit && openFit.id === focusedId ? openFit : null;
  const focusedOpenFrame = focusedFit?.frame;
  const focusNarrow = focusedFit ? focusedFit.narrow : narrowFocusWidth(size.w);
  const focusExact = Boolean(focusedFit?.resized);
  // The delivery drawers tiles hold where the drawer's rule (deliverablesShown) closes them: one an edit of its form kept
  // open once it took the delivery back (SessionTile onHoldDeliverables). The canvas counts them as shown for a close,
  // which is remembered as closing a shown drawer is (toggleDeliverables), and a node opened without a frame of its own
  // keeps the drawer's room (presentationNodes). Never saved.
  const [heldDrawers, setHeldDrawers] = useState<ReadonlySet<string>>(() => new Set());
  const heldDrawersRef = useRef(heldDrawers);
  heldDrawersRef.current = heldDrawers;
  const holdDeliverables = useCallback((nodeId: string, held: boolean) => setHeldDrawers(previous => {
    if (previous.has(nodeId) === held) return previous;
    const next = new Set(previous);
    if (held) next.add(nodeId); else next.delete(nodeId);
    return next;
  }), []);
  const focusHeld = focusedId !== null && heldDrawers.has(focusedId);
  // A node drawn as it was keeps the object it was drawn with: each one is a tile's geometry, and tiles are memoised on
  // their props, so a fresh copy of every card for any one node's edit would re-render the whole canvas.
  const drawnNodes = useRef(new globalThis.Map<string, { node: CanvasNode; drawn: CanvasNode }>());
  const renderNodes = useMemo(() => {
    const drawn = presentationNodes(nodes, focusedId, focusNarrow, cardFrames, focusedOpenFrame, focusExact, focusHeld);
    const kept = new globalThis.Map<string, { node: CanvasNode; drawn: CanvasNode }>();
    const stable = drawn.map((next, index) => {
      const held = drawnNodes.current.get(next.id);
      const same = held && held.node === nodes[index] && held.drawn.w === next.w && held.drawn.h === next.h ? held.drawn : next;
      kept.set(next.id, { node: nodes[index], drawn: same });
      return same;
    });
    drawnNodes.current = kept;
    return stable;
  }, [nodes, focusedId, focusNarrow, cardFrames, focusedOpenFrame, focusExact, focusHeld]);
  const renderNodeById = useMemo(() => new globalThis.Map(renderNodes.map(node => [node.id, node])), [renderNodes]);
  // The board as drawn with converged groups: their members' cards give way to one icon each, and the wires that cross
  // a group's edge end on its icon (convergedGroups.ts). renderNodes stays the geometry every card is drawn from.
  const nodeIdsKey = nodes.map(node => node.id).join('\u0001');
  // The components the icon counts and rings: forms are inputs, not steps (two of them are no canvas to converge).
  const stepCount = useMemo(() => countSteps(nodes), [nodes]);
  const groupsDrawn = useMemo(() => drawnGroups(converged, nodeIdsKey ? nodeIdsKey.split('\u0001') : [], stepCount), [converged, nodeIdsKey, stepCount]);
  const convergedView = useMemo(() => convergeView(renderNodes, edges, groupsDrawn, { w: CONVERGED_ICON_WORLD, h: CONVERGED_ICON_WORLD }),
    [renderNodes, edges, groupsDrawn]);
  convergedViewRef.current = convergedView;
  // Whether a member is inside an icon now: undo and redo wait until the cards are drawn (they would change one unseen).
  const membersHidden = convergedView.hidden.size > 0;
  // The cards the board draws: every node but the members inside an icon (the same objects as renderNodes).
  const shownNodes = useMemo(() => convergedView.hidden.size ? renderNodes.filter(node => !convergedView.hidden.has(node.id)) : renderNodes,
    [renderNodes, convergedView]);
  // Nothing acts on a node the board does not draw: a member converged into an icon leaves the selection, so Delete,
  // 运行选区, arranging and the review bar never reach it unseen. Before paint, so they are never drawn for a frame; and
  // only over the selection this render saw: one set since (a node being opened) is the next render's to check.
  useLayoutEffect(() => {
    if (!convergedView.hidden.size || !selection.some(id => convergedView.hidden.has(id))) return;
    setSelection(previous => previous === selection ? previous.filter(id => !convergedView.hidden.has(id)) : previous);
  }, [convergedView, selection]);
  // A converged canvas with fewer than two components is not converged, as a group of one dissolves: the toggle never
  // stays pressed over cards, and what is added later is not put away. An icon that was drawn and went (another tab left
  // fewer than two) is said, and the focus it took goes to the toggle; a preference kept from before, on a canvas that
  // has fewer than two components by the time it opens, is let go without a word, as nothing was converged. Before paint,
  // so the toggle is never drawn pressed for a frame. (The surface mounts with its document: the SaaS app once the
  // canvas's record is in, the local edition from the local copy.)
  const canvasIconDrawn = convergedView.icons.some(icon => icon.id === CANVAS_GROUP_ID);
  const canvasIconWasDrawn = useRef(false);
  useLayoutEffect(() => {
    const was = canvasIconWasDrawn.current;
    canvasIconWasDrawn.current = canvasIconDrawn;
    if (canvasIconDrawn || !converged.canvas) return;
    const next = { ...convergedNowRef.current, canvas: false };
    if (was) showConverged(next, t('converge.announce.expanded', { title: t('converge.wholeCanvas') }));
    else { convergedNowRef.current = next; setConverged(next); setSelectedIconId(null); }
  }, [canvasIconDrawn, converged.canvas, showConverged, t]);
  // The components drawn as icons in the icon view: every one the board draws, but the open or configured node (its card
  // is what is being read). Group icons stay group icons, and their members are not drawn (so a canvas converged whole
  // has none).
  const iconIdsKey = iconView
    ? shownNodes.filter(node => node.id !== focusedId && node.id !== inspectorId).map(node => node.id).join('\u0001') : '';
  const iconIds = useMemo<ReadonlySet<string>>(() => new Set(iconIdsKey ? iconIdsKey.split('\u0001') : []), [iconIdsKey]);
  // The board as the icon view draws it (nodeIcons.ts): the wires and each icon's ports meet its round band; the marks, the
  // marquee, the minimap, the collaboration flow and display links its plate. The very arrays while nothing is an icon.
  const iconWireNodes = useMemo(() => withIconGeometry(convergedView.wireNodes, iconIds, 'wire'), [convergedView.wireNodes, iconIds]);
  const shownBoxes = useMemo(() => withIconGeometry(shownNodes, iconIds, 'plate'), [shownNodes, iconIds]);
  // A 预览展示 window showing a converged member links to its member's icon; in the icon view, to the component's icon.
  const linkBoxes = useMemo<ReadonlyMap<string, { x: number; y: number; w: number; h: number }>>(() => {
    if (!convergedView.icons.length && !iconIds.size) return renderNodeById;
    const boxes = new globalThis.Map<string, { x: number; y: number; w: number; h: number }>(renderNodeById);
    for (const icon of convergedView.icons) for (const id of icon.members) boxes.set(id, { x: icon.x, y: icon.y, w: icon.w, h: icon.h });
    for (const node of shownBoxes) if (iconIds.has(node.id)) boxes.set(node.id, { x: node.x, y: node.y, w: node.w, h: node.h });
    return boxes;
  }, [renderNodeById, convergedView, iconIds, shownBoxes]);
  // An opened node never stays inside an icon: every way of opening one (a double-click, the Bot list, search, the
  // timeline, results, next steps, Configure) goes through focusNode, which draws its group's cards again first.
  const expandGroupOfNode = useCallback((nodeId: string) => {
    const state = convergedNowRef.current;
    showConverged(expandForNode(state, nodeId), state.canvas
      ? tLatest.current('converge.announce.expanded', { title: tLatest.current('converge.wholeCanvas') }) : tLatest.current('converge.announce.shown'));
  }, [showConverged]);
  // Focus pushes the pre-focus viewport so a second press returns exactly where you were.
  const focusReturn = useRef<ViewportState | null>(null);

  // Viewport size for the fit math. The reported size comes from the viewport's own measure +
  // ResizeObserver, but BOTH can still be 0 at the moment a fit is requested: the mount measure
  // runs before layout settles, and RO callbacks are delivered on frame boundaries, which stall in
  // a backgrounded/non-compositing tab. Falling back to a live measurement turns what would be a
  // silent no-op (press ⌘E, nothing happens, no way to tell why) into the action the user asked
  // for. Returns null only when there is genuinely nothing laid out to fit into.
  // `cover`: how much of the stage's left edge the assistant sidebar covers where it floats over the stage (the hosted
  // workspace with a model library lays it over the board): fits use the stage right of it. `configuring`: whether
  // the fit is for the stage with Configure open (by default, whether it is open now); where Configure raises the board
  // above the sidebar, nothing is covered.
  const viewportSize = useCallback((configuring = inspectorRef.current !== null): StageBox | null => {
    const root = rootRef.current;
    const r = root?.getBoundingClientRect();
    if (root && r && r.width > 0) return { w: r.width, h: r.height, cover: configuring && configureRaisesBoard(root) ? 0 : sidebarCover(root, r) };
    return sizeRef.current.w > 0 ? sizeRef.current : null;
  }, []);

  const fitAll = useCallback(() => {
    // Configure closes here (the ref still says it is open): the fit is for the board without it.
    const box = viewportSize(false);
    if (!nodes.length || !box || inspectorCloseLocked.current) return;
    setInspectorId(null);
    setFocusedId(null);
    focusReturn.current = null;
    autoFit(nodes, box);
  }, [nodes, viewportSize, autoFit]);

  useEffect(() => {
    if (fitted.current || size.w === 0) return;
    const saved = savedView.current;
    // An empty graph has nothing to fit; a saved view keeps owning the camera, an unpositioned
    // canvas waits for its first node.
    if (nodes.length === 0) { if (saved) fitted.current = true; return; }
    fitted.current = true;
    // The board as it is with Configure closed: a node open (and configured) now returns to it.
    const box: StageBox = viewportSize(false) || size;
    // A kept saved view already shows the whole graph, so it counts as fitted: a later stage change
    // may refit it, exactly as it would the overview computed below. It shows it only in the part a
    // sidebar floating over the stage leaves (simple mode opens the assistant with the canvas).
    const cover = box.cover ?? 0;
    const keepSaved = Boolean(saved && boundsWithinViewport(boundsOfNodes(presentationNodes(nodes, null)), shiftView(saved, -cover), { w: box.w - cover, h: box.h }));
    // A node opened before the stage's first size arrived owns the camera: no overview is fitted over it. Closing it
    // lands on the overview of the stage it closes on (restoreFocusCamera), not on the camera the canvas started with,
    // which may not show the graph at all (none saved: the app's default camera); a saved view that shows it stays,
    // and so does a camera the operator took before opening the node (a pan, a zoom, a waypoint).
    if (focusedRef.current !== null) {
      overviewOnReturn.current = !keepSaved && focusReturn.current !== null && isFittedCamera(focusReturn.current, startupCamera.current);
      return;
    }
    if (keepSaved) {
      lastAutoView.current = viewRef.current;
      return;
    }
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
      // The camera as it will be once a glide in progress lands (closing a node glides back to the overview): a passing
      // frame is not the operator's camera.
      if (focusedRef.current !== null || inspectorCloseLocked.current || !isFittedCamera(glideTarget.current ?? viewRef.current, lastAutoView.current)) return;
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
  // After a control that had focus goes away (it unmounted, its view closed, or a part of the page around it was hidden,
  // as the assistant's panel is when it steps aside), focus moves to `selector`.
  const moveLostFocus = useCallback((selector: string) => {
    if (!focusIsLost()) return;
    rootRef.current?.closest('.awwo-workspace')?.querySelector<HTMLElement>(selector)?.focus();
  }, []);
  // At the next frame, by which React has drawn a change made in a click or a key press. A change made after awaiting
  // the server is drawn in a scheduler task, which a frame can come before: such a change moves the focus in the commit
  // that draws it instead (refocusInCommit).
  const refocus = useCallback((selector: string) => { requestAnimationFrame(() => moveLostFocus(selector)); }, [moveLostFocus]);
  // In the commit that draws the change it is asked for with: for a change made after awaiting the server, in an effect
  // or in a frame. Each request is a new object, so the same selector asked for again is looked at again.
  const [focusRequest, setFocusRequest] = useState<{ selector: string } | null>(null);
  useLayoutEffect(() => { if (focusRequest) moveLostFocus(focusRequest.selector); }, [focusRequest, moveLostFocus]);
  const refocusInCommit = useCallback((selector: string) => setFocusRequest({ selector }), []);
  refocusToggle.current = () => refocusInCommit('[data-converge-toggle]');
  // The icon view draws an opened component as its card and a closed one as its icon again, so the focus that was in the
  // one goes to the other: the opened card's close button (or its first control), the icon's button. Without scrolling:
  // the board is moved by its camera, never by a scroll. Matched by attribute value, so no id is read as a selector.
  // When a pointer last went down on the board: a focus that comes with a press is the press's, and never moves the camera.
  const lastBoardPress = useRef(0);
  const noteBoardPress = useCallback(() => { lastBoardPress.current = Date.now(); }, []);
  const trackIconFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const id = target.closest?.<HTMLElement>('[data-node-icon]')?.dataset.nodeIcon ?? null;
    keyIconRef.current = id;
    setKeyIcon(id);
    // The keyboard's focus on a part of an icon the stage does not show whole, less what a floating assistant covers (its
    // button, or a port past the stage's edge; the board's one stop entered by Tab, the next icon after a deletion): the
    // camera goes to the icon, in the part of the stage left, as ⌘[ ] does.
    const root = rootRef.current;
    if (!id || !root || Date.now() - lastBoardPress.current < 600) return;
    const stage = root.getBoundingClientRect();
    const box = viewportSize();
    const part = target.getBoundingClientRect();
    if (!stage.width || !box) return;
    const left = stage.left + (box.cover ?? 0);
    if (part.left >= left && part.right <= stage.right && part.top >= stage.top && part.bottom <= stage.bottom) return;
    const node = docRef.current.nodes.find(candidate => candidate.id === id);
    if (!node) return;
    const plate = nodeIconBox(node);
    const cover = box.cover ?? 0;
    moveCamera(shiftView(focusWorld(viewRef.current, plate.x + plate.w / 2, plate.y + plate.h / 2, { w: box.w - cover, h: box.h }), cover));
  }, [moveCamera, viewportSize]);
  // The focus left the board, or went to nothing while its control is still there (a press on the board's background):
  // no icon has it any more. Not when the page itself lost the focus (another tab or app, which gives it back to the same
  // control), nor for the icon's own removal (the board gives the focus on then).
  const releaseIconFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const was = (event.target as HTMLElement).closest?.<HTMLElement>('[data-node-icon]')?.dataset.nodeIcon ?? null;
    if (!was) return;
    const letGo = () => { if (keyIconRef.current === was) { keyIconRef.current = null; setKeyIcon(null); } };
    const next = event.relatedTarget as Node | null;
    if (next) { if (!event.currentTarget.contains(next)) letGo(); return; }
    const target = event.target as Node;
    setTimeout(() => { if (target.isConnected && document.hasFocus()) letGo(); }, 0);
  }, []);
  const focusNodePart = useCallback((nodeId: string, part: 'icon' | 'card', unlessHeld = true) => {
    if (unlessHeld && !focusIsLost()) return false;
    const root = rootRef.current;
    if (!root) return false;
    const target = part === 'icon'
      ? [...root.querySelectorAll<HTMLElement>('[data-node-icon]')].find(element => element.dataset.nodeIcon === nodeId)
        ?.querySelector<HTMLElement>('.awwo-node-icon-hit')
      : (() => {
        const card = [...root.querySelectorAll<HTMLElement>('.canvas-tile[data-node-id]')].find(element => element.dataset.nodeId === nodeId);
        return card?.querySelector<HTMLElement>('[data-collapse-node]:not(:disabled)') ?? card?.querySelector<HTMLElement>(CARD_CONTROLS);
      })();
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  }, []);
  useLayoutEffect(() => {
    if (iconFocusRequest && !focusNodePart(iconFocusRequest.id, 'icon', false)) moveLostFocus('[data-icon-view-toggle]');
  }, [iconFocusRequest, focusNodePart, moveLostFocus]);
  const iconFocus = useRef({ focusedId, iconIds });
  useLayoutEffect(() => {
    const before = iconFocus.current;
    iconFocus.current = { focusedId, iconIds };
    if (focusedId && focusedId !== before.focusedId && before.iconIds.has(focusedId)) focusNodePart(focusedId, 'card');
    else if (before.focusedId && before.focusedId !== focusedId && iconIds.has(before.focusedId)) {
      // Its icon is off the board when the camera went back at once (reduced motion): the toggle, never the page.
      if (focusIsLost() && !focusNodePart(before.focusedId, 'icon', false)) moveLostFocus('[data-icon-view-toggle]');
    }
  }, [focusedId, iconIds, focusNodePart, moveLostFocus]);
  // The icon with the focus gone from the board (its component deleted, here or by someone else, an undo, a plan; not
  // opened, which the card takes): the focus goes on to the next icon in reading order on the stage (so another's
  // deletion never moves this reader's camera), else the next one drawn, else the next at all (drawn first, then focused),
  // else the toggle; never the page.
  const iconOrder = useRef<ReadonlyArray<string>>([]);
  useLayoutEffect(() => {
    const before = iconOrder.current;
    iconOrder.current = orderNodes(shownBoxes.filter(node => iconIds.has(node.id))).map(node => node.id);
    const lost = keyIconRef.current;
    if (!lost || iconIds.has(lost) || lost === focusedId) return;
    keyIconRef.current = null;
    setKeyIcon(null);
    if (!focusIsLost()) return;
    const at = before.indexOf(lost);
    const after = [...before.slice(at + 1), ...before.slice(0, Math.max(0, at))].filter(id => iconIds.has(id));
    if (!after.length) { moveLostFocus('[data-icon-view-toggle]'); return; }
    const box = viewportSize();
    const cover = box?.cover ?? 0;
    const plates = shownBoxes.filter(node => after.includes(node.id));
    const onStage = box ? visibleBoxIds(plates, shiftView(viewRef.current, -cover), { w: box.w - cover, h: box.h }, 0) : new Set<string>();
    if ([...after.filter(id => onStage.has(id)), ...after].some(id => focusNodePart(id, 'icon', false))) return;
    keyIconRef.current = after[0];
    setKeyIcon(after[0]);
    setIconFocusRequest({ id: after[0] });
  }, [iconIds, shownBoxes, focusedId, focusNodePart, moveLostFocus, viewportSize]);

  /** Where a node opens on this stage, from the camera `current`: the frame its content can use (openFrameFor) and the
   *  camera that shows it whole, opened where it is — never re-centred. Null when nothing is laid out to fit into.
   *  `content` keeps the room of what the node showed; `preferredScale` is the operator's zoom, kept where readable. */
  const openPlacement = useCallback((nodeId: string, configuring: boolean, currentOnStage: ViewportState,
    options: { content?: OpenContent; preferredScale?: number; frame?: { w: number; h: number } } = {}) => {
    const stage = viewportSize(configuring);
    const target = docRef.current.nodes.find((n) => n.id === nodeId);
    if (!stage || !target) return null;
    const besidePanel = configuring && (canInitialize || target.kind !== 'session');
    // Opened to be configured (or re-fitted while its inspector is open) where the inspector floats
    // over the stage (cloud canvases, forms), the node keeps clear of it, as far as it can while
    // staying readable: the reserve shrinks before the node would drop below the readable scale.
    // Where the inspector spans the stage instead (the hosted app at 760 px and below), nothing is
    // reserved.
    const spansStage = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 760px)').matches)
      && Boolean(rootRef.current?.closest('.saas-canvas-shell'));
    const reserving = besidePanel && !spansStage;
    const pad = FOCUS_FIT_PADDING;
    // Placed in the stage right of `cover`, the width of its left edge under a floating sidebar: everything is measured
    // there (the camera too: its x is moved by the covered width), and the camera is moved back at the end.
    const place = (cover: number) => {
      const box = { w: stage.w - cover, h: stage.h };
      const current = shiftView(currentOnStage, -cover);
      // The narrow layout is a narrow stage's (a phone, a tablet), and a wider one's whose part right of the sidebar has
      // no room for an open frame; there as wide as that part. Beside a sidebar the node otherwise keeps its frame,
      // sized to that part.
      const frameless = box.w - pad.x * 2 < FOCUSED_SESSION_MIN_SIZE.w;
      const narrow = narrowFocusWidth(stage.w) || frameless ? narrowFocusWidth(box.w) : undefined;
      const frame = options.frame ?? openFrameFor(target, openRoom(box, besidePanel), options.content);
      const node = presentationNodes(docRef.current.nodes, nodeId, narrow, undefined, frame, Boolean(options.frame), heldDrawersRef.current.has(nodeId))
        .find((n) => n.id === nodeId)!;
      // Cap the focus scale so the whole node — delivery drawer included — fits the stage inside the focus padding.
      const availH = Math.max(120, box.h - pad.top - pad.bottom);
      const inspectorRoom = INSPECTOR_OVERLAY.inset + Math.min(INSPECTOR_OVERLAY.width, box.w - INSPECTOR_OVERLAY.inset * 2) + INSPECTOR_OVERLAY.gap;
      const readable = Math.min(MIN_READABLE_FIT_SCALE, availH / Math.max(1, node.h));
      const right = reserving ? Math.max(pad.x, Math.min(inspectorRoom, box.w - pad.x - node.w * readable)) : pad.x;
      const availW = Math.max(120, box.w - pad.x - right);
      const maxScale = Math.min(1.25, availW / Math.max(1, node.w), availH / Math.max(1, node.h));
      // The operator's own zoom when it is readable and the node fits; else a node drawn at its open frame opens at
      // 100 % (the frame is sized for it; less only where a node resized by hand needs it), and one on a narrow stage
      // as large as fits. The card's corner stays where it sat on screen, moved only as far as the stage needs.
      const atFrame = Boolean(frame) && !narrow;
      const preferred = options.preferredScale ?? current.scale;
      const scale = preferred >= 1 && preferred <= maxScale ? preferred : atFrame ? Math.min(1, maxScale) : maxScale;
      const view = shiftView(openInPlace(current, { minX: node.x, minY: node.y, maxX: node.x + node.w, maxY: node.y + node.h }, box, scale, { ...pad, right }), cover);
      const placement = { frame, view, anchor: { x: node.x, y: node.y }, narrow, content: options.content ?? openContentOf(target) };
      return { placement, squeezed: reserving && right < inspectorRoom };
    };
    const cover = stage.cover ?? 0;
    const beside = place(cover);
    // Configured where the part right of the sidebar leaves no readable room beside the inspector, the node opens as
    // without the sidebar: clear of the panel in use, which the reserve would otherwise give up.
    return cover > 0 && beside.squeezed ? place(0).placement : beside.placement;
  }, [viewportSize, canInitialize]);

  // Steps the assistant's panel aside for the node being opened (set once the panel's state exists below), and whether it
  // has stepped aside for the node open now.
  const stowAssistantRef = useRef<(nodeId: string) => void>(() => {});
  const assistantStowedRef = useRef(false);
  const focusNode = useCallback(
    (nodeId: string, options: { configure?: boolean } = {}) => {
      if (inspectorCloseLocked.current) return;
      // Opening a node always shows the board.
      changeStageView('canvas');
      if (!docRef.current.nodes.some((n) => n.id === nodeId)) return;
      // Where the floating assistant leaves the board no readable room (a narrow window, or a phone where it spans the
      // stage), the node opens as without it, so under it: the assistant steps aside while the node is open (also for
      // the next node opened from it), back once it closes; 画布助手 brings it back over the node.
      const root = rootRef.current;
      const stageBox = root?.getBoundingClientRect();
      if (assistantStowedRef.current || (root && stageBox && stageBox.width > 0 && floatingSidebar(root, stageBox)?.cramped)) {
        stowAssistantRef.current(nodeId);
      }
      const configuring = Boolean(options.configure) || inspectorRef.current === nodeId;
      // The camera as it will be once a glide in progress lands: reopening mid-glide must not take a
      // passing frame for the operator's camera.
      const current = glideTarget.current ?? viewRef.current;
      // The operator's camera is kept from the first open until the node is left: every way out clears
      // it, so an empty one means nothing is open, whatever render this callback came from.
      if (focusReturn.current === null) focusReturn.current = current;
      if (focusedId !== nodeId) setInspectorId(current => current === nodeId ? current : null);
      expandGroupOfNode(nodeId);
      setFocusedId(nodeId);
      setSelection([nodeId]);
      // Placing the node already open again (Configure, 查看交付物, a 接下来 step) keeps its delivery's room and a frame
      // the reader resized by hand.
      const kept = openFitRef.current?.id === nodeId && focusedRef.current === nodeId ? openFitRef.current : null;
      const target = docRef.current.nodes.find(n => n.id === nodeId);
      const content = kept && target && kept.content === 'delivery' && openContentOf(target) === 'chat' ? kept.content : undefined;
      const placement = openPlacement(nodeId, configuring, current, { content, ...(kept?.resized ? { frame: kept.frame } : {}) });
      setOpenFit(placement ? { id: nodeId, frame: placement.frame, view: placement.view, narrow: placement.narrow, content: placement.content,
        ...(kept?.resized ? { resized: true } : {}) } : null);
      if (placement) glideTo(placement.view, placement.anchor);
    },
    [focusedId, openPlacement, glideTo, changeStageView, expandGroupOfNode],
  );
  // The latest focusNode, for a focus deferred to the next frame (an older one judges a stale render).
  const focusNodeRef = useRef(focusNode);
  focusNodeRef.current = focusNode;
  // The open node takes its new room when what it opens at changes — the stage changed shape (the assistant panel
  // opened or closed, the window was resized), Configure opened or closed beside it, its first delivery arrived — once
  // the change has settled, and only while the camera is still the one the app opened it with: a camera the operator
  // zoomed or panned since is theirs, and so is a frame they resized; the node keeps its frame under it. A run that
  // clears its delivery does not take back the delivery's room.
  const focusedNode = focusedId ? nodes.find(node => node.id === focusedId) : undefined;
  const focusedContent = focusedNode ? openContentOf(focusedNode) : null;
  const configuringFocused = Boolean(focusedId && inspectorId === focusedId);
  useEffect(() => {
    if (!focusedId) return;
    const timer = setTimeout(() => {
      const fit = openFitRef.current;
      if (focusedRef.current !== focusedId || !fit || fit.id !== focusedId || fit.resized || inspectorCloseLocked.current) return;
      if (!isFittedCamera(glideTarget.current ?? viewRef.current, fit.view)) return;
      const node = docRef.current.nodes.find(candidate => candidate.id === focusedId);
      const content = node && fit.content === 'delivery' && openContentOf(node) === 'chat' ? fit.content : undefined;
      const placement = openPlacement(focusedId, inspectorRef.current === focusedId, fit.view,
        { content, preferredScale: focusReturn.current?.scale });
      if (!placement) return;
      const sameFrame = placement.frame?.w === fit.frame?.w && placement.frame?.h === fit.frame?.h && placement.narrow === fit.narrow;
      const sameView = Math.abs(placement.view.x - fit.view.x) < 0.5 && Math.abs(placement.view.y - fit.view.y) < 0.5
        && Math.abs(placement.view.scale - fit.view.scale) <= 1e-9 * Math.max(1, fit.view.scale);
      if (sameFrame && sameView) return;
      setOpenFit({ id: focusedId, frame: placement.frame, view: placement.view, narrow: placement.narrow, content: placement.content });
      glideTo(placement.view, placement.anchor);
    }, REFIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [focusedId, size.w, size.h, railsVersion, configuringFocused, focusedContent, bindingLocked, openPlacement, glideTo]);

  const arrangeNodes = useCallback(() => {
    // Arranging moves every card: not while cards are drawn as icons (they would move unseen).
    if (convergedViewRef.current?.icons.length) return;
    if (!canEditStructure(false, [])) return;
    const arranged = arrangeNodePositions(docRef.current.nodes, docRef.current.edges);
    patchDoc(previous => ({ ...previous, nodes: arranged }), { label: 'arrange:nodes' });
    setInspectorId(null);
    setFocusedId(null);
    focusReturn.current = null;
    const box = viewportSize(false);
    if (box) autoFit(arranged, box);
  }, [canEditStructure, patchDoc, viewportSize, autoFit]);

  /** The camera the operator had before opening a node, glided back to (and forgotten), so leaving a
   *  node — closing it, deleting it, adding a review partner from it — lands where they were. */
  const restoreFocusCamera = useCallback(() => {
    const back = focusReturn.current;
    focusReturn.current = null;
    const overview = overviewOnReturn.current;
    overviewOnReturn.current = false;
    // Only an open node has a camera to return from; with none open, a leftover one is just forgotten.
    if (!back || !focusedRef.current) return;
    // The canvas's first fit, put off while the node was open: the overview of the stage now, the app's camera (a later
    // stage change may refit it, and it is not saved as the operator's).
    const box = overview && docRef.current.nodes.length ? viewportSize(false) : null;
    const target = box ? overviewCamera(docRef.current.nodes, box) : back;
    if (box) { lastAutoView.current = target; unsavedCamera.current = target; }
    const node = docRef.current.nodes.find(candidate => candidate.id === focusedRef.current);
    if (node) glideTo(target, { x: node.x, y: node.y });
    else moveCamera(target);
  }, [glideTo, moveCamera, viewportSize, overviewCamera]);

  const unfocus = useCallback(() => {
    if (inspectorCloseLocked.current) return;
    setInspectorId(null);
    restoreFocusCamera();
    setFocusedId(null);
  }, [restoreFocusCamera]);

  // Every tile takes these (a double-click, its open button, Configure): they read the selection and the open node of the
  // latest render instead of closing over them, so they keep their identity when a press changes the selection and the
  // memoised tiles are not all re-rendered for it.
  const toggleFocus = useCallback(
    (nodeId?: string) => {
      const focusedIcon = keyIconRef.current && selectionRef.current.includes(keyIconRef.current) ? keyIconRef.current : null;
      const target = nodeId ?? focusedIcon ?? selectionRef.current[0] ?? null;
      const open = focusedRef.current;
      if (open && (!nodeId || nodeId === open)) {
        unfocus();
        return;
      }
      if (target) focusNodeRef.current(target);
    },
    [unfocus],
  );
  const openNode = useCallback((nodeId: string) => focusNodeRef.current(nodeId), []);

  const cycle = useCallback(
    (dir: 1 | -1) => {
      // Through the cards the board draws: a member inside an icon is not stepped onto (nor selected unseen).
      const order = orderNodes(convergedView.hidden.size ? nodes.filter(node => !convergedView.hidden.has(node.id)) : nodes);
      const from = keyIconRef.current && selection.includes(keyIconRef.current) ? keyIconRef.current : selection[0];
      const nextId = nextIn(order, from ?? focusedId ?? null, dir);
      if (!nextId) return;
      if (focusedId) focusNode(nextId);
      else {
        setSelection([nextId]);
        const n = renderNodes.find((x) => x.id === nextId);
        if (n && sizeRef.current.w) {
          moveCamera(focusWorld(viewRef.current, n.x + n.w / 2, n.y + n.h / 2, sizeRef.current));
        }
        // The keyboard's focus on an icon goes on with the selection to the next icon.
        if (iconIds.has(nextId) && (document.activeElement as HTMLElement | null)?.closest?.('[data-node-icon]')) setIconFocusRequest({ id: nextId });
      }
    },
    [nodes, renderNodes, selection, focusedId, focusNode, moveCamera, convergedView, iconIds],
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
  // The cloud canvas runs this page saw end since it last said that work ended (onWorkSettled's graphIds): only runs it
  // started itself, in this load (their journals' ids), not one it found in a journal another load or tab left.
  const endedGraphs = useRef<string[]>([]);
  const startedJournals = useRef(new Set<string>());
  // A canvas run this page started whose journal is gone (another tab saw it end and let the journal go, or replaced it
  // with one of its own) is named at the end of the work this page watches: by the id its journal holds or, where its
  // admission answer was lost, by its operation (a read that fails names nothing).
  const nameOwnedGraph = async (owned: CanvasRunJournal | null | undefined, signal?: AbortSignal) => {
    if (!owned?.serverGraph || !startedJournals.current.has(owned.id)) return;
    const id = owned.serverGraph.id || await graphIdOfOperation(owned.serverGraph, owned.id,
      signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)).catch(() => undefined);
    if (id && startedJournals.current.delete(owned.id)) { endedGraphs.current.push(id); setNamedGraphs(count => count + 1); }
  };
  // Each run named: one named after the work it ended with was over still reaches the host (the run-end effect below).
  const [namedGraphs, setNamedGraphs] = useState(0);
  // Two nodes bound to one agent take turns, even when they run in different lanes.
  const agentQueue = useRef(new globalThis.Map<string, Promise<unknown>>());
  const [laneRuns, setLaneRuns] = useState<Array<Record<string, RunView>>>(() => RUN_LANES.map(lane => initialOf(lane)?.nodes ?? {}));
  const [laneRunning, setLaneRunning] = useState<boolean[]>(() => RUN_LANES.map(lane => Boolean(initialOf(lane))));
  const [laneRecovering, setLaneRecovering] = useState<boolean[]>(() => RUN_LANES.map(lane => Boolean(initialOf(lane))));
  const laneRecoveringRef = useRef(laneRecovering);
  laneRecoveringRef.current = laneRecovering;
  // Lanes never share a node, so their badges merge without conflict; a lane that starts takes its nodes' badges.
  const runs = useMemo(() => Object.assign({}, ...laneRuns) as Record<string, RunView>, [laneRuns]);
  const settledRuns = useRef(runs);
  settledRuns.current = runs;
  // The lanes seen running after recovery settled: when their work ends, the host hears of it (the run-end effect). A
  // page repair the service refused before it ran takes its lane back out: it was no run (endRefusedRepair).
  const watchedLanes = useRef(new Set<number>());
  // Badges a page repair the service refused before it ran gave back to their node (endRefusedRepair): the host heard of
  // them when their own run ended, so they are no news when other work ends (the run-end effect).
  const givenBackBadges = useRef(new WeakSet<RunView>());
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
  laneGuard.current = {
    busy: (exceptLane?: number) => {
      const busy = busyNodeIds(exceptLane);
      // 多人同屏: the nodes others' runs hold are changed here no more than this page's own running ones. A node of one
      // of this page's own lanes is its own run's (AwwO shows those as running too), which its lane may still write.
      const remote = multiplayerRef.current?.busyNodes?.();
      if (remote?.size) {
        const mine = busyNodeIds();
        for (const id of remote) if (!mine.has(id)) busy.add(id);
      }
      return busy;
    },
    active: anyLaneActive, exclusive: exclusiveLaneActive,
  };
  laneGuardLaneActive.current = laneActive;
  // 多人同屏: a run another page started, which ended with results no page published (saas/runAdoption.ts), lands only
  // where nothing here holds what it writes: never a run a lane of this page holds, nor beside a run that holds the whole
  // canvas, nor on nodes a lane here runs (a start not yet accepted too), someone else's run holds or a chat is talking
  // on, nor while node setup rewrites the document or the page is out of date.
  canLandRef.current = (operationId, nodes) => {
    if (readOnlyRef.current || outdatedObserver.current || setupRequest.current || !mounted.current || exclusiveLaneActive()) return false;
    if (RUN_LANES.some(lane => laneJournal(lane)?.id === operationId)) return false;
    const busy = busyNodeIds(undefined, true);
    for (const id of multiplayerRef.current?.busyNodes?.() ?? []) busy.add(id);
    if (nodes.some(id => busy.has(id))) return false;
    return !hasStreamingConversation(docRef.current.nodes.filter(node => nodes.includes(node.id)));
  };
  // Its results are on the canvas (the host's save was taken): the page says so, and reads again the conversations of its
  // nodes this page has loaded and is not talking in, which the run's turns joined (as a lane does when it lands one).
  landedRef.current = (nodes, say) => {
    if (say) setHandoffNote(surfaceNotice(t, 'graph_recovery_complete'));
    for (const node of docRef.current.nodes) {
      if (node.kind !== 'session' || !nodes.includes(node.id)) continue;
      const storeKey = sessionStoreKey(node);
      const session = getSessionSnapshot(storeKey);
      if (session.history !== 'loaded' || session.streaming) continue;
      forgetNode(storeKey);
      void restoreHistory({ gatewayBase: gatewayApiBase(), node, signal: AbortSignal.timeout(15000) }).catch(() => undefined);
    }
  };
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
  // The question a run of the whole canvas asks before it runs nodes again that have their result (RerunConfirm.tsx);
  // `changed` once the canvas changed under it and it was asked again.
  const [rerunChoice, setRerunChoice] = useState<(WholeRunChoice & { changed?: boolean }) | null>(null);
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
        const previous = laneList[lane].journal.current;
        if (previous && previous.id !== active.id) void nameOwnedGraph(previous);
        laneList[lane].journal.current = active; setRuns(timelineRuns({}, active.nodes, Date.now())); setReviewRound(active.review?.round ?? 0); setRunning(true); setRecovering(true);
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
    // A server graph's run is read whole at this observer's first poll, which keeps the canvas it froze at admission, and
    // without that canvas at every poll after (observeCloudGraph): a film's is about a megabyte, polled every 2.5 s.
    const observation: GraphObservation = {};
    // The journals (by id) whose runs the server has answered for to this observer: a canvas run already ended at its
    // journal's first answer, here or after another tab put that journal in place of one read before, is landed by the
    // host (below), which, where 多人同屏 is on, connects a moment after the canvas opens: it is waited for.
    const answeredJournals = new Set<string>();
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
      const saved = lastSaved.current?.canonical() ?? null;
      return live === saved || sansCamera(live) === sansCamera(saved)
        || Boolean(pending && pending.document === live
        && pending.storageKey === capturedDocumentKey && pending.journalId === (loadRunJournal()?.id ?? journal.current?.id));
    };
    const canWriteRecovery = () => {
      if (!observerIsActive()) return false;
      const cached = loadDocumentWithStatus({ readOnly: true });
      // Scoped fingerprints omit unrelated nodes, drafts and history. Protect the complete
      // durable base AND any unsaved source edits in this page before rewriting the cache.
      // Only an exact recovery result that this observer failed to save may be retried.
      if (cached.status !== 'ok' || canonicalCanvasDocumentJSON(cached.doc) !== lastSaved.current?.canonical()) return pauseOutdatedObserver();
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
        // 多人同屏: a canvas run whose journal another tab let go (it handed the run over to its host, or finished it) is
        // this page's host's to land too (a run landed already is found landed there, and the conversations of its steps
        // loaded here are read again). No tab's copy of the canvas is taken: the live changes keep this page's in step,
        // and a copy behind it would go back as an edit of its own. The host connects a moment after the canvas opens.
        const left = journal.current;
        const canvasRun = Boolean(left?.serverGraph && !left.manual);
        if (canvasRun && !multiplayerRef.current?.landEnded && multiplayerExpectedRef.current) {
          timer = setTimeout(() => void poll(), 500); return;
        }
        const takeOver = multiplayerRef.current?.landEnded;
        if (left?.serverGraph && canvasRun && takeOver) {
          // A run whose admission answer this page never heard is found by its operation first (a lookup that fails is
          // asked again at the next look; one that finds none, a run never admitted, hands nothing over). Both reads end
          // before the lane goes: letting it go stops this observer, and its reads with it.
          let id = left.serverGraph.id;
          if (!id) {
            try { id = await graphIdOfOperation(left.serverGraph, left.id, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])); }
            catch {
              if (observerIsActive()) timer = setTimeout(() => void poll(), 2500);
              return;
            }
            if (!observerIsActive()) return;
          }
          // A run this page started is named as it ends here, as ever.
          if (id) await nameOwnedGraph({ ...left, serverGraph: { ...left.serverGraph, id } }, controller.signal);
          if (!observerIsActive()) return;
          if (id) takeOver(id);
          // A journal put in the lane meanwhile (Stop here, another tab's run) is this lane's to follow: looked at again.
          if (journal.current !== left || loadRunJournal()) { timer = setTimeout(() => void poll(), 2500); return; }
          // Its badges here are the run's as it went, and it is over: they go, as when another tab finishes a run.
          journal.current = null; setRecovering(false); setRunning(false); setRuns({}); setReviewRound(0);
          setHandoffNote(previous => previous === surfaceNotice(t, 'recovering_run') ? '' : previous);
          return;
        }
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
        // A run this page started is named as it ends here.
        if (observed?.serverGraph && startedJournals.current.has(observed.id)) {
          await nameOwnedGraph(observed, controller.signal);
          if (!observerIsActive()) return;
        }
        // Structural/session edits in another tab are possible after it clears the journal.
        // Do not publish our pre-fetch document over those edits or unlock a newer run.
        if (journal.current !== observed || loadRunJournal()
            || JSON.stringify(loadDocumentWithStatus().doc) !== JSON.stringify(current.doc)) { retry(); return; }
        if (!observerIsActive()) return;
        if (!hasNoUnsavedSourceEdits()) { pauseOutdatedObserver(); return; }
        // Another tab's run ended here: its outputs play out in an icon, a change it made to the canvas is drawn as cards.
        showAdopted(docRef.current, current.doc, true);
        docRef.current = current.doc; setDoc(current.doc);
        lastSaved.current = savedDocument(current.doc); lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY);
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
      const reconciled = await reconcileRunJournal(observed, docRef.current.nodes, gatewayApiBase(), controller.signal, observation);
      // The journal itself comes back when the server did not answer for its run.
      const answered = reconciled !== observed;
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
      // 多人同屏: a canvas run that had ended before this page took it up from its journal (a reopening) lands by the host's
      // versioned save (saas/useRunLanding.ts), which leaves what others published since it ended: this page's own write
      // of it would clear that. Its journal goes, and the host lands it or leaves the canvas as it is. One this page
      // started, or saw going, lands here as it always has.
      const handOver = multiplayerRef.current?.landEnded;
      const ended = !Object.values(next.nodes).some(node => node.state === 'running' || node.state === 'waiting');
      // A run the server never admitted (Stop found none by its operation) has nothing to land: its journal goes, applied
      // nowhere (applied, it would clear what anyone published on its steps since), whichever page started it.
      if (answered && ended && !next.manual && next.serverGraph && !next.serverGraph.id) {
        clearRunJournal(next.id); journal.current = null; startedJournals.current.delete(next.id); setRuns({}); setReviewRound(0);
        setRecovering(false); setRunning(false);
        setHandoffNote(previous => previous === surfaceNotice(t, 'recovering_run') ? '' : previous);
        return;
      }
      if (!answeredJournals.has(next.id) && !next.manual && next.serverGraph && !startedJournals.current.has(next.id)) {
        // Nothing of a canvas run's journal is applied before the server has answered for its run once (by its id, or by
        // its operation where the page never heard the id): a page closed while it went stored its steps as running, and
        // applied as they are they would clear what the canvas shows.
        if (!answered || (ended && !handOver && multiplayerExpectedRef.current)) {
          timer = setTimeout(() => void poll(), answered ? 500 : 2500); return;
        }
        if (ended && handOver && next.serverGraph.id) {
          // Its outcome shows here (each step's badge, the run's summary); its results are the host's to land.
          clearRunJournal(next.id); journal.current = null;
          setRuns(prev => timelineRuns(prev, next.nodes, Date.now())); setRunSummary(journalSummary(next));
          setRecovering(false); setRunning(false);
          setHandoffNote(previous => previous === surfaceNotice(t, 'recovering_run') ? '' : previous);
          handOver(next.serverGraph.id);
          return;
        }
      }
      answeredJournals.add(next.id);
      if (!saveRunJournal(next)) {
        setHandoffNote(surfaceNotice(t, 'storage_write_failed'));
        timer = setTimeout(() => void poll(), 2500); return;
      }
      journal.current = next;
      setRuns(prev => timelineRuns(prev, next.nodes, Date.now()));
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
        if (next.serverGraph?.id && startedJournals.current.delete(next.id)) endedGraphs.current.push(next.serverGraph.id);
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

  // Writes the tiles' last lines that wait to be written (writePreviews, set below) at once. A node setup and a run take
  // them in first, as they did when each line was written as it came: neither takes an edit to its nodes once it starts.
  const writePreviewsNow = useRef<() => void>(() => {});

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
    writePreviewsNow.current();
    const controller = new AbortController();
    setupRequest.current = controller; setInitializing(true); setHandoffNote('');
    try {
      // Save the synchronous ref now: React's document effect has not necessarily committed yet.
      if (!saveLocalDocument(docRef.current)) throw new Error(surfaceNotice(t, 'storage_unavailable'));
      const document = await initializeSaaSCanvas(sessionScope, controller.signal);
      if (!mounted.current || controller.signal.aborted || readOnlyRef.current) throw new Error(locale === 'zh' ? '节点准备已取消。' : 'Node setup was cancelled.');
      docRef.current = document; setDoc(document);
      lastSaved.current = savedDocument(document); lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY);
      return document;
    } finally {
      if (setupRequest.current === controller) setupRequest.current = null;
      if (mounted.current) setInitializing(false);
    }
  }, [locale, t, saveLocalDocument, runUnavailableReason]);

  // `asked`, for a start from the rerun question (RerunConfirm.tsx): the question the reader answered, or null for a run
  // of the whole canvas that had none to ask. It is held to once the run's ownership, and then its nodes' setup, are
  // through. Undefined for every other run.
  // `operationId` is the one a run the host asks for is admitted under (an auto rerun's, autoRun); any other run has a
  // new one.
  // `sentDraft`: the box's draft as it was when the message was sent, where the run starts later (after the pages a node's
  // message names are read): only that is consumed, never what was typed meanwhile.
  const startRun = useCallback((requestedScope?: ReadonlyArray<string>, manualMessage?: string, onAccepted?: () => void, manualDisplayText?: string, collaboration?: GraphCollaborationPolicy,
    asked?: WholeRunChoice | null, operationId?: string, sentDraft?: string) => {
    if (readOnlyRef.current || outdatedObserver.current) return Promise.resolve();
    if (runUnavailableReason) { setHandoffNote(runUnavailableReason); return Promise.resolve(); }
    writePreviewsNow.current();
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
        setLaneRuns(previous => previous.map((item, index) => index === lane ? {} : withoutBadges(item, executingIds)));
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
    // The draft the send came from: a media node's prompt in the document, a chat node's message on this device.
    const submittedDraft = submittedNode && submittedThread
      ? sentDraft ?? (draftIsShared(submittedNode) ? submittedThread.draft : readComposerDraft(submittedNode.id, submittedThread.id))
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
      setRuns(timelineRuns({}, durable.nodes, Date.now())); setReviewRound(durable.review?.round ?? 0); setRunning(true); setRecovering(true);
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
        && persistedRevision !== lastSaved.current?.planRevision()) {
      // The note asks the reader to look at what changed before running: the cards are drawn for that.
      showAdopted(docRef.current, persistedCanvas.doc);
      docRef.current = persistedCanvas.doc; setDoc(persistedCanvas.doc);
      // Another tab's document: what this page's undo knew about the plan no longer describes it.
      planStep.current?.reset();
      lastSaved.current = savedDocument(persistedCanvas.doc, persistedRevision); lastSavedRaw.current = canvasStorage().getItem(CANVAS_STORAGE_KEY);
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
    // The canvas stays editable while the run waits for its ownership (a node added touches none of the nodes it
    // holds). Before anything is set up or cleared, a start from the rerun question must find the canvas as the question
    // showed it, or, having had nothing to ask, still with nothing to ask: one that changed (a node added, a result
    // published by hand) is asked again as it now stands, with nothing cleared.
    if (asked !== undefined) {
      const now = rerunQuestionOf(docRef.current);
      if (!sameWholeRunChoice(asked, now)) {
        if (now) setRerunChoice({ ...now, changed: true }); else setHandoffNote(t('rerun.changedSetup'));
        return;
      }
      // Setting the nodes up can itself clear a result (a node moved to another runtime starts a new conversation:
      // node_setup.go). A run its own preflight refuses anyway (an input nobody filled in, a cycle, a team's or a media
      // node's settings) is refused before that, by the same check, with the Agents the setup would bind taken as bound:
      // nothing else it checks does the setup change.
      if (currentSaaSCanvas()) {
        const asSetUp = docRef.current.nodes.map(node => node.kind === 'session' && !node.binding ? { ...node, binding: { companyId: '', agentId: '', agentName: node.title } } : node);
        const refused = preflightGraphIssue(asSetUp, reconcileEdges(asSetUp, docRef.current.edges).filter(edge => edge.kind !== 'feedback'), scope,
          { media: mediaCatalogueOf(mediaStateRef.current) });
        if (refused) { refusedRevision.current = canvasPlanRevision(docRef.current); setHandoffNote(preflightIssueMessage(t, refused, locale) ?? refused.message); return; }
        // That check judges a media node's settings by the workspace's catalogue, so while it is still loading, a run
        // whose setup could take a result (an Agent node's: a form keeps what it sent, and is never set up) waits: once
        // the catalogue arrives, the run could still be refused. Not when it failed to load: the service judges them
        // then, as it did before.
        const inRun = (scope ? docRef.current.nodes.filter(node => scope!.includes(node.id)) : docRef.current.nodes)
          .filter((node): node is SessionNode => node.kind === 'session');
        if (mediaStateRef.current?.status === 'loading' && inRun.some(node => node.lastOutput != null)
            && inRun.some(node => mediaKindOf(node.agentKind))) {
          setHandoffNote(t('rerun.mediaLoading')); return;
        }
      }
    }
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
    // The setup may itself clear a result of a node it sets up anew (moved to another runtime, its conversation starts
    // again: node_setup.go), which the run replaces anyway. What the run must not do is replace a result the question
    // did not name (one that came from elsewhere while the setup ran), nor run more than it quoted.
    if (asked !== undefined) {
      const now = rerunQuestionOf(runDocument);
      const runs = new Set(requestedScope ?? runNodes.map(node => node.id));
      const named = new Set(asked?.finished ?? []);
      if (now && now.finished.some(id => runs.has(id) && !named.has(id))) { setRerunChoice({ ...now, changed: true }); return; }
      const quoted = asked ? (requestedScope ? asked.rest : asked.whole) : undefined;
      if (quoted) {
        const ids = new Set(runNodes.map(node => node.id));
        const spends = runCost(runNodes, requestedScope, Boolean(currentSaaSCanvas()));
        const sameNodes = requestedScope ? quoted.scope.every(id => ids.has(id)) : ids.size === quoted.scope.length && quoted.scope.every(id => ids.has(id));
        if (!sameNodes || spends.calls !== quoted.calls || (spends.generations ?? 0) !== (quoted.generations ?? 0)) { setHandoffNote(t('rerun.changedSetup')); return; }
      }
    }
    const runEdges = reconcileEdges(runNodes, runDocument.edges);
    const reviewPolicy = !manualMessage && !collaboration ? runDocument.execution : undefined;
    const problem = collaboration ? '' : preflightIssueMessage(t, reviewPolicy
      ? preflightReviewGraphIssue(runNodes, runEdges, reviewPolicy, scope)
      : preflightGraphIssue(runNodes, runEdges.filter(edge => edge.kind !== 'feedback'), scope,
        { conversation: Boolean(currentSaaSCanvas() && manualMessage), media: mediaCatalogueOf(mediaStateRef.current) }), locale);
    if (problem) { refusedRevision.current = canvasPlanRevision(runDocument); setHandoffNote(problem); return; }
    setHandoffNote('');
    const ac = new AbortController();
    // A failed or stopped retry must never leave its previous success available to downstream nodes.
    const executing = new Set(scope ?? runNodes.map(n => n.id));
    const pending: CanvasRunJournal = { version: 1, id: operationId ?? crypto.randomUUID(), startedAt: Date.now(), scope: [...executing], inputFingerprint: runInputFingerprint(runDocument, [...executing]), ...(manualMessage ? { manual: true, manualMessage } : {}), nodes: Object.fromEntries(runNodes.filter(n => executing.has(n.id)).map(n => [n.id, { nodeId: n.id, threadId: n.kind === 'session' ? activeThreadId(n) : 'form', operationId: n.kind === 'session' ? crypto.randomUUID() : null, companyId: n.kind === 'session' ? n.binding?.companyId ?? null : null, agentId: n.kind === 'session' ? n.binding?.agentId ?? null : null, issueId: n.kind === 'session' ? n.issueId ?? null : null, runId: null, state: 'waiting' as const }])) };
    if (reviewPolicy) pending.review = { round: 0, maxRounds: reviewPolicy.maxRounds, outcome: 'running', turns: [] };
    if (collaboration) pending.collaboration = { ...collaboration, maxModelCalls: 2 * executing.size * collaboration.rounds + 1, phase: 'proposal', round: 0, turns: [] };
    const cloud = currentSaaSCanvas();
    // This canvas's (lane) storage as the run is accepted: canvasStorage() resolves whichever canvas is open when it is
    // called, and a refused page repair (endRefusedRepair) must clear this canvas's journal and write its deferral here.
    const acceptedStorage = canvasStorage();
    if (cloud && !manualMessage) pending.serverGraph = { tenantId: cloud.tenant.id, canvasId: cloud.canvasId };
    // Collaboration admission needs the exact saved upstream candidates, including selected peers.
    // The shared execution lock prevents consuming them while the server is accepting the run.
    const prepared = collaboration ? runDocument : prepareRunDocument(runDocument, [...executing], Boolean(manualMessage));
    const acceptedManualNode = manualMessage ? runNodes.find(node => executing.has(node.id)) : undefined;
    // AwwO's own page repair (pageRepair.ts, by its first line), not a person's message.
    const automaticRepair = isPageRepairMessage(manualMessage);
    if (!saveLocalDocument(prepared)) { setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return; }
    if (!saveRunJournal(pending)) {
      // No dispatch happened: preserve the previous published results on a quota failure.
      saveLocalDocument(docRef.current);
      setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return;
    }
    // Draft consumption is part of durable acceptance, not a generic composer edit (which
    // is correctly blocked once running). Save only after the journal succeeds, so neither
    // storage failure can discard a request that has not been accepted or dispatched. AwwO's
    // own page repair was never the draft: what a person left unsent there stays.
    const acceptedThreadId = acceptedManualNode?.kind === 'session' ? activeThreadId(acceptedManualNode) : undefined;
    // A media node's draft is its prompt in the document; a chat node's is this person's message on this device
    // (composerDrafts.ts). Either is consumed only while it is still what was sent: a newer one typed meanwhile stays.
    const sharedDraft = acceptedManualNode?.kind === 'session' && draftIsShared(acceptedManualNode);
    const draftNow = acceptedManualNode?.kind === 'session' && acceptedThreadId
      ? sharedDraft ? getNodeThreads(acceptedManualNode).find(thread => thread.id === acceptedThreadId)?.draft
        : readComposerDraft(acceptedManualNode.id, acceptedThreadId, acceptedStorage)
      : undefined;
    const consumeDraft = !automaticRepair && acceptedManualNode?.kind === 'session' && submittedThread && draftNow === submittedDraft;
    const acceptedDocument = consumeDraft && sharedDraft ? { ...prepared, nodes: prepared.nodes.map(node =>
      node.id === acceptedManualNode.id && node.kind === 'session'
        ? updateNodeDraft(node, '', acceptedThreadId) : node) } : prepared;
    if (acceptedDocument !== prepared && !saveLocalDocument(acceptedDocument)) {
      clearRunJournal(pending.id);
      setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return;
    }
    // A sent message that stayed on the device would come back after a reload, to be sent again: not dispatched then.
    if (consumeDraft && !sharedDraft && !writeComposerDraft(acceptedManualNode.id, acceptedThreadId!, '', acceptedStorage)) {
      clearRunJournal(pending.id);
      setHandoffNote(surfaceNotice(t, 'storage_unavailable')); return;
    }
    docRef.current = acceptedDocument; setDoc(acceptedDocument);
    journal.current = pending;
    if (pending.serverGraph) startedJournals.current.add(pending.id);
    runAbort.current = ac;
    if (consumeDraft) onAccepted?.();
    // A run's start takes the canvas's last run off show: this lane's earlier badges, its nodes' badges in other lanes,
    // the summary, a stop, the round and the start. A page repair runs from its start as any run (its Stop, the lane's
    // watch, the locks running brings), but takes only its own node's badges then, and the rest once the service has
    // admitted it, or answered anything but a definite refusal (takeLastRun, below): one the service refuses before it
    // runs (endRefusedRepair) leaves the rest as it was, newer changes included, and gives its node back the badge it had.
    const earlierBadge = automaticRepair && acceptedManualNode ? settledRuns.current[acceptedManualNode.id] : undefined;
    let tookLastRun = !automaticRepair;
    const takeLastRun = () => {
      if (tookLastRun || runAbort.current !== ac || currentSaaSCanvas() !== cloud) return;
      tookLastRun = true;
      setStopped(false);
      setRunSummary(null);
      // This lane's earlier badges go; the repair's own stays (its other lanes' copies went at its start).
      setLaneRuns(previous => previous.map((item, index) => index === lane
        ? Object.fromEntries(Object.entries(item).filter(([id]) => executingIds.has(id))) : item));
      setReviewRound(0);
      setRunStartedAt(pending.startedAt);
    };
    // The lane that showed the node's badge (lanes merge in order: the last one holding it), as this start leaves it.
    let heldIn: { lane: number; map: Record<string, RunView> } | null = null;
    setRunning(true);
    if (automaticRepair) setLaneRuns(previous => {
      const next = previous.map(item => withoutBadges(item, executingIds));
      for (let index = previous.length - 1; index >= 0; index -= 1) {
        if (Object.hasOwn(previous[index], acceptedManualNode!.id)) { heldIn = { lane: index, map: next[index] }; break; }
      }
      return next;
    });
    else {
      setStopped(false);
      setRunSummary(null);
      setRuns({});
      setReviewRound(0);
      setRunStartedAt(Date.now());
    }
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
        setRuns(prev => timelineRuns(prev, recovered.nodes, Date.now()));
        if (ac.signal.aborted) await cancelCloudGraph(journal.current);
      } catch (error) {
        if (!admitted && graphAdmissionRejected(error)) {
          // This request was rejected before admission; retain the user's inputs and
          // show the rejection. A lost response keeps its operation journal instead.
          clearRunJournal(submissionStorage, pending.id);
          if (currentSaaSCanvas() !== cloud) return;
          journal.current = null; setRunning(false);
          // A refusal the service blamed on one node (a media node's saved model, type or settings, which it freezes
          // for the whole scope before the run starts) names that node: its copy alone would not.
          setHandoffNote(refusedNodeMessage(saasErrorMessage(error, locale), graphRefusedNodeId(error), runNodes, locale));
          // The free trial ended while this page was open: the board's notice (with the plans for the owner) follows the
          // alert once it is put away, without waiting for the next read of route-usage.
          if (isFreePlanEnded(saasErrorMessage(error, locale))) setFreePlanEnded(true);
          runAbort.current = null; return;
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
      onRunAccepted: (nodeId, identity) => {
        updateJournal(nodeId, identity);
        // The service admitted the page repair: it takes the canvas's last run off show now.
        takeLastRun();
      },
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
    // A page repair the service refused before it ran (today's calls used up, every run slot busy, the page sent back
    // already: page_repair_chained) was no repair, and nothing failed. Its run ends here, in one step with no await,
    // before anything is marked, published, kept or summed up: no 'failed' reaches the journal, the node or another tab,
    // the tail below never runs, the canvas's last run is still on show (takeLastRun never ran) with the node's own badge
    // given back (earlierBadge), and the host hears of no run (watchedLanes). Its delivery may go back later
    // (pageRepair.ts deferPageRepair), in this canvas's own storage, where repairPage recorded it; its request leaves the
    // node's chat and the display cache, and one quiet line says why in its place. A person's own refused message keeps
    // its failure: their words and the next steps it offers (nextSteps.ts) live in it.
    const endRefusedRepair = (node: SessionNode, code: string, copy: string) => {
      const retryAfter = pageRepairRetryAfter(code, Date.now());
      if (retryAfter !== null) deferPageRepair(acceptedStorage, pageRepairMessageKey(node.id, manualMessage), retryAfter);
      clearRunJournal(acceptedStorage, pending.id);
      const operationId = pending.nodes[node.id]?.operationId;
      const key = sessionStoreKey(node);
      if (operationId) {
        forgetConversationPresentation(node, operationId, storage);
        removeSessionTurns(key, turn => turn.recoveryOperationId === operationId);
      }
      // page_repair_chained's words say what was refused; the others say only why (today's calls used up, the run slots
      // busy), so the line first says that the page's automatic repair did not run, and, where it can go back later
      // (deferred above), that it will, in the language the bridge has just put those words in (canvasLocale). A line
      // the chat ends with already (the same repair sent again later and refused again) is not said twice.
      const zh = canvasLocale() === 'zh';
      const lead = code === 'page_repair_chained' ? '' : zh ? '页面的自动修复没有运行。' : 'The page’s automatic repair did not run. ';
      const later = retryAfter === null ? '' : zh ? '页面之后再出错时，AwwO 会再送回一次。' : ' When the page fails again later, AwwO sends it back once more.';
      const said = copy.trim() ? `${lead}${copy}${later}` : '';
      const turns = getSessionSnapshot(key).turns;
      const last = turns[turns.length - 1];
      if (said.trim() && !(last?.notice && last.text === said)) appendSessionTurn(key, { role: 'system', tone: 'info', text: said, notice: true });
      if (currentSaaSCanvas() !== cloud) return;
      journal.current = null; runAbort.current = null;
      // The rest of the canvas's last run never left (this start took only the node's own badges): the node gets back
      // the badge it had, in the lane that showed it, unless something since cleared the running one in its place (an
      // edit upstream of it) or changed what that other lane shows (a run's start in it, or one taking badges from it, or
      // an edit clearing some: withoutBadges keeps a lane that lost nothing as it was).
      if (earlierBadge) givenBackBadges.current.add(earlierBadge);
      setLaneRuns(previous => {
        if (previous[lane]?.[node.id]?.state !== 'running') return previous;
        const held = heldIn as { lane: number; map: Record<string, RunView> } | null;
        const back = earlierBadge && held && (held.lane === lane || previous[held.lane] === held.map) ? held.lane : null;
        return previous.map((item, index) => {
          const own = index === lane ? Object.fromEntries(Object.entries(item).filter(([id]) => id !== node.id)) : item;
          return index === back ? { ...own, [node.id]: earlierBadge! } : own;
        });
      });
      watchedLanes.current.delete(lane);
      setRunning(false);
    };
    const executeManual = async () => {
      const node = runNodes.find(n => executing.has(n.id));
      if (!node || node.kind !== 'session') throw new Error('Conversation node is unavailable');
      onStatus(node.id, { state: 'running' });
      const result = await exec(node, manualMessage!);
      if (result.refusedCode && automaticRepair) {
        endRefusedRepair(node, result.refusedCode, result.detail);
        return null;
      }
      // Anything but a definite refusal: it ran, or may have (its answer was lost, and recovery finds out), so it takes
      // the canvas's last run off show, if its admission did not already.
      takeLastRun();
      onStatus(node.id, { state: result.unconfirmed ? 'running' : result.ok ? 'done' : result.cancelled ? 'cancelled' : 'failed', output: result.output, detail: result.detail });
      return journalSummary(journal.current!);
    };
    const options = {
      nodes: runNodes,
      edges: reviewPolicy ? runEdges : runEdges.filter(edge => edge.kind !== 'feedback'),
      scope,
      // An out-of-scope upstream contributes what it produced earlier rather than running again. A form contributes its
      // fields as they are now, as a cloud run's does (graph_runs.go formOutput), so the nodes left can run from a form
      // that never ran.
      storedOutput: (nodeId: string) => {
        const node = docRef.current.nodes.find((n) => n.id === nodeId);
        if (node?.kind === 'form') return serializeFormOutput(node);
        const output = node?.lastOutput;
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
        setRuns(timelineRuns({}, next.nodes, Date.now())); setReviewRound(round);
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
    // A request refused before admission was no run (endRefusedRepair): nothing to recover, publish or sum up.
    if (!summary) return;
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
        setDoc(docRef.current); setRuns(timelineRuns({}, historical.nodes, Date.now())); finalSummary = journalSummary(historical);
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
            journal.current = confirmed; setRuns(prev => timelineRuns(prev, confirmed.nodes, Date.now()));
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
   * it, which is the loop the product exists for. It reads the wires of the latest render, so that it keeps its identity
   * (saveNode, which every tile takes, is built on it).
   */
  const downstreamClosure = useCallback(
    (roots: ReadonlyArray<string>): string[] => {
      const out = new Set(roots);
      let grew = true;
      while (grew) {
        grew = false;
        for (const e of edgesRef.current) {
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
    [],
  );

  /** Re-run exactly one node, reusing every upstream's stored output. */
  const rerunNode = useCallback((nodeId: string) => void startRun([nodeId]), [startRun]);

  /** Run the selection and everything it feeds. */
  const runFromSelection = useCallback(
    () => void startRun(downstreamClosure(selectionRef.current)),
    [startRun, downstreamClosure],
  );

  /** What a run of the whole canvas asks first (RerunConfirm.tsx), or null when it has nothing to ask: no node it would
   *  run again has its result, or it would not start anyway (read only, unavailable, another run going), which startRun
   *  says itself. */
  const wholeRunAsk = useCallback((): WholeRunChoice | null => {
    if (readOnlyRef.current || runUnavailableReason || anyLaneActive()) return null;
    // A review loop runs its rounds over the whole canvas: it is asked about as a whole (rerunQuestionOf).
    return rerunQuestionOf(docRef.current);
  }, [runUnavailableReason, anyLaneActive]);
  /** Run the whole canvas, from its run button, the 成果 view or the command bar: asked first where that runs nodes again
   *  that already have their result. Started without asking, it still holds to having had nothing to ask (startRun's
   *  `asked` null): a result that arrives while it waits to start is asked about. */
  const runWholeCanvas = useCallback(() => {
    const ask = wholeRunAsk();
    if (ask) setRerunChoice(ask); else void startRun(undefined, undefined, undefined, undefined, undefined, null);
  }, [wholeRunAsk, startRun]);
  /** The question's answer: only the nodes without a result and what they feed, or every node. It acts only on the
   *  canvas the question showed: a plan that applied, a wire moved, a result that arrived, a run another tab started
   *  while it was open would make either start more (or other) work than it quoted, so the question is asked again as
   *  things now stand, or, with nothing left to ask, the reader is told to press run again. */
  const answerRerun = useCallback((answer: 'rest' | 'whole') => {
    const shown = rerunChoice;
    if (!shown) return;
    const now = wholeRunAsk();
    if (!sameWholeRunChoice(shown, now)) {
      if (now) setRerunChoice({ ...now, changed: true });
      else { setRerunChoice(null); setHandoffNote(t('rerun.changedAgain')); }
      return;
    }
    setRerunChoice(null);
    // The nodes the question named and quoted, no more: the scope it was worked out with, checked again once the run is
    // set up (startRun's `asked`).
    if (answer === 'rest' && shown.rest) void startRun(shown.rest.scope, undefined, undefined, undefined, undefined, shown);
    else void startRun(undefined, undefined, undefined, undefined, undefined, shown);
  }, [rerunChoice, wholeRunAsk, startRun, t]);

  // ---- node mutations -----------------------------------------------------------------------

  // The glance LOD can only render `node.preview` — a far-away tile has no transcript loaded — so
  // the last line has to be persisted onto the document when a tile's stream settles. Guarded to a
  // real change so it never re-saves the document on an identical value.
  // A tile reports it from an effect of the render that settled its history, and opening a canvas settles every tile's
  // at once. Written one by one, each report re-rendered and saved the whole canvas, and a run of them back to back
  // counted as an update loop (React error #185 on a 142-node canvas, 2026-10-19). So reports wait a moment and are
  // written together, in one machine write, outside the render that made them: as if those tiles had settled then.
  const pendingPreviews = useRef(new globalThis.Map<string, { nodeId: string; preview: string; threadId?: string }>());
  const previewWrite = useRef<{ timer: ReturnType<typeof setTimeout>; since: number } | null>(null);
  const writePreviews = useCallback(() => {
    if (previewWrite.current) clearTimeout(previewWrite.current.timer);
    previewWrite.current = null;
    if (!pendingPreviews.current.size) return;
    // A page that cannot write at all drops them. One that takes no edit for a while keeps them until it does: they were
    // made before that began (a setup or a run started here takes them first; a review loop or a collaboration another
    // tab started holds the canvas without asking).
    if (readOnlyRef.current || outdatedObserver.current) { pendingPreviews.current.clear(); return; }
    if (setupRequest.current || laneGuard.current.exclusive()) {
      previewWrite.current = { since: performance.now(), timer: setTimeout(writePreviews, PREVIEW_MAX_WAIT_MS) };
      return;
    }
    // Recovery can briefly display a previously loaded transcript while another tab has
    // already saved the final document. Never write that stale tail back into its preview.
    // With lanes, only the nodes a run executes are recovering; every other node keeps its preview.
    const busy = laneGuard.current.busy();
    const reports = new globalThis.Map<string, Array<{ preview: string; threadId?: string }>>();
    for (const report of pendingPreviews.current.values()) {
      if (!busy.has(report.nodeId)) reports.set(report.nodeId, [...(reports.get(report.nodeId) ?? []), report]);
    }
    pendingPreviews.current.clear();
    if (!reports.size) return;
    patchDoc((prev) => {
      let changed = false;
      const nodes = prev.nodes.map((node) => {
        let next = node;
        for (const report of reports.get(node.id) ?? []) {
          if (next.kind === 'session') next = updateThreadPreview(next, report.threadId ?? activeThreadId(next), report.preview);
        }
        if (next !== node) changed = true;
        return next;
      });
      return changed ? { ...prev, nodes } : prev;
    }, { silent: true });
  }, [patchDoc]);
  writePreviewsNow.current = writePreviews;
  const persistPreview = useCallback(
    (nodeId: string, preview: string, threadId?: string) => {
      // A report the write would refuse now is dropped now (patchDoc's own refusals), as a write made at once was.
      if (readOnlyRef.current || outdatedObserver.current || setupRequest.current || laneGuard.current.exclusive()
        || laneGuard.current.busy().has(nodeId)) return;
      pendingPreviews.current.set(`${nodeId}\u0000${threadId ?? ''}`, { nodeId, preview, threadId });
      // Written once the reports pause, and at least every PREVIEW_MAX_WAIT_MS while they keep coming.
      const now = performance.now();
      const since = previewWrite.current?.since ?? now;
      if (previewWrite.current) clearTimeout(previewWrite.current.timer);
      previewWrite.current = { since, timer: setTimeout(writePreviews, Math.max(0, Math.min(PREVIEW_QUIET_MS, since + PREVIEW_MAX_WAIT_MS - now))) };
    },
    [writePreviews],
  );
  useEffect(() => () => { if (previewWrite.current) clearTimeout(previewWrite.current.timer); }, []);

  const persistDraft = useCallback((nodeId: string, threadId: string, draft: string) => {
    if (readOnlyRef.current) return;
    // A chat node's unsent message is this person's own (composerDrafts.ts): kept on the device, never in the document,
    // so nothing anyone else does with the canvas reads it or writes over it, also while its node runs.
    const owner = docRef.current.nodes.find(node => node.id === nodeId);
    if (owner?.kind === 'session' && !draftIsShared(owner)) { writeComposerDraft(nodeId, threadId, draft); return; }
    // Once a node's own run executes, its draft belongs to that run's acceptance (as with the single run before lanes);
    // a draft typed while the run still waits for ownership is kept, and every other node's draft saves while others run.
    const executing = RUN_LANES.some(lane => laneList[lane].abort.current && laneList[lane].journal.current?.scope.includes(nodeId));
    if (inspectorCloseLocked.current || executing) return;
    patchDoc(prev => {
      const target = prev.nodes.find(node => node.id === nodeId);
      if (!target || target.kind !== 'session') return prev;
      const next = updateNodeDraft(target, draft, threadId);
      return next === target ? prev : { ...prev, nodes: prev.nodes.map(node => node.id === nodeId ? next : node) };
    }, { silent: true });
  }, [patchDoc, laneList]);

  // Before chat drafts were kept on the device, they were typed into the shared document, where everyone on the canvas
  // reads them. An editor's page moves what it finds there once, when it opens the canvas: a conversation's draft goes
  // into this device's drafts where it holds none for that conversation (so someone alone on their canvas keeps what they
  // left unsent), and out of the document once the device holds it (or held the same already). One the device holds
  // otherwise (another person's, or this person's from another device) stays for the page that holds none, as does one
  // the device refused. A media node's draft is its prompt and stays.
  useEffect(() => {
    if (readOnlyRef.current) return;
    const moved = new globalThis.Map<string, Set<string>>();
    for (const node of docRef.current.nodes) {
      if (node.kind !== 'session' || draftIsShared(node)) continue;
      for (const thread of node.threads ?? []) {
        if (!thread.draft) continue;
        const held = readComposerDraft(node.id, thread.id);
        if (held === thread.draft || (!held && writeComposerDraft(node.id, thread.id, thread.draft))) {
          moved.set(node.id, (moved.get(node.id) ?? new Set()).add(thread.id));
        }
      }
    }
    if (!moved.size) return;
    patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(node => node.kind === 'session' && moved.has(node.id)
      ? withoutThreadDrafts(node, moved.get(node.id)) : node) }), { silent: true });
    // Once a page: what an older page types into the document later goes when a page of this release opens it next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The reader's choice is kept against what the node shows now (deliverablesShown), so closing a drawer that opened by
  // itself is remembered, and so is closing a drawer its tile holds open (an edit of its form kept it). An open is asked
  // of the rule alone: a held drawer closed during a run, which the tile kept to itself, opens and is recorded open when
  // its delivery is asked for (查看交付物). The drawer takes a share of an opened node's frame, so the node keeps its
  // size and camera; only a node opened without a frame grows by the drawer and is fitted again.
  const toggleDeliverables = useCallback((nodeId: string, open: boolean) => {
    if (!canEditStructure(false, [])) return;
    const target = docRef.current.nodes.find(node => node.id === nodeId);
    const drawn = renderNodesRef.current.find(node => node.id === nodeId);
    const placed = openFitRef.current?.id === nodeId ? openFitRef.current : null;
    const narrow = placed ? placed.narrow : narrowFocusWidth(sizeRef.current.w);
    const shown = target?.kind === 'session' && deliverablesShown(target, drawerBeside(narrow, drawn?.w ?? target.w));
    if (!target || target.kind !== 'session' || hasStreamingConversation([target])
      || (open ? shown : shown || heldDrawersRef.current.has(nodeId)) === open) return;
    patchDoc(prev => ({ ...prev, nodes: prev.nodes.map(node => node.id === nodeId && node.kind === 'session' ? { ...node, deliverablesOpen: open } : node) }),
      { silent: true });
    const fit = openFitRef.current;
    if (!fit || fit.id !== nodeId || !fit.frame) requestAnimationFrame(() => focusNodeRef.current(nodeId));
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
  // The board as it is with no node open: a display is placed beside where a card sits, not beside its open frame.
  const closedNodes = useCallback(() => presentationNodes(docRef.current.nodes, null, undefined, cardFramesRef.current), []);
  // ...and clear of the node open now, whose frame covers the board around its card.
  const openNodeFrame = useCallback(() => renderNodesRef.current.filter(node => node.id === focusedRef.current), []);
  /** The view tools' 预览展示: everything the canvas made, live, at the end of the board (the one already there, if any). */
  const showCanvasDisplay = useCallback(() => {
    const existing = docRef.current.displays?.find(item => item.source.type === 'canvas');
    if (existing) { selectDisplay(existing.id); revealDisplay(existing); return; }
    const added = addDisplay(placeDisplayAfter([...closedNodes(), ...openNodeFrame(), ...(docRef.current.displays ?? NO_DISPLAYS)]));
    if (added) fitAll();
  }, [selectDisplay, revealDisplay, addDisplay, fitAll, closedNodes, openNodeFrame]);
  /** A card's 在预览展示中查看: the display already showing that component, or a new one beside it. */
  const showNodeInDisplay = useCallback((nodeId: string) => {
    const existing = docRef.current.displays?.find(item => item.source.type === 'node' && item.source.nodeId === nodeId);
    if (existing) { selectDisplay(existing.id); revealDisplay(existing); return; }
    const board = closedNodes();
    const card = board.find(node => node.id === nodeId);
    if (!card) return;
    const added = addDisplay(placeDisplayBeside(card, [...board, ...openNodeFrame(), ...(docRef.current.displays ?? NO_DISPLAYS)]), { type: 'node', nodeId });
    if (added) revealDisplay(added);
  }, [selectDisplay, revealDisplay, addDisplay, closedNodes, openNodeFrame]);

  const addNode = useCallback(
    (kind: AddNodeKind, world: { x: number; y: number }) => {
      if (kind === 'display') { addDisplay(world); return; }
      if (!canEditStructure(false, [])) return;
      const media = canInitialize ? mediaKindOf(kind) : null;
      // A cloud image or video node is a plain generator: no role template, delivery format or
      // team. The first catalog model is shown, and runs only once the operator saves it.
      const node = kind === 'form' ? createFormNode(world)
        : kind === 'assemble' ? createAssembleNode(world, locale)
        : kind === 'edit' ? createEditNode(world, locale)
        : media ? { ...createSessionNode(media, world), title: t(media === 'video' ? 'node.video' : media === 'model3d' ? 'node.model3d' : media === 'audio' ? 'node.audio' : 'node.image'),
          model: mediaModelsOf(mediaCatalogueOf(mediaState), media)[0]?.id ?? '' }
        : kind === 'llm' || kind === 'coding' || kind === 'image' || kind === 'video' || kind === 'model3d' || kind === 'audio'
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
      // A node drawn at its open frame resizes that frame, like the camera a view choice: saved into the node, a size
      // fitted to this screen would open it oversized (or below 100 %) on the next one.
      const fit = openFitRef.current;
      if (fit && fit.id === nodeId && fit.frame && !fit.narrow && focusedRef.current === nodeId) {
        setOpenFit({ ...fit, frame: { w: Math.max(FOCUSED_SESSION_MIN_SIZE.w, Math.round(w)), h: Math.max(FOCUSED_SESSION_MIN_SIZE.h, Math.round(h)) }, resized: true });
        return;
      }
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
        const errors = validateNodeOutput(next, next.lastOutput!.text, locale);
        if (errors.length) { setHandoffNote(errors.join(locale === 'zh' ? '；' : ' ')); return; }
      }
      // A session taking its first deliverable form keeps its wires on the form's ports (deliverableWires.ts); one the
      // form cannot carry goes, and is named.
      let dropped: CanvasEdge[] = [];
      const unsaved = docRef.current;
      patchDoc(prev => {
        const live = prev.nodes.find(n => n.id === next.id);
        const placed = live ? { ...next, x: live.x, y: live.y, w: live.w, h: live.h } : next;
        const carried = live ? carryWiresIntoContract(prev.nodes, prev.edges, live, placed, tLatest.current('contract.contextInputLabel'))
          : { node: placed, edges: prev.edges, dropped: [] };
        dropped = carried.dropped;
        const nodes = prev.nodes.map(n => n.id === next.id ? carried.node : n);
        // A field deleted or retyped here takes its wires with it, as the board already shows: a wire left in the
        // document is not drawn, cannot be disconnected, and would make every later plan fail.
        return { ...prev, nodes, edges: reconcileEdges(nodes, carried.edges) };
      }, { label: `config:${next.id}` });
      const droppedNote = docRef.current !== unsaved && dropped.length ? droppedWiresNote(tLatest.current, docRef.current.nodes, unsaved.nodes, dropped) : '';
      if (current?.kind === 'session' && next.kind === 'session' && (JSON.stringify(current.team) !== JSON.stringify(next.team)
        || JSON.stringify(current.taskFrame) !== JSON.stringify(next.taskFrame) || JSON.stringify(current.skills ?? []) !== JSON.stringify(next.skills ?? []))) {
        const affected = new Set(downstreamClosure([next.id]));
        setAllRuns(previous => withoutBadges(previous, affected));
        setRunSummary(null);
      }
      setHandoffNote(droppedNote);
    },
    [canEditStructure, patchDoc, downstreamClosure, locale],
  );
  // A change a node's card made (SessionTile's onPatchNode: its inputs, its outputs, a result published by hand, another
  // conversation opened), applied to the node as the document holds it now; saveNode's checks apply as to any save. A
  // card's own copy is the node it last drew: two changes made before the next render would each put back what the other
  // changed, or what the document cleared in between.
  const patchNode = useCallback((nodeId: string, change: (node: SessionNode) => SessionNode) => {
    const live = docRef.current.nodes.find(node => node.id === nodeId);
    if (live?.kind === 'session') saveNode(change(live));
  }, [saveNode]);

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
    } else if (live.kind === 'assemble' && draft.kind === 'assemble') {
      saveNode({ ...live, title: draft.title, template: draft.template, contract: draft.contract,
        ...(draft.fileName ? { fileName: draft.fileName } : { fileName: undefined }) });
    } else if (live.kind === 'edit' && draft.kind === 'edit') {
      saveNode({ ...live, title: draft.title, timeline: draft.timeline });
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
  // (inspectorId and inspectorRef are declared beside focusedId: an opened node's size depends on them.)
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
    const ids = new Set(stageMeasured ? visibleBoxIds(renderNodes, view, size) : []);
    // A converged member is drawn inside its icon, not as a card (opening one expands its group first: focusNode).
    for (const id of convergedView.hidden) ids.delete(id);
    // A focused or inspected node is always mounted, even if the operator has panned it off
    // screen — the inspector keeps describing a tile that is still "yours".
    if (focusedId) ids.add(focusedId);
    if (inspectorId) ids.add(inspectorId);
    // So is the icon with the keyboard's focus, which the camera may move off screen (⌘[ ], a pan).
    if (keyIcon && iconIds.has(keyIcon)) ids.add(keyIcon);
    return ids;
  }, [renderNodes, view, size, focusedId, inspectorId, stageMeasured, convergedView, keyIcon, iconIds]);
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
  // A node's message names web pages: those whose addresses the person typed or pasted into its box are read first
  // (messagePages.ts), the box saying which; one that is not read keeps the message in the box with why, and the same
  // message sent again goes without it. One read at a time a node. An image, video or 3D node takes no knowledge (the
  // server refuses it), so its prompt is never read for pages.
  const [tileStatus, setTileStatus] = useState<Record<string, ComposerStatus>>({});
  const tileReading = useRef(new globalThis.Set<string>());
  // The node messages' page reads under way: stopped when this surface goes (a draft's recovery takes its place while
  // the canvas stays open), so a read it left cites nothing and reads none of its message's later addresses.
  const tileReads = useRef(new globalThis.Set<AbortController>());
  useEffect(() => () => { for (const controller of tileReads.current) controller.abort(); tileReads.current.clear(); }, []);
  const showTileStatus = useCallback((nodeId: string, status: ComposerStatus | null) => setTileStatus(previous => {
    if (!status) { if (!(nodeId in previous)) return previous; const { [nodeId]: _gone, ...rest } = previous; return rest; }
    return { ...previous, [nodeId]: status };
  }), []);
  const tileOnSend = useCallback(
    (node: CanvasNode, message: string, onAccepted?: () => void, displayText?: string) => {
      const read = readPagesRef.current;
      const text = displayText ?? message;
      if (!read || node.kind !== 'session' || draftIsShared(node) || !messageLinks(text).length) {
        showTileStatus(node.id, null);
        void startRun([node.id], message, onAccepted, displayText);
        return;
      }
      if (tileReading.current.has(node.id)) return;
      tileReading.current.add(node.id);
      // The conversation the message was written in and the agent it was written to: the run starts after the read, and
      // only if both are still the node's. The draft it came from, as it is now, is the one the run consumes (the box
      // stays locked while the read lasts, so nothing else is typed into it meanwhile).
      const threadId = activeThreadId(node);
      const binding = JSON.stringify(node.binding ?? null);
      const sentDraft = readComposerDraft(node.id, threadId);
      const typed = typedIn(`node:${node.id}:${threadId}`, text);
      showTileStatus(node.id, { text: t('assistant.reading'), tone: 'reading' });
      void (async () => {
        let outcome: MessagePagesOutcome | null = null;
        const controller = new AbortController();
        tileReads.current.add(controller);
        try {
          outcome = await read({ text, scope: `node:${node.id}`, typed }, controller.signal,
            step => showTileStatus(node.id, { text: t('assistant.readingPage', { host: step.host, index: step.index, total: step.total }), tone: 'reading' }));
        } catch { /* The canvas closed, or the read failed: nothing is sent, and the box says so. */ }
        finally { tileReading.current.delete(node.id); tileReads.current.delete(controller); }
        if (!mounted.current) return;
        const now = docRef.current.nodes.find(item => item.id === node.id);
        if (!now || now.kind !== 'session') { showTileStatus(node.id, null); return; }
        if (!outcome) { showTileStatus(node.id, { text: t('assistant.pagesFailed'), tone: 'held' }); return; }
        if (activeThreadId(now) !== threadId || JSON.stringify(now.binding ?? null) !== binding) {
          showTileStatus(node.id, { text: t('assistant.pagesMoved'), tone: 'held' });
          return;
        }
        if (outcome.hold) { showTileStatus(node.id, { text: t('assistant.pagesHeld', { pages: unreadPages(outcome.pages) }), tone: 'held' }); return; }
        // Pages that went unread with the message (not the person's address, a one-time link) are said under the box.
        const unread = unreadPages(outcome.pages);
        showTileStatus(node.id, unread ? { text: t('assistant.pageNotRead', { reason: unread }), tone: 'note' } : null);
        forgetTyped(`node:${node.id}:${threadId}`);
        void startRun([node.id], message, onAccepted, displayText, undefined, undefined, undefined, sentDraft);
      })();
    },
    [startRun, showTileStatus, t, unreadPages, typedIn, forgetTyped],
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
    (id: string) => { if (!inspectorCloseLocked.current) { setInspectorId(id); focusNodeRef.current(id, { configure: true }); } },
    [],
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
  // 收敛: the whole canvas drawn as one live icon, and back. A way of looking, so it works for readers, while the canvas
  // runs and in the simple view; not while a node is open (its card is what is being read), and not for one component.
  // Selecting anything else lets the icon go.
  useEffect(() => { if (selection.length || selectedEdgeId || selectedDisplayId) setSelectedIconId(null); }, [selection, selectedEdgeId, selectedDisplayId]);
  // Ends a wiring gesture (set once the wiring exists, below).
  const cancelWiringRef = useRef<() => void>(() => {});
  const setCanvasConverged = useCallback((on: boolean) => {
    if (on === convergedNowRef.current.canvas) return;
    // An open or configured node is what is being read: it is never put away under an icon. Asked by the keys (the
    // toggle and the palette row are greyed out then, with the reason), it says why nothing happens.
    if (on && (countSteps(docRef.current.nodes) < MIN_GROUP_MEMBERS || focusedRef.current || inspectorRef.current)) {
      announce(t(countSteps(docRef.current.nodes) < MIN_GROUP_MEMBERS ? 'converge.needsTwo' : 'converge.closeOpen'));
      return;
    }
    // A wire being drawn from a card that goes into the icon ends here, as a cancelled pointer ends it.
    if (on) cancelWiringRef.current();
    // A camera the person moved to just before, still waiting out its save, is theirs: saved now, before the glide
    // (whose cameras are the app's own and never saved) would drop it.
    const pendingSave = pendingCameraSave.current;
    if (pendingSave) { clearTimeout(pendingSave.timer); pendingCameraSave.current = null; pendingSave.save(); }
    setSelection([]);
    setSelectedEdgeId(null);
    setSelectedDisplayId(null);
    setSelectedIconId(null);
    // Showing all components shows the groups kept from before too.
    setConverged(previous => on ? { ...previous, canvas: true } : NOTHING_CONVERGED);
    // A card or the icon that held the focus is gone: the focus goes to the toggle, never to the page.
    refocusInCommit('[data-converge-toggle]');
    announce(on ? t('converge.announce.converged', { count: countSteps(docRef.current.nodes) })
      : t('converge.announce.expanded', { title: t('converge.wholeCanvas') }));
    const box = viewportSize(false);
    // The icon sits on the middle of the cards (convergeView): the camera glides around that point both ways, so the
    // icon grows where the cards were and the cards spread from it.
    const boxes = renderNodesRef.current;
    const middle = {
      x: boxes.reduce((sum, node) => sum + node.x + node.w / 2, 0) / Math.max(1, boxes.length),
      y: boxes.reduce((sum, node) => sum + node.y + node.h / 2, 0) / Math.max(1, boxes.length),
    };
    if (!box) return;
    const cover = box.cover ?? 0;
    // Both cameras are the app's own, placed for the icon or back from it, so neither is saved into the document
    // (unsavedCamera): converging changes nothing of the canvas, its camera included, until the person moves it.
    if (on) {
      convergeReturn.current = glideTarget.current ?? viewRef.current;
      // Centred in the board's free part (right of a floating assistant) at 75 %, where it reads at 120 px, a little
      // above the middle so the rows under it are in view too.
      const scale = .75;
      const target = { scale, x: cover + (box.w - cover) / 2 - middle.x * scale, y: box.h / 2 - middle.y * scale - 24 };
      unsavedCamera.current = target;
      glideTo(target, middle);
      return;
    }
    // Back to the camera it was converged from; converged before this page was opened, to the overview of the cards.
    const back = convergeReturn.current
      ?? shiftView(fitNodeOverview(docRef.current.nodes, { w: box.w - cover, h: box.h }, cardFramesRef.current, docRef.current.displays ?? NO_DISPLAYS), cover);
    if (!convergeReturn.current) lastAutoView.current = back;
    convergeReturn.current = null;
    unsavedCamera.current = back;
    glideTo(back, middle);
  }, [viewportSize, glideTo, announce, t, refocusInCommit]);
  const expandIcon = useCallback((id: string) => {
    if (id === CANVAS_GROUP_ID) { setCanvasConverged(false); return; }
    setConverged(previous => ({ ...previous, groups: previous.groups.filter(group => group.id !== id) }));
    setSelectedIconId(current => current === id ? null : current);
    refocusInCommit('[data-converge-toggle]');
  }, [setCanvasConverged, refocusInCommit]);
  const selectIcon = useCallback((id: string) => {
    setSelection([]);
    setSelectedEdgeId(null);
    setSelectedDisplayId(null);
    setSelectedIconId(id);
  }, []);
  // Each icon's members in ring order, the run's own order (step in the graph, then top to bottom, then left to right),
  // and its name: the whole canvas, a stage, or its first member and how many more.
  // Worked out only while an icon is drawn: a card's drag changes the nodes on every frame.
  const hasIcons = convergedView.icons.length > 0;
  const graphDepths = useMemo(() => hasIcons ? nodeDepths(nodes, edges.filter(edge => edge.kind !== 'feedback')) : NO_DEPTHS,
    [hasIcons, nodes, edges]);
  const iconMembers = useMemo(() => {
    if (!hasIcons) return new globalThis.Map<string, CanvasNode[]>();
    const byId = new globalThis.Map(nodes.map(node => [node.id, node]));
    return new globalThis.Map(convergedView.icons.map(icon => [icon.id, icon.members.flatMap(id => byId.get(id) ?? [])
      .sort((a, b) => (graphDepths.get(a.id) ?? 0) - (graphDepths.get(b.id) ?? 0) || a.y - b.y || a.x - b.x)]));
  }, [hasIcons, nodes, convergedView, graphDepths]);
  // A group is named by its first component and how many more (forms are inputs, not components).
  const iconTitle = (id: string, members: ReadonlyArray<CanvasNode>) => {
    if (id === CANVAS_GROUP_ID) return t('converge.wholeCanvas');
    const components = members.filter(node => node.kind !== 'form');
    return t('converge.more', { first: components[0]?.title.trim() || '—', count: Math.max(0, components.length - 1) });
  };
  // Converged groups are kept as cards are sized: per person and browser, pruned to the nodes on the canvas when saved.
  // A member deleted meanwhile is simply not drawn (convergeView skips it), and comes back converged if the deletion
  // is undone before the next save.
  useEffect(() => {
    const timer = setTimeout(() => saveConvergedState(converged, new Set(docRef.current.nodes.map(node => node.id))), 300);
    return () => clearTimeout(timer);
  }, [converged]);
  // 图标视图: every component drawn as its own live icon, wired as the cards are, and back. A way of looking as 收敛 is (for
  // readers, while the canvas runs, in the simple view), kept per person, browser and canvas; not while the whole canvas
  // is one icon (the toggle is greyed out then, with the reason). A wire being drawn ends, as its port moves.
  const toggleIconView = useCallback(() => {
    cancelWiringRef.current();
    const next = !iconViewRef.current;
    iconViewRef.current = next;
    setIconView(next);
    refocusInCommit('[data-icon-view-toggle]');
    announce(tLatest.current(next ? 'nodeIcon.announce.on' : 'nodeIcon.announce.off'));
  }, [announce, refocusInCommit]);
  useEffect(() => {
    const timer = setTimeout(() => saveIconView(iconView), 300);
    return () => clearTimeout(timer);
  }, [iconView]);
  // The results studio (成果工作台), over the board: one node's deliverables or the whole canvas's.
  const [studio, setStudio] = useState<{ nodeId?: string; entryId?: string } | null>(null);
  const openStudio = useCallback((nodeId?: string, entryId?: string) => setStudio({ nodeId, entryId }), []);
  // Every file the canvas made, for previews that show what another node generated. Keyed on outputs only, so a
  // moved card does not hand every card a new array (cards are memoised).
  const outputsKey = nodes.map(node => node.kind !== 'form'
    ? `${node.id}\u0001${node.title}\u0001${node.lastOutput?.at ?? ''}\u0001${node.lastOutput?.text.length ?? 0}` : node.id).join('\u0002');
  // Who handed each result in: an entry of one an invited Agent handed in is held (agentPages.ts), whatever its time.
  const handInsKey = JSON.stringify(nodes.map(node => handedInBy(node.lastOutput) ?? null));
  const canvasEntries = useMemo(() => studioGroups({ nodes: docRef.current.nodes, edges: docRef.current.edges }).flatMap(group => group.entries), [outputsKey, handInsKey]);
  // What the 预览展示 windows read, keyed so a moved card hands them nothing new (they are memoised and run pages).
  const edgesKey = edges.map(edge => `${edge.id}\u0001${edge.kind ?? ''}`).join('\u0002');
  const executionKey = doc.execution ? JSON.stringify(doc.execution) : '';
  const displayGroups = useMemo(() => studioGroups({ nodes: docRef.current.nodes, edges: edgesRef.current, execution: docRef.current.execution }),
    [outputsKey, handInsKey, edgesKey, executionKey]);
  const choicesKey = nodes.map(node => node.kind === 'session' ? `${node.id}\u0001${node.title}` : '').join('\u0002');
  const displayChoices = useMemo<DisplayChoice[]>(() => {
    const depths = nodeDepths(docRef.current.nodes, edgesRef.current.filter(edge => edge.kind !== 'feedback'));
    return docRef.current.nodes.flatMap((node, index) => node.kind === 'session' ? [{ id: node.id, title: node.title.trim() || node.id, depth: depths.get(node.id) ?? 0, index }] : [])
      .sort((a, b) => a.depth - b.depth || a.index - b.index).map(({ id, title }) => ({ id, title }));
  }, [choicesKey, edgesKey]);
  const runningKey = [...new Set([...busyNow, ...Object.entries(runs).filter(([, run]) => run.state === 'running').map(([id]) => id)])].sort().join('\u0001');
  const runningIds = useMemo<ReadonlySet<string>>(() => new Set(runningKey ? runningKey.split('\u0001') : []), [runningKey]);
  const visibleDisplayIds = useMemo(() => {
    const ids = new Set(stageMeasured ? visibleBoxIds(displays, view, size) : []);
    if (selectedDisplayId) ids.add(selectedDisplayId);
    return ids;
  }, [displays, view, size, selectedDisplayId, stageMeasured]);
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
  cancelWiringRef.current = wiring.cancelWiring;
  const marquee = useMarquee({
    enabled: selectionTool,
    // Only cards the board draws: a member inside an icon is never selected (and so never deleted or run) unseen. In the
    // icon view, each component's icon (its plate) is what a frame takes in.
    nodes: shownBoxes,
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
      // A converged icon is a way of looking, never deleted: Delete says how to reach its components instead.
      else if (!selection.length && selectedIconId) announce(t('converge.deleteHint'));
      else deleteNodes(selection);
    },
    onConvergeToggle: () => setCanvasConverged(!converged.canvas),
    // Undo/redo are locked during a run for the same reason every other structural edit is: the
    // run executes a SNAPSHOT, so rewinding the graph under it would show the operator a document
    // that does not match the timeline describing what is executing.
    onUndo: readOnly || running || initializing || !history.undo ? undefined : undo,
    onRedo: readOnly || running || initializing || !history.redo ? undefined : redo,
    // While components are inside an icon, a step back or forward would change them unseen (the last edit is rarely
    // what one expects ⌘Z to take back from a way of looking): the keys say to expand first, as Delete on the icon does.
    ...(membersHidden ? {
      onUndo: readOnly || running || initializing || !history.undo ? undefined : () => announce(t('converge.undoHint')),
      onRedo: readOnly || running || initializing || !history.redo ? undefined : () => announce(t('converge.redoHint')),
    } : {}),
    onSaveWaypoint: readOnly ? undefined : saveWaypoint,
    onRecallWaypoint: recallWaypoint,
    onEscape: () => {
      // Unwind outermost-first so one Escape never closes two things at once.
      if (addMenu) setAddMenu(null);
      else if (barMode) setBarMode(null);
      else if (selectionTool) setSelectionTool(false);
      else if (inspectorId) { if (!inspectorCloseLocked.current) setInspectorId(null); }
      else if (focusedId) unfocus();
      // A selected converged icon is let go first; Escape never expands it.
      else if (selectedIconId) setSelectedIconId(null);
      else setSelection([]);
    },
  }, !showingResults);
  const convergeKeyHint = keyBindings.find(binding => binding.action === 'converge-toggle')?.hint ?? formatChord('G', { mod: true });
  // Whether they work now, for the assistant panel's hand-back, which counts the navigation keys among them (below).
  const canvasKeysOn = useRef(true);
  canvasKeysOn.current = !showingResults;

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
  // 收敛 is a way of looking, so readers are offered it as well.
  // What holds undo, redo and arranging besides an icon (a reader, a run, nothing to step to): their "expand first"
  // titles are given only where expanding would let them work.
  const undoBlocked = readOnly || running || initializing || !history.undo;
  const redoBlocked = readOnly || running || initializing || !history.redo;
  const arrangeBlocked = readOnly || exclusiveNow || initializing || bindingLocked || !nodes.length;
  const convergeAction = {
    toggleConverged: () => setCanvasConverged(!converged.canvas),
    converged: converged.canvas,
    canConverge: stepCount >= MIN_GROUP_MEMBERS && !focusedId && !inspectorId,
    convergeHint: stepCount < MIN_GROUP_MEMBERS ? t('converge.needsTwo') : focusedId || inspectorId ? t('converge.closeOpen') : undefined,
  };
  const commandActions: CanvasCommandActions = useMemo(
    () => readOnly ? ({
      fitAll, toggleTimeline: focusedId ? undefined : () => setTimelineOpen(o => !o),
      toggleMinimap: focusedId ? undefined : () => setMinimapOpen(o => !o), recallWaypoint: () => recallWaypoint(1),
      ...convergeAction,
    }) : ({
      ...convergeAction,
      addSession: (kind) => addAtViewCenter(kind),
      canEdit,
      run: runUnavailableReason ? undefined : runWholeCanvas,
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
      // Not while components are inside an icon (see the keys above): then the rows say to expand first, not that there
      // is nothing to undo.
      canUndo: canEdit && history.undo > 0 && !membersHidden,
      canRedo: canEdit && history.redo > 0 && !membersHidden,
      undoHeld: canEdit && history.undo > 0 && membersHidden,
      redoHeld: canEdit && history.redo > 0 && membersHidden,
    }),
    // The last four are what convergeAction reads (it is rebuilt every render).
    [readOnly, addAtViewCenter, canEdit, startRun, runWholeCanvas, stopRun, fitAll, saveWaypoint, recallWaypoint, deleteNodes, selection, undo, redo, history.undo, history.redo, runUnavailableReason, focusedId,
      membersHidden, t, setCanvasConverged, converged.canvas, stepCount, inspectorId],
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
  // A node with an Agent of the Agent market (canvasMarket.tsx), added where the workspace and team-market Agents are.
  const addAgentMarketNode = useCallback((create: (pos: { x: number; y: number }) => SessionNode) => {
    if (!canEditStructure(false, [])) return false;
    const v = viewRef.current;
    const s = sizeRef.current;
    const node = create({ x: (-v.x + s.w / 2) / (v.scale || 1) - 170, y: (-v.y + s.h / 2) / (v.scale || 1) - 130 });
    patchDoc(previous => ({ ...previous, nodes: [...previous.nodes, node] }), { label: `add:${node.id}` });
    setSelection([node.id]); focusNode(node.id);
    return true;
  }, [canEditStructure, patchDoc, focusNode]);
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
    // A glide in flight is judged by where it lands, as autoFit's flush judges it: a glide cut short (the tab hidden, its
    // frames stopped) never saves a frame on the way, and the app's own camera (converging, say) is never saved at all.
    const kept = focusedRef.current && focusReturn.current ? focusReturn.current : glideTarget.current ?? view;
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
  // An empty box keeps no marks of words it held: a message the canvas took from it (sent, answered here, a repair, a
  // run) never lends them to words it writes there later (messagePages.ts TypedWords).
  useEffect(() => { if (!planning.draft) forgetTyped('assistant'); }, [planning.draft, forgetTyped]);
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
  const [assistantOpen, setAssistantOpenState] = useState(() => simple && !readOnly && isDesktopStage());
  // The open node the assistant has stepped aside for (focusNode): kept mounted, not drawn, while that node is open.
  const [stowedFor, setStowedFor] = useState<string | null>(null);
  // Opening or closing the assistant (画布助手, or a request that brings it up) ends its stepping aside.
  const setAssistantOpen = useCallback((open: boolean) => { setStowedFor(null); setAssistantOpenState(open); }, []);
  useEffect(() => { if (stowedFor !== null && stowedFor !== focusedId) setStowedFor(null); }, [stowedFor, focusedId]);
  // Whether an empty canvas's welcome holds the conversation in the latest render (set where the panel is decided, below),
  // and whether it did as the message being handled went (set as the assistant begins to wait, below).
  const welcomeShownRef = useRef(false);
  const waitFromWelcome = useRef(false);
  const [planningBusy, setPlanningBusy] = useState(false);
  // The assistant's canvas changes on the operator's model are outside today's calls up to a daily number (the server's
  // route usage says how many are left); read again whenever a plan settles, so the composer's note stays true.
  const [plannerAllowance, setPlannerAllowance] = useState<RouteAllowance | null>(null);
  // The free trial has ended for this hosted workspace (route-usage freePlan.ended): nothing runs until its owner subscribes.
  const [freePlanEnded, setFreePlanEnded] = useState(false);
  const cloudTenantId = cloudScope?.tenant.id;
  useEffect(() => {
    if (!cloudTenantId || planningBusy) return;
    const controller = new AbortController();
    fetchRouteUsage(cloudTenantId, controller.signal)
      .then(usage => {
        // Once the free trial has ended nothing is free: the note keeps its general wording.
        if (controller.signal.aborted) return;
        setPlannerAllowance(usage.freePlan?.ended ? null : usage.planner ?? null);
        setFreePlanEnded(usage.freePlan?.ended === true);
      })
      .catch(() => { /* The note then keeps its general wording. */ });
    return () => controller.abort();
  }, [cloudTenantId, planningBusy]);
  // A canvas run or a plan that may have spent calls has ended: the header meter reads today's numbers again.
  const spending = running || planningBusy;
  const wasSpending = useRef(false);
  useEffect(() => {
    if (wasSpending.current && !spending) announceRouteUsageChanged();
    wasSpending.current = spending;
  }, [spending]);
  // The host hears when a run or a plan this page was watching ends (设置 → 任务提醒), with whether any node failed.
  const workSettled = useRef(onWorkSettled);
  workSettled.current = onWorkSettled;
  // A lane's run counts as watched once it is seen running after recovery has settled (watchedLanes): a journal-restored
  // run that recovery finds already over ends without a word. A canvas run this page started is named at its end either
  // way (another lane's recovery may last the whole run).
  useEffect(() => {
    if (!recovering) laneRunning.forEach((on, lane) => { if (on) watchedLanes.current.add(lane); });
    if (running) return;
    const graphIds = endedGraphs.current.splice(0);
    if (watchedLanes.current.size || graphIds.length) workSettled.current?.({ kind: 'run', failed: Object.values(settledRuns.current).some(run => (run.state === 'failed' || run.state === 'blocked') && !givenBackBadges.current.has(run)), ...(graphIds.length ? { graphIds } : {}) });
    watchedLanes.current.clear();
  }, [running, recovering, laneRunning, namedGraphs]);
  // A plan that ends says whether it failed (its error is set in the same update); one the reader stopped says nothing.
  const wasPlanning = useRef(false);
  const planStopped = useRef(false);
  const planFailed = useRef('');
  useEffect(() => {
    if (wasPlanning.current && !planningBusy && !planStopped.current) workSettled.current?.({ kind: 'plan', failed: Boolean(planFailed.current) });
    if (planningBusy) planStopped.current = false;
    wasPlanning.current = planningBusy;
  }, [planningBusy]);
  const [planningError, setPlanningError] = useState('');
  planFailed.current = planningError;
  const [planningRecovery, setPlanningRecovery] = useState<Awaited<ReturnType<typeof readCanvasPlanRecovery>> | null>(null);
  const [recoveryLoaded, setRecoveryLoaded] = useState(!canInitialize);
  const [recoveryChecking, setRecoveryChecking] = useState(false);
  // The plan revision the planning recovery was last read for: until it has been read for this document, nothing may
  // resume what was read for another one (a new plan needs no such read: an entry refuses any other prompt or revision).
  const [recoveryRevision, setRecoveryRevision] = useState<string | null>(null);
  const recoveryForDocument = !canInitialize || recoveryRevision === planRevision;
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
  // Every fix request this page wrote, word for word: the nodes a plan adds never take one as their task (planSeedRequest).
  const writtenFixRequests = useRef(new Set<string>());
  const refreshPlanningRecovery = useCallback(async (signal?: AbortSignal) => {
    if (!canInitialize || !mounted.current || readOnlyRef.current || currentSaaSCanvas() !== cloudScope) return;
    const sequence = ++recoveryCheckSequence.current;
    const stillCurrent = () => mounted.current && !signal?.aborted && !readOnlyRef.current
      && currentSaaSCanvas() === cloudScope && sequence === recoveryCheckSequence.current;
    setRecoveryChecking(true);
    // Read (or failed) for this revision, the recovery is not read again on its own until the document changes.
    const revision = revisionOf(docRef.current);
    try {
      const recovery = await readCanvasPlanRecovery(docRef.current, signal, revision);
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
    } finally { if (stillCurrent()) { setRecoveryRevision(revision); setRecoveryChecking(false); } }
  }, [canInitialize, cloudScope, t, revisionOf]);
  useEffect(() => {
    if (!canInitialize || readOnly || planningBusy) return;
    const controller = new AbortController();
    const refresh = () => { void refreshPlanningRecovery(controller.signal); };
    const unsubscribe = subscribeCanvasKnowledge(refresh);
    refresh();
    return () => { controller.abort(); unsubscribe(); };
  }, [canInitialize, readOnly, planningBusy, refreshPlanningRecovery]);
  // A changed document's recovery is read once the document has stopped changing for a moment, not on every change: a
  // drag changes it on every frame, and a read started from the effects of that frame's commit set state that React
  // counted as nested in the next frame, and the next (React error #185 in a long drag on a slow machine).
  useEffect(() => {
    if (!canInitialize || readOnly || planningBusy || recoveryChecking || recoveryRevision === planRevision) return;
    const timer = setTimeout(() => { void refreshPlanningRecovery(); }, PLAN_RECOVERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [canInitialize, readOnly, planningBusy, recoveryChecking, recoveryRevision, planRevision, refreshPlanningRecovery]);
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
  // flight, an earlier plan to resume, one under way), else the reason to show. A plan built here (a lesson's
  // suggestion: applyEvolution) needs no planner, so the planner's availability does not hold it up (`planner` false).
  const planBlocker = (resume = false, planner = true): string | null => {
    // A message being handled (routed, becoming a task) is the one request in flight; nothing else plans meanwhile.
    if (readOnlyRef.current || pendingRef.current) return '';
    if (!resume && planner && planningUnavailableReason) return planningUnavailableReason;
    if (recoveryStopInFlight.current || (canInitialize && (!recoveryLoaded || recoveryChecking || (resume && !recoveryForDocument)))) return '';
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
  // This canvas's palette, none while it is another workspace's or canvas's.
  const planningCatalogue = (): readonly ModelPaletteSelection[] => {
    const live = paletteRef.current; const here = currentSaaSCanvas();
    return live && here && live.tenantId === here.tenant.id && live.canvasId === here.canvasId ? live.models : [];
  };
  // The chat models a plan may put a node on: this canvas's palette less the models only a user may choose
  // (userChosenModels.ts planModelsOf): the planner sees no other, and a plan's set_model resolves against the same list.
  const planningModels = () => planModelsOf(planningCatalogue());
  // What a plan's reply says a node now runs: its model as the node's model picker names it (modelNames.ts), never by
  // its selector, a model only a user may choose (the planner is not offered it) and one the palette lacks included.
  const plannedModelName = (_model: string, node: SessionNode) => nodeModelName(node, { models: planningCatalogue() }, locale);
  // The model the Agent nodes a plan adds without set_model will take (withAssistantModel), which the planner sizes them
  // by, once both reads it rests on are in: this canvas's palette and the host's own catalogue ("default" where they run
  // the workspace default). Until then the request names none, and they take the reader's choice when the plan lands,
  // as before plans named one; the desktop, which has no palette, names none.
  const planNewNodeChoice = () => {
    const live = paletteRef.current; const here = currentSaaSCanvas(); const host = executionRef.current;
    if (!live || !here || live.tenantId !== here.tenant.id || live.canvasId !== here.canvasId || (host && !host.componentModelRead)) return undefined;
    return componentModelEntry(host?.componentModel, live.models)?.model ?? DEFAULT_NEW_NODE_MODEL;
  };
  // `shown`: the reader's own words for the conversation, where the planner is given more (a hand-over's request).
  const sendPlanningMessage = async (request?: string, resume = false, shown?: string, pages?: MessagePage[]) => {
    // Keep the draft untouched and refuse before allocating a request or calling either planner.
    const blocked = planBlocker(resume);
    if (blocked !== null) { if (blocked) setPlanningError(blocked); return; }
    const prompt = (request ?? planning.draft).trim();
    if (!prompt) return;
    // The plan is for this document, and one that changes before it lands is refused (plan_stale): the tiles' waiting
    // last lines go in first, as they did when each was written as it came.
    writePreviews();
    // A resume is for the document its recovery was read for: lines that went in just now made another (read again soon).
    if (resume && canInitialize && revisionOf(docRef.current) !== recoveryRevision) return;
    const snapshot = docRef.current;
    const revision = revisionOf(snapshot);
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
      : { draft: request === undefined || previous.draft.trim() === (shown ?? prompt) ? '' : previous.draft,
        messages: [...previous.messages, { id: `${id}-user`, role: 'user' as const, content: shown ?? prompt, ...(route ? { route } : {}),
          ...(shown !== undefined && shown !== prompt ? { request: prompt } : {}), ...(pages?.length ? { pages } : {}) }].slice(-60) });
    try {
      const reportProgress = (progress: PlanProgress) => {
        // A superseded or cancelled request must not repaint the current one's progress.
        if (readOnlyRef.current || controller.signal.aborted || planningRequest.current?.id !== id) return;
        setPlanningProgress(progress);
      };
      // The planner sees the models a node can run (each once, where AwwO runs it) and how each node's last run ended,
      // so it can change a node's model and act on a failure the reader asks it to fix: what happened, not the note's
      // advice to the reader.
      const modelChoices = planningModels(); const planModels = modelChoices.choices;
      const planRuns = Object.fromEntries(Object.entries(runs).map(([id, run]) => [id,
        { state: run.state, ...(run.detail ? { detail: failureReason(t, run.detail, locale) || run.detail } : {}) }]));
      const jev = !resume && plannerProvider === 'jev'
        ? await requestJevPlan(prompt, snapshot, planningTurns(planning.messages), controller.signal, locale, reportProgress) : null;
      // A plan may give a node a team on a hosted canvas whose palette has a model ready on a team runtime: every hosted
      // runtime runs teams (canvasBridge.ts supportsNodeTeams), and the palette already says which are ready.
      const teams = currentSaaSCanvas() !== null && paletteRunsTeams(planModels);
      const plan = jev?.plan ?? await planRequest(prompt, snapshot, planningTurns(planning.messages), controller.signal, locale, reportProgress,
        { ...(resume ? { recoveryOperationId: planningRecovery!.operationId } : {}), mediaKinds, teams,
          models: automaticEntries(planModels).filter(entry => entry.available).map(entry => ({ id: entry.model, name: entry.name || entry.model,
            ...(entry.efforts?.length ? { efforts: entry.efforts } : {}), ...(entry.requiresUpgrade ? { paid: true } : {}) })),
          // The model the nodes it adds without set_model will take (withAssistantModel below), which it sizes them by.
          newNodeModel: planNewNodeChoice(),
          runs: planRuns, selected: selection });
      if (readOnlyRef.current || controller.signal.aborted || planningRequest.current?.id !== id) return;
      if (revisionOf(docRef.current) !== revision || laneGuard.current.active() || inspectorCloseLocked.current || hasStreamingConversation(docRef.current.nodes)) {
        appendPlanningMessage(`${id}-assistant`, surfaceNotice(t, 'plan_stale'), 'stale', route);
        setPlanning(previous => ({ ...previous, draft: previous.draft || prompt }));
        return;
      }
      const before = docRef.current;
      // The nodes it adds take the request as their first constraint, but never the canvas's own fix request in it: one
      // this page wrote, or the one it would write for a failure it shows now (a request written before a reload).
      const failedIds = Object.entries(runs).filter(([, run]) => run.state === 'failed').map(([nodeId]) => nodeId);
      const seed = planSeedRequest(prompt, [...writtenFixRequests.current,
        ...(failedIds.length ? [fixRequestText(failedIds), ...failedIds.map(nodeId => fixRequestText([nodeId]))] : [])]);
      // A planned page gets the design skills only where AwwO runs the models: a model on a personal key is given 32K
      // counted in bytes (connections.go), and the skills would take some 40% of it.
      const hosted = currentSaaSCanvas() !== null;
      const planned = jev ? applyJevPlan(before, jev, locale, seed)
        : applyCanvasPlan(before, plan, locale, seed, planMedia, modelChoices, hosted, hosted && !personalCredentialsRequired, teams);
      // The components a plan adds start on the model the reader chose for the canvas assistant (Jev picks its own):
      // the one its request named, which the planner sized them for (a resume's, chosen before the reader changed it;
      // planComponentModel), against the reader's choice now, which may have changed while it planned; except a node the
      // plan itself put on a model, the workspace default included.
      const applied = jev ? planned : { ...planned, doc: withAssistantModel(planned.doc,
        planned.addedNodeIds.filter(id => !planned.modelSetNodeIds.includes(id)),
        planComponentModel(planNewNodeModel(plan), executionRef.current?.componentModel, paletteRef.current?.models ?? []), paletteRef.current?.models ?? []) };
      // Every step skipped (each one said in the adjustments) leaves the canvas as it was: nothing to patch, undo
      // or select, and the reply says so instead of calling it applied.
      const changed = revisionOf(before) !== revisionOf(applied.doc);
      if (changed) {
        fitted.current = true;
        patchDoc(() => applied.doc, { label: `ai:${id}` });
        planUndoEntry.current = undoStack.current.at(-1) ?? null;
        setLastPlanRevision(revisionOf(docRef.current));
        setFocusedId(null);
        focusReturn.current = null;
        setInspectorId(null);
        setSelection(applied.addedNodeIds);
        setAssistantOpen(true);
        setPlanningFitId(id);
        // From an empty canvas's welcome the plan takes the conversation to the side panel, whose box comes up idle and
        // so does not take the focus back as it does after a message handled in the panel: a focus left on the page
        // goes there, as for a task's start. One that removed every node takes it back to the welcome the same way,
        // where tasks do not keep the panel (with them, the panel's own hand-back does, where the reader stayed with it).
        if (welcomeShownRef.current) refocusInCommit(PANEL_BOX);
        else if (!applied.doc.nodes.length) refocusInCommit(WELCOME_BOX);
      }
      // A plan that changed nothing else keeps the nodes it added, which tell whether it is still on the canvas.
      // What was applied differently from how the plan wrote it is said with its summary, never hidden.
      const shownAdjustments = applied.adjustments.slice(0, PLAN_NOTES_SHOWN);
      // Media nodes a plan added: said once, so the user knows a canvas run generates them and Send makes one alone.
      const addedMedia = changed ? applied.doc.nodes.filter(node => applied.addedNodeIds.includes(node.id) && node.kind === 'session' && mediaKindOf(node.agentKind)).length : 0;
      // What the canvas now holds, node by node, under the model's own summary of what it meant to do.
      const changes = changed ? describePlanChanges(before, applied.doc, locale, t, plannedModelName) : [];
      // A plan made from a shortened view of a large canvas says so: those texts were left as they are.
      const condensedNodes = jev ? 0 : planContextCondensed(plan)?.size ?? 0;
      const lead = [...(!changed && plan.operations.length ? [applied.summary, t('planning.nothingApplied')] : [applied.summary]),
        ...(condensedNodes ? [t('planning.condensed', { count: condensedNodes })] : []),
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
  // A lesson's suggestion (CanvasEvolution) applied as a plan of one step: the node's reasoning effort, on the model it
  // runs (or the one its lesson's runs ran with, for a node on the workspace's default), through applyCanvasPlan as
  // any plan, so a node it does not fit (media, a team, a model that does not offer the effort) is left as it is and
  // the reply says why. Committed as a plan ('ai:'), the assistant's undo takes it back; it clears the node's outputs
  // and those downstream as any change of its model does. Refused while a plan, a run or a message is under way.
  // What a suggestion's request comes to is said in the assistant's panel, opened for it (the 经验 panel it came from
  // has closed), in its conversation under the suggestion's own words, so a later reply leaves it standing. While a
  // turn of the conversation is in flight (a message being handled, a plan being made) nothing can join it: a refusal
  // then shows where a plan's refusal would (planningError) and is held, to join the conversation, and leave that
  // place, with the next thing a suggestion says.
  const heldEvolutionReplies = useRef<{ text: string; reason: string }[]>([]);
  // A note that is no reply to a message of the conversation (an auto rerun's, `routed` false) carries no route's label.
  const sayEvolution = (text: string, status?: 'applied', routed = true) => {
    for (const held of heldEvolutionReplies.current.splice(0)) {
      appendPlanningMessage(`lesson-${Date.now()}-${++planningSequence.current}-assistant`, held.text, undefined, assistantExecution ? 'plan' : undefined);
      setPlanningError(current => current === held.reason ? '' : current);
    }
    appendPlanningMessage(`lesson-${Date.now()}-${++planningSequence.current}-assistant`, text, status, routed && assistantExecution ? 'plan' : undefined);
  };
  const refuseEvolution = (reason: string, request: CanvasEvolution): CanvasEvolutionResult => {
    setAssistantOpen(true);
    const text = [request.note, reason].join('\n');
    if (pendingRef.current || planningRequest.current) { setPlanningError(reason); heldEvolutionReplies.current.push({ text, reason }); }
    else sayEvolution(text);
    return { applied: false, reason };
  };
  const applyEvolution = (request: CanvasEvolution): CanvasEvolutionResult => {
    // A page whose canvas is out of date keeps none of its edits (patchDoc), so it takes no suggestion either.
    if (outdatedObserver.current) return refuseEvolution(t('planning.evolutionOutdated'), request);
    const blocked = planBlocker(false, false);
    if (blocked !== null) return refuseEvolution(blocked || recoveryReadError.current || surfaceNotice(t, 'planning_busy'), request);
    if (paletteError) return refuseEvolution(paletteError, request);
    writePreviews();
    const before = docRef.current;
    const node = before.nodes.find(item => item.id === request.nodeId);
    if (!node) return refuseEvolution(t('planning.evolutionNodeGone'), request);
    if (request.expect !== undefined && (node.kind !== 'session' || (node.effort ?? '') !== request.expect)) return refuseEvolution(t('planning.evolutionChanged'), request);
    if (request.expectMark !== undefined && (node.kind !== 'session' || node.evolution?.change !== request.expectMark)) return refuseEvolution(t('planning.evolutionChanged'), request);
    if (request.since !== undefined && (effortChangedAt.current.get(node.id) ?? 0) > request.since) return refuseEvolution(t('planning.evolutionChanged'), request);
    // The node keeps its model; one on the workspace default takes the model its lesson's runs ran with, which a lesson
    // from an API before 2026-11-02 does not name.
    const model = (node.kind === 'session' && node.model) || request.model;
    if (!model) return refuseEvolution(t('planning.evolutionNoModel'), request);
    const plan: CanvasPlan = { version: 1, summary: request.note, operations: [{ type: 'set_model', nodeId: node.id, model, effort: request.effort }] };
    const hosted = currentSaaSCanvas() !== null;
    const modelChoices = planningModels();
    const planned = applyCanvasPlan(before, plan, locale, '', planMedia, modelChoices, hosted, hosted && !personalCredentialsRequired);
    // A change of the canvas's evolution leaves its mark on the node it makes (undone with it, as the plan is).
    const change = request.change;
    const applied = change ? { ...planned, doc: { ...planned.doc, nodes: planned.doc.nodes.map(item => item.id === node.id && item.kind === 'session'
      ? { ...item, evolution: { change } } : item) } } : planned;
    // Judged by the node alone: a plan may also tidy the canvas (an edge left without its node), which takes no
    // suggestion; and a node its plan left at another effort (its model offers no such level) has not taken it.
    const after = applied.doc.nodes.find(item => item.id === node.id);
    if (after?.kind !== 'session' || after.effort !== request.effort) return refuseEvolution(applied.adjustments[0] || t('planning.evolutionNotApplied'), request);
    const id = `lesson-${Date.now()}-${++planningSequence.current}`;
    const runsAs = (item: SessionNode) => [item.runtime, item.model, item.effort].join('\n');
    if (node.kind === 'session' && runsAs(after) === runsAs(node)) {
      setAssistantOpen(true);
      sayEvolution([request.note, t('planning.evolutionNothing')].join('\n'));
      return { applied: false, satisfied: true, reason: t('planning.evolutionNothing') };
    }
    // Everything said is worked out before the canvas changes, so nothing after the change can leave it unsaid.
    const changes = describePlanChanges(before, applied.doc, locale, t, plannedModelName);
    const reply = [request.note, ...(changes.length ? [t('planning.changesHeader'), ...changes.map(line => `· ${line}`)] : []),
      ...applied.adjustments.slice(0, PLAN_NOTES_SHOWN).map(item => `· ${item}`)].join('\n');
    patchDoc(() => applied.doc, { label: `ai:${id}` });
    // Taken only once the canvas holds it, judged by the node (patchDoc clears the outputs the change makes stale, so
    // the canvas it keeps is not the plan's to the byte): a change patchDoc kept from the canvas (a node running there,
    // a review holding the canvas) is no plan the reader could undo.
    const committed = docRef.current.nodes.find(item => item.id === node.id);
    if (docRef.current === before || committed?.kind !== 'session' || runsAs(committed) !== runsAs(after)) return refuseEvolution(t('planning.evolutionNotApplied'), request);
    planUndoEntry.current = undoStack.current.at(-1) ?? null;
    setLastPlanRevision(revisionOf(docRef.current));
    setAssistantOpen(true);
    sayEvolution(reply, 'applied');
    return { applied: true };
  };
  // Each suggestion the host hands over is applied once (a re-render passes the same request again), once this canvas's
  // palette, which its model is resolved against, is read, and its check for a plan to resume is done, as a plan of the
  // assistant's waits for. A palette or a check that could not be read ends the wait, and the suggestion says why.
  const appliedEvolution = useRef('');
  const recoveryRead = recoveryLoaded || (recoveryRevision !== null && recoveryRevision === revisionOf(docRef.current));
  const evolutionWaits = canInitialize && ((!palette && !paletteError) || !recoveryRead || recoveryChecking);
  useEffect(() => {
    if (!evolution || readOnly || appliedEvolution.current === evolution.id || evolutionWaits) return;
    appliedEvolution.current = evolution.id;
    if (evolution.wanted?.() === false) { onEvolutionSettled?.(evolution.id, { applied: false }); return; }
    // A suggestion that cannot be made into a plan says so; it never takes the canvas down with it.
    let result: CanvasEvolutionResult;
    try { result = applyEvolution(evolution); } catch { result = refuseEvolution(t('planning.evolutionNotApplied'), evolution); }
    onEvolutionSettled?.(evolution.id, result);
    // The request and what it waits for decide: the surface's state it reads is the latest at the time they arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evolution, readOnly, evolutionWaits]);
  // A run the host's canvas evolution asks for starts once, once the canvas is ready as a suggestion waits for it, as
  // any run the reader starts would (refused the same way, with the same notes). Once it started, the assistant's panel
  // says why the canvas runs by itself. Whether it started goes back to the host.
  const startedAutoRun = useRef('');
  useEffect(() => {
    if (!autoRun || readOnly || startedAutoRun.current === autoRun.id || evolutionWaits) return;
    startedAutoRun.current = autoRun.id;
    const request = autoRun;
    void startRun(request.scope, undefined, undefined, undefined, undefined, undefined, request.operationId).catch(() => undefined).then(() => {
      const started = laneList.some(lane => lane.journal.current?.id === request.operationId);
      if (started && mounted.current) { setAssistantOpen(true); sayEvolution(request.note, undefined, false); }
      onAutoRunSettled?.(request.id, { started });
    });
    // The request and what it waits for decide, as for a suggestion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, readOnly, evolutionWaits]);
  const cancelPlanning = async () => {
    if (readOnlyRef.current || recoveryStopInFlight.current) return;
    const request = planningRequest.current;
    const prompt = request?.prompt ?? planningRecovery?.prompt;
    if (!request && !planningRecovery?.pending) return;
    planningRequest.current = null;
    planStopped.current = true;
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
  // On a hosted canvas it also waits, at most HAND_OVER_MODEL_WAIT_MS, until the model its new nodes take is known
  // (planNewNodeChoice), so it is sized for the reader's choice as a request sent from the box is.
  const [handOverWaited, setHandOverWaited] = useState(false);
  useEffect(() => {
    if (!initialPlan || readOnly || !canInitialize) return;
    const timer = setTimeout(() => setHandOverWaited(true), HAND_OVER_MODEL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [initialPlan, readOnly, canInitialize]);
  const newNodeChoiceRead = Boolean(assistantExecution?.componentModelRead);
  const newNodeChoiceModel = assistantExecution?.componentModel?.model;
  useEffect(() => {
    const request = initialPlan;
    if (!request || readOnly || initialPlanSettled.current) return;
    // The person wrote it on the home: theirs whenever the box holds it as carried, before anything below settles the
    // hand-over (a recovery, nodes on the canvas), and while it stays there (a stopped read, a page not read, a reload
    // that put it back).
    if (!request.untrusted && planning.draft === request.prompt && typedWords.current.get('assistant')?.text !== request.prompt) {
      typedWords.current.set('assistant', { text: request.prompt, typed: [[0, request.prompt.length]] });
    }
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
    // A palette that could not be read will not be: the request goes without naming the model.
    if (canInitialize && !paletteError && !handOverWaited && planNewNodeChoice() === undefined) return;
    const timer = setTimeout(() => {
      // The reader sent it from the box meanwhile (sendAssistantMessage settles it), or another message is being handled:
      // never a second read or plan of it.
      if (initialPlanSettled.current) return;
      if (pendingRef.current || planningRequest.current) { settle(); return; }
      initialPlanSettled.current = true;
      if (!request.claim()) { request.done(); return; }
      // An unmount mid-plan leaves the claim in place, so the next page says the plan was interrupted. The pages it
      // names are read first; one that is not leaves the request in the box, with why. One that names none is planned
      // at once, as before.
      const planned = !namesPages(request.prompt) ? sendPlanningMessage(request.prompt) : (async () => {
        const read = await assistantLatest.current!.readAssistantPages(`turn-${Date.now()}-${++planningSequence.current}`, request.prompt,
          request.untrusted ? new Set() : undefined);
        // A read takes time: the plan goes as the latest render sends it, and only onto a canvas still empty.
        if (!read || read.hold || !mounted.current || docRef.current.nodes.length) return;
        await assistantLatest.current!.sendPlanningMessage(request.prompt, false, undefined, read.pages);
      })();
      void planned.finally(() => { if (mounted.current) request.done(); });
    }, 0);
    return () => clearTimeout(timer);
  }, [initialPlan, readOnly, planning.draft, plannerStatusKnown, planningUnavailableReason, runUnavailableReason,
    canInitialize, recoveryLoaded, recoveryChecking, planningRecovery?.pending, palette, paletteError, handOverWaited,
    newNodeChoiceRead, newNodeChoiceModel]);
  // ---- one conversation, routed by the server (assistantRouting.ts) -----------------------------------
  // Where the host also does tasks, each message goes to the server first, which says whether it arranges the
  // canvas or becomes a task. A message the router cannot answer for is planned: a plan is undone in one step
  // and makes one call, where a task makes up to sixteen and acts in a workspace.
  // A message joins the conversation once it is handled. Until then the box keeps it and the conversation shows it
  // pending, so a stop, a refusal or leaving the page never strands it.
  const unifiedHost = assistantExecution && routeAssistant ? assistantExecution : undefined;
  // Handlers resume after awaiting the server; what they read then is the latest render's (set below).
  const assistantLatest = useRef<{ planBlocker: typeof planBlocker; sendPlanningMessage: typeof sendPlanningMessage;
    canUndoPlan: boolean; undo: typeof undo; readAssistantPages: typeof readAssistantPages } | null>(null);
  // Hands the latest request over to the other way with a correction added, as the latest render can (set below):
  // false when it cannot, so the correction is handled as a message of its own.
  const redirectLatest = useRef<((to: AssistantRoute, correction: string) => boolean) | null>(null);
  // Routing needs to know whether a task can start, so a canvas that routes has the service read once it opens.
  useEffect(() => { if (!readOnly && routeAssistant) executionRef.current?.activate(); }, [readOnly, routeAssistant]);
  // The unconfirmed turn a settled submission belongs to: the one carrying its identity. None may be here (another
  // tab's submission), and a turn without one (saved before identities were kept) has no submission waiting for it.
  const unconfirmedTurn = (messages: PlanningMessage[], operationId: string) =>
    messages.findIndex(message => message.status === 'unconfirmed' && message.operationId === operationId);
  // The request a reply answers.
  const requestBefore = (messages: PlanningMessage[], index: number) =>
    messages.slice(0, index).reverse().find(message => message.role === 'user')?.content ?? '';
  // The turn a confirmed start becomes the task of: the request recorded for it, unconfirmed or settled with no task
  // (given up). None where its task is already in the conversation, or where the start is another page's own (a page
  // announces every task it starts).
  const confirmedTurn = (messages: PlanningMessage[], confirmed: { taskId: string; operationId: string }) =>
    messages.some(message => message.taskId === confirmed.taskId) ? -1
      : messages.findIndex(message => (message.status === 'unconfirmed' || message.status === 'error') && message.operationId === confirmed.operationId);
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
  // recorded for it, unconfirmed or settled with no task (given up), becomes that task's turn, and leaves the box. The
  // host lists every confirmation of the canvas, once per submission, so none is lost to another that comes before the
  // page draws it; each is linked (a turn already linked is left).
  // A focus a new one took goes to the message box of whichever holds the conversation then: where its task takes the
  // conversation out of an empty canvas's welcome to the side panel (open), the welcome's box with it, as for a task's
  // start; and where the reconcile was pressed here (`here`), its button going with its box, in the welcome or in the
  // panel. A start another page announces while the conversation stays where it is moves none, nor one the host already
  // listed when the canvas opened (it outlives the canvas, which is drawn again once its document is read).
  const confirmedTasks = assistantExecution?.confirmedTasks;
  const [confirmationsSeen] = useState(() => new Set(confirmedTasks ?? []));
  useLayoutEffect(() => {
    const listed = confirmedTasks ?? [];
    const arrived = listed.filter(confirmed => !confirmationsSeen.has(confirmed));
    for (const confirmed of arrived) confirmationsSeen.add(confirmed);
    if (!listed.length || readOnly) return;
    setPlanning(previous => listed.reduce((state, confirmed) => {
      const index = confirmedTurn(state.messages, confirmed);
      if (index < 0) return state;
      const { status, operationId: _operation, ...reply } = state.messages[index];
      const messages = [...state.messages];
      messages[index] = { ...reply, content: '', taskId: confirmed.taskId };
      const request = status === 'error' ? requestBefore(messages, index) : '';
      return { draft: request && state.draft.trim() === request ? '' : state.draft, messages };
    }, previous));
    const takesWelcome = (confirmed: (typeof listed)[number]) => welcomeShownRef.current && assistantOpen && confirmedTurn(planning.messages, confirmed) >= 0;
    if (arrived.some(confirmed => confirmed.here || takesWelcome(confirmed))) refocusInCommit(MESSAGE_BOX);
  }, [confirmedTasks, readOnly]);
  useEffect(() => () => { pendingRef.current?.controller?.abort(); pendingRef.current = null; }, []);
  const planAvailable = !readOnly && !planningUnavailableReason;
  const assistantRoutes = (): AssistantRoute[] => {
    const routes: AssistantRoute[] = [];
    if (planAvailable) routes.push('plan');
    if (assistantExecution?.ready && !assistantExecution.readOnly) routes.push('execute');
    return routes;
  };
  const failureText = (error: unknown) => error instanceof Error && error.message ? error.message : t('assistant.unavailable');
  // `request`: a hand-over's whole request, kept on the turn so a later correction hands it over again.
  const userTurn = (id: string, prompt: string, route: AssistantRoute, request?: string, pages?: MessagePage[]) => ({ id: `${id}-user`, role: 'user' as const, content: prompt, route,
    ...(request !== undefined && request !== prompt ? { request } : {}), ...(pages?.length ? { pages } : {}) });
  // The identity a task is sent under, chosen here so its turn can carry it.
  const submissionId = () => `execution-${crypto.randomUUID()}`;
  // The web pages a message names, read before it is handled (messagePages.ts): those whose addresses the person typed
  // or pasted into the box (`typed`), or every one the home's request names (absent). Held (an address was not read):
  // the box keeps the message and says which and why, and the same message sent again goes without that page. null:
  // stopped, the read failed (the box keeps the message, and says so), or the page has gone.
  const readAssistantPages = async (id: string, prompt: string, typed?: ReadonlySet<string>): Promise<{ pages?: MessagePage[]; hold: boolean } | null> => {
    const read = readPagesRef.current;
    if (!read || !namesPages(prompt)) return { hold: false };
    const controller = new AbortController();
    setPending({ id, prompt, phase: 'reading' }, controller);
    let outcome: MessagePagesOutcome | null = null;
    let failed = false;
    try {
      outcome = await read({ text: prompt, scope: 'assistant', ...(typed ? { typed } : {}) }, controller.signal,
        reading => { if (pendingId() === id && !controller.signal.aborted) setPending({ id, prompt, phase: 'reading', reading }, controller); });
    } catch (error) { failed = !(error instanceof DOMException && error.name === 'AbortError'); }
    if (pendingId() !== id || controller.signal.aborted || !mounted.current) return null;
    setPending(null);
    if (!outcome) { if (failed) setPlanningError(t('assistant.pagesFailed')); return null; }
    if (outcome.hold) { setPlanningError(t('assistant.pagesHeld', { pages: unreadPages(outcome.pages) })); return { hold: true }; }
    forgetTyped('assistant');
    return { pages: outcome.pages.length ? outcome.pages : undefined, hold: false };
  };
  // A message routed to a task. Started, it joins the conversation with its task; refused, with the reason, and the
  // box keeps it; unconfirmed, the host offers to reconcile it and the box lets it go, so it is not sent twice.
  const startAssistantTask = async (prompt: string, id: string, pages?: MessagePage[]) => {
    const host = executionRef.current;
    if (!host) return;
    const operationId = submissionId();
    setPending({ id, prompt, phase: 'starting', operationId });
    try {
      const taskId = await host.start(prompt, operationId);
      if (!mounted.current) return;
      setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
        userTurn(id, prompt, 'execute', undefined, pages), { id: `${id}-task`, role: 'assistant' as const, content: '', route: 'execute' as const, taskId }].slice(-60) }));
      setAssistantOpen(true);
      // A task that starts takes the conversation to the side panel (on an empty canvas, out of the welcome, whose box
      // had the focus), and a focus it left on the page to the panel's box, in the commit that draws the panel: React
      // draws the start in a scheduler task, which a frame can come before (see refocus). Only where the welcome held the
      // conversation as the message went and still does as the task starts: a node the reader added meanwhile took it
      // away, and the reader with it (adding one from the models closes the assistant and opens the node); and one sent
      // from the panel, whose last node the reader deleted meanwhile, is the panel's own hand-back's (panelWaitHeld:
      // there the reader stayed with the panel, or not).
      if (waitFromWelcome.current && welcomeShownRef.current) refocusInCommit(PANEL_BOX);
    } catch (error) {
      if (!mounted.current) return;
      const unconfirmed = error instanceof TaskStartUnconfirmed;
      const reason = unconfirmed ? t('assistant.startUnconfirmed') : failureText(error);
      if (!unconfirmed) setPlanningError(reason);
      setPlanning(previous => ({ draft: unconfirmed && previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
        userTurn(id, prompt, 'execute', undefined, pages), { id: `${id}-task`, role: 'assistant' as const, content: reason,
          status: unconfirmed ? 'unconfirmed' as const : 'error' as const, route: 'execute' as const, ...(unconfirmed ? { operationId } : {}) }].slice(-60) }));
    } finally { if (pendingId() === id) setPending(null); }
  };
  // A message routed to the canvas: refused with the reason (the box keeps it), or planned.
  const planRouted = (prompt: string, id: string, pages?: MessagePage[]) => {
    // The planner takes at most 8000 bytes. A longer message goes to a task when one can start, as the reader would
    // expect of an assistant; otherwise the reply says so and the box keeps it.
    if (new TextEncoder().encode(prompt).length > 8000) {
      if (executionRef.current?.ready) { void startAssistantTask(prompt, id, pages); return; }
      setPlanning(previous => ({ ...previous, messages: [...previous.messages, userTurn(id, prompt, 'plan', undefined, pages),
        { id: `${id}-assistant`, role: 'assistant' as const, content: t('assistant.tooLongToPlan'), status: 'error' as const, route: 'plan' as const }].slice(-60) }));
      return;
    }
    const blocked = assistantLatest.current!.planBlocker();
    if (blocked !== null) { setPlanningError(blocked || t('assistant.notNow')); return; }
    void assistantLatest.current!.sendPlanningMessage(prompt, false, undefined, pages);
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
    // Sent from the box, the home's request is the reader's to send now: the hand-over leaves it to them.
    if (initialPlan && !initialPlanSettled.current) { initialPlanSettled.current = true; initialPlan.done(); }
    // The web pages it names are read first, so the plan, the task or the components it starts cite them. A message that
    // names none goes on in this same tick, exactly as before.
    const read: { pages?: MessagePage[]; hold: boolean } | null = namesPages(prompt) ? await readAssistantPages(id, prompt, typedIn('assistant', prompt)) : { hold: false };
    if (!read || read.hold) return;
    const pages = read.pages;
    let route: AssistantRoute = routes.includes('plan') ? 'plan' : routes[0];
    let redirect = false;
    if (routes.length > 1) {
      const controller = new AbortController();
      const request = assistantRouteRequest(prompt, routes, docRef.current, planning.messages, taskId => executionRef.current?.outcome?.(taskId));
      setPending({ id, prompt, phase: 'routing' }, controller);
      try { ({ route, redirect = false } = await routeAssistant(request, controller.signal)); }
      catch { /* The router did not answer: the message is handled the default way rather than lost. */ }
      // Stopped while it was routed (the box still holds it), or the page has gone.
      if (pendingId() !== id || controller.signal.aborted || !mounted.current) return;
      setPending(null);
    }
    // A correction (别改画布，直接写吧) hands the request before it over to the other way, with the correction added:
    // the reader never picks a way by hand. Where that request cannot be handed over, the message is handled alone.
    if (redirect && redirectLatest.current?.(route, prompt)) return;
    if (route === 'execute') await startAssistantTask(prompt, id, pages);
    else planRouted(prompt, id, pages);
  };
  // A task's card sends a follow-up (the request again) straight to a new task, as its own turn.
  const sendTaskFollowUp = (text: string) => {
    if (readOnlyRef.current || pendingRef.current || planningRequest.current || !text.trim()) return;
    void startAssistantTask(text.trim(), `turn-${Date.now()}-${++planningSequence.current}`);
  };
  /** Stops a message being routed, or whose pages are being read; the box still holds it. False when none is. */
  const cancelRouting = () => {
    const current = pendingRef.current;
    if (current?.pending.phase !== 'routing' && current?.pending.phase !== 'reading') return false;
    current.controller?.abort();
    setPending(null);
    return true;
  };

  const canUndoPlan = !readOnly && !planningBusy && !running && !bindingLocked && history.undo > 0
    && lastPlanRevision !== null && planRevision === lastPlanRevision
    && Boolean(lastCommit.current?.label.startsWith('ai:')) && canEditStructure();
  assistantLatest.current = { planBlocker, sendPlanningMessage, canUndoPlan, undo, readAssistantPages };
  // After the assistant took its plan back while components were inside an icon: the cards are drawn again to show it.
  const showPlanUndone = () => {
    if (convergedViewRef.current?.hidden.size || convergedNowRef.current.canvas) showConverged(NOTHING_CONVERGED, t('converge.announce.shownForChange'));
  };
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
  // The assistant can be asked to fix a failure or fill in inputs only while it can plan (and not through Jev, which
  // adds nodes rather than repairing one).
  const assistantCanPlan = !planningUnavailableReason && plannerProvider !== 'jev' && plannerStatus?.available !== false;
  const suggested: NextSteps | null = readOnly || initializing || bindingLocked ? null : canvasNextSteps({
    nodes, edges, runs, running, canRun: !runUnavailableReason, resultsAvailable: Boolean(results), upgradeAvailable: Boolean(cloudScope) && !localEdition,
    // A refusal's detail is the run error's own copy (canvasErrors), in whichever language the run was read in, or its
    // code (runRefusals.ts). The end of the free trial stops every node alike until the owner subscribes, as a full
    // allowance does, so it is one too: the plans lift it (upgradeHelps) and no other model would run (modelSwitchHelps).
    isPremiumRefusal, isQuotaRefusal: (detail: string) => isQuotaRefusal(detail) || isFreePlanEnded(detail), upgradeHelps, modelSwitchHelps,
    // Only the hosted workspace puts a node's task requirements into its prompt, which is how a rework carries the
    // review's findings.
    reworkAvailable: Boolean(cloudScope),
    canPlan: assistantCanPlan,
    // A hosted canvas runs on the server, which generates its media nodes and renders its edits.
    cloudRuns: Boolean(cloudScope),
    timelineLabel: t('edit.portTimeline'),
  });
  // Only the hosted app counts calls, so only it says what a step costs (and that this advice cost none): at least its
  // calls, and a generation for each image, video and 3D node it runs.
  const countsCalls = Boolean(cloudScope);
  const withCost = (label: string, { calls, generations }: { calls: number; generations?: number }) => !countsCalls ? label
    : generations ? t(calls ? 'assistant.nextWithCost' : 'assistant.nextWithGenerations', { label, calls, generations })
    : calls ? t('assistant.nextWithCalls', { label, calls }) : label;
  // The same, as a sentence after a reply that starts a run from the conversation.
  const runCostText = ({ calls, generations }: { calls: number; generations?: number }) => !countsCalls ? ''
    : generations ? t(calls ? 'assistant.runCost' : 'assistant.runGenerations', { calls, generations })
    : calls ? t('assistant.runCalls', { calls }) : '';
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
  // Said as the reader's own message, so it carries what happened, and the request says how to change the canvas.
  const fixRequestText = (ids: ReadonlyArray<string>) => {
    const failedNodes = ids.map(titleOf).filter(Boolean);
    return t('assistant.fixRequest', { nodes: failedNodes.map(name => locale === 'zh' ? `「${name}」` : `“${name}”`).join(listSeparator),
      reason: failureReason(t, runs[ids[0]]?.detail, locale) || t('assistant.repairNoReason') });
  };
  const fixRequest = (ids: ReadonlyArray<string>) => {
    const text = fixRequestText(ids);
    const written = writtenFixRequests.current;
    written.delete(text); written.add(text);
    // The newest fifty: one asked about long ago has been planned since.
    if (written.size > 50) written.delete(written.values().next().value!);
    return text;
  };
  // A node handed to the assistant from its own view: 'edit' starts the request in the composer (the reader says what
  // to change), 'fix' asks it to make the failed node finish, as the 接下来 card's step does.
  // A fix the assistant cannot take now (it is busy, or cannot plan) waits in its composer as a draft, never lost.
  askAboutNodeRef.current = (nodeId: string, kind: 'edit' | 'fix') => {
    if (readOnlyRef.current) return;
    if (kind === 'fix' && assistantCanPlan && !planningBusy && planBlocker() === null) { askAssistant(fixRequest([nodeId])); return; }
    setAssistantOpen(true);
    const lead = kind === 'fix' ? fixRequest([nodeId]) : t('brief.askAssistantDraft', { node: titleOf(nodeId) });
    // A draft the reader started is theirs: a change request leaves it, a fix request goes after it.
    setPlanning(previous => !previous.draft.trim() ? { ...previous, draft: lead }
      : kind === 'fix' && !previous.draft.includes(lead) ? { ...previous, draft: `${previous.draft.trimEnd()}\n${lead}` } : previous);
    // The message box, not a box that a task card above it holds (a question's answer), which the draft is not in.
    requestAnimationFrame(() => {
      const scope = rootRef.current?.closest('.awwo-workspace') ?? document;
      const box = scope.querySelector<HTMLTextAreaElement>(PANEL_BOX) ?? scope.querySelector<HTMLTextAreaElement>(MESSAGE_BOX);
      box?.focus(); box?.setSelectionRange(box.value.length, box.value.length);
    });
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
      case 'rerun-failed': return { id: 'rerun-failed', primary, label: withCost(t('assistant.nextRerunFailed'), step), onSelect: () => void startRun(downstreamClosure(step.nodeIds)) };
      // The inputs are filled in where they are: the node opens on its input drawer (Configure has no input fields).
      // An edit's timeline is written in its settings.
      case 'fill-inputs': return { id: `fill-${step.nodeId}`, primary, label: t('assistant.nextFillShort'), ariaLabel: t('assistant.nextFill', { node: titleOf(step.nodeId) }),
        onSelect: () => nodes.find(node => node.id === step.nodeId)?.kind === 'edit' ? configureNode(step.nodeId) : openNodeInputs(step.nodeId) };
      case 'assistant-fix': return { id: 'assistant-fix', primary, label: t('assistant.nextAssistantFix'), onSelect: () => askAssistant(fixRequest(step.nodeIds)) };
      case 'assistant-fill': return { id: 'assistant-fill', primary, label: t('assistant.nextAssistantFill'), onSelect: () => askAssistant(fillRequest(step.nodeIds)) };
      case 'run-all': return { id: 'run-all', primary, label: withCost(t('assistant.nextRunAll'), step), onSelect: runWholeCanvas };
      // One node, alone: an out-of-scope upstream would contribute what it produced earlier, and a first node has none.
      case 'try-first': return { id: `try-${step.nodeId}`, primary, label: withCost(t('assistant.nextTryFirst', { node: titleOf(step.nodeId) }), step),
        onSelect: () => void startRun([step.nodeId]) };
      case 'run-rest': return { id: 'run-rest', primary, label: withCost(t('assistant.nextRunRest', { count: step.nodeIds.length }), step),
        onSelect: () => void startRun(downstreamClosure(step.nodeIds)) };
      case 'rework': return { id: `rework-${step.nodeId}`, primary, label: withCost(t('assistant.nextRework', { node: titleOf(step.nodeId) }), step),
        onSelect: () => reworkFromReview(step.nodeId, step.reviewerId) };
      case 'open-review': return { id: `review-${step.nodeId}`, primary, label: t('assistant.nextOpenReview'),
        onSelect: () => { toggleDeliverables(step.nodeId, true); focusNode(step.nodeId); setTimelineOpen(false); countPress('review.open_report'); } };
      case 'results': return { id: 'results', primary, label: t('assistant.nextResults'), onSelect: () => changeStageView('results') };
    }
  };
  const nextLead = (situation: NextSteps['situation'], tryFirst: boolean): string => {
    switch (situation.kind) {
      // In the refusal's own words where it has them (a generation, an edit, the plan's credits), which say what lifts it.
      case 'quota': {
        if (isFreePlanEnded(runs[situation.nodeId]?.detail)) return t('assistant.nextLeadFreePlanEnded', { node: situation.nodeTitle });
        const refused = nodes.find(node => node.id === situation.nodeId);
        const reason = refusalReason(runs[situation.nodeId]?.detail, t, locale, Boolean(cloudScope && refused?.kind === 'session' && mediaKindOf(refused.agentKind)));
        return reason ? t('assistant.nextLeadRefused', { node: situation.nodeTitle, reason }) : t('assistant.nextLeadQuota', { node: situation.nodeTitle });
      }
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
      // A copied case has its text deliveries but none of its files: how many of the nodes left generate theirs is said,
      // since each takes a generation from today's allowance or the plan's credits.
      case 'partial': return situation.media ? t('assistant.nextLeadPartialMedia', { count: situation.count, media: situation.media })
        : t('assistant.nextLeadPartial', { count: situation.count });
      case 'complete': return situation.approvedBy ? t('assistant.nextLeadCompleteApproved', { node: situation.approvedBy }) : t('assistant.nextLeadComplete');
    }
  };
  const fillSteps = suggested?.steps.flatMap(step => step.kind === 'fill-inputs' ? [step] : []) ?? [];
  // Live data the canvas's newest request names (liveDataNeed): AwwO's Agents have no live web, so the next steps say how
  // the person's own Agent brings it (treg through 邀请 Agent), where no checklist's footnote is said.
  const newestRequest = [...planning.messages].reverse().find(message => message.role === 'user');
  const liveData = !readOnly && newestRequest ? liveDataNeed(newestRequest.request ?? newestRequest.content ?? '').length > 0 : false;
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
        ? t(suggested.situation.generations ? 'assistant.nextAfterInputsCost' : 'assistant.nextAfterInputsCalls',
          { calls: suggested.situation.calls, generations: suggested.situation.generations ?? 0 }) : t('assistant.nextAfterInputs'),
    } : {}),
    ...(!fillSteps.length && liveData ? { footnote: t('assistant.nextLiveData') } : {}),
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
      const detail = recoveryDetailMessage(t, runs[first.id]?.detail, locale)?.trim();
      const reason = !detail ? t('assistant.repairNoReason') : /[。.!?！？]$/.test(detail) ? detail : `${detail}${locale === 'zh' ? '。' : '.'}`;
      content = failed.length > 1 ? t('assistant.repairFailedMany', { node: first.title, count: failed.length, reason })
        : t('assistant.repairFailed', { node: first.title, reason });
      const rerun = kind === 'fix' ? suggested.steps.find(step => step.kind === 'rerun-failed') : undefined;
      if (rerun?.kind === 'rerun-failed') {
        scope = downstreamClosure(rerun.nodeIds);
        const after = scope.length - rerun.nodeIds.length;
        content += (after > 0 ? t('assistant.repairRerun', { count: after }) : t('assistant.repairRerunAlone')) + runCostText(rerun);
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
    // A canvas of Agents: on this device every session node is one, in the cloud the image, video and 3D nodes are not.
    if (!kind || !nodes.some(node => node.kind === 'session' && (!cloudScope || !mediaKindOf(node.agentKind)))) return false;
    let content: string;
    let scope: string[] | undefined;
    let start = false;
    let ask: WholeRunChoice | null = null;
    if (running) content = t('assistant.runBusy');
    else if (runUnavailableReason) content = t('assistant.runUnavailable', { reason: runUnavailableReason });
    else if (suggested?.situation.kind === 'inputs') content = localAnswer();
    else {
      const rest = kind === 'rest' ? suggested?.steps.find(step => step.kind === 'run-rest') : undefined;
      const failed = kind === 'rest' ? suggested?.steps.find(step => step.kind === 'rerun-failed') : undefined;
      if (rest?.kind === 'run-rest') {
        scope = downstreamClosure(rest.nodeIds);
        content = t('assistant.runStartingRest', { count: rest.nodeIds.length });
      } else if (failed?.kind === 'rerun-failed') {
        // What is left after a failure is the failed nodes and what they feed.
        scope = downstreamClosure(failed.nodeIds);
        content = t('assistant.runStartingFailed', { count: failed.nodeIds.length });
      // Nothing to start: the card's advice where it has some (a review to act on, inputs, what is left), else every node
      // has its result, or what is left cannot run on this device (a hosted canvas only waits while it is set up).
      } else if (kind === 'rest') {
        content = suggested && suggested.situation.kind !== 'complete' ? localAnswer()
          : !nodesLeft(nodes) ? t('assistant.runNothingLeft')
          : !cloudScope && !initializing && !bindingLocked ? t('assistant.runCannotHere') : localAnswer();
      } else content = t('assistant.runStarting');
      // 「继续运行」 with every node done runs nothing: running it all again is 「重新运行」.
      start = kind === 'all' || scope !== undefined;
      // A whole run that would run nodes with a result again asks first, as the run button's does (RerunConfirm.tsx);
      // the reply says so instead of saying it started.
      ask = start && scope === undefined ? wholeRunAsk() : null;
      if (ask) content = t(ask.rest ? 'assistant.runConfirmRest' : ask.left ? 'assistant.runConfirmWhole' : 'assistant.runConfirmAll', { count: ask.finished.length });
      // What it spends is counted over what it starts (the whole canvas, or the nodes left and what they feed).
      else if (start) content += runCostText(runCost(nodes, scope, Boolean(cloudScope)));
    }
    const id = `turn-${Date.now()}-${++planningSequence.current}`;
    setPlanningError('');
    setPlanning(previous => ({ draft: previous.draft.trim() === prompt ? '' : previous.draft, messages: [...previous.messages,
      { id: `${id}-user`, role: 'user' as const, content: prompt }, { id: `${id}-assistant`, role: 'assistant' as const, content }].slice(-60) }));
    setAssistantOpen(true);
    if (ask) setRerunChoice(ask);
    // A run of the whole canvas that had nothing to ask holds to that, as the run button's does (runWholeCanvas).
    else if (start) void startRun(scope, undefined, undefined, undefined, undefined, scope === undefined ? null : undefined);
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
      // Read for another document, it waits as while a read runs (its text still says what that read found).
      busy: !recoveryLoaded || recoveryChecking || !recoveryForDocument || recoveryStopping,
      onResume: () => { void sendPlanningMessage(planningRecovery.prompt, true); },
      onStop: () => { void cancelPlanning(); },
    } } : {}),
    progress: planningProgress, expectedSeconds: plannerProvider === 'jev' ? undefined : lastPlanSeconds,
    onDraftChange: (draft: string) => { if (!readOnlyRef.current) setPlanning(previous => ({ ...previous, draft })); },
    onTyped: (previous: string, next: string, typed: boolean, edit?: TypedEdit) => noteTyped('assistant', previous, next, typed, edit),
    onSend: () => { void sendAssistantMessage(); }, onCancel: () => { if (!cancelRouting()) void cancelPlanning(); },
    onUndo: () => {
      // undo() can still decline (a node began talking since this render); only an undo that happened is said.
      if (!canUndoPlan || !undo()) return;
      // The assistant's 撤销 names what it takes back: the cards are drawn again to show it gone (the keys wait instead).
      showPlanUndone();
      appendPlanningMessage(`undo-${Date.now()}`, surfaceNotice(t, 'plan_undone'));
      // The undo can move the conversation, and the button with it: from the welcome (a plan that had removed every node
      // has them back) to the side panel, or from the side panel (the first plan undone) to the welcome, which comes up
      // idle; tasks keep the panel. A focus the button took with it goes to the box there, or to 画布助手 where the reader
      // had closed the panel (a task kept it while the canvas was empty). Only the assistant's own undo does this: one by
      // hand (Ctrl+Z, a deletion) leaves the focus on the page, where the canvas's keys work.
      if (welcomeShownRef.current) refocusInCommit(assistantOpen ? PANEL_BOX : '.awwo-assistant-toggle');
      else if (!docRef.current.nodes.length) refocusInCommit(WELCOME_BOX);
    }, canUndo: canUndoPlan,
    ...(showPlannerLine ? { runtimeControls: <div className="awwo-planner-connection"><span className={plannerReady ? 'is-ready' : ''} />
      {plannerProvider === 'jev' ? jevStatus?.error || (locale === 'zh' ? 'Jev · 选择人设与模型，新增工作流' : 'Jev · Select personas and models for a new workflow') : plannerConnectionMessage(t, plannerStatus)}
      {plannerProvider === 'pi' && plannerStatus && !plannerStatus.available ? <button type="button" title={plannerStatus.error} onClick={() => { void readPlannerStatus(undefined, locale).then(setPlannerStatus); }}>{t('surface.retryPlanner')}</button> : null}
      {canInitialize && !recoveryLoaded ? <button type="button" disabled={recoveryChecking || recoveryStopping} onClick={() => { void refreshPlanningRecovery(); }}>{locale === 'zh' ? '检查上次规划' : 'Check earlier plan'}</button> : null}
    </div> } : {}),
  };

  // The latest request and its reply, which a correction from the reader (别改画布，直接写吧) hands over to the other
  // way. A hand-over that fails changes nothing but says why: a plan on the canvas is undone only once its task exists,
  // and a running task is stopped only where the canvas can take the request.
  let lastRequestIndex = -1;
  planning.messages.forEach((message, index) => { if (message.role === 'user') lastRequestIndex = index; });
  const lastRequest = lastRequestIndex >= 0 ? planning.messages[lastRequestIndex] : undefined;
  const lastReply = lastRequest ? planning.messages.slice(lastRequestIndex + 1).find(message => message.role === 'assistant' && message.route) : undefined;
  // `prompt` is what the other way is given (the request with the correction after it); `shown`, the reader's own words.
  const switchToTask = async (prompt: string, planOnCanvas: boolean, shown = prompt) => {
    const host = executionRef.current;
    if (!host) return;
    const id = `turn-${Date.now()}-${++planningSequence.current}`;
    const operationId = submissionId();
    setPlanningError('');
    setPending({ id, prompt: shown, phase: 'starting', operationId });
    try {
      const taskId = await host.start(prompt, operationId);
      if (!mounted.current) return;
      // A canvas edited since the plan, or busy now, keeps it, and the conversation says so: only an undo that
      // happened is reported as one.
      const latest = assistantLatest.current!;
      const undone = planOnCanvas && latest.canUndoPlan && latest.undo();
      if (undone) showPlanUndone();
      setPlanning(previous => ({ draft: previous.draft.trim() === shown ? '' : previous.draft, messages: [...previous.messages,
        ...(planOnCanvas ? [{ id: `${id}-undo`, role: 'assistant' as const, content: undone ? surfaceNotice(t, 'plan_undone') : t('assistant.planKept') }] : []),
        userTurn(id, shown, 'execute', prompt), { id: `${id}-task`, role: 'assistant' as const, content: '', route: 'execute' as const, taskId }].slice(-60) }));
      setAssistantOpen(true);
      // As for a task's start (startAssistantTask): from the welcome; the panel's own hand-back where it had the request.
      if (waitFromWelcome.current && welcomeShownRef.current) refocusInCommit(PANEL_BOX);
    } catch (error) {
      if (!mounted.current) return;
      // A task that may exist joins the conversation as unconfirmed (out of the box, as it may not be sent again),
      // and the plan stays until it is known.
      if (error instanceof TaskStartUnconfirmed) {
        setPlanning(previous => ({ draft: previous.draft.trim() === shown ? '' : previous.draft, messages: [...previous.messages,
          ...(planOnCanvas ? [{ id: `${id}-undo`, role: 'assistant' as const, content: t('assistant.planKept') }] : []), userTurn(id, shown, 'execute', prompt),
          { id: `${id}-task`, role: 'assistant' as const, content: t('assistant.startUnconfirmed'), status: 'unconfirmed' as const, route: 'execute' as const,
            operationId }].slice(-60) }));
      } else setPlanningError(failureText(error));
    } finally { if (pendingId() === id) setPending(null); }
  };
  // A bare follow-up (继续, 重试…) hands the canvas the request it followed: planned alone, the word says nothing.
  const handOverRequest = (messages: PlanningMessage[], index: number) => {
    for (let i = index; i >= 0; i--) {
      if (messages[i].role === 'user' && !FOLLOW_UP.test(messages[i].content.trim())) return messages[i].request ?? messages[i].content;
    }
    return messages[index].request ?? messages[index].content;
  };
  const switchToCanvas = async (prompt: string, taskId?: string, shown = prompt) => {
    const blocked = planBlocker();
    if (blocked !== null) { setPlanningError(blocked || t('assistant.canvasBusy')); return; }
    const host = executionRef.current;
    if (taskId && host && !host.finished(taskId)) {
      const id = `turn-${Date.now()}-${++planningSequence.current}`;
      setPlanningError('');
      setPending({ id, prompt: shown, phase: 'stopping' });
      try { await host.stop(taskId); }
      catch (error) { if (mounted.current) setPlanningError(failureText(error)); return; }
      finally { if (pendingId() === id) setPending(null); }
      if (!mounted.current) return;
      // The canvas may have become busy while the task stopped.
      const again = assistantLatest.current!.planBlocker();
      if (again !== null) { setPlanningError(`${t('assistant.taskStopped')}${again || t('assistant.canvasBusy')}`); return; }
    }
    void assistantLatest.current!.sendPlanningMessage(prompt, false, shown);
  };
  // Whether the latest request can be handed over to `to`: it went the other way, has its reply, and that way can take it
  // now. A task whose start is unconfirmed may exist, so it is reconciled, never planned over. A plan still on the canvas
  // is undone once its task exists where it can be, and otherwise kept, and the conversation says which.
  const canHandOver = (to: AssistantRoute) => Boolean(unifiedHost && !readOnly && lastRequest?.route && lastRequest.route !== to && lastReply && !planningBusy
    && (to === 'execute' ? unifiedHost.ready : planAvailable && lastReply.status !== 'unconfirmed'));
  // Hands the latest request over with the reader's correction after it; false where nothing was done with it.
  const switchLastRequest = (to: AssistantRoute, correction: string) => {
    if (!lastRequest || !lastReply || pendingRef.current || planningRequest.current) return false;
    const request = to === 'plan' ? handOverRequest(planning.messages, lastRequestIndex) : lastRequest.request ?? lastRequest.content;
    const prompt = `${request}\n\n${correction}`;
    // The planner takes at most 8000 bytes: a longer hand-over is not made, and the correction is planned on its own.
    if (to === 'plan' && new TextEncoder().encode(prompt).length > 8000) return false;
    if (to === 'plan') { void switchToCanvas(prompt, lastReply.taskId, correction); return true; }
    const planOnCanvas = lastReply.status === 'applied' && !undoneHere(lastReply);
    // A node that began talking since this render would keep the plan from being undone once the task exists.
    if (planOnCanvas && !canEditStructure()) { setPlanningError(surfaceNotice(t, 'planning_busy')); return true; }
    void switchToTask(prompt, planOnCanvas, correction);
    return true;
  };
  redirectLatest.current = (to, correction) => canHandOver(to) && switchLastRequest(to, correction);
  // Tasks the conversation mentions; the host lists the canvas's others (earlier ones, other devices') at its top.
  const mentionedTasks = useMemo(() => new Set(planning.messages.flatMap(message => message.taskId ? [message.taskId] : [])), [planning.messages]);
  // With the planner closed, tasks are the one way left, and the composer says so.
  const routeNotice = unifiedHost && planningUnavailableReason && unifiedHost.ready ? t('assistant.executeOnly') : undefined;
  const unified: UnifiedAssistant | undefined = assistantExecution ? {
    ...(assistantPending ? { pending: assistantPending } : {}),
    renderTask: taskId => assistantExecution.renderTask(taskId, readOnly ? undefined : { send: sendTaskFollowUp }),
    earlier: assistantExecution.renderEarlier(mentionedTasks, readOnly),
    notices: assistantExecution.renderNotices(planAvailable),
    settings: assistantExecution.settings,
    ...(routeNotice ? { notice: routeNotice } : {}),
    readOnly,
  } : undefined;
  // A read-only canvas shows its tasks; an editable one draws the panel for a canvas to work on or a conversation
  // with tasks, which needs no canvas.
  const viewerTasks = readOnly && Boolean(assistantExecution);
  // Closing the panel can take the pressed control with it (its close button): the focus goes to the toggle, which is
  // offered wherever the panel is drawn (nodes, tasks, or a viewer's tasks).
  const closeAssistant = () => {
    setAssistantOpen(false);
    refocus('.awwo-assistant-toggle');
  };
  const assistantPanel = assistantOpen && (viewerTasks || (!readOnly && (nodes.length > 0 || mentionedTasks.size > 0)))
    ? <CanvasAssistant mode="panel" {...assistantProps} unified={unified} focusBack={false} onClose={() => closeAssistant()} /> : undefined;
  // Whether the welcome holds the conversation: the workspace draws it on an empty canvas without the panel (below).
  welcomeShownRef.current = !readOnly && !assistantPanel && !nodes.length;
  // Stepped aside for the open node (focusNode): mounted, not drawn. A focus inside it as it steps aside goes to the
  // toggle, in the commit that hides it: a node opens there after awaiting the server too (a recovered run's result), in
  // an effect (the stage narrowing under it) or in a frame. Any other focus stays where it is, as beside the assistant,
  // one lost to the page too (a node's 打开 takes it away with its card as the node opens; a node's box, or the panel's,
  // drops it while disabled for its reply): on the toggle the next Enter or Space would bring the assistant back over
  // the node, and what hands the focus on there still does (that node's box once its reply ends, 成果's 在画布中打开 to
  // the view switch), the panel's own hand-back going to the toggle (below).
  const assistantStowed = Boolean(assistantPanel) && stowedFor !== null && stowedFor === focusedId;
  assistantStowedRef.current = assistantStowed;
  stowAssistantRef.current = (nodeId: string) => {
    if (!assistantPanel) return;
    const held = Boolean(rootRef.current?.closest('.awwo-workspace')?.querySelector('.awwo-planner-sidebar')?.contains(document.activeElement));
    setStowedFor(nodeId);
    if (held) refocusInCommit('.awwo-assistant-toggle');
  };
  // Whether the reader's last focus or press was in the assistant's panel, its 用户须知 included (read as the panel
  // begins to wait, below).
  const readerInPanel = useRef(false);
  useEffect(() => {
    const track = (event: Event) => {
      const sidebar = rootRef.current?.closest('.awwo-workspace')?.querySelector('.awwo-planner-sidebar');
      readerInPanel.current = event.target instanceof Node && Boolean(sidebar && inOrOwnedBy(sidebar, event.target));
    };
    document.addEventListener('focusin', track, true);
    document.addEventListener('pointerdown', track, true);
    return () => { document.removeEventListener('focusin', track, true); document.removeEventListener('pointerdown', track, true); };
  }, []);
  // The panel's box is disabled while a message the panel handled waits (CanvasAssistant: busy or routing), which drops
  // the focus to the page. Once the message is done the box takes a lost focus back (its own hand-back is off,
  // focusBack), or 画布助手 does where the panel stepped aside meanwhile (a hidden box cannot), in the commit that ends
  // the wait, as an opened node's box does for its own reply (TileComposer): only where the panel had the reader as the
  // wait began (its box, disabled in that commit, still has the focus then; a press on a control the message takes away
  // with it, a step of 接下来 or a recovery's 继续, already let it go) and they have not turned elsewhere since
  // (watchReaderAway, and the canvas's keys), its 用户须知 counting as the panel's. A focus the reader took elsewhere
  // meanwhile, to the page too (another node by key, a wheel, a press on the board), stays there: in the box the canvas's
  // keys would no longer work. It is held as the panel the reader was with, so a panel closed meanwhile and opened again
  // (by the plan, before closing hands 画布助手 the focus at the next frame) is another, and takes nothing. The wait also
  // says whether it began in an empty canvas's welcome (for a task's start, which takes the conversation from there).
  const panelWaiting = planningBusy || Boolean(unified?.pending);
  const panelWaitHeld = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const sidebar = rootRef.current?.closest('.awwo-workspace')?.querySelector<HTMLElement>('.awwo-planner-sidebar') ?? null;
    if (!panelWaiting) {
      const held = panelWaitHeld.current;
      panelWaitHeld.current = null;
      if (held?.isConnected) moveLostFocus(assistantStowedRef.current ? '.awwo-assistant-toggle' : PANEL_BOX);
      return undefined;
    }
    waitFromWelcome.current = welcomeShownRef.current;
    const active = document.activeElement;
    const held = sidebar && (readerInPanel.current || (active !== null && inOrOwnedBy(sidebar, active))) ? sidebar : null;
    panelWaitHeld.current = held;
    if (!held) return undefined;
    const away = () => { panelWaitHeld.current = null; };
    // The canvas's navigation keys too, wherever pressed, as useCanvasKeys takes them (not in a field, nor while 成果
    // pauses them): Ctrl/⌘ with a digit recalls a waypoint (with Shift it saves one, which is no navigation), with 0
    // fits all, with E opens or closes a node, with [ or ] goes to the one before or after (opens it, or selects it with
    // the camera on it). Each counts whether or not it moves anything (an empty waypoint), as for a node's box.
    // watchReaderAway leaves the camera keys to this.
    const onCanvasKey = (event: KeyboardEvent) => {
      if (!canvasKeysOn.current || !(event.ctrlKey || event.metaKey) || isTypingTarget(event.target)) return;
      // A digit's code comes first, as in useCanvasKeys.
      const moves = /^Digit[1-9]$/.test(event.code) ? !event.shiftKey
        : event.code === 'Digit0' || event.key === '0' || ['e', '[', ']'].includes(event.key.toLowerCase());
      if (moves) away();
    };
    document.addEventListener('keydown', onCanvasKey, true);
    const stopWatching = watchReaderAway(held, away, { cameraKeys: false, tabKey: false, owns: target => inOrOwnedBy(held, target) });
    return () => { stopWatching(); document.removeEventListener('keydown', onCanvasKey, true); };
  }, [panelWaiting, moveLostFocus]);
  const panelShown = Boolean(assistantPanel) && !assistantStowed;
  // What the stage says the assistant is doing (StageActivity.tsx): a message being handled, a plan being made, or the
  // latest direct task under way (read only while the conversation is on screen); and on an empty canvas whose
  // conversation has tasks, that a task leaves the canvas as it is.
  const latestTask = lastReply?.route === 'execute' ? lastReply.taskId : undefined;
  const stageActivity: StageActivityState | undefined = readOnly ? undefined
    : assistantPending ? { kind: 'pending', phase: assistantPending.phase }
      : planningBusy ? { kind: 'planning', progress: planningProgress }
        : latestTask && panelShown && assistantExecution?.running?.(latestTask) ? { kind: 'task' }
          : !nodes.length && mentionedTasks.size > 0 ? { kind: 'empty' } : undefined;
  // The stage shrinking under an open node until the floating assistant leaves it no readable room steps the assistant
  // aside, as opening the node there does; bringing it back over the node is the reader's (no size changes then).
  const stageSeen = useRef(size);
  useEffect(() => {
    const before = stageSeen.current;
    stageSeen.current = size;
    if (!focusedId || !panelShown || before.w === 0 || (before.w === size.w && before.h === size.h)) return;
    const root = rootRef.current;
    const stage = root?.getBoundingClientRect();
    if (root && stage && stage.width > 0 && floatingSidebar(root, stage)?.cramped) stowAssistantRef.current(focusedId);
  }, [size, focusedId, panelShown]);
  // Showing or hiding the panel changes the room a fit has where the sidebar floats over the board: the overview and an
  // open node refit, as when a rail toggles (not on the first render: the opening fit measures it itself).
  const panelSeen = useRef(panelShown);
  useEffect(() => {
    if (panelSeen.current === panelShown) return;
    panelSeen.current = panelShown;
    onRailsChange();
  }, [panelShown, onRailsChange]);
  // The view tools (zoom, fit) sit in the stage's bottom-left corner, which a sidebar floating over the stage covers (the
  // hosted workspace at 1280 px and below, any at 900 px and below): with the assistant open they could not be reached
  // (found 2026-10-16). They move right of the sidebar as far as it covers, while they fit on the stage with their own
  // margin on both sides; where they would then reach the minimap (drawn in their row: not while an open node hides
  // it), they step up over it. Configure lifting the board over the sidebar (hosted, 900 px and below) leaves nothing
  // covered. Measured again when a selection adds or takes away 运行所选及下游, the one button that changes their width
  // once they are drawn.
  const viewToolsRef = useRef<HTMLDivElement>(null);
  const viewToolsShift = useRef({ x: 0, y: 0 });
  const [viewToolsCover, setViewToolsCover] = useState({ x: 0, y: 0 });
  const viewToolsShown = nodes.length > 0 || history.undo > 0 || history.redo > 0;
  // Mounted as the minimap's own condition below says; an open node hides it (visibility, canvas.css).
  const minimapShown = minimapOpen && !simple && nodes.length > 0 && !focusedId;
  const measureViewTools = useCallback(() => {
    const root = rootRef.current;
    const tools = viewToolsRef.current;
    const stage = root?.getBoundingClientRect();
    const raised = Boolean(root && inspectorRef.current !== null && configureRaisesBoard(root));
    const side = root && tools && stage && stage.width > 0 && !raised ? floatingSidebar(root, stage) : null;
    const shift = { x: 0, y: 0 };
    // Their own left margin (the stylesheet's, without the shift set here).
    const margin = tools ? tools.offsetLeft - viewToolsShift.current.x : 0;
    if (root && tools && stage && side && side.cover + 2 * margin + tools.offsetWidth <= stage.width) {
      shift.x = side.cover;
      // Where they sit unraised, and where they reach once moved.
      const row = tools.getBoundingClientRect();
      const bottom = row.bottom + viewToolsShift.current.y;
      const right = stage.left + side.cover + margin + tools.offsetWidth;
      const minimap = root.closest('.awwo-workspace')?.querySelector<HTMLElement>('.canvas-minimap');
      const map = minimap && getComputedStyle(minimap).visibility !== 'hidden' ? minimap.getBoundingClientRect() : null;
      if (map && map.width > 0 && map.top < bottom && map.bottom > bottom - row.height && right + margin > map.left) {
        shift.y = Math.round(bottom - map.top + margin);
      }
    }
    viewToolsShift.current = shift;
    setViewToolsCover(previous => previous.x === shift.x && previous.y === shift.y ? previous : shift);
  }, []);
  const selectionShown = selection.length > 0;
  useLayoutEffect(measureViewTools, [measureViewTools, size.w, size.h, railsVersion, panelShown, simple, viewToolsShown, inspectorId, minimapShown, selectionShown]);
  // How much of the stage's left edge a sidebar floating over it covers (floatingSidebar), where it leaves the stage
  // STAGE_OVERLAY_MIN_ROOM or more: 0 where it takes its own room, is closed or stepped aside, or (nearly) spans the stage.
  // The workspace hands it to the stylesheets as --awwo-stage-cover, and the run notes in the stage's top-left corner,
  // the selection bar at its top centre and the 成果 view lay themselves out right of it: they sat under it (found
  // 2026-10-16). A note reads in less room than an open node, so the part left may be narrower than the board's own fit
  // needs (sidebarCover); there, an open node has the assistant step aside instead. Where Configure lifts the board over
  // the sidebar (hosted, 900 px and below), the board's own notes and bar stay put (awwo-workspace.css).
  const [stageCover, setStageCover] = useState(0);
  const measureStageCover = useCallback(() => {
    const root = rootRef.current;
    const stage = root?.getBoundingClientRect();
    const side = root && stage && stage.width > 0 ? floatingSidebar(root, stage) : null;
    const cover = side && stage && stage.width - side.cover >= STAGE_OVERLAY_MIN_ROOM ? side.cover : 0;
    setStageCover(previous => previous === cover ? previous : cover);
  }, []);
  useLayoutEffect(measureStageCover, [measureStageCover, size.w, size.h, railsVersion, panelShown, simple]);
  // The one icon a Tab reaches (a roving stop: one per component would make the board a long list of stops): the first
  // selected icon on screen, else the first on screen in reading order. ⌘[ and ⌘] step through the rest. On screen is
  // the stage itself (culling keeps a margin round it) less what a floating assistant covers; with none there, any icon
  // drawn (the camera then goes to it as it takes the focus).
  const iconTabStop = useMemo(() => {
    if (!iconIds.size) return null;
    const mounted = shownBoxes.filter(node => iconIds.has(node.id) && visibleIds.has(node.id));
    const onScreen = stageMeasured ? visibleBoxIds(mounted, shiftView(view, -stageCover), { w: size.w - stageCover, h: size.h }, 0)
      : new Set(mounted.map(node => node.id));
    const pool = onScreen.size ? mounted.filter(node => onScreen.has(node.id)) : mounted;
    const ids = new Set(pool.map(node => node.id));
    return selection.find(id => ids.has(id)) ?? orderNodes(pool)[0]?.id ?? null;
  }, [iconIds, selection, visibleIds, shownBoxes, view, size, stageMeasured, stageCover]);
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
  // The models a node can run in its own sandbox computer; a node gets there only through its settings' switch.
  const sandboxShelf = useMemo(() => sandboxGroups(palette?.groups ?? []), [palette?.groups]);
  // And those it can run in the Blender workstation, by its settings' other switch.
  const blenderShelf = useMemo(() => sandboxGroups(palette?.groups ?? [], 'blender'), [palette?.groups]);
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
  // 多人同屏's people bar and 同屏 panel name a running AwwO Agent's model by the same names (multiplayer/host.ts).
  useEffect(() => { multiplayer?.modelNames?.(modelNames); }, [multiplayer, modelNames]);
  // The models a node's own chat can switch to, in its composer: the workspace's chat models for an agent, the
  // media catalogue's models of its kind for an image, video or 3D node. Stable arrays, so cards stay memoised.
  // Each chat model is offered once, on the runtime AwwO runs it on (nodeRuntime.ts): the reader picks a model, never a
  // runtime. An agent in a computer of its own (its sandbox, its Blender workstation) stays there, so its composer offers
  // the models that computer runs, as its settings do (InspectorPanel), and a pick keeps it there (changeNodeModel).
  const { chatModelChoices, computerModelChoices } = useMemo(() => {
    const catalogue = currentModelCatalogue ?? [];
    const choice = (model: ModelPaletteSelection): NodeModelChoice => ({
      key: model.key, label: model.displayName || model.label, available: model.available, reason: model.reason, model: model.model,
      group: palette?.groups.find(group => group.id === model.providerGroup)?.label,
    });
    const on = (runtime: string) => catalogue.filter(model => model.runtime === runtime).map(choice);
    return { chatModelChoices: automaticEntries(catalogue).map(choice),
      computerModelChoices: { sandbox: on(SANDBOX_RUNTIME), blender: on(BLENDER_RUNTIME) } };
  }, [currentModelCatalogue, palette?.groups]);
  const mediaModelChoices = useMemo<Record<MediaKind, NodeModelChoice[]>>(() => {
    const catalogue = mediaCatalogueOf(mediaState);
    const of = (kind: MediaKind) => mediaModelsOf(catalogue, kind).map(model => ({ key: model.id, label: mediaModelLabel(model, locale), group: mediaGroupLabel(locale), available: true, references: model.references, subjectReferences: model.subjectReferences, audioReferences: model.audioReferences }));
    return { image: of('image'), video: of('video'), model3d: of('model3d'), audio: of('audio') };
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
    // A node in its sandbox or its Blender workstation takes the model there, and nothing when that computer does not
    // offer it; any other node never moves into one (nodeRuntime.ts pickedModelEntry). A pick from a list drawn before
    // the node moved that comes to what it runs already changes nothing: its effort stays and its chat does not fork.
    const choice = pickedModelEntry(live, key, paletteRef.current?.models ?? []);
    if (!choice || (choice.runtime === live.runtime && choice.model === live.model)) return;
    saveInspector({ ...live, runtime: choice.runtime, model: choice.model, effort: choice.effort ?? '' });
  }, [saveInspector]);
  const tileModelChoices = (node: CanvasNode): ReadonlyArray<NodeModelChoice> | undefined => {
    if (node.kind !== 'session' || readOnly || !canInitialize) return undefined;
    const media = mediaKindOf(node.agentKind);
    if (media) return mediaModelChoices[media];
    if (node.runtime === BLENDER_RUNTIME) return computerModelChoices.blender;
    if (node.runtime === SANDBOX_RUNTIME) return computerModelChoices.sandbox;
    return chatModelChoices;
  };
  const nodeOfId = useCallback((id: string) => docRef.current.nodes.find(node => node.id === id), []);
  const market = useCanvasMarket({ settings: canInitialize ? marketSettings : null, tenantId: cloudScope?.tenant.id ?? null, readOnly,
    catalogue: currentModelCatalogue, nodeOf: nodeOfId, saveNode: saveInspector, addNode: addAgentMarketNode });
  // What a tile's inputs read now (prepareNodeConversation, assembleInputViews) comes from the node, the wires into it
  // and the nodes they come from, and nothing else, so it is kept from render to render while those are as they were.
  // Prepared afresh, every tile got a new object on every render, which defeated the tiles' memo (the whole canvas
  // re-rendered on each camera frame, each edit and each tile's settled history) and read every upstream delivery again.
  const tileInputs = useRef(new globalThis.Map<string, { node: CanvasNode; wires: string; sources: ReadonlyArray<CanvasNode | undefined>; value: unknown }>());
  const runEdges = useMemo(() => edges.filter(edge => edge.kind !== 'feedback'), [edges]);
  const wiresInto = useMemo(() => {
    const into = new globalThis.Map<string, CanvasEdge[]>();
    for (const edge of runEdges) {
      const list = into.get(edge.toNode);
      if (list) list.push(edge); else into.set(edge.toNode, [edge]);
    }
    return into;
  }, [runEdges]);
  // The nodes as each reader finds them: prepareNodeConversation keeps the last node of an id, assembleInputViews the first.
  const lastNodeById = useMemo(() => new globalThis.Map(nodes.map(node => [node.id, node])), [nodes]);
  const firstNodeById = useMemo(() => new globalThis.Map([...nodes].reverse().map(node => [node.id, node])), [nodes]);
  useEffect(() => { for (const id of tileInputs.current.keys()) if (!lastNodeById.has(id)) tileInputs.current.delete(id); }, [lastNodeById]);
  function inputsFor(node: SessionNode): ReturnType<typeof prepareNodeConversation>;
  function inputsFor(node: CanvasNode & { kind: 'assemble' }): ReturnType<typeof assembleInputViews>;
  function inputsFor(node: CanvasNode): unknown {
    const wires = wiresInto.get(node.id) ?? [];
    const sources = wires.map(edge => node.kind === 'session' ? (edge.fromNode === node.id ? node : lastNodeById.get(edge.fromNode)) : firstNodeById.get(edge.fromNode));
    const key = wires.map(edge => JSON.stringify(edge)).join('\n');
    const held = tileInputs.current.get(node.id);
    if (held && held.node === node && held.wires === key && held.sources.length === sources.length
      && held.sources.every((source, index) => sameAsSource(source, sources[index]))) return held.value;
    const value = node.kind === 'session' ? prepareNodeConversation(node, nodes, runEdges) : node.kind === 'assemble' ? assembleInputViews(node, nodes, edges) : undefined;
    tileInputs.current.set(node.id, { node, wires: key, sources, value });
    return value;
  }

  const renderInspector = (node: CanvasNode, inline = false) => (
    <InspectorPanel key={!canInitialize && node.kind === 'session' ? `${node.id}:${activeThreadId(node)}` : node.id} node={node} liveCompanies={companies} apiBase={paperclipApiBase()}
      readJson={runtimeReadJson} onSave={saveInspector} onInitialize={canInitialize && !runUnavailableReason ? initializeInspector : undefined} readOnly={readOnly || busyNow.has(node.id) || exclusiveNow} readOnlyMessage={readOnly ? t('common.readOnly') : undefined}
      media={canInitialize ? mediaState : undefined} onRetryMedia={() => setMediaRefresh(value => value + 1)}
      editFiles={node.kind === 'edit' ? editWiredFiles(node, nodes, edges) : undefined}
      modelGroups={canInitialize ? shelfGroups : undefined} modelNames={canInitialize ? modelNames : undefined} sandboxGroups={canInitialize ? sandboxShelf : undefined} blenderGroups={canInitialize ? blenderShelf : undefined} modelsLoading={paletteLoading} modelsError={paletteError}
      onRetryModels={() => setPaletteRefresh(value => value + 1)}
      market={canInitialize ? market.inspector : undefined}
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
    <MarketPagesContext.Provider value={marketPages}>
    <AgentPagesContext.Provider value={agentPages}>
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
      assistant={assistantPanel} assistantStowed={assistantStowed} stageCover={stageCover}
      // One composer at a time: on an empty canvas whose conversation is in the side panel, the welcome steps aside.
      welcome={readOnly || assistantPanel ? undefined : <CanvasAssistant mode="welcome" {...assistantProps} unified={unified} />}
      emptyStage={stageActivity && !nodes.length ? <StageActivity state={stageActivity} /> : undefined}
      // The toggle reports the panel as it is drawn; tasks need no canvas, so it is offered on an empty one with them.
      assistantOpen={panelShown} assistantAvailable={viewerTasks || mentionedTasks.size > 0} assistantHint={assistantHint}
      onToggleAssistant={readOnly && !assistantExecution ? undefined : () => { if (panelShown) closeAssistant(); else setAssistantOpen(true); }}
      onRailsChange={onRailsChange} modelRailCollapsed={modelRailCollapsed} onExpandModelRail={() => setShelfCollapsed(false)}
      onOpenSettings={onOpenSettings ? () => { if (!inspectorCloseLocked.current) onOpenSettings(); } : undefined}
      headerTitle={headerTitle} headerActions={headerActions} canvasTools={market.tool ? <>{canvasTools}{market.tool}</> : canvasTools}
      view={showingResults ? 'results' : 'canvas'} onViewChange={results ? changeStageView : undefined}
      results={showingResults ? <CanvasResults nodes={nodes} edges={edges} execution={doc.execution} runs={runs} running={running} readOnly={readOnly}
        runUnavailableReason={runUnavailableReason} onRun={readOnly ? undefined : runWholeCanvas}
        notice={initializing ? { kind: 'status', text: locale === 'zh' ? '正在准备节点，首次运行会自动使用工作区默认配置…' : 'Preparing nodes with the workspace defaults…' }
          : handoffNote ? { kind: 'alert', text: handoffNote, onDismiss: () => setHandoffNote('') }
          : freePlanEnded ? { kind: 'status', text: t(cloudScope?.tenant.role === 'owner' ? 'canvas.freePlanEndedOwner' : 'canvas.freePlanEndedOther') } : undefined}
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
        stopped={stopped} onStart={runWholeCanvas} onStop={stopRun}
        onToggleTimeline={() => { const fromResults = stageViewRef.current === 'results'; changeStageView('canvas'); setTimelineOpen(o => fromResults || !o); }} timelineOpen={timelineOpen && !showingResults}
        timelineUnavailableReason={focusedId ? t('run.timelineWhileOpen') : undefined}
        style={{ position: 'static', maxWidth: 'none', flexWrap: 'nowrap' }} /></>}>
    {/* Under the 成果 view the board is out of reach (the shortcuts pause too) but stays as it was. */}
    <div className="canvas-root" onFocus={trackIconFocus} onBlur={releaseIconFocus} onPointerDownCapture={noteBoardPress} inert={showingResults || undefined} data-read-only={readOnly || undefined} data-selection-tool={selectionTool || undefined} data-narrow-focus={(focusedId ? focusNarrow : narrowFocusWidth(size.w)) ? true : undefined} data-node-open={focusedId ? true : undefined} ref={rootRef}
      // 多人同屏: this person's pointer, in world coordinates, for the others on the canvas (the host paces it).
      onPointerMove={multiplayer ? event => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect || event.pointerType === 'touch') return;
        const world = screenToWorld(viewRef.current, event.clientX - rect.left, event.clientY - rect.top);
        multiplayer.presence({ cursor: { x: Math.round(world.x), y: Math.round(world.y) } });
      } : undefined}
      onPointerLeave={multiplayer ? () => multiplayer.presence({ cursor: null }) : undefined}
      {...nodeViewRoot}>
      <CanvasViewport
        view={view}
        onViewChange={moveCamera}
        onResize={onStageResize}
        onBackgroundPointerDown={(e) => {
          wiring.clearPending();
          // The marquee claims Shift-drags (returning true suppresses the viewport's pan); a
          // plain background press just clears the selection.
          if (marquee.onBackgroundPointerDown(e)) return true;
          setSelection([]);
          setSelectedEdgeId(null);
          setSelectedDisplayId(null);
          setSelectedIconId(null);
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
        {/* What the board holds appears with its tiles, once the stage has measured itself: wires never float without them. */}
        {stageMeasured && <WirePlane nodes={iconWireNodes} edges={convergedView.wireEdges} runs={collaborationJournal ? {} : runs} running={running && !collaborationJournal} round={doc.execution ? reviewRound : 0} scale={view.scale}
          selectedEdgeId={selectedEdgeId ?? undefined} onSelectEdge={readOnly || exclusiveNow || initializing || simple ? undefined : setSelectedEdgeId}
          // A wire is never previewed from a card the board does not draw (its anchor would be the icon's).
          preview={wiring.wireDrag && !convergedView.hidden.has(wiring.wireDrag.from.nodeId) ? wiring.wireDrag : null}
          onDisconnect={readOnly || exclusiveNow || initializing || simple ? undefined : disconnect} />}
        {stageMeasured && <CollaborationFlow nodes={shownBoxes} collaboration={collaborationJournal?.collaboration} running={running} scale={view.scale} />}
        {stageMeasured && <DisplayLinks displays={displays} boxes={linkBoxes} />}
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
          visibleIds.has(node.id) && (iconIds.has(node.id) ? (
          // 图标视图: the component as its live icon, with the card's own locks on its moves and its ports.
          <NodeIconTile
            key={node.id}
            node={node}
            drawn={renderNodeById.get(node.id) ?? node}
            run={runs[node.id] ?? null}
            live={running || recovering}
            scale={view.scale}
            selected={selection.includes(node.id)}
            soleSelected={selection.length === 1 && selection[0] === node.id}
            tabbable={iconTabStop === node.id}
            readOnly={readOnly}
            interactionLocked={busyNow.has(node.id) || exclusiveNow || initializing || bindingLocked}
            wiring={wiring}
            modelChoices={tileModelChoices(node)}
            onMove={readOnly || exclusiveNow || initializing ? undefined : moveNode}
            onSelect={selectNode}
            onToggleFocus={toggleFocus}
          />
          ) : (
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
            composerStatus={tileStatus[node.id]}
            onComposerTyped={readOnly ? undefined : noteNodeTyped}
            conversationContext={node.kind === 'session' ? inputsFor(node) : undefined}
            assembleInputs={node.kind === 'assemble' ? inputsFor(node) : undefined}
            onIssueId={tileOnIssueId}
            onPreview={readOnly ? undefined : persistPreview}
            onDraftChange={readOnly ? undefined : persistDraft}
            onToggleDeliverables={readOnly ? undefined : toggleDeliverables}
            onHoldDeliverables={readOnly ? undefined : holdDeliverables}
            interactionLocked={busyNow.has(node.id) || exclusiveNow || initializing || bindingLocked}
            onMove={readOnly || exclusiveNow || initializing ? undefined : moveNode}
            onResizeNode={readOnly || exclusiveNow || initializing || (node.kind === 'session' && focusedId !== node.id) ? undefined : resizeNode}
            onSelect={selectNode}
            onToggleFocus={toggleFocus}
            onFitNode={openNode}
            onConfigure={simple ? undefined : tileOnConfigure}
            configurationPanel={!canInitialize && node.kind === 'session' && focusedId === node.id && inspectorId === node.id ? renderInspector(node, true) : null}
            onUpdateNode={readOnly || busyNow.has(node.id) || exclusiveNow || initializing || bindingLocked ? undefined : saveNode}
            onPatchNode={readOnly || busyNow.has(node.id) || exclusiveNow || initializing || bindingLocked ? undefined : patchNode}
            onRunNode={readOnly || busyNow.has(node.id) || exclusiveNow || initializing || runUnavailableReason ? undefined : rerunNode}
            onDelete={readOnly || busyNow.has(node.id) || exclusiveNow || initializing ? undefined : tileDelete}
            modelChoices={tileModelChoices(node)}
            inputRequest={inputRequests[node.id]}
            onAskAssistant={readOnly ? undefined : askAboutNode}
            deliveryBeside={focusedId === node.id ? drawerBeside(focusNarrow, renderNodeById.get(node.id)?.w ?? node.w) : !narrowFocusWidth(size.w)}
            modelNames={modelNames}
            onChangeModel={readOnly || busyNow.has(node.id) || exclusiveNow || initializing ? undefined : changeNodeModel}
            onOpenMarket={market.openForNode} onDetachMarket={market.detachNode}
            onResizeCard={resizeCard}
            onToggleCardPreview={toggleCardPreview}
            onOpenStudio={openStudio}
            onShowInDisplay={readOnly ? undefined : showNodeInDisplay}
            canvasEntries={canvasEntries}
            onStopNode={!readOnly && soloRunning.has(node.id) ? stopNode : undefined}
            wiring={wiring}
          />
          ))
        ))}
        {/* Icons are never culled off screen, as cards are: there are few, and one panned away still says a member's failure. */}
        {stageMeasured && convergedView.icons.map(icon => (
          <ConvergedIcon
            key={icon.id}
            icon={icon}
            members={iconMembers.get(icon.id) ?? NO_MEMBERS}
            runs={runs}
            depths={graphDepths}
            title={iconTitle(icon.id, iconMembers.get(icon.id) ?? NO_MEMBERS)}
            scale={view.scale}
            selected={selectedIconId === icon.id}
            onSelect={selectIcon}
            onExpand={expandIcon}
            onAnnounce={announce}
            live={running || recovering}
          />
        ))}
        {/* 多人同屏: others' rings, claims and pointers, over the cards and never in the way of a press. It marks the cards
            the board draws (shownNodes), as the collaboration flow does: a member inside a converged icon has no place on
            this board (the wires' stand-in for it is the icon's middle, its face), so none of its marks is drawn there;
            the 同屏 panel still says who is on it, and naming it there draws its cards with their marks. In the icon view
            a component's marks ring its icon (its round plate). */}
        {stageMeasured && multiplayer?.boardLayer?.(shownBoxes, view.scale)}
        <Marquee rect={marquee.rect as WorldRect | null} />
      </CanvasViewport>

      {!running && !simple && <SelectionCollaboration key={`selection:${JSON.stringify(selection)}`} nodes={nodes.filter(node => selection.includes(node.id))}
        disabled={readOnly || initializing || bindingLocked || Boolean(runUnavailableReason)} available={Boolean(cloudScope)}
        onStart={(ids, policy) => { void startRun(ids, undefined, undefined, undefined, policy); }} />}
      {running && collaborationJournal?.collaboration && <CollaborationStatus nodes={nodes} collaboration={collaborationJournal.collaboration} />}

      {initializing && <div className="awwo-handoff-note" role="status">{locale === 'zh' ? '正在准备节点，首次运行会自动使用工作区默认配置…' : 'Preparing nodes with the workspace defaults…'}</div>}
      {/* Over a canvas with nodes, a plan being made or a direct task under way is said where the canvas is. */}
      {stageActivity && showsStageLine(stageActivity, { nodes: nodes.length, results: showingResults, note: initializing || Boolean(handoffNote) })
        && <StageActivity compact state={stageActivity} announce={!panelShown} />}
      {!initializing && handoffNote && <div className="awwo-handoff-note" role="alert"><span>{handoffNote}</span><button type="button" aria-label={locale === 'zh' ? '关闭提示' : 'Dismiss notice'} onClick={() => setHandoffNote('')}>×</button></div>}
      {/* Behind a one-off note in the same place; the owner gets the plans (only the owner's plan opens the workspace). */}
      {!initializing && !handoffNote && freePlanEnded && <div className="awwo-handoff-note awwo-plan-ended-note" role="status">
        <span>{t(cloudScope?.tenant.role === 'owner' ? 'canvas.freePlanEndedOwner' : 'canvas.freePlanEndedOther')}</span>
        {cloudScope?.tenant.role === 'owner' && <a href={accountURL('plans')}>{t('assistant.nextUpgrade')}</a>}
      </div>}
      {/* Same guard as the minimap: the view tools never paint over the opaque welcome overlay of a
          fresh canvas. An empty canvas that still has something to undo or redo keeps them, or a
          deleted last node or an undone plan could only come back through a keyboard shortcut. */}
      {viewToolsShown && <div ref={viewToolsRef} className={`awwo-view-tools${simple ? ' is-simple' : ''}`} role="toolbar" aria-label={viewText.toolbar} data-feedback-avoid="above"
        style={viewToolsCover.x ? { marginLeft: viewToolsCover.x, ...(viewToolsCover.y ? { marginBottom: viewToolsCover.y } : {}) } : undefined}>
        {!simple && <><button type="button" aria-label={locale === 'zh' ? '框选组件' : 'Select components'} title={locale === 'zh' ? '框选组件（也可按住 Shift 拖动）' : 'Select components (or Shift + drag)'} aria-pressed={selectionTool}
          onClick={() => setSelectionTool(value => !value)}><MousePointer2 size={16} /></button>
        <span className="awwo-tool-separator" /></>}
        <button aria-label={viewText.zoomOut} title={viewText.zoomOut} onClick={() => zoomBy(1 / 1.2)}><Minus size={16} /></button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button aria-label={viewText.zoomIn} title={viewText.zoomIn} onClick={() => zoomBy(1.2)}><Plus size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.fitAll} title={viewText.fitAll} disabled={!nodes.length} onClick={fitAll}><Maximize2 size={16} /></button>
        {/* 收敛: the whole canvas as one live icon (both views, readers too: a way of looking, never an edit). */}
        <button type="button" className="awwo-converge-tool" aria-pressed={converged.canvas} data-converge-toggle=""
          aria-label={t('converge.canvas')}
          title={converged.canvas ? t('converge.expandAllTitle', { key: convergeKeyHint }) : stepCount < MIN_GROUP_MEMBERS ? t('converge.needsTwo')
            : focusedId || inspectorId ? t('converge.closeOpen') : t('converge.canvasTitle', { key: convergeKeyHint })}
          disabled={!converged.canvas && (stepCount < MIN_GROUP_MEMBERS || Boolean(focusedId) || Boolean(inspectorId))}
          onClick={() => setCanvasConverged(!converged.canvas)}><Orbit size={16} /></button>
        {/* 图标视图: every component as its own live icon, wired as the cards are (a way of looking too). */}
        <button type="button" className="awwo-icon-view-tool" aria-pressed={iconView} data-icon-view-toggle=""
          aria-label={t('nodeIcon.toggle')}
          title={converged.canvas ? t('nodeIcon.toggleConverged') : iconView ? t('nodeIcon.toggleTitleOn') : t('nodeIcon.toggleTitle')}
          disabled={converged.canvas}
          onClick={toggleIconView}><Bot size={16} /></button>
        <button className="awwo-display-tool" aria-label={displayText(locale, 'display.showCanvas')} title={displayText(locale, 'display.showCanvas')}
          disabled={!nodes.length || (readOnly && !displays.some(display => display.source.type === 'canvas'))} onClick={showCanvasDisplay}><MonitorPlay size={16} /></button>
        {/* "Expand first" only where the icon is all that holds them: not for a reader, during a run or with nothing to do. */}
        {!simple && <><button aria-label={viewText.arrange} title={convergedView.icons.length && !arrangeBlocked ? t('converge.arrangeExpanded') : viewText.arrangeTitle}
          disabled={arrangeBlocked || convergedView.icons.length > 0} onClick={arrangeNodes}><LayoutGrid size={16} /></button>
        <button className="awwo-minimap-toggle" aria-label={viewText.showMinimap} title={focusedId ? t('surface.minimapWhileOpen') : viewText.showMinimap} aria-pressed={minimapOpen} disabled={Boolean(focusedId)} onClick={() => setMinimapOpen(o => !o)}><Map size={16} /></button>
        <span className="awwo-tool-separator" />
        <button aria-label={viewText.undo} title={membersHidden && !undoBlocked ? t('converge.undoExpanded') : viewText.undo} disabled={undoBlocked || membersHidden} onClick={undo}><Undo2 size={16} /></button>
        <button aria-label={viewText.redo} title={membersHidden && !redoBlocked ? t('converge.redoExpanded') : viewText.redo} disabled={redoBlocked || membersHidden} onClick={redo}><Redo2 size={16} /></button>
        {selection.length > 0 && <><span className="awwo-tool-separator" /><button aria-label={viewText.runSelection} title={runUnavailableReason || viewText.runSelection} disabled={readOnly || exclusiveNow || Boolean(runUnavailableReason)} onClick={runFromSelection}><Play size={15} /></button></>}</>}
      </div>}

      {minimapOpen && !simple && nodes.length > 0 ? (
        <Minimap
          boxes={displays.length || convergedView.icons.length ? [...shownBoxes, ...convergedView.icons, ...displays] : shownBoxes}
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

      {inspectorNode && (inspectorNode.kind !== 'session' || canInitialize) ? renderInspector(inspectorNode) : null}

      {!readOnly && addMenu ? (
        <AddNodeMenu
          onOpenModelShelf={modelShelf ? () => setShelfCollapsed(false) : undefined}
          mediaKinds={canInitialize ? mediaKinds : undefined}
          withEdit={canInitialize && editEnabled !== false}
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
    {/* Converged icons speak here, once per change; the same words twice still differ (a no-break space), so they are said.
        A polite live region, not role=status: the board's own status notes keep that role to themselves. Outside the
        board, which turns inert (and silent to assistive technology) under the 成果 view, while its run goes on. */}
    <div className="awwo-converged-sr" aria-live="polite" aria-atomic="true" data-testid="converged-announcer">
      {announcement.text ? `${announcement.text}${announcement.nonce % 2 ? ' ' : ''}` : ''}
    </div>
    {/* Outside the board, which turns inert under the 成果 view, where its run button asks this too. */}
    {rerunChoice && <RerunConfirm choice={rerunChoice} changed={rerunChoice.changed} titleOf={titleOf} withCost={withCost}
      onRest={() => answerRerun('rest')} onWhole={() => answerRerun('whole')} onCancel={() => setRerunChoice(null)} />}
    {market.dialogs}
    </AgentWorkspace>
    </AgentPagesContext.Provider>
    </MarketPagesContext.Provider>
  );
}

export { CANVAS_STORAGE_KEY };
