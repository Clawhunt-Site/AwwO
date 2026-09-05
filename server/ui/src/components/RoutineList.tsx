import type { ReactNode } from "react";
import { MoreHorizontal, Play } from "lucide-react";
import { Link } from "@/lib/router";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { type LocalizedText, useLocalizedText } from "../i18n/localized";

export type RoutineListProjectSummary = {
  name: string;
  color?: string | null;
};

export type RoutineListAgentSummary = {
  name: string;
  icon?: string | null;
};

export type RoutineListRowItem = {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  lastRun?: {
    triggeredAt?: Date | string | null;
    status?: string | null;
  } | null;
};

export function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export function formatRoutineRunStatus(value: string | null | undefined) {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

const routineRunStatusCopy: Record<string, LocalizedText> = {
  cancelled: { en: "cancelled", zh: "已取消" },
  completed: { en: "completed", zh: "已完成" },
  failed: { en: "failed", zh: "失败" },
  queued: { en: "queued", zh: "排队中" },
  running: { en: "running", zh: "运行中" },
  success: { en: "success", zh: "成功" },
};

export function nextRoutineStatus(currentStatus: string, enabled: boolean) {
  if (currentStatus === "archived" && enabled) return "active";
  return enabled ? "active" : "paused";
}

export function RoutineListRow<TRoutine extends RoutineListRowItem>({
  routine,
  projectById,
  agentById,
  runningRoutineId,
  statusMutationRoutineId,
  href,
  configureLabel,
  managedByLabel,
  secondaryDetails,
  runNowButton = false,
  disableRunNow = false,
  disableToggle = false,
  hideArchiveAction = false,
  divider = true,
  onRunNow,
  onToggleEnabled,
  onToggleArchived,
}: {
  routine: TRoutine;
  projectById: Map<string, RoutineListProjectSummary>;
  agentById: Map<string, RoutineListAgentSummary>;
  runningRoutineId: string | null;
  statusMutationRoutineId: string | null;
  href: string;
  configureLabel?: string;
  managedByLabel?: string | null;
  secondaryDetails?: ReactNode;
  runNowButton?: boolean;
  disableRunNow?: boolean;
  disableToggle?: boolean;
  hideArchiveAction?: boolean;
  /** Render a bottom divider between consecutive rows. Off when the group is its own card. */
  divider?: boolean;
  onRunNow: (routine: TRoutine) => void;
  onToggleEnabled: (routine: TRoutine, enabled: boolean) => void;
  onToggleArchived?: (routine: TRoutine) => void;
}) {
  const localize = useLocalizedText();
  const enabled = routine.status === "active";
  const isArchived = routine.status === "archived";
  const isStatusPending = statusMutationRoutineId === routine.id;
  const project = routine.projectId ? projectById.get(routine.projectId) ?? null : null;
  const agent = routine.assigneeAgentId ? agentById.get(routine.assigneeAgentId) ?? null : null;
  const isDraft = !isArchived && !routine.assigneeAgentId;
  const runDisabled = runningRoutineId === routine.id || isArchived || disableRunNow;
  const lastRunStatus = routine.lastRun ? formatRoutineRunStatus(routine.lastRun.status) : null;
  const localizedRunStatus = lastRunStatus && routineRunStatusCopy[routine.lastRun?.status ?? ""]
    ? localize(routineRunStatusCopy[routine.lastRun?.status ?? ""])
    : lastRunStatus;
  const lastRunLabel = routine.lastRun?.triggeredAt
    ? formatLastRunTimestamp(routine.lastRun.triggeredAt)
    : localize({ en: "Never", zh: "从未运行" });
  const resolvedConfigureLabel = configureLabel ?? localize({ en: "Edit", zh: "编辑" });

  return (
    <Link
      to={href}
      className={`group flex flex-col gap-3 px-3 py-3 transition-colors hover:bg-accent/50 sm:flex-row sm:items-center no-underline text-inherit${
        divider ? " border-b border-border last:border-b-0" : ""
      }`}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{routine.title}</span>
          {(isArchived || routine.status === "paused" || isDraft) ? (
            <span className="text-xs text-muted-foreground">
              {isArchived
                ? localize({ en: "archived", zh: "已归档" })
                : isDraft
                  ? localize({ en: "draft", zh: "草稿" })
                  : localize({ en: "paused", zh: "已暂停" })}
            </span>
          ) : null}
          {managedByLabel ? (
            <span className="text-xs text-muted-foreground">{managedByLabel}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project?.color ?? "#64748b" }}
            />
            <span>
              {routine.projectId
                ? (project?.name ?? localize({ en: "Unknown project", zh: "未知项目" }))
                : localize({ en: "No project", zh: "无项目" })}
            </span>
          </span>
          <span className="flex items-center gap-2">
            {agent?.icon ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0" /> : null}
            <span>
              {routine.assigneeAgentId
                ? (agent?.name ?? localize({ en: "Unknown agent", zh: "未知 Agent" }))
                : localize({ en: "No default agent", zh: "无默认 Agent" })}
            </span>
          </span>
          <span>
            {lastRunLabel}
            {localizedRunStatus ? ` · ${localizedRunStatus}` : ""}
          </span>
        </div>
        {secondaryDetails ? (
          <div className="text-xs text-muted-foreground">{secondaryDetails}</div>
        ) : null}
      </div>

      <div className="flex items-center gap-3" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        {runNowButton ? (
          <Button
            variant="outline"
            size="sm"
            disabled={runDisabled}
            onClick={() => onRunNow(routine)}
          >
            <Play className="h-3.5 w-3.5" />
            {runningRoutineId === routine.id
              ? localize({ en: "Running...", zh: "运行中..." })
              : localize({ en: "Run now", zh: "立即运行" })}
          </Button>
        ) : null}

        <div className="flex items-center gap-3">
          <ToggleSwitch
            size="lg"
            checked={enabled}
            onCheckedChange={() => onToggleEnabled(routine, enabled)}
            disabled={isStatusPending || isArchived || disableToggle}
            aria-label={enabled
              ? localize({ en: `Disable ${routine.title}`, zh: `停用 ${routine.title}` })
              : localize({ en: `Enable ${routine.title}`, zh: `启用 ${routine.title}` })}
          />
          <span className="w-12 text-xs text-muted-foreground">
            {isArchived
              ? localize({ en: "Archived", zh: "已归档" })
              : isDraft
                ? localize({ en: "Draft", zh: "草稿" })
                : enabled
                  ? localize({ en: "On", zh: "开启" })
                  : localize({ en: "Off", zh: "关闭" })}
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={localize({ en: `More actions for ${routine.title}`, zh: `${routine.title} 的更多操作` })}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to={href}>{resolvedConfigureLabel}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={runDisabled}
              onClick={() => onRunNow(routine)}
            >
              {runningRoutineId === routine.id
                ? localize({ en: "Running...", zh: "运行中..." })
                : localize({ en: "Run now", zh: "立即运行" })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onToggleEnabled(routine, enabled)}
              disabled={isStatusPending || isArchived || disableToggle}
            >
              {enabled ? localize({ en: "Pause", zh: "暂停" }) : localize({ en: "Enable", zh: "启用" })}
            </DropdownMenuItem>
            {!hideArchiveAction && onToggleArchived ? (
              <DropdownMenuItem
                onClick={() => onToggleArchived(routine)}
                disabled={isStatusPending}
              >
                {routine.status === "archived"
                  ? localize({ en: "Restore", zh: "恢复" })
                  : localize({ en: "Archive", zh: "归档" })}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Link>
  );
}
