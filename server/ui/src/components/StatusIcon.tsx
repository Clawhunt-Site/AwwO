import { useState } from "react";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { StatusGlyph, type StatusGlyphSize } from "./StatusGlyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useLocalizedText, type LocalizedText } from "../i18n/localized";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

const statusCopy: Record<string, LocalizedText> = {
  backlog: { en: "Backlog", zh: "待办池" },
  todo: { en: "To do", zh: "待办" },
  in_progress: { en: "In progress", zh: "进行中" },
  in_review: { en: "In review", zh: "评审中" },
  done: { en: "Done", zh: "完成" },
  cancelled: { en: "Cancelled", zh: "已取消" },
  blocked: { en: "Blocked", zh: "受阻" },
};

function statusLabel(status: string, localize: (copy: LocalizedText) => string): string {
  const copy = statusCopy[status];
  if (copy) return localize(copy);
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatusIconProps {
  status: string;
  blockerAttention?: IssueBlockerAttention | null;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
  /** Glyph size (PAP-243a). Default `md` (16px); lists/detail/mentions use `lg` (20px). */
  size?: StatusGlyphSize;
}

function blockedAttentionLabel(blockerAttention: IssueBlockerAttention | null | undefined, localize: (copy: LocalizedText) => string) {
  if (!blockerAttention || blockerAttention.state === "none") return localize(statusCopy.blocked);

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return localize({
        en: `Blocked · waiting on active sub-task ${blockerAttention.sampleBlockerIdentifier}`,
        zh: `受阻 · 等待活跃子任务 ${blockerAttention.sampleBlockerIdentifier}`,
      });
    }
    if (count === 1) return localize({ en: "Blocked · waiting on 1 active sub-task", zh: "受阻 · 等待 1 个活跃子任务" });
    return localize({ en: `Blocked · waiting on ${count} active sub-tasks`, zh: `受阻 · 等待 ${count} 个活跃子任务` });
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return localize({
        en: `Blocked · covered by active dependency ${blockerAttention.sampleBlockerIdentifier}`,
        zh: `受阻 · 已由活跃依赖 ${blockerAttention.sampleBlockerIdentifier} 承接`,
      });
    }
    if (count === 1) return localize({ en: "Blocked · covered by 1 active dependency", zh: "受阻 · 已由 1 个活跃依赖承接" });
    return localize({ en: `Blocked · covered by ${count} active dependencies`, zh: `受阻 · 已由 ${count} 个活跃依赖承接` });
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) {
      return localize({ en: `Blocked · review stalled on ${leaf}`, zh: `受阻 · 评审卡在 ${leaf}` });
    }
    if (count === 1) {
      return localize({ en: "Blocked · review stalled with no clear next step", zh: "受阻 · 评审停滞且没有明确下一步" });
    }
    return localize({
      en: `Blocked · ${count} reviews stalled with no clear next step`,
      zh: `受阻 · ${count} 个评审停滞且没有明确下一步`,
    });
  }

  if (blockerAttention.reason === "attention_required") {
    const count = blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;
    const attentionCopy = localize({
      en: `${count} ${count === 1 ? "blocker needs" : "blockers need"} attention`,
      zh: `${count} 个阻塞项需要处理`,
    });
    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return localize({
        en: `Blocked · ${attentionCopy}; ${coveredCount} covered by active work`,
        zh: `受阻 · ${attentionCopy}；${coveredCount} 个已有活跃工作承接`,
      });
    }
    return localize({ en: `Blocked · ${attentionCopy}`, zh: `受阻 · ${attentionCopy}` });
  }

  return localize(statusCopy.blocked);
}

/**
 * Task/issue status indicator — renders the unified, color-blind-safe
 * {@link StatusGlyph} (one distinct shape per status). With `onChange` it also
 * acts as a status picker (popover). This one component drives every standalone
 * status surface: list, kanban, detail header, properties row + picker flyout,
 * sub-task / blocked-by pills, blocked inbox, quicklook, sibling nav, filters,
 * search, columns, dashboard.
 *
 * A "covered" blocked task (waiting on active work) maps to the `in_queue`
 * glyph — the blocked shape recoloured blue — while the full blocked reason
 * still rides on the accessible label.
 */
export function StatusIcon({ status, blockerAttention, onChange, className, showLabel, size = "md" }: StatusIconProps) {
  const [open, setOpen] = useState(false);
  const localize = useLocalizedText();
  const isCoveredBlocked = status === "blocked" && blockerAttention?.state === "covered";
  const visibleStatusLabel = statusLabel(status, localize);
  const ariaLabel = status === "blocked" ? blockedAttentionLabel(blockerAttention, localize) : visibleStatusLabel;
  const glyphStatus = isCoveredBlocked ? "in_queue" : status;

  const glyph = (
    <StatusGlyph
      status={glyphStatus}
      size={size}
      className={cn(onChange && !showLabel && "cursor-pointer", className)}
      title={ariaLabel}
    />
  );

  if (!onChange) {
    return showLabel ? (
      <span className="inline-flex items-center gap-1.5">
        {glyph}
        <span className="text-sm">{visibleStatusLabel}</span>
      </span>
    ) : (
      glyph
    );
  }

  const trigger = showLabel ? (
    <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {glyph}
      <span className="text-sm">{visibleStatusLabel}</span>
    </button>
  ) : (
    glyph
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        {allStatuses.map((s) => (
          <Button
            key={s}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s === status && "bg-accent")}
            onClick={() => {
              onChange(s);
              setOpen(false);
            }}
          >
            <StatusIcon status={s} size="lg" />
            {statusLabel(s, localize)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
