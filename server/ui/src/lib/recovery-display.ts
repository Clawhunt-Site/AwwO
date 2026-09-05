import type { IssueRecoveryAction, IssueRecoveryActionKind } from "@paperclipai/shared";
import { Eye, OctagonAlert, RefreshCw, TriangleAlert } from "lucide-react";
import type { LocalizedText } from "../i18n/localized";

export type RecoveryDisplayState =
  | "needed"
  | "in_progress"
  | "observe_only"
  | "escalated"
  | "resolved";

export type ActiveRecoveryDisplayState = Exclude<RecoveryDisplayState, "resolved">;

export const RECOVERY_CHIP_DEFAULT_TONE: Record<
  ActiveRecoveryDisplayState,
  { className: string; icon: typeof TriangleAlert; label: string }
> = {
  needed: {
    className:
      "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    icon: TriangleAlert,
    label: "Recovery needed",
  },
  in_progress: {
    className:
      "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-300",
    icon: RefreshCw,
    label: "Recovery in progress",
  },
  observe_only: {
    className: "border-border bg-muted text-muted-foreground",
    icon: Eye,
    label: "Observing active run",
  },
  escalated: {
    className: "border-red-500/60 bg-red-500/15 text-red-700 dark:text-red-300",
    icon: OctagonAlert,
    label: "Recovery escalated",
  },
};

export const RECOVERY_CHIP_LABEL_COPY: Record<ActiveRecoveryDisplayState | "workspace_validation_needed", LocalizedText> = {
  needed: { en: "Recovery needed", zh: "需要恢复" },
  workspace_validation_needed: { en: "Workspace recovery needed", zh: "需要恢复工作区" },
  in_progress: { en: "Recovery in progress", zh: "正在恢复" },
  observe_only: { en: "Observing active run", zh: "正在观察活跃运行" },
  escalated: { en: "Recovery escalated", zh: "恢复已升级" },
};

export function deriveRecoveryDisplayState(
  action: Pick<IssueRecoveryAction, "status" | "kind" | "outcome">,
): RecoveryDisplayState {
  if (action.status === "resolved") return "resolved";
  if (action.status === "escalated") return "escalated";
  if (action.status === "cancelled") return "resolved";
  if (action.kind === "active_run_watchdog") return "observe_only";
  if (action.outcome === "delegated") return "in_progress";
  return "needed";
}

export function deriveActiveRecoveryDisplayState(
  action: Pick<IssueRecoveryAction, "status" | "kind" | "outcome">,
): ActiveRecoveryDisplayState | null {
  const state = deriveRecoveryDisplayState(action);
  return state === "resolved" ? null : state;
}

export function recoveryChipLabel(
  state: ActiveRecoveryDisplayState,
  kind: IssueRecoveryActionKind,
): string {
  return recoveryChipLabelText(state, kind).en;
}

export function recoveryChipLabelText(
  state: ActiveRecoveryDisplayState,
  kind: IssueRecoveryActionKind,
): LocalizedText {
  if (kind === "workspace_validation" && state === "needed") {
    return RECOVERY_CHIP_LABEL_COPY.workspace_validation_needed;
  }
  return RECOVERY_CHIP_LABEL_COPY[state] ?? {
    en: RECOVERY_CHIP_DEFAULT_TONE[state].label,
    zh: RECOVERY_CHIP_DEFAULT_TONE[state].label,
  };
}
