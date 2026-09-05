// ChatAutomationControl — the v4 "会话即定时任务" UI. Bound to ONE chat session, it lets the
// user turn a task into a recurring background automation for THIS conversation, list the
// session's automations, approve a pending one (the fail-closed human gate), and delete.
// Talks to the gateway via chatAutomations.ts (which proxies to apps/gateway).
//
// Governance is surfaced honestly: a new automation is `pending_approval` and will NOT run
// until approved; the panel never optimistically claims it "will run". The cadence/last
// outcome are read back from the gateway (never assumed).

import { useCallback, useEffect, useState } from 'react';
import {
  approveAutomation,
  createSessionAutomation,
  deleteAutomation,
  listSessionAutomations,
  type ChatAutomationView,
} from './chatAutomations';

type Locale = 'zh' | 'en';

type Props = {
  sessionIssueId: string | null;
  locale: Locale;
  // Optional initial prompt (e.g. the composer text the user was typing).
  initialPrompt?: string;
  // Notify the host that this session's automations changed (create / approve / delete) so
  // it can refresh cross-surface state — e.g. the sidebar "automated" badge.
  onChanged?: () => void;
};

// Interval presets (seconds). Floor is 60s on the gateway; offer human-friendly cadences.
const INTERVALS: Array<{ sec: number; zh: string; en: string }> = [
  { sec: 3600, zh: '每小时', en: 'Hourly' },
  { sec: 21600, zh: '每 6 小时', en: 'Every 6 hours' },
  { sec: 86400, zh: '每天', en: 'Daily' },
  { sec: 604800, zh: '每周', en: 'Weekly' },
];

const COPY: Record<Locale, Record<string, string>> = {
  en: {
    title: 'Scheduled tasks',
    lede: 'Turn a task into a recurring background automation for this conversation.',
    promptPlaceholder: 'What should run on a schedule?',
    cadence: 'Cadence',
    create: 'Create scheduled task',
    creating: 'Creating…',
    pendingNote: 'Created — it will NOT run until you approve it.',
    none: 'No scheduled tasks for this conversation yet.',
    loading: 'Loading…',
    approve: 'Approve',
    approving: 'Approving…',
    del: 'Delete',
    pending: 'Pending approval',
    approved: 'Active',
    nextRun: 'Next run',
    lastFailed: 'Last run failed',
    noSession: 'Open a conversation to schedule a task.',
    createErr: 'Could not create',
    loadErr: 'Could not reach the automation service. Showing last known.',
  },
  zh: {
    title: '定时任务',
    lede: '把一个任务变成本对话的后台定时自动化。',
    promptPlaceholder: '要定时执行什么？',
    cadence: '频率',
    create: '设为定时任务',
    creating: '创建中…',
    pendingNote: '已创建 —— 在你批准前不会运行。',
    none: '本对话暂无定时任务。',
    loading: '加载中…',
    approve: '批准',
    approving: '批准中…',
    del: '删除',
    pending: '待批准',
    approved: '已启用',
    nextRun: '下次运行',
    lastFailed: '上次运行失败',
    noSession: '打开一个对话以设置定时任务。',
    createErr: '创建失败',
    loadErr: '无法连接定时任务服务，显示上次已知。',
  },
};

function nextRunLabel(a: ChatAutomationView, c: Record<string, string>): string | null {
  if (a.approvalState !== 'approved' || !a.enabled) return null;
  const when = new Date(a.nextRunAt);
  if (Number.isNaN(when.getTime())) return null;
  return `${c.nextRun}: ${when.toLocaleString()}`;
}

export function ChatAutomationControl({ sessionIssueId, locale, initialPrompt, onChanged }: Props) {
  const c = COPY[locale] ?? COPY.en;
  const [items, setItems] = useState<ChatAutomationView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [intervalSec, setIntervalSec] = useState(86400);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  // Reset the draft to the (new) initial prompt when the bound session changes, so a stale
  // prompt from a previous conversation is not carried over.
  useEffect(() => {
    setPrompt(initialPrompt ?? '');
    setNotice(null);
  }, [sessionIssueId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    if (!sessionIssueId) {
      setItems([]);
      return;
    }
    const data = await listSessionAutomations(sessionIssueId);
    if (data === null) {
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setItems(data);
  }, [sessionIssueId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || !sessionIssueId || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await createSessionAutomation({ sessionIssueId, prompt: trimmed, intervalSec });
    setBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: `${c.createErr}: ${result.error}` });
      return;
    }
    setPrompt('');
    await refresh();
    onChanged?.();
    setNotice({ kind: 'ok', text: c.pendingNote });
  }, [prompt, sessionIssueId, intervalSec, busy, refresh, onChanged, c]);

  const onApprove = useCallback(
    async (id: string) => {
      if (actingId) return;
      setActingId(id);
      const result = await approveAutomation(id);
      setActingId(null);
      if (result.ok) {
        await refresh();
        onChanged?.();
      } else setNotice({ kind: 'error', text: result.error });
    },
    [actingId, refresh, onChanged],
  );

  const onDelete = useCallback(
    async (id: string) => {
      if (actingId) return;
      setActingId(id);
      const result = await deleteAutomation(id);
      setActingId(null);
      if (result.ok) {
        await refresh();
        onChanged?.();
      } else setNotice({ kind: 'error', text: result.error });
    },
    [actingId, refresh, onChanged],
  );

  if (!sessionIssueId) {
    return (
      <section className="chat-automation" aria-label={c.title}>
        <p className="chat-automation-empty">{c.noSession}</p>
      </section>
    );
  }

  return (
    <section className="chat-automation" aria-label={c.title}>
      <header className="chat-automation-head">
        <h3>{c.title}</h3>
        <p className="chat-automation-lede">{c.lede}</p>
      </header>

      <div className="chat-automation-create">
        <textarea
          className="chat-automation-input"
          value={prompt}
          placeholder={c.promptPlaceholder}
          rows={2}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
        />
        <div className="chat-automation-create-row">
          <label className="chat-automation-cadence">
            <span>{c.cadence}</span>
            <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} disabled={busy}>
              {INTERVALS.map((iv) => (
                <option key={iv.sec} value={iv.sec}>
                  {locale === 'zh' ? iv.zh : iv.en}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="chat-automation-btn primary"
            onClick={() => void onCreate()}
            disabled={busy || !prompt.trim()}
          >
            {busy ? c.creating : c.create}
          </button>
        </div>
      </div>

      {notice ? (
        <p className={`chat-automation-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      ) : null}
      {loadFailed ? (
        <p className="chat-automation-notice error" role="alert">
          {c.loadErr}
        </p>
      ) : null}

      {items === null ? (
        <p className="chat-automation-empty">{c.loading}</p>
      ) : items.length === 0 ? (
        <p className="chat-automation-empty">{c.none}</p>
      ) : (
        <ul className="chat-automation-list">
          {items.map((a) => {
            const next = nextRunLabel(a, c);
            return (
              <li key={a.id} className="chat-automation-row">
                <div className="chat-automation-row-main">
                  <span className="chat-automation-prompt">{a.prompt}</span>
                  <span className={`chat-automation-chip ${a.approvalState}`}>
                    {a.approvalState === 'approved' ? c.approved : c.pending}
                  </span>
                  {next ? <span className="chat-automation-next">{next}</span> : null}
                  {a.lastOutcomeOk === false ? (
                    <span className="chat-automation-next error">{`${c.lastFailed}${a.lastError ? `: ${a.lastError}` : ''}`}</span>
                  ) : null}
                </div>
                <div className="chat-automation-row-actions">
                  {a.approvalState === 'pending_approval' ? (
                    <button
                      type="button"
                      className="chat-automation-btn"
                      onClick={() => void onApprove(a.id)}
                      disabled={actingId === a.id}
                    >
                      {actingId === a.id ? c.approving : c.approve}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="chat-automation-btn ghost"
                    onClick={() => void onDelete(a.id)}
                    disabled={actingId === a.id}
                  >
                    {c.del}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
