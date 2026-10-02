import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_INVITE_KEY, PENDING_INVITE_TTL_MS, forgetPendingInvite, rememberPendingInvite, restorePendingInvite, takePendingInvite } from '../src/saas/pendingInvite';

const token = 'fixture_invite_token_0123456789abcdef';
const stored = () => sessionStorage.getItem(PENDING_INVITE_KEY);

beforeEach(() => { sessionStorage.clear(); history.replaceState(null, '', '/'); });
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

describe('pending workspace invitation', () => {
  it('is taken once, while fresh', () => {
    rememberPendingInvite(token, 1_000);
    expect(takePendingInvite(1_000 + PENDING_INVITE_TTL_MS)).toBe(token);
    expect(stored()).toBeNull();
    expect(takePendingInvite(1_000)).toBeNull();
  });

  it('ignores anything that is not an invitation token', () => {
    for (const value of [null, undefined, '', 'short', 'https://evil.example/?invite=x', `${token}/../x`, 42, 'a'.repeat(257)]) {
      rememberPendingInvite(value, 1_000);
      expect(stored()).toBeNull();
    }
  });

  it('drops a stale, future-dated or malformed entry when it is read', () => {
    rememberPendingInvite(token, 1_000);
    expect(takePendingInvite(1_000 + PENDING_INVITE_TTL_MS + 1)).toBeNull();
    expect(stored()).toBeNull();
    rememberPendingInvite(token, 100_000);
    expect(takePendingInvite(100_000 - 6_000)).toBeNull();
    for (const raw of ['{', 'null', '[]', JSON.stringify({ v: 2, token, savedAt: 1 }), JSON.stringify({ v: 1, token: 'x', savedAt: 1 }), JSON.stringify({ v: 1, token, savedAt: 'now' })]) {
      sessionStorage.setItem(PENDING_INVITE_KEY, raw);
      expect(takePendingInvite(1)).toBeNull();
      expect(stored()).toBeNull();
    }
  });

  it('survives a tab that cannot store anything', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    expect(() => rememberPendingInvite(token)).not.toThrow();
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(takePendingInvite()).toBeNull();
    expect(() => forgetPendingInvite()).not.toThrow();
  });
});

describe('restoring after sign-in', () => {
  it('puts the invitation back only on the plain landing a sign-in returns to', () => {
    rememberPendingInvite(token);
    restorePendingInvite();
    expect(location.pathname + location.search).toBe(`/?invite=${token}`);
    expect(stored()).toBeNull();
  });

  it('lets an address that already names an invitation win and forgets the stored one', () => {
    const other = 'other_invite_token_0123456789abcdefgh';
    rememberPendingInvite(token);
    history.replaceState(null, '', `/?invite=${other}`);
    restorePendingInvite();
    expect(location.search).toBe(`?invite=${other}`);
    expect(stored()).toBeNull();
  });

  it('leaves a deliberately chosen address and the stored invitation alone', () => {
    for (const address of ['/?tenant=team-a', '/?tenant=team-a&canvas=c1', '/admin', '/#start']) {
      rememberPendingInvite(token);
      history.replaceState(null, '', address);
      restorePendingInvite();
      expect(location.pathname + location.search + location.hash).toBe(address);
      expect(stored()).not.toBeNull();
    }
  });
});
