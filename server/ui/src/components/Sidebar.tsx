import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  GitBranch,
  Package,
  Settings,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  MessagesSquare,
  Building2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarProjects } from "./SidebarProjects";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useEmbeddedHost } from "../context/EmbeddedHostContext";
import { useSidebar } from "../context/SidebarContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalizedText } from "@/i18n/localized";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function Sidebar() {
  const localize = useLocalizedText();
  const { openNewIssue } = useDialogActions();
  const embeddedHost = useEmbeddedHost();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile, collapsed, collapseLocked, peeking, toggleCollapsed, setCollapsed } = useSidebar();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const showPipelines = experimentalSettings?.enablePipelines === true;
  // IA flag: branch the sidebar nav presentation. Default ON =
  // streamlined (top-level Projects link). Users can opt out in experiments to
  // get classic (per-project collapsible, no Projects nav link). Issue/Task
  // wording is split to PR #7651. Gating is navigation-only; all routes stay
  // registered in both modes.
  const streamlined = experimentalSettings?.enableStreamlinedLeftNavigation !== false;
  // Conference Room Chat flag (PAP-136/PAP-137): the Conference Room nav item
  // is a new surface, hidden entirely while the flag is off (same no-flash
  // pattern as showWorkspacesLink above).
  const conferenceRoomChatEnabled = experimentalSettings?.enableConferenceRoomChat === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        {embeddedHost && !rail ? null : <SidebarCompanyMenu />}
        {/* In the collapsed rail the search/toggle controls don't fit beside the
            logo — keeping them would overflow the 64px rail and squeeze the logo
            out of alignment with the icon column below it (PAP-10676). They return
            as soon as the panel is expanded (pinned) or peeking. Expansion in the
            rail is still reachable via hover-peek + Pin and Cmd/Ctrl+B. */}
        {!rail ? (
          <>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/35"
              aria-label={localize({ en: "Open search", zh: "打开搜索" })}
              title={localize({ en: "Open search", zh: "打开搜索" })}
            >
              <NavLink to="/search">
                <Search className="h-4 w-4" />
              </NavLink>
            </Button>
            {/* Desktop-only collapse/expand affordance. While peeking (hover flyout
                over the collapsed rail) it becomes a Pin that promotes the peek to a
                pinned-expanded sidebar; otherwise it toggles the pinned rail. Mobile
                uses the off-canvas drawer, so this control is hidden there. It is
                also hidden while a secondary sidebar forces the rail (collapseLocked):
                the user cannot expand the primary while a secondary sidebar is shown. */}
            {!isMobile && !collapseLocked ? (
              peeking ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/35"
                  aria-label={localize({ en: "Keep sidebar expanded", zh: "保持侧边栏展开" })}
                  title={localize({ en: "Keep sidebar expanded", zh: "保持侧边栏展开" })}
                  onClick={() => setCollapsed(false)}
                >
                  <Pin className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/35"
                  aria-expanded={!collapsed}
                  aria-label={collapsed
                    ? localize({ en: "Expand sidebar", zh: "展开侧边栏" })
                    : localize({ en: "Collapse sidebar", zh: "收起侧边栏" })}
                  title={collapsed
                    ? localize({ en: "Expand sidebar", zh: "展开侧边栏" })
                    : localize({ en: "Collapse sidebar", zh: "收起侧边栏" })}
                  onClick={() => toggleCollapsed()}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              )
            ) : null}
          </>
        ) : null}
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 pointer-coarse:gap-3 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Task button aligned with nav items */}
          {(() => {
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                aria-label={rail ? localize({ en: "New Task", zh: "新任务" }) : undefined}
                className="flex items-center gap-2.5 px-3 py-2 pointer-coarse:py-1.5 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/35"
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>
                  {localize({ en: "New Task", zh: "新任务" })}
                </span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">{localize({ en: "New Task", zh: "新任务" })}</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          <SidebarNavItem to="/companies" label={localize({ en: "Companies", zh: "公司列表" })} icon={Building2} />
          <SidebarNavItem to="/dashboard" label={localize({ en: "Dashboard", zh: "仪表盘" })} icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label={localize({ en: "Inbox", zh: "收件箱" })}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel={localize({ en: "unread", zh: "未读" })}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {conferenceRoomChatEnabled ? (
            <SidebarNavItem to="/board-chat" label={localize({ en: "Conference Room", zh: "会议室" })} icon={MessagesSquare} />
          ) : null}
        </div>

        <SidebarSection label={localize({ en: "Work", zh: "工作" })}>
          <SidebarNavItem to="/issues" label={localize({ en: "Tasks", zh: "任务" })} icon={CircleDot} />
          <SidebarNavItem to="/routines" label={localize({ en: "Routines", zh: "定时任务" })} icon={Repeat} />
          {showPipelines ? (
            <SidebarNavItem to="/pipelines" label={localize({ en: "Pipelines", zh: "流程" })} icon={GitBranch} />
          ) : null}
          <SidebarNavItem to="/goals" label={localize({ en: "Goals", zh: "目标" })} icon={Target} />
          <SidebarNavItem to="/artifacts" label={localize({ en: "Artifacts", zh: "产物" })} icon={Package} />
          <SidebarNavItem to="/skills" label={localize({ en: "Skills", zh: "技能" })} icon={Boxes} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={localize({ en: "Workspaces", zh: "工作区" })} icon={GitBranch} />
          ) : null}
          {streamlined ? (
            <SidebarNavItem to="/projects" label={localize({ en: "Projects", zh: "项目" })} icon={FolderOpen} />
          ) : null}
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
          />
        </SidebarSection>

        {/* Classic mode restores the per-project collapsible below Work. */}
        {streamlined ? null : <SidebarProjects />}

        <SidebarAgents streamlined={streamlined} />

        <SidebarSection label={localize({ en: "Company", zh: "公司" })}>
          <SidebarNavItem to="/org" label={localize({ en: "Org", zh: "组织" })} icon={Network} />
          <SidebarNavItem to="/costs" label={localize({ en: "Costs", zh: "成本" })} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={localize({ en: "Activity", zh: "活动" })} icon={History} />
          <SidebarNavItem to="/company/settings" label={localize({ en: "Settings", zh: "设置" })} icon={Settings} />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
