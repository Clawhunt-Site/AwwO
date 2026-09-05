import { useRef, useState } from "react";
import type { DashboardRunActivityDay, HeartbeatRun } from "@paperclipai/shared";
import { useLocalizedText } from "@/i18n/localized";

/* ---- Utilities ---- */

export function getLast14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---- Sub-components ---- */

function DateLabels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-[3px] mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {(i === 0 || i === 6 || i === 13) ? (
            <span className="text-[9px] text-muted-foreground tabular-nums">{formatDayLabel(day)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {subtitle && <span className="text-[10px] text-muted-foreground/60">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

/* ---- Chart Components ---- */

type RunChartProps =
  | { activity?: DashboardRunActivityDay[] | null; runs?: never }
  | { runs?: HeartbeatRun[] | null; activity?: never };

function aggregateRuns(runs: readonly HeartbeatRun[] = []): DashboardRunActivityDay[] {
  const days = getLast14Days();
  const grouped = new Map<string, DashboardRunActivityDay>();
  for (const day of days) grouped.set(day, { date: day, succeeded: 0, failed: 0, other: 0, total: 0 });
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") entry.succeeded++;
    else if (run.status === "failed" || run.status === "timed_out") entry.failed++;
    else entry.other++;
    entry.total++;
  }
  return Array.from(grouped.values());
}

function resolveRunActivity(props: RunChartProps): DashboardRunActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.runs)) return aggregateRuns(props.runs);
  return [];
}

export function RunActivityChart(props: RunChartProps) {
  const localize = useLocalizedText();
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = activity.some(v => v.total > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">{localize({ en: "No runs yet", zh: "暂无运行" })}</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? { date: day, succeeded: 0, failed: 0, other: 0, total: 0 };
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} ${localize({ en: "runs", zh: "次运行" })}`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.succeeded > 0 && <div className="bg-emerald-500" style={{ flex: entry.succeeded }} />}
                  {entry.failed > 0 && <div className="bg-red-500" style={{ flex: entry.failed }} />}
                  {entry.other > 0 && <div className="bg-neutral-500" style={{ flex: entry.other }} />}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </div>
  );
}

const priorityColors: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#6b7280",
};

const priorityOrder = ["critical", "high", "medium", "low"] as const;

export function PriorityChart({ issues }: { issues: { priority: string; createdAt: Date }[] }) {
  const localize = useLocalizedText();
  const days = getLast14Days();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, { critical: 0, high: 0, medium: 0, low: 0 });
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (issue.priority in entry) entry[issue.priority]++;
  }

  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = Array.from(grouped.values()).some(v => Object.values(v).reduce((a, b) => a + b, 0) > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">{localize({ en: "No tasks", zh: "暂无任务" })}</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} ${localize({ en: "tasks", zh: "个任务" })}`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {priorityOrder.map(p => entry[p] > 0 ? (
                    <div key={p} style={{ flex: entry[p], backgroundColor: priorityColors[p] }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={priorityOrder.map((p) => ({
        color: priorityColors[p],
        label: ({
          critical: localize({ en: "Critical", zh: "紧急" }),
          high: localize({ en: "High", zh: "高" }),
          medium: localize({ en: "Medium", zh: "中" }),
          low: localize({ en: "Low", zh: "低" }),
        })[p],
      }))} />
    </div>
  );
}

const statusColors: Record<string, string> = {
  todo: "#3b82f6",
  in_progress: "#8b5cf6",
  in_review: "#a855f7",
  done: "#10b981",
  blocked: "#ef4444",
  cancelled: "#6b7280",
  backlog: "#64748b",
};

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
  backlog: "Backlog",
};

export function IssueStatusChart({ issues }: { issues: { status: string; createdAt: Date }[] }) {
  const localize = useLocalizedText();
  const days = getLast14Days();
  const allStatuses = new Set<string>();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, {});
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    entry[issue.status] = (entry[issue.status] ?? 0) + 1;
    allStatuses.add(issue.status);
  }

  const statusOrder = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"].filter(s => allStatuses.has(s));
  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = allStatuses.size > 0;

  if (!hasData) return <p className="text-xs text-muted-foreground">{localize({ en: "No tasks", zh: "暂无任务" })}</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} ${localize({ en: "tasks", zh: "个任务" })}`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {statusOrder.map(s => (entry[s] ?? 0) > 0 ? (
                    <div key={s} style={{ flex: entry[s], backgroundColor: statusColors[s] ?? "#6b7280" }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={statusOrder.map((s) => ({
        color: statusColors[s] ?? "#6b7280",
        label: ({
          todo: localize({ en: "To Do", zh: "待办" }),
          in_progress: localize({ en: "In Progress", zh: "进行中" }),
          in_review: localize({ en: "In Review", zh: "评审中" }),
          done: localize({ en: "Done", zh: "完成" }),
          blocked: localize({ en: "Blocked", zh: "阻塞" }),
          cancelled: localize({ en: "Cancelled", zh: "已取消" }),
          backlog: localize({ en: "Backlog", zh: "待排期" }),
        })[s] ?? statusLabels[s] ?? s,
      }))} />
    </div>
  );
}

export function SuccessRateChart(props: RunChartProps) {
  const localize = useLocalizedText();
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const hasData = activity.some(v => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">{localize({ en: "No runs yet", zh: "暂无运行" })}</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? { date: day, succeeded: 0, failed: 0, other: 0, total: 0 };
          const rate = entry.total > 0 ? entry.succeeded / entry.total : 0;
          const color = entry.total === 0 ? undefined : rate >= 0.8 ? "#10b981" : rate >= 0.5 ? "#eab308" : "#ef4444";
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${entry.total > 0 ? Math.round(rate * 100) : 0}% (${entry.succeeded}/${entry.total})`}>
              {entry.total > 0 ? (
                <div style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: color }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </div>
  );
}

/* ---- Dashboard-only: horizontal segment distribution bars ---- */

// Used only by Dashboard's compact chart section (not AgentDetail — AgentDetail
// keeps PriorityChart / IssueStatusChart / SuccessRateChart unchanged).

function SegmentDistributionBar({
  buckets,
  emptyText,
}: {
  buckets: { label: string; count: number; color: string }[];
  emptyText: string;
}) {
  const filled = buckets.filter((b) => b.count > 0);
  if (filled.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  }
  const total = filled.reduce((a, b) => a + b.count, 0);
  return (
    <div className="space-y-2.5">
      <div
        className="flex h-3 overflow-hidden rounded-full"
        title={filled.map((b) => `${b.label}: ${b.count}`).join(" · ")}
      >
        {filled.map((b) => (
          <div key={b.label} style={{ flex: b.count, backgroundColor: b.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {filled.map((b) => (
          <span key={b.label} className="flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: b.color }} />
            {b.label}
            <span className="font-medium text-foreground/70">{b.count}</span>
            <span className="text-muted-foreground/50">({Math.round((b.count / total) * 100)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function PrioritySegmentChart({ issues }: { issues: { priority: string }[] }) {
  const localize = useLocalizedText();
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    if (issue.priority in counts) counts[issue.priority]++;
  }
  return (
    <SegmentDistributionBar
      emptyText={localize({ en: "No tasks", zh: "暂无任务" })}
      buckets={[
        { label: localize({ en: "Critical", zh: "紧急" }), count: counts.critical, color: priorityColors.critical },
        { label: localize({ en: "High", zh: "高" }), count: counts.high, color: priorityColors.high },
        { label: localize({ en: "Medium", zh: "中" }), count: counts.medium, color: priorityColors.medium },
        { label: localize({ en: "Low", zh: "低" }), count: counts.low, color: priorityColors.low },
      ]}
    />
  );
}

export function StatusSegmentChart({ issues }: { issues: { status: string }[] }) {
  const localize = useLocalizedText();
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.status] = (counts[issue.status] ?? 0) + 1;
  }
  const order = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"];
  const buckets = order
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => ({
      label: ({
        todo: localize({ en: "To Do", zh: "待办" }),
        in_progress: localize({ en: "In Progress", zh: "进行中" }),
        in_review: localize({ en: "In Review", zh: "评审中" }),
        done: localize({ en: "Done", zh: "完成" }),
        blocked: localize({ en: "Blocked", zh: "阻塞" }),
        cancelled: localize({ en: "Cancelled", zh: "已取消" }),
        backlog: localize({ en: "Backlog", zh: "待排期" }),
      })[s] ?? s,
      count: counts[s],
      color: statusColors[s] ?? "#6b7280",
    }));
  return (
    <SegmentDistributionBar
      emptyText={localize({ en: "No tasks", zh: "暂无任务" })}
      buckets={buckets}
    />
  );
}

// #4 Run Pulse — thin horizontal strip of 14 day-cells showing run outcome history.
// Each cell is green (≥80% success), red (≥60% failure), amber (mixed), or muted (no runs).
export function RunPulseStrip({ activity }: { activity: DashboardRunActivityDay[] }) {
  const days = getLast14Days();
  const byDate = new Map(activity.map((d) => [d.date, d]));

  return (
    <div className="flex h-1.5 gap-0.5 rounded-full overflow-hidden" aria-hidden>
      {days.map((day) => {
        const d = byDate.get(day);
        let bg = "bg-muted/30";
        if (d && d.total > 0) {
          const successRate = d.succeeded / d.total;
          const failRate = d.failed / d.total;
          if (successRate >= 0.8) bg = "bg-emerald-500/70";
          else if (failRate >= 0.6) bg = "bg-red-500/70";
          else bg = "bg-amber-500/70";
        }
        return <div key={day} className={`flex-1 ${bg} rounded-[1px]`} />;
      })}
    </div>
  );
}

/* ---- Metric Cards: Sparkline + Breakdown ---- */

function SparklineWithTooltip({
  values,
  labels,
  dates,
  color,
}: {
  values: number[];
  labels: string[];
  dates: string[];
  color: string;
}) {
  const [hovIdx, setHovIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const W = 200, H = 44, PAD = 3;
  const max = Math.max(...values, 1);
  const allZero = values.every((v) => v === 0);

  const pts = values.map((v, i) => ({
    x: values.length < 2 ? W / 2 : (i / (values.length - 1)) * W,
    y: PAD + (H - PAD * 2) * (1 - v / max),
  }));

  const lineD = allZero
    ? `M 0 ${H - PAD} L ${W} ${H - PAD}`
    : pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaD = allZero
    ? null
    : `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${H} L 0 ${H} Z`;

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setHovIdx(Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1)))));
  };

  const hp = hovIdx !== null ? pts[hovIdx] : null;
  // Clamp tooltip so it never clips at the edges
  const ttLeft = hovIdx !== null ? `${Math.max(8, Math.min(92, (hovIdx / (values.length - 1)) * 100)).toFixed(1)}%` : "50%";

  return (
    <div ref={wrapRef} className="relative flex-1 min-h-[80px] cursor-crosshair" onMouseMove={handleMouseMove} onMouseLeave={() => setHovIdx(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" style={{ color }} preserveAspectRatio="none" aria-hidden>
        {areaD && <path d={areaD} fill="currentColor" fillOpacity="0.1" />}
        <path d={lineD} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={allZero ? "0.2" : "1"} />
        {hp && !allZero && (
          <>
            <line x1={hp.x.toFixed(1)} y1={PAD} x2={hp.x.toFixed(1)} y2={H} stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" opacity="0.45" />
            <circle cx={hp.x.toFixed(1)} cy={hp.y.toFixed(1)} r="3.5" fill="currentColor" />
          </>
        )}
      </svg>
      {hovIdx !== null && (
        <div
          className="pointer-events-none absolute -top-10 z-10 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-1 shadow-md"
          style={{ left: ttLeft }}
        >
          <p className="text-[10px] text-muted-foreground">{dates[hovIdx]}</p>
          <p className="text-xs font-medium tabular-nums text-foreground">{labels[hovIdx]}</p>
        </div>
      )}
    </div>
  );
}

export function RunSparklineCard({ activity }: { activity: DashboardRunActivityDay[] }) {
  const localize = useLocalizedText();
  const days = getLast14Days();
  const byDate = new Map(activity.map((d) => [d.date, d]));
  const dailyTotals = days.map((day) => byDate.get(day)?.total ?? 0);
  const total = dailyTotals.reduce((a, b) => a + b, 0);
  const dates = days.map((d) => {
    const dt = new Date(d + "T12:00:00");
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  });
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-4 flex flex-col gap-3">
      <div>
        <p className="text-3xl font-semibold tabular-nums tracking-tight">{total}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {localize({ en: "Runs · last 14 days", zh: "运行次数 · 最近 14 天" })}
        </p>
      </div>
      <SparklineWithTooltip
        values={dailyTotals}
        labels={dailyTotals.map((v) => localize({ en: `${v} run${v === 1 ? "" : "s"}`, zh: `${v} 次` }))}
        dates={dates}
        color="#3b82f6"
      />
    </div>
  );
}

export function SuccessSparklineCard({ activity }: { activity: DashboardRunActivityDay[] }) {
  const localize = useLocalizedText();
  const days = getLast14Days();
  const byDate = new Map(activity.map((d) => [d.date, d]));
  const dailyData = days.map((day) => {
    const d = byDate.get(day);
    return d && d.total > 0 ? { pct: Math.round((d.succeeded / d.total) * 100), hasRuns: true } : { pct: 0, hasRuns: false };
  });
  const totalRuns = activity.reduce((a, d) => a + d.total, 0);
  const totalSucceeded = activity.reduce((a, d) => a + d.succeeded, 0);
  const overallPct = totalRuns > 0 ? Math.round((totalSucceeded / totalRuns) * 100) : null;
  const dates = days.map((d) => {
    const dt = new Date(d + "T12:00:00");
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  });
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-4 flex flex-col gap-3">
      <div>
        <p className="text-3xl font-semibold tabular-nums tracking-tight">
          {overallPct !== null ? `${overallPct}%` : "—"}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {localize({ en: "Success rate · last 14 days", zh: "成功率 · 最近 14 天" })}
        </p>
      </div>
      <SparklineWithTooltip
        values={dailyData.map((d) => d.pct)}
        labels={dailyData.map((d) => d.hasRuns ? `${d.pct}%` : localize({ en: "No runs", zh: "无运行" }))}
        dates={dates}
        color="#10b981"
      />
    </div>
  );
}

const PRIORITY_ROWS = [
  { key: "critical", en: "Critical", zh: "紧急", color: priorityColors.critical },
  { key: "high",     en: "High",     zh: "高",   color: priorityColors.high },
  { key: "medium",   en: "Medium",   zh: "中",   color: priorityColors.medium },
  { key: "low",      en: "Low",      zh: "低",   color: priorityColors.low },
] as const;

export function PriorityBreakdownCard({ issues }: { issues: { priority: string }[] }) {
  const localize = useLocalizedText();
  const total = issues.length;
  const counts = Object.fromEntries(PRIORITY_ROWS.map((r) => [r.key, 0])) as Record<string, number>;
  for (const issue of issues) if (issue.priority in counts) counts[issue.priority]++;
  const rows = PRIORITY_ROWS.filter((r) => counts[r.key] > 0);
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-4 flex flex-col gap-3">
      <div>
        <p className="text-3xl font-semibold tabular-nums tracking-tight">{total}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {localize({ en: "Tasks by priority", zh: "按优先级任务分布" })}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground/40">{localize({ en: "No tasks yet", zh: "暂无任务" })}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => {
            const count = counts[r.key];
            const pct = total > 0 ? Math.round((count / total) * 100) : 0;
            return (
              <div key={r.key} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
                  <span className="flex-1 truncate text-xs text-muted-foreground">{localize({ en: r.en, zh: r.zh })}</span>
                  <span className="shrink-0 text-xs font-medium tabular-nums">{count}</span>
                  <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">{pct}%</span>
                </div>
                <div className="ml-4 h-1 overflow-hidden rounded-full bg-border/40">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: r.color }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STATUS_ROWS = [
  { key: "in_progress", en: "In Progress", zh: "进行中" },
  { key: "todo",        en: "To Do",       zh: "待办" },
  { key: "in_review",   en: "In Review",   zh: "评审中" },
  { key: "blocked",     en: "Blocked",     zh: "阻塞" },
  { key: "done",        en: "Done",        zh: "完成" },
  { key: "backlog",     en: "Backlog",     zh: "待排期" },
  { key: "cancelled",   en: "Cancelled",   zh: "已取消" },
] as const;

export function StatusBreakdownCard({ issues }: { issues: { status: string }[] }) {
  const localize = useLocalizedText();
  const total = issues.length;
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.status] = (counts[issue.status] ?? 0) + 1;
  const rows = STATUS_ROWS.filter((r) => (counts[r.key] ?? 0) > 0);
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-4 flex flex-col gap-3">
      <div>
        <p className="text-3xl font-semibold tabular-nums tracking-tight">{total}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {localize({ en: "Tasks by status", zh: "按状态任务分布" })}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground/40">{localize({ en: "No tasks yet", zh: "暂无任务" })}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => {
            const count = counts[r.key] ?? 0;
            const pct = total > 0 ? Math.round((count / total) * 100) : 0;
            const barColor = statusColors[r.key] ?? "#6b7280";
            return (
              <div key={r.key} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: barColor }} />
                  <span className="flex-1 truncate text-xs text-muted-foreground">{localize({ en: r.en, zh: r.zh })}</span>
                  <span className="shrink-0 text-xs font-medium tabular-nums">{count}</span>
                  <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/50">{pct}%</span>
                </div>
                <div className="ml-4 h-1 overflow-hidden rounded-full bg-border/40">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: barColor }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
