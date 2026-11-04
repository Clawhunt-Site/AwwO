import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';

// The sign-in page's layout in a narrow and a laptop window (2026-11-05, in Chrome): a phone broke the Chinese headline
// inside 同一张 (让 Agent 在同一 / 张画布上协作。), a tablet inside 画布, and from 1080 to 1300 px the page scrolled
// sideways (6 px at 1280).
// jsdom lays nothing out, so the rules are pinned at their source; Chrome measured the result (see the commit).
const css = readFileSync(resolve(process.cwd(), 'src/saas/design/system.css'), 'utf8');
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function signedOut(locale: 'zh' | 'en') {
  localStorage.setItem('superclaw_locale', locale);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options') ? response({ clawhuntSSO: true, localAuth: false })
    : response({ error: { code: 'unauthenticated', message: 'Login required' } }, 401)));
  render(<SaaSApp />);
}

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('writes the Chinese headline as its phrases, each kept whole on its line, and the English as it was', async () => {
  signedOut('zh');
  const headline = await screen.findByRole('heading', { level: 1, name: '让 Agent 在同一张画布上协作。' });
  // 让 Agent on a line of its own; then 在同一张 and 画布上协作。, side by side where they fit, a line each where not.
  expect([...headline.querySelectorAll('.saas-phrase')].map(phrase => phrase.textContent)).toEqual(['让 Agent', '在同一张', '画布上协作。']);
  expect(headline.firstElementChild).toHaveTextContent('让 Agent');
  expect(css).toContain('.saas-login :is(h1, h2) .saas-phrase { display: inline-block; }');
  expect(css).toContain('.saas-login-brand h1 .saas-phrase:first-child { display: block; }');
  cleanup();
  signedOut('en');
  expect((await screen.findByRole('heading', { level: 1, name: 'Bring your agents together on one canvas.' })).querySelector('.saas-phrase')).toBeNull();
});

it('sizes the Chinese headline on a phone so its ten-character second line fits down to 320 px', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 760px) {\n  .saas-login { grid-template-columns: 1fr;'));
  expect(phone.slice(0, phone.indexOf('\n}'))).toContain(':root:lang(zh) .saas-login-brand h1 { font-size: min(34px, calc(10vw - 5px)); }');
});

it('clips the page sideways, where the orb is wider than the card’s column it is centred on', () => {
  const at = css.indexOf('.saas-login {\n  position: relative;');
  expect(at).toBeGreaterThan(0);
  const rule = css.slice(at, css.indexOf('}', at));
  expect(rule).toContain('overflow-x: clip;');
  // clip, which makes no scroll container of the page, as hidden would.
  expect(rule).not.toContain('overflow-x: hidden');
});
