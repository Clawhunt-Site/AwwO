export class ApiError extends Error {
  constructor(status, code, message, { details = {}, requestId = null, retryable = false, retryAfter = null } = {}) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code;
    this.details = details; this.requestId = requestId; this.retryable = retryable; this.retryAfter = retryAfter;
  }
}

export function errorState(error) {
  if (error?.name === 'AbortError') return { kind: 'cancelled', message: '请求已取消。' };
  const codes = {
    AUTH_REQUIRED: ['login', '请登录后继续。'], SESSION_INVALID: ['login', '登录已失效，请重新登录。'],
    REAUTH_REQUIRED: ['reauth', '请重新验证身份后继续。'], CURSOR_STALE: ['restart-search', '结果已更新，请从第一页重新检索。'],
    REVISION_CONFLICT: ['conflict', '文档已被修改。请保留当前输入，刷新版本后再保存。'],
    QUALITY_FAILED: ['validation', '发布检查未通过，请修正提示的字段。'],
  };
  const statuses = { 401: ['login', '登录已失效，请重新登录。'], 403: ['forbidden', '你没有执行此操作的权限。'],
    404: ['not-found', '内容不存在或不可访问。'], 409: ['conflict', '状态已变化，请刷新后重试。'],
    422: ['validation', '请检查填写的内容。'], 429: ['unavailable', '请求较多，请稍后重试。'] };
  const [kind, message] = codes[error?.code] ?? statuses[error?.status] ?? ['unavailable', '服务暂时不可用，请稍后重试。'];
  return { kind, message, code: error?.code ?? 'NETWORK_ERROR', requestId: error?.requestId ?? null };
}

const part = value => {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\u0000]/u.test(value)) {
    throw new TypeError('Resource ID must be an opaque path segment');
  }
  return encodeURIComponent(value);
};
const workspacePath = wid => `/workspaces/${part(wid)}`;
const documentPath = (wid, did) => `${workspacePath(wid)}/documents/${part(did)}`;
const dictionaryPath = (wid, kind) => {
  if (!['categories', 'tags', 'collections'].includes(kind)) throw new TypeError('Unknown dictionary');
  return `${workspacePath(wid)}/${kind}`;
};
function writableDictionary(wid, kind) {
  if (kind === 'categories') throw new ApiError(403, 'FORBIDDEN', '分类维护尚未开放。');
  return dictionaryPath(wid, kind);
}
function queryString(input = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return query.size ? `?${query}` : '';
}

// No implicit demo fallback, bearer tokens, browser persistence or automatic write retries.
export function createHttpApi({ baseUrl = '/api/v1', fetchImpl = globalThis.fetch, onUnauthorized = () => {} } = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('/') || baseUrl.startsWith('//') || /[\\?#\u0000-\u0020\u007f]/u.test(baseUrl)) {
    throw new TypeError('Use a same-origin absolute API path');
  }
  let csrfToken = null;
  const base = baseUrl.replace(/\/$/u, '');
  async function request(method, path, { body, query, signal, loginChallenge = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && !loginChallenge) {
      if (!csrfToken) throw new ApiError(401, 'AUTH_REQUIRED', '请先恢复登录状态。');
      headers['X-CSRF-Token'] = csrfToken;
    }
    let response;
    try {
      response = await fetchImpl(`${base}${path}${queryString(query)}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal, credentials: 'include', cache: 'no-store', redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务。');
    }
    if (response.status === 401) { csrfToken = null; onUnauthorized(); }
    let envelope;
    try { envelope = await response.json(); } catch { throw new ApiError(response.status === 401 ? 401 : 502, 'INVALID_RESPONSE', '服务响应格式不正确。'); }
    if (!envelope || typeof envelope.request_id !== 'string' || !('data' in envelope) || !('error' in envelope)) {
      throw new ApiError(response.status === 401 ? 401 : 502, 'INVALID_RESPONSE', '服务响应格式不正确。');
    }
    if (!response.ok || envelope.error) {
      const error = envelope.error ?? {};
      throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? '请求失败。', {
        details: error.details ?? {}, requestId: envelope.request_id,
        retryable: [429, 503].includes(response.status) && error.retryable === true,
        retryAfter: response.headers.get('Retry-After'),
      });
    }
    return envelope.data;
  }
  const get = (path, query, options) => request('GET', path, { ...options, query });
  const write = (method, path, body, options) => request(method, path, { ...options, body });
  return Object.freeze({
    mode: 'http',
    async getSession(options) {
      const data = await get('/session', undefined, options);
      if (!data?.user?.user_id || typeof data.csrf_token !== 'string' || !data.csrf_token) {
        csrfToken = null; throw new ApiError(502, 'INVALID_RESPONSE', '登录状态响应不完整。');
      }
      csrfToken = data.csrf_token; return data;
    },
    startLogin: (return_path, options) => {
      let decoded = return_path;
      for (let i = 0; i < 4 && typeof decoded === 'string' && decoded.includes('%'); i++) {
        try { decoded = decodeURIComponent(decoded); } catch { throw new TypeError('Invalid return path'); }
      }
      if (typeof decoded !== 'string' || !decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u0020%]/u.test(decoded)) throw new TypeError('Invalid return path');
      return write('POST', '/auth/login/start', { return_path }, { ...options, loginChallenge: true });
    },
    completeLogin: (body, options) => write('POST', '/auth/login/complete', body, { ...options, loginChallenge: true }),
    async logout(options) { const data = await write('POST', '/auth/logout', {}, options); csrfToken = null; return data; },
    clearSession: () => { csrfToken = null; },
    listWorkspaces: (query, options) => get('/workspaces', query, options),
    getWorkspace: (wid, options) => get(workspacePath(wid), undefined, options),
    updateWorkspace: (wid, body, options) => write('PATCH', workspacePath(wid), body, options),
    getMe: (wid, options) => get(`${workspacePath(wid)}/members/me`, undefined, options),
    listMembers: (wid, query, options) => get(`${workspacePath(wid)}/members`, query, options),
    updateMember: (wid, mid, body, options) => write('PATCH', `${workspacePath(wid)}/members/${part(mid)}`, body, options),
    removeMember: (wid, mid, body, options) => write('DELETE', `${workspacePath(wid)}/members/${part(mid)}`, body, options),
    search: (wid, query, options) => get(`${workspacePath(wid)}/search`, query, options),
    dashboard: (wid, query, options) => get(`${workspacePath(wid)}/dashboard`, query, options),
    listDocuments: (wid, query, options) => get(`${workspacePath(wid)}/documents/manage`, query, options),
    getDocument: (wid, did, options) => get(documentPath(wid, did), undefined, options),
    getManagedDocument: (wid, did, options) => get(`${documentPath(wid, did)}/manage`, undefined, options),
    listVersions: (wid, did, query, options) => get(`${documentPath(wid, did)}/versions`, query, options),
    getVersion: (wid, did, vid, options) => get(`${documentPath(wid, did)}/versions/${part(vid)}`, undefined, options),
    createDocument: (wid, body, options) => write('POST', `${workspacePath(wid)}/documents`, body, options),
    saveVersion: (wid, did, body, options) => write('POST', `${documentPath(wid, did)}/versions`, body, options),
    publishDocument: (wid, did, body, options) => write('POST', `${documentPath(wid, did)}/publish`, body, options),
    archiveDocument: (wid, did, body, options) => write('POST', `${documentPath(wid, did)}/archive`, body, options),
    deleteDocument: (wid, did, body, options) => write('DELETE', documentPath(wid, did), body, options),
    listDictionary: (wid, kind, query, options) => get(dictionaryPath(wid, kind), query, options),
    createDictionary: (wid, kind, body, options) => write('POST', writableDictionary(wid, kind), body, options),
    updateDictionary: (wid, kind, id, body, options) => write('PATCH', `${writableDictionary(wid, kind)}/${part(id)}`, body, options),
    deleteDictionary: (wid, kind, id, body, options) => write('DELETE', `${writableDictionary(wid, kind)}/${part(id)}`, body, options),
  });
}
