import { api, type Identity } from './api';
import { trustedClawHuntLogoutURL } from './clawhuntAuth';
import { forgetPendingInvite } from './pendingInvite';

/**
 * Signs out of AwwO, and for a ClawHunt account out of the main site too. Resolves with an error message to show
 * when it could not finish; on success the page goes on to the signed-out landing (or the main site's sign-out).
 */
export async function signOut(identity: Identity, t: (zh: string, en: string) => string): Promise<string | null> {
  forgetPendingInvite();
  try {
    const result = await api<null | { logoutURL: string }>('/auth/logout', { method: 'POST' });
    if (identity.authentication === 'clawhunt') {
      const logoutURL = trustedClawHuntLogoutURL(result?.logoutURL, identity.clawhuntSiteURL);
      if (!logoutURL) return t('AwwO 已退出，但无法确认 ClawHunt 主站退出。请到主站检查登录状态。', 'You signed out of AwwO, but we could not confirm ClawHunt sign-out. Check your main-site session.');
      location.assign(logoutURL);
    } else location.reload();
    return null;
  } catch { return t('退出失败，请重试。', 'Sign-out failed. Please try again.'); }
}
