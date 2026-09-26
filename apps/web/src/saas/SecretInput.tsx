import { useId, useState, type InputHTMLAttributes } from 'react';
import { useSaaSPreferences } from './preferences';

/** Visibility is local to this field; secrets never leave the normal form flow. */
export function SecretInput({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const { t } = useSaaSPreferences();
  return <div className="saas-secret-field">
    <label htmlFor={id}>{label}</label>
    <div className="saas-secret-control">
      <input {...props} id={id} type={visible ? 'text' : 'password'} spellCheck={false} autoCapitalize="none" autoCorrect="off" />
      <button type="button" disabled={props.disabled} aria-controls={id} aria-pressed={visible}
        aria-label={visible ? t(`隐藏${label}`, `Hide ${label}`) : t(`显示${label}`, `Show ${label}`)}
        onClick={() => setVisible(value => !value)}>{visible ? t('隐藏', 'Hide') : t('显示', 'Show')}</button>
    </div>
  </div>;
}
