import type { CanvasDocument } from '../canvas/canvasDoc';
import { supersededGraphNodes } from '../canvas/followupDelivery';
import { diffDocuments, sameValue } from '../canvas/multiplayer/changes';
import type { CanvasChange, CanvasOp } from '../canvas/multiplayer/types';
import { reconcileEdges } from '../canvas/ports';
import { applyRecoveredDocument, recoverableOutput, runInputFingerprint, runStepInputs } from '../canvas/runRecoveryDocument';
import type { CanvasRunJournal } from '../canvas/runJournal';
import { graphIsActive, graphRecoveryJournal, type GraphRunSnapshot, type GraphRunSummary } from './graphRuns';

// 多人同屏: a canvas run's results reach the canvas through a page that watches it: the page that started it, or one that
// takes it up from the server's run record (graphRecoveryJournal) as it opens the canvas. While others have the canvas
// open, a run can end after its starter's page closed, and nothing would publish its results until someone opened the
// canvas again; so an editor's open page looks at the runs that ended a while ago (ADOPT_GRACE_MS: the starter's own page,
// when open, publishes at once) and lands each that still holds results the canvas lacks (runLanding). SaaSApp sends the
// landing as a whole-document save on the version it was decided on, which the server takes only if the canvas has not
// changed since (AWWO-LAW-026), and records with no page's id: every page, the lander's own, takes it in as someone
// else's change, which no one's undo or redo takes back.

/** How long after a run ended its starter's page is given to publish its results itself. */
export const ADOPT_GRACE_MS = 10_000;
/** A run that ended longer ago than this is left to the next opening of the canvas. */
export const ADOPT_WITHIN_MS = 30 * 60_000;
/** The runs that ended this long before the page opened are looked at too (by the page's clock, which may run some
 *  minutes off the server's; the opening itself leaves to the page the one run it takes up then). */
export const ADOPT_SINCE_MS = 5 * 60_000;
/** How often an open canvas looks. */
export const ADOPT_POLL_MS = 15_000;
/** How soon a page looks first when the opening left a run to it. */
export const ADOPT_FIRST_MS = 1_500;
let pollMs = ADOPT_POLL_MS;
/** How often an open canvas looks now (a test looks sooner). */
export function adoptionPollMs(): number { return pollMs; }
/** Tests look sooner; null puts the usual pace back. */
export function setAdoptionPollForTests(ms: number | null): void { pollMs = ms ?? ADOPT_POLL_MS; }
/** How many times a landing may find the canvas changed under it (the save refused) before the run is left to the next
 *  opening. A landing put off for another reason (a node of it running, an edit not sent yet) is asked again while the
 *  run is within ADOPT_WITHIN_MS. */
export const ADOPT_ATTEMPTS = 8;

/** When a run ended, by the server's clock: its last change, which for a finished run is its end. */
export const runEnd = (run: Pick<GraphRunSummary, 'createdAt' | 'updatedAt'>) => Date.parse(run.updatedAt ?? run.createdAt);

/** The nodes a run executes, read as graphRecoveryJournal reads them: its scope, else every node it did not reuse. */
export function runScope(run: Pick<GraphRunSummary, 'scope' | 'nodes'>): string[] {
  return run.scope?.length ? run.scope : run.nodes.filter(node => node.state !== 'cached').map(node => node.nodeId);
}

/** The runs of a canvas's run list that ended at least ADOPT_GRACE_MS ago: within ADOPT_WITHIN_MS and not before `since`,
 *  or, however long ago, one `also` names (the opening left it to the page), newest first. */
export function endedRunsToCheck(items: readonly GraphRunSummary[], now: number, since = Number.NEGATIVE_INFINITY,
  also: ReadonlySet<string> = new Set()): GraphRunSummary[] {
  return items.filter(item => {
    if (graphIsActive(item)) return false;
    const ended = runEnd(item);
    if (!Number.isFinite(ended) || now - ended < ADOPT_GRACE_MS) return false;
    return also.has(item.id) || (ended >= since && now - ended <= ADOPT_WITHIN_MS);
  });
}

/** The nodes of `run` a newer run in the list holds or remade (its results, or the ones it is making, replace the older
 *  run's there): one still going over them, or one that finished them. A newer run that failed on a node, or reused it,
 *  remade nothing there; whatever it cleared or left there is a change of the canvas, which resultsTouchedAfter sees. */
export function nodesRunSince(items: readonly GraphRunSummary[], run: GraphRunSummary): Set<string> {
  const started = Date.parse(run.createdAt);
  const own = new Set(runScope(run));
  const held = new Set<string>();
  for (const other of items) {
    if (other.id === run.id || !(Date.parse(other.createdAt) > started)) continue;
    if (graphIsActive(other)) for (const id of runScope(other)) { if (own.has(id)) held.add(id); }
    else for (const node of other.nodes) if (own.has(node.nodeId) && node.state === 'done') held.add(node.nodeId);
  }
  return held;
}

/** A node's keys whose change is a change of what the node shows as its result: the result itself, its preview and issue,
 *  a contract's outputs' values, its conversations (the node shows its active one's) and which conversation it shows. */
const RESULT_KEYS: ReadonlySet<string> = new Set(['lastOutput', 'preview', 'issueId', 'outputValues', 'contract', 'threads', 'activeThreadId']);

/** The nodes whose result anyone or anything changed at `ended` or later (by the server's clock and order, from the
 *  canvas's change log): a result published by hand, an Agent's hand-in, a chat's reply, a newer run's, a result cleared
 *  or put back, a node added again or removed. */
export function resultsTouchedAfter(changes: readonly CanvasChange[], ended: number): Set<string> {
  const touched = new Set<string>();
  for (const change of changes) {
    const at = Date.parse(change.at);
    // A change with no readable time could be any time: it counts.
    if (Number.isFinite(at) && at < ended) continue;
    for (const op of change.ops) {
      if (op.path[0] !== 'nodes' || op.path.length < 2) continue;
      if (op.path.length === 2 || RESULT_KEYS.has(op.path[2])) touched.add(op.path[1]);
    }
  }
  return touched;
}

/** Where the change log no longer reaches back to a run's end (pruned, or too long to send): the nodes showing a result
 *  stamped at its end or later, a result's own time (its writer's clock; the server's for an Agent's hand-in). */
export function resultsNewerByClock(document: CanvasDocument, ended: number): Set<string> {
  return new Set(document.nodes.filter(node => node.lastOutput && !(node.lastOutput.at < ended)).map(node => node.id));
}

/** The canvas's change log after a version, as GET …/changes answers it. */
export interface ChangeLog { version: number; changes?: CanvasChange[]; reset?: boolean }
/** How much before a run's end the oldest change read must be for the log to hold every change since. The database stamps
 *  each change as it is written, under the canvas's lock, so time follows the version; the margin is caution only. */
export const LOG_MARGIN_MS = 2_000;

type RunTimes = Pick<GraphRunSummary, 'createdAt' | 'updatedAt' | 'documentVersion'>;

/** Whether the log read after version `after` holds every change since `run` ended: it was read from the run's admission,
 *  or its oldest change came before the end (a pruned log, or one too long to send, holds nothing). */
export function logHoldsSinceEnd(run: RunTimes, log: ChangeLog | null, after: number): boolean {
  const changes = log && !log.reset && Array.isArray(log.changes) ? log.changes : null;
  return changes !== null && (after <= run.documentVersion || (changes.length > 0 && Date.parse(changes[0].at) < runEnd(run) - LOG_MARGIN_MS));
}

/** The nodes whose results changed since `run` ended: by the log read after version `after` where it holds every change
 *  since the end (logHoldsSinceEnd); else by a result's own time on `document` (resultsNewerByClock), with the nodes the
 *  changes it does hold name. */
export function touchedSinceEnd(run: RunTimes, log: ChangeLog | null, after: number, document: CanvasDocument): Set<string> {
  const ended = runEnd(run);
  const changes = log && !log.reset && Array.isArray(log.changes) ? log.changes : [];
  if (logHoldsSinceEnd(run, log, after)) return resultsTouchedAfter(changes, ended);
  return new Set([...resultsTouchedAfter(changes, ended), ...resultsNewerByClock(document, ended)]);
}

/** Whether the run's result for a step is partial, as a recovery publishes it (runRecoveryDocument.ts recoveredDelivery):
 *  complete only for a step done and not partial, and in a collaboration only its synthesis once the run completed. */
function deliveredPartial(recovered: CanvasRunJournal, id: string): boolean {
  const item = recovered.nodes[id];
  const complete = item?.state === 'done' && item.partial !== true && (!recovered.collaboration
    || (recovered.serverGraph?.status === 'completed' && id === recovered.collaboration.synthesizerNodeId));
  return !complete;
}

/** Whether the canvas shows the run's result for step `id` as a recovery publishes it, its standing included; false where
 *  the run has none for it. */
function showsDelivery(recovered: CanvasRunJournal, document: CanvasDocument, id: string): boolean {
  const item = recovered.nodes[id];
  const output = item ? recoverableOutput(recovered, item) : null;
  const shown = document.nodes.find(node => node.id === id)?.lastOutput;
  return output !== null && shown?.text === output && shown.source === 'run' && (shown.partial === true) === deliveredPartial(recovered, id);
}

/** Whether a run (its outputs read without the canvas it froze) may hold a result for one of its steps that the canvas
 *  does not show: a step whose text the canvas lacks, or shows otherwise than as the run's own result with its standing (a
 *  collaboration's synthesis shown partial, as a proposal, though the run completed it): runLanding, on the run read whole,
 *  says which lands. A step `held` names, or one a later revision of its conversation replaced, does not count, nor
 *  (outside a collaboration) a waiting, blocked or reused one, which the server records with an empty output. */
export function missingResults(run: Omit<GraphRunSnapshot, 'document'>, document: CanvasDocument, tenantId: string,
  held: ReadonlySet<string>): boolean {
  const recovered = graphRecoveryJournal({ ...run, document: undefined }, tenantId, document);
  const superseded = supersededGraphNodes(document, run);
  return recovered.scope.some(id => {
    if (held.has(id) || superseded.has(id)) return false;
    const item = recovered.nodes[id];
    return Boolean(item && recoverableOutput(recovered, item) !== null) && !showsDelivery(recovered, document, id);
  });
}

/** Each node's shown result, by id (null for none). */
const resultsOf = (document: CanvasDocument) => new Map(document.nodes.map(node => [node.id, node.lastOutput ?? null] as const));
/** What a landing may write on each node, by id: its result, its issue and its conversations (which carry theirs). */
const landingStatesOf = (document: CanvasDocument) => new Map(document.nodes.map(node => [node.id,
  [node.lastOutput ?? null, node.kind === 'session' ? node.issueId ?? null : null, node.kind === 'session' ? node.threads ?? null : null]] as const));

/** `from` and every node of `among` the wires of `documents` reach from it (the canvas the run froze and the canvas now):
 *  a run's steps after a step that keeps what the canvas shows were made from the run's own result for that step, which
 *  the canvas does not show, so they stay too. */
function withStepsAfter(documents: readonly CanvasDocument[], from: ReadonlySet<string>, among: ReadonlySet<string>): Set<string> {
  const edges = documents.flatMap(document => reconcileEdges(document.nodes, document.edges));
  const reached = new Set(from);
  const queue = [...from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of edges) {
      if (edge.fromNode === id && among.has(edge.toNode) && !reached.has(edge.toNode)) { reached.add(edge.toNode); queue.push(edge.toNode); }
    }
  }
  return reached;
}

/** What a landing writes: a node's result, its issue (and its conversations', which carry them), nothing else. */
// A landing also fingerprints each result it lands held for an invited Agent's words, as every landing does
// (runRecoveryDocument.ts applyRecoveredDocument, agentPages.ts recordAgentPages); the server takes them as a person's
// write may add them (canvas_agent_words.go keepAgentWritten).
const LANDING_KEYS: ReadonlySet<string> = new Set(['lastOutput', 'issueId', 'threads', 'agentWritten']);

/** A run's results as they land on a canvas. */
export interface RunLanding {
  /** The run as it lands: the steps that stay as the canvas shows them are left out. */
  journal: CanvasRunJournal;
  /** The ops that turn the canvas into `document` (results only). */
  ops: CanvasOp[];
  /** The canvas with the run's results. */
  document: CanvasDocument;
  /** Every node the landing writes or runs on. */
  nodes: string[];
  /** Whether the run lands whole, no step left as the canvas shows it. */
  whole: boolean;
}

/** The run's steps that stay as the canvas shows them, before the steps after them are added: where the canvas still holds
 *  the inputs of the whole run, each step `marked` (held or touched) whose result, issue or conversations the landing would
 *  change (one showing the run's own result stays in the run); else, some step's inputs having changed since (its brief
 *  edited to run it again, say), each marked step whose result, issue or conversations its own delivery would change,
 *  and every step whose own inputs differ from the run's (runStepInputs: its settings and its wires, an earlier step of
 *  the run by its settings alone, as the run fed it its own result). */
function stepsToKeep(recovered: CanvasRunJournal, frozen: CanvasDocument, document: CanvasDocument, marked: (id: string) => boolean): string[] {
  if (recovered.inputFingerprint === runInputFingerprint(document, recovered.scope)) {
    const before = landingStatesOf(document);
    const whole = landingStatesOf(applyRecoveredDocument(document, { ...recovered, inputFingerprint: recovered.inputFingerprint ?? '' }));
    return recovered.scope.filter(id => marked(id) && !sameValue(whole.get(id) ?? null, before.get(id) ?? null));
  }
  const before = landingStatesOf(document);
  // A step's own delivery alone, as a recovery of that step would make it on this canvas (a collaboration lands whole or
  // not at all: its marked steps stay).
  const changes = (id: string) => {
    const item = recovered.nodes[id];
    if (!item || recovered.collaboration) return true;
    const alone = applyRecoveredDocument(document, { ...recovered, scope: [id], nodes: { [id]: item }, inputFingerprint: runInputFingerprint(document, [id]) });
    return !sameValue(landingStatesOf(alone).get(id) ?? null, before.get(id) ?? null);
  };
  return recovered.scope.filter(id => (marked(id) && changes(id))
    || runStepInputs(frozen, recovered.scope, id) !== runStepInputs(document, recovered.scope, id));
}

/**
 * How a run that ended (read whole: its frozen canvas and its nodes' outputs) lands on `document`, or null for one to
 * leave as the canvas is. A step stays as the canvas shows it, whatever the run made of it (a step it left without output
 * too), where `held` names it (a newer run holds or remade it: nodesRunSince) or `touched` does (its result changed since
 * the run ended: resultsTouchedAfter), and the run would change what it shows, its issue or its conversations (one showing
 * the run's own result already stays in the run); so does a step whose own inputs changed since the run; and so do the
 * run's steps after any of these, which were made from the run's result for it. The rest lands, unless the run is a
 * collaboration (whole or not at all). Nothing lands where the canvas no longer holds the inputs the rest was made from,
 * nor where the landing would change the result, issue or conversations of any node `touched` or `held` names, anywhere
 * on the canvas (a step it publishes lies upstream of one: the freshness rules would clear it). Null too where no step
 * gets a result it does not show, with its standing (a partial shown where the run's is complete counts as missing).
 */
export function runLanding(run: GraphRunSnapshot, document: CanvasDocument, tenantId: string, held: ReadonlySet<string>,
  touched: ReadonlySet<string>): RunLanding | null {
  // The inputs a result was made from are told by the canvas the run froze: without it nothing is known to match.
  if (graphIsActive(run) || !run.document) return null;
  const frozen = run.document;
  const recovered = graphRecoveryJournal(run, tenantId, document);
  const changed = stepsToKeep(recovered, frozen, document, id => held.has(id) || touched.has(id));
  const kept = withStepsAfter([frozen, document], new Set(changed), new Set(recovered.scope));
  const scope = recovered.scope.filter(id => !kept.has(id));
  if (!scope.length || (kept.size && recovered.collaboration)) return null;
  const journal: CanvasRunJournal = kept.size ? { ...recovered, scope, inputFingerprint: runInputFingerprint(frozen, scope),
    nodes: Object.fromEntries(Object.entries(recovered.nodes).filter(([id]) => !kept.has(id))) } : recovered;
  if (journal.inputFingerprint !== runInputFingerprint(document, scope)) return null;
  // What lies after a step it gives a result goes stale, as after any edit (applyRecoveredDocument).
  const landed = applyRecoveredDocument(document, { ...journal, inputFingerprint: journal.inputFingerprint ?? '' });
  const shown = resultsOf(document), results = resultsOf(landed);
  if (!scope.some(id => results.get(id) != null && !sameValue(results.get(id), shown.get(id) ?? null))) return null;
  const before = landingStatesOf(document), after = landingStatesOf(landed);
  for (const id of [...touched, ...held]) {
    if (before.has(id) && !sameValue(after.get(id) ?? null, before.get(id) ?? null)) return null;
  }
  const ops = diffDocuments(document, landed);
  if (!ops.length || ops.some(op => op.op === 'order' || op.path[0] !== 'nodes' || op.path.length < 3 || !LANDING_KEYS.has(op.path[2]))) return null;
  return { journal, ops, document: landed, nodes: [...new Set([...scope, ...ops.map(op => op.path[1])])], whole: !kept.size };
}

/** Whether a page's working document holds what `landing` was decided on: the inputs its steps were made from, and every
 *  result it writes, as the server's document did (no edit of this page's own there, not sent yet). */
export function workingHoldsLanding(working: CanvasDocument, decided: CanvasDocument, landing: RunLanding): boolean {
  if (runInputFingerprint(working, landing.journal.scope) !== runInputFingerprint(decided, landing.journal.scope)) return false;
  const shown = new Map(working.nodes.map(node => [node.id, node] as const));
  return decided.nodes.every(node => !landing.nodes.includes(node.id) || (shown.has(node.id)
    && sameValue(shown.get(node.id)?.lastOutput ?? null, node.lastOutput ?? null)));
}
