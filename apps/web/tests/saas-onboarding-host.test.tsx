import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSOnboarding, GuideLauncher, onboardingScene, onboardingStorageKey } from '../src/saas/SaaSOnboarding';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { mainSiteEnvironment, safeMainSiteURL } from '../src/saas/mainSite';
import type { Identity } from '../src/saas/api';
import type { FirstRunTourProps } from '../src/saas/FirstRunTour';

vi.mock('../src/saas/FirstRunTour', () => ({
  FirstRunTour: ({ open, scene, readOnly, personalEngines, onClose }: FirstRunTourProps) => open ? <section role="dialog" aria-label={scene}>
    <span>{readOnly ? 'Read only' : 'Editable'}</span><span>{personalEngines ? 'Personal' : 'Workspace engine'}</span>
    <button onClick={() => onClose(false)}>Dismiss guide</button><button onClick={() => onClose(true)}>Complete guide</button>
  </section> : null,
}));
let sequence = 0;
const identity = (): Identity => ({ user: { id: `guide-user-${++sequence}`, name: 'New user', email: 'new@example.test', platformRole: 'user' }, personalCredentialsRequired: true,
  tenants: [{ id: 'team', name: 'Team', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 20 }] });
const content = (user: Identity, ready = true) => <SaaSPreferencesProvider><SaaSOnboarding identity={user}><GuideLauncher />{ready && <div data-onboarding="canvas-list" />}</SaaSOnboarding></SaaSPreferencesProvider>;
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); history.replaceState(null, '', '/?tenant=team'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); history.replaceState(null, '', '/'); });

it('waits for the real page, dismisses once per account and can always replay', async () => {
  const user = identity(); const view = render(content(user, false));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(content(user));
  await screen.findByRole('dialog', { name: 'workspace' });
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss guide' }));
  expect(localStorage.getItem(onboardingStorageKey(user.user.id, 'workspace'))).toBe('dismissed');
  view.unmount(); render(content(user));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Getting started' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Complete guide' }));
  expect(localStorage.getItem(onboardingStorageKey(user.user.id, 'workspace'))).toBe('completed');
});

it('keeps users and scenes independent without creating or fetching anything', async () => {
  const first = identity(); const second = identity(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  localStorage.setItem(onboardingStorageKey(first.user.id, 'workspace'), 'completed');
  const view = render(content(first)); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(content(second)); await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Complete guide' }));
  expect(localStorage.getItem(onboardingStorageKey(second.user.id, 'canvas'))).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('does not reopen after a manual dismissal during page loading', async () => {
  const user = identity(); const view = render(content(user, false));
  fireEvent.click(screen.getByRole('button', { name: 'Getting started' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss guide' }));
  view.rerender(content(user));
  await waitFor(() => expect(localStorage.getItem(onboardingStorageKey(user.user.id, 'workspace'))).toBe('dismissed'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('waits for an existing modal to close instead of stealing it', async () => {
  const dialog = document.createElement('dialog'); dialog.setAttribute('open', ''); document.body.append(dialog);
  render(content(identity())); expect(screen.queryByRole('dialog', { name: 'workspace' })).not.toBeInTheDocument();
  dialog.removeAttribute('open');
  await screen.findByRole('dialog', { name: 'workspace' }); dialog.remove();
});

it('uses correct readonly and workspace credential instructions', async () => {
  const user = identity(); user.tenants[0].role = 'reader'; user.personalCredentialsRequired = false;
  render(content(user)); await screen.findByRole('dialog');
  expect(screen.getByText('Read only')).toBeInTheDocument(); expect(screen.getByText('Workspace engine')).toBeInTheDocument();
});

it('keeps guide usable when local storage is unavailable', async () => {
  const user = identity(); render(content(user)); await screen.findByRole('dialog');
  const original = localStorage.setItem; localStorage.setItem = () => { throw new Error('disabled'); };
  try { fireEvent.click(screen.getByRole('button', { name: 'Dismiss guide' })); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); }
  finally { localStorage.setItem = original; }
});

it('excludes auth/security/admin/unknown and suspended workspaces', () => {
  const user = identity();
  for (const search of ['?invite=abc', '?reset=secret', '?account=security', '?tenant=unknown']) expect(onboardingScene(user, search, '/')).toBeNull();
  expect(onboardingScene(user, '', '/admin')).toBeNull();
  expect(onboardingScene(user, '?tenant=team&canvas=c', '/')).toEqual({ scene: 'canvas', readOnly: false });
  expect(onboardingScene(user, '?account=engines&canvas=c', '/')).toEqual({ scene: 'engines', readOnly: false });
  user.tenants[0].status = 'suspended'; expect(onboardingScene(user, '', '/')).toBeNull();
  user.personalCredentialsRequired = false; expect(onboardingScene(user, '?account=engines', '/')).toBeNull();
});

it('accepts HTTPS navigation without secrets or open redirects in every environment', () => {
  expect(safeMainSiteURL('https://main.example.test/awwo')).toBe('https://main.example.test/awwo');
  expect(safeMainSiteURL('https://main.example.test/awwo', 'development')).toBe('https://main.example.test/awwo');
  for (const value of ['', undefined, 'javascript:alert(1)', '//main.example.test', 'http://main.example.test', 'https://key@main.example.test', 'https://@main.example.test', 'https://main.example.test/?token=secret', 'https://main.example.test/#token', 'https://main.example.test/?', 'https://main.example.test/#']) expect(safeMainSiteURL(value)).toBeUndefined();
});

it('permits only literal loopback HTTP sites in explicit development', () => {
  for (const value of ['http://127.0.0.1:8795', 'http://localhost:8795/awwo', 'http://[::1]:8795']) {
    expect(safeMainSiteURL(value, 'development')).toBe(new URL(value).href);
    expect(safeMainSiteURL(value)).toBeUndefined();
    expect(safeMainSiteURL(value, 'production')).toBeUndefined();
  }
  for (const value of [
    'http://main.example.test', 'http://127.1:8795', 'http://2130706433:8795',
    'http://0x7f000001:8795', 'http://127.0.0.1.evil.test:8795', 'http://localhost.evil.test:8795',
    'http://localhost.:8795', 'http://user@localhost:8795', 'http://@localhost:8795',
    'http://localhost:8795/?token=secret', 'http://localhost:8795/#token',
    'http://localhost:8795/?', 'http://localhost:8795/#',
  ]) expect(safeMainSiteURL(value, 'development')).toBeUndefined();
});

it('does not enable local HTTP in a production build even with development mode', () => {
  expect(mainSiteEnvironment({ DEV: true, MODE: 'development' })).toBe('development');
  expect(mainSiteEnvironment({ DEV: false, MODE: 'development' })).toBe('production');
  expect(mainSiteEnvironment({ DEV: true, MODE: 'test' })).toBe('production');
});
