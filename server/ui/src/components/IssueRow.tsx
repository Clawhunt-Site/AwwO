import type { ReactNode } from "react";
import type { ExternalObjectSummary, Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Eye, Flag, X } from "lucide-react";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import { cn } from "../lib/utils";
import {
  type ActiveRecoveryDisplayState,
  deriveActiveRecoveryDisplayState,
  RECOVERY_CHIP_DEFAULT_TONE,
} from "../lib/recovery-display";
import { StatusIcon } from "./StatusIcon";
import { hasAssignedBacklogBlocker } from "../lib/issue-blockers";
import { ExternalObjectStatusSummary } from "./ExternalObjectStatusSummary";
import { type LocalizedText, useLocalizedText } from "../i18n/localized";

type UnreadState = "hidden" | "visible" | "fading";

interface IssueRowProps {
  issue: Issue;
  issueLinkState?: unknown;
  selected?: boolean;
  mobileLeading?: ReactNode;
  desktopMetaLeading?: ReactNode;
  desktopLeadingSpacer?: boolean;
  mobileMeta?: ReactNode;
  desktopTrailing?: ReactNode;
  /**
   * Optional pre-fetched external-object summary. Renders a compact severity
   * marker before the rest of `desktopTrailing` on desktop only.
   */
  externalObjectSummary?: ExternalObjectSummary | null;
  trailingMeta?: ReactNode;
  titleSuffix?: ReactNode;
  titleClassName?: string;
  checklistStepNumber?: number | string | null;
  checklistCurrentStep?: boolean;
  checklistDependencyChips?: ReactNode;
  checklistRowId?: string;
  unreadState?: UnreadState | null;
  onMarkRead?: () => void;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  className?: string;
}

const productivityReviewTriggerCopy: Record<string, LocalizedText> = {
  no_comment_streak: { en: "No-comment streak", zh: "连续无评论" },
  long_active_duration: { en: "Long active duration", zh: "活跃时间过长" },
  high_churn: { en: "High churn", zh: "变更频繁" },
};

function localizedProductivityReviewTriggerLabel(
  trigger: string | null | undefined,
  localize: (copy: LocalizedText) => string,
): string {
  if (!trigger) return localize({ en: "Productivity review", zh: "生产力复盘" });
  const fallback = trigger.replace(/_/g, " ");
  return localize(productivityReviewTriggerCopy[trigger] ?? { en: fallback, zh: fallback });
}

export function IssueRow({
  issue,
  issueLinkState,
  selected = false,
  mobileLeading,
  desktopMetaLeading,
  desktopLeadingSpacer = false,
  mobileMeta,
  desktopTrailing,
  externalObjectSummary,
  trailingMeta,
  titleSuffix,
  titleClassName,
  checklistStepNumber = null,
  checklistCurrentStep = false,
  checklistDependencyChips,
  checklistRowId,
  unreadState = null,
  onMarkRead,
  onArchive,
  archiveDisabled,
  className,
}: IssueRowProps) {
  const localize = useLocalizedText();
  const issuePathId = issue.identifier ?? issue.id;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";
  const selectedStatusClass = selected ? "!text-muted-foreground !border-muted-foreground" : undefined;
  const detailState = withIssueDetailHeaderSeed(issueLinkState, issue);
  const productivityReview = issue.productivityReview ?? null;
  const productivityReviewLabel = productivityReview
    ? localizedProductivityReviewTriggerLabel(productivityReview.trigger, localize)
    : null;
  const productivityReviewIndicator = productivityReview ? (
    <span
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
        selected ? "border-muted-foreground text-muted-foreground" : null,
      )}
      title={localize({ en: `Productivity review: ${productivityReviewLabel}`, zh: `生产力复盘：${productivityReviewLabel}` })}
      aria-label={localize({ en: "Productivity review open", zh: "生产力复盘已打开" })}
    >
      <Eye className="h-2.5 w-2.5" aria-hidden />
    </span>
  ) : null;
  const hasChecklistStep = checklistStepNumber !== null;
  const checklistStep = hasChecklistStep ? (
    <span className="shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">
      {checklistStepNumber}.
    </span>
  ) : null;
  const recoveryAction = issue.activeRecoveryAction ?? null;
  const recoveryIndicator = recoveryAction ? renderRecoveryChip(recoveryAction, selected, localize) : null;
  const parkedBlockerIndicator = hasAssignedBacklogBlocker(issue.blockedBy) ? (
    <span
      data-testid="issue-row-parked-blocker"
      className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 rounded-full border border-amber-500/60 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
      title={localize({
        en: "Blocked by parked work - at least one assigned blocker is in backlog and will not wake its assignee.",
        zh: "被暂存工作阻塞 - 至少一个已分配阻塞项在待办池中，不会唤醒负责人。",
      })}
    >
      <Flag className="h-2.5 w-2.5" aria-hidden />
      {localize({ en: "Blocked by parked work", zh: "被暂存工作阻塞" })}
    </span>
  ) : null;

  return (
    <Link
      to={createIssueDetailPath(issuePathId)}
      state={detailState}
      disableIssueQuicklook
      issuePrefetch={issue}
      data-inbox-issue-link
      id={checklistRowId}
      aria-current={checklistCurrentStep ? "step" : undefined}
      onClickCapture={() => rememberIssueDetailLocationState(issuePathId, detailState)}
      className={cn(
        "group flex items-start gap-2 border-b border-border py-2.5 pl-2 pr-3 text-sm no-underline text-inherit transition-colors last:border-b-0 sm:items-center sm:py-2 sm:pl-1",
        selected ? "hover:bg-transparent" : "hover:bg-accent/50",
        checklistCurrentStep ? "border-l-2 border-l-primary bg-primary/5 pl-[calc(theme(spacing.2)-2px)] sm:pl-[calc(theme(spacing.1)-2px)]" : null,
        className,
      )}
    >
      <span className="flex shrink-0 items-center gap-1 pt-px sm:hidden">
        {mobileLeading ?? <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} size="lg" className={selectedStatusClass} />}
        {productivityReviewIndicator}
        {parkedBlockerIndicator}
        {recoveryIndicator}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
        <span className={cn("line-clamp-2 text-sm sm:order-2 sm:min-w-0 sm:flex-1 sm:truncate sm:line-clamp-none", titleClassName)}>
          {issue.title}{titleSuffix}
        </span>
        {checklistDependencyChips ? (
          <span className="flex flex-wrap gap-1 sm:order-3 sm:ml-[calc(theme(spacing.3)+theme(spacing.2))]">
            {checklistDependencyChips}
          </span>
        ) : null}
        <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
          {desktopLeadingSpacer ? (
            <span className="hidden w-3.5 shrink-0 sm:block" />
          ) : null}
          {desktopMetaLeading ?? (
            <>
              <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
                <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} size="lg" className={selectedStatusClass} />
                {productivityReviewIndicator}
              </span>
              {checklistStep}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {identifier}
              </span>
              {parkedBlockerIndicator}
              {recoveryIndicator}
            </>
          )}
          {mobileMeta ? (
            <>
              <span className="text-xs text-muted-foreground sm:hidden" aria-hidden="true">
                &middot;
              </span>
              <span className="text-xs text-muted-foreground sm:hidden">{mobileMeta}</span>
            </>
          ) : null}
        </span>
      </span>
      {(desktopTrailing || trailingMeta || externalObjectSummary) ? (
        <span className="ml-auto hidden shrink-0 items-center gap-2 sm:order-3 sm:flex sm:gap-3">
          {externalObjectSummary ? (
            <ExternalObjectStatusSummary summary={externalObjectSummary} compact />
          ) : null}
          {desktopTrailing}
          {trailingMeta ? (
            <span className="text-xs text-muted-foreground">{trailingMeta}</span>
          ) : null}
        </span>
      ) : null}
      {showUnreadSlot ? (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
          {showUnreadDot ? (
            <button
              type="button"
              data-slot="icon-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkRead?.();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkRead?.();
                }
              }}
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors",
                selected ? "hover:bg-muted/80" : "hover:bg-blue-500/20",
              )}
              aria-label={localize({ en: "Mark as read", zh: "标记为已读" })}
            >
              <span
                className={cn(
                  "block h-2 w-2 rounded-full transition-opacity duration-300",
                  selected ? "bg-muted-foreground/70" : "bg-blue-600 dark:bg-blue-400",
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )}
              />
            </button>
          ) : onArchive ? (
            <button
              type="button"
              data-slot="icon-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onArchive();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onArchive();
              }}
              disabled={archiveDisabled}
              className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
              aria-label={localize({ en: "Dismiss from inbox", zh: "从收件箱移除" })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <span className="inline-flex h-4 w-4" aria-hidden="true" />
          )}
        </span>
      ) : null}
    </Link>
  );
}

const recoveryChipCopy: Record<string, LocalizedText> = {
  needed: { en: "Recovery needed", zh: "需要恢复" },
  workspace_validation_needed: { en: "Workspace recovery needed", zh: "需要恢复工作区" },
  in_progress: { en: "Recovery in progress", zh: "正在恢复" },
  observe_only: { en: "Observing active run", zh: "正在观察活跃运行" },
  escalated: { en: "Recovery escalated", zh: "恢复已升级" },
};

function localizedRecoveryChipLabel(
  state: ActiveRecoveryDisplayState,
  kind: IssueRecoveryAction["kind"],
  localize: (copy: LocalizedText) => string,
): string {
  if (kind === "workspace_validation" && state === "needed") {
    return localize(recoveryChipCopy.workspace_validation_needed);
  }
  return localize(recoveryChipCopy[state] ?? { en: RECOVERY_CHIP_DEFAULT_TONE[state].label, zh: RECOVERY_CHIP_DEFAULT_TONE[state].label });
}

function renderRecoveryChip(action: IssueRecoveryAction, selected: boolean, localize: (copy: LocalizedText) => string): ReactNode {
  const state = deriveActiveRecoveryDisplayState(action);
  if (!state) return null;
  const tone = RECOVERY_CHIP_DEFAULT_TONE[state];
  const Icon = tone.icon;
  const label = localizedRecoveryChipLabel(state, action.kind, localize);
  return (
    <span
      data-testid="issue-row-recovery-indicator"
      data-recovery-state={state}
      data-recovery-kind={action.kind}
      role="status"
      aria-label={label}
      className={cn(
        "ml-1.5 inline-flex shrink-0 items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        tone.className,
        selected ? "!border-muted-foreground !text-muted-foreground" : null,
      )}
      title={localize({ en: `${label} - open the source task to act.`, zh: `${label} - 打开来源任务进行处理。` })}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {label}
    </span>
  );
}
