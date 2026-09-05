// DOM regression for explicit Tab-boundary handling, not native browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initAccessibility } from '../src/accessibility.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.AWW_JSDOM_PATH || "E:/Bobo's Coding cache/bo-work/superclaw/.worktrees/awwo-agent-canvas/apps/web/node_modules/jsdom");
const fixture = readFileSync(new URL('./responsive-accessibility.html', import.meta.url), 'utf8');

function setup(t, content = fixture) {
  const dom = new JSDOM(content, { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const { document } = window;
  const previousAbortController = globalThis.AbortController;
  globalThis.AbortController = window.AbortController;
  // JSDOM has no layout, native modal state or sequential keyboard navigation.
  window.HTMLElement.prototype.getClientRects = function () {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.hasAttribute('inert') || window.getComputedStyle(node).display === 'none') return [];
    }
    return [{ width: 44, height: 44 }];
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const dialog = document.querySelector('dialog');
  const nativeMatches = dialog.matches.bind(dialog);
  let modal = false;
  dialog.matches = selector => selector === ':modal' ? modal : nativeMatches(selector);
  dialog.showModal = () => {
    modal = true;
    dialog.open = true;
    dialog.querySelector('[autofocus], button, a[href]')?.focus();
  };
  dialog.close = () => {
    dialog.open = false;
    modal = false;
    dialog.dispatchEvent(new window.Event('close'));
  };
  const dispose = initAccessibility(document);
  t.after(() => { dispose(); dom.window.close(); globalThis.AbortController = previousAbortController; });
  const key = (key = 'Tab', options = {}) => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    document.activeElement.dispatchEvent(event);
    return event;
  };
  const open = () => {
    const trigger = document.querySelector('[data-dialog-open]');
    trigger.focus();
    trigger.click();
    document.querySelector('[autofocus]')?.focus();
  };
  return { document, dialog, key, open, dispose, window };
}

test('fixture: Tab from autofocus close button wraps to first link', t => {
  const { document, dialog, key, open } = setup(t);
  open();
  assert.equal(document.activeElement, dialog.querySelector('[autofocus]'));
  const event = key();
  assert.equal(event.defaultPrevented, true, 'Boundary Tab must not leave control to browser navigation');
  assert.equal(document.activeElement, dialog.querySelector('a'));
});

test('fixture: Shift+Tab from first link wraps to last close button', t => {
  const { document, dialog, key, open } = setup(t);
  open();
  dialog.querySelector('a').focus();
  assert.equal(key('Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(document.activeElement, dialog.querySelector('[autofocus]'));
});

test('fixture: intermediate Tab stays native; Escape and close restoration are preserved', t => {
  const { document, dialog, key, open } = setup(t);
  open();
  dialog.querySelector('a').focus();
  assert.equal(key().defaultPrevented, false, 'Normal internal navigation must stay native');
  dialog.querySelector('[autofocus]').focus();
  assert.equal(key('Tab', { shiftKey: true }).defaultPrevented, false);
  assert.equal(key('Escape').defaultPrevented, false, 'Native Escape must not be cancelled');
  dialog.close(); // Native close behavior itself is covered by the unchanged browser harness.
  assert.equal(document.activeElement, document.querySelector('[data-dialog-open]'));
});

test('app-owned showModal: a single button contains both Tab directions without data-dialog-open', t => {
  const { document, dialog, key } = setup(t, '<main></main><dialog><button autofocus>知道了</button></dialog>');
  dialog.showModal();
  for (const shiftKey of [false, true, false, true]) {
    assert.equal(key('Tab', { shiftKey }).defaultPrevented, true);
    assert.equal(document.activeElement, dialog.querySelector('button'));
  }
});

test('dynamic endpoints exclude disabled, hidden, inert and negative tabindex controls', t => {
  const { document, dialog, key } = setup(t, `<dialog>
    <button disabled>Disabled</button><fieldset disabled><button>Disabled fieldset</button></fieldset>
    <button hidden>Hidden</button><div style="display:none"><button>Not rendered</button></div>
    <button style="visibility:hidden">Invisible</button><div inert><button>Inert</button></div>
    <button tabindex="-1">Programmatic only</button><button id="first">First</button><button id="last">Last</button>
  </dialog>`);
  dialog.showModal();
  document.querySelector('#last').focus();
  assert.equal(key().defaultPrevented, true);
  assert.equal(document.activeElement.id, 'first');
  const added = document.createElement('button');
  added.id = 'added';
  dialog.append(added);
  assert.equal(key('Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(document.activeElement, added, 'Boundaries must reflect controls added after opening');
});

test('positive tabindex endpoints use sequential order rather than DOM order', t => {
  const { document, dialog, key } = setup(t, '<dialog><button id="zero">Zero</button><button id="two" tabindex="2">Two</button><button id="one" tabindex="1">One</button></dialog>');
  dialog.showModal();
  document.querySelector('#zero').focus();
  assert.equal(key().defaultPrevented, true);
  assert.equal(document.activeElement.id, 'one');
  assert.equal(key('Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(document.activeElement.id, 'zero');
});

test('nonmodal dialogs, modifier shortcuts and disposed helpers do not intercept Tab', t => {
  const { document, dialog, key, dispose } = setup(t, '<dialog open><button>Close</button></dialog>');
  dialog.querySelector('button').focus();
  assert.equal(key().defaultPrevented, false);
  dialog.showModal();
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(key('Tab', { [modifier]: true }).defaultPrevented, false);
  }
  dispose();
  assert.equal(key().defaultPrevented, false);
  assert.equal(document.activeElement, dialog.querySelector('button'));
});

test('modal with only a programmatically focused heading keeps Tab inside', t => {
  const { document, dialog, key } = setup(t, '<dialog><h2 tabindex="-1">Loading</h2></dialog>');
  dialog.showModal();
  dialog.querySelector('h2').focus();
  assert.equal(key().defaultPrevented, true);
  assert.equal(document.activeElement, dialog.querySelector('h2'));
});
