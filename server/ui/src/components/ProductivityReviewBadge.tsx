import { Eye } from "lucide-react";
import type { IssueProductivityReview } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { type LocalizedText, useLocalizedText } from "../i18n/localized";

const TRIGGER_LABELS: Record<string, string> = {
  no_comment_streak: "No-comment streak",
  long_active_duration: "Long active duration",
  high_churn: "High churn",
};

const REVIEW_STATUS_LABELS: Record<string, string> = {
  todo: "Open",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  backlog: "Open",
};

const TRIGGER_COPY: Record<string, LocalizedText> = {
  no_comment_streak: { en: "No-comment streak", zh: "连续无评论" },
  long_active_duration: { en: "Long active duration", zh: "活跃时间过长" },
  high_churn: { en: "High churn", zh: "变更频繁" },
};

const REVIEW_STATUS_COPY: Record<string, LocalizedText> = {
  todo: { en: "Open", zh: "打开" },
  in_progress: { en: "In progress", zh: "进行中" },
  in_review: { en: "In review", zh: "评审中" },
  blocked: { en: "Blocked", zh: "受阻" },
  backlog: { en: "Open", zh: "打开" },
};

export function productivityReviewTriggerLabel(
  trigger: IssueProductivityReview["trigger"],
): string {
  if (!trigger) return "Productivity review";
  return TRIGGER_LABELS[trigger] ?? "Productivity review";
}

export function ProductivityReviewBadge({
  review,
  className,
  hideLabel = false,
}: {
  review: IssueProductivityReview;
  className?: string;
  hideLabel?: boolean;
}) {
  const localize = useLocalizedText();
  const fallbackLabel = productivityReviewTriggerLabel(review.trigger);
  const label = review.trigger
    ? localize(TRIGGER_COPY[review.trigger] ?? { en: fallbackLabel, zh: fallbackLabel })
    : localize({ en: "Productivity review", zh: "生产力复盘" });
  const reviewIdentifier = review.reviewIdentifier ?? review.reviewIssueId.slice(0, 8);
  const reviewPath = createIssueDetailPath(review.reviewIdentifier ?? review.reviewIssueId);
  const fallbackStatusLabel = REVIEW_STATUS_LABELS[review.status] ?? review.status.replace(/_/g, " ");
  const statusLabel = localize(REVIEW_STATUS_COPY[review.status] ?? { en: fallbackStatusLabel, zh: fallbackStatusLabel });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={reviewPath}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 shrink-0 hover:bg-amber-500/20 transition-colors",
            className,
          )}
          aria-label={localize({
            en: `Under review - productivity review ${reviewIdentifier} (${label})`,
            zh: `复盘中 - 生产力复盘 ${reviewIdentifier}（${label}）`,
          })}
        >
          <Eye className="h-3 w-3" aria-hidden />
          {hideLabel ? null : <span>{localize({ en: "Under review", zh: "复盘中" })}</span>}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">{localize({ en: "Productivity review open", zh: "生产力复盘已打开" })}</div>
          <div>
            <span className="text-muted-foreground">{localize({ en: "Trigger:", zh: "触发原因：" })}</span> {label}
          </div>
          {typeof review.noCommentStreak === "number" && review.noCommentStreak > 0 ? (
            <div>
              <span className="text-muted-foreground">{localize({ en: "No-comment streak:", zh: "连续无评论：" })}</span>{" "}
              {localize({ en: `${review.noCommentStreak} runs`, zh: `${review.noCommentStreak} 次运行` })}
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">{localize({ en: "Review:", zh: "复盘：" })}</span> {reviewIdentifier} ({statusLabel})
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
