/** Opt-in keyboard helpers. Business state and permission checks stay in the app. */
export function initAccessibility(root = document) {
  const doc = root.ownerDocument || root;
  const controller = new AbortController();
  const openers = new WeakMap();
  const wiredDialogs = new WeakSet();
  const wireDialog = (dialog) => {
    if (wiredDialogs.has(dialog)) return;
    wiredDialogs.add(dialog);
    dialog.addEventListener('close', () => {
      const opener = openers.get(dialog);
      if (opener?.isConnected && !opener.disabled && opener.getAttribute('aria-disabled') !== 'true'
          && !opener.closest('[hidden], [inert]') && opener.getClientRects().length) {
        opener.focus();
      } else {
        const fallback = doc.querySelector('main, [role="main"]');
        if (fallback) {
          if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1');
          fallback.focus();
        }
      }
      openers.delete(dialog);
    }, { signal: controller.signal });
  };
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof doc.defaultView.Element)) return;
    const trigger = event.target.closest('[data-dialog-open], [data-dialog-close], .skip-link');
    if (!trigger || !root.contains(trigger) || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return;
    if (trigger.matches('.skip-link')) {
      const href = trigger.getAttribute('href');
      if (!href?.startsWith('#')) return;
      const target = doc.getElementById(href.slice(1));
      if (!target) return;
      event.preventDefault();
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus();
      target.scrollIntoView({ block: 'start' });
      return;
    }
    if (trigger.hasAttribute('data-dialog-open')) {
      const dialog = doc.getElementById(trigger.dataset.dialogOpen);
      if (!dialog || dialog.tagName !== 'DIALOG' || dialog.open) return;
      event.preventDefault();
      wireDialog(dialog);
      openers.set(dialog, trigger);
      dialog.showModal(); // Native inert background, Escape, and Tab containment.
      return;
    }
    const dialog = trigger.closest('dialog');
    if (dialog?.open) {
      event.preventDefault();
      dialog.close();
    }
  }, { signal: controller.signal });
  return () => controller.abort();
}

/** Call after a completed SPA route render, not after each keystroke or filter. */
export function focusPageHeading(root = document) {
  const heading = root.querySelector('main h1, [role="main"] h1');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus();
}

/** Use a pre-existing role=status region; never pass sensitive document content. */
export function announceStatus(message, region = document.getElementById('app-status')) {
  if (region) region.textContent = String(message);
}
