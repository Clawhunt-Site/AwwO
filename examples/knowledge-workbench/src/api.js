import { ApiError, createDemoService } from './demo.js';

export { ApiError };

/** Same-origin B v1 transport. Demo data is selected explicitly by the caller. */
export class ApiClient {
  constructor({ demo = false, onUnauthorized = () => {} } = {}) {
    this.demo = demo ? createDemoService() : null;
    this.onUnauthorized = onUnauthorized;
    this.csrfToken = null;
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    method = method.toUpperCase();
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/u.test(path)) {
      throw new ApiError(422, 'VALIDATION_FAILED', '请求路径必须位于当前应用。');
    }
    try {
      let data;
      if (this.demo) {
        data = await this.demo.request(path, { method, body, signal });
      } else {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (!['GET', 'HEAD'].includes(method) && this.csrfToken) {
          headers['X-CSRF-Token'] = this.csrfToken;
        }
        let response;
        try {
          response = await fetch(`/api/v1${path}`, {
            method, headers, credentials: 'include', cache: 'no-store', signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务，请检查网络后重试。');
        }
        let envelope;
        try { envelope = await response.json(); } catch {
          throw new ApiError(response.status === 401 ? 401 : 502,
            response.status === 401 ? 'SESSION_INVALID' : 'INVALID_RESPONSE',
            response.status === 401 ? '登录已失效，请重新登录。' : '服务返回了无法识别的响应。');
        }
        if (!envelope || typeof envelope !== 'object') {
          throw new ApiError(response.status === 401 ? 401 : 502,
            response.status === 401 ? 'SESSION_INVALID' : 'INVALID_RESPONSE', '服务返回了无法识别的响应。');
        }
        if (!response.ok || envelope.error) {
          throw new ApiError(response.status, envelope.error?.code || 'REQUEST_FAILED',
            envelope.error?.message || '请求失败。', envelope.error?.details || {},
            envelope.request_id || null, Boolean(envelope.error?.retryable));
        }
        if (!Object.hasOwn(envelope, 'data')) {
          throw new ApiError(502, 'INVALID_RESPONSE', '服务响应缺少 data 字段。');
        }
        data = envelope.data;
      }
      if (path.split('?')[0] === '/session') this.csrfToken = data.csrf_token;
      if (path.split('?')[0] === '/auth/logout') this.csrfToken = null;
      return data;
    } catch (error) {
      if (error.status === 401) {
        this.csrfToken = null;
        this.onUnauthorized(error);
      }
      throw error;
    }
  }
}
