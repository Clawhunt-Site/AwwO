import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { buildCompanyUserProfileMap, type CompanyUserProfile } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useEmbeddedHost } from "../context/EmbeddedHostContext";
import { useBoardChrome } from "../context/BoardChromeContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { useLocalizedRelativeTime, useLocalizedText } from "@/i18n/localized";
import { cn, formatCents } from "../lib/utils";
import { Bot, LayoutDashboard, PauseCircle } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { RunSparklineCard, SuccessSparklineCard, PriorityBreakdownCard, StatusBreakdownCard, RunPulseStrip } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { ActivityEvent, Agent, Issue } from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

const DASHBOARD_ACTIVITY_LIMIT = 10;

// One cell of the dashboard "telemetry panel" — the four metrics read as a single
// instrument cluster (no per-tile icons; the number leads, the label sits under it
// in a small uppercase caption). Cells are separated by the panel's dividers, so a
// cell carries no border of its own.
function MetricCell({
  value,
  label,
  description,
  to,
}: {
  value: string | number;
  label: string;
  description?: ReactNode;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="block bg-card px-4 py-4 no-underline text-inherit transition-colors hover:bg-accent/40 sm:px-5 sm:py-5"
    >
      <p className="text-2xl font-semibold tracking-tighter tabular-nums sm:text-3xl">{value}</p>
      <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      {description && (
        <div className="mt-1.5 hidden text-xs text-muted-foreground/70 sm:block">{description}</div>
      )}
    </Link>
  );
}

type TimelineFilter = "all" | "activity" | "tasks";

function UnifiedTimeline({
  recentActivity,
  recentIssues,
  agentMap,
  userProfileMap,
  entityNameMap,
  entityTitleMap,
  animatedActivityIds,
  agentName,
  relative,
}: {
  recentActivity: ActivityEvent[];
  recentIssues: Issue[];
  agentMap: Map<string, Agent>;
  userProfileMap: Map<string, CompanyUserProfile>;
  entityNameMap: Map<string, string>;
  entityTitleMap: Map<string, string>;
  animatedActivityIds: Set<string>;
  agentName: (id: string | null) => string | null;
  relative: (date: Date | string) => string;
}) {
  const localize = useLocalizedText();
  const [filter, setFilter] = useState<TimelineFilter>("all");

  type Entry =
    | { kind: "activity"; ts: number; event: ActivityEvent }
    | { kind: "task"; ts: number; issue: Issue };

  const merged = useMemo((): Entry[] => {
    const items: Entry[] = [];
    if (filter !== "tasks") {
      for (const event of recentActivity) {
        items.push({ kind: "activity", ts: new Date(event.createdAt).getTime(), event });
      }
    }
    if (filter !== "activity") {
      for (const issue of recentIssues.slice(0, 10)) {
        items.push({ kind: "task", ts: new Date(issue.updatedAt).getTime(), issue });
      }
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 14);
  }, [recentActivity, recentIssues, filter]);

  const FILTERS: { key: TimelineFilter; labelEn: string; labelZh: string }[] = [
    { key: "all", labelEn: "All Events", labelZh: "全部" },
    { key: "activity", labelEn: "Activity", labelZh: "活动" },
    { key: "tasks", labelEn: "Tasks", labelZh: "任务" },
  ];

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">
          {localize({ en: "Timeline", zh: "时间线" })}
        </h3>
        <div
          role="group"
          aria-label={localize({ en: "Filter events", zh: "筛选事件" })}
          className="flex items-center gap-1"
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                filter === f.key
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {localize({ en: f.labelEn, zh: f.labelZh })}
            </button>
          ))}
        </div>
      </div>
      {merged.length === 0 ? (
        <div className="rounded-xl border border-border bg-card/60 shadow-sm p-4">
          <p className="text-sm text-muted-foreground">
            {localize({ en: "No recent events.", zh: "暂无最近事件。" })}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card shadow-sm divide-y divide-border overflow-hidden">
          {merged.map((entry) =>
            entry.kind === "activity" ? (
              <ActivityRow
                key={`act-${entry.event.id}`}
                event={entry.event}
                agentMap={agentMap}
                userProfileMap={userProfileMap}
                entityNameMap={entityNameMap}
                entityTitleMap={entityTitleMap}
                className={animatedActivityIds.has(entry.event.id) ? "activity-row-enter" : undefined}
              />
            ) : (
              <Link
                key={`task-${entry.issue.id}`}
                to={`/issues/${entry.issue.identifier ?? entry.issue.id}`}
                className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
              >
                <StatusIcon status={entry.issue.status} blockerAttention={entry.issue.blockerAttention} />
                <span className="flex-1 min-w-0 truncate">
                  <span className="font-mono text-xs text-muted-foreground mr-2">
                    {entry.issue.identifier ?? entry.issue.id.slice(0, 8)}
                  </span>
                  {entry.issue.title}
                </span>
                {entry.issue.assigneeAgentId && (() => {
                  const name = agentName(entry.issue.assigneeAgentId);
                  return name ? (
                    <span className="hidden sm:inline-flex shrink-0">
                      <Identity name={name} size="sm" />
                    </span>
                  ) : null;
                })()}
                <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                  {relative(entry.issue.updatedAt)}
                </span>
              </Link>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function Dashboard() {
  const localize = useLocalizedText();
  const relative = useLocalizedRelativeTime();
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const embeddedHost = useEmbeddedHost();
  // In super's Team-panel embed (top-nav chrome) the board has no big page title,
  // so add a small product header. Standalone board keeps its own breadcrumb header.
  const isEmbedded = useBoardChrome() === "top-nav";
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: localize({ en: "Dashboard", zh: "仪表盘" }) }]);
  }, [localize, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message={localize({
            en: "Create your first company to open the dashboard.",
            zh: "创建你的第一个公司，开始使用仪表盘。",
          })}
          action={localize({ en: "Get Started", zh: "开始使用" })}
          onAction={embeddedHost ? embeddedHost.onCreateCompany : openOnboarding}
        />
      );
    }
    return (
      <EmptyState
        icon={LayoutDashboard}
        message={localize({
          en: "Create or select a company to view the dashboard.",
          zh: "创建或选择一家公司来查看仪表盘。",
        })}
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;
  const companyName = companies.find((c) => c.id === selectedCompanyId)?.name ?? "";

  return (
    <div className="space-y-6">
      {/* Embedded product header — a clean page title so the panel reads as super's
          own command surface, not a bare template. Embed-only; standalone board
          keeps its breadcrumb. Status line appears once the summary loads. */}
      {isEmbedded && !!companyName && (
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{companyName}</h1>
          {data && (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {localize({
                  en: `${data.agents.active + data.agents.running + data.agents.paused + data.agents.error} agents · ${data.tasks.inProgress} in progress · ${data.pendingApprovals + data.budgets.pendingApprovals} pending`,
                  zh: `${data.agents.active + data.agents.running + data.agents.paused + data.agents.error} 个 Agent · ${data.tasks.inProgress} 个进行中 · ${data.pendingApprovals + data.budgets.pendingApprovals} 个待审批`,
                })}
              </p>
              {data.runActivity.some((d) => d.total > 0) && (
                <div className="mt-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
                      {localize({ en: "14-day run health", zh: "14 天运行健康度" })}
                    </span>
                    <span className="flex items-center gap-2 text-[10px] text-muted-foreground/40">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-3 shrink-0 rounded-sm bg-emerald-500/70" />
                        {localize({ en: "≥80% pass", zh: "≥80% 成功" })}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-3 shrink-0 rounded-sm bg-amber-500/70" />
                        {localize({ en: "mixed", zh: "混合" })}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-3 shrink-0 rounded-sm bg-red-500/70" />
                        {localize({ en: "≥60% fail", zh: "≥60% 失败" })}
                      </span>
                    </span>
                  </div>
                  <RunPulseStrip activity={data.runActivity} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              {localize({ en: "You have no agents.", zh: "你还没有 agent。" })}
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            {localize({ en: "Create one here", zh: "在这里创建" })}
          </button>
        </div>
      )}

      <ActiveAgentsPanel
        companyId={selectedCompanyId!}
        title={localize({ en: "Agents", zh: "Agent" })}
        emptyMessage={localize({ en: "No recent agent runs.", zh: "暂无最近 agent 运行。" })}
        compact
      />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {localize({
                      en: `${data.budgets.activeIncidents} active budget incident${data.budgets.activeIncidents === 1 ? "" : "s"}`,
                      zh: `${data.budgets.activeIncidents} 个活跃预算事件`,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {localize({
                      en: `${data.budgets.pausedAgents} agents paused · ${data.budgets.pausedProjects} projects paused · ${data.budgets.pendingApprovals} pending budget approvals`,
                      zh: `${data.budgets.pausedAgents} 个 agent 已暂停 · ${data.budgets.pausedProjects} 个项目已暂停 · ${data.budgets.pendingApprovals} 个预算审批待处理`,
                    })}
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-destructive">
                {localize({ en: "Open budgets", zh: "打开预算" })}
              </Link>
            </div>
          ) : null}

          {/* Telemetry panel — the four metrics as one instrument cluster: a single
              bordered card with hairline dividers between cells, no per-tile icons.
              Uses the gap-px + bg-border grid trick (not `divide-*`, which is
              linear and leaves stray borders when a grid wraps to 2 columns). */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border shadow-sm xl:grid-cols-4">
            <MetricCell
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label={localize({ en: "Agents Enabled", zh: "已启用 Agent" })}
              to="/agents"
              description={localize({
                en: `${data.agents.running} running, ${data.agents.paused} paused, ${data.agents.error} errors`,
                zh: `${data.agents.running} 运行中，${data.agents.paused} 已暂停，${data.agents.error} 个错误`,
              })}
            />
            <MetricCell
              value={data.tasks.inProgress}
              label={localize({ en: "Tasks In Progress", zh: "进行中的任务" })}
              to="/issues"
              description={localize({
                en: `${data.tasks.open} open, ${data.tasks.blocked} blocked`,
                zh: `${data.tasks.open} 个打开，${data.tasks.blocked} 个阻塞`,
              })}
            />
            <MetricCell
              value={formatCents(data.costs.monthSpendCents)}
              label={localize({ en: "Month Spend", zh: "本月花费" })}
              to="/costs"
              description={
                data.costs.monthBudgetCents > 0
                  ? localize({
                    en: `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`,
                    zh: `已用预算 ${data.costs.monthUtilizationPercent}% / ${formatCents(data.costs.monthBudgetCents)}`,
                  })
                  : localize({ en: "Unlimited budget", zh: "无限预算" })
              }
            />
            <MetricCell
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label={localize({ en: "Pending Approvals", zh: "待审批" })}
              to="/approvals"
              description={
                data.budgets.pendingApprovals > 0
                  ? localize({
                    en: `${data.budgets.pendingApprovals} budget overrides awaiting board review`,
                    zh: `${data.budgets.pendingApprovals} 个预算覆盖等待审核`,
                  })
                  : localize({ en: "Awaiting board review", zh: "等待看板审核" })
              }
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <RunSparklineCard activity={data.runActivity} />
            <SuccessSparklineCard activity={data.runActivity} />
            <PriorityBreakdownCard issues={issues ?? []} />
            <StatusBreakdownCard issues={issues ?? []} />
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <UnifiedTimeline
            recentActivity={recentActivity}
            recentIssues={recentIssues}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
            entityNameMap={entityNameMap}
            entityTitleMap={entityTitleMap}
            animatedActivityIds={animatedActivityIds}
            agentName={agentName}
            relative={relative}
          />

        </>
      )}
    </div>
  );
}
