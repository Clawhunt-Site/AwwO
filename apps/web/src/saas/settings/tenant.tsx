import { useState } from 'react';
import type { Identity, Tenant } from '../api';
import { useSaaSPreferences } from '../preferences';

/**
 * The workspace a settings page is about (skills, members, the default model's catalogue, today's usage): the
 * address's ?tenant= when the account belongs to it, else its first active workspace. Changing it keeps the address
 * in step, so a reload or a link opens the same one.
 */
export function useSettingsTenant(identity: Identity): [Tenant | undefined, (id: string) => void] {
  const [id, setId] = useState(() => {
    const requested = new URLSearchParams(location.search).get('tenant');
    return (identity.tenants.find(item => item.id === requested) || identity.tenants.find(item => item.status === 'active') || identity.tenants[0])?.id || '';
  });
  const choose = (next: string) => {
    setId(next);
    const url = new URL(location.href);
    url.searchParams.set('tenant', next);
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  };
  return [identity.tenants.find(item => item.id === id), choose];
}

export function TenantPicker({ identity, tenant, onChange, label }: { identity: Identity; tenant?: Tenant; onChange: (id: string) => void; label?: string }) {
  const { t } = useSaaSPreferences();
  if (identity.tenants.length < 2) return null;
  return <label className="saas-settings-tenant">
    {label || t('工作区', 'Workspace')}
    <select value={tenant?.id || ''} onChange={event => onChange(event.target.value)}>
      {identity.tenants.map(item => <option key={item.id} value={item.id}>{item.name}{item.status !== 'active' ? t('（已暂停）', ' (suspended)') : ''}</option>)}
    </select>
  </label>;
}
