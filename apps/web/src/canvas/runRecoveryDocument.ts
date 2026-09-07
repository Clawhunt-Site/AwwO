import { canvasStorage } from './canvasStorage';
import type { CanvasDocument, CanvasEdge, CanvasNode, SessionNode } from './canvasDoc';
import { invalidateOutputs } from './invalidateOutputs';
import type { CanvasRunJournal } from './runJournal';
import { activeThreadId, updateThreadIssueId } from './nodeThreads';
import { reconcileEdges } from './ports';

export type FingerprintedRunJournal = CanvasRunJournal & { inputFingerprint: string };

export interface RecoveredConversationTurn {
  role: 'user' | 'agent' | 'system';
  text: string;
  tone?: 'info' | 'warn' | 'error';
  /** In-memory idempotency metadata. Session storage preserves extra fields when
   *  turns are replaced, while renderers continue to use role/text/tone only. */
  recoveryOperationId?: string;
  recoveryRunId?: string;
}

interface DurableManualTurn {
  operationId: string | null;
  runId: string | null;
  userText: string;
  agentText: string;
  state: 'done' | 'failed' | 'cancelled';
  startedAt: number;
}

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;
const MANUAL_RECOVERY_PREFIX = 'awwo.canvas.manual-recovery.v1';
const MAX_MANUAL_RECOVERIES_PER_SESSION = 50;
const MAX_MANUAL_RECOVERY_CHARS = 1_000_000;

function manualRecoveryKey(node: SessionNode): string | null {
  if (!node.binding) return null;
  return [MANUAL_RECOVERY_PREFIX, node.binding.companyId, node.binding.agentId, node.id, activeThreadId(node)]
    .map(encodeURIComponent).join(':');
}

function manualRecord(node: SessionNode, journal: CanvasRunJournal): DurableManualTurn | null {
  if (!journal.manual) return null;
  const item = journal.nodes[node.id];
  if (!item || !['done', 'failed', 'cancelled'].includes(item.state)
    || item.threadId !== activeThreadId(node) || !node.binding
    || item.companyId !== node.binding.companyId || item.agentId !== node.binding.agentId
    || (!item.operationId && !item.runId)) return null;
  return {
    operationId: item.operationId ?? null,
    runId: item.runId ?? null,
    userText: journal.manualMessage ?? '',
    agentText: item.output ?? '',
    state: item.state as DurableManualTurn['state'],
    startedAt: journal.startedAt,
  };
}

function sameManualIdentity(left: DurableManualTurn, right: DurableManualTurn): boolean {
  return Boolean((left.operationId && left.operationId === right.operationId)
    || (left.runId && left.runId === right.runId));
}

function readManualRecords(node: SessionNode, storage: Pick<Storage, 'getItem'>): DurableManualTurn[] | null {
  const key = manualRecoveryKey(node);
  if (!key) return [];
  try {
    const source = storage.getItem(key);
    if (source === null) return [];
    if (source.length > MAX_MANUAL_RECOVERY_CHARS) return null;
    const raw = JSON.parse(source) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as { version?: unknown; records?: unknown };
    if (value.version !== 1 || !Array.isArray(value.records)
      || value.records.length > MAX_MANUAL_RECOVERIES_PER_SESSION) return null;
    const records: DurableManualTurn[] = [];
    for (const item of value.records) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if ((record.operationId !== null && typeof record.operationId !== 'string')
        || (record.runId !== null && typeof record.runId !== 'string')
        || (!record.operationId && !record.runId)
        || typeof record.userText !== 'string' || typeof record.agentText !== 'string'
        || !['done', 'failed', 'cancelled'].includes(String(record.state))
        || !Number.isFinite(record.startedAt)) return null;
      records.push(record as unknown as DurableManualTurn);
    }
    return records;
  } catch {
    return null;
  }
}

/** Persist confirmed manual stdout before its journal is deleted. A full/corrupt
 * store fails closed so the durable journal remains the recovery source. */
export function persistRecoveredManualConversation(
  node: SessionNode,
  journal: CanvasRunJournal,
  storage: RecoveryStorage = canvasStorage(),
): boolean {
  const key = manualRecoveryKey(node);
  const record = manualRecord(node, journal);
  if (!key || !record) return !journal.manual;
  if (record.userText.length + record.agentText.length > MAX_MANUAL_RECOVERY_CHARS) return false;
  const records = readManualRecords(node, storage);
  if (!records) return false;
  if (records.some(existing => sameManualIdentity(existing, record))) return true;
  if (records.length >= MAX_MANUAL_RECOVERIES_PER_SESSION) return false;
  const encoded = JSON.stringify({ version: 1, records: [...records, record] });
  if (encoded.length > MAX_MANUAL_RECOVERY_CHARS) return false;
  try { storage.setItem(key, encoded); return true; } catch { return false; }
}

function mergeManualRecord(
  existing: RecoveredConversationTurn[],
  record: DurableManualTurn,
  consumedPairs: Set<number>,
): RecoveredConversationTurn[] {
  if (existing.some(turn => (record.operationId && turn.recoveryOperationId === record.operationId)
    || (record.runId && turn.recoveryRunId === record.runId))) return existing;
  const visible = existing.map((turn, index) => ({ turn, index })).filter(item => item.turn.role !== 'system');
  for (let index = 0; index < visible.length; index += 1) {
    const user = visible[index];
    const agent = visible[index + 1];
    if (consumedPairs.has(user.index) || user.turn.role !== 'user' || user.turn.text !== record.userText) continue;
    if (record.agentText && (!agent || agent.turn.role !== 'agent' || agent.turn.text !== record.agentText)) continue;
    consumedPairs.add(user.index);
    if (agent) consumedPairs.add(agent.index);
    return existing;
  }
  const identity = {
    ...(record.operationId ? { recoveryOperationId: record.operationId } : {}),
    ...(record.runId ? { recoveryRunId: record.runId } : {}),
  };
  const merged = [...existing];
  if (record.userText.trim()) merged.push({ role: 'user', text: record.userText, ...identity });
  if (record.agentText.trim()) merged.push({
    role: 'agent', text: record.agentText,
    ...(record.state === 'done' ? {} : { tone: 'warn' as const }),
    ...identity,
  });
  return merged;
}

/** Overlay locally recovered stdout onto a freshly restored server transcript.
 * null means the local recovery store was unreadable and history must not be
 * reported as fully loaded. */
export function mergePersistedManualConversations(
  node: SessionNode,
  serverTurns: ReadonlyArray<RecoveredConversationTurn>,
  storage: Pick<Storage, 'getItem'> = canvasStorage(),
): RecoveredConversationTurn[] | null {
  const records = readManualRecords(node, storage);
  if (!records) return null;
  let merged = [...serverTurns];
  const consumedPairs = new Set<number>();
  for (const record of records.slice().sort((a, b) => a.startedAt - b.startedAt)) {
    merged = mergeManualRecord(merged, record, consumedPairs);
  }
  return merged;
}

/** A historical native success is not a successful delivery for changed canvas inputs. */
export function recoveryJournalForDocument(doc: CanvasDocument, journal: CanvasRunJournal): CanvasRunJournal {
  if (journal.manual || journal.inputFingerprint === runInputFingerprint(doc, journal.scope)) return journal;
  const scope = new Set(journal.scope);
  return { ...journal, nodes: Object.fromEntries(Object.entries(journal.nodes).map(([id, node]) => [
    id, scope.has(id) && node.state === 'done'
      ? { ...node, state: 'failed' as const, detail: 'recovery_input_changed' }
      : node,
  ])) };
}

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function relevantNodeIds(edges: ReadonlyArray<CanvasEdge>, scope: ReadonlyArray<string>): Set<string> {
  const relevant = new Set(scope);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (!relevant.has(edge.toNode) || relevant.has(edge.fromNode)) continue;
      relevant.add(edge.fromNode);
      changed = true;
    }
  }
  return relevant;
}

function fieldInput(field: NonNullable<SessionNode['contract']>['inputs'][number]) {
  return {
    id: field.id, label: field.label, type: field.type, required: field.required,
    value: field.value, help: field.help ?? null, placeholder: field.placeholder ?? null,
  };
}

function fieldOutput(field: NonNullable<SessionNode['contract']>['outputs'][number]) {
  return {
    id: field.id, label: field.label, type: field.type, required: field.required,
    help: field.help ?? null, placeholder: field.placeholder ?? null,
  };
}

function nodeInput(node: CanvasNode, inScope: boolean) {
  if (node.kind === 'form') {
    return {
      id: node.id,
      kind: node.kind,
      title: node.title,
      fields: node.fields.map(field => ({ id: field.id, label: field.label, value: field.value })),
      // An out-of-scope ancestor contributes its captured output instead of executing again.
      reusedOutput: inScope ? null : node.lastOutput
        ? { text: node.lastOutput.text, partial: node.lastOutput.partial === true }
        : null,
    };
  }
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    agentKind: node.agentKind,
    runtime: node.runtime,
    model: node.model,
    effort: node.effort,
    persona: node.persona,
    binding: node.binding ? { companyId: node.binding.companyId, agentId: node.binding.agentId } : null,
    activeThreadId: activeThreadId(node),
    contract: node.contract ? {
      version: node.contract.version,
      inputs: node.contract.inputs.map(fieldInput),
      outputs: node.contract.outputs.map(fieldOutput),
    } : null,
    // Scope nodes produce a new value. Only cached ancestors' current output is a run input.
    reusedOutput: inScope ? null : node.lastOutput
      ? { text: node.lastOutput.text, partial: node.lastOutput.partial === true }
      : null,
  };
}

function edgeInput(edge: CanvasEdge) {
  return {
    fromNode: edge.fromNode, fromPort: edge.fromPort,
    toNode: edge.toNode, toPort: edge.toPort, dataType: edge.dataType,
  };
}

function incomingOrder(
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
  relevant: ReadonlySet<string>,
) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return nodes
    .filter(node => relevant.has(node.id))
    .map(node => ({
      nodeId: node.id,
      inputs: edges
        .filter(edge => edge.toNode === node.id)
        .slice()
        // This mirrors runGraph.dependenciesOf. Coordinates themselves remain presentation
        // state; only the relative order that actually changes a legacy node's prompt is saved.
        .sort((a, b) => {
          const left = byId.get(a.fromNode);
          const right = byId.get(b.fromNode);
          if (!left || !right) return 0;
          if (left.y !== right.y) return left.y - right.y;
          if (left.x !== right.x) return left.x - right.x;
          return lexical(a.id, b.id);
        })
        .map(edgeInput),
    }))
    .filter(item => item.inputs.length > 1)
    .sort((a, b) => lexical(a.nodeId, b.nodeId));
}

/**
 * Exact canonical run-input snapshot. It deliberately is not a short, collision-prone hash.
 * Server-minted issue/run identities, geometry, previews and the outputs being replaced are
 * excluded. A cached ancestor's output is included because it is a real input to a scoped run.
 */
export function runInputFingerprint(doc: CanvasDocument, scope: ReadonlyArray<string>): string {
  const scoped = [...new Set(scope)].sort(lexical);
  const scopeSet = new Set(scoped);
  // Match the runner's executable graph. Persisted documents may briefly retain a stale wire
  // whose port was removed; that wire never reaches runGraph and must not poison recovery.
  const executableEdges = reconcileEdges(doc.nodes, doc.edges);
  const relevant = relevantNodeIds(executableEdges, scoped);
  const nodes = doc.nodes
    .filter(node => relevant.has(node.id))
    .sort((a, b) => lexical(a.id, b.id))
    .map(node => nodeInput(node, scopeSet.has(node.id)));
  const edges = executableEdges
    .filter(edge => relevant.has(edge.fromNode) && relevant.has(edge.toNode))
    .map(edgeInput)
    .sort((a, b) => lexical(JSON.stringify(a), JSON.stringify(b)));
  const orderedInputs = incomingOrder(doc.nodes, executableEdges, relevant);
  return `v1:${JSON.stringify({ scope: scoped, nodes, edges, orderedInputs })}`;
}

/** Build and persist this snapshot before any native dispatch can begin. */
export function prepareRunDocument(
  doc: CanvasDocument,
  scope: ReadonlyArray<string>,
  manual: boolean,
): CanvasDocument {
  if (manual) return doc;
  const selected = new Set(scope);
  const cleared = {
    ...doc,
    nodes: doc.nodes.map(node => selected.has(node.id) && node.lastOutput != null
      ? { ...node, lastOutput: null }
      : node),
  };
  return invalidateOutputs(doc, cleared);
}

/** Rebuild a detached manual turn after the server transcript has been restored.
 * The journal is the durable source for the exact user input and confirmed run
 * output. Reapplying the same operation/run is idempotent, and a server history
 * that already ends with the same pair is left untouched. */
export function mergeRecoveredManualConversation(
  existing: ReadonlyArray<RecoveredConversationTurn>,
  journal: CanvasRunJournal,
  nodeId: string,
): RecoveredConversationTurn[] {
  const item = journal.nodes[nodeId];
  if (!journal.manual || !item || !['done', 'failed', 'cancelled'].includes(item.state)
    || (!item.operationId && !item.runId)) return [...existing];
  return mergeManualRecord([...existing], {
    operationId: item.operationId ?? null,
    runId: item.runId ?? null,
    userText: journal.manualMessage ?? '',
    agentText: item.output ?? '',
    state: item.state as DurableManualTurn['state'],
    startedAt: journal.startedAt,
  }, new Set());
}

function belongsToJournalThread(node: CanvasNode, threadId: string): boolean {
  return node.kind === 'form' ? threadId === 'form' : activeThreadId(node) === threadId;
}

function belongsToJournalBinding(
  node: CanvasNode,
  item: CanvasRunJournal['nodes'][string],
): boolean {
  if (!belongsToJournalThread(node, item.threadId)) return false;
  if (node.kind === 'form') return true;
  return Boolean(node.binding
    && node.binding.companyId === item.companyId
    && node.binding.agentId === item.agentId);
}

/**
 * Merge one confirmed recovery batch without letting normal freshness invalidation erase a
 * downstream result from that same coherent run. The caller writes this returned document
 * directly; passing it through invalidateOutputs a second time would recreate the bug.
 */
export function applyRecoveredDocument(
  doc: CanvasDocument,
  journal: FingerprintedRunJournal,
): CanvasDocument {
  const inputsMatch = journal.inputFingerprint === runInputFingerprint(doc, journal.scope);
  const selected = new Set(journal.scope);

  // First apply ordinary freshness rules. This clears old scope results and anything downstream,
  // including nodes outside a partial-run scope. Manual conversation recovery does not touch the
  // publication graph at all.
  const cleared = journal.manual ? doc : {
    ...doc,
    nodes: doc.nodes.map(node => selected.has(node.id) && belongsToJournalThread(node, journal.nodes[node.id]?.threadId ?? '')
      && node.lastOutput != null ? { ...node, lastOutput: null } : node),
  };
  const invalidated = journal.manual ? doc : invalidateOutputs(doc, cleared);

  const nodes = invalidated.nodes.map(node => {
    const item = journal.nodes[node.id];
    // A node id/thread id can survive rebinding. Server identities and output from
    // the old Agent must never be merged into the replacement Agent's session.
    if (!item || !belongsToJournalBinding(node, item)) return node;
    let next = node;
    // Issue ids are server evidence, not an execution-input edit. Merge them after freshness
    // invalidation so a newly observed id cannot erase an existing manual publication.
    if (next.kind === 'session' && item.issueId) next = updateThreadIssueId(next, item.threadId, item.issueId);
    if (journal.manual || !inputsMatch || !selected.has(node.id)) return next;
    if (!['done', 'failed', 'cancelled'].includes(item.state) || !item.output) return next;
    return {
      ...next,
      lastOutput: {
        text: item.output,
        at: journal.startedAt,
        source: 'run' as const,
        ...(item.state === 'done' ? {} : { partial: true }),
      },
    };
  });
  return nodes.some((node, index) => node !== doc.nodes[index]) ? { ...invalidated, nodes } : invalidated;
}
