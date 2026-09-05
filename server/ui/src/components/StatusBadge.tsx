import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import {
  statusBadge,
  statusBadgeDefault,
  agentStatusMotion,
  agentStatusVar,
  agentStatusVarDefault,
  taskStatusVar,
  taskStatusVarDefault,
} from "../lib/status-colors";
import { StatusGlyph } from "./StatusGlyph";
import { type LocalizedText, useLocalizedText } from "../i18n/localized";

/** Inline `--sc` local var pointing a status helper at a base-hue CSS var. */
function scStyle(cssVar: string): CSSProperties {
  return { "--sc": `var(${cssVar})` } as CSSProperties;
}

/** "in_review" → "In review" (sentence case). */
function sentenceCaseStatus(status: string): string {
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const genericStatusCopy: Record<string, LocalizedText> = {
  active: { en: "active", zh: "活跃" },
  approved: { en: "approved", zh: "已批准" },
  backlog: { en: "backlog", zh: "待规划" },
  cancelled: { en: "cancelled", zh: "已取消" },
  completed: { en: "completed", zh: "已完成" },
  done: { en: "done", zh: "已完成" },
  error: { en: "error", zh: "错误" },
  failed: { en: "failed", zh: "失败" },
  in_progress: { en: "in progress", zh: "进行中" },
  in_review: { en: "in review", zh: "审核中" },
  paused: { en: "paused", zh: "已暂停" },
  pending: { en: "pending", zh: "待处理" },
  pending_approval: { en: "pending approval", zh: "待批准" },
  planned: { en: "planned", zh: "已计划" },
  queued: { en: "queued", zh: "排队中" },
  rejected: { en: "rejected", zh: "已拒绝" },
  running: { en: "running", zh: "运行中" },
  success: { en: "success", zh: "成功" },
  todo: { en: "todo", zh: "待办" },
};

const agentStatusCopy: Record<string, LocalizedText> = {
  active: { en: "idle", zh: "空闲" },
  idle: { en: "idle", zh: "空闲" },
  running: { en: "running", zh: "运行中" },
  paused: { en: "paused", zh: "已暂停" },
  error: { en: "error", zh: "错误" },
  terminated: { en: "terminated", zh: "已终止" },
  pending_approval: { en: "pending approval", zh: "待批准" },
};

const issueStatusCopy: Record<string, LocalizedText> = {
  todo: { en: "Todo", zh: "待办" },
  in_progress: { en: "In progress", zh: "进行中" },
  in_review: { en: "In review", zh: "审核中" },
  done: { en: "Done", zh: "已完成" },
  cancelled: { en: "Cancelled", zh: "已取消" },
};

/**
 * Generic status badge for runs / goals / approvals (not task status).
 */
export function StatusBadge({ status }: { status: string }) {
  const localize = useLocalizedText();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {genericStatusCopy[status] ? localize(genericStatusCopy[status]) : status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Agent status chip — bordered chip recoloured from the editable
 * `--status-agent-*` base hue via the `.status-chip` color-mix helper. `active`
 * renders as "idle" (alias for dead code).
 */
export function AgentStatusBadge({ status }: { status: string }) {
  const localize = useLocalizedText();
  const cssVar = agentStatusVar[status] ?? agentStatusVarDefault;
  const label = agentStatusCopy[status] ? localize(agentStatusCopy[status]) : status.replace(/_/g, " ");
  return (
    <span
      className="status-chip inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium leading-none whitespace-nowrap shrink-0"
      style={scStyle(cssVar)}
    >
      {label}
    </span>
  );
}

/**
 * Agent status indicator — heartbeat capsule (vertical 8x16, r4) filled from the
 * editable `--status-agent-*` base hue. Running agents pulse, broken (error)
 * agents blink; both honor `prefers-reduced-motion`.
 */
export function AgentStatusCapsule({ status }: { status: string }) {
  const cssVar = agentStatusVar[status] ?? agentStatusVarDefault;
  const motion = agentStatusMotion[status] ?? "";
  return (
    <span
      aria-hidden
      className={cn("status-fill inline-block h-4 w-2 rounded-[4px] shrink-0", motion)}
      style={scStyle(cssVar)}
    />
  );
}

/**
 * Issue/task status chip — bordered chip recoloured from the editable
 * `--status-task-*` base hue via `.status-chip`, carrying the unified
 * {@link StatusGlyph} (one distinct, color-blind-safe shape per status), a
 * sentence-cased label and regular weight. `cancelled` is struck through.
 * Distinct from the generic {@link StatusBadge} so run/goal/approval badges are
 * unaffected.
 */
export function IssueStatusBadge({ status }: { status: string }) {
  const localize = useLocalizedText();
  const cssVar = taskStatusVar[status] ?? taskStatusVarDefault;
  return (
    <span
      className={cn(
        "status-chip inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-normal leading-none whitespace-nowrap shrink-0",
        status === "cancelled" && "line-through"
      )}
      style={scStyle(cssVar)}
    >
      <StatusGlyph status={status} size="sm" />
      {issueStatusCopy[status] ? localize(issueStatusCopy[status]) : sentenceCaseStatus(status)}
    </span>
  );
}
