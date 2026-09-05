import { useEffect, useRef, useState } from 'react';
import { UserRound, X } from 'lucide-react';
import { AccountWorkspacePanel } from './account';
import type { ClawHuntSsoIdentity } from './clawhuntSso';
import type { UiLocale } from './i18n';
import './canvasAccount.css';

export interface CanvasAccountControlProps {
  locale: UiLocale;
  identity: ClawHuntSsoIdentity | null;
  onLogin: () => void;
  onLogout: () => void;
  onOpenWorkspaceAuth: () => void;
}

/** Native modal semantics keep keyboard focus inside account management. */
export function CanvasAccountControl({ locale, identity, onLogin, onLogout, onOpenWorkspaceAuth }: CanvasAccountControlProps) {
  const [open, setOpen] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = locale === 'zh' ? '账号与工作区' : 'Account & workspaces';

  useEffect(() => {
    if (open) {
      if (dialog.current && !dialog.current.open) dialog.current.showModal();
    } else dialog.current?.close();
  }, [open]);

  function close() {
    if (dialog.current?.open) dialog.current.close();
    setOpen(false);
    trigger.current?.focus();
  }

  return <>
    <button ref={trigger} type="button" className="canvas-auth-chip-user"
      aria-label={title} title={title} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {identity?.avatar_url
        ? <img className="canvas-auth-avatar" src={identity.avatar_url} alt="" />
        : <UserRound size={17} aria-hidden="true" />}
      <span className="canvas-auth-name">{identity?.username || title}</span>
    </button>
    {open && <dialog ref={dialog} className="awwo-account-dialog" aria-labelledby="awwo-account-title"
      onCancel={event => { event.preventDefault(); close(); }}
      onClose={close}>
      <header className="awwo-account-dialog-header">
        <h2 id="awwo-account-title">{title}</h2>
        <button type="button" className="awwo-icon-button" aria-label={locale === 'zh' ? '关闭账号面板' : 'Close account panel'}
          onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="awwo-account-dialog-body">
        <AccountWorkspacePanel locale={locale} clawHuntIdentity={identity}
          selectedCompanyId={companyId} onCompanyChange={setCompanyId}
          onClawHuntLogin={() => { close(); onLogin(); }} onClawHuntLogout={onLogout}
          onOpenWorkspaceAuth={() => { close(); onOpenWorkspaceAuth(); }} />
      </div>
    </dialog>}
  </>;
}
