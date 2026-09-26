import { useState } from 'react';
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
