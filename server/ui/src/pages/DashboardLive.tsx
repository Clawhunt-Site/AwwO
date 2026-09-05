import { useEffect } from "react";
import { ArrowLeft, RadioTower } from "lucide-react";
import { Link } from "@/lib/router";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useLocalizedText } from "@/i18n/localized";

const DASHBOARD_LIVE_RUN_LIMIT = 50;

export function DashboardLive() {
  const localize = useLocalizedText();
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: localize({ en: "Dashboard", zh: "仪表盘" }), href: "/dashboard" },
      { label: localize({ en: "Live runs", zh: "实时运行" }) },
    ]);
  }, [localize, setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0
          ? localize({ en: "Create a company to view live runs.", zh: "创建公司后查看实时运行。" })
          : localize({ en: "Select a company to view live runs.", zh: "选择公司后查看实时运行。" })}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {localize({ en: "Dashboard", zh: "仪表盘" })}
          </Link>
          <h1 className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-normal text-foreground">
            <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            {localize({ en: "Live agent runs", zh: "实时 Agent 运行" })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {localize({
              en: "Active runs first, followed by the most recent completed runs.",
              zh: "优先显示正在运行的任务，然后是最近完成的运行。",
            })}
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          {localize({ en: `Showing up to ${DASHBOARD_LIVE_RUN_LIMIT}`, zh: `最多显示 ${DASHBOARD_LIVE_RUN_LIMIT} 个` })}
        </div>
      </div>

      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title={localize({ en: "Active / recent", zh: "活跃 / 最近" })}
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        gridClassName="gap-3 md:grid-cols-2 2xl:grid-cols-3"
        cardClassName="h-[420px]"
        emptyMessage={localize({ en: "No active or recent agent runs.", zh: "暂无活跃或最近的 agent 运行。" })}
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}
