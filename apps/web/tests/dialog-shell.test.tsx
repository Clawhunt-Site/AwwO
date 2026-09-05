// DialogShell behavior contract (settings-redesign PR-6b).
// The unified shell must preserve the dismissal semantics the three legacy
// modals had: blocking gates close only via their header button, regular
// dialogs also close on Escape and on a backdrop press.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DialogShell } from '../src/ui/DialogShell';

afterEach(() => {
  cleanup();
});

function renderShell(overrides: Partial<Parameters<typeof DialogShell>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <DialogShell
      open
      titleId="test-dialog-title"
      title="Test dialog"
      subtitle="A subtitle"
      closeLabel="Close test dialog"
      onClose={onClose}
      {...overrides}
    >
      <p>dialog body</p>
    </DialogShell>,
  );
  return onClose;
}

describe('DialogShell', () => {
  it('renders nothing when closed', () => {
    render(
      <DialogShell open={false} titleId="t" title="Hidden" closeLabel="Close" onClose={() => {}}>
        <p>never</p>
      </DialogShell>,
    );
    expect(screen.queryByText('never')).not.toBeInTheDocument();
  });

  it('exposes the accessible dialog with title, subtitle, and body', () => {
    renderShell();
    expect(screen.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
    expect(screen.getByText('A subtitle')).toBeInTheDocument();
    expect(screen.getByText('dialog body')).toBeInTheDocument();
  });

  it('closes via the header button regardless of dismissable', () => {
    const onClose = renderShell({ dismissable: false });
    fireEvent.click(screen.getByRole('button', { name: 'Close test dialog' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismissable dialogs close on Escape and on a backdrop press', () => {
    const onClose = renderShell({ dismissable: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector('.dialog-shell-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('blocking gates ignore Escape and backdrop presses', () => {
    const onClose = renderShell({ role: 'alertdialog', dismissable: false });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.dialog-shell-backdrop')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Test dialog' })).toBeInTheDocument();
  });

  it('does not dismiss when the press starts inside the panel', () => {
    const onClose = renderShell({ dismissable: true });
    fireEvent.mouseDown(screen.getByText('dialog body'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
