import { Link } from "@/lib/router";
import { resolveContentUrl } from "../api/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { deriveInitials } from "./Identity";
import { IssueReferenceActivitySummary } from "./IssueReferenceActivitySummary";
import { useLocalizedRelativeTime, useLocalizedText } from "@/i18n/localized";
import { cn } from "../lib/utils";
import { formatActivityVerb } from "../lib/activity-format";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "../lib/company-members";

const ACTIVITY_VERB_ZH_BY_ACTION: Record<string, string> = {
  "issue.created": "创建了",
  "issue.updated": "更新了",
  "issue.checked_out": "签出了",
  "issue.released": "释放了",
  "issue.comment_added": "评论了",
  "issue.comment_cancelled": "取消了排队评论",
  "issue.comment_deleted": "删除了评论",
  "issue.attachment_added": "添加了附件到",
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
  "issue.monitor_recovery_wake_queued": "排队了监控恢复",
  "issue.monitor_recovery_issue_created": "创建了监控恢复",
  "issue.monitor_escalated_to_board": "把监控升级到看板",
  "issue.commented": "评论了",
  "issue.deleted": "删除了",
  "issue.successful_run_handoff_required": "标记缺少下一步",
  "issue.successful_run_handoff_resolved": "记录了下一步选择",
  "issue.successful_run_handoff_escalated": "升级了缺少下一步的问题",
  "issue.accepted_plan_decomposition_updated": "更新了已接受计划拆解",
  "issue.recovery_action_opened": "打开了恢复动作",
  "issue.recovery_action_resolved": "解决了恢复动作",
  "issue.recovery_action_escalated": "升级了恢复动作",
  "issue.read_marked": "标记已读",
  "issue.read_unmarked": "取消已读标记",
  "issue.inbox_archived": "归档了收件箱项",
  "issue.inbox_unarchived": "取消归档收件箱项",
  "issue.feedback_vote_saved": "保存了反馈",
  "issue.work_product_created": "创建了工作产物",
  "issue.work_product_updated": "更新了工作产物",
  "issue.work_product_deleted": "删除了工作产物",
  "agent.created": "创建了",
  "agent.updated": "更新了",
  "agent.paused": "暂停了",
  "agent.resumed": "恢复了",
  "agent.error_cleared": "清除了错误",
  "agent.terminated": "终止了",
  "agent.key_created": "创建了 API key",
  "agent.budget_updated": "更新了预算",
  "agent.runtime_session_reset": "重置了会话",
  "agent.skills_synced": "同步了技能",
  "heartbeat.invoked": "触发了心跳",
  "heartbeat.cancelled": "取消了心跳",
  "heartbeat.output_stale_source_resolved": "折叠了过期运行",
  "heartbeat.output_stale_recovery_recursion_refused": "拒绝了恢复递归",
  "approval.created": "请求了审批",
  "approval.approved": "批准了",
  "approval.rejected": "拒绝了",
  "approval.revision_requested": "请求了修订",
  "approval.requester_wakeup_queued": "排队了请求者唤醒",
  "approval.requester_wakeup_failed": "请求者唤醒失败",
  "project.created": "创建了",
  "project.updated": "更新了",
  "project.deleted": "删除了",
  "goal.created": "创建了",
  "goal.updated": "更新了",
  "goal.deleted": "删除了",
  "cost.reported": "上报了成本",
  "cost.recorded": "记录了成本",
  "company.created": "创建了公司",
  "company.updated": "更新了公司",
  "company.archived": "归档了",
  "company.reactivated": "重新启用了",
  "company.budget_updated": "更新了预算",
  "company.skill_created": "创建了技能",
  "company.skill_deleted": "删除了技能",
  "environment_lease.acquired": "获取了环境租约",
  "environment_lease.released": "释放了环境租约",
  "environment.lease_acquired": "获取了环境租约",
  "environment.lease_released": "释放了环境租约",
};

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

  return label;
}

function translateStructuredVerb(verb: string): string | null {
  if (verb === "environment lease acquired") return "获取了环境租约";
  if (verb === "environment lease released") return "释放了环境租约";

  let match = verb.match(/^changed status from (.+) to (.+) on$/);
  if (match) return `将状态从 ${localizeStatusOrPriorityValue(match[1])} 改为 ${localizeStatusOrPriorityValue(match[2])}`;

  match = verb.match(/^changed status to (.+) on$/);
  if (match) return `将状态改为 ${localizeStatusOrPriorityValue(match[1])}`;

  match = verb.match(/^changed priority from (.+) to (.+) on$/);
  if (match) return `将优先级从 ${localizeStatusOrPriorityValue(match[1])} 改为 ${localizeStatusOrPriorityValue(match[2])}`;

  match = verb.match(/^changed priority to (.+) on$/);
  if (match) return `将优先级改为 ${localizeStatusOrPriorityValue(match[1])}`;

  match = verb.match(/^added (.+) to$/);
  if (match) return `添加了${localizeChangedEntityLabel(match[1])}到`;

  match = verb.match(/^removed (.+) from$/);
  if (match) return `移除了${localizeChangedEntityLabel(match[1])}从`;

  match = verb.match(/^updated (blockers|reviewers|approvers) on$/);
  if (match) return `更新了${localizeChangedEntityLabel(`2 ${match[1]}`).replace(/^2 个 /, "")}`;

  return null;
}

function localizeActivityVerb(
  action: string,
  verb: string,
  localize: ReturnType<typeof useLocalizedText>,
): string {
  return localize({
    en: verb,
    zh: translateStructuredVerb(verb) ?? ACTIVITY_VERB_ZH_BY_ACTION[action] ?? verb,
  });
}

function entityLink(entityType: string, entityId: string, name?: string | null): string | null {
  switch (entityType) {
    case "issue": return `/issues/${name ?? entityId}`;
    case "agent": return `/agents/${entityId}`;
    case "project": return `/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `/goals/${entityId}`;
    case "approval": return `/approvals/${entityId}`;
    default: return null;
  }
}

interface ActivityRowProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  className?: string;
}

export function ActivityRow({ event, agentMap, userProfileMap, entityNameMap, entityTitleMap, className }: ActivityRowProps) {
  const localize = useLocalizedText();
  const relativeTime = useLocalizedRelativeTime();
  const verb = localizeActivityVerb(
    event.action,
    formatActivityVerb(event.action, event.details, { agentMap, userProfileMap }),
    localize,
  );

  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (event.details as Record<string, unknown> | null)?.agentId as string | undefined
    : undefined;

  const name = isHeartbeatEvent
    ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : null)
    : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : entityLink(event.entityType, event.entityId, name);

  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const userProfile = event.actorType === "user" ? userProfileMap?.get(event.actorId) : null;
  const userProfileLabel = userProfile?.label === "Board"
    ? localize({ en: "Board", zh: "看板" })
    : userProfile?.label;
  const actorName = actor?.name ?? (
    event.actorType === "system"
      ? localize({ en: "System", zh: "系统" })
      : userProfileLabel ?? (
        event.actorType === "user"
          ? localize({ en: "Board", zh: "看板" })
          : event.actorId || localize({ en: "Unknown", zh: "未知" })
      )
  );
  const actorAvatarUrl = userProfile?.image ?? null;

  const inner = (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Avatar size="xs">
            {actorAvatarUrl && <AvatarImage src={resolveContentUrl(actorAvatarUrl)} alt={actorName} />}
            <AvatarFallback>{deriveInitials(actorName)}</AvatarFallback>
          </Avatar>
          <p className="min-w-0 flex-1 truncate">
            <span>{actorName}</span>
            <span className="text-muted-foreground"> {verb} </span>
            {name && <span className="font-medium">{name}</span>}
            {entityTitle && <span className="text-muted-foreground"> — {entityTitle}</span>}
          </p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">{relativeTime(event.createdAt)}</span>
      </div>
      <IssueReferenceActivitySummary event={event} />
    </div>
  );

  const classes = cn(
    "px-4 py-2 text-sm",
    link && "cursor-pointer hover:bg-accent/50 transition-colors",
    className,
  );

  if (link) {
    return (
      <Link to={link} className={cn(classes, "no-underline text-inherit block")}>
        {inner}
      </Link>
    );
  }

  return (
    <div className={classes}>
      {inner}
    </div>
  );
}
