import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed, FileText, GitBranch, ImagePlus, ListChecks, Loader2, MessageSquareQuote, X, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { formatAssigneeUserLabel } from "../lib/assignees";
import {
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  countSuggestedTaskNodes,
  getCheckboxConfirmationSelectedLabels,
  getQuestionAnswerLabels,
  type AskUserQuestionsAnswer,
  type AskUserQuestionsInteraction,
  type IssueThreadInteraction,
  type RequestCheckboxConfirmationInteraction,
  type RequestConfirmationInteraction,
  type RequestConfirmationTarget,
  type SuggestTasksInteraction,
  type SuggestTasksResultCreatedTask,
  type SuggestedTaskDraft,
  type SuggestedTaskTreeNode,
} from "../lib/issue-thread-interactions";
import { cn, formatDateTime, formatShortDate } from "../lib/utils";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { PriorityIcon } from "./PriorityIcon";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useLocalizedText, type LocalizedText } from "@/i18n/localized";

const OTHER_ANSWER_ID = "__paperclip_other__";

interface IssueThreadInteractionCardProps {
  interaction: IssueThreadInteraction;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onAcceptInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction:
      | SuggestTasksInteraction
      | RequestConfirmationInteraction
      | RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  externalReferences?: MarkdownExternalReferenceMap;
}

function resolveActorLabel(args: {
  agentId?: string | null;
  userId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  localize?: (copy: LocalizedText) => string;
}) {
  const { agentId, userId, agentMap, currentUserId, userLabelMap, localize } = args;
  if (agentId) {
    return agentMap?.get(agentId)?.name ?? agentId.slice(0, 8);
  }
  if (userId) {
    return formatAssigneeUserLabel(userId, currentUserId, userLabelMap) ?? (localize ? localize({ en: "Board", zh: "看板" }) : "Board");
  }
  return localize ? localize({ en: "Unknown", zh: "未知" }) : "Unknown";
}

function statusLabel(status: IssueThreadInteraction["status"], localize?: (copy: LocalizedText) => string) {
  switch (status) {
    case "pending":
      return localize ? localize({ en: "Pending", zh: "待处理" }) : "Pending";
    case "accepted":
      return localize ? localize({ en: "Accepted", zh: "已接受" }) : "Accepted";
    case "rejected":
      return localize ? localize({ en: "Rejected", zh: "已拒绝" }) : "Rejected";
    case "answered":
      return localize ? localize({ en: "Answered", zh: "已回答" }) : "Answered";
    case "cancelled":
      return localize ? localize({ en: "Cancelled", zh: "已取消" }) : "Cancelled";
    case "expired":
      return localize ? localize({ en: "Expired", zh: "已过期" }) : "Expired";
    case "failed":
      return localize ? localize({ en: "Failed", zh: "失败" }) : "Failed";
    default:
      return status;
  }
}

function interactionKindLabel(kind: IssueThreadInteraction["kind"], localize?: (copy: LocalizedText) => string) {
  switch (kind) {
    case "suggest_tasks":
      return localize ? localize({ en: "Suggested tasks", zh: "建议任务" }) : "Suggested tasks";
    case "ask_user_questions":
      return localize ? localize({ en: "Ask user questions", zh: "询问用户" }) : "Ask user questions";
    case "request_confirmation":
      return localize ? localize({ en: "Confirmation", zh: "确认" }) : "Confirmation";
    case "request_checkbox_confirmation":
      return localize ? localize({ en: "Checkbox confirmation", zh: "勾选确认" }) : "Checkbox confirmation";
    default:
      return kind;
  }
}

function planStatusLabel(status: IssueThreadInteraction["status"], localize: (copy: LocalizedText) => string) {
  switch (status) {
    case "accepted":
    case "answered":
      return localize({ en: "Approved", zh: "已批准" });
    case "rejected":
    case "cancelled":
      return localize({ en: "Changes requested", zh: "已请求修改" });
    case "failed":
    case "expired":
      return localize({ en: "Expired", zh: "已过期" });
    default:
      return localize({ en: "In review", zh: "评审中" });
  }
}

function statusIcon(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "accepted":
    case "answered":
      return CheckCircle2;
    case "rejected":
    case "cancelled":
    case "failed":
      return XCircle;
    case "expired":
      return AlertTriangle;
    default:
      return CircleDashed;
  }
}

function statusClasses(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "accepted":
    case "answered":
      return {
        shell: "border-emerald-400/70 bg-transparent",
        badge: "border-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100",
      };
    case "rejected":
    case "cancelled":
      return {
        shell: "border-rose-400/70 bg-transparent",
        badge: "border-rose-500/60 bg-rose-500/10 text-rose-900 dark:bg-rose-500/15 dark:text-rose-100",
      };
    case "failed":
    case "expired":
      return {
        shell: "border-amber-400/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
      };
    default:
      return {
        shell: "border-sky-500/70 bg-transparent",
        badge: "border-sky-500/70 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
      };
  }
}

/**
 * A confirmation that targets the issue's `plan` document renders as a distinct
 * plan card (PAP-95g): a full state-coloured outline — violet while in review,
 * green once approved, red when changes are requested (PAP-75 palette) — with no
 * left stripe, so plans stand out from comments and status rows.
 */
function isPlanConfirmation(interaction: IssueThreadInteraction): boolean {
  if (interaction.kind !== "request_confirmation") return false;
  const target = interaction.payload.target;
  return target?.type === "issue_document" && target?.key === "plan";
}

function planStatusClasses(status: IssueThreadInteraction["status"]) {
  switch (status) {
    case "accepted":
    case "answered":
      return {
        shell: "border-2 border-green-500/80 bg-transparent",
        badge: "border-green-500/60 bg-green-500/10 text-green-900 dark:bg-green-500/15 dark:text-green-100",
        label: "Approved",
        Icon: CheckCircle2,
      };
    case "rejected":
    case "cancelled":
      return {
        shell: "border-2 border-red-500/80 bg-transparent",
        badge: "border-red-500/60 bg-red-500/10 text-red-900 dark:bg-red-500/15 dark:text-red-100",
        label: "Changes requested",
        Icon: XCircle,
      };
    case "failed":
    case "expired":
      return {
        shell: "border-2 border-amber-500/70 bg-transparent",
        badge: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
        label: "Expired",
        Icon: AlertTriangle,
      };
    default:
      return {
        shell: "border-2 border-violet-500/80 bg-transparent",
        badge: "border-violet-500/60 bg-violet-500/10 text-violet-900 dark:bg-violet-500/15 dark:text-violet-100",
        label: "In review",
        Icon: FileText,
      };
  }
}

function TaskField({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "subtle";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]",
        tone === "default"
          ? "border-border/70 bg-transparent text-foreground"
          : "border-border/60 bg-transparent text-muted-foreground",
      )}
    >
      {label}: {value}
    </span>
  );
}

function createdTaskMap(
  createdTasks: readonly SuggestTasksResultCreatedTask[] | undefined,
) {
  return new Map(
    (createdTasks ?? []).map((entry) => [entry.clientKey, entry] as const),
  );
}

function TaskTreeNode({
  node,
  createdByClientKey,
  agentMap,
  currentUserId,
  userLabelMap,
  depth = 0,
  selectedClientKeys,
  skippedClientKeys,
  showSelection,
  localize,
  onToggleSelection,
}: {
  node: SuggestedTaskTreeNode;
  createdByClientKey: ReadonlyMap<string, SuggestTasksResultCreatedTask>;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  depth?: number;
  selectedClientKeys?: ReadonlySet<string>;
  skippedClientKeys?: ReadonlySet<string>;
  showSelection?: boolean;
  localize: (copy: LocalizedText) => string;
  onToggleSelection?: (node: SuggestedTaskTreeNode, checked: boolean) => void;
}) {
  const visibleChildren = node.children.filter((child) => !child.task.hiddenInPreview);
  const hiddenChildCount = node.children
    .filter((child) => child.task.hiddenInPreview)
    .reduce((sum, child) => sum + countSuggestedTaskNodes(child), 0);
  const createdTask = createdByClientKey.get(node.task.clientKey);
  const isSelected = selectedClientKeys?.has(node.task.clientKey) ?? false;
  const isSkipped = skippedClientKeys?.has(node.task.clientKey) ?? false;
  const assigneeLabel = resolveActorLabel({
    agentId: node.task.assigneeAgentId,
    userId: node.task.assigneeUserId,
    agentMap,
    currentUserId,
    userLabelMap,
    localize,
  });
  const hasExplicitAssignee = Boolean(
    node.task.assigneeAgentId || node.task.assigneeUserId,
  );
  const labels = node.task.labels ?? [];
  const hasMetadata = hasExplicitAssignee
    || Boolean(node.task.billingCode)
    || Boolean(node.task.projectId)
    || labels.length > 0;

  return (
    <>
      <div
        className={cn(
          "relative border-b border-border/60 px-3 py-2.5 last:border-b-0",
          depth > 0 && "before:absolute before:left-3 before:top-0 before:h-full before:w-px before:bg-border/70",
        )}
        style={depth > 0 ? { paddingLeft: `${depth * 24 + 12}px` } : undefined}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              {showSelection ? (
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={(checked) => onToggleSelection?.(node, checked === true)}
                  aria-label={`Include ${node.task.title}`}
                  className="mt-0.5"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  {node.task.priority ? (
                    <PriorityIcon
                      priority={node.task.priority}
                      className="mt-px"
                    />
                  ) : null}
                  <div className="min-w-0 truncate text-sm font-medium text-foreground">
                    {node.task.title}
                  </div>
                </div>
                {depth > 0 ? (
                  <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Child task
                  </div>
                ) : null}
                {node.task.description ? (
                  <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                    {node.task.description}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {createdTask?.issueId ? (
            <Link
              to={`/issues/${createdTask.identifier ?? createdTask.issueId}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-900 transition-colors hover:bg-emerald-500/15 dark:text-emerald-100"
            >
              {createdTask.identifier ?? createdTask.issueId.slice(0, 8)}
              <ChevronRight className="h-3 w-3" />
            </Link>
          ) : isSkipped ? (
            <span className="inline-flex shrink-0 items-center rounded-sm border border-amber-500/60 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-900 dark:text-amber-100">
              {localize({ en: "Skipped", zh: "已跳过" })}
            </span>
          ) : null}
        </div>

        {hasMetadata ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hasExplicitAssignee ? (
              <TaskField label={localize({ en: "Assignee", zh: "负责人" })} value={assigneeLabel} />
            ) : null}
            {node.task.billingCode ? (
              <TaskField label={localize({ en: "Billing", zh: "计费" })} value={node.task.billingCode} />
            ) : null}
            {node.task.projectId ? (
              <TaskField label={localize({ en: "Project", zh: "项目" })} value={node.task.projectId} tone="subtle" />
            ) : null}
            {labels.map((label) => (
              <TaskField key={label} label={localize({ en: "Label", zh: "标签" })} value={label} tone="subtle" />
            ))}
          </div>
        ) : null}

        {hiddenChildCount > 0 ? (
          <div className="mt-2 flex items-center gap-2 rounded-sm border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span>
              {hiddenChildCount === 1
                ? "1 follow-on task hidden in preview"
                : `${hiddenChildCount} follow-on tasks hidden in preview`}
            </span>
          </div>
        ) : null}
      </div>

      {visibleChildren.length > 0 ? (
        <>
          {visibleChildren.map((child) => (
            <TaskTreeNode
              key={child.task.clientKey}
              node={child}
              createdByClientKey={createdByClientKey}
              agentMap={agentMap}
              currentUserId={currentUserId}
              userLabelMap={userLabelMap}
              depth={depth + 1}
              selectedClientKeys={selectedClientKeys}
              skippedClientKeys={skippedClientKeys}
              showSelection={showSelection}
              localize={localize}
              onToggleSelection={onToggleSelection}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function SuggestTasksCard({
  interaction,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
}: {
  interaction: SuggestTasksInteraction;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  onAcceptInteraction?: (
    interaction: SuggestTasksInteraction,
    selectedClientKeys?: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: SuggestTasksInteraction,
    reason?: string,
  ) => Promise<void> | void;
}) {
  const localize = useLocalizedText();
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(
    interaction.result?.rejectionReason ?? "",
  );

  useEffect(() => {
    setRejectReason(interaction.result?.rejectionReason ?? "");
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.result?.rejectionReason, interaction.status]);

  const roots = useMemo(
    () =>
      buildSuggestedTaskTree(interaction.payload.tasks).filter(
        (node) => !node.task.hiddenInPreview,
      ),
    [interaction.payload.tasks],
  );
  const createdByClientKey = useMemo(
    () => createdTaskMap(interaction.result?.createdTasks),
    [interaction.result?.createdTasks],
  );
  const skippedClientKeys = useMemo(
    () => new Set(interaction.result?.skippedClientKeys ?? []),
    [interaction.result?.skippedClientKeys],
  );
  const totalTasks = interaction.payload.tasks.length;
  const [selectedClientKeys, setSelectedClientKeys] = useState<Set<string>>(
    () => new Set(interaction.payload.tasks.map((task) => task.clientKey)),
  );
  const taskSelectionSeed = useMemo(
    () => interaction.payload.tasks.map((task) => task.clientKey).join("\n"),
    [interaction.payload.tasks],
  );

  useEffect(() => {
    setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)));
  }, [interaction.id, interaction.status, taskSelectionSeed]);

  const taskByClientKey = useMemo(
    () => new Map(interaction.payload.tasks.map((task) => [task.clientKey, task] as const)),
    [interaction.payload.tasks],
  );
  const selectedCount = selectedClientKeys.size;
  const createdCount = interaction.result?.createdTasks?.length ?? 0;
  const skippedCount = interaction.result?.skippedClientKeys?.length ?? 0;

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    try {
      await onAcceptInteraction(interaction, [...selectedClientKeys]);
    } finally {
      setWorking(null);
    }
  }

  async function handleReject() {
    if (!onRejectInteraction) return;
    setWorking("reject");
    try {
      await onRejectInteraction(interaction, rejectReason.trim() || undefined);
      setRejecting(false);
    } finally {
      setWorking(null);
    }
  }

  function handleToggleSelection(node: SuggestedTaskTreeNode, checked: boolean) {
    const subtreeClientKeys = collectSuggestedTaskClientKeys(node);
    setSelectedClientKeys((current) => {
      const next = new Set(current);
      if (!checked) {
        for (const clientKey of subtreeClientKeys) {
          next.delete(clientKey);
        }
        return next;
      }

      for (const clientKey of subtreeClientKeys) {
        next.add(clientKey);
      }

      let parentClientKey = taskByClientKey.get(node.task.clientKey)?.parentClientKey ?? null;
      while (parentClientKey) {
        next.add(parentClientKey);
        parentClientKey = taskByClientKey.get(parentClientKey)?.parentClientKey ?? null;
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{localize({ en: totalTasks === 1 ? "1 draft issue" : `${totalTasks} draft issues`, zh: `${totalTasks} 个草稿任务` })}</span>
        {interaction.payload.defaultParentId ? (
          <TaskField label={localize({ en: "Default parent", zh: "默认父级" })} value={interaction.payload.defaultParentId} tone="subtle" />
        ) : null}
      </div>

      <div className="overflow-hidden border border-border/70">
        {roots.map((root) => (
          <TaskTreeNode
            key={root.task.clientKey}
            node={root}
            createdByClientKey={createdByClientKey}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            selectedClientKeys={selectedClientKeys}
            skippedClientKeys={skippedClientKeys}
            showSelection={interaction.status === "pending"}
            localize={localize}
            onToggleSelection={handleToggleSelection}
          />
        ))}
      </div>

      {interaction.status === "accepted" ? (
        <div className="rounded-sm border border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {localize({ en: "Resolution summary", zh: "处理摘要" })}
          </div>
          <p className="mt-1 leading-6">
            {skippedCount > 0
              ? localize({
                en: `Created ${createdCount} draft ${createdCount === 1 ? "issue" : "issues"} and skipped ${skippedCount} during review.`,
                zh: `已创建 ${createdCount} 个草稿任务，并在评审中跳过 ${skippedCount} 个。`,
              })
              : localize({
                en: `Created all ${createdCount} draft ${createdCount === 1 ? "issue" : "issues"}.`,
                zh: `已创建全部 ${createdCount} 个草稿任务。`,
              })}
          </p>
        </div>
      ) : null}

      {interaction.status === "rejected" ? (
        <div className="rounded-sm border border-rose-500/60 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-100">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-rose-700">
            {localize({ en: "Rejection reason", zh: "拒绝原因" })}
          </div>
          <p className={cn(
            "mt-1 leading-6",
            !interaction.result?.rejectionReason && "text-rose-900/75",
          )}>
            {interaction.result?.rejectionReason || localize({ en: "No reason provided.", zh: "未提供原因。" })}
          </p>
        </div>
      ) : null}

      {interaction.status === "pending" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {selectedCount === totalTasks
                  ? localize({ en: `All ${totalTasks} draft ${totalTasks === 1 ? "issue" : "issues"} selected`, zh: `已选择全部 ${totalTasks} 个草稿任务` })
                  : localize({ en: `${selectedCount} of ${totalTasks} draft ${totalTasks === 1 ? "issue" : "issues"} selected`, zh: `已选择 ${selectedCount}/${totalTasks} 个草稿任务` })}
              </span>
              {selectedCount < totalTasks ? (
                <span>
                  {localize({
                    en: `${totalTasks - selectedCount} will be skipped if you accept this interaction.`,
                    zh: `接受此交互后将跳过 ${totalTasks - selectedCount} 个。`,
                  })}
                </span>
              ) : null}
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button
                size="sm"
                disabled={!onAcceptInteraction || working !== null || selectedCount === 0}
                onClick={() => void handleAccept()}
              >
                {working === "accept" ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {localize({ en: "Accepting...", zh: "正在接受..." })}
                  </>
                ) : (
                  selectedCount === totalTasks
                    ? localize({ en: "Accept drafts", zh: "接受草稿" })
                    : localize({ en: "Accept selected drafts", zh: "接受选中草稿" })
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!onRejectInteraction || working !== null}
                onClick={() => setRejecting((current) => !current)}
              >
                {localize({ en: "Reject", zh: "拒绝" })}
              </Button>
              {selectedCount < totalTasks ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working !== null}
                  onClick={() => setSelectedClientKeys(new Set(interaction.payload.tasks.map((task) => task.clientKey)))}
                >
                  {localize({ en: "Reset selection", zh: "重置选择" })}
                </Button>
              ) : null}
            </div>
          </div>

          {rejecting ? (
            <div className="space-y-3">
              <Textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder={localize({ en: "Add a short reason for rejecting this suggestion", zh: "简要说明拒绝此建议的原因" })}
                className="min-h-24 bg-background text-sm"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onRejectInteraction || working !== null}
                  onClick={() => void handleReject()}
                >
                  {working === "reject" ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {localize({ en: "Saving...", zh: "正在保存..." })}
                    </>
                  ) : (
                    localize({ en: "Save rejection", zh: "保存拒绝" })
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function QuestionOptionButton({
  id,
  label,
  description,
  selected,
  selectionMode,
  onClick,
}: {
  id: string;
  label: string;
  description?: string | null;
  selected: boolean;
  selectionMode: "single" | "multi";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={selectionMode === "single" ? "radio" : "checkbox"}
      aria-checked={selected}
      className={cn(
        "w-full rounded-sm border px-4 py-3 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected
          ? "border-sky-500/80 bg-sky-500/10 text-sky-950 dark:border-sky-400/80 dark:bg-sky-400/15 dark:text-sky-50"
          : "border-border/70 bg-transparent text-foreground hover:border-sky-500/70 hover:bg-sky-500/10 dark:hover:border-sky-400/70 dark:hover:bg-sky-400/10",
      )}
      id={id}
      onClick={onClick}
    >
      <div
        className={cn(
          "text-sm font-medium",
          selected ? "text-sky-950 dark:text-sky-50" : "text-foreground",
        )}
      >
        {label}
      </div>
      {description ? (
        <div
          className={cn(
            "mt-1 text-sm leading-6",
            selected
              ? "text-sky-900/80 dark:text-sky-100/80"
              : "text-muted-foreground",
          )}
        >
          {description}
        </div>
      ) : null}
    </button>
  );
}

function AskUserQuestionsCard({
  interaction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  externalReferences,
}: {
  interaction: AskUserQuestionsInteraction;
  onSubmitInteractionAnswers?: (
    interaction: AskUserQuestionsInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => Promise<void> | void;
  onCancelInteraction?: (
    interaction: AskUserQuestionsInteraction,
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const localize = useLocalizedText();
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? []).map((answer) => [
        answer.questionId,
        [...answer.optionIds],
      ]),
    ),
  );
  const [draftOtherAnswers, setDraftOtherAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? [])
        .filter((answer) => answer.otherText)
        .map((answer) => [answer.questionId, answer.otherText ?? ""]),
    ),
  );
  const [otherActiveQuestions, setOtherActiveQuestions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      (interaction.result?.answers ?? [])
        .filter((answer) => answer.otherText)
        .map((answer) => [answer.questionId, true]),
    ),
  );
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    setDraftAnswers(
      Object.fromEntries(
        (interaction.result?.answers ?? []).map((answer) => [
          answer.questionId,
          [...answer.optionIds],
        ]),
      ),
    );
    setDraftOtherAnswers(
      Object.fromEntries(
        (interaction.result?.answers ?? [])
          .filter((answer) => answer.otherText)
          .map((answer) => [answer.questionId, answer.otherText ?? ""]),
      ),
    );
    setOtherActiveQuestions(
      Object.fromEntries(
        (interaction.result?.answers ?? [])
          .filter((answer) => answer.otherText)
          .map((answer) => [answer.questionId, true]),
      ),
    );
  }, [interaction.result?.answers]);

  const questions = interaction.payload.questions;
  const requiredQuestions = questions.filter((question) => question.required);
  const canSubmit = requiredQuestions.every(
    (question) =>
      (draftAnswers[question.id] ?? []).length > 0
      || (
        otherActiveQuestions[question.id] === true
        && (draftOtherAnswers[question.id]?.trim().length ?? 0) > 0
      ),
  );

  function toggleOption(questionId: string, optionId: string, selectionMode: "single" | "multi") {
    if (optionId === OTHER_ANSWER_ID) {
      setOtherActiveQuestions((current) => ({
        ...current,
        [questionId]: !current[questionId],
      }));
      if (selectionMode === "single") {
        setDraftAnswers((current) => ({ ...current, [questionId]: [] }));
      }
      return;
    }

    setDraftAnswers((current) => {
      const existing = current[questionId] ?? [];
      if (selectionMode === "single") {
        return { ...current, [questionId]: [optionId] };
      }
      const next = existing.includes(optionId)
        ? existing.filter((value) => value !== optionId)
        : [...existing, optionId];
      return { ...current, [questionId]: next };
    });
    if (selectionMode === "single") {
      setOtherActiveQuestions((current) => ({ ...current, [questionId]: false }));
    }
  }

  async function handleSubmit() {
    if (!onSubmitInteractionAnswers || !canSubmit) return;
    setWorking(true);
    try {
      await onSubmitInteractionAnswers(
        interaction,
        questions.map((question) => {
          const otherText = otherActiveQuestions[question.id] === true
            ? draftOtherAnswers[question.id]?.trim() ?? ""
            : "";
          return {
            questionId: question.id,
            optionIds: draftAnswers[question.id] ?? [],
            ...(otherText ? { otherText } : {}),
          };
        }),
      );
    } finally {
      setWorking(false);
    }
  }

  async function handleCancel() {
    if (!onCancelInteraction) return;
    setCancelling(true);
    try {
      await onCancelInteraction(interaction);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 font-medium uppercase tracking-[0.16em] text-foreground/70">
          <MessageSquareQuote className="h-3 w-3" />
          {localize({ en: "Ask user questions", zh: "询问用户" })}
        </span>
        <span>
          {questions.length === 1
            ? localize({ en: "1 question", zh: "1 个问题" })
            : localize({ en: `${questions.length} questions`, zh: `${questions.length} 个问题` })}
        </span>
      </div>

      {interaction.status === "pending" ? (
        <div className="space-y-4">
          {questions.map((question, index) => (
            <div
              key={question.id}
              className="rounded-2xl border border-border/70 bg-background/82 p-4 shadow-[0_18px_42px_rgba(15,23,42,0.06)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {localize({ en: `Question ${index + 1}`, zh: `问题 ${index + 1}` })}
                  </div>
                  <div
                    id={`${interaction.id}-${question.id}-prompt`}
                    className="mt-1 text-sm font-semibold text-foreground"
                  >
                    {question.prompt}
                  </div>
                  {question.helpText ? (
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {question.helpText}
                    </p>
                  ) : null}
                </div>
                <TaskField
                  label={question.selectionMode === "single" ? localize({ en: "Pick", zh: "选择" }) : localize({ en: "Pick many", zh: "多选" })}
                  value={question.required ? localize({ en: "Required", zh: "必填" }) : localize({ en: "Optional", zh: "可选" })}
                  tone="subtle"
                />
              </div>

              <div className="mt-3 space-y-3">
                <div
                  className="grid gap-3"
                  role={question.selectionMode === "single" ? "radiogroup" : "group"}
                  aria-labelledby={`${interaction.id}-${question.id}-prompt`}
                >
                  {question.options.map((option) => (
                    <QuestionOptionButton
                      key={option.id}
                      id={`${interaction.id}-${question.id}-${option.id}`}
                      label={option.label}
                      description={option.description}
                      selected={(draftAnswers[question.id] ?? []).includes(option.id)}
                      selectionMode={question.selectionMode}
                      onClick={() =>
                        toggleOption(question.id, option.id, question.selectionMode)}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  id={`${interaction.id}-${question.id}-other`}
                  aria-expanded={otherActiveQuestions[question.id] === true}
                  className={cn(
                    "text-sm font-medium underline underline-offset-4 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    otherActiveQuestions[question.id]
                      ? "text-sky-700 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() =>
                    toggleOption(question.id, OTHER_ANSWER_ID, question.selectionMode)}
                >
                  {localize({ en: "Other", zh: "其他" })}
                </button>
                {otherActiveQuestions[question.id] ? (
                  <Textarea
                    aria-label={localize({ en: `Other answer for ${question.prompt}`, zh: `${question.prompt} 的其他回答` })}
                    value={draftOtherAnswers[question.id] ?? ""}
                    onChange={(event) =>
                      setDraftOtherAnswers((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))}
                    placeholder={localize({ en: "Type your answer", zh: "输入你的回答" })}
                    className="min-h-24 bg-background text-sm"
                  />
                ) : null}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/75 p-4">
            <div className="text-sm text-muted-foreground">
              {localize({ en: "Submit once after you finish the full form.", zh: "完成整个表单后再统一提交。" })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onCancelInteraction ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || cancelling}
                  onClick={() => void handleCancel()}
                >
                  {cancelling ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {localize({ en: "Cancelling...", zh: "正在取消..." })}
                    </>
                  ) : (
                    localize({ en: "Cancel question", zh: "取消问题" })
                  )}
                  </Button>
                ) : null}
              <Button
                size="sm"
                disabled={!onSubmitInteractionAnswers || !canSubmit || working || cancelling}
                onClick={() => void handleSubmit()}
              >
                {working ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    {localize({ en: "Submitting...", zh: "正在提交..." })}
                  </>
                ) : (
                  interaction.payload.submitLabel ?? localize({ en: "Submit answers", zh: "提交回答" })
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : interaction.status === "cancelled" ? (
        <div className="rounded-2xl border border-rose-300/60 bg-rose-50/85 p-4 text-sm leading-6 text-rose-950 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100">
          <div className="font-semibold">{localize({ en: "Question cancelled", zh: "问题已取消" })}</div>
          {interaction.result?.cancellationReason ? (
            <p className="mt-1">{interaction.result.cancellationReason}</p>
          ) : (
            <p className="mt-1">{localize({ en: "No answer was recorded.", zh: "未记录回答。" })}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {questions.map((question) => {
            const labels = getQuestionAnswerLabels({
              question,
              answers: interaction.result?.answers ?? [],
            });
            return (
              <div
                key={question.id}
                className="rounded-2xl border border-border/70 bg-background/82 p-4"
              >
                <div className="text-sm font-semibold text-foreground">
                  {question.prompt}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {labels.length > 0 ? (
                    labels.map((label) => (
                      <TaskField key={label} label={localize({ en: "Answer", zh: "回答" })} value={label} />
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">{localize({ en: "No answer recorded.", zh: "未记录回答。" })}</span>
                  )}
                </div>
              </div>
            );
          })}

          {interaction.result?.summaryMarkdown ? (
            <div className="rounded-2xl border border-emerald-300/60 bg-emerald-50/85 p-4">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                {localize({ en: "Submitted summary", zh: "已提交摘要" })}
              </div>
              <MarkdownBody externalReferences={externalReferences}>{interaction.result.summaryMarkdown}</MarkdownBody>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function requestConfirmationTargetLabel(target: RequestConfirmationTarget) {
  if (target.label) return target.label;
  const revision = target.revisionNumber ? ` v${target.revisionNumber}` : "";
  if (target.type === "issue_document" && target.key === "plan") {
    return `Plan${revision}`;
  }
  return `${target.key}${revision}`;
}

function requestConfirmationTargetHref({
  interaction,
  target,
}: {
  interaction: Pick<IssueThreadInteraction, "issueId">;
  target: RequestConfirmationTarget;
}) {
  if (target.href) return target.href;
  if (target.type === "issue_document") {
    const issueId = target.issueId ?? interaction.issueId;
    return `/issues/${issueId}#document-${encodeURIComponent(target.key)}`;
  }
  return null;
}

function RequestConfirmationTargetChip({
  interaction,
  target,
  tone = "default",
}: {
  interaction: Pick<IssueThreadInteraction, "issueId">;
  target: RequestConfirmationTarget | null | undefined;
  tone?: "default" | "subtle";
}) {
  if (!target) return null;

  const href = requestConfirmationTargetHref({ interaction, target });
  const className = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]",
    tone === "default"
      ? "border-border/70 bg-transparent text-foreground"
      : "border-border/60 bg-transparent text-muted-foreground",
    href && "transition-colors hover:border-sky-500/70 hover:bg-sky-500/10",
  );
  const content = (
    <>
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{requestConfirmationTargetLabel(target)}</span>
    </>
  );

  if (!href) return <span className={className}>{content}</span>;
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return (
    <Link to={href} className={className}>
      {content}
    </Link>
  );
}

function RequestConfirmationResolution({
  interaction,
}: {
  interaction: RequestConfirmationInteraction;
}) {
  const outcome = interaction.result?.outcome;
  const target = interaction.payload.target ?? null;
  const staleTarget = interaction.result?.staleTarget ?? null;

  if (interaction.status === "accepted") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
        <span className="font-medium">Confirmed</span>
        <RequestConfirmationTargetChip interaction={interaction} target={target} />
      </div>
    );
  }

  if (interaction.status === "rejected") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
          <span className="font-medium">Declined</span>
          <RequestConfirmationTargetChip interaction={interaction} target={target} />
        </div>
        {interaction.result?.reason ? (
          <div className="rounded-sm border-l-2 border-rose-500/70 bg-rose-500/10 px-3 py-2 text-sm leading-6 text-rose-900 dark:text-rose-100">
            <MarkdownBody>{interaction.result.reason}</MarkdownBody>
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "expired") {
    const expiredByComment = outcome === "superseded_by_comment";
    const expiredByTargetChange = outcome === "stale_target";
    return (
      <div className="space-y-3 rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
          {expiredByComment ? "Expired by comment" : "Expired by target change"}
        </div>
        <p className="leading-6">
          {expiredByComment
            ? "A board comment superseded this confirmation before it was resolved."
            : "The requested target changed before this confirmation was resolved."}
        </p>
        {expiredByComment && interaction.result?.commentId ? (
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-amber-950 hover:bg-amber-500/15 dark:text-amber-50">
            <a href={`#comment-${interaction.result.commentId}`}>Jump to comment</a>
          </Button>
        ) : null}
        {expiredByTargetChange ? (
          <div className="flex flex-wrap items-center gap-2">
            <RequestConfirmationTargetChip
              interaction={interaction}
              target={staleTarget}
              tone="subtle"
            />
            {staleTarget && target ? (
              <ChevronRight className="h-3.5 w-3.5 text-amber-700" />
            ) : null}
            <RequestConfirmationTargetChip interaction={interaction} target={target} />
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "failed") {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        This request could not be resolved. Try again or create a new request.
      </p>
    );
  }

  return null;
}

function RequestConfirmationCard({
  interaction,
  isPlan = false,
  onAcceptInteraction,
  onRejectInteraction,
  onUploadImage,
  externalReferences,
}: {
  interaction: RequestConfirmationInteraction;
  isPlan?: boolean;
  onAcceptInteraction?: (
    interaction: RequestConfirmationInteraction,
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  onUploadImage?: (file: File) => Promise<string>;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(interaction.result?.reason ?? "");
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shots, setShots] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Screenshots ride along in the decline reason as markdown image refs so the
  // board can attach images when sending a plan back — no schema change needed.
  const allowScreenshots = isPlan && Boolean(onUploadImage);
  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowDeclineReason = interaction.payload.allowDeclineReason !== false;
  const trimmedRejectReason = rejectReason.trim();
  const canReject = !rejectRequiresReason || trimmedRejectReason.length > 0 || shots.length > 0;
  const declineReasonInvalid = rejectRequiresReason && !canReject;
  const declineReasonPlaceholder =
    interaction.payload.declineReasonPlaceholder
    ?? (interaction.payload.acceptLabel === "Approve plan"
      ? "Optional: what would you like revised?"
      : "Optional: tell the agent what you'd change.");

  useEffect(() => {
    setRejectReason(interaction.result?.reason ?? "");
    setRejectAttempted(false);
    setActionError(null);
    setShots([]);
    setUploadError(null);
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.id, interaction.result?.reason, interaction.status]);

  async function handleAddScreenshots(files: FileList | null) {
    if (!onUploadImage || !files || files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const uploaded: { name: string; url: string }[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const url = await onUploadImage(file);
        uploaded.push({ name: file.name || "screenshot", url });
      }
      if (uploaded.length > 0) setShots((current) => [...current, ...uploaded]);
    } catch {
      setUploadError("Couldn't upload that image. Try again.");
    } finally {
      setUploading(false);
    }
  }

  function composeReason() {
    const text = trimmedRejectReason;
    if (shots.length === 0) return text || undefined;
    const images = shots.map((s) => `![${s.name}](${s.url})`).join("\n");
    return [text, images].filter(Boolean).join("\n\n");
  }

  async function handleAccept() {
    if (!onAcceptInteraction) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction);
    } catch {
      setActionError("Try again");
    } finally {
      setWorking(null);
    }
  }

  async function handleReject() {
    setRejectAttempted(true);
    if (!onRejectInteraction || !canReject) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, composeReason());
      setRejecting(false);
    } catch {
      setActionError("Try again");
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-4">
      {interaction.status === "pending" ? (
        <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
          <div className="text-sm leading-6 text-foreground">
            {interaction.payload.prompt}
          </div>
          {interaction.payload.detailsMarkdown ? (
            <div className="border-t border-border/60 pt-3 text-sm">
              <MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody>
            </div>
          ) : null}
          <RequestConfirmationTargetChip
            interaction={interaction}
            target={interaction.payload.target}
          />
        </div>
      ) : null}

      {interaction.status === "pending" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant={rejecting ? "outline" : isPlan ? "cta" : "default"}
              disabled={!onAcceptInteraction || working !== null}
              onClick={() => void handleAccept()}
            >
              {working === "accept" ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Confirming...
                </>
              ) : (
                interaction.payload.acceptLabel ?? "Confirm"
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!onRejectInteraction || working !== null}
              onClick={() => {
                if (!allowDeclineReason) {
                  void handleReject();
                  return;
                }
                setRejectAttempted(false);
                setRejecting((current) => !current);
              }}
            >
              {interaction.payload.rejectLabel ?? "Decline"}
            </Button>
          </div>

          {rejecting ? (
            <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-3">
              <Textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder={declineReasonPlaceholder}
                aria-invalid={rejectAttempted && declineReasonInvalid}
                className={cn(
                  "min-h-24 bg-background text-sm",
                  rejectAttempted && declineReasonInvalid
                    && "border-rose-500 focus-visible:ring-rose-500/25",
                )}
              />
              {rejectAttempted && declineReasonInvalid ? (
                <p className="text-xs text-destructive">A decline reason is required.</p>
              ) : null}
              {allowScreenshots ? (
                <div className="space-y-2">
                  {shots.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {shots.map((shot, index) => (
                        <div
                          key={`${shot.url}-${index}`}
                          className="group relative h-16 w-16 overflow-hidden rounded-sm border border-border/70"
                        >
                          <img
                            src={shot.url}
                            alt={shot.name}
                            className="h-full w-full object-cover"
                          />
                          <button
                            type="button"
                            aria-label={`Remove ${shot.name}`}
                            className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={() =>
                              setShots((current) => current.filter((_, i) => i !== index))
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void handleAddScreenshots(event.target.value ? event.target.files : null);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={working !== null || uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <ImagePlus className="mr-2 h-3.5 w-3.5" />
                        Attach screenshots
                      </>
                    )}
                  </Button>
                  {uploadError ? (
                    <p className="text-xs text-destructive">{uploadError}</p>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working !== null}
                  onClick={() => {
                    setRejecting(false);
                    setRejectAttempted(false);
                  }}
                >
                  Cancel decline
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onRejectInteraction || working !== null}
                  onClick={() => void handleReject()}
                >
                  {working === "reject" ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    interaction.payload.rejectLabel ?? "Decline"
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {actionError ? (
            <div className="rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {actionError}
            </div>
          ) : null}
        </div>
      ) : (
        <RequestConfirmationResolution interaction={interaction} />
      )}
    </div>
  );
}

const CHECKBOX_SUMMARY_LABEL_LIMIT = 8;

function RequestCheckboxConfirmationResolution({
  interaction,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
}) {
  const target = interaction.payload.target ?? null;
  const [expanded, setExpanded] = useState(false);

  if (interaction.status === "accepted") {
    const totalOptions = interaction.payload.options.length;
    const selectedLabels = getCheckboxConfirmationSelectedLabels({
      payload: interaction.payload,
      result: interaction.result,
    });
    const selectedCount = interaction.result?.selectedOptionIds?.length ?? selectedLabels.length;
    const visibleLabels = expanded
      ? selectedLabels
      : selectedLabels.slice(0, CHECKBOX_SUMMARY_LABEL_LIMIT);
    const hiddenCount = selectedLabels.length - CHECKBOX_SUMMARY_LABEL_LIMIT;
    const hasHiddenLabels = hiddenCount > 0;
    const chipClassName =
      "inline-flex items-center rounded-sm border border-border/60 bg-transparent px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground";

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm leading-6 text-foreground">
          <span className="font-medium">
            {selectedCount === 0
              ? "Confirmed with no options selected"
              : `Confirmed ${selectedCount} of ${totalOptions} ${totalOptions === 1 ? "option" : "options"}`}
          </span>
          <RequestConfirmationTargetChip interaction={interaction} target={target} />
        </div>
        {visibleLabels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleLabels.map((label, index) => (
              <TaskField key={`${label}-${index}`} label="Selected" value={label} />
            ))}
            {hasHiddenLabels ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className={cn(
                  chipClassName,
                  "cursor-pointer transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                )}
                aria-expanded={expanded}
              >
                {expanded ? "Show less" : `+${hiddenCount} more`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (interaction.status === "rejected") {
    return <RequestConfirmationResolution interaction={interaction as unknown as RequestConfirmationInteraction} />;
  }

  if (interaction.status === "expired") {
    return <RequestConfirmationResolution interaction={interaction as unknown as RequestConfirmationInteraction} />;
  }

  if (interaction.status === "failed") {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        This request could not be resolved. Try again or create a new request.
      </p>
    );
  }

  return null;
}

function CheckboxOptionRow({
  id,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  description?: string | null;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-2.5 border-b border-border/60 px-3 py-2 last:border-b-0 transition-colors",
        checked ? "bg-sky-500/10" : "hover:bg-sky-500/5",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onToggle(value === true)}
        aria-label={label}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-5 text-foreground">{label}</div>
        {description ? (
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </label>
  );
}

function RequestCheckboxConfirmationCard({
  interaction,
  onAcceptInteraction,
  onRejectInteraction,
  externalReferences,
}: {
  interaction: RequestCheckboxConfirmationInteraction;
  onAcceptInteraction?: (
    interaction: RequestCheckboxConfirmationInteraction,
    selectedClientKeys: undefined,
    selectedOptionIds: string[],
  ) => Promise<void> | void;
  onRejectInteraction?: (
    interaction: RequestCheckboxConfirmationInteraction,
    reason?: string,
  ) => Promise<void> | void;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  const options = interaction.payload.options;
  const optionIds = useMemo(() => options.map((option) => option.id), [options]);
  const validOptionIds = useMemo(() => new Set(optionIds), [optionIds]);
  const minSelected = interaction.payload.minSelected ?? 0;
  const maxSelected = interaction.payload.maxSelected ?? null;

  const defaultSelected = useMemo(
    () =>
      new Set(
        (interaction.payload.defaultSelectedOptionIds ?? []).filter((id) => validOptionIds.has(id)),
      ),
    [interaction.payload.defaultSelectedOptionIds, validOptionIds],
  );

  const [selectedOptionIds, setSelectedOptionIds] = useState<Set<string>>(() => new Set(defaultSelected));
  const [rejecting, setRejecting] = useState(false);
  const [working, setWorking] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState(interaction.result?.reason ?? "");
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [acceptAttempted, setAcceptAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const optionSeed = useMemo(() => optionIds.join("\n"), [optionIds]);

  useEffect(() => {
    setSelectedOptionIds(new Set(defaultSelected));
    setRejectReason(interaction.result?.reason ?? "");
    setRejectAttempted(false);
    setAcceptAttempted(false);
    setActionError(null);
    if (interaction.status !== "pending") {
      setRejecting(false);
      setWorking(null);
    }
  }, [interaction.id, interaction.status, interaction.result?.reason, defaultSelected, optionSeed]);

  const rejectRequiresReason = interaction.payload.rejectRequiresReason === true;
  const allowDeclineReason = interaction.payload.allowDeclineReason !== false;
  const trimmedRejectReason = rejectReason.trim();
  const canReject = !rejectRequiresReason || trimmedRejectReason.length > 0;
  const declineReasonInvalid = rejectRequiresReason && !canReject;
  const declineReasonPlaceholder =
    interaction.payload.declineReasonPlaceholder ?? "Optional: tell the agent what you'd change.";

  const selectedCount = selectedOptionIds.size;
  const totalOptions = options.length;
  const atMax = maxSelected != null && selectedCount >= maxSelected;
  const belowMin = selectedCount < minSelected;
  const aboveMax = maxSelected != null && selectedCount > maxSelected;
  const selectionValid = !belowMin && !aboveMax;

  const validationMessage = belowMin
    ? minSelected === 1
      ? "Select at least 1 option."
      : `Select at least ${minSelected} options.`
    : aboveMax && maxSelected != null
      ? maxSelected === 1
        ? "Select at most 1 option."
        : `Select at most ${maxSelected} options.`
      : null;

  function toggleOption(optionId: string, checked: boolean) {
    setSelectedOptionIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(optionId);
      } else {
        next.delete(optionId);
      }
      return next;
    });
  }

  function handleSelectAll() {
    const capped = maxSelected != null ? optionIds.slice(0, maxSelected) : optionIds;
    setSelectedOptionIds(new Set(capped));
  }

  function handleClearSelection() {
    setSelectedOptionIds(new Set());
  }

  async function handleAccept() {
    setAcceptAttempted(true);
    if (!onAcceptInteraction || !selectionValid) return;
    setWorking("accept");
    setActionError(null);
    try {
      await onAcceptInteraction(interaction, undefined, [...selectedOptionIds]);
    } catch {
      setActionError("Try again");
    } finally {
      setWorking(null);
    }
  }

  async function handleReject() {
    setRejectAttempted(true);
    if (!onRejectInteraction || !canReject) return;
    setWorking("reject");
    setActionError(null);
    try {
      await onRejectInteraction(interaction, trimmedRejectReason || undefined);
      setRejecting(false);
    } catch {
      setActionError("Try again");
    } finally {
      setWorking(null);
    }
  }

  if (interaction.status !== "pending") {
    return (
      <div className="space-y-4">
        <RequestCheckboxConfirmationResolution interaction={interaction} />
      </div>
    );
  }

  const selectionSummary = totalOptions > 0 && selectedCount === totalOptions
    ? `All ${totalOptions} options selected`
    : `${selectedCount} of ${totalOptions} ${totalOptions === 1 ? "option" : "options"} selected`;
  const boundsHint = maxSelected != null
    ? `Pick ${minSelected === maxSelected ? `exactly ${maxSelected}` : `${minSelected}-${maxSelected}`}.`
    : minSelected > 0
      ? `Pick at least ${minSelected}.`
      : null;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-4">
        <div className="text-sm leading-6 text-foreground">{interaction.payload.prompt}</div>
        {interaction.payload.detailsMarkdown ? (
          <div className="border-t border-border/60 pt-3 text-sm">
            <MarkdownBody externalReferences={externalReferences}>{interaction.payload.detailsMarkdown}</MarkdownBody>
          </div>
        ) : null}
        <RequestConfirmationTargetChip
          interaction={interaction}
          target={interaction.payload.target}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{selectionSummary}</span>
            {boundsHint ? <span>{boundsHint}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null || selectedCount === totalOptions || (maxSelected != null && selectedCount >= maxSelected)}
              onClick={handleSelectAll}
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null || selectedCount === 0}
              onClick={handleClearSelection}
            >
              Clear selection
            </Button>
          </div>
        </div>

        <div
          role="group"
          aria-label="Selectable options"
          className="max-h-80 overflow-y-auto rounded-sm border border-border/70"
        >
          {options.map((option) => {
            const checked = selectedOptionIds.has(option.id);
            return (
              <CheckboxOptionRow
                key={option.id}
                id={`${interaction.id}-${option.id}`}
                label={option.label}
                description={option.description}
                checked={checked}
                disabled={working !== null || (!checked && atMax)}
                onToggle={(value) => toggleOption(option.id, value)}
              />
            );
          })}
        </div>

        {acceptAttempted && validationMessage ? (
          <p className="text-xs text-destructive">{validationMessage}</p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant={rejecting ? "outline" : "default"}
            disabled={!onAcceptInteraction || working !== null}
            onClick={() => void handleAccept()}
          >
            {working === "accept" ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Confirming...
              </>
            ) : (
              interaction.payload.acceptLabel ?? "Confirm selected"
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!onRejectInteraction || working !== null}
            onClick={() => {
              if (!allowDeclineReason) {
                void handleReject();
                return;
              }
              setRejectAttempted(false);
              setRejecting((current) => !current);
            }}
          >
            {interaction.payload.rejectLabel ?? "Request changes"}
          </Button>
        </div>

        {rejecting ? (
          <div className="space-y-3 rounded-sm border border-border/70 bg-background/75 p-3">
            <Textarea
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder={declineReasonPlaceholder}
              aria-invalid={rejectAttempted && declineReasonInvalid}
              className={cn(
                "min-h-24 bg-background text-sm",
                rejectAttempted && declineReasonInvalid
                  && "border-rose-500 focus-visible:ring-rose-500/25",
              )}
            />
            {rejectAttempted && declineReasonInvalid ? (
              <p className="text-xs text-destructive">A reason is required.</p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={working !== null}
                onClick={() => {
                  setRejecting(false);
                  setRejectAttempted(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!onRejectInteraction || working !== null}
                onClick={() => void handleReject()}
              >
                {working === "reject" ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  interaction.payload.rejectLabel ?? "Request changes"
                )}
              </Button>
            </div>
          </div>
        ) : null}

        {actionError ? (
          <div className="rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function IssueThreadInteractionCard({
  interaction,
  agentMap,
  currentUserId,
  userLabelMap,
  onAcceptInteraction,
  onRejectInteraction,
  onSubmitInteractionAnswers,
  onCancelInteraction,
  onUploadImage,
  externalReferences,
}: IssueThreadInteractionCardProps) {
  const localize = useLocalizedText();
  const isPlan = isPlanConfirmation(interaction);
  const planStyles = isPlan ? planStatusClasses(interaction.status) : null;
  const StatusIcon = planStyles ? planStyles.Icon : statusIcon(interaction.status);
  const styles = planStyles ?? statusClasses(interaction.status);
  const createdByLabel = resolveActorLabel({
    agentId: interaction.createdByAgentId,
    userId: interaction.createdByUserId,
    agentMap,
    currentUserId,
    userLabelMap,
    localize,
  });
  const resolvedByLabel =
    interaction.resolvedByAgentId || interaction.resolvedByUserId
      ? resolveActorLabel({
          agentId: interaction.resolvedByAgentId,
          userId: interaction.resolvedByUserId,
          agentMap,
          currentUserId,
          userLabelMap,
          localize,
        })
      : null;

  return (
    <div className={cn("rounded-sm border p-5 shadow-none", styles.shell)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-1 rounded-sm border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]", styles.badge)}>
              <StatusIcon className="h-3.5 w-3.5" />
              {isPlan ? localize({ en: "Plan", zh: "计划" }) : interactionKindLabel(interaction.kind, localize)}
              <span className="text-current/60">/</span>
              {isPlan ? planStatusLabel(interaction.status, localize) : statusLabel(interaction.status, localize)}
            </span>
            {interaction.continuationPolicy === "wake_assignee"
              || interaction.continuationPolicy === "wake_assignee_on_accept" ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-transparent px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-foreground/70">
                <ListChecks className="h-3.5 w-3.5" />
                {interaction.continuationPolicy === "wake_assignee_on_accept"
                  ? localize({ en: "Wakes on confirm", zh: "确认后唤醒" })
                  : localize({ en: "Wakes assignee", zh: "唤醒负责人" })}
              </span>
            ) : null}
          </div>

          <div className="mt-3 text-lg font-bold text-foreground">
            {interaction.title
              ?? (interaction.kind === "suggest_tasks"
                ? localize({ en: "Suggested task tree", zh: "建议任务树" })
                : interaction.kind === "ask_user_questions"
                  ? interaction.payload.title ?? localize({ en: "Questions for the operator", zh: "给操作员的问题" })
                : interaction.kind === "request_checkbox_confirmation"
                  ? localize({ en: "Checkbox confirmation requested", zh: "请求勾选确认" })
                  : isPlan
                    ? localize({ en: "Plan review", zh: "计划评审" })
                    : localize({ en: "Confirmation requested", zh: "请求确认" }))}
          </div>
          {interaction.summary ? (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              {interaction.summary}
            </p>
          ) : null}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="rounded-sm border border-border/70 bg-transparent px-3 py-2 text-right text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{formatShortDate(interaction.createdAt)}</div>
              <div>{localize({ en: `proposed by ${createdByLabel}`, zh: `由 ${createdByLabel} 提出` })}</div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {localize({ en: `Created ${formatDateTime(interaction.createdAt)}`, zh: `创建于 ${formatDateTime(interaction.createdAt)}` })}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-5">
        {interaction.kind === "suggest_tasks" ? (
          <SuggestTasksCard
            interaction={interaction}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
          />
        ) : interaction.kind === "ask_user_questions" ? (
          <AskUserQuestionsCard
            interaction={interaction}
            onSubmitInteractionAnswers={onSubmitInteractionAnswers}
            onCancelInteraction={onCancelInteraction}
            externalReferences={externalReferences}
          />
        ) : interaction.kind === "request_checkbox_confirmation" ? (
          <RequestCheckboxConfirmationCard
            interaction={interaction}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            externalReferences={externalReferences}
          />
        ) : (
          <RequestConfirmationCard
            interaction={interaction}
            isPlan={isPlan}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            onUploadImage={onUploadImage}
            externalReferences={externalReferences}
          />
        )}
      </div>

      {resolvedByLabel ? (
        <div className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
          {localize({ en: "Resolved by", zh: "解决人" })} <span className="font-medium text-foreground">{resolvedByLabel}</span>
          {interaction.resolvedAt ? localize({ en: ` on ${formatShortDate(interaction.resolvedAt)}`, zh: `，时间 ${formatShortDate(interaction.resolvedAt)}` }) : ""}
        </div>
      ) : null}
    </div>
  );
}
