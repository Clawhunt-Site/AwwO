import { timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const LIMITS = { request: 512 * 1024, response: 4 * 1024 * 1024, artifact: 2 * 1024 * 1024, artifacts: 8 * 1024 * 1024, event: 3 * 1024 * 1024, events: 16 * 1024 * 1024 } as const;
export type RunRequest = { runId: string; tenantId: string; sessionId: string; prompt: string; instructions: string; modelProxyURL: string; modelProxyToken: string; timeoutMs: number; maxModelCalls: number };
export type ApprovalAnswer = { requestId: string; behavior: 'allow' | 'deny'; message?: string };
export type WorkerEvent = { type: string; [key: string]: unknown };
export const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export class WorkerError extends Error { code: string; status: number; constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; } }
export function safeEqual(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
export function textField(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value) > max) throw new WorkerError('INVALID_REQUEST');
  return value;
}
export function parseRun(value: unknown, proxyOrigins: Set<string>): RunRequest {
  if (!record(value)) throw new WorkerError('INVALID_REQUEST');
  const runId = textField(value.runId, 256), tenantId = textField(value.tenantId, 256), sessionId = textField(value.sessionId, 256);
  if ([runId, tenantId, sessionId].some(id => /[\x00-\x1f\x7f]/.test(id))) throw new WorkerError('INVALID_REQUEST');
  const prompt = textField(value.prompt, 256 * 1024), instructions = textField(value.instructions ?? '', 128 * 1024, true);
  const modelProxyURL = textField(value.modelProxyURL, 2048), modelProxyToken = textField(value.modelProxyToken, 4096);
  let url: URL; try { url = new URL(modelProxyURL); } catch { throw new WorkerError('INVALID_MODEL_PROXY'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!proxyOrigins.has(url.origin) && !(proxyOrigins.size === 0 && local))) throw new WorkerError('INVALID_MODEL_PROXY');
  if (/\r|\n/.test(modelProxyToken) || modelProxyToken.length < 16) throw new WorkerError('INVALID_MODEL_PROXY');
  const timeoutMs = value.timeoutMs ?? 300_000, maxModelCalls = value.maxModelCalls ?? 16;
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 900_000 || !Number.isSafeInteger(maxModelCalls) || Number(maxModelCalls) < 1 || Number(maxModelCalls) > 32) throw new WorkerError('INVALID_BUDGET');
  return { runId, tenantId, sessionId, prompt, instructions, modelProxyURL, modelProxyToken, timeoutMs: Number(timeoutMs), maxModelCalls: Number(maxModelCalls) };
}
export function parseAnswer(value: unknown): ApprovalAnswer {
  if (!record(value) || !['allow', 'deny'].includes(String(value.behavior))) throw new WorkerError('INVALID_ANSWER');
  return { requestId: textField(value.requestId, 256), behavior: value.behavior as 'allow' | 'deny', ...(value.message === undefined ? {} : { message: textField(value.message, 32_768, true) }) };
}
export async function readBytes(source: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of source) { total += chunk.byteLength; if (total > limit) throw new WorkerError('PAYLOAD_TOO_LARGE', 413); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
export async function readJSON(req: IncomingMessage, limit = LIMITS.request): Promise<unknown> {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > limit) throw new WorkerError('PAYLOAD_TOO_LARGE', 413);
  try { return JSON.parse((await readBytes(req, limit)).toString('utf8')); } catch (e) { if (e instanceof WorkerError) throw e; throw new WorkerError('INVALID_JSON'); }
}
export async function responseJSON(response: Response, limit = LIMITS.response): Promise<unknown> {
  if (!response.body) throw new WorkerError('UPSTREAM_EMPTY', 502);
  return JSON.parse((await readBytes(response.body, limit)).toString('utf8'));
}
export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
}
export function boundedText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  const marker = '\n[truncated]', budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  for (let end = budget; end >= Math.max(0, budget - 4); end--) {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)) + marker, truncated: true }; } catch { /* Avoid splitting a UTF-8 code point. */ }
  }
  return { text: marker, truncated: true };
}
export function safeMessage(value: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
}
