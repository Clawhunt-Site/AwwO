import { API_BASE, api, SaaSApiError, tenantPath } from './api';

export interface ExecutionModel { id: string; label: string; runtime: string; efforts?: string[] }
export interface ExecutionRuntime { ready: boolean; reason?: string; capabilities: { workspace: boolean; approvals: boolean }; models: ExecutionModel[] }
export interface ExecutionRunSummary { id: string; status: string; prompt: string; createdAt: string; updatedAt: string }
export interface ExecutionRuns { items: ExecutionRunSummary[]; truncated?: boolean }
export interface ExecutionMessage { id: string; role: string; text: string; createdAt: string; truncated?: boolean }
export interface ExecutionApproval {
  id: string; requestId: string; title: string; description: string; kind: 'approval' | 'question';
  arguments: Record<string, unknown>; status: 'pending' | 'sending' | 'allowed' | 'denied' | 'unknown'; createdAt: string;
}
export interface ExecutionArtifact { id: string; name: string; runId: string; nodeId: string; size: number; contentType?: string; sha256?: string; canvasId?: string; fieldId?: string; createdAt?: string }
export interface ExecutionRun extends ExecutionRunSummary {
  output: string; outputTruncated?: boolean; error: string; canRespond: boolean; canCancel: boolean; truncated: boolean;
  messages: ExecutionMessage[]; approvals: ExecutionApproval[]; artifacts: ExecutionArtifact[];
}
export interface ExecutionInput { operationId: string; prompt: string; runtime: string; model: string; effort?: string; knowledgeRevisionIds?: string[] }
export interface ExecutionResponseInput { requestId: string; behavior: 'allow' | 'deny'; message?: string; operationId: string }
export const executionTerminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => string(value) && value.length > 0;
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const unique = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
const summary = (value: unknown): value is ExecutionRunSummary => object(value) && nonempty(value.id) && nonempty(value.status)
  && string(value.prompt) && string(value.createdAt) && string(value.updatedAt);
const acceptedRun = (value: unknown): value is Pick<ExecutionRun, 'id' | 'status'> => object(value) && nonempty(value.id) && nonempty(value.status);
function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new SaaSApiError(502, 'invalid_execution_response', '执行助手返回的数据不完整，请重新读取。');
  return value;
}

/** Each HTTP request is bounded. Retrying a mutation is always an explicit UI action. */
async function bounded(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try { return await api<unknown>(path, { ...init, signal: controller.signal }); }
  catch (error) {
    if (timedOut && !signal.aborted) throw new SaaSApiError(408, 'execution_request_timeout', '执行助手请求超过 15 秒。请核对状态；未自动重复提交。');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
const runPath = (tenantId: string, runId: string) => tenantPath(tenantId, `/computer-runs/${encodeURIComponent(runId)}`);
const canvasPath = (tenantId: string, canvasId: string) => tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/computer-runs`);
const post = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });

export async function readExecutionRuntime(tenantId: string, signal: AbortSignal): Promise<ExecutionRuntime> {
  return checked(await bounded(tenantPath(tenantId, '/computer-runtime'), signal), (value): value is ExecutionRuntime => object(value)
    && bool(value.ready) && (value.reason === undefined || string(value.reason)) && object(value.capabilities)
    && bool(value.capabilities.workspace) && bool(value.capabilities.approvals) && Array.isArray(value.models)
    && value.models.every(model => object(model) && nonempty(model.id) && string(model.label) && nonempty(model.runtime)
      && (model.efforts === undefined || (Array.isArray(model.efforts) && model.efforts.every(string))))
    && new Set(value.models.map(model => `${model.runtime}/${model.id}`)).size === value.models.length);
}
export async function readExecutionRuns(tenantId: string, canvasId: string, signal: AbortSignal): Promise<ExecutionRuns> {
  return checked(await bounded(canvasPath(tenantId, canvasId), signal), (value): value is ExecutionRuns => object(value)
    && Array.isArray(value.items) && value.items.every(summary) && unique(value.items) && (value.truncated === undefined || bool(value.truncated)));
}
export async function createExecutionRun(tenantId: string, canvasId: string, input: ExecutionInput, signal: AbortSignal) {
  return checked(await bounded(canvasPath(tenantId, canvasId), signal, post(input)), acceptedRun);
}
export async function readExecutionRun(tenantId: string, runId: string, signal: AbortSignal): Promise<ExecutionRun> {
  return checked(await bounded(runPath(tenantId, runId), signal), (value): value is ExecutionRun => summary(value) && value.id === runId
    && object(value) && string(value.output) && string(value.error) && bool(value.canRespond) && bool(value.canCancel) && bool(value.truncated)
    && (value.outputTruncated === undefined || bool(value.outputTruncated))
    && Array.isArray(value.messages) && value.messages.every(message => object(message) && nonempty(message.id) && string(message.role) && string(message.text) && string(message.createdAt)
      && (message.truncated === undefined || bool(message.truncated))) && unique(value.messages)
    && Array.isArray(value.approvals) && value.approvals.every(item => object(item) && nonempty(item.id) && nonempty(item.requestId)
      && string(item.title) && string(item.description) && ['approval', 'question'].includes(String(item.kind))
      && object(item.arguments) && ['pending', 'sending', 'allowed', 'denied', 'unknown'].includes(String(item.status)) && string(item.createdAt)) && unique(value.approvals)
    && Array.isArray(value.artifacts) && value.artifacts.every(item => object(item) && nonempty(item.id) && string(item.name)
      && item.runId === runId && string(item.nodeId) && Number.isSafeInteger(item.size) && Number(item.size) >= 0
      && (item.contentType === undefined || string(item.contentType))) && unique(value.artifacts));
}
export async function respondToExecutionRun(tenantId: string, runId: string, input: ExecutionResponseInput, signal: AbortSignal) {
  return checked(await bounded(`${runPath(tenantId, runId)}/respond`, signal, post(input)), (value): value is { accepted: boolean; status: string } => object(value) && bool(value.accepted)
    && ['allowed', 'denied', 'sending', 'unknown'].includes(String(value.status)) && value.accepted === ['allowed', 'denied'].includes(String(value.status)));
}
export async function cancelExecutionRun(tenantId: string, runId: string, signal: AbortSignal) {
  return checked(await bounded(tenantPath(tenantId, `/runs/${encodeURIComponent(runId)}/cancel`), signal, post({})), (value): value is Pick<ExecutionRun, 'id' | 'status'> => acceptedRun(value) && value.id === runId);
}
export const executionArtifactURL = (tenantId: string, artifactId: string) => `${API_BASE}${tenantPath(tenantId, `/artifacts/${encodeURIComponent(artifactId)}`)}`;
