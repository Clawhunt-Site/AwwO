// Page switches answer at once (a progress line while the next page loads) and the loading surface is the same one
// the HTML shell painted, announced as busy.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { beginNavigation, endNavigation, installNavigationFeedback } from '../src/saas/navigation';
import { BootSurface } from '../src/saas/BootSurface';

afterEach(() => { cleanup(); endNavigation(); document.body.innerHTML = ''; });

function link(href: string, attributes: Record<string, string> = {}) {
  const anchor = document.createElement('a');
  anchor.href = href;
  for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
  anchor.textContent = 'go';
  document.body.append(anchor);
  return anchor;
}
const navigating = () => document.documentElement.dataset.navigating === '1';
// Registered after the feedback listener, so it sees every click un-prevented; this only stops jsdom navigating.
const stopJsdomNavigation = (event: Event) => event.preventDefault();

function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  endNavigation();
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  return navigating();
}

describe('navigation feedback', () => {
  it('marks the page as navigating and clears on demand', () => {
    beginNavigation();
    expect(navigating()).toBe(true);
    endNavigation();
    expect(navigating()).toBe(false);
  });

  it('answers a same-origin page link, and leaves downloads, new tabs, modified clicks, other sites and API routes alone', () => {
    const uninstall = installNavigationFeedback();
    document.addEventListener('click', stopJsdomNavigation);
    try {
      expect(click(link('/app/settings'))).toBe(true);
      expect(click(link('/app/settings', { download: '' }))).toBe(false);
      expect(click(link('/app/settings', { target: '_blank' }))).toBe(false);
      expect(click(link('https://example.com/elsewhere'))).toBe(false);
      expect(click(link('/api/files/1'))).toBe(false);
      expect(click(link('/app/other'), { ctrlKey: true })).toBe(false);
      expect(click(link('/app/other'), { button: 1 })).toBe(false);
    } finally {
      uninstall();
    }
    // Uninstalled: a click is not answered any more.
    expect(click(link('/app/settings'))).toBe(false);
    document.removeEventListener('click', stopJsdomNavigation);
  });

  it('leaves a click another handler already took (an in-app action) alone', () => {
    const uninstall = installNavigationFeedback();
    const anchor = link('/app/settings');
    anchor.addEventListener('click', event => event.preventDefault());
    expect(click(anchor)).toBe(false);
    uninstall();
  });

  it('clears when the page is restored from the back-forward cache', () => {
    const uninstall = installNavigationFeedback();
    beginNavigation();
    window.dispatchEvent(new Event('pageshow'));
    expect(navigating()).toBe(false);
    uninstall();
  });
});

describe('boot surface', () => {
  it('announces a busy status with its text, in the canvas shape when asked', () => {
    const { container } = render(<BootSurface text="正在加载云端画布…" canvas><a href="/">返回</a></BootSurface>);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('正在加载云端画布…');
    expect(container.querySelector('.awwo-boot.is-canvas')).not.toBeNull();
    expect(screen.getByRole('link', { name: '返回' })).toBeTruthy();
  });
});
