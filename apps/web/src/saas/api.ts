export const API_BASE = '/api/v1';
export class SaaSApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include', headers });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new SaaSApiError(response.status, payload?.error?.code || 'request_failed',
      payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : `请求失败（${response.status}）`));
  }
  return payload as T;
}
export type Tenant = { id: string; name: string; status: string; role: string; maxConcurrentRuns: number; maxRunsPerDay: number };
export type Identity = { user: { id: string; email: string; name: string; platformRole: 'user' | 'admin' }; tenants: Tenant[] };
export type CanvasRecord = { id: string; tenantId: string; name: string; document: unknown; version: number; createdAt: string; updatedAt: string };
export const tenantPath = (tenantId: string, suffix = '') => `/tenants/${encodeURIComponent(tenantId)}${suffix}`;

/** Translate known application failures; retain unknown service details rather than invent a cause. */
export function saasErrorMessage(error: unknown, locale: 'zh' | 'en'): string {
  const codes: Record<string, [string, string]> = {
    unauthenticated: ['请重新登录。', 'Please sign in again.'], forbidden: ['你没有执行此操作的权限。', 'You do not have permission for this action.'],
    invalid_credentials: ['邮箱或密码不正确。', 'The email or password is incorrect.'], invalid_input: ['输入无效，请检查后重试。', 'Check the entered values and try again.'],
    invalid_cursor: ['分页已失效，请刷新列表重新开始。', 'Pagination expired. Refresh the listing.'],
    invalid_pagination: ['分页参数无效，请刷新列表重新开始。', 'The pagination parameters are invalid. Refresh the listing.'],
    email_exists: ['此邮箱已注册，请登录。', 'This email is already registered. Please sign in.'],
    not_found: ['找不到此资源，或你没有访问权限。', 'This resource was not found or is not accessible.'],
    conflict: ['内容已发生变化，请重新读取后重试。', 'The content has changed. Reload it before retrying.'],
    invalid_appearance: ['配色文件或颜色无效，请检查后重试。', 'Invalid color scheme or color. Check it and try again.'],
    tenant_suspended: ['工作区已暂停，请联系管理员或切换工作区。', 'This workspace is suspended. Contact an administrator or switch workspaces.'],
    session_busy: ['此会话正在运行，请稍后重试。', 'This session is running. Try again when it finishes.'],
    context_limit: ['输入超出模型上下文限制，请缩短输入或减少历史内容。', 'The input exceeds the model context limit. Shorten it or reduce the history.'],
    rate_limited: ['请求过于频繁，请稍后重试。', 'Too many requests. Please try again later.'],
    quota_exceeded: ['工作区运行额度不足，请联系管理员。', 'The workspace run quota has been reached. Contact an administrator.'],
    model_unavailable: ['所选模型不可用，请重新选择服务端提供的模型。', 'The selected model is unavailable. Choose a model offered by the server.'],
    invite_used: ['此邀请已被其他账号领取。', 'This invitation was claimed by another account.'],
    invite_expired: ['邀请已过期，请索取新邀请。', 'This invitation has expired. Request a new one.'],
    invite_revoked: ['邀请已撤销，请索取新邀请。', 'This invitation was revoked. Request a new one.'],
    invite_unavailable: ['邀请已失效，请联系工作区所有者。', 'This invitation is no longer valid. Contact the workspace owner.'],
    invite_membership_removed: ['原成员身份已移除，请索取新邀请。', 'Your membership was removed. Request a new invitation.'],
  };
  if (error instanceof SaaSApiError && codes[error.code]) return codes[error.code][locale === 'zh' ? 0 : 1];
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const known: Record<string, [string, string]> = {
    'Pi service token is not configured': ['Pi 服务认证尚未配置。', 'Pi service authentication is not configured.'],
    'Pi service is unavailable': ['Pi 执行服务暂不可用。', 'The Pi execution service is unavailable.'],
    'Pi provider is not configured or available': ['Pi 模型服务尚未配置或不可用。', 'The Pi model provider is not configured or available.'],
    '画布已在另一页面更新。未同步草稿已独立保存在本机，重新加载后可恢复或导出，不会覆盖云端版本。': ['画布已在另一页面更新。未同步草稿已独立保存在本机，重新加载后可恢复或导出，不会覆盖云端版本。', 'This canvas changed in another page. Your unsynced draft is stored separately on this device. Reload to recover or export it without overwriting the cloud version.'],
    '草稿状态刚被另一个页面更新，请重新连接后核对。': ['草稿状态刚被另一个页面更新，请重新连接后核对。', 'Another page just changed this draft. Reconnect and check its state.'],
    '画布未同步，请先解决保存错误再运行。': ['画布未同步，请先解决保存错误再运行。', 'The canvas is not synced. Resolve the save error before running.'],
  };
  if (known[raw]) return known[raw][locale === 'zh' ? 0 : 1];
  if (locale === 'en') {
    if (raw.startsWith('保存失败：')) return raw.replace('保存失败：', 'Save failed: ').replace('。未同步草稿保留在本机，重新加载后可恢复或导出。', '. Your unsynced draft is kept on this device. Reload to recover or export it.');
    if (raw.startsWith('本机草稿保存失败：')) return raw.replace('本机草稿保存失败：', 'Local draft save failed: ').replace('。请立即导出本地副本。', '. Export a local copy now.');
    if (raw.startsWith('无法读取本机草稿：')) return raw.replace('无法读取本机草稿：', 'Could not read local drafts: ');
    if (raw.startsWith('无法恢复草稿：')) return raw.replace('无法恢复草稿：', 'Could not restore draft: ');
  }
  return raw || (locale === 'zh' ? '请求失败，请重试。' : 'The request failed. Please try again.');
}
