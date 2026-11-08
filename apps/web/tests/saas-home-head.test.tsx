// The head in the middle of 首页 (owner 2026-11-08: the bare ball there becomes the icon designed for the loading pages):
// the boot head's plate, collar and face with the calm eyes, no arc going round (nothing is loading), its own idle
// loops in system.css (a glance and a blink, only where motion is welcome), and no trace of the old orb.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AVATAR_CRESCENT, AVATAR_FACES } from '../src/canvas/avatarFace';
import { HomeHead } from '../src/saas/home/HomeHead';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'tenant-h', name: 'Workspace H', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-h', name: 'Hana', email: 'h@example.test', platformRole: 'user' }, tenants: [tenant] };
// Read as tests/saas-boot-head.test.tsx reads them (the run's folder is apps/web).
const css = readFileSync(resolve(process.cwd(), 'src/saas/design/system.css'), 'utf8');
const html = readFileSync(resolve(process.cwd(), 'saas.html'), 'utf8');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('superclaw_locale', 'zh');
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(new URL(input, 'http://localhost').pathname.endsWith('/runtime')
    ? { available: true, configured: true, plannerAvailable: true, models: [{ id: 'model' }] } : { items: [], nextCursor: null }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the home’s head', () => {
  it('stands in the hero above the title, where the orb was', () => {
    const { container } = render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
    const hero = container.querySelector('.saas-home-hero')!;
    const head = hero.querySelector('.saas-home-head')!;
    expect(head).not.toBeNull();
    expect(hero.firstElementChild).toBe(head);
    expect(head.nextElementSibling).toHaveClass('saas-home-workspace');
    expect(container.querySelector('.saas-home-orb')).toBeNull();
  });

  it('is the loading pages’ head at rest: plate, collar, face, chin light and calm eyes, with no arc going round', () => {
    const { container } = render(<HomeHead />);
    const head = container.firstElementChild!;
    expect(head).toHaveClass('awwo-boot-head', 'saas-home-head');
    expect(head).toHaveAttribute('aria-hidden', 'true');
    expect(head.querySelector('.awwo-boot-plate')).not.toBeNull();
    expect(head.querySelector('.awwo-boot-ring circle.awwo-boot-collar')?.getAttribute('r')).toBe('52');
    expect(head.querySelector('.awwo-boot-orbit, .awwo-boot-arc')).toBeNull();
    expect(head.querySelector('.awwo-boot-crescent path')?.getAttribute('d')).toBe(AVATAR_CRESCENT);
    expect(head.querySelector('.awwo-boot-face > .awwo-boot-rim')).not.toBeNull();
    const eyes = [...head.querySelectorAll('.awwo-boot-gaze .awwo-boot-blink rect')].map(rect =>
      ['x', 'y', 'width', 'height'].map(name => Number(rect.getAttribute(name))));
    const calm = AVATAR_FACES.calm.map(eye => eye.shape === 'capsule' ? [eye.cx - eye.w / 2, eye.cy - eye.h / 2, eye.w, eye.h] : []);
    expect(eyes).toEqual(calm);
    // The calm eyes are not the working ones the loading head shows.
    expect(AVATAR_FACES.calm).not.toEqual(AVATAR_FACES.working);
  });

  it('moves by loops of its own, only where motion is welcome, and keeps the loading head’s look', () => {
    const motion = css.match(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.saas-home-head \.awwo-boot-gaze \{ animation: saas-home-glance [^}]*\}\s*\.saas-home-head \.awwo-boot-blink \{ animation: saas-home-blink [^}]*\}\s*\}/);
    expect(motion).not.toBeNull();
    expect(css).toMatch(/@keyframes saas-home-glance \{/);
    expect(css).toMatch(/@keyframes saas-home-blink \{/);
    // Not named awwo-boot-*: the loading head's phase lock (lockBootPhase) leaves these loops alone.
    expect(css).not.toMatch(/\.saas-home-head[^{]*\{[^}]*animation:[^}]*awwo-boot-/);
    // The phone's size outranks saas.html's 96 px, whichever comes later in the page.
    expect(css).toMatch(/\.saas-home-head\.awwo-boot-head \{ width: 72px; height: 72px;/);
    // The look itself is saas.html's, the loading head's (its plate, collar, face and forced-colour rules).
    for (const rule of ['.awwo-boot-head{', '.awwo-boot-plate{', '.awwo-boot-collar{', '.awwo-boot-head>.awwo-boot-face{', '@media (forced-colors:active){.awwo-boot-plate']) {
      expect(html).toContain(rule);
    }
    expect(css).not.toContain('saas-home-orb');
  });
});
