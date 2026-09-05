// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopNav } from "./TopNav";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockInboxBadge = vi.hoisted(() => ({ inbox: 0, failedRuns: 0 }));

const mockOpenNewIssue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: mockOpenNewIssue }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "ACME", name: "Acme Co" },
  }),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => mockInboxBadge,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: ({ slotTypes }: { slotTypes: string[] }) => (
    <div data-plugin-slot-types={slotTypes.join(",")}>Plugin slot outlet</div>
  ),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: ({ placementZones }: { placementZones: string[] }) => (
    <div data-plugin-launcher-zone={placementZones.join(",")}>Plugin launcher outlet</div>
  ),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("TopNav", () => {
  let container: HTMLDivElement;

  async function renderTopNav() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <TopNav />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  function hrefs() {
    return [...container.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockInboxBadge.inbox = 0;
    mockInboxBadge.failedRuns = 0;
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the in-company routes as a horizontal grouped tab bar", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderTopNav();

    // The in-company routes (minus Companies + Goals, which are intentionally
    // dropped from the top-nav).
    expect(hrefs()).toEqual(
      expect.arrayContaining([
        "/dashboard",
        "/inbox",
        "/issues",
        "/routines",
        "/artifacts",
        "/skills",
        "/projects",
        "/agents",
        "/org",
        "/costs",
        "/activity",
        "/company/settings",
      ]),
    );
    // Companies + Goals are hidden from the top-nav.
    expect(hrefs()).not.toContain("/companies");
    expect(hrefs()).not.toContain("/goals");
    // Group labels are preserved (grouping requirement).
    expect(container.textContent).toContain("Work");
    expect(container.textContent).toContain("Company");
    expect(container.textContent).toContain("New Task");

    flushSync(() => root.unmount());
  });

  it("exposes Agents as a single tab into the agents page, NOT an inline per-agent list", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderTopNav();

    const agentLinks = hrefs().filter((h) => h?.startsWith("/agents"));
    expect(agentLinks).toEqual(["/agents"]);

    flushSync(() => root.unmount());
  });

  it("renders Chinese labels when the board locale is Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderTopNav();

    expect(container.textContent).toContain("仪表盘");
    expect(container.textContent).toContain("收件箱");
    expect(container.textContent).toContain("工作");
    expect(container.textContent).toContain("任务");
    expect(container.textContent).toContain("公司");
    expect(container.textContent).toContain("设置");
    expect(container.textContent).toContain("新任务");
    // Routines is "定时任务" (scheduled tasks), not the old "例行任务".
    expect(container.textContent).toContain("定时任务");
    expect(container.textContent).not.toContain("例行任务");

    flushSync(() => root.unmount());
  });

  it("gates flag-controlled routes the same way the sidebar does", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enablePipelines: false,
      enableConferenceRoomChat: false,
    });
    const root = await renderTopNav();

    expect(hrefs()).not.toContain("/pipelines");
    expect(hrefs()).not.toContain("/workspaces");
    expect(hrefs()).not.toContain("/board-chat");

    flushSync(() => root.unmount());

    // Flip the flags on → the routes appear.
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: true,
      enablePipelines: true,
      enableConferenceRoomChat: true,
    });
    const root2 = await renderTopNav();
    expect(hrefs()).toEqual(
      expect.arrayContaining(["/pipelines", "/workspaces", "/board-chat"]),
    );
    flushSync(() => root2.unmount());
  });

  it("shows the inbox badge with a danger tone when runs have failed", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockInboxBadge.inbox = 7;
    mockInboxBadge.failedRuns = 2;
    const root = await renderTopNav();

    const inboxLink = [...container.querySelectorAll("nav a")].find(
      (a) => a.getAttribute("href") === "/inbox",
    );
    expect(inboxLink?.textContent).toContain("7");

    flushSync(() => root.unmount());
  });

  it("fires the host New Task action", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    const root = await renderTopNav();

    const newTask = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("New Task"),
    );
    expect(newTask).toBeTruthy();
    flushSync(() => {
      newTask!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockOpenNewIssue).toHaveBeenCalledTimes(1);

    flushSync(() => root.unmount());
  });
});
