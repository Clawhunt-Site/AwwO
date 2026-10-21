import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AcademyLauncher, AcademyProvider } from '../src/saas/Academy';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { page } from '../src/saas/staleBuild';

// The Academy's dialog is its own part of the site. Here that part never loads until the test lets it, and then fails:
// the frame shows meanwhile, can be closed, and a failure says so; each takes the Academy out of the address.
const control = vi.hoisted(() => {
  let fail: () => void = () => {};
  const gate = new Promise<void>(resolve => { fail = resolve; });
  return { gate, fail: () => fail() };
});
vi.mock('../src/saas/AcademyDialog', async () => { await control.gate; throw new Error('The chunk did not load'); });

const TITLE = 'Learn AwwO from real canvases';
const view = () => render(<SaaSPreferencesProvider><AcademyProvider><AcademyLauncher /></AcademyProvider></SaaSPreferencesProvider>);
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState({}, '', '/'); });

it('opens a frame of itself at once while its part loads, which closes and leaves the address as it was', async () => {
  window.history.replaceState({}, '', '/?tenant=t1&academy=umber-photo');
  view();
  const frame = screen.getByRole('dialog', { name: TITLE });
  expect(frame).toHaveAttribute('open');
  expect(frame).toHaveAttribute('aria-busy', 'true');
  expect(within(frame).getByRole('status')).toHaveTextContent('Opening the Academy…');
  fireEvent.click(within(frame).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.search).toBe('?tenant=t1');
});

it('says when its part does not load, and closing that leaves the address as it was', async () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Academy' }));
  expect(screen.getByRole('dialog', { name: TITLE })).toHaveAttribute('aria-busy', 'true');
  // The address has it while it loads, so a reload or a copied link opens it again.
  expect(window.location.search).toBe('?academy');
  await act(async () => { control.fail(); await control.gate; });
  const failed = await screen.findByRole('dialog', { name: 'The Academy could not open' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull());
  fireEvent(failed, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.search).toBe('');
});

it('saves an open canvas before it reloads, and reloads nothing once it was closed while the save ran', async () => {
  let saved: () => void = () => {};
  configureSaaSCanvas({ tenant: { id: 't1', name: 'T', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }, canvasId: 'c1' });
  configureSaaSCanvasSave(() => new Promise<void>(resolve => { saved = resolve; }));
  const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
  try {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Academy' }));
    const failed = await screen.findByRole('dialog', { name: 'The Academy could not open' });
    fireEvent.click(within(failed).getByRole('button', { name: 'Reload the page' }));
    expect(within(failed).getByRole('button', { name: 'Reload the page' })).toBeDisabled();
    fireEvent.click(within(failed).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { saved(); await Promise.resolve(); await Promise.resolve(); });
    expect(reload).not.toHaveBeenCalled();
  } finally { clearSaaSCanvas(); }
});
