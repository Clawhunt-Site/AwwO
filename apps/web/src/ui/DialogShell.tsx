// Unified modal shell (settings-redesign PR-6b).
// One backdrop/panel/header skeleton for every app modal; bodies stay owned
// by the caller. Dismissal semantics are explicit: blocking gates (agent
// setup, ClawHunt login) pass dismissable={false} and close only through
// their header button, while regular dialogs also close on Escape and on a
// backdrop press — exactly the behaviors the three legacy shells had.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export type DialogShellVariant = 'default' | 'compact' | 'wide' | 'full';

export function DialogShell({
  open,
  role = 'dialog',
  variant = 'default',
  align = 'start',
  titleId,
  title,
  subtitle,
  kicker,
  statusPill,
  closeLabel,
  onClose,
  dismissable = false,
  hideClose = false,
  children,
}: {
  open: boolean;
  role?: 'dialog' | 'alertdialog';
  variant?: DialogShellVariant;
  // 'center' stacks and centers the brand/heading and floats the close button
  // top-right — for focused, app-style dialogs like the login card.
  align?: 'start' | 'center';
  titleId: string;
  title: ReactNode;
  subtitle?: ReactNode;
  kicker?: ReactNode;
  statusPill?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  dismissable?: boolean;
  // Drop the header close (X) entirely — for a hard gate that may ONLY be left by
  // completing it (e.g. the desktop force-login). Combined with dismissable=false
  // (no Escape, no backdrop press), the dialog has no dismissal path at all.
  hideClose?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open || !dismissable) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return (
    <div
      className={`dialog-shell-backdrop${variant === 'full' ? ' dialog-shell-backdrop--stretch' : ''}`}
      role="presentation"
      onMouseDown={
        dismissable
          ? (event) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
    >
      <section
        className={`dialog-shell-panel dialog-shell-panel--${variant}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={`dialog-shell-header${align === 'center' ? ' dialog-shell-header--center' : ''}`}>
          {statusPill}
          <div className="dialog-shell-heading">
            {kicker}
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {hideClose ? null : (
            <button type="button" className="icon-button dialog-shell-close" aria-label={closeLabel} onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </header>
        {children}
      </section>
    </div>
  );
}
