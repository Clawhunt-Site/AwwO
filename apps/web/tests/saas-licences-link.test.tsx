import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { COMMITTED, OUTPUT, bundleLicences } from '../scripts/bundle-licences.mjs';
import { appearanceFixture } from './saas-appearance-fixture';

// The file the hosted build writes to the root of the site (scripts/bundle-licences.mjs), which both links open.
const licences = `/${OUTPUT}`;
const WEB = path.resolve(__dirname, '..');
const identity = { user: { id: 'member-1', name: 'Ada', email: 'ada@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', status: 'active', role: 'owner' }], authentication: 'local' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const unauthorized = () => response({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401);
const NAMES = [['zh', '开源许可'], ['en', 'Open-source licenses']] as const;

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); localStorage.clear(); sessionStorage.clear(); });

function expectLicencesLink(link: HTMLElement) {
  expect(link).toHaveAttribute('href', licences);
  // In a tab of its own, as the skill library opens its license texts, and it says so.
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noreferrer');
  expect(link.getAttribute('title')).toMatch(/新窗口|new window/);
}

it.each(NAMES)('links the license texts from the sign-in page, after the cases (%s)', async (locale, name) => {
  localStorage.setItem('superclaw_locale', locale);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ clawhuntSSO: true, localAuth: false, clawhuntSiteURL: 'https://clawhunt.store' })));
  render(<SaaSApp />);
  const link = await screen.findByRole('link', { name });
  expectLicencesLink(link);
  expect(link.closest('footer')).toHaveClass('saas-login-footer');
  // At the end of the page, after the cases a visitor sees first.
  const cases = await screen.findByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' });
  expect(cases.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('links them while the sign-in methods cannot be read', async () => {
  localStorage.setItem('superclaw_locale', 'zh');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? unauthorized() : response({ error: { code: 'unavailable' } }, 503)));
  render(<SaaSApp />);
  await screen.findByRole('heading', { level: 2, name: '无法确认登录方式' });
  expectLicencesLink(screen.getByRole('link', { name: '开源许可' }));
});

it.each(NAMES)('links them from the workspace menu (%s)', async (locale, name) => {
  localStorage.setItem('superclaw_locale', locale);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/me') ? response(identity) : url.endsWith('/appearance') ? response(appearanceFixture) : response({ items: [] })));
  render(<SaaSApp />);
  const more = await screen.findByRole('button', { name: locale === 'zh' ? '更多选项' : 'More options' });
  // Inside the menu, not on the workspace page itself.
  expect(screen.queryByRole('link', { name })).toBeNull();
  fireEvent.click(more);
  expectLicencesLink(await screen.findByRole('link', { name }));
});

type DevResponse = { headers: Record<string, string>; body: unknown; setHeader: (key: string, value: string) => void; end: (body: unknown) => void };
type Handler = (req: { url?: string }, res: DevResponse, next: () => void) => void;

it('serves the committed text at that path in the dev server, which would otherwise answer with a page', () => {
  const plugin = bundleLicences(WEB).find(entry => entry.name === 'awwo-bundle-licences-serve') as unknown as
    { apply: string; configureServer: (server: { middlewares: { use: (handler: Handler) => void } }) => void };
  expect(plugin.apply).toBe('serve');
  let handler: Handler = () => {};
  plugin.configureServer({ middlewares: { use: added => { handler = added; } } });
  const request = (url: string) => {
    const res: DevResponse = { headers: {}, body: undefined, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
    const next = vi.fn();
    handler({ url }, res, next);
    return { res, next };
  };
  for (const url of [licences, `${licences}?v=1`]) {
    const { res, next } = request(url);
    expect(next).not.toHaveBeenCalled();
    expect(res.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(Buffer.from(res.body as Uint8Array).equals(readFileSync(path.join(WEB, COMMITTED)))).toBe(true);
  }
  for (const url of ['/', '/saas.html', `/assets${licences}`, `${licences}x`]) {
    const { res, next } = request(url);
    expect(next).toHaveBeenCalledOnce();
    expect(res.body).toBeUndefined();
  }
});
