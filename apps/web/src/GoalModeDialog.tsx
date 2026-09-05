// Goal Mode (目标模式) confirmation dialog — the "选兵台" (PR6 + PR4 multi-agent).
//
// Two phases over one DialogShell:
//   A. plan preview — the role-slot plan the kernel materialized for this goal.
//   B. roster pick  — a LEAD runtime that covers every slot, plus an optional
//      per-slot override so each serial slot can run on its own agent (PR4 multi-
//      agent role casting). Each selector is a RuntimePicker (铁律6: runtime-linked
//      model/effort, fail-closed, relay packages closed, default never backfilled).
//
// Thin surface over the PR3/PR4 endpoints: the roster it submits (a lead entry plus
// one entry per overridden role) is the execution source of truth the kernel runs on.
import { useEffect, useRef, useState } from 'react';
import { DialogShell } from './ui/DialogShell';
import { Dropdown } from './ui/Dropdown';
import { RuntimePicker, type RuntimeValue } from './RuntimePicker';

// The plan topologies a surface may pick. LINEAR is serial; the others run workers
// concurrently and so REQUIRE a token budget (the kernel's hard gate) — the budget is
// the admission ceiling that stops concurrent branches from overspending it.
const LINEAR = 'linear';
const CONCURRENT_TOPOLOGIES = new Set(['implement_fanout', 'explore_fanout', 'review_consensus']);
const TOPOLOGY_OPTIONS = [
  { value: 'linear', zh: '线性（单 agent 串行）', en: 'Linear (single agent, serial)' },
  { value: 'implement_fanout', zh: '实现并行（2 个 implement 分支）', en: 'Implement fan-out (2 implement branches)' },
  { value: 'explore_fanout', zh: '探索并行（2 个 explore 分支）', en: 'Explore fan-out (2 explore branches)' },
  { value: 'review_consensus', zh: '评审共识（3 个 review 分支投票）', en: 'Review consensus (3 review branches)' },
] as const;

export type GoalRecord = {
  spec: { goal_id: string; title: string; description?: string };
  status: string;
  revision: number;
  plan_hash: string | null;
  plan: { topology?: string; slots?: Array<{ role: string; title: string }> } | null;
};

type ReadJson = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;

const COPY = {
  zh: {
    title: '目标模式',
    close: '关闭',
    strategyHeading: '执行策略',
    budget: 'Token 预算',
    budgetHint: '并行/共识策略必填——并发分支的预算上限（绝不超支）',
    planHeading: '任务计划',
    leadHeading: '默认执行 agent（lead，覆盖所有未单独指派的任务）',
    perSlotHeading: '按任务指派 agent（可选）',
    confirm: '确认并执行',
    confirmNoStart: '仅确认（暂不执行）',
    replan: '重新规划',
    cancel: '取消',
    error: '操作失败',
    loadFailed: '无法加载可用 runtime；请稍后重试',
  },
  en: {
    title: 'Goal mode',
    close: 'Close',
    strategyHeading: 'Execution strategy',
    budget: 'Token budget',
    budgetHint: 'Required for a parallel/consensus strategy — the admission ceiling concurrent branches cannot overspend',
    planHeading: 'Task plan',
    leadHeading: 'Default agent (lead — covers every slot not assigned below)',
    perSlotHeading: 'Assign an agent per task (optional)',
    confirm: 'Confirm & run',
    confirmNoStart: 'Confirm only',
    replan: 'Re-plan',
    cancel: 'Cancel',
    error: 'Action failed',
    loadFailed: 'Could not load available runtimes; try again',
  },
} as const;

const EMPTY: RuntimeValue = { backend: '', model: '', effort: '' };

function planRoles(record: GoalRecord | null): string[] {
  const seen: string[] = [];
  for (const slot of record?.plan?.slots ?? []) {
    if (slot.role && !seen.includes(slot.role)) seen.push(slot.role);
  }
  return seen;
}

export function GoalModeDialog({
  open,
  record,
  readJson,
  lang = 'zh',
  onClose,
  onConfirmed,
  onReplanned,
}: {
  open: boolean;
  record: GoalRecord | null;
  readJson: ReadJson;
  lang?: 'zh' | 'en';
  onClose: () => void;
  onConfirmed: (next: GoalRecord) => void;
  onReplanned: (next: GoalRecord) => void;
}) {
  const t = COPY[lang];
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [inventoryReady, setInventoryReady] = useState(false);
  const [lead, setLead] = useState<RuntimeValue>(EMPTY);
  const [perRole, setPerRole] = useState<Record<string, RuntimeValue>>({});
  const [tokenBudget, setTokenBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const readJsonRef = useRef(readJson);
  useEffect(() => {
    readJsonRef.current = readJson;
  });

  // The dialog returns null when closed but its state persists (it is not unmounted),
  // so reset the GOAL-specific selections whenever the goal changes — otherwise a later
  // concurrent goal could inherit the previous goal's budget / per-slot picks and send
  // an unintended token_budget the operator never entered for THIS plan.
  const goalId = record?.spec.goal_id;
  useEffect(() => {
    setTokenBudget('');
    setPerRole({});
  }, [goalId]);

  // Load the live runtime inventory when the dialog opens. Closing resets readiness
  // so a reopen can never confirm against the previous cycle's cached inventory.
  useEffect(() => {
    if (!open) {
      setInventoryReady(false);
      return;
    }
    let stale = false;
    setError('');
    setInventoryReady(false);
    void readJsonRef.current('/api/agents')
      .then((d) => {
        if (stale) return;
        const list = Array.isArray(d?.agents) ? d.agents : [];
        const names = list
          .map((a: { name?: string }) => a?.name)
          .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
        setRuntimes(names);
        setLead((prev) => (prev.backend && names.includes(prev.backend) ? prev : { ...EMPTY, backend: names[0] ?? '' }));
        setInventoryReady(true);
      })
      .catch(() => {
        if (stale) return;
        setRuntimes([]);
        setLead(EMPTY);
        setPerRole({});
        setError(t.loadFailed);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !record) return null;

  const slots = record.plan?.slots ?? [];
  const roles = planRoles(record);
  const topology = record.plan?.topology ?? LINEAR;
  const isConcurrent = CONCURRENT_TOPOLOGIES.has(topology);
  // Number() (not parseInt) so "1e6" parses as 1000000, not 1; a budget must be a
  // positive integer, so "1.5" / "" / "abc" are all rejected (confirm stays gated).
  const budgetNum = Number(tokenBudget.trim());
  const budgetOk = tokenBudget.trim() !== '' && Number.isInteger(budgetNum) && budgetNum > 0;
  // Confirm only when a live lead runtime is selected AND, for a concurrent strategy, a
  // positive token budget is set (mirrors the kernel's hard gate so the surface never
  // lets a user confirm a plan the kernel would reject).
  const canConfirm =
    !busy &&
    inventoryReady &&
    lead.backend !== '' &&
    runtimes.includes(lead.backend) &&
    (!isConcurrent || budgetOk);

  function buildRoster() {
    const entries: Array<Record<string, unknown>> = [
      { source: 'backend', role: null, backend: lead.backend || null, model: lead.model || null, effort: lead.effort || null },
    ];
    for (const role of roles) {
      const rv = perRole[role];
      if (rv && rv.backend) {
        entries.push({ source: 'backend', role, backend: rv.backend, model: rv.model || null, effort: rv.effort || null });
      }
    }
    return entries;
  }

  async function confirm(start: boolean) {
    if (!record) return;
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        revision: record.revision,
        plan_hash: record.plan_hash,
        roster: buildRoster(),
        start,
        dry_run: false,
      };
      if (isConcurrent && budgetOk) body.token_budget = budgetNum;
      const out = await readJsonRef.current(`/api/goals/${encodeURIComponent(record.spec.goal_id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onConfirmed((out?.goal ?? out) as GoalRecord);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
    } finally {
      setBusy(false);
    }
  }

  async function changeTopology(next: string) {
    if (!record || next === topology) return;
    // Switching the execution strategy re-materializes the plan (the kernel /replan
    // path), so the slot list + roles update to the chosen topology before confirm.
    setBusy(true);
    setError('');
    try {
      const updated = await readJsonRef.current(`/api/goals/${encodeURIComponent(record.spec.goal_id)}/replan`, {
        method: 'POST',
        body: JSON.stringify({ revision: record.revision, topology: next }),
      });
      setPerRole({});  // role set may change with the topology
      onReplanned(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
    } finally {
      setBusy(false);
    }
  }

  async function replan() {
    if (!record) return;
    setBusy(true);
    setError('');
    try {
      const next = await readJsonRef.current(`/api/goals/${encodeURIComponent(record.spec.goal_id)}/replan`, {
        method: 'POST',
        body: JSON.stringify({ revision: record.revision }),
      });
      onReplanned(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      open={open}
      variant="default"
      titleId="goal-mode-dialog"
      title={t.title}
      subtitle={record.spec.title}
      closeLabel={t.close}
      dismissable={!busy}
      onClose={onClose}
    >
      <div className="goal-mode-dialog">
        <section className="goal-mode-strategy">
          <h3>{t.strategyHeading}</h3>
          <div className="goal-mode-field">
            <Dropdown
              ariaLabel={t.strategyHeading}
              value={topology}
              options={TOPOLOGY_OPTIONS.map((o) => ({ value: o.value, label: o[lang] }))}
              onChange={changeTopology}
              disabled={busy}
            />
          </div>
          {isConcurrent ? (
            <label className="goal-mode-field">
              <span>{t.budget}</span>
              <input
                className="goal-mode-budget-input"
                type="number"
                min={1}
                inputMode="numeric"
                aria-label={t.budget}
                value={tokenBudget}
                onChange={(e) => setTokenBudget(e.target.value)}
                disabled={busy}
              />
              <span className="goal-mode-note">{t.budgetHint}</span>
            </label>
          ) : null}
        </section>

        <section className="goal-mode-plan" aria-label={t.planHeading}>
          <h3>{t.planHeading}</h3>
          <ol className="goal-mode-slots">
            {slots.map((slot, i) => (
              <li key={i} className="goal-mode-slot">
                <span className="goal-mode-slot__role">{slot.role}</span>
                <span className="goal-mode-slot__title">{slot.title}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="goal-mode-roster">
          <h3>{t.leadHeading}</h3>
          <div className="goal-mode-field">
            <RuntimePicker runtimes={runtimes} value={lead} onChange={setLead} readJson={readJson} lang={lang} disabled={busy} />
          </div>

          {roles.length > 0 ? (
            <>
              <h3>{t.perSlotHeading}</h3>
              {roles.map((role) => (
                <div key={role} className="goal-mode-field goal-mode-slot-assign">
                  <span className="goal-mode-slot__role">{role}</span>
                  <RuntimePicker
                    runtimes={runtimes}
                    value={perRole[role] ?? EMPTY}
                    onChange={(rv) => setPerRole((prev) => ({ ...prev, [role]: rv }))}
                    readJson={readJson}
                    lang={lang}
                    allowInherit
                    disabled={busy}
                  />
                </div>
              ))}
            </>
          ) : null}
        </section>

        {error ? (
          <p className="goal-mode-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="goal-mode-actions">
          <button type="button" className="ghost-button" onClick={replan} disabled={busy}>
            {t.replan}
          </button>
          <span className="goal-mode-actions__spacer" />
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
            {t.cancel}
          </button>
          <button type="button" className="ghost-button" onClick={() => confirm(false)} disabled={!canConfirm}>
            {t.confirmNoStart}
          </button>
          <button type="button" className="primary-button" onClick={() => confirm(true)} disabled={!canConfirm}>
            {t.confirm}
          </button>
        </footer>
      </div>
    </DialogShell>
  );
}
