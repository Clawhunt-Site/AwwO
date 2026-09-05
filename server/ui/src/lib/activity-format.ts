import type { Agent } from "@paperclipai/shared";
import type { LocalizedText } from "@/i18n/localized";
import type { CompanyUserProfile } from "./company-members";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityIssueReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
  localize?: (copy: LocalizedText) => string;
}

type Localize = (copy: LocalizedText) => string;

const defaultLocalize: Localize = (copy) => copy.en;

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.comment_cancelled": "cancelled a queued comment on",
  "issue.comment_deleted": "deleted a comment on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.document_created": "created document for",
  "issue.document_updated": "updated document on",
  "issue.document_locked": "locked document on",
  "issue.document_unlocked": "unlocked document on",
  "issue.document_deleted": "deleted document from",
  "issue.monitor_scheduled": "scheduled monitor on",
  "issue.monitor_triggered": "triggered monitor for",
  "issue.monitor_cleared": "cleared monitor on",
  "issue.monitor_skipped": "skipped monitor for",
  "issue.monitor_exhausted": "exhausted monitor on",
  "issue.monitor_recovery_wake_queued": "queued monitor recovery for",
  "issue.monitor_recovery_issue_created": "created monitor recovery for",
  "issue.monitor_escalated_to_board": "escalated monitor for",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
  "issue.successful_run_handoff_required": "flagged missing next step on",
  "issue.successful_run_handoff_resolved": "recorded next step chosen on",
  "issue.successful_run_handoff_escalated": "escalated missing next step on",
  "issue.accepted_plan_decomposition_updated": "updated accepted-plan decomposition on",
  "issue.recovery_action_opened": "opened a recovery action on",
  "issue.recovery_action_resolved": "resolved the recovery action on",
  "issue.recovery_action_escalated": "escalated the recovery action on",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.error_cleared": "cleared error on",
  "agent.terminated": "terminated",
  "agent.key_created": "created API key for",
  "agent.budget_updated": "updated budget for",
  "agent.runtime_session_reset": "reset session for",
  "heartbeat.invoked": "invoked heartbeat for",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "heartbeat.output_stale_source_resolved": "system-folded stale run on",
  "heartbeat.output_stale_recovery_recursion_refused": "refused recovery-on-recovery for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.reactivated": "reactivated",
  "company.budget_updated": "updated budget for",
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.comment_cancelled": "cancelled a queued comment",
  "issue.comment_deleted": "deleted a comment",
  "issue.feedback_vote_saved": "saved feedback on an AI output",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_locked": "locked a document",
  "issue.document_unlocked": "unlocked a document",
  "issue.document_deleted": "deleted a document",
  "issue.monitor_scheduled": "scheduled a monitor",
  "issue.monitor_triggered": "triggered a monitor",
  "issue.monitor_cleared": "cleared a monitor",
  "issue.monitor_skipped": "skipped a monitor",
  "issue.monitor_exhausted": "exhausted a monitor",
  "issue.monitor_recovery_wake_queued": "queued a monitor recovery wake",
  "issue.monitor_recovery_issue_created": "created a monitor recovery issue",
  "issue.monitor_escalated_to_board": "escalated a monitor to the board",
  "issue.deleted": "deleted the issue",
  "issue.successful_run_handoff_required": "Run finished without a clear next step",
  "issue.successful_run_handoff_resolved": "Next step chosen",
  "issue.successful_run_handoff_escalated": "Run finished without a next step - recovery escalated",
  "issue.recovery_action_opened": "Opened a source-scoped recovery action",
  "issue.recovery_action_resolved": "Resolved the recovery action",
  "issue.recovery_action_escalated": "Escalated the recovery action",
  "issue.accepted_plan_decomposition_updated": "updated the accepted-plan decomposition",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.error_cleared": "cleared the agent error",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "heartbeat.output_stale_source_resolved": "System folded a stale run",
  "heartbeat.output_stale_recovery_recursion_refused": "Refused recovery-on-recovery escalation",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

const ISSUE_ACTIVITY_LABELS_ZH: Record<string, string> = {
  "issue.created": "创建了任务",
  "issue.updated": "更新了任务",
  "issue.checked_out": "签出了任务",
  "issue.released": "释放了任务",
  "issue.comment_added": "添加了评论",
  "issue.comment_cancelled": "取消了排队评论",
  "issue.comment_deleted": "删除了评论",
  "issue.feedback_vote_saved": "保存了 AI 输出反馈",
  "issue.attachment_added": "添加了附件",
  "issue.attachment_removed": "移除了附件",
  "issue.document_created": "创建了文档",
  "issue.document_updated": "更新了文档",
  "issue.document_locked": "锁定了文档",
  "issue.document_unlocked": "解锁了文档",
  "issue.document_deleted": "删除了文档",
  "issue.monitor_scheduled": "安排了监控",
  "issue.monitor_triggered": "触发了监控",
  "issue.monitor_cleared": "清除了监控",
  "issue.monitor_skipped": "跳过了监控",
  "issue.monitor_exhausted": "耗尽了监控",
  "issue.monitor_recovery_wake_queued": "排队了监控恢复唤醒",
  "issue.monitor_recovery_issue_created": "创建了监控恢复任务",
  "issue.monitor_escalated_to_board": "已将监控升级到看板",
  "issue.deleted": "删除了任务",
  "issue.successful_run_handoff_required": "运行结束但缺少明确下一步",
  "issue.successful_run_handoff_resolved": "已选择下一步",
  "issue.successful_run_handoff_escalated": "运行结束但缺少下一步 - 已升级恢复",
  "issue.recovery_action_opened": "打开了来源范围恢复动作",
  "issue.recovery_action_resolved": "解决了恢复动作",
  "issue.recovery_action_escalated": "升级了恢复动作",
  "issue.accepted_plan_decomposition_updated": "更新了已接受计划拆解",
  "agent.created": "创建了 agent",
  "agent.updated": "更新了 agent",
  "agent.paused": "暂停了 agent",
  "agent.resumed": "恢复了 agent",
  "agent.error_cleared": "清除了 agent 错误",
  "agent.terminated": "终止了 agent",
  "heartbeat.invoked": "触发了心跳",
  "heartbeat.cancelled": "取消了心跳",
  "heartbeat.output_stale_source_resolved": "系统折叠了过期运行",
  "heartbeat.output_stale_recovery_recursion_refused": "拒绝了恢复递归升级",
  "approval.created": "请求了审批",
  "approval.approved": "已批准",
  "approval.rejected": "已拒绝",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function localizeStatusOrPriorityValue(value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, "_");
  return {
    none: "无",
    open: "待处理",
    todo: "待办",
    in_progress: "进行中",
    in_review: "待审阅",
    done: "已完成",
    completed: "已完成",
    cancelled: "已取消",
    canceled: "已取消",
    blocked: "已阻塞",
    low: "低",
    medium: "中",
    high: "高",
    urgent: "紧急",
  }[normalized] ?? value;
}

function localizeChangedEntityLabel(label: string): string {
  const exact = label.match(/^(blocker|reviewer|approver) (.+)$/);
  if (exact) {
    const [, type, name] = exact;
    return `${{
      blocker: "阻塞项",
      reviewer: "审查人",
      approver: "审批人",
    }[type]} ${name}`;
  }

  const plural = label.match(/^(\d+) (blockers|reviewers|approvers)$/);
  if (plural) {
    const [, count, type] = plural;
    return `${count} 个 ${{
      blockers: "阻塞项",
      reviewers: "审查人",
      approvers: "审批人",
    }[type]}`;
  }

  if (label === "blockers") return "阻塞项";
  if (label === "reviewers") return "审查人";
  if (label === "approvers") return "审批人";
  return label;
}

function localizeDecompositionSummary(summary: string): string {
  return summary
    .replace(/created (\d+) new/g, "新建 $1 个")
    .replace(/reused (\d+) existing/g, "复用 $1 个")
    .replace(/(\d+) requested/g, "请求 $1 个");
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityIssueReference(value: unknown): value is ActivityIssueReference {
  return asRecord(value) !== null;
}

function readParticipants(details: ActivityDetails, key: string): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readIssueReferences(details: ActivityDetails, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityIssueReference);
}

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions = {}): string {
  const localize = options.localize ?? defaultLocalize;
  if (!userId || userId === "local-board") return localize({ en: "Board", zh: "看板" });
  if (options.currentUserId && userId === options.currentUserId) return localize({ en: "You", zh: "你" });
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return `${localize({ en: "user", zh: "用户" })} ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? (options.localize ?? defaultLocalize)({ en: "agent", zh: "agent" });
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return "task";
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  return `${labels.length} ${plural}`;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function readStringArrayLength(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => typeof entry === "string" && entry.length > 0).length;
}

function formatAcceptedPlanDecompositionDetail(details: ActivityDetails): string | null {
  if (!details) return null;
  const status = typeof details.status === "string" ? details.status : null;
  const requested = readNumber(details.requestedChildCount);
  const totalChildren = readStringArrayLength(details.childIssueIds);
  const newlyCreated = readStringArrayLength(details.newlyCreatedChildIssueIds);
  const reused = Math.max(0, totalChildren - newlyCreated);
  const parts: string[] = [];
  if (newlyCreated > 0) parts.push(`created ${newlyCreated} new`);
  if (reused > 0) parts.push(`reused ${reused} existing`);
  if (parts.length === 0 && requested !== null) parts.push(`${requested} requested`);
  const summary = parts.length > 0 ? parts.join(", ") : null;
  if (status === "completed" && summary) return `decomposition completed (${summary})`;
  if (status === "completed") return "decomposition completed";
  if (status === "in_flight" && summary) return `decomposition in flight (${summary})`;
  return summary;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? `changed status from ${humanizeValue(from)} to ${humanizeValue(details.status)} on`
      : `changed status to ${humanizeValue(details.status)} on`;
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`
      : `changed priority to ${humanizeValue(details.priority)} on`;
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
        : `changed the status to ${humanizeValue(details.status)}`,
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
        : `changed the priority to ${humanizeValue(details.priority)}`,
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? `assigned the task to ${assigneeName}` : "unassigned the task");
  }
  if (details.title !== undefined) parts.push("updated the title");
  if (details.description !== undefined) parts.push("updated the description");

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? "updated blockers" : "updated blockers on";
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? "reviewer" : "approver";
    const plural = input.action === "issue.reviewers_updated" ? "reviewers" : "approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? `updated ${plural}` : `updated ${plural} on`;
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
}

function translateIssueActivityAction(action: string, text: string): string {
  const commaParts = text.split(", ");
  if (commaParts.length > 1) {
    return commaParts.map((part) => translateIssueActivityAction(action, part)).join("，");
  }

  let match = text.match(/^changed the status from (.+) to (.+)$/);
  if (match) return `将状态从 ${localizeStatusOrPriorityValue(match[1])} 改为 ${localizeStatusOrPriorityValue(match[2])}`;

  match = text.match(/^changed the status to (.+)$/);
  if (match) return `将状态改为 ${localizeStatusOrPriorityValue(match[1])}`;

  match = text.match(/^changed the priority from (.+) to (.+)$/);
  if (match) return `将优先级从 ${localizeStatusOrPriorityValue(match[1])} 改为 ${localizeStatusOrPriorityValue(match[2])}`;

  match = text.match(/^changed the priority to (.+)$/);
  if (match) return `将优先级改为 ${localizeStatusOrPriorityValue(match[1])}`;

  match = text.match(/^assigned the task to (.+)$/);
  if (match) return `将任务分配给 ${match[1]}`;

  if (text === "unassigned the task") return "取消了任务分配";
  if (text === "updated the title") return "更新了标题";
  if (text === "updated the description") return "更新了描述";

  match = text.match(/^added (.+)$/);
  if (match) return `添加了${localizeChangedEntityLabel(match[1])}`;

  match = text.match(/^removed (.+)$/);
  if (match) return `移除了${localizeChangedEntityLabel(match[1])}`;

  match = text.match(/^updated (blockers|reviewers|approvers)$/);
  if (match) return `更新了${localizeChangedEntityLabel(match[1])}`;

  match = text.match(/^decomposition completed \((.+)\)$/);
  if (match) return `拆解已完成（${localizeDecompositionSummary(match[1])}）`;

  if (text === "decomposition completed") return "拆解已完成";

  match = text.match(/^decomposition in flight \((.+)\)$/);
  if (match) return `拆解进行中（${localizeDecompositionSummary(match[1])}）`;

  match = text.match(/^(.+) for (.+)$/);
  if (match) {
    const [, base, serviceName] = match;
    const actionForBase = Object.entries(ISSUE_ACTIVITY_LABELS).find(([, value]) => value === base)?.[0];
    const baseZh = actionForBase ? ISSUE_ACTIVITY_LABELS_ZH[actionForBase] : null;
    if (baseZh) return `${baseZh}：${serviceName}`;
  }

  const base = ISSUE_ACTIVITY_LABELS[action];
  const baseZh = ISSUE_ACTIVITY_LABELS_ZH[action];
  if (base && baseZh && text.startsWith(`${base} `)) {
    return `${baseZh} ${text.slice(base.length + 1)}`;
  }

  return baseZh ?? text;
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  const finalize = (text: string) => options.localize
    ? options.localize({ en: text, zh: translateIssueActivityAction(action, text) })
    : text;

  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, options);
    if (issueUpdatedAction) return finalize(issueUpdatedAction);
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return finalize(structuredChange);

  if (action === "issue.accepted_plan_decomposition_updated") {
    const detail = formatAcceptedPlanDecompositionDetail(details);
    if (detail) return finalize(detail);
  }

  if (action.startsWith("issue.monitor_") && details) {
    const serviceName = typeof details.serviceName === "string" && details.serviceName.trim()
      ? details.serviceName.trim()
      : null;
    const base = ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
    return finalize(serviceName ? `${base} for ${serviceName}` : base);
  }

  if (
    (
      action === "issue.document_created" ||
      action === "issue.document_updated" ||
      action === "issue.document_locked" ||
      action === "issue.document_unlocked" ||
      action === "issue.document_deleted"
    ) &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return finalize(`${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`);
  }

  return finalize(ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " "));
}
