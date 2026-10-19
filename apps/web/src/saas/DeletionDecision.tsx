import { useEffect, useRef, useState } from 'react';
import { SaaSApiError, saasErrorMessage } from './api';
import { decideDeletion, type AdminRow } from './adminData';
import { useSaaSPreferences } from './preferences';

export type DeletionOutcome = 'handled' | 'declined';
const MAX_NOTE = 1000;

/** How the 删除申请 tab names a request's status. */
export function deletionStatusLabel(status: unknown, t: (zh: string, en: string) => string): string {
  return status === 'pending' ? t('待处理', 'Pending') : status === 'withdrawn' ? t('已撤回', 'Withdrawn')
    : status === 'handled' ? t('已处理', 'Handled') : status === 'declined' ? t('已拒绝', 'Declined') : String(status || '—');
}

/**
 * The operator's outcome of one pending request: handled (they carried the deletion out themselves; this records it and
 * deletes nothing) or declined, with a reason the person who asked is shown.
 */
export function DeletionDecisionDialog({ row, outcome, onClose, onDecided, onStale }: { row: AdminRow; outcome: DeletionOutcome; onClose: () => void; onDecided: () => void;
  /** The request changed meanwhile (withdrawn, decided by someone else): the list behind reads it again. */
  onStale?: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const declining = outcome === 'declined';
  const ready = !busy && (!declining || note.trim() !== '') && [...note].length <= MAX_NOTE;
  return <dialog ref={dialog} className="saas-native-dialog" aria-labelledby="deletion-decision-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="saas-card" onSubmit={async event => {
      event.preventDefault(); if (!ready) return; setBusy(true); setError(null);
      try { await decideDeletion(String(row.id), outcome, note); onDecided(); }
      catch (cause) { setError(cause); if (cause instanceof SaaSApiError && cause.status === 409) onStale?.(); }
      finally { setBusy(false); }
    }}>
      <h2 id="deletion-decision-title">{declining ? t('拒绝这条删除申请？', 'Decline this deletion request?') : t('标记为已处理？', 'Mark as handled?')}</h2>
      <p>{row.email}{row.reason ? ` · ${t('原因：', 'Reason: ')}${row.reason}` : ''}</p>
      <p className="saas-field-hint">{declining
        ? t('对方会在「设置 → 数据管理」看到拒绝和下面的理由，之后可以重新申请。', 'They see the decline and the reason below in Settings → Data management, and may ask again.')
        : t('账号已删除：这里只记录结果，不再删除任何东西。说明只给管理员看，会留在这条申请记录里（可不填）。', 'The account is deleted: this only records the outcome and deletes nothing more. The note is for operators and stays with the request (optional).')}</p>
      <label>{declining ? t('拒绝理由（必填）', 'Reason for the decline (required)') : t('说明（可选）', 'Note (optional)')}
        <textarea rows={3} maxLength={MAX_NOTE} value={note} onChange={event => setNote(event.target.value)} />
      </label>
      {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
      <div className="saas-draft-actions">
        <button type="button" autoFocus disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button>
        <button className={declining ? 'saas-danger-button' : 'saas-primary'} disabled={!ready}>
          {busy ? t('请稍候…', 'Please wait…') : declining ? t('确认拒绝', 'Decline request') : t('确认已处理', 'Mark handled')}
        </button>
      </div>
    </form>
  </dialog>;
}
