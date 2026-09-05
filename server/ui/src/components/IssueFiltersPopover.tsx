import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bot, Filter, HardDrive, Search, User, X } from "lucide-react";
import { PriorityIcon } from "./PriorityIcon";
import { StatusIcon } from "./StatusIcon";
import {
  defaultIssueFilterState,
  externalObjectFilterLabel,
  externalObjectFilterOrder,
  issueFilterArraysEqual,
  issueFilterLabel,
  issuePriorityOrder,
  issueQuickFilterPresets,
  issueStatusOrder,
  toggleIssueFilterValue,
  type IssueFilterState,
} from "../lib/issue-filters";
import { externalObjectIconForCategory } from "../lib/external-objects";
import { externalObjectStatusIcon } from "../lib/status-colors";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { type LocalizedText, useLocalizedText } from "../i18n/localized";

type AgentOption = {
  id: string;
  name: string;
};

type ProjectOption = {
  id: string;
  name: string;
};

type LabelOption = {
  id: string;
  name: string;
  color: string;
};

type WorkspaceOption = {
  id: string;
  name: string;
};

type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

const issueFilterLabelCopy: Record<string, LocalizedText> = {
  All: { en: "All", zh: "全部" },
  Active: { en: "Active", zh: "活跃" },
  Backlog: { en: "Backlog", zh: "待办池" },
  Done: { en: "Done", zh: "已完成" },
  in_progress: { en: "In Progress", zh: "进行中" },
  todo: { en: "Todo", zh: "待处理" },
  backlog: { en: "Backlog", zh: "待办池" },
  in_review: { en: "In Review", zh: "评审中" },
  blocked: { en: "Blocked", zh: "受阻" },
  done: { en: "Done", zh: "已完成" },
  cancelled: { en: "Cancelled", zh: "已取消" },
  critical: { en: "Critical", zh: "紧急" },
  high: { en: "High", zh: "高" },
  medium: { en: "Medium", zh: "中" },
  low: { en: "Low", zh: "低" },
};

const externalObjectFilterLabelCopy: Record<string, LocalizedText> = {
  failed: { en: "Any failed", zh: "有失败项" },
  waiting: { en: "Any waiting", zh: "有等待项" },
  running: { en: "Any running", zh: "有运行项" },
  auth_required: { en: "Auth required", zh: "需要认证" },
  unreachable: { en: "Unreachable", zh: "不可达" },
  stale: { en: "Stale", zh: "已过期" },
  none: { en: "No external objects", zh: "无外部对象" },
};

function localizedIssueFilterLabel(value: string, localize: (copy: LocalizedText) => string): string {
  return localize(issueFilterLabelCopy[value] ?? { en: issueFilterLabel(value), zh: issueFilterLabel(value) });
}

function localizedExternalObjectFilterLabel(value: string, localize: (copy: LocalizedText) => string): string {
  return localize(externalObjectFilterLabelCopy[value] ?? { en: externalObjectFilterLabel(value), zh: externalObjectFilterLabel(value) });
}

export function IssueFiltersPopover({
  state,
  onChange,
  activeFilterCount,
  agents,
  projects,
  labels,
  currentUserId,
  enableExternalObjectFilters = true,
  enableRoutineVisibilityFilter = false,
  buttonVariant = "ghost",
  iconOnly = false,
  workspaces,
  creators,
}: {
  state: IssueFilterState;
  onChange: (patch: Partial<IssueFilterState>) => void;
  activeFilterCount: number;
  agents?: AgentOption[];
  projects?: ProjectOption[];
  labels?: LabelOption[];
  currentUserId?: string | null;
  enableExternalObjectFilters?: boolean;
  enableRoutineVisibilityFilter?: boolean;
  buttonVariant?: "ghost" | "outline";
  iconOnly?: boolean;
  workspaces?: WorkspaceOption[];
  creators?: CreatorOption[];
}) {
  const localize = useLocalizedText();
  const [creatorSearch, setCreatorSearch] = useState("");
  const creatorOptions = creators ?? [];
  const creatorOptionById = useMemo(
    () => new Map(creatorOptions.map((option) => [option.id, option])),
    [creatorOptions],
  );
  const normalizedCreatorSearch = creatorSearch.trim().toLowerCase();
  const visibleCreatorOptions = useMemo(() => {
    if (!normalizedCreatorSearch) return creatorOptions;
    return creatorOptions.filter((option) =>
      `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(normalizedCreatorSearch),
    );
  }, [creatorOptions, normalizedCreatorSearch]);
  const selectedCreatorOptions = useMemo(
    () => state.creators.map((creatorId) => {
      const knownOption = creatorOptionById.get(creatorId);
      if (knownOption) return knownOption;
      if (creatorId.startsWith("agent:")) {
        const agentId = creatorId.slice("agent:".length);
        return { id: creatorId, label: agentId.slice(0, 8), kind: "agent" as const };
      }
      const userId = creatorId.startsWith("user:") ? creatorId.slice("user:".length) : creatorId;
      return {
        id: creatorId,
        label: formatAssigneeUserLabel(userId, currentUserId) ?? userId.slice(0, 5),
        kind: "user" as const,
      };
    }),
    [creatorOptionById, currentUserId, state.creators],
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={buttonVariant}
          size={iconOnly ? "icon" : "sm"}
          className={`text-xs ${iconOnly ? "relative h-8 w-8 shrink-0" : ""} ${activeFilterCount > 0 ? "text-blue-600 dark:text-blue-400" : ""}`}
          title={iconOnly
            ? (activeFilterCount > 0
              ? localize({ en: `Filters: ${activeFilterCount}`, zh: `筛选：${activeFilterCount}` })
              : localize({ en: "Filter", zh: "筛选" }))
            : undefined}
        >
          <Filter className={iconOnly ? "h-3.5 w-3.5" : "h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1"} />
          {!iconOnly && (
            <span className="hidden sm:inline">
              {activeFilterCount > 0
                ? localize({ en: `Filters: ${activeFilterCount}`, zh: `筛选：${activeFilterCount}` })
                : localize({ en: "Filter", zh: "筛选" })}
            </span>
          )}
          {!iconOnly && activeFilterCount > 0 ? <span className="ml-0.5 text-[10px] font-medium sm:hidden">{activeFilterCount}</span> : null}
          {iconOnly && activeFilterCount > 0 ? <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold text-white">{activeFilterCount}</span> : null}
          {!iconOnly && activeFilterCount > 0 ? (
            <X
              className="ml-1 hidden h-3 w-3 sm:block"
              onClick={(event) => {
                event.stopPropagation();
                onChange(defaultIssueFilterState);
              }}
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(780px,calc(100vw-2rem))] max-h-[min(80vh,42rem)] overflow-y-auto overscroll-contain p-0"
      >
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{localize({ en: "Filters", zh: "筛选" })}</span>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onChange(defaultIssueFilterState)}
              >
                {localize({ en: "Clear", zh: "清除" })}
              </button>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">{localize({ en: "Quick filters", zh: "快速筛选" })}</span>
            <div className="flex flex-wrap gap-1.5">
              {issueQuickFilterPresets.map((preset) => {
                const isActive = issueFilterArraysEqual(state.statuses, preset.statuses);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                    }`}
                    onClick={() => onChange({ statuses: isActive ? [] : [...preset.statuses] })}
                  >
                    {localizedIssueFilterLabel(preset.label, localize)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border" />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{localize({ en: "Status", zh: "状态" })}</span>
                <div className="space-y-0.5">
                  {issueStatusOrder.map((status) => (
                    <label key={status} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.statuses.includes(status)}
                        onCheckedChange={() => onChange({ statuses: toggleIssueFilterValue(state.statuses, status) })}
                      />
                      <StatusIcon status={status} />
                      <span className="text-sm">{localizedIssueFilterLabel(status, localize)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{localize({ en: "Priority", zh: "优先级" })}</span>
                <div className="space-y-0.5">
                  {issuePriorityOrder.map((priority) => (
                    <label key={priority} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.priorities.includes(priority)}
                        onCheckedChange={() => onChange({ priorities: toggleIssueFilterValue(state.priorities, priority) })}
                      />
                      <PriorityIcon priority={priority} />
                      <span className="text-sm">{localizedIssueFilterLabel(priority, localize)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{localize({ en: "Assignee", zh: "负责人" })}</span>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                    <Checkbox
                      checked={state.assignees.includes("__unassigned")}
                      onCheckedChange={() => onChange({ assignees: toggleIssueFilterValue(state.assignees, "__unassigned") })}
                    />
                    <span className="text-sm">{localize({ en: "No assignee", zh: "未分配" })}</span>
                  </label>
                  {currentUserId ? (
                    <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.assignees.includes("__me")}
                        onCheckedChange={() => onChange({ assignees: toggleIssueFilterValue(state.assignees, "__me") })}
                      />
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm">{localize({ en: "Me", zh: "我" })}</span>
                    </label>
                  ) : null}
                  {(agents ?? []).map((agent) => (
                    <label key={agent.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.assignees.includes(agent.id)}
                        onCheckedChange={() => onChange({ assignees: toggleIssueFilterValue(state.assignees, agent.id) })}
                      />
                      <span className="text-sm">{agent.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              {creatorOptions.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{localize({ en: "Creator", zh: "创建者" })}</span>
                  {selectedCreatorOptions.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {selectedCreatorOptions.map((creator) => (
                        <Badge key={creator.id} variant="secondary" className="gap-1 pr-1">
                          {creator.kind === "agent" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
                          <span>{creator.label}</span>
                          <button
                            type="button"
                            className="rounded-full p-0.5 hover:bg-accent"
                            onClick={() => onChange({ creators: state.creators.filter((value) => value !== creator.id) })}
                            aria-label={localize({ en: `Remove creator ${creator.label}`, zh: `移除创建者 ${creator.label}` })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={creatorSearch}
                      onChange={(event) => setCreatorSearch(event.target.value)}
                      placeholder={localize({ en: "Search creators...", zh: "搜索创建者..." })}
                      className="h-8 pl-7 text-xs"
                    />
                  </div>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {visibleCreatorOptions.length > 0 ? visibleCreatorOptions.map((creator) => {
                      const selected = state.creators.includes(creator.id);
                      return (
                        <button
                          key={creator.id}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm ${
                            selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onChange({ creators: toggleIssueFilterValue(state.creators, creator.id) })}
                        >
                          {creator.kind === "agent" ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                          <span className="min-w-0 flex-1 truncate">{creator.label}</span>
                          {selected ? <X className="h-3 w-3" /> : null}
                        </button>
                      );
                    }) : (
                      <div className="px-2 py-1 text-xs text-muted-foreground">{localize({ en: "No creators match.", zh: "没有匹配的创建者。" })}</div>
                    )}
                  </div>
                </div>
              ) : null}

              {projects && projects.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{localize({ en: "Project", zh: "项目" })}</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {projects.map((project) => (
                      <label key={project.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                        <Checkbox
                          checked={state.projects.includes(project.id)}
                          onCheckedChange={() => onChange({ projects: toggleIssueFilterValue(state.projects, project.id) })}
                        />
                        <span className="text-sm">{project.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="min-w-0 space-y-3">
              {labels && labels.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{localize({ en: "Labels", zh: "标签" })}</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {labels.map((label) => (
                      <label key={label.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                        <Checkbox
                          checked={state.labels.includes(label.id)}
                          onCheckedChange={() => onChange({ labels: toggleIssueFilterValue(state.labels, label.id) })}
                        />
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                        <span className="text-sm">{label.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              {workspaces && workspaces.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{localize({ en: "Workspace", zh: "工作区" })}</span>
                  <div className="max-h-32 space-y-0.5 overflow-y-auto">
                    {workspaces.map((workspace) => (
                      <label key={workspace.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                        <Checkbox
                          checked={state.workspaces.includes(workspace.id)}
                          onCheckedChange={() => onChange({ workspaces: toggleIssueFilterValue(state.workspaces, workspace.id) })}
                        />
                        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm">{workspace.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}

              {enableExternalObjectFilters ? (
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">{localize({ en: "External object status", zh: "外部对象状态" })}</span>
                  <div className="space-y-0.5">
                    {externalObjectFilterOrder.map((value) => {
                      const iconCategory = value === "failed" ? "failed"
                        : value === "waiting" ? "waiting"
                        : value === "running" ? "running"
                        : value === "auth_required" ? "auth_required"
                        : value === "unreachable" ? "unreachable"
                        : value === "stale" ? "unknown"
                        : "closed";
                      const Icon = externalObjectIconForCategory(iconCategory);
                      const tone = externalObjectStatusIcon[iconCategory] ?? "";
                      const textTone = tone.split(" ").filter((c) => c.startsWith("text-")).join(" ");
                      return (
                        <label
                          key={value}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50"
                        >
                          <Checkbox
                            checked={state.externalObjectStatuses.includes(value)}
                            onCheckedChange={() => onChange({ externalObjectStatuses: toggleIssueFilterValue(state.externalObjectStatuses, value) })}
                          />
                          <Icon className={`h-3.5 w-3.5 shrink-0 ${textTone}`} aria-hidden="true" />
                          <span className="text-sm">{localizedExternalObjectFilterLabel(value, localize)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">{localize({ en: "Visibility", zh: "可见性" })}</span>
                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                  <Checkbox
                    checked={state.liveOnly}
                    onCheckedChange={(checked) => onChange({ liveOnly: checked === true })}
                  />
                  <span className="text-sm">{localize({ en: "Live runs only", zh: "仅实时运行" })}</span>
                </label>
                {enableRoutineVisibilityFilter ? (
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                    <Checkbox
                      checked={state.hideRoutineExecutions}
                      onCheckedChange={(checked) => onChange({ hideRoutineExecutions: checked === true })}
                    />
                    <span className="text-sm">{localize({ en: "Hide routine runs", zh: "隐藏定时任务运行" })}</span>
                  </label>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
