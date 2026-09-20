import { api, SaaSApiError, tenantPath } from './api';
import type { UiLocale } from '../locale';

export type JevQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type JevRequest = { state: unknown; questions: Record<string, JevQuestion> };
export type JevUsage = { input_tokens: number | null; output_tokens: number | null };
export type JevAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export type JevEvaluation = { model: string; answers: Record<string, JevAnswer>; usage: JevUsage };
export type JevStatus = { provider: 'typesafe'; model: string; configured: boolean; enabled: boolean; canEvaluate: boolean;
  questionTypes: string[]; limits: { maxQuestions: number; maxRequestBytes: number }; reason?: string };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const jevMessage = (locale: UiLocale, zh: string, en: string): string => locale === 'zh' ? zh : en;

export function jevFailure(error: unknown, locale: UiLocale): Error {
  if (error instanceof DOMException && error.name === 'AbortError') return error;
  const code = error instanceof SaaSApiError ? error.code : '';
  const messages: Record<string, [string, string]> = {
    typesafe_disabled: ['此工作区尚未启用 Jev 编排。', 'Jev planning is not enabled for this workspace.'],
    typesafe_unconfigured: ['服务端尚未配置 Jev。', 'Jev is not configured on the server.'],
    typesafe_rate_limited: ['Jev 编排请求已达频率或并发上限，请稍后重试。', 'Jev planning reached its request or concurrency limit. Try again later.'],
    typesafe_timeout: ['Jev 判断超时，本次未修改画布；服务方可能已收到请求。', 'Jev timed out. The canvas was not changed; the provider may have received the request.'],
    typesafe_access_revoked: ['Jev 编排权限已撤销，本次未修改画布。', 'Jev planning permission was revoked. The canvas was not changed.'],
    typesafe_provider_rate_limited: ['Jev 服务暂时限流，请稍后重试。', 'The Jev service is temporarily rate limited.'],
    typesafe_provider_unconfigured: ['Jev 服务凭据不可用，请联系管理员。', 'Jev service credentials are unavailable. Contact the administrator.'],
    typesafe_invalid_response: ['Jev 返回的判断格式无效，本次未修改画布。', 'Jev returned an invalid judgment. The canvas was not changed.'],
    unauthorized: ['请登录后再使用 Jev 编排。', 'Sign in to use Jev planning.'],
    unauthenticated: ['请登录后再使用 Jev 编排。', 'Sign in to use Jev planning.'],
    forbidden: ['当前账号没有 Jev 编排权限。', 'This account cannot use Jev planning.'],
  };
  if (error instanceof SaaSApiError && error.status === 404) return new Error(jevMessage(locale, '此服务尚未提供 Jev 编排判断接口。', 'This service has not deployed the Jev evaluation endpoint.'));
  const message = messages[code];
  return new Error(message ? message[locale === 'zh' ? 0 : 1] : jevMessage(locale, 'Jev 判断服务暂不可用，本次未修改画布。', 'The Jev evaluation service is unavailable. The canvas was not changed.'));
}

export async function readJevStatus(tenantId: string, signal: AbortSignal | undefined, locale: UiLocale): Promise<JevStatus> {
  let raw: unknown;
  try { raw = await api(tenantPath(tenantId, '/typesafe'), { signal }); } catch (error) { throw jevFailure(error, locale); }
  if (!object(raw) || raw.provider !== 'typesafe' || typeof raw.model !== 'string' || !raw.model.trim()
    || typeof raw.configured !== 'boolean' || typeof raw.enabled !== 'boolean' || typeof raw.canEvaluate !== 'boolean'
    || !Array.isArray(raw.questionTypes) || !raw.questionTypes.every(type => typeof type === 'string')
    || !object(raw.limits) || !tokens(raw.limits.maxQuestions) || raw.limits.maxQuestions < 1
    || !tokens(raw.limits.maxRequestBytes) || raw.limits.maxRequestBytes < 1) {
    throw new Error(jevMessage(locale, 'Jev 状态数据无效。', 'Invalid Jev status response.'));
  }
  return raw as JevStatus;
}

/** The server chooses the model and destination. No browser credential, URL, retry or model override. */
export async function evaluateJev(tenantId: string, request: JevRequest, status: JevStatus, signal: AbortSignal, locale: UiLocale): Promise<JevEvaluation> {
  signal.throwIfAborted();
  const entries = Object.entries(request.questions);
  const body = JSON.stringify(request);
  if (entries.length < 1 || entries.length > Math.min(16, status.limits.maxQuestions)
    || new TextEncoder().encode(body).length > Math.min(65536, status.limits.maxRequestBytes)
    || entries.some(([id, question]) => !id || question.type !== 'choice' || !question.instructions.trim()
      || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255)) {
    throw new Error(jevMessage(locale, '本次编排超出 Jev 问题或输入大小限制，请缩短目标或候选范围。', 'This plan exceeds the Jev question or input limit. Shorten the goal or candidate set.'));
  }
  let raw: unknown;
  try { raw = await api(tenantPath(tenantId, '/typesafe/evaluations'), { method: 'POST', body, signal }); }
  catch (error) { if (signal.aborted) signal.throwIfAborted(); throw jevFailure(error, locale); }
  signal.throwIfAborted();
  const invalid = () => new Error(jevMessage(locale, 'Jev 返回的判断格式无效，本次未修改画布。', 'Jev returned an invalid judgment. The canvas was not changed.'));
  if (!object(raw) || typeof raw.model !== 'string' || !raw.model.trim() || !object(raw.answers)
    || Object.keys(raw.answers).length !== entries.length || !object(raw.usage)
    || (raw.usage.input_tokens != null && !tokens(raw.usage.input_tokens))
    || (raw.usage.output_tokens != null && !tokens(raw.usage.output_tokens))) throw invalid();
  const answers: Record<string, JevAnswer> = {};
  for (const [id, question] of entries) {
    const answer = raw.answers[id];
    const keys = Object.keys(question.criteria);
    if (!object(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)
      || !probability(answer.confidence) || !object(answer.probabilities) || Object.keys(answer.probabilities).length !== keys.length
      || !keys.every(key => Object.hasOwn(answer.probabilities as object, key) && probability((answer.probabilities as Record<string, unknown>)[key]))
      || Math.abs(Object.values(answer.probabilities).reduce<number>((sum, value) => sum + Number(value), 0) - 1) > 0.05) throw invalid();
    answers[id] = { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: { ...answer.probabilities } as Record<string, number> };
  }
  return { model: raw.model, answers, usage: { input_tokens: raw.usage.input_tokens as number ?? null, output_tokens: raw.usage.output_tokens as number ?? null } };
}
