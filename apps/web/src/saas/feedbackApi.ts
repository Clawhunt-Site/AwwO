// The feedback assistant's three calls (backend feedback.go). They go out with fetch rather than api(): a report is for
// the moment the site is going wrong, a session that just ended included, which api() would stop before it is sent.
import { API_BASE } from './api';
import type { FeedbackContext } from './feedbackDiagnostics';

/** Where reports go when the site cannot send them itself (shown, and used for an email the person sends). */
export const FEEDBACK_FALLBACK_EMAIL = 'support@clawhunt.store';

/** Where a tab keeps a conversation in progress (FeedbackAssistant.tsx). */
export const FEEDBACK_STORE = 'awwo.feedback.v1';

/** Forgets the tab's conversation in progress: on sign-out, so the next person at this computer never sees it. */
export function forgetFeedbackConversation(): void {
  try { sessionStorage.removeItem(FEEDBACK_STORE); } catch { /* storage off: nothing was kept */ }
}

export type FeedbackTurn = { role: 'user' | 'assistant'; text: string };
export type FeedbackReport = {
  title: string; category: 'bug' | 'feature' | 'question' | 'other'; severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string; steps: string[]; expected: string; actual: string;
};
export type FeedbackStatus = { available: boolean; assistant: boolean; signedIn: boolean; email?: string; supportEmail: string };
export type FeedbackAnswer = { reply: string; ready: boolean; report?: FeedbackReport };
export type FeedbackPicture = { type: 'image/jpeg' | 'image/png'; data: string };

export class FeedbackError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new FeedbackError(0, 'network', 'The network did not answer');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new FeedbackError(response.status, payload?.error?.code || 'request_failed', payload?.error?.message || `Request failed (${response.status})`);
  return payload as T;
}

export function feedbackStatus(signal?: AbortSignal): Promise<FeedbackStatus> {
  return call<FeedbackStatus>('/feedback', { signal });
}

export function askFeedbackAssistant(messages: FeedbackTurn[], locale: 'zh' | 'en', page: string, signal?: AbortSignal): Promise<FeedbackAnswer> {
  return call<FeedbackAnswer>('/feedback/assistant', { method: 'POST', body: JSON.stringify({ messages, locale, page }), signal });
}

export function sendFeedback(report: {
  messages: FeedbackTurn[]; report: FeedbackReport | null; contact: string; locale: 'zh' | 'en'; context: FeedbackContext; attachments: FeedbackPicture[];
}): Promise<{ id: string; duplicate?: boolean }> {
  return call('/feedback', { method: 'POST', body: JSON.stringify(report) });
}

/** The report as plain text, for an email the person sends themselves or the clipboard, when the site cannot send it. */
export function feedbackText(messages: FeedbackTurn[], report: FeedbackReport | null, context: FeedbackContext): string {
  const lines: string[] = [];
  if (report) {
    lines.push(report.title, '', report.summary);
    if (report.steps.length) lines.push('', ...report.steps.map((step, i) => `${i + 1}. ${step}`));
    if (report.expected) lines.push('', `Expected: ${report.expected}`);
    if (report.actual) lines.push(`Actual: ${report.actual}`);
    lines.push('');
  }
  for (const turn of messages) if (turn.role === 'user') lines.push(turn.text);
  lines.push('', `Page: ${context.url}`, `Browser: ${context.userAgent}`, `Build: ${context.webBuild}`);
  return lines.join('\n');
}

/** A mailto: link for that text, held to what mail clients take in one link. */
export function feedbackMailto(address: string, subject: string, text: string): string {
  const body = text.length > 1600 ? `${text.slice(0, 1600)}…` : text;
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
