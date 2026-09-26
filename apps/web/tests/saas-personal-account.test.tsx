import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  PersonalEngineGate,
  PasswordRecovery,
  AccountSecurity,
  ConnectionSettings,
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
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
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

it("does not request personal credentials in platform LLM Gate mode", () => {
  history.replaceState(null, "", "/?account=engines");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    <SaaSPreferencesProvider>
      <PersonalEngineGate identity={{ ...identity, personalCredentialsRequired: false }}>
        <p>Canvas content</p>
      </PersonalEngineGate>
    </SaaSPreferencesProvider>,
  );
  expect(screen.getByText(/AwwO provides models through LLM Gate/)).toBeVisible();
  expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps existing workspace access visible without a personal connection", async () => {
  const fetch = vi.fn().mockResolvedValue(response(catalog));
  vi.stubGlobal("fetch", fetch);
  gate();
  expect(screen.getByText("Canvas content")).toBeVisible();
  expect(await screen.findByText("No execution engine connected")).toBeVisible();
  expect(screen.getByText(/browse and edit your workspaces, canvases and history/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Connect an engine" })).toHaveAttribute("href", "/?account=engines");
  expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
});

it("keeps workspace access when the connection list fails and allows a retry", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(response(catalog));
  vi.stubGlobal("fetch", fetch);
  gate();
  expect(screen.getByText("Canvas content")).toBeVisible();
  expect(await screen.findByText("Could not check engine connections")).toBeVisible();
  expect(screen.getByRole("link", { name: "Connect an engine" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
  expect(await screen.findByText("No execution engine connected")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("returns to the same canvas when engine settings cannot load", async () => {
  history.replaceState(null, "", "/?tenant=t&canvas=c&account=engines");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  gate();
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByRole("link", { name: "Back to workspace" })).toHaveAttribute("href", "/?tenant=t&canvas=c");
});

it("selects a supported engine and links to LLM Gate from personal settings", async () => {
  history.replaceState(null, "", "/?account=engines");
  const fetch = vi.fn().mockResolvedValue(response(catalog));
  vi.stubGlobal("fetch", fetch);
  gate();
  await screen.findByText("Connect your first engine");
  expect(screen.queryByText("Canvas content")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to workspace" })).toHaveAttribute("href", "/");
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

it("shows a completed connection only after verification and server readback, without storing the key", async () => {
  history.replaceState(null, "", "/?account=engines");
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
  expect(await screen.findByRole("link", { name: "Open workspace" })).toHaveAttribute("href", "/");
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

it("keeps legacy connections unavailable under the Gate-only catalog while allowing removal", async () => {
  history.replaceState(null, "", "/?account=engines");
  const gateCatalog = {
    ...catalog,
    providers: [providers[0]],
    items: [
      {
        id: "legacy-connection",
        name: "Old Claude",
        provider: "anthropic",
        runtime: "pi",
        models: ["legacy-model"],
        hasKey: true,
      },
      {
        id: "empty-gate-connection",
        name: "Empty Gate",
        provider: "llmgate",
        runtime: "pi",
        models: [],
        hasKey: true,
      },
    ],
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(gateCatalog))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      response({
        ...gateCatalog,
        items: gateCatalog.items.slice(1),
      }),
    );
  vi.stubGlobal("fetch", fetch);
  gate();
  await screen.findByText("Connect your first engine");
  expect(screen.queryByText("Canvas content")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open workspace" })).not.toBeInTheDocument();
  expect(screen.getAllByText(/Unavailable for new tasks/)).toHaveLength(2);
  expect(screen.getAllByRole("option", { name: /LLM Gate/ })).toHaveLength(1);
  fireEvent.click(
    within(screen.getByText("Old Claude").closest("article")!).getByRole("button", {
      name: "Remove connection",
    }),
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("Old Claude");
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  await waitFor(() => expect(screen.queryByText("Old Claude")).not.toBeInTheDocument());
  expect(fetch.mock.calls[1][0]).toBe(
    "/api/v1/auth/connections/legacy-connection",
  );
  expect(fetch.mock.calls[1][1].method).toBe("DELETE");
  expect(screen.queryByText("Canvas content")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Open workspace" })).not.toBeInTheDocument();
});

it("verification failure keeps onboarding closed and clears the password field", async () => {
  history.replaceState(null, "", "/?account=engines");
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

it("blocks unavailable email recovery before the user submits anything", async () => {
  const fetch = vi.fn().mockResolvedValue(response({ passwordRecovery: false }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><PasswordRecovery onBack={() => {}} /></SaaSPreferencesProvider>);
  await screen.findByText(/Email recovery is not configured/);
  expect(screen.getByRole('button', { name: 'Send reset link' })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeEnabled();
});

it("retries the capability check and sends recovery only after it is available", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(response({ passwordRecovery: true })).mockResolvedValueOnce(response({}));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><PasswordRecovery onBack={() => {}} /></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'local@example.test' } });
  fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  await screen.findByText(/If this email is registered/);
  expect(fetch.mock.calls[2][0]).toBe('/api/v1/auth/forgot-password');
});

it("reveals only the entered key and resets visibility and stale errors on provider change", async () => {
  history.replaceState(null, "", "/?account=engines");
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(catalog)).mockResolvedValueOnce(response({ error: { code: 'provider_verification_failed' } }, 422)));
  gate(); await screen.findByLabelText('API Key');
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-user-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show API Key' }));
  expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'text');
  fireEvent.click(screen.getByRole('button', { name: 'Verify and save' }));
  await screen.findByRole('alert');
  fireEvent.change(screen.getByLabelText('Model provider'), { target: { value: 'anthropic' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('API Key')).toHaveValue('');
});

it("confirms removal, allows cancellation, and retries readback without repeating deletion", async () => {
  const connected = { ...catalog, items: [{ id: 'c1', name: 'My test connection', provider: 'llmgate', runtime: 'pi', models: ['test-model'], hasKey: true }] };
  const fetch = vi.fn().mockResolvedValueOnce(response({})).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response(catalog));
  vi.stubGlobal('fetch', fetch); const changed = vi.fn();
  render(<SaaSPreferencesProvider><ConnectionSettings catalog={connected} onChange={changed} onboarding={false} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Remove connection', exact: true }));
  expect(screen.getByRole('dialog')).toHaveTextContent('My test connection');
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Remove connection', exact: true })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Remove connection', exact: true }));
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  expect(changed).toHaveBeenCalledWith(catalog);
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

it('keeps a return path for operator accounts with an empty personal connection list', async () => {
  history.replaceState(null, '', '/?tenant=t&canvas=c&account=engines');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(catalog)));
  render(<SaaSPreferencesProvider><PersonalEngineGate identity={{ ...identity, personalCredentialsRequired: false }}><p>Canvas</p></PersonalEngineGate></SaaSPreferencesProvider>);
  expect(await screen.findByRole('link', { name: 'Back to workspace' })).toHaveAttribute('href', '/?tenant=t&canvas=c');
  expect(screen.queryByText('Connect your first engine')).toBeNull();
});

it('never shows a deleted connection again when readback fails and the user closes the dialog', async () => {
  const connected = { ...catalog, items: [{ id: 'c1', name: 'Removed connection', provider: 'llmgate', runtime: 'pi', models: [], hasKey: true }] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({})).mockRejectedValueOnce(new TypeError('offline')));
  function Host() { const [data, setData] = useState(connected); return <ConnectionSettings catalog={data} onChange={setData} onboarding={false} />; }
  render(<SaaSPreferencesProvider><Host /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Remove connection', exact: true }));
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByRole('combobox', { name: 'Model provider' })).toHaveFocus();
  expect(screen.queryByText('Removed connection')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove connection' })).toBeNull();
});
