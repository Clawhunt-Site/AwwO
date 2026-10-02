import { api, SaaSApiError, tenantPath } from './api';
import { canvasStorageKey } from '../canvas/canvasStorage';
import { canvasText } from './canvasErrors';

type Scope = { tenant: { id: string }; canvasId: string };
type Entry = { version: 1; tenantId: string; canvasId: string; operationId: string; prompt: string; context?: string; revision: string; knowledgeRevisionIds?: string[]; runId?: string };
export type PlannerRun = { id: string; status?: string; terminal?: boolean; output?: string; error?: string };
const terminal = (run: PlannerRun) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status ?? '');
export const planningRecoveryRequired = () => new SaaSApiError(409, 'planning_recovery_required', canvasText(
  '规划连接中断，本次运行已保留。请恢复本次规划或确认停止后再开始；当前画布保持原样。',
  'The planning connection was interrupted. Recover this planning run or confirm it has stopped before starting another. The canvas has not changed.'));
const storageError = () => new SaaSApiError(409, 'planning_recovery_storage', canvasText(
  '无法保存或读取规划恢复记录。请先恢复浏览器存储，再读取原运行状态，避免重复提交。',
  'Planning recovery storage is unavailable. Restore browser storage and check the original run before submitting again.'));

/** Capture the complete account/workspace/canvas namespace once. No prompt or credentials leave
 * the existing API; the small journal only prevents an uncertain admission being submitted again. */
export function plannerRecovery(scope: Scope, knowledgeRevisionIds: readonly string[] = []) {
  const knowledge = [...new Set(knowledgeRevisionIds)].sort();
  const key = canvasStorageKey(`awwo.canvas.planning.run.v1:${encodeURIComponent(scope.tenant.id)}:${encodeURIComponent(scope.canvasId)}`);
  const base = tenantPath(scope.tenant.id);
  function read(): Entry | null {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw) as Entry;
      if (value.version !== 1 || value.tenantId !== scope.tenant.id || value.canvasId !== scope.canvasId
        || typeof value.operationId !== 'string' || !value.operationId || typeof value.prompt !== 'string'
        || (value.context !== undefined && typeof value.context !== 'string')
        || typeof value.revision !== 'string' || (value.runId !== undefined && typeof value.runId !== 'string')
        || (value.knowledgeRevisionIds !== undefined && (!Array.isArray(value.knowledgeRevisionIds) || value.knowledgeRevisionIds.some(id => typeof id !== 'string')))) throw storageError();
      return value;
    } catch { throw storageError(); }
  }
  function write(value: Entry) {
    try {
      const previous = read();
      if (previous && previous.operationId !== value.operationId) throw planningRecoveryRequired();
      const raw = JSON.stringify(value);
      localStorage.setItem(key, raw);
      if (localStorage.getItem(key) !== raw) throw storageError();
    } catch (error) { if (error instanceof SaaSApiError) throw error; throw storageError(); }
  }
  function clearUnlocked(value: Entry) {
    try { if (read()?.operationId === value.operationId) localStorage.removeItem(key); }
    catch { throw storageError(); }
  }
  // Reads and cancellation acknowledgements are bounded independently of a model's runtime.
  async function request<T>(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(relay, 30_000);
    try {
      if (signal?.aborted) controller.abort();
      return await api<T>(`${base}${path}`, { ...init, signal: controller.signal });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); }
  }
  async function lookupUnlocked(value: Entry, signal?: AbortSignal, allowMissing = false): Promise<PlannerRun | null> {
    const run = value.runId
      ? await request<PlannerRun>(`/runs/${encodeURIComponent(value.runId)}`, signal)
      : (await request<{ items: PlannerRun[] }>(`/runs?operationId=${encodeURIComponent(value.operationId)}`, signal)).items?.[0];
    // An empty lookup is not proof that a timed-out admission cannot still commit. Only explicit
    // recovery may replay the exact original payload and idempotency key; never allocate a new one.
    if (!run && allowMissing && !value.runId) return null;
    if (!run || typeof run.id !== 'string' || !run.id || (value.runId && run.id !== value.runId)) throw planningRecoveryRequired();
    if (!value.runId) { value.runId = run.id; write(value); }
    return run;
  }
  async function beginUnlocked(prompt: string, revision: string, context: string, signal?: AbortSignal, expectedOperationId?: string) {
    let entry = read();
    if (expectedOperationId !== undefined && entry?.operationId !== expectedOperationId) throw planningRecoveryRequired();
    const recovering = Boolean(entry);
    if (entry) {
      if (entry.prompt !== prompt || !matches(entry, revision)) throw planningRecoveryRequired();
      const run = await lookupUnlocked(entry, signal, true);
      if (run) return { entry, run, recovering: true };
      if (entry.context === undefined) throw planningRecoveryRequired();
    } else {
      entry = { version: 1, tenantId: scope.tenant.id, canvasId: scope.canvasId, operationId: crypto.randomUUID(), prompt, context, revision, knowledgeRevisionIds: knowledge };
      // Fail closed before admission if refresh could otherwise forget an accepted paid run.
      write(entry);
    }
    let run: PlannerRun;
    try {
      run = await request<PlannerRun>(`/canvases/${encodeURIComponent(scope.canvasId)}/plan`, signal,
        { method: 'POST', body: JSON.stringify({ prompt: entry.prompt, context: entry.context, operationId: entry.operationId,
          ...(entry.knowledgeRevisionIds?.length ? { knowledgeRevisionIds: entry.knowledgeRevisionIds } : {}) }) });
    } catch (error) {
      // Explicit rejection did not create this operation. Network/5xx outcomes remain uncertain.
      if (error instanceof SaaSApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        // A rejection of a replay says nothing about the earlier uncertain request's outcome.
        if (!recovering) clearUnlocked(entry);
        throw error;
      }
      throw planningRecoveryRequired();
    }
    if (!run || typeof run.id !== 'string' || !run.id) throw planningRecoveryRequired();
    entry.runId = run.id;
    write(entry); // If this fails, the operationId already on disk still recovers the accepted run.
    return { entry, run, recovering };
  }
  async function locked<T>(action: () => T | Promise<T>): Promise<T> {
    // localStorage has no compare-and-swap. Serialize the read/claim/admission across tabs, so
    // two empty reads cannot create differently keyed paid operations or overwrite one journal.
    if (!navigator.locks) throw storageError();
    return navigator.locks.request(`awwo.planner:${key}`, { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) throw planningRecoveryRequired();
      return action();
    });
  }
  const begin = (prompt: string, revision: string, context: string, signal?: AbortSignal, expectedOperationId?: string) => locked(() => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return beginUnlocked(prompt, revision, context, signal, expectedOperationId);
  });
  const lookup = (entry: Entry, signal?: AbortSignal) => locked(async () => (await lookupUnlocked(entry, signal))!);
  const clear = (entry: Entry) => locked(() => clearUnlocked(entry));
  async function cancelUnlocked(entry: Entry | null, signal?: AbortSignal): Promise<void> {
    if (!entry) return;
    let run = entry.runId ? { id: entry.runId } : (await lookupUnlocked(entry, signal))!;
    if (!terminal(run)) {
      try {
        run = await request<PlannerRun>(`/runs/${encodeURIComponent(run.id)}/cancel`, signal, { method: 'POST', body: '{}' });
      } catch (error) {
        if (error instanceof SaaSApiError && error.status === 401) throw error;
        run = (await lookupUnlocked(entry, signal))!;
      }
    }
    if (!terminal(run)) throw planningRecoveryRequired();
    clearUnlocked(entry);
  }
  const cancel = (entry?: Entry | null, signal?: AbortSignal) => locked(() => cancelUnlocked(entry === undefined ? read() : entry, signal));
  const cancelMatching = (operationId: string, signal?: AbortSignal) => locked(() => {
    const entry = read();
    if (!operationId || entry?.operationId !== operationId) throw planningRecoveryRequired();
    return cancelUnlocked(entry, signal);
  });
  function matches(entry: Entry, revision: string) {
    return entry.revision === revision && JSON.stringify([...(entry.knowledgeRevisionIds ?? [])].sort()) === JSON.stringify(knowledge);
  }
  return { read, begin, lookup, clear, cancel, cancelMatching, terminal, matches };
}
