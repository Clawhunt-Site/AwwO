import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import GeneratedOfficialDemo from '../src/saas/examples/GeneratedOfficialDemo';

const documents: JSDOM[] = [];
beforeEach(() => sessionStorage.clear());
afterEach(() => { documents.forEach(dom => dom.window.close()); documents.length = 0; cleanup(); vi.restoreAllMocks(); });

// Execute the curated Orbit preview and its real controls. Only the browser's
// cross-frame transport is represented here; no storage or pricing is mocked.
function openPreview(frame: HTMLIFrameElement) {
  const dom = new JSDOM(frame.srcdoc, {
    runScripts: 'dangerously',
    beforeParse(win) {
      Object.defineProperty(win, 'parent', { value: {
        postMessage(data: unknown) { window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow, origin: 'null' })); },
      } });
    },
  });
  documents.push(dom);
  return dom;
}

function selectStarter(dom: JSDOM) {
  const doc = dom.window.document;
  (doc.querySelector('[data-plan="Starter"]') as HTMLElement).click();
  const seats = doc.querySelector('#headcount-input') as HTMLInputElement;
  seats.value = '3';
  seats.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  (doc.querySelector('[data-cycle="monthly"]') as HTMLElement).click();
  expect(doc.querySelector('#cycle-bill')?.textContent).toBe('¥117');
}

function frame() { return screen.getByTitle('Orbit result') as HTMLIFrameElement; }
function mount() { return render(<GeneratedOfficialDemo id="interaction-page" title="Orbit result" />); }

it('preserves the chosen plan, seats and billing across the sign-in navigation without changing prices', () => {
  const mounted = mount();
  expect(frame()).toHaveAttribute('sandbox', 'allow-scripts');
  selectStarter(openPreview(frame()));
  mounted.unmount();
  // A fresh page after OAuth uses the same tab storage.
  mount();
  const restored = openPreview(frame()).window.document;
  expect(restored.querySelector('[data-plan="Starter"]')).toHaveAttribute('aria-checked', 'true');
  expect(restored.querySelector('#headcount-input')).toHaveValue(3);
  expect(restored.querySelector('[data-cycle="monthly"]')).toHaveAttribute('aria-checked', 'true');
  expect(restored.querySelector('#cycle-bill')?.textContent).toBe('¥117');
});

it('ignores messages from other frames and malformed or out-of-bounds preview state', () => {
  const mounted = mount();
  selectStarter(openPreview(frame()));
  const message = { type: 'awwo:official-demo-state', id: 'interaction-page', state: { plan: 'Scale', seats: 30, billing: 'yearly' } };
  window.dispatchEvent(new MessageEvent('message', { data: message, source: window, origin: 'null' }));
  window.dispatchEvent(new MessageEvent('message', { data: message, source: frame().contentWindow, origin: 'https://untrusted.example' }));
  for (const state of [null, { plan: 'Starter', seats: 31, billing: 'monthly' }, { plan: 'Studio', seats: 2.5, billing: 'monthly' }, { plan: '<script>', seats: 3, billing: 'monthly' }, { plan: 'Studio', seats: 3, billing: 'arbitrary' }]) {
    window.dispatchEvent(new MessageEvent('message', { data: { ...message, state }, source: frame().contentWindow, origin: 'null' }));
  }
  window.dispatchEvent(new MessageEvent('message', { data: { ...message, id: 'model-lab' }, source: frame().contentWindow, origin: 'null' }));
  mounted.unmount(); mount();
  expect(openPreview(frame()).window.document.querySelector('#cycle-bill')?.textContent).toBe('¥117');
});

it('expires demo choices after thirty minutes and still works if tab storage is unavailable', () => {
  let mounted = mount();
  selectStarter(openPreview(frame()));
  mounted.unmount();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
  mounted = mount();
  const expired = openPreview(frame()).window.document;
  expect(expired.querySelector('[data-plan="Studio"]')).toHaveAttribute('aria-checked', 'true');
  expect(expired.querySelector('#headcount-input')).toHaveValue(10);
  mounted.unmount();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  mount();
  expect(() => selectStarter(openPreview(frame()))).not.toThrow();
});
