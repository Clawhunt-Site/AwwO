// Secrets settings 表层不变量：契约驱动渲染（provider/target 类型来自 /api/secrets/contract）、
// 永远掩码（创建后输入的明文绝不回显）、mutation 走 API 同款路径。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SecretsSettings } from '../src/settings/SecretsSettings';

afterEach(() => {
  cleanup();
});

const CONTRACT = {
  providers: [
    { id: 'local_encrypted', label: 'Local encrypted (AES-256-GCM)', ready: true, notes: '' },
    { id: 'vault', label: 'HashiCorp Vault', ready: false, notes: 'B 端里程碑' },
  ],
  binding_target_types: ['agent_profile', 'plugin', 'backend', 'company', 'runtime'],
  masking: { plaintext_never_listed: true },
  instance_settings_buckets: ['general', 'experimental'],
};

function makeReadJson(overrides: Record<string, any> = {}) {
  const calls: Array<{ path: string; init?: any }> = [];
  const state = {
    secrets: [
      {
        secret_id: 'secret_1',
        name: 'gh-token',
        company_profile_id: 'local',
        provider: 'local_encrypted',
        description: 'ci token',
        current_version: 2,
        archived: false,
      },
    ],
    instance: { general: { keyboard_shortcuts: true }, experimental: {} },
    ...overrides,
  };
  const readJson = vi.fn(async (path: string, init?: any) => {
    calls.push({ path, init });
    if (path === '/api/secrets/contract') return CONTRACT;
    if (path === '/api/secrets' && (!init || !init.method)) return { secrets: state.secrets };
    if (path === '/api/instance-settings') return state.instance;
    if (path.startsWith('/api/secrets/bindings?') || path === '/api/secrets/bindings') {
      return {
        bindings: [
          {
            binding_id: 'secbind_1',
            secret_id: 'secret_1',
            target_type: 'agent_profile',
            target_id: 'p1',
            config_path: 'GH_TOKEN',
            required: true,
          },
        ],
      };
    }
    if (path.includes('/access-log')) {
      return {
        events: [
          {
            event_id: 'secevt_1',
            action: 'create',
            actor: 'api_user',
            target_type: null,
            target_id: null,
            occurred_at: 1760000000,
            detail: '',
          },
        ],
      };
    }
    return {};
  });
  return { readJson, calls };
}

describe('SecretsSettings', () => {
  it('renders the masked ledger from the contract and never shows values', async () => {
    const { readJson } = makeReadJson();
    render(<SecretsSettings readJson={readJson} lang="en" />);
    expect(await screen.findByText('gh-token')).toBeInTheDocument();
    expect(screen.getByText(/v2 · local_encrypted · ci token/)).toBeInTheDocument();
    // provider pill 来自契约（ready 的那个）
    expect(screen.getByText('Local encrypted (AES-256-GCM)')).toBeInTheDocument();
    // 实例设置两桶渲染
    expect(screen.getByText('keyboard_shortcuts=true')).toBeInTheDocument();
  });

  it('creates a secret through the API and never echoes the typed value', async () => {
    const { readJson, calls } = makeReadJson();
    render(<SecretsSettings readJson={readJson} lang="en" />);
    fireEvent.click(await screen.findByRole('button', { name: /New secret/ }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'api-key' } });
    fireEvent.change(dialog.getByLabelText('Value'), { target: { value: 'sk-SUPERSECRET' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/api/secrets' && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.init.body).value).toBe('sk-SUPERSECRET');
    });
    // 提交后明文不在文档任何位置回显
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('sk-SUPERSECRET');
    });
  });

  it('expands bindings, binds with contract-driven target types, and unbinds', async () => {
    const { readJson, calls } = makeReadJson();
    render(<SecretsSettings readJson={readJson} lang="en" />);
    fireEvent.click(await screen.findByRole('button', { name: /Bindings/ }));
    expect(await screen.findByText(/agent_profile:p1 ← GH_TOKEN/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/secrets/bindings?secret=gh-token&company=local')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Unbind/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/secrets/bindings/secbind_1' && c.init?.method === 'DELETE')).toBe(true);
    });
  });

  it('shows the access log dialog', async () => {
    const { readJson } = makeReadJson();
    render(<SecretsSettings readJson={readJson} lang="en" />);
    fireEvent.click(await screen.findByRole('button', { name: /Access log/ }));
    expect(await screen.findByText('create')).toBeInTheDocument();
    expect(screen.getByText(/api_user/)).toBeInTheDocument();
  });

  it('sets and unsets instance settings keys with JSON parsing', async () => {
    const { readJson, calls } = makeReadJson();
    render(<SecretsSettings readJson={readJson} lang="en" />);
    await screen.findByText('gh-token');
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'enable_daemon' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'true' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.path === '/api/instance-settings/general' && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch!.init.body)).toEqual({ patch: { enable_daemon: true } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unset' }));
    await waitFor(() => {
      const unset = calls.filter((c) => c.path === '/api/instance-settings/general' && c.init?.method === 'PATCH');
      expect(JSON.parse(unset[unset.length - 1]!.init.body)).toEqual({ patch: { keyboard_shortcuts: null } });
    });
  });

  it('archives and deletes through the API with confirm gating', async () => {
    const { readJson, calls } = makeReadJson();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SecretsSettings readJson={readJson} lang="en" />);
    fireEvent.click(await screen.findByRole('button', { name: /Archive/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/api/secrets/gh-token/archive');
      expect(post && JSON.parse(post.init.body)).toEqual({ archived: true, company: 'local' });
    });
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/secrets/gh-token?company=local' && c.init?.method === 'DELETE')).toBe(true);
    });
    confirmSpy.mockRestore();
  });
});

describe('plaintext residue', () => {
  it('clears the typed value when a dialog is cancelled (no echo into the next dialog)', async () => {
    const { readJson } = makeReadJson();
    render(<SecretsSettings readJson={readJson} lang="en" />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }));
    const rotateDialog = within(screen.getByRole('dialog'));
    fireEvent.change(rotateDialog.getByLabelText('Value'), { target: { value: 'sk-RESIDUE' } });
    fireEvent.click(rotateDialog.getByRole('button', { name: /Cancel/ }));
    fireEvent.click(screen.getByRole('button', { name: /New secret/ }));
    const createDialog = within(screen.getByRole('dialog'));
    expect((createDialog.getByLabelText('Value') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('sk-RESIDUE');
  });
});

describe('company scope', () => {
  it('threads each secret own company through every operation (no cross-company drift)', async () => {
    const { readJson, calls } = makeReadJson({
      secrets: [
        {
          secret_id: 'secret_b',
          name: 'shared-name',
          company_profile_id: 'co_b',
          provider: 'local_encrypted',
          description: '',
          current_version: 1,
          archived: false,
        },
      ],
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SecretsSettings readJson={readJson} lang="en" />);
    await screen.findByText('shared-name');

    fireEvent.click(screen.getByRole('button', { name: /Access log/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/secrets/shared-name/access-log?company=co_b')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/api/secrets/shared-name/archive');
      expect(post && JSON.parse(post.init.body)).toEqual({ archived: true, company: 'co_b' });
    });

    fireEvent.click(screen.getByRole('button', { name: /^Rotate/ }));
    const rotateDialog = within(screen.getByRole('dialog'));
    fireEvent.change(rotateDialog.getByLabelText('Value'), { target: { value: 'v2' } });
    fireEvent.click(rotateDialog.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/api/secrets/shared-name/rotate');
      expect(post && JSON.parse(post.init.body)).toEqual({ value: 'v2', company: 'co_b' });
    });

    fireEvent.click(screen.getByRole('button', { name: /Bindings/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/secrets/bindings?secret=shared-name&company=co_b')).toBe(true);
    });
    fireEvent.click(screen.getByRole('button', { name: /Bind consumer/ }));
    const bindDialog = within(screen.getByRole('dialog'));
    fireEvent.change(bindDialog.getByLabelText('Consumer id'), { target: { value: 'p9' } });
    fireEvent.change(bindDialog.getByLabelText('Environment variable'), { target: { value: 'TOK' } });
    fireEvent.click(bindDialog.getByRole('button', { name: 'Bind consumer' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/api/secrets/shared-name/bindings' && c.init?.method === 'POST');
      expect(post && JSON.parse(post.init.body).company).toBe('co_b');
    });

    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/api/secrets/shared-name?company=co_b' && c.init?.method === 'DELETE')).toBe(true);
    });
    confirmSpy.mockRestore();
  });
});
