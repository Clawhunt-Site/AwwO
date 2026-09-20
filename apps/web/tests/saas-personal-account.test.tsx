import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  PersonalEngineGate,
  PasswordRecovery,
  AccountSecurity,
} from "../src/saas/PersonalAccount";
import { SaaSPreferencesProvider } from "../src/saas/preferences";
import type { Identity } from "../src/saas/api";

const providers = [
  {
    id: "llmgate",
    name: "LLM Gate · ClawHunt",
    runtimes: ["openai-agents", "pi"],
  },
  { id: "anthropic", name: "Claude / Anthropic", runtimes: ["pi"] },
];
const catalog = {
  items: [],
  providers,
  required: true,
  purchaseURL: "https://api.clawhunt.site/",
};
const identity = {
  user: { id: "user-a", name: "Test", email: "test@example.test" },
  tenants: [],
  personalCredentialsRequired: true,
} as Identity;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  localStorage.setItem("superclaw_locale", "en");
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  history.replaceState(null, "", "/");
});
const gate = () =>
  render(
    <SaaSPreferencesProvider>
      <PersonalEngineGate identity={identity}>
        <p>Canvas content</p>
      </PersonalEngineGate>
    </SaaSPreferencesProvider>,
  );

it("requires a saved personal connection, selects a supported engine and links to LLM Gate", async () => {
  const fetch = vi.fn().mockResolvedValue(response(catalog));
  vi.stubGlobal("fetch", fetch);
  gate();
  await screen.findByText("Connect your first engine");
  expect(screen.queryByText("Canvas content")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Open LLM Gate/ })).toHaveAttribute(
    "href",
    "https://api.clawhunt.site/",
  );
  expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
  fireEvent.change(screen.getByLabelText("Model provider"), {
    target: { value: "anthropic" },
  });
  expect(screen.getByLabelText("Execution engine")).toHaveValue("pi");
  expect(
    screen.queryByRole("option", { name: "OpenAI Agents JS" }),
  ).not.toBeInTheDocument();
});

it("opens the workspace only after verification and server readback, without storing the key", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(catalog))
    .mockResolvedValueOnce(response({ id: "connection" }, 201))
    .mockResolvedValueOnce(
      response({
        ...catalog,
        items: [
          {
            id: "connection",
            name: "Work",
            provider: "llmgate",
            runtime: "pi",
            models: ["model"],
            hasKey: true,
          },
        ],
      }),
    );
  vi.stubGlobal("fetch", fetch);
  gate();
  await screen.findByText("Connect your first engine");
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "synthetic-user-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
  await screen.findByText("Canvas content");
  expect(fetch.mock.calls[1][0]).toBe("/api/v1/auth/connections");
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    provider: "llmgate",
    runtime: "openai-agents",
    name: "",
    apiKey: "synthetic-user-secret",
  });
  expect(JSON.stringify({ ...localStorage })).not.toContain(
    "synthetic-user-secret",
  );
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(
    "synthetic-user-secret",
  );
});

it("verification failure keeps onboarding closed and clears the password field", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(catalog))
    .mockResolvedValueOnce(
      response(
        {
          error: {
            code: "provider_verification_failed",
            message: "Could not verify",
          },
        },
        422,
      ),
    );
  vi.stubGlobal("fetch", fetch);
  gate();
  await screen.findByText("Connect your first engine");
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "synthetic-user-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Canvas content")).not.toBeInTheDocument();
  expect(screen.getByLabelText("API Key")).toHaveValue("");
});

it("does not claim delivery when email recovery is unavailable", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        response(
          {
            error: {
              code: "email_unavailable",
              message: "Password recovery email is not configured.",
            },
          },
          503,
        ),
      ),
  );
  render(
    <SaaSPreferencesProvider>
      <PasswordRecovery token="" onBack={() => {}} />
    </SaaSPreferencesProvider>,
  );
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "test@example.test" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: /Send reset link/ }).closest("form")!,
  );
  await screen.findByRole("alert");
  expect(screen.queryByText(/If the account exists/)).not.toBeInTheDocument();
});

it("checks password confirmation before sending and never requests another account session", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ items: [] }));
  vi.stubGlobal("fetch", fetch);
  render(
    <SaaSPreferencesProvider>
      <AccountSecurity />
    </SaaSPreferencesProvider>,
  );
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "old-password" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "new-password-123" },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: "different-password" },
  });
  fireEvent.submit(screen.getByLabelText("Current password").closest("form")!);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("do not match"),
  );
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    "/api/v1/auth/sessions",
  ]);
});
