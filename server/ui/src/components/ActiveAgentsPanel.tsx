import { memo, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import {
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
  recoveryChipLabelText,
} from "../lib/recovery-display";
import { ExternalLink } from "lucide-react";
import { useLocalizedRelativeTime, useLocalizedText } from "@/i18n/localized";
import { Identity } from "./Identity";
import { RunChatSurface } from "./RunChatSurface";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";

function RunCardRecoveryChip({ action }: { action: IssueRecoveryAction }) {
  const localize = useLocalizedText();
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  const label = localize(recoveryChipLabelText(state, action.kind));
  return (
    <span
      data-testid="active-agent-run-recovery-indicator"
      data-recovery-state={state}
      role="status"
      aria-label={label}
      title={localize({
        en: `${label} — open the source task to act.`,
        zh: `${label}，打开来源任务处理。`,
      })}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        tone.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </span>
  );
}

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_CARD_LIMIT = 4;
const DASHBOARD_LOG_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_LOG_READ_LIMIT_BYTES = 64_000;
const DASHBOARD_MAX_CHUNKS_PER_RUN = 40;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

// Extract the last meaningful log line from a run's transcript for the strip view.
function lastLogLine(transcript: TranscriptEntry[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.kind === "tool_call") return `▶ ${e.name}`;
    if (e.kind === "tool_result" || e.kind === "init") continue;
    if ("text" in e && e.text) {
      const nl = e.text.indexOf("\n");
      return (nl === -1 ? e.text : e.text.slice(0, nl)).trim().slice(0, 120);
    }
  }
  return "";
}

interface ActiveAgentsPanelProps {
  companyId: string;
  title?: string;
  minRunCount?: number;
  fetchLimit?: number;
  cardLimit?: number;
  gridClassName?: string;
  cardClassName?: string;
  emptyMessage?: string;
  queryScope?: string;
  showMoreLink?: boolean;
  /** Render as compact horizontal console strips instead of full transcript cards */
  compact?: boolean;
}

export function ActiveAgentsPanel({
  companyId,
  title,
  minRunCount = MIN_DASHBOARD_RUNS,
  fetchLimit,
  cardLimit = DASHBOARD_RUN_CARD_LIMIT,
  gridClassName,
  cardClassName,
  emptyMessage,
  queryScope = "dashboard",
  showMoreLink = true,
  compact = false,
}: ActiveAgentsPanelProps) {
  const localize = useLocalizedText();
  const panelTitle = title ?? localize({ en: "Agents", zh: "Agent" });
  const panelEmptyMessage = emptyMessage ?? localize({ en: "No recent agent runs.", zh: "暂无最近 agent 运行。" });
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), queryScope, { minRunCount, fetchLimit }],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: minRunCount, limit: fetchLimit }),
  });

  const runs = liveRuns ?? [];
  const visibleRuns = useMemo(() => runs.slice(0, cardLimit), [cardLimit, runs]);
  const hiddenRunCount = Math.max(0, runs.length - visibleRuns.length);
  const visibleIssueIds = useMemo(
    () => [...new Set(visibleRuns.map((run) => run.issueId).filter((issueId): issueId is string => Boolean(issueId)))],
    [visibleRuns],
  );

  const issueQueries = useQueries({
    queries: visibleIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const query of issueQueries) {
      const issue = query.data;
      if (issue) map.set(issue.id, issue);
    }
    return map;
  }, [issueQueries]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: visibleRuns,
    companyId,
    maxChunksPerRun: DASHBOARD_MAX_CHUNKS_PER_RUN,
    logPollIntervalMs: DASHBOARD_LOG_POLL_INTERVAL_MS,
    logReadLimitBytes: DASHBOARD_LOG_READ_LIMIT_BYTES,
    enableRealtimeUpdates: false,
  });

  return (
    <div>
      <h3 className="mb-3 text-base font-semibold tracking-tight text-foreground">
        {panelTitle}
      </h3>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border bg-card/60 shadow-sm p-4">
          <p className="text-sm text-muted-foreground">{panelEmptyMessage}</p>
        </div>
      ) : compact ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm divide-y divide-border">
          {visibleRuns.map((run) => (
            <AgentRunStripRow
              key={run.id}
              companyId={companyId}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT}
              isActive={isRunActive(run)}
            />
          ))}
        </div>
      ) : (
        <div className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
          {visibleRuns.map((run) => (
            <AgentRunCard
              key={run.id}
              companyId={companyId}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT}
              hasOutput={hasOutputForRun(run.id)}
              isActive={isRunActive(run)}
              className={cardClassName}
            />
          ))}
        </div>
      )}
      {showMoreLink && hiddenRunCount > 0 && (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link to="/dashboard/live" className="hover:text-foreground hover:underline">
            {hiddenRunCount} {localize({
              en: `more active/recent run${hiddenRunCount === 1 ? "" : "s"}`,
              zh: "个更多活跃/最近运行",
            })}
          </Link>
        </div>
      )}
    </div>
  );
}

const AgentRunStripRow = memo(function AgentRunStripRow({
  companyId: _companyId,
  run,
  issue,
  transcript,
  isActive,
}: {
  companyId: string;
  run: LiveRunForIssue;
  issue?: Issue;
  transcript: TranscriptEntry[];
  isActive: boolean;
}) {
  const localize = useLocalizedText();
  const relative = useLocalizedRelativeTime();
  const logLine = lastLogLine(transcript);

  const statusLabel = isActive
    ? localize({ en: "Live", zh: "运行中" })
    : run.finishedAt
      ? relative(run.finishedAt)
      : relative(run.createdAt);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Left: status dot + identity + status label */}
      <div className="flex w-40 shrink-0 items-center gap-2">
        {isActive ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        ) : (
          <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-muted-foreground/30" />
        )}
        <div className="min-w-0">
          <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{statusLabel}</p>
        </div>
      </div>

      {/* Middle: task context */}
      <div className="min-w-0 flex-1">
        {run.issueId ? (
          <Link
            to={`/issues/${issue?.identifier ?? run.issueId}`}
            className="block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
            title={issue?.title ? `${issue?.identifier} — ${issue.title}` : undefined}
          >
            <span className="font-medium text-foreground/80">{issue?.identifier ?? run.issueId.slice(0, 8)}</span>
            {issue?.title ? <span className="ml-1 text-muted-foreground">— {issue.title}</span> : null}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground/40">—</span>
        )}
      </div>

      {/* Right: last log line + link to full logs */}
      <div className="hidden shrink-0 items-center gap-2 sm:flex">
        {logLine ? (
          <p className="max-w-[220px] truncate font-mono text-[10px] text-muted-foreground/50">
            {logLine}
          </p>
        ) : null}
        <Link
          to={`/agents/${run.agentId}/runs/${run.id}`}
          className="inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-2.5 w-2.5" />
          {localize({ en: "Logs", zh: "日志" })}
        </Link>
      </div>
    </div>
  );
});

const AgentRunCard = memo(function AgentRunCard({
  companyId,
  run,
  issue,
  transcript,
  hasOutput,
  isActive,
  className,
}: {
  companyId: string;
  run: LiveRunForIssue;
  issue?: Issue;
  transcript: TranscriptEntry[];
  hasOutput: boolean;
  isActive: boolean;
  className?: string;
}) {
  const localize = useLocalizedText();
  const relative = useLocalizedRelativeTime();
  const statusText = isActive
    ? localize({ en: "Live now", zh: "正在运行" })
    : run.finishedAt
      ? `${localize({ en: "Finished", zh: "完成于" })} ${relative(run.finishedAt)}`
      : `${localize({ en: "Started", zh: "开始于" })} ${relative(run.createdAt)}`;

  return (
    <div className={cn(
      "flex h-[320px] flex-col overflow-hidden rounded-xl border bg-card shadow-sm",
      isActive
        ? "border-emerald-500/30"
        : "border-border",
      className,
    )}>
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isActive ? (
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                </span>
              ) : (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
              )}
              <Identity name={run.agentName} size="sm" className="[&>span:last-child]:!text-[11px]" />
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{statusText}</span>
            </div>
          </div>

          <Link
            to={`/agents/${run.agentId}/runs/${run.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
        </div>

        {run.issueId && (
          <div className="mt-3 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-xs">
            <Link
              to={`/issues/${issue?.identifier ?? run.issueId}`}
              className={cn(
                "line-clamp-2 hover:underline",
                isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
            >
              {issue?.identifier ?? run.issueId.slice(0, 8)}
              {issue?.title ? ` - ${issue.title}` : ""}
            </Link>
            {issue?.activeRecoveryAction ? (
              <div className="mt-1.5">
                <RunCardRecoveryChip action={issue.activeRecoveryAction} />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <RunChatSurface
          run={run}
          transcript={transcript}
          hasOutput={hasOutput}
          companyId={companyId}
        />
      </div>
    </div>
  );
});
