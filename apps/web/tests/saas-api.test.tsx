import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('superclaw_locale', 'zh');
  window.history.replaceState({}, '', '/');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  { mode: 'login', status: 401, code: 'invalid_credentials', message: 'Invalid email or password',
    zh: '邮箱或密码不正确。', en: 'The email or password is incorrect.' },
  { mode: 'register', status: 409, code: 'email_exists', message: 'Email already registered',
    zh: '此邮箱已注册，请登录。', en: 'This email is already registered. Please sign in.' },
  { mode: 'register', status: 400, code: 'invalid_input', message: 'Workspace name is invalid',
    zh: '输入无效，请检查后重试。', en: 'Check the entered values and try again.' },
  { mode: 'login', status: 503, code: 'unknown_service_failure', message: 'Authentication service maintenance',
    zh: 'Authentication service maintenance', en: 'Authentication service maintenance' },
])('renders $code from the real $mode form and re-translates without resubmitting', async ({ mode, status, code, message, zh, en }) => {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/v1/auth/me') return response({ error: { code: 'unauthenticated', message: 'Login required' } }, 401);
    if (url === `/api/v1/auth/${mode}`) return response({ error: { code, message } }, status);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  render(<SaaSApp />);
  await screen.findByRole('heading', { name: '欢迎回来' });
  if (mode === 'register') {
    fireEvent.click(screen.getByRole('button', { name: '创建账号和工作区' }));
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: 'Login test user' } });
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: 'Login test workspace' } });
  }
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'login@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'test-password-only' } });
  fireEvent.click(screen.getByRole('button', { name: mode === 'register' ? '注册并创建工作区' : '登录' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(zh);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith(`/api/v1/auth/${mode}`, expect.objectContaining({ method: 'POST', credentials: 'include' }));
  fireEvent.click(screen.getByRole('button', { name: '切换为英文' }));
  expect(screen.getByRole('alert')).toHaveTextContent(en);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Chinese' }));
  expect(screen.getByRole('alert')).toHaveTextContent(zh);
  expect(fetch).toHaveBeenCalledTimes(2);
});
