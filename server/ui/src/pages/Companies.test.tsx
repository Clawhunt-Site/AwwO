// @vitest-environment jsdom

// Delete-confirm UX on the company directory grid: a failed DELETE must surface its
// error inside the confirm panel (it used to be swallowed — the server 500'd on the
// cascade-order bug and the click read as "nothing happened"), a successful DELETE
// closes the panel, and re-opening the confirm on another card never shows a stale
// error from a previous attempt.

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompaniesApi = vi.hoisted(() => ({
  stats: vi.fn(),
  remove: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockReloadCompanies = vi.hoisted(() => vi.fn());

const testCompanies = [
  {
    id: "company-1",
    name: "Hello Co",
    status: "active",
    issuePrefix: "HEL",
    description: null,
    logoUrl: null,
    brandColor: null,
  },
  {
    id: "company-2",
    name: "Second Co",
    status: "active",
    issuePrefix: "SEC",
    description: null,
    logoUrl: null,
    brandColor: null,
  },
];

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: testCompanies,
    selectedCompanyId: null,
    setSelectedCompanyId: vi.fn(),
    loading: false,
    error: null,
    reloadCompanies: mockReloadCompanies,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("@/i18n/localized", () => ({
  useLocalizedText: () => (text: { en: string; zh: string }) => text.en,
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => <span />,
}));

import { Companies } from "./Companies";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Companies delete confirm", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockCompaniesApi.stats.mockResolvedValue({});
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    queryClient.clear();
    vi.clearAllMocks();
  });

  async function renderCompanies() {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Companies />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function openDeleteConfirm(companyName: string) {
    const card = Array.from(container.querySelectorAll<HTMLElement>('[role="button"].group'))
      .find((element) => element.textContent?.includes(companyName));
    expect(card).toBeTruthy();
    const trigger = card!.querySelector<HTMLButtonElement>('button[aria-label="Company actions"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((element) => element.textContent?.includes("Delete company"));
    expect(item).toBeTruthy();
    await act(async () => {
      item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    return card!;
  }

  function confirmDeleteButton(card: HTMLElement) {
    return Array.from(card.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent?.trim() === "Delete");
  }

  it("surfaces a failed delete inside the confirm panel instead of swallowing it", async () => {
    mockCompaniesApi.remove.mockRejectedValue(new Error("Internal server error"));
    await renderCompanies();
    const card = await openDeleteConfirm("Hello Co");
    expect(card.textContent).toContain("Delete this company and all its data?");

    await act(async () => {
      confirmDeleteButton(card)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.remove).toHaveBeenCalledWith("company-1");
    const alert = card.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Delete failed:");
    expect(alert?.textContent).toContain("Internal server error");
    // The confirm panel stays open so the user can retry or cancel.
    expect(card.textContent).toContain("Delete this company and all its data?");
  });

  it("closes the confirm panel when the delete succeeds", async () => {
    mockCompaniesApi.remove.mockResolvedValue({ ok: true });
    await renderCompanies();
    const card = await openDeleteConfirm("Hello Co");

    await act(async () => {
      confirmDeleteButton(card)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.remove).toHaveBeenCalledWith("company-1");
    expect(card.textContent).not.toContain("Delete this company and all its data?");
    expect(card.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not leak a stale error into another card's confirm panel", async () => {
    mockCompaniesApi.remove.mockRejectedValue(new Error("Internal server error"));
    await renderCompanies();
    const firstCard = await openDeleteConfirm("Hello Co");
    await act(async () => {
      confirmDeleteButton(firstCard)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(firstCard.querySelector('[role="alert"]')).not.toBeNull();

    const secondCard = await openDeleteConfirm("Second Co");
    expect(secondCard.textContent).toContain("Delete this company and all its data?");
    expect(secondCard.querySelector('[role="alert"]')).toBeNull();
  });
});
