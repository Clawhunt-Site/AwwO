import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSOnboarding, GuideLauncher, TutorialLauncher, onboardingScene, tutorialRequired, tutorialStorageKey, TUTORIAL_REQUIRED_SINCE } from '../src/saas/SaaSOnboarding';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { mainSiteEnvironment, safeMainSiteURL } from '../src/saas/mainSite';
import type { Identity } from '../src/saas/api';
import type { FirstRunTourProps } from '../src/saas/FirstRunTour';
import type { WorkModeTutorialProps } from '../src/saas/WorkModeTutorial';

vi.mock('../src/saas/FirstRunTour', () => ({
  FirstRunTour: ({ open, scene, readOnly, personalEngines, onClose, onAction }: FirstRunTourProps) => open ? <section role="dialog" aria-label={`tour ${scene}`}>
    <span>{readOnly ? 'Read only' : 'Editable'}</span><span>{personalEngines ? 'Personal' : 'Workspace engine'}</span>
    <button onClick={() => onClose(false)}>Dismiss tour</button>
    <button onClick={() => { onClose(false); onAction?.('create-canvas'); }}>Create canvas action</button>
  </section> : null,
}));
vi.mock('../src/saas/WorkModeTutorial', () => ({
  default: ({ open, mandatory, readOnly, onClose, onStart }: WorkModeTutorialProps) => open ? <section role="dialog" aria-label="tutorial">
    <span>{mandatory ? 'Mandatory' : 'Optional'}</span><span>{readOnly ? 'Read only' : 'Editable'}</span>
    {!mandatory && <button onClick={() => onClose(false)}>Skip tutorial</button>}
    <button onClick={() => onClose(true)}>Finish tutorial</button>
    {onStart && <button onClick={() => { onClose(true); onStart(); }}>Write my first brief</button>}
  </section> : null,
}));
let sequence = 0;
const OLD = '2026-09-01T08:00:00Z';
const identity = (createdAt: string | undefined = OLD): Identity => ({ user: { id: `guide-user-${++sequence}`, name: 'New user', email: 'new@example.test', platformRole: 'user' }, personalCredentialsRequired: true,
  tenants: [{ id: 'team', name: 'Team', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 20, ...(createdAt ? { createdAt } : {}) }] });
const newcomer = () => identity(new Date(Date.now() - 3600_000).toISOString());
const content = (user: Identity, ready = true) => <SaaSPreferencesProvider><SaaSOnboarding identity={user}><GuideLauncher /><TutorialLauncher />{ready && <div data-onboarding="canvas-list" />}</SaaSOnboarding></SaaSPreferencesProvider>;
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); history.replaceState(null, '', '/?tenant=team'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); history.replaceState(null, '', '/'); });

it('requires the tutorial only of accounts registered since it shipped, and only for their first two weeks', () => {
  const since = Date.parse(TUTORIAL_REQUIRED_SINCE), day = 86_400_000;
  const at = (createdAt?: string, role = 'owner'): Identity => { const user = identity(createdAt); user.tenants[0].role = role; return user; };
  expect(tutorialRequired(at(new Date(since + day).toISOString()), since + 2 * day)).toBe(true);
  expect(tutorialRequired(at(new Date(since - 1).toISOString()), since + day)).toBe(false);          // registered before the tutorial
  expect(tutorialRequired(at(new Date(since + day).toISOString()), since + 16 * day)).toBe(false);    // past the first 14 days
  expect(tutorialRequired(at(new Date(since + day).toISOString(), 'member'), since + 2 * day)).toBe(false); // joining a team is not registering
  expect(tutorialRequired(at(undefined), since + day)).toBe(false);
  expect(tutorialRequired(at('not a date'), since + day)).toBe(false);
  // The earliest owned workspace is the registration: a newer one does not make an old account new.
  const both = identity(OLD); both.tenants.push({ ...both.tenants[0], id: 'second', createdAt: new Date(since + day).toISOString() });
  expect(tutorialRequired(both, since + 2 * day)).toBe(false);
});

it('opens the tutorial for an existing account once, when the page is ready, and lets it be skipped for good', async () => {
  const user = identity(); const view = render(content(user, false));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(content(user));
  await screen.findByRole('dialog', { name: 'tutorial' });
  expect(screen.getByText('Optional')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Skip tutorial' }));
  expect(localStorage.getItem(tutorialStorageKey(user.user.id))).toBe('dismissed');
  view.unmount(); render(content(user));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // A replay is always available and never mandatory; finishing it records completion.
  fireEvent.click(screen.getByRole('button', { name: 'How AwwO works' }));
  expect(await screen.findByText('Optional')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Finish tutorial' }));
  expect(localStorage.getItem(tutorialStorageKey(user.user.id))).toBe('completed');
});

it('makes a new account finish the tutorial: it comes back until it is completed', async () => {
  const user = newcomer(); const view = render(content(user));
  await screen.findByRole('dialog', { name: 'tutorial' });
  expect(screen.getByText('Mandatory')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Skip tutorial' })).not.toBeInTheDocument();
  // An earlier dismissal, from a skipped replay say, does not excuse it.
  view.unmount(); localStorage.setItem(tutorialStorageKey(user.user.id), 'dismissed');
  const again = render(content(user));
  await screen.findByRole('dialog', { name: 'tutorial' });
  fireEvent.click(screen.getByRole('button', { name: 'Finish tutorial' }));
  expect(localStorage.getItem(tutorialStorageKey(user.user.id))).toBe('completed');
  again.unmount(); render(content(user));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps accounts apart and never fetches or creates anything', async () => {
  const first = identity(); const second = identity(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  localStorage.setItem(tutorialStorageKey(first.user.id), 'completed');
  const view = render(content(first)); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(content(second)); await screen.findByRole('dialog', { name: 'tutorial' });
  fireEvent.click(screen.getByRole('button', { name: 'Finish tutorial' }));
  expect(localStorage.getItem(tutorialStorageKey(second.user.id))).toBe('completed');
  expect(fetch).not.toHaveBeenCalled();
});

it('does not reopen after the tutorial was finished during page loading', async () => {
  const user = identity(); const view = render(content(user, false));
  fireEvent.click(screen.getByRole('button', { name: 'How AwwO works' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Finish tutorial' }));
  view.rerender(content(user));
  await waitFor(() => expect(localStorage.getItem(tutorialStorageKey(user.user.id))).toBe('completed'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('never downgrades a finished tutorial when a replay is skipped', async () => {
  const user = identity(); localStorage.setItem(tutorialStorageKey(user.user.id), 'completed');
  render(content(user));
  fireEvent.click(screen.getByRole('button', { name: 'How AwwO works' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Skip tutorial' }));
  expect(localStorage.getItem(tutorialStorageKey(user.user.id))).toBe('completed');
});

it('hands the last step to the home prompt box, only focusing it', async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const submitted = vi.fn(event => event.preventDefault());
  render(<SaaSPreferencesProvider><SaaSOnboarding identity={identity()}><GuideLauncher />
    <form data-onboarding="canvas-create" onSubmit={submitted}><textarea aria-label="Canvas request" defaultValue="" /></form>
    <div data-onboarding="canvas-list" /></SaaSOnboarding></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Write my first brief' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Canvas request' })).toHaveFocus());
  expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
  expect(submitted).not.toHaveBeenCalled();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

it('offers no prompt-box hand-off to readers or outside the workspace home', async () => {
  const reader = identity(); reader.tenants[0].role = 'reader';
  const view = render(content(reader)); await screen.findByRole('dialog', { name: 'tutorial' });
  expect(screen.getByText('Read only')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Write my first brief' })).not.toBeInTheDocument();
  view.unmount(); history.replaceState(null, '', '/?tenant=team&canvas=one');
  render(<SaaSPreferencesProvider><SaaSOnboarding identity={identity()}><div data-onboarding="canvas-stage" /></SaaSOnboarding></SaaSPreferencesProvider>);
  await screen.findByRole('dialog', { name: 'tutorial' });
  expect(screen.queryByRole('button', { name: 'Write my first brief' })).not.toBeInTheDocument();
});

it('waits for an existing modal to close instead of stealing it', async () => {
  const dialog = document.createElement('dialog'); dialog.setAttribute('open', ''); document.body.append(dialog);
  render(content(identity())); expect(screen.queryByRole('dialog', { name: 'tutorial' })).not.toBeInTheDocument();
  dialog.removeAttribute('open');
  await screen.findByRole('dialog', { name: 'tutorial' }); dialog.remove();
});

it('keeps the page tour on request, with read-only and workspace-engine instructions', async () => {
  const user = identity(); user.tenants[0].role = 'reader'; user.personalCredentialsRequired = false;
  localStorage.setItem(tutorialStorageKey(user.user.id), 'completed');
  render(content(user));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Getting started' }));
  expect(screen.getByRole('dialog', { name: 'tour workspace' })).toBeVisible();
  expect(screen.getByText('Read only')).toBeInTheDocument(); expect(screen.getByText('Workspace engine')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss tour' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('still makes a new account finish the tutorial where nothing can be remembered', async () => {
  const original = localStorage.setItem; localStorage.setItem = () => { throw new Error('disabled'); };
  try {
    render(content(newcomer()));
    expect(await screen.findByText('Mandatory')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip tutorial' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish tutorial' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  } finally { localStorage.setItem = original; }
});

it('does not open by itself for anyone else a tutorial it could not remember, and keeps the menu entry', async () => {
  const original = localStorage.setItem; localStorage.setItem = () => { throw new Error('disabled'); };
  try {
    render(content(identity()));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'How AwwO works' }));
    expect(await screen.findByText('Optional')).toBeInTheDocument();
  } finally { localStorage.setItem = original; }
});

it('lets a completion written by another tab win over a skipped replay in this one', async () => {
  const user = identity(); render(content(user));
  fireEvent.click(await screen.findByRole('button', { name: 'Skip tutorial' }));        // this tab: dismissed
  localStorage.setItem(tutorialStorageKey(user.user.id), 'completed');                  // another tab finished it
  fireEvent.click(screen.getByRole('button', { name: 'How AwwO works' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Skip tutorial' }));
  expect(localStorage.getItem(tutorialStorageKey(user.user.id))).toBe('completed');
});

it('keeps the tutorial usable when local storage is unavailable', async () => {
  const user = identity(); render(content(user)); await screen.findByRole('dialog', { name: 'tutorial' });
  const original = localStorage.setItem; localStorage.setItem = () => { throw new Error('disabled'); };
  try { fireEvent.click(screen.getByRole('button', { name: 'Skip tutorial' })); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); }
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



it('introduces the work mode once, not again on every page', async () => {
  const user = identity();
  const view = render(content(user));
  fireEvent.click(await screen.findByRole('button', { name: 'Finish tutorial' }));
  view.unmount();
  history.replaceState(null, '', '/?tenant=team&canvas=one');
  render(<SaaSPreferencesProvider><SaaSOnboarding identity={user}><GuideLauncher /><div data-onboarding="canvas-stage" /></SaaSOnboarding></SaaSPreferencesProvider>);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Getting started' }));
  expect(screen.getByRole('dialog', { name: 'tour canvas' })).toBeVisible();
});
