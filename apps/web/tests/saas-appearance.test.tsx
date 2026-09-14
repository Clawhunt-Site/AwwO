import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import catalog from '../../../backend/internal/app/appearance_catalog.json';
import { AppearanceScope, SaaSAppearanceControl } from '../src/saas/SaaSAppearance';
import { SaaSPreferencesProvider, PreferenceControls } from '../src/saas/preferences';
const payload = (id = 'default', version = 0) => ({ ...catalog, active_preset: id, version, custom: { light: {}, dark: {} } });
const wrap = (id = 'alice') => <SaaSPreferencesProvider><AppearanceScope key={id} userId={id}><PreferenceControls/><SaaSAppearanceControl/><p>Workspace remains usable</p></AppearanceScope></SaaSPreferencesProvider>;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.documentElement.removeAttribute('style'); });
function locale() { localStorage.setItem('superclaw_locale', 'en'); localStorage.setItem('superclaw_theme', 'dark'); }
it('persists a preset through the API, projects both themes and reloads the saved choice', async () => {
  locale(); let server = payload();
  const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') { const b = JSON.parse(init.body as string); expect(b.version).toBe(server.version); server = { ...server, ...b, version: server.version + 1 }; }
    return new Response(JSON.stringify(server));
  }); vi.stubGlobal('fetch', fetch);
  const view = render(wrap());
  await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled());
  fireEvent.click(screen.getByText('Color scheme settings')); fireEvent.click(screen.getByRole('radio', { name: 'Emerald' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Emerald' })).toHaveAttribute('aria-checked', 'true'));
  expect(server.active_preset).toBe('emerald');
  const emerald = catalog.presets.find(p => p.id === 'emerald')!;
  expect(document.documentElement.style.getPropertyValue('--accent')).toBe(emerald.overrides.dark.accent);
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); fireEvent.click(screen.getByRole('button', { name: 'Use light theme' }));
  expect(document.documentElement.style.getPropertyValue('--accent')).toBe(emerald.overrides.light.accent);
  view.unmount(); expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  render(wrap()); await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe(emerald.overrides.light.accent));
});
it('keeps the confirmed palette on CAS failure and offers reload without retrying the write', async () => {
  locale(); let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') { writes++; return new Response(JSON.stringify({ error: { code: 'version_conflict', message: 'conflict' } }), { status: 409 }); }
    return new Response(JSON.stringify(payload('midnight', 4)));
  }));
  render(wrap()); await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled());
  fireEvent.click(screen.getByText('Color scheme settings')); fireEvent.click(screen.getByRole('radio', { name: 'Emerald' }));
  await screen.findByRole('alert'); expect(screen.getByRole('radio', { name: 'Midnight' })).toHaveAttribute('aria-checked', 'true');
  expect(writes).toBe(1); fireEvent.click(screen.getByText('Reload color scheme'));
  await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled()); expect(writes).toBe(1);
  const bundle = { kind: 'superclaw.appearance', schema_version: '0.1.0', active_preset: 'emerald', custom: { light: {}, dark: {} } };
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [{ text: async () => JSON.stringify(bundle) }] } });
  await waitFor(() => expect(screen.getAllByText('The color scheme changed in another page. Reload the color scheme and try again.')).toHaveLength(2));
  expect(screen.queryByText(/canvas version|canvas has changed/i)).toBeNull(); expect(writes).toBe(2);
  expect(screen.getByRole('radio', { name: 'Midnight' })).toHaveAttribute('aria-checked', 'true');
});
it('does not let malformed successful appearance responses crash the workspace', async () => {
  locale(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }))));
  render(wrap()); await screen.findByRole('alert'); expect(screen.getByText('Workspace remains usable')).toBeVisible();
  expect(screen.getByText('Color scheme settings')).toBeDisabled(); expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
});
it('ignores a late response after the signed-in user changes and clears the prior colors', async () => {
  locale(); let resolveAlice!: (r: Response) => void;
  const alice = new Promise<Response>(r => { resolveAlice = r; });
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(alice).mockResolvedValueOnce(new Response(JSON.stringify(payload('emerald', 2)))));
  const view = render(wrap('alice')); view.rerender(wrap('bob'));
  await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled());
  await act(async () => { resolveAlice(new Response(JSON.stringify(payload('midnight', 99)))); await alice; });
  fireEvent.click(screen.getByText('Color scheme settings')); expect(screen.getByRole('radio', { name: 'Emerald' })).toHaveAttribute('aria-checked', 'true');
});
it('rejects an incompatible import before writing and reports an export creation failure', async () => {
  locale(); const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload()))); vi.stubGlobal('fetch', fetch);
  render(wrap()); await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled()); fireEvent.click(screen.getByText('Color scheme settings'));
  const input = document.querySelector('input[type=file]')!;
  fireEvent.change(input, { target: { files: [{ text: async () => JSON.stringify({ kind: 'other' }) }] } });
  await screen.findByText('Unsupported color scheme format or version.'); expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Advanced — custom colors'));
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('denied'); });
  fireEvent.click(screen.getByText('Export')); await screen.findByText(/Could not export the color scheme/);
});
it('serializes rapid color changes so the final user selection reaches PostgreSQL', async () => {
  locale(); let server = payload('custom', 1); let release!: () => void; const held = new Promise<void>(r => { release = r; }); let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') { writes++; if (writes === 1) await held; const b = JSON.parse(init.body as string); expect(b.version).toBe(server.version); server = { ...server, ...b, version: server.version + 1 }; }
    return new Response(JSON.stringify(server));
  }));
  render(wrap()); await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled()); fireEvent.click(screen.getByText('Color scheme settings'));
  fireEvent.click(screen.getByText('Advanced — custom colors')); const color = screen.getByLabelText('Accent color');
  fireEvent.change(color, { target: { value: '#112233' } }); fireEvent.change(color, { target: { value: '#445566' } });
  await waitFor(() => expect(writes).toBe(1)); await act(async () => { release(); await held; });
  await waitFor(() => expect(server.custom.dark).toMatchObject({ accent: '#445566' })); expect(writes).toBe(2); expect(server.version).toBe(3);
});
it('roundtrips a valid original appearance bundle and exports only confirmed fields', async () => {
  locale(); let server = payload(); let exported: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { exported = blob as Blob; return 'blob:fixture'; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') { const b = JSON.parse(init.body as string); expect(b).toMatchObject({ version: 0, active_preset: 'custom' }); server = { ...server, ...b, version: 1 }; }
    return new Response(JSON.stringify(server));
  }));
  render(wrap()); await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled()); fireEvent.click(screen.getByText('Color scheme settings'));
  const bundle = { kind: 'superclaw.appearance', schema_version: '0.1.0', active_preset: 'custom', custom: { light: { accent: '#abcdef' }, dark: { accent: '#123456' } } };
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [{ text: async () => JSON.stringify(bundle) }] } });
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Custom' })).toHaveAttribute('aria-checked', 'true'));
  fireEvent.click(screen.getByText('Advanced — custom colors')); fireEvent.click(screen.getByText('Export'));
  expect(JSON.parse(await exported!.text())).toEqual(bundle);
});
it('uses one modal when opened from runtime settings and returns to the runtime page', async () => {
  locale(); const { RuntimeSettings } = await import('../src/saas/RuntimeSettings');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/appearance') ? payload() : { engine: 'pi', available: true, configured: true, models: [] }))));
  render(<SaaSPreferencesProvider><AppearanceScope userId="alice"><RuntimeSettings tenantId="tenant-a" onClose={() => {}}/></AppearanceScope></SaaSPreferencesProvider>);
  await waitFor(() => expect(screen.getByText('Color scheme settings')).toBeEnabled()); fireEvent.click(screen.getByText('Color scheme settings'));
  expect(screen.getAllByRole('dialog')).toHaveLength(1); expect(screen.queryByText('Refresh runtime status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus(); fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1); await screen.findByText('Refresh runtime status');
});
