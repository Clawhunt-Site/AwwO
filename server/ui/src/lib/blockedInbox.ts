import type {
  Issue,
  IssueBlockedInboxAttention,
  IssueBlockedInboxReason,
  IssueBlockedInboxSeverity,
} from "@paperclipai/shared";
import { type LocalizedText, localizedText } from "../i18n/localized";

export type BlockedReasonVariant =
  | "needs_decision"
  | "stalled"
  | "needs_attention"
  | "recovery_required"
  | "external_wait"
  | "owner_paused";

const VARIANT_BY_REASON: Record<IssueBlockedInboxReason, BlockedReasonVariant> = {
  pending_board_decision: "needs_decision",
  pending_user_decision: "needs_decision",
  missing_successful_run_disposition: "needs_decision",
  blocked_chain_stalled: "stalled",
  blocked_by_unassigned_issue: "needs_attention",
  blocked_by_assigned_backlog_issue: "needs_attention",
  blocked_by_cancelled_issue: "needs_attention",
  in_review_without_action_path: "needs_attention",
  invalid_review_participant: "needs_attention",
  open_recovery_issue: "recovery_required",
  external_owner_action: "external_wait",
  blocked_by_uninvokable_assignee: "owner_paused",
};

export const BLOCKED_REASON_VARIANT_ORDER: BlockedReasonVariant[] = [
  "needs_decision",
  "stalled",
  "needs_attention",
  "recovery_required",
  "external_wait",
  "owner_paused",
];

export const BLOCKED_VARIANT_LABELS: Record<BlockedReasonVariant, string> = {
  needs_decision: "Needs decision",
  stalled: "Blocked chain stalled",
  needs_attention: "Needs attention",
  recovery_required: "Recovery required",
  external_wait: "External wait",
  owner_paused: "Owner paused",
};

const BLOCKED_VARIANT_COPY: Record<BlockedReasonVariant, LocalizedText> = {
  needs_decision: { en: "Needs decision", zh: "需要决策" },
  stalled: { en: "Blocked chain stalled", zh: "阻塞链停滞" },
  needs_attention: { en: "Needs attention", zh: "需要关注" },
  recovery_required: { en: "Recovery required", zh: "需要恢复" },
  external_wait: { en: "External wait", zh: "等待外部" },
  owner_paused: { en: "Owner paused", zh: "负责人已暂停" },
};

const REASON_COPY: Record<IssueBlockedInboxReason, LocalizedText> = {
  pending_board_decision: { en: "Pending board decision", zh: "等待 board 决策" },
  pending_user_decision: { en: "Pending user decision", zh: "等待用户决策" },
  missing_successful_run_disposition: { en: "Pick disposition", zh: "选择处理方式" },
  blocked_chain_stalled: { en: "Blocked chain stalled", zh: "阻塞链停滞" },
  blocked_by_unassigned_issue: { en: "Unassigned blocker", zh: "未分配阻塞项" },
  blocked_by_assigned_backlog_issue: { en: "Parked blocker", zh: "搁置的阻塞项" },
  blocked_by_cancelled_issue: { en: "Cancelled blocker", zh: "已取消的阻塞项" },
  in_review_without_action_path: { en: "Review without action path", zh: "审核缺少行动路径" },
  invalid_review_participant: { en: "Invalid review participant", zh: "无效审核参与者" },
  open_recovery_issue: { en: "Recovery in progress", zh: "恢复处理中" },
  external_owner_action: { en: "External owner action", zh: "外部负责人操作" },
  blocked_by_uninvokable_assignee: { en: "Owner paused", zh: "负责人已暂停" },
};

const SEVERITY_RANK: Record<IssueBlockedInboxSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export type BlockedInboxBadgeTone = "muted" | "amber" | "red";

export function blockedReasonVariant(reason: IssueBlockedInboxReason): BlockedReasonVariant {
  return VARIANT_BY_REASON[reason] ?? "needs_attention";
}

export function blockedReasonLabel(reason: IssueBlockedInboxReason, language?: string): string {
  const copy = REASON_COPY[reason];
  return copy ? localizedText(copy, language) : localizedText({ en: "Stopped", zh: "已停止" }, language);
}

export function blockedVariantLabel(variant: BlockedReasonVariant, language?: string): string {
  return localizedText(BLOCKED_VARIANT_COPY[variant], language);
}

export function blockedSeverityRank(severity: IssueBlockedInboxSeverity): number {
  return SEVERITY_RANK[severity] ?? 9;
}

export function compareBlockedAttention(
  a: IssueBlockedInboxAttention,
  b: IssueBlockedInboxAttention,
): number {
  const sevDiff = blockedSeverityRank(a.severity) - blockedSeverityRank(b.severity);
  if (sevDiff !== 0) return sevDiff;
  const aSince = a.stoppedSinceAt ? new Date(a.stoppedSinceAt).getTime() : Number.POSITIVE_INFINITY;
  const bSince = b.stoppedSinceAt ? new Date(b.stoppedSinceAt).getTime() : Number.POSITIVE_INFINITY;
  const sinceDiff = aSince - bSince;
  return Number.isFinite(sinceDiff) ? sinceDiff : 0;
}

export interface BlockedInboxIssueRow {
  issue: Issue;
  attention: IssueBlockedInboxAttention;
  variant: BlockedReasonVariant;
  reasonLabel: string;
  stoppedAtMs: number | null;
}

export type BlockedInboxGroupBy = "blocker_type" | "none";
export type BlockedInboxSort = "urgency" | "most_recent" | "longest_stopped";

export const BLOCKED_GROUP_OPTIONS: readonly [BlockedInboxGroupBy, string][] = [
  ["blocker_type", "Blocker type"],
  ["none", "None"],
];

export const BLOCKED_SORT_OPTIONS: readonly [BlockedInboxSort, string][] = [
  ["urgency", "Most urgent"],
  ["most_recent", "Most recent"],
  ["longest_stopped", "Longest stopped"],
];

export interface BlockedInboxGroup {
  variant: BlockedReasonVariant;
  label: string;
  rows: BlockedInboxIssueRow[];
}

export function buildBlockedInboxRows(issues: readonly Issue[]): BlockedInboxIssueRow[] {
  const rows: BlockedInboxIssueRow[] = [];
  for (const issue of issues) {
    const attention = issue.blockedInboxAttention;
    if (!attention) continue;
    rows.push({
      issue,
      attention,
      variant: blockedReasonVariant(attention.reason),
      reasonLabel: blockedReasonLabel(attention.reason),
      stoppedAtMs: attention.stoppedSinceAt ? new Date(attention.stoppedSinceAt).getTime() : null,
    });
  }
  return rows;
}

function issueTimestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function blockedRowRecencyMs(row: BlockedInboxIssueRow): number {
  return row.stoppedAtMs ?? issueTimestampMs(row.issue.updatedAt) ?? 0;
}

function compareBlockedRowsByTitle(a: BlockedInboxIssueRow, b: BlockedInboxIssueRow): number {
  const byTitle = a.issue.title.localeCompare(b.issue.title);
  if (byTitle !== 0) return byTitle;
  return a.issue.id.localeCompare(b.issue.id);
}

export function compareBlockedRows(
  a: BlockedInboxIssueRow,
  b: BlockedInboxIssueRow,
  sort: BlockedInboxSort = "urgency",
): number {
  if (sort === "most_recent") {
    const recencyDiff = blockedRowRecencyMs(b) - blockedRowRecencyMs(a);
    if (recencyDiff !== 0) return recencyDiff;
    const attentionDiff = compareBlockedAttention(a.attention, b.attention);
    if (attentionDiff !== 0) return attentionDiff;
    return compareBlockedRowsByTitle(a, b);
  }

  if (sort === "longest_stopped") {
    const aStopped = a.stoppedAtMs ?? Number.POSITIVE_INFINITY;
    const bStopped = b.stoppedAtMs ?? Number.POSITIVE_INFINITY;
    const stoppedDiff = aStopped - bStopped;
    if (stoppedDiff !== 0) return stoppedDiff;
    const severityDiff = blockedSeverityRank(a.attention.severity) - blockedSeverityRank(b.attention.severity);
    if (severityDiff !== 0) return severityDiff;
    return compareBlockedRowsByTitle(a, b);
  }

  const attentionDiff = compareBlockedAttention(a.attention, b.attention);
  if (attentionDiff !== 0) return attentionDiff;
  const recencyDiff = blockedRowRecencyMs(b) - blockedRowRecencyMs(a);
  if (recencyDiff !== 0) return recencyDiff;
  return compareBlockedRowsByTitle(a, b);
}

export function sortBlockedInboxRows(
  rows: readonly BlockedInboxIssueRow[],
  sort: BlockedInboxSort = "urgency",
): BlockedInboxIssueRow[] {
  return [...rows].sort((a, b) => compareBlockedRows(a, b, sort));
}

export function groupBlockedInboxRows(
  rows: readonly BlockedInboxIssueRow[],
  sort: BlockedInboxSort = "urgency",
): BlockedInboxGroup[] {
  const buckets = new Map<BlockedReasonVariant, BlockedInboxIssueRow[]>();
  for (const row of rows) {
    const list = buckets.get(row.variant) ?? [];
    list.push(row);
    buckets.set(row.variant, list);
  }
  const groups: BlockedInboxGroup[] = [];
  for (const variant of BLOCKED_REASON_VARIANT_ORDER) {
    const list = buckets.get(variant);
    if (!list || list.length === 0) continue;
    const sorted = sortBlockedInboxRows(list, sort);
    groups.push({ variant, label: BLOCKED_VARIANT_LABELS[variant], rows: sorted });
  }
  return groups;
}

export function blockedRowMatchesSearch(row: BlockedInboxIssueRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.issue.title,
    row.issue.identifier ?? "",
    row.attention.owner.label ?? "",
    row.attention.action.label,
    row.attention.action.detail ?? "",
    row.reasonLabel,
    row.attention.leafIssue?.identifier ?? "",
    row.attention.leafIssue?.title ?? "",
    row.attention.recoveryIssue?.identifier ?? "",
    row.attention.recoveryIssue?.title ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function blockedBadgeTone(rows: readonly BlockedInboxIssueRow[]): BlockedInboxBadgeTone {
  if (rows.length === 0) return "muted";
  let highest: IssueBlockedInboxSeverity = "low";
  for (const row of rows) {
    if (blockedSeverityRank(row.attention.severity) < blockedSeverityRank(highest)) {
      highest = row.attention.severity;
    }
  }
  if (highest === "critical") return "red";
  if (highest === "high") return "amber";
  return "muted";
}

export function formatStoppedAge(
  stoppedSinceAt: string | null,
  now: number = Date.now(),
  language?: string,
): string {
  if (!stoppedSinceAt) return localizedText({ en: "stopped", zh: "已停止" }, language);
  const then = new Date(stoppedSinceAt).getTime();
  if (!Number.isFinite(then)) return localizedText({ en: "stopped", zh: "已停止" }, language);
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return localizedText({ en: "stopped just now", zh: "刚刚停止" }, language);
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return localizedText({ en: `stopped ${m}m`, zh: `已停止 ${m} 分钟` }, language);
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return localizedText({ en: `stopped ${h}h`, zh: `已停止 ${h} 小时` }, language);
  }
  if (seconds < 86_400 * 7) {
    const d = Math.floor(seconds / 86_400);
    return localizedText({ en: `stopped ${d}d`, zh: `已停止 ${d} 天` }, language);
  }
  if (seconds < 86_400 * 30) {
    const w = Math.floor(seconds / (86_400 * 7));
    return localizedText({ en: `stopped ${w}w`, zh: `已停止 ${w} 周` }, language);
  }
  const mo = Math.floor(seconds / (86_400 * 30));
  return localizedText({ en: `stopped ${mo}mo`, zh: `已停止 ${mo} 个月` }, language);
}
