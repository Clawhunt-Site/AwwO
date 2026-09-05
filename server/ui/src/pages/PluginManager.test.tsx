// @vitest-environment jsdom

import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page only pulls company/breadcrumb/toast context — stub them so the test focuses
// on the host-capability-store wiring + the data-source gating. The capability store
// and React Query stay REAL, so the render assertions actually prove the gating. This
// lives in server/ui (next to the component) so PluginManager and the test share ONE
// react-query instance; apps/web's vitest resolves the board's react-query to a second
// copy, which breaks rendering a board component there.
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: () => {} }) }));

import { CapabilityStoreProvider } from "@/host/capability-store";
import { PluginManager } from "./PluginManager";

function recordFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url,
      );
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

describe("PluginManager data source by host mode (first render)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // StrictMode double-invokes render/effects — the exact condition that exposed the old
  // effect-registered opener's first-render flash; the context delivery must survive it.
  async function renderPluginManager(opener?: () => void): Promise<string[]> {
    const calls = recordFetch();
    const page = opener ? (
      <CapabilityStoreProvider opener={opener}>
        <PluginManager />
      </CapabilityStoreProvider>
    ) : (
      <PluginManager />
    );
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>{page}</MemoryRouter>
          </QueryClientProvider>
        </StrictMode>,
      );
      // Let react-query's mount-time fetches flush.
      await Promise.resolve();
      await Promise.resolve();
    });
    return calls;
  }

  it("embedded (host provider): requests /plugins/global, never /plugins/examples", async () => {
    const calls = await renderPluginManager(() => {});
    expect(calls.some((u) => u.includes("/plugins/global"))).toBe(true);
    expect(calls.some((u) => u.includes("/plugins/examples"))).toBe(false);
  });

  it("standalone (no provider): requests /plugins/examples, never /plugins/global", async () => {
    const calls = await renderPluginManager();
    expect(calls.some((u) => u.includes("/plugins/examples"))).toBe(true);
    expect(calls.some((u) => u.includes("/plugins/global"))).toBe(false);
  });
});
