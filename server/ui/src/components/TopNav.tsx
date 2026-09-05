import {
  // Top-nav icons are deliberately a DIFFERENT-but-similar set from the left
  // Sidebar's (so the embedded top-nav reads as its own chrome, not a relocated
  // sidebar) — semantics stay obvious. Reviewed with Codex against lucide-react.
  Gauge,
  MailOpen,
  ListTodo,
  CalendarClock,
  PackageOpen,
  Blocks,
  Bot,
  Waypoints,
  Wallet,
  ScrollText,
  SlidersHorizontal,
  PenLine,
  Workflow,
  FolderGit2,
  FolderKanban,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { useLocalizedText } from "@/i18n/localized";
import { cn } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Button } from "./ui/button";

// TopNav — the embedded board's primary in-company navigation rendered as a
// horizontal grouped tab bar (super's Team-panel embed requests it via
// BoardChromeContext `chrome: "top-nav"`). It is a presentation-only sibling of
// <Sidebar/>: it draws from the same route set + flags/badges, but with its own
// DIFFERENT-but-similar icons and a trimmed list (Companies + Goals are dropped
// from the top nav — Companies stays reachable via the host breadcrumb), laid out
// across the top, with the host owning the surrounding shell (back button,
// account/theme). Standalone board keeps the vertical <Sidebar/>.
//
// Why not reuse SidebarNavItem/SidebarSection: those read the global sidebar
// collapse state and intentionally render icon-only ("rail") on takeover routes
// (company settings / skills / plugin route-sidebars force-collapse the primary
// rail). In a top bar that would silently drop the labels on exactly the routes
// that need them, so TopNav uses its own collapse-independent item components.
//
// Dynamic per-agent lists, plugin *panels*, and the account menu are NOT
// inlined here (they don't fit a horizontal bar): "Agents" is a single tab into
// the agents list page, plugin sidebar *nav* entries render as tabs via the same
// outlets, and account/theme chrome is owned by the host.

interface TopNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Unread/count badge (e.g. Inbox). */
  badge?: number;
  badgeTone?: "default" | "danger";
  /** Red attention dot on the icon (e.g. failed runs). */
  alert?: boolean;
  /** Live-run count (e.g. Dashboard) shown as an emerald dot + count. */
  liveCount?: number;
}

function TopNavItem({
  to,
  label,
  icon: Icon,
  end,
  badge,
  badgeTone = "default",
  alert = false,
  liveCount,
}: TopNavItemProps) {
  const hasBadge = badge != null && badge > 0;
  const hasLive = liveCount != null && liveCount > 0;

  return (
    <NavLink
      to={to}
      end={end}
      state={SIDEBAR_SCROLL_RESET_STATE}
      className={({ isActive }) =>
        cn(
          "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 h-8 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-muted/75 text-foreground dark:bg-muted/45"
            : "text-foreground/80 hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/35",
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" />
        {alert && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="truncate">{label}</span>
      {hasLive && (
        <span
          className="ml-0.5 inline-flex h-2 w-2 shrink-0 rounded-full bg-emerald-500"
          aria-label={`${liveCount} live`}
        />
      )}
      {hasBadge && (
        <span
          className={cn(
            "ml-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[11px] leading-none",
            badgeTone === "danger"
              ? "bg-red-600/90 text-red-50"
              : "bg-primary text-primary-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}

function TopNavGroup({
  label,
  ariaLabel,
  children,
}: {
  label?: string;
  /** Accessible name when there is no visible group label (e.g. the primary group). */
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      role="group"
      aria-label={label ?? ariaLabel}
      data-nav-measure="group"
    >
      {label ? (
        <span className="mr-1 shrink-0 select-none text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {label}
        </span>
      ) : null}
      {children}
    </div>
  );
}

function TopNavDivider() {
  return <span className="mx-1.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
}

export function TopNav() {
  const localize = useLocalizedText();
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
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
  // Same nav-gating flags as <Sidebar/> (single source of which routes show).
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const showPipelines = experimentalSettings?.enablePipelines === true;
  const streamlined = experimentalSettings?.enableStreamlinedLeftNavigation !== false;
  const conferenceRoomChatEnabled = experimentalSettings?.enableConferenceRoomChat === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  // Responsive layout: show every tab on ONE row when the panel is wide enough;
  // otherwise stack — each group on its own row (not a horizontal scroll). We
  // compute the single-row width needed as the SUM of each group's + the New Task
  // button's INTRINSIC width (read via getBoundingClientRect; groups stay shrink-0
  // and the column uses items-start, so a group's width is its content width in
  // BOTH layouts) plus a fixed allowance for the on-one-row dividers + gaps. That
  // sum is layout-independent, so the stack decision can't flip-flop (no reliance
  // on scrollWidth, which clamps to clientWidth once content fits). Guarded for
  // SSR/jsdom where ResizeObserver is absent (mirrors FoldCurtain) — it then stays
  // single-row, the correct default.
  const navRef = useRef<HTMLElement | null>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    // Guard upfront: with no ResizeObserver (SSR/jsdom) we can't measure live, so
    // skip entirely and keep the single-row default (stacked=false). Running
    // measure() here would mis-stack — getBoundingClientRect is 0 in jsdom, so
    // `clientWidth(0) < needed(80)` would wrongly stack.
    if (typeof ResizeObserver === "undefined") return;
    const el = navRef.current;
    if (!el) return;
    const measure = () => {
      let needed = 0;
      // data-nav-measure="group" marks every group regardless of DOM depth.
      // In stacked mode the overview group is nested inside a flex-row wrapper (not a
      // direct nav child), so :scope > [role='group'] would miss it; the data attr
      // selector finds it at any depth within nav. Work + Company groups are direct
      // children in both modes and also carry the attribute (via TopNavGroup).
      el.querySelectorAll("[data-nav-measure='group']").forEach((g) => {
        needed += (g as HTMLElement).getBoundingClientRect().width;
      });
      // Same reasoning: button is a direct nav child in non-stacked mode but nested
      // inside the first-row wrapper in stacked mode.
      const btn = el.querySelector("[data-nav-measure='button']");
      if (btn) needed += (btn as HTMLElement).getBoundingClientRect().width;
      // Fixed overhead that only exists on one row, all on the content axis:
      // nav px-3 padding (24) + 3 dividers (1px + mx-1.5*2 ≈ 13 each = 39) +
      // root gap-0.5 between the ~8 children (≈ 14). `clientWidth` includes the
      // padding, so it's folded into the allowance. Rounded up a hair so we stack
      // just BEFORE content would collide (overflow-hidden must never clip).
      needed += 80;
      setStacked(el.clientWidth < needed);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Plugin slot/launcher tabs populate asynchronously (React Query); when they
    // appear the nav's *content* grows but its box doesn't, so RO alone wouldn't
    // re-measure. A MutationObserver on the subtree catches those late children
    // (and any badge/label text change) and re-evaluates the fit.
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
    // Re-run when the visible tab set changes (flags/badges) so the threshold is
    // refreshed. Not keyed on `stacked` — the measurement is layout-independent.
  }, [showWorkspacesLink, showPipelines, streamlined, conferenceRoomChatEnabled, inboxBadge.inbox, liveRunCount]);

  // Shared overview items rendered in both stacked (inside flex-row wrapper) and
  // non-stacked (inside TopNavGroup) modes. Agents is inlined here — the previous
  // separate AGENTS section label was removed per design request.
  const overviewItems = (
    <>
      <TopNavItem
        to="/dashboard"
        label={localize({ en: "Dashboard", zh: "仪表盘" })}
        icon={Gauge}
        liveCount={liveRunCount}
      />
      <TopNavItem
        to="/inbox"
        label={localize({ en: "Inbox", zh: "收件箱" })}
        icon={MailOpen}
        badge={inboxBadge.inbox}
        badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
        alert={inboxBadge.failedRuns > 0}
      />
      <TopNavItem to="/agents" label={localize({ en: "Agents", zh: "Agent" })} icon={Bot} />
      {conferenceRoomChatEnabled ? (
        <TopNavItem
          to="/board-chat"
          label={localize({ en: "Conference Room", zh: "会议室" })}
          icon={Presentation}
        />
      ) : null}
    </>
  );

  return (
    <nav
      ref={navRef}
      className={cn(
        "flex w-full shrink-0 gap-0.5 border-b border-border bg-background px-3",
        stacked
          ? "flex-col items-start py-1.5"
          : "h-12 flex-row items-center overflow-hidden",
      )}
      aria-label={localize({ en: "Company navigation", zh: "公司导航" })}
    >
      {stacked ? (
        // In stacked mode the first nav row is a flex-row wrapper that holds the
        // overview group and the New Task button side-by-side. ml-auto on the button
        // naturally aligns it to the far right. No absolute positioning is used:
        //   • button is in-flow → zero risk of vertical overlap with rows below
        //   • flex layout guarantees no horizontal overlap: button is shrink-0,
        //     overview has min-w-0 + overflow-hidden so it shrinks to fit and its
        //     items are clipped before reaching the button — no magic-number needed
        // measure() finds the overview group via data-nav-measure="group" regardless
        // of it being a grandchild of nav (not a direct child).
        <div className="flex w-full items-center gap-0.5">
          <div
            data-nav-measure="group"
            role="group"
            aria-label={localize({ en: "Overview", zh: "概览" })}
            className="flex min-w-0 items-center gap-0.5 overflow-hidden"
          >
            {overviewItems}
          </div>
          <Button
            data-nav-measure="button"
            variant="cta"
            size="sm"
            onClick={() => openNewIssue()}
            className="ml-auto shrink-0 rounded-full"
          >
            <PenLine className="h-4 w-4" />
            {localize({ en: "New Task", zh: "新任务" })}
          </Button>
        </div>
      ) : (
        <TopNavGroup ariaLabel={localize({ en: "Overview", zh: "概览" })}>
          {overviewItems}
        </TopNavGroup>
      )}

      {stacked ? null : <TopNavDivider />}

      <TopNavGroup label={localize({ en: "Work", zh: "工作" })}>
        <TopNavItem to="/issues" label={localize({ en: "Tasks", zh: "任务" })} icon={ListTodo} />
        <TopNavItem to="/routines" label={localize({ en: "Routines", zh: "定时任务" })} icon={CalendarClock} />
        {showPipelines ? (
          <TopNavItem to="/pipelines" label={localize({ en: "Pipelines", zh: "流程" })} icon={Workflow} />
        ) : null}
        <TopNavItem to="/artifacts" label={localize({ en: "Artifacts", zh: "产物" })} icon={PackageOpen} />
        <TopNavItem to="/skills" label={localize({ en: "Skills", zh: "技能" })} icon={Blocks} />
        {showWorkspacesLink ? (
          <TopNavItem to="/workspaces" label={localize({ en: "Workspaces", zh: "工作区" })} icon={FolderGit2} />
        ) : null}
        {streamlined ? (
          <TopNavItem to="/projects" label={localize({ en: "Projects", zh: "项目" })} icon={FolderKanban} />
        ) : null}
        {/* Plugin-contributed sidebar nav entries render as tabs too. The
            outlets emit nav links (icon + label); a horizontal flow lays them
            out as tabs. Plugin *panels* (sidebarPanel) are deliberately not
            mounted in a horizontal bar — they stay sidebar-only. */}
        <PluginSlotOutlet
          slotTypes={["sidebar"]}
          context={pluginContext}
          className="flex shrink-0 items-center gap-0.5"
          itemClassName="text-[13px] font-medium"
          missingBehavior="hidden"
        />
        <PluginLauncherOutlet
          placementZones={["sidebar"]}
          context={pluginContext}
          className="flex shrink-0 items-center gap-0.5"
          itemClassName="text-[13px] font-medium"
        />
      </TopNavGroup>

      {stacked ? null : <TopNavDivider />}

      <TopNavGroup label={localize({ en: "Company", zh: "公司" })}>
        <TopNavItem to="/org" label={localize({ en: "Org", zh: "组织" })} icon={Waypoints} />
        <TopNavItem to="/costs" label={localize({ en: "Costs", zh: "成本" })} icon={Wallet} />
        <TopNavItem to="/activity" label={localize({ en: "Activity", zh: "活动" })} icon={ScrollText} />
        <TopNavItem to="/company/settings" label={localize({ en: "Settings", zh: "设置" })} icon={SlidersHorizontal} />
      </TopNavGroup>

      {/* New Task in non-stacked mode: ml-auto pushes it to the far right of the
          single flex-row. In stacked mode the button lives inside the first-row
          wrapper above (with data-nav-measure="button") so measure() always finds
          exactly one [data-nav-measure='button'] regardless of layout mode. */}
      {stacked ? null : (
        <Button
          data-nav-measure="button"
          variant="cta"
          size="sm"
          onClick={() => openNewIssue()}
          className="ml-auto shrink-0 rounded-full"
        >
          <PenLine className="h-4 w-4" />
          {localize({ en: "New Task", zh: "新任务" })}
        </Button>
      )}
    </nav>
  );
}
