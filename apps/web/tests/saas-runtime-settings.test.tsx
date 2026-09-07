import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RuntimeSettings } from '../src/saas/RuntimeSettings';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it('refreshes the real inventory without exposing secret inputs or claiming inference succeeded', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ engine: 'pi', available: false, configured: false, models: [], reason: 'Pi service is unavailable' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ engine: 'pi', available: true, configured: true, modelConnectivityVerified: false, models: [{ id: 'configured-model' }] })));
  vi.stubGlobal('fetch', fetch);
  const onClose = vi.fn();
  render(<SaaSPreferencesProvider><RuntimeSettings onClose={onClose}/></SaaSPreferencesProvider>);
  await screen.findByText('Unavailable');
  expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh runtime status' }));
  await screen.findByText('configured-model');
  expect(screen.getByText(/an actual canvas run verifies model connectivity/)).toBeVisible();
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/v1/runtime', '/api/v1/runtime']);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});
