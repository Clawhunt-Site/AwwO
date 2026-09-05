// Escalation approval gate (Direction 4 P1 D3 — the runtime approval popup).
//
// Completes the in-process escalation loop end-to-end: a B-class tool action that
// needs human approval suspends the run (D1) and is recorded in the durable queue;
// D2 exposes that queue over REST; this component surfaces it as a "text + N buttons"
// popup so a human can SEE and ANSWER it, after which the run resumes.
//
// It is a thin, surface-only view over the SAME kernel queue the CLI drives — it adds
// NO authorization (the kernel's resolve_escalation enforces principal binding,
// single-use grants and fail-closed denial). Dismissing the popup is NOT a decision:
// the escalation stays pending in the authoritative store and is kept visible via the
// badge; only choosing an option calls respond. We POLL the queue (not the run SSE)
// because the run-events stream closes once a run is WAITING_FOR_HUMAN_GATE (see D2).
import { useCallback, useEffect, useRef, useState } from 'react';

import { DialogShell } from './ui/DialogShell';

// Mirrors the kernel escalation_summary projection (no HMAC material on the wire).
export type EscalationOption = { id: string; label: string; style?: string; grants?: boolean };
export type EscalationSummary = {
  request_id: string;
  kind: string;
  status: string;
  prompt_text: string;
  options: EscalationOption[];
  default_option_id: string | null;
  tool_name: string | null;
  reserved_path: string | null;
  run_id: string | null;
  // Carried by the kernel projection; not consumed by the popup yet (kept for a faithful
  // mirror of escalation_summary so future surface work needn't re-derive the shape).
  session_id?: string | null;
  principal?: string | null;
  created_at?: string | null;
  expires_at?: string | null;
  decision?: string | null;
  approver?: string | null;
};

type ReadJson = (
  path: string,
  init?: RequestInit & { headers?: Record<string, string> },
) => Promise<unknown>;

const POLL_MS = 4000;

export function EscalationGate({
  readJson,
  active = true,
  pollMs = POLL_MS,
  t = (text: string) => text,
}: {
  readJson: ReadJson;
  active?: boolean;
  pollMs?: number;
  t?: (text: string) => string;
}) {
  const [pending, setPending] = useState<EscalationSummary[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Hold the latest readJson in a ref so the polling effect/callbacks do NOT depend on its
  // identity. App's readJson is a render-scoped function (new identity every render); if the
  // effect depended on it, every App rerender would tear down + rebuild the interval and
  // immediately re-GET — not a 4s poll. The ref keeps callbacks stable; the effect re-runs
  // only when active/pollMs actually change.
  const readJsonRef = useRef(readJson);
  readJsonRef.current = readJson;
  // Ordering guard. ``refreshSeq`` is a monotonic ISSUE counter; ``appliedSeq`` is the
  // highest seq whose result was actually applied. A result applies iff it is NEWER than
  // the last applied — NOT only if it is the latest issued. Requiring "latest issued"
  // would starve the UI forever whenever latency > pollMs (each response is superseded by
  // a newer in-flight poll before it returns, so nothing ever lands and the approval popup
  // never appears — a liveness bug). Dropping only strictly-older-than-applied responses
  // keeps liveness AND still prevents an out-of-order overwrite/resurrect.
  const refreshSeq = useRef(0);
  const appliedSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const data = (await readJsonRef.current('/api/escalations?status=pending')) as {
        escalations?: EscalationSummary[];
      };
      if (!mounted.current || seq <= appliedSeq.current) return;
      appliedSeq.current = seq;
      const items = Array.isArray(data?.escalations) ? data.escalations : [];
      setPending(items);
      // Drop dismissals for escalations that are no longer pending so the badge count
      // and re-open behavior stay consistent with the authoritative queue.
      setDismissed((prev) => {
        if (prev.size === 0) return prev;
        const live = new Set(items.map((item) => item.request_id));
        const next = new Set<string>();
        for (const id of prev) if (live.has(id)) next.add(id);
        return next.size === prev.size ? prev : next;
      });
      setError(null);
    } catch (err) {
      // Polling failure is non-fatal: keep the last known queue and retry next tick
      // (the durable store is the authority; a transient read does not change it).
      if (mounted.current && seq > appliedSeq.current) setError((err as Error).message);
    }
  }, []);

  // Mount/unmount tracker with EMPTY deps so `mounted` toggles EXACTLY once — decoupled
  // from the polling effect, so a polling-effect re-run can never reset `mounted` back to
  // true while an earlier request is in flight (the stale-overwrite race).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [active, pollMs, refresh]);

  const respond = useCallback(
    async (escalation: EscalationSummary, optionId: string) => {
      setBusy((prev) => new Set(prev).add(escalation.request_id));
      setError(null);
      try {
        await readJsonRef.current(
          `/api/escalations/${encodeURIComponent(escalation.request_id)}/respond`,
          {
            method: 'POST',
            body: JSON.stringify({ decision: optionId }),
          },
        );
        // Optimistically drop it; the next poll reconciles against the authority.
        if (mounted.current) {
          setPending((prev) => prev.filter((item) => item.request_id !== escalation.request_id));
        }
        void refresh();
      } catch (err) {
        if (mounted.current) setError((err as Error).message);
      } finally {
        if (mounted.current) {
          setBusy((prev) => {
            const next = new Set(prev);
            next.delete(escalation.request_id);
            return next;
          });
        }
      }
    },
    [refresh],
  );

  const visible = pending.filter((item) => !dismissed.has(item.request_id));
  const current = visible[0] ?? null;
  const pendingCount = pending.length;

  if (pendingCount === 0) return null;

  return (
    <>
      {pendingCount > 0 && !current ? (
        <button
          type="button"
          className="escalation-gate__badge"
          onClick={() => setDismissed(new Set())}
          aria-label={t('Show pending approvals')}
        >
          {t('Approvals')} <span className="escalation-gate__badge-count">{pendingCount}</span>
        </button>
      ) : null}
      {current ? (
        <DialogShell
          open
          role="alertdialog"
          titleId="escalation-gate-title"
          kicker={t('Approval required')}
          title={current.prompt_text || t('An action needs your approval')}
          subtitle={
            current.tool_name
              ? `${t('Tool')}: ${current.tool_name}${current.reserved_path ? ` → ${current.reserved_path}` : ''}`
              : undefined
          }
          statusPill={pendingCount > 1 ? `${pendingCount} ${t('pending')}` : undefined}
          closeLabel={t('Dismiss (stays pending)')}
          onClose={() => setDismissed((prev) => new Set(prev).add(current.request_id))}
          dismissable
        >
          <div className="escalation-gate">
            {error ? (
              <p className="escalation-gate__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="escalation-gate__options">
              {current.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`escalation-gate__option escalation-gate__option--${option.style ?? 'default'}`}
                  disabled={busy.has(current.request_id)}
                  onClick={() => void respond(current, option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </DialogShell>
      ) : null}
    </>
  );
}
