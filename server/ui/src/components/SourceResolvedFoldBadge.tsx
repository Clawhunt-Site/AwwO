import { Sparkles } from "lucide-react";
import { useLocalizedText } from "@/i18n/localized";
import { cn } from "@/lib/utils";

export interface SourceResolvedFoldBadgeProps {
  className?: string;
  title?: string;
  /** When true (default) the leading sparkles icon is rendered. */
  showIcon?: boolean;
}

export function SourceResolvedFoldBadge({
  className,
  title,
  showIcon = true,
}: SourceResolvedFoldBadgeProps) {
  const localize = useLocalizedText();
  const resolvedTitle = title ?? localize({
    en: "System folded this run as a source-resolved false positive.",
    zh: "系统已将此运行折叠为来源已解决的误报。",
  });
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        "border-emerald-300/60 bg-emerald-50/80 text-emerald-900",
        "dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
        className,
      )}
      title={resolvedTitle}
      aria-label={localize({ en: "Source-resolved watchdog fold", zh: "来源已解决的看门狗折叠" })}
    >
      {showIcon ? <Sparkles className="h-3 w-3 text-emerald-700 dark:text-emerald-300" aria-hidden /> : null}
      {localize({ en: "Source-resolved", zh: "来源已解决" })}
    </span>
  );
}

export default SourceResolvedFoldBadge;
