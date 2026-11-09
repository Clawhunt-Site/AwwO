// The server's side of the Share dialog (canvas/multiplayer/ShareDialog.tsx): whether this server offers sharing a canvas
// with people, and, while the dialog is open, this person's role, the workspace's people and its invitations, read
// again after each change made here (invitations.go, resources.go, tenant_pagination.go).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, tenantPath, type Identity } from './api';
import { readCapabilities } from './capabilitiesApi';
import { listPage } from './listPage';
import type { CreatedShareInvite, ShareInvite, ShareList, ShareMember, ShareRole } from '../canvas/multiplayer/ShareDialog';

/** Whether the canvas offers sharing with people (capabilities multiplayer.people, set by AWWO_PEOPLE_SHARING): false
 *  until the server says so, and for an older server or one that has it switched off, which keep today's canvas. Asked
 *  only while `enabled`. */
export function usePeopleSharing(tenantId: string, enabled = true): boolean {
  const [people, setPeople] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setPeople(false);
    readCapabilities(tenantId, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPeople(value.multiplayer?.people === true); }, () => undefined);
    return () => controller.abort();
  }, [tenantId, enabled]);
  return people;
}

const ROLES: readonly ShareRole[] = ['reader', 'member', 'admin', 'owner'];
const asRole = (value: unknown): ShareRole | null => ROLES.includes(value as ShareRole) ? value as ShareRole : null;
/** The people read at once: a workspace holds a few; one with more lists the rest in Settings. */
const MEMBERS_SHOWN = 200;
const EMPTY = { items: [], loading: false, error: null } as const;

export interface CanvasSharing {
  /** This person in the workspace: their account, their role and its name (null and '' until read). */
  userId: string;
  role: ShareRole | null;
  workspaceName: string;
  members: ShareList<ShareMember>;
  invites: ShareList<ShareInvite>;
  createInvite(input: { email: string; role: ShareRole; days: number }): Promise<CreatedShareInvite>;
  revokeInvite(id: string): Promise<void>;
  changeRole(userId: string, role: ShareRole): Promise<void>;
  remove(userId: string): Promise<void>;
}

/** The Share dialog's data for one canvas, read while `open`. */
export function useCanvasSharing(tenantId: string, canvasId: string, open: boolean): CanvasSharing {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ShareRole | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [members, setMembers] = useState<ShareList<ShareMember>>(EMPTY);
  const [invites, setInvites] = useState<ShareList<ShareInvite>>(EMPTY);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const mine = ++generation.current;
    const current = () => !controller.signal.aborted && mine === generation.current;
    setMembers(was => ({ ...was, loading: true, error: null }));
    void (async () => {
      let manages = false;
      try {
        const me = await api<Identity>('/auth/me', { signal: controller.signal });
        const tenant = me.tenants.find(item => item.id === tenantId);
        const own = asRole(tenant?.role);
        manages = tenant?.status === 'active' && (own === 'owner' || own === 'admin');
        if (!current()) return;
        setUserId(me.user.id);
        setRole(own);
        setWorkspaceName(tenant?.name ?? '');
        const page = await listPage<ShareMember>(tenantPath(tenantId, '/members'), null, controller.signal, MEMBERS_SHOWN);
        if (!current()) return;
        setMembers({ items: page.items.filter(item => asRole(item.role)), loading: false, error: null, more: Boolean(page.nextCursor) });
      } catch (error) {
        if (current()) setMembers(was => ({ ...was, loading: false, error }));
        return;
      }
      if (!manages) { setInvites(EMPTY); return; }
      setInvites(was => ({ ...was, loading: true, error: null }));
      try {
        const page = await listPage<ShareInvite>(tenantPath(tenantId, '/invites'), null, controller.signal, MEMBERS_SHOWN);
        if (current()) setInvites({ items: page.items, loading: false, error: null, more: Boolean(page.nextCursor) });
      } catch (error) {
        if (current()) setInvites(was => ({ ...was, loading: false, error }));
      }
    })();
    return () => controller.abort();
  }, [tenantId, open, revision]);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  const createInvite = useCallback(async ({ email, role, days }: { email: string; role: ShareRole; days: number }) => {
    const made = await api<CreatedShareInvite>(tenantPath(tenantId, '/invites'), {
      method: 'POST', body: JSON.stringify({ role, expiresInHours: days * 24, canvasId, ...(email ? { email } : {}) }),
    });
    reload();
    return made;
  }, [tenantId, canvasId, reload]);
  const revokeInvite = useCallback(async (id: string) => {
    await api(tenantPath(tenantId, `/invites/${encodeURIComponent(id)}`), { method: 'DELETE' });
    reload();
  }, [tenantId, reload]);
  const changeRole = useCallback(async (userId: string, next: ShareRole) => {
    await api(tenantPath(tenantId, `/members/${encodeURIComponent(userId)}`), { method: 'PATCH', body: JSON.stringify({ role: next }) });
    reload();
  }, [tenantId, reload]);
  const remove = useCallback(async (userId: string) => {
    await api(tenantPath(tenantId, `/members/${encodeURIComponent(userId)}`), { method: 'DELETE' });
    reload();
  }, [tenantId, reload]);
  return { userId, role, workspaceName, members, invites, createInvite, revokeInvite, changeRole, remove };
}
