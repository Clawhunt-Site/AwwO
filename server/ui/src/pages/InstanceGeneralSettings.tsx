import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackupRetentionPolicy } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
} from "@paperclipai/shared";
import { SlidersHorizontal } from "lucide-react";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useLocalizedText } from "../i18n/localized";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const localize = useLocalizedText();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: localize({ en: "Settings", zh: "设置" }), href: "/company/settings" },
      { label: localize({ en: "Instance settings", zh: "实例设置" }) },
      { label: localize({ en: "General", zh: "通用" }) },
    ]);
  }, [setBreadcrumbs, localize]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error
          ? error.message
          : localize({ en: "Failed to update general settings.", zh: "更新通用设置失败。" }),
      );
    },
  });

  if (generalQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        {localize({ en: "Loading general settings...", zh: "正在加载通用设置…" })}
      </div>
    );
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : localize({ en: "Failed to load general settings.", zh: "加载通用设置失败。" })}
      </div>
    );
  }

  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{localize({ en: "General", zh: "通用" })}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {localize({
            en: "Configure instance-wide preferences including log display, keyboard shortcuts, and backup retention.",
            zh: "配置实例级偏好，包括日志显示、键盘快捷键与备份保留策略。",
          })}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{localize({ en: "Deployment and auth", zh: "部署与认证" })}</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? localize({
                  en: "Local trusted mode is optimized for a local operator. Browser requests run as local board context and no sign-in is required.",
                  zh: "本地受信模式针对本地操作者优化。浏览器请求以本地看板上下文运行，无需登录。",
                })
              : healthQuery.data?.deploymentExposure === "public"
                ? localize({
                    en: "Authenticated public mode requires sign-in for board access and is intended for public URLs.",
                    zh: "认证公开模式需登录才能访问看板，适用于公网地址。",
                  })
                : localize({
                    en: "Authenticated private mode requires sign-in and is intended for LAN, VPN, or other private-network deployments.",
                    zh: "认证私有模式需登录，适用于局域网、VPN 等私有网络部署。",
                  })}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label={localize({ en: "Auth readiness", zh: "认证就绪" })}
              value={healthQuery.data?.authReady ? localize({ en: "Ready", zh: "就绪" }) : localize({ en: "Not ready", zh: "未就绪" })}
            />
            <StatusBox
              label={localize({ en: "Bootstrap status", zh: "初始化状态" })}
              value={
                healthQuery.data?.bootstrapStatus === "bootstrap_pending"
                  ? localize({ en: "Setup required", zh: "需要设置" })
                  : localize({ en: "Ready", zh: "就绪" })
              }
            />
            <StatusBox
              label={localize({ en: "Bootstrap invite", zh: "初始化邀请" })}
              value={healthQuery.data?.bootstrapInviteActive ? localize({ en: "Active", zh: "已启用" }) : localize({ en: "None", zh: "无" })}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{localize({ en: "Backup retention", zh: "备份保留" })}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {localize({
                en: "Configure how long automatic database backups are retained. Backups run roughly every hour and are compressed with gzip. Within the daily window all backups are kept; beyond that, one backup per week and one per month are preserved.",
                zh: "配置自动数据库备份的保留时长。备份大约每小时运行一次并以 gzip 压缩。在每日窗口内保留所有备份；超出后每周保留一份、每月保留一份。",
              })}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{localize({ en: "Daily", zh: "每日" })}</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{localize({ en: `${days} days`, zh: `${days} 天` })}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{localize({ en: "Weekly", zh: "每周" })}</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = localize({
                  en: weeks === 1 ? "1 week" : `${weeks} weeks`,
                  zh: `${weeks} 周`,
                });
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{localize({ en: "Monthly", zh: "每月" })}</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = localize({
                  en: months === 1 ? "1 month" : `${months} months`,
                  zh: `${months} 个月`,
                });
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
