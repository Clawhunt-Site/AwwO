import type { SessionNode } from './canvasDoc';
import { activeThreadId } from './nodeThreads';
import { normalizeContract } from './nodeContracts';
import type { Turn, TurnPresentation } from './sessions';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
type ReadStore = Pick<Storage, 'getItem'>;
interface RecordEntry {
  operationId: string;
  issueId: string | null;
  runId: string | null;
  executionText: string;
  outputText?: string;
  presentation: TurnPresentation;
}
const PREFIX = 'awwo.canvas.conversation-presentation.v1';
const MAX_CHARS = 1_000_000;
const MAX_RECORDS = 100;

/** Access itself can throw in a blocked or sandboxed browser, before getItem is called. */
function browserStorage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function normalizePresentation(value: unknown): TurnPresentation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as TurnPresentation;
  if ((p.displayText !== undefined && typeof p.displayText !== 'string')
    || (p.inputKind !== undefined && !['manual', 'workflow', 'legacy-execution'].includes(p.inputKind))
    || (p.outputState !== undefined && !['streaming', 'final', 'failed'].includes(p.outputState))) return undefined;
  const outputContract = normalizeContract(p.outputContract);
  if (p.outputContract !== undefined && !outputContract) return undefined;
  return {
    ...(p.displayText !== undefined ? { displayText: p.displayText } : {}),
    ...(p.inputKind !== undefined ? { inputKind: p.inputKind } : {}),
    ...(p.outputState !== undefined ? { outputState: p.outputState } : {}),
    ...(outputContract ? { outputContract } : {}),
  };
}

function key(node: SessionNode): string | null {
  if (!node.binding) return null;
  return [PREFIX, node.binding.companyId, node.binding.agentId, node.id, activeThreadId(node)].map(encodeURIComponent).join(':');
}

/** Optional presentation data fails back to the original transcript, never to invented history. */
function read(node: SessionNode, store: ReadStore | null): RecordEntry[] | null {
  try {
    if (!store) return null;
    const name = key(node);
    if (!name) return [];
    const source = store.getItem(name);
    if (!source || source.length > MAX_CHARS) return [];
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object') return [];
    const raw = parsed as { version?: unknown; records?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) return [];
    const records: RecordEntry[] = [];
    for (const value of raw.records) {
      if (!value || typeof value !== 'object') return [];
      const item = value as RecordEntry;
      if (typeof item.operationId !== 'string' || !item.operationId || typeof item.executionText !== 'string'
        || (item.issueId !== null && typeof item.issueId !== 'string') || (item.runId !== null && typeof item.runId !== 'string')
        || (item.outputText !== undefined && typeof item.outputText !== 'string')
        || !item.presentation || typeof item.presentation !== 'object') return [];
      const presentation = normalizePresentation(item.presentation);
      if (!presentation) return [];
      records.push({ operationId: item.operationId, issueId: item.issueId, runId: item.runId,
        executionText: item.executionText,
        ...(item.outputText !== undefined ? { outputText: item.outputText } : {}), presentation });
    }
    return records;
  } catch { return null; }
}

function write(node: SessionNode, records: RecordEntry[], store: Store | null): boolean {
  try {
    const name = key(node);
    if (!store || !name) return false;
    // Eviction removes only the display cache; the raw native transcript stays authoritative.
    const bounded = records.slice(-MAX_RECORDS);
    let encoded = JSON.stringify({ version: 1, records: bounded });
    while (encoded.length > MAX_CHARS && bounded.length > 1) {
      bounded.shift();
      encoded = JSON.stringify({ version: 1, records: bounded });
    }
    if (encoded.length > MAX_CHARS) return false;
    store.setItem(name, encoded);
    return true;
  } catch { return false; }
}

export function beginConversationPresentation(
  node: SessionNode, operationId: string, executionText: string, presentation: TurnPresentation,
  store?: Store,
): boolean {
  try {
    const resolved = store ?? browserStorage();
    if (!resolved || !operationId) return false;
    const records = read(node, resolved);
    if (!records) return false;
    const existing = records.find(record => record.operationId === operationId);
    if (existing) return existing.issueId === node.issueId && existing.executionText === executionText;
    const frozen = normalizePresentation(JSON.parse(JSON.stringify(presentation)));
    if (!frozen) return false;
    return write(node, [...records, { operationId, issueId: node.issueId, runId: null, executionText, presentation: frozen }], resolved);
  } catch { return false; }
}

export function updateConversationPresentation(
  node: SessionNode, operationId: string,
  patch: { issueId?: string | null; runId?: string | null; outputText?: string; outputState?: TurnPresentation['outputState'] },
  store?: Store,
): boolean {
  const resolved = store ?? browserStorage();
  const records = read(node, resolved);
  if (!records?.some(record => record.operationId === operationId)) return false;
  return write(node, records.map(record => record.operationId !== operationId ? record : {
    ...record,
    ...(patch.issueId !== undefined ? { issueId: patch.issueId } : {}),
    ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
    ...(patch.outputText !== undefined ? { outputText: patch.outputText } : {}),
    presentation: { ...record.presentation, ...(patch.outputState ? { outputState: patch.outputState } : {}) },
  }), resolved);
}

/** Join by native/recovery identity AND exact execution text; never guess from display text. */
export function projectConversationTurns<T extends Omit<Turn, 'id'>>(
  node: SessionNode, turns: ReadonlyArray<T>, store?: ReadStore,
): T[] {
  const records = read(node, store ?? browserStorage()) ?? [];
  return turns.map(turn => {
    if (turn.role === 'system') return turn;
    const operationId = turn.nativeOperationId || turn.recoveryOperationId;
    const runId = turn.nativeRunId || turn.recoveryRunId;
    // Conflicting native/recovery markers cannot safely select a display projection.
    if ((turn.nativeOperationId && turn.recoveryOperationId && turn.nativeOperationId !== turn.recoveryOperationId)
      || (turn.nativeRunId && turn.recoveryRunId && turn.nativeRunId !== turn.recoveryRunId)) return turn;
    const matches = records.filter(record => record.issueId === node.issueId && (
      operationId ? record.operationId === operationId : turn.role === 'agent' && runId && record.runId === runId
    ) && (!runId || !record.runId || record.runId === runId));
    if (matches.length !== 1) return turn;
    const record = matches[0];
    if (turn.role === 'user') {
      if (turn.text !== record.executionText) return turn;
      return { ...turn, presentation: { inputKind: record.presentation.inputKind, displayText: record.presentation.displayText } };
    }
    if (turn.text !== record.outputText) return turn;
    return { ...turn, presentation: { outputState: record.presentation.outputState, outputContract: record.presentation.outputContract } };
  });
}

/** The Gateway writes this operation marker as comment metadata, outside the user's body. */
export function nativeConversationOperation(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = metadata as { version?: unknown; sections?: unknown };
  if (value.version !== 1 || !Array.isArray(value.sections)) return undefined;
  const ids: string[] = [];
  for (const section of value.sections) {
    if (!section || section.title !== 'AwwO conversation' || !Array.isArray(section.rows)) continue;
    for (const row of section.rows) {
      if (row?.type === 'key_value' && row.label === 'Operation' && typeof row.value === 'string' && row.value) ids.push(row.value);
    }
  }
  return ids.length === 1 ? ids[0] : undefined;
}
