// chatAutomations — apps/web's path into the gateway's chat-automation control plane
// (the v4 "会话即定时任务" backend in apps/gateway). The composer's "设为定时任务" toggle
// creates an automation here; the sidebar badge + management read it back.
//
// Reachability: the gateway's automation API lives at `/api/automations` on the ClawHunt
// Node gateway, reached through the `/gateway-api` proxy prefix (dev: vite proxy →
// gateway; packaged: the front door). The gateway requires a loopback origin + a control
// token; the PROXY injects the token server-side so the browser never holds the secret —
// this module sends no token itself.
//
// READS are fail-soft (null on any failure → caller keeps last-known). WRITES return a
// typed result so the UI reads back the real outcome and never optimistically claims an
// automation was created / will run (matches docs §7: scheduler state is read back, never
// assumed).

// The `/gateway-api` proxy prefix. In a packaged desktop the window stays on
// `tauri://localhost`, so a bare relative path would resolve against that origin and
// never reach the Python front door — prepend the front door's loopback ORIGIN
// (`__SUPERCLAW_PY_ORIGIN__`, injected at runtime once the desktop session base_url is
// known), exactly as paperclipBridge does for its board-data reads. Empty in
// browser/dev, where the same-origin Vite proxy handles `/gateway-api`.
// Exported so other surfaces (e.g. the embedded Fleet Canvas mission planning)
// reach the gateway through the exact same front door + desktop-origin logic.
export function gatewayApiBase(): string {
  const origin = (globalThis as { __SUPERCLAW_PY_ORIGIN__?: unknown }).__SUPERCLAW_PY_ORIGIN__;
  const prefix = typeof origin === 'string' ? origin.replace(/\/+$/, '') : '';
  return `${prefix}/gateway-api`;
}

// Subset of the gateway's ChatAutomation we render. Mirrors apps/gateway types.ts.
export type AutomationApprovalState = 'approved' | 'pending_approval';

export type ChatAutomationView = {
  id: string;
  sessionIssueId: string;
  prompt: string;
  cadence: { kind: 'interval'; intervalSec: number } | { kind: 'cron'; expression: string };
  timezone: string;
  enabled: boolean;
  approvalState: AutomationApprovalState;
  nextRunAt: number;
  lastFiredAt: number | null;
  lastOutcomeOk: boolean | null;
  lastError: string | null;
};

export type AutomationWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; error: string };

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${gatewayApiBase()}${path}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function send<T>(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<AutomationWriteResult<T>> {
  try {
    const res = await fetch(`${gatewayApiBase()}${path}`, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = (await res.json()) as { error?: unknown };
        detail = typeof parsed?.error === 'string' ? parsed.error : '';
      } catch {
        detail = '';
      }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
    }
    // 204 (delete) has no body.
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : 'network error' };
  }
}

// List the automations bound to one chat session (its scheduled tasks). Fail-soft.
export async function listSessionAutomations(sessionIssueId: string): Promise<ChatAutomationView[] | null> {
  const data = await get<ChatAutomationView[]>(
    `/automations?sessionIssueId=${encodeURIComponent(sessionIssueId)}`,
  );
  return Array.isArray(data) ? data : data === null ? null : [];
}

// The set of chat-session ids that have at least one automation — for the sidebar
// "automated" badge. One fetch covers the whole list (no per-session N+1). Fail-soft.
export async function listAutomationSessionIds(): Promise<Set<string> | null> {
  const data = await get<ChatAutomationView[]>('/automations');
  if (!Array.isArray(data)) return null;
  return new Set(data.map((a) => a.sessionIssueId));
}

export type CreateSessionAutomationInput = {
  sessionIssueId: string;
  prompt: string;
  intervalSec: number;
  timezone?: string;
};

// Create an automation for a chat session. It is created `pending_approval` (fail-closed)
// — the caller must surface that it will NOT run until approved.
export async function createSessionAutomation(
  input: CreateSessionAutomationInput,
): Promise<AutomationWriteResult<ChatAutomationView>> {
  return send<ChatAutomationView>('/automations', 'POST', input);
}

// Approve a pending automation (the human gate) so the scheduler may fire it.
export async function approveAutomation(id: string): Promise<AutomationWriteResult<ChatAutomationView>> {
  return send<ChatAutomationView>(`/automations/${encodeURIComponent(id)}/approve`, 'POST');
}

export async function deleteAutomation(id: string): Promise<AutomationWriteResult<void>> {
  return send<void>(`/automations/${encodeURIComponent(id)}`, 'DELETE');
}
