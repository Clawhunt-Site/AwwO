import { api as requestApi, SaaSApiError, tenantPath } from './api';
import type { KnowledgeDocument } from './knowledgeApi';

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController(); const parent = init.signal; let timedOut = false;
  const abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try { return await requestApi<T>(path, { ...init, signal: controller.signal }); }
  catch (error) {
    if (timedOut && !parent?.aborted) throw new SaaSApiError(408, 'openmaus_request_timeout', 'OpenMaus 请求超过 15 秒。请读取状态确认结果；未自动重新发送任务。');
    throw error;
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}

export interface OpenMausStatus { configured: boolean; available: boolean; status: 'disabled' | 'connected' | 'unavailable'; message: string }
export interface OpenMausTask { id: string; title: string; busy: boolean; active: boolean }
export interface OpenMausBot { id: string; name: string; title: string; description: string; busy: boolean; activity: string; activeTaskId: string; tasks: OpenMausTask[] }
export interface OpenMausMessage { id: string; role: string; kind: string; text: string; at: string; queued: boolean; needsInput: boolean; hasImage: boolean; truncated: boolean }
export interface OpenMausMessages { botId: string; taskId: string; messages: OpenMausMessage[]; hasMore: boolean }
export interface OpenMausTaskResult { operationId: string; botId: string; taskId: string; status: 'sent' | 'unknown' | 'rejected' | 'sending'; message: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string';
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
/** OpenMaus stores Message.at as Date.now() milliseconds. Keep rendering on one ISO contract. */
function messageTimestamp(value: unknown): string | null {
  let milliseconds: number;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    milliseconds = value;
  } else if (typeof value === 'string') {
    const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!fields) return null;
    const [year, month, day, hour, minute, second] = fields.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
    milliseconds = Date.parse(value);
  } else return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const base = (tenantId: string) => tenantPath(tenantId, '/openmaus');
const post = (value: unknown, signal: AbortSignal) => ({ method: 'POST', body: JSON.stringify(value), signal });
function checked<T>(value: unknown, validate: (item: unknown) => item is T): T {
  if (!validate(value)) throw new SaaSApiError(502, 'invalid_openmaus_response', 'OpenMaus 返回的数据不完整，请重新读取。');
  return value;
}
function taskResult(value: unknown): value is OpenMausTaskResult {
  return object(value) && str(value.operationId) && str(value.botId) && str(value.taskId) && ['sent', 'unknown', 'rejected', 'sending'].includes(String(value.status)) && str(value.message);
}
export async function readOpenMausStatus(tenantId: string, signal: AbortSignal) {
  return checked(await api<unknown>(`${base(tenantId)}/status`, { signal }), (item): item is OpenMausStatus => object(item) && bool(item.configured) && bool(item.available) && ['disabled', 'connected', 'unavailable'].includes(String(item.status)) && str(item.message));
}
export async function readOpenMausBots(tenantId: string, signal: AbortSignal): Promise<OpenMausBot[]> {
  const value = checked(await api<unknown>(`${base(tenantId)}/bots`, { signal }), (item): item is { bots: OpenMausBot[] } => object(item) && Array.isArray(item.bots) && item.bots.every(bot => object(bot)
    && ['id', 'name', 'title', 'description', 'activity', 'activeTaskId'].every(key => str(bot[key])) && bool(bot.busy) && Array.isArray(bot.tasks)
    && bot.tasks.every(task => object(task) && str(task.id) && str(task.title) && bool(task.busy) && bool(task.active))));
  return value.bots;
}
export async function readOpenMausMessages(tenantId: string, botId: string, taskId: string, signal: AbortSignal) {
  type WireMessages = Omit<OpenMausMessages, 'messages'> & { messages: (Omit<OpenMausMessage, 'at'> & { at: number | string })[] };
  const value = checked(await api<unknown>(`${base(tenantId)}/bots/${encodeURIComponent(botId)}/messages?taskId=${encodeURIComponent(taskId)}`, { signal }), (item): item is WireMessages => object(item) && item.botId === botId && item.taskId === taskId && bool(item.hasMore)
    && Array.isArray(item.messages) && item.messages.every(message => object(message) && ['id', 'role', 'kind', 'text'].every(key => str(message[key])) && messageTimestamp(message.at) !== null && ['queued', 'needsInput', 'hasImage', 'truncated'].every(key => bool(message[key]))));
  return { ...value, messages: value.messages.map(message => ({ ...message, at: messageTimestamp(message.at)! })) } satisfies OpenMausMessages;
}
export async function sendOpenMausTask(tenantId: string, input: { botId: string; taskId: string; text: string; operationId: string }, signal: AbortSignal) {
  return checked(await api<unknown>(`${base(tenantId)}/tasks`, post(input, signal)), (item): item is OpenMausTaskResult => taskResult(item) && item.botId === input.botId && item.taskId === input.taskId && item.operationId === input.operationId);
}
export async function readOpenMausTask(tenantId: string, operationId: string, signal: AbortSignal) {
  return checked(await api<unknown>(`${base(tenantId)}/tasks/${encodeURIComponent(operationId)}`, { signal }), (item): item is OpenMausTaskResult => taskResult(item) && item.operationId === operationId);
}
export async function importOpenMausMessage(tenantId: string, input: { botId: string; taskId: string; messageId: string; title: string; operationId: string }, signal: AbortSignal) {
  return checked(await api<unknown>(`${base(tenantId)}/imports`, post(input, signal)), (item): item is KnowledgeDocument => object(item) && str(item.id) && item.kind === 'source' && str(item.title) && str(item.content) && str(item.currentRevisionId) && str(item.contentHash) && typeof item.version === 'number' && item.version > 0 && object(item.provenance) && str(item.sourceUri) && str(item.createdAt) && str(item.updatedAt));
}
