import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAWHUNT_SSO_STORAGE_KEY,
  buildClawHuntSsoBridgeUrl,
  captureClawHuntSsoCallback,
  clearClawHuntSsoToken,
  readClawHuntSsoToken,
  verifyClawHuntSsoToken,
} from '../src/clawhuntSso';

describe('ClawHunt main-site SSO', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('builds the main-site bridge URL with the exact canvas return URL', () => {
    expect(
      buildClawHuntSsoBridgeUrl(
        'https://clawhunt.store',
        'https://canvas.example/studio?company=7#panel=chat',
      ),
    ).toBe(
      'https://clawhunt.store/cn-auth-bridge.html?return_to=https%3A%2F%2Fcanvas.example%2Fstudio%3Fcompany%3D7%23panel%3Dchat',
    );
  });

  it('rejects an insecure non-local bridge origin', () => {
    expect(() =>
      buildClawHuntSsoBridgeUrl('http://clawhunt.example', 'https://canvas.example/'),
    ).toThrow(/https/i);
  });

  it('captures a callback token without persisting it before the caller scrubs the URL', () => {
    const result = captureClawHuntSsoCallback(
      'https://canvas.example/studio?company=7#panel=chat&clawhunt_sso_token=signed.jwt.token',
      localStorage,
    );

    expect(result).toEqual({
      token: 'signed.jwt.token',
      error: null,
      cleanedUrl: 'https://canvas.example/studio?company=7#panel=chat',
    });
    expect(localStorage.getItem(CLAWHUNT_SSO_STORAGE_KEY)).toBeNull();
    expect(result.cleanedUrl).not.toContain('signed.jwt.token');
  });

  it('captures a bridge error without retaining it in the address bar', () => {
    localStorage.setItem(CLAWHUNT_SSO_STORAGE_KEY, 'old.jwt.token');
    const result = captureClawHuntSsoCallback(
      'https://canvas.example/#clawhunt_sso_error=missing_main_token',
      localStorage,
    );

    expect(result).toEqual({
      token: null,
      error: 'missing_main_token',
      cleanedUrl: 'https://canvas.example/',
    });
    expect(localStorage.getItem(CLAWHUNT_SSO_STORAGE_KEY)).toBeNull();
  });

  it('verifies the token through the same-origin gateway and returns the identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 42,
          username: 'alice',
          email: 'alice@example.com',
          avatar_url: 'https://cdn.example/alice.png',
          tier: 'pro',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(verifyClawHuntSsoToken('signed.jwt.token', fetchImpl)).resolves.toEqual({
      id: 42,
      username: 'alice',
      email: 'alice@example.com',
      avatar_url: 'https://cdn.example/alice.png',
      tier: 'pro',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/gateway-api/auth/me', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer signed.jwt.token',
      },
      cache: 'no-store',
    });
  });

  it('prefixes identity verification with the desktop loopback origin in Tauri', async () => {
    const desktopGlobal = globalThis as typeof globalThis & {
      __SUPERCLAW_PY_ORIGIN__?: string;
    };
    desktopGlobal.__SUPERCLAW_PY_ORIGIN__ = 'http://127.0.0.1:9988';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 42, username: 'desktop-alice' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      await verifyClawHuntSsoToken('signed.jwt.token', fetchImpl);
    } finally {
      delete desktopGlobal.__SUPERCLAW_PY_ORIGIN__;
    }

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9988/gateway-api/auth/me', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer signed.jwt.token',
      },
      cache: 'no-store',
    });
  });

  it('stores no token after local logout', () => {
    localStorage.setItem(CLAWHUNT_SSO_STORAGE_KEY, 'signed.jwt.token');
    expect(readClawHuntSsoToken(localStorage)).toBe('signed.jwt.token');
    clearClawHuntSsoToken(localStorage);
    expect(readClawHuntSsoToken(localStorage)).toBeNull();
  });

  it('rejects a return_to that carries userinfo credentials or a non-http(s) scheme', () => {
    expect(() => buildClawHuntSsoBridgeUrl('https://clawhunt.store', 'https://user:pass@canvas.example/')).toThrow(
      /credentials/i,
    );
    expect(() => buildClawHuntSsoBridgeUrl('https://clawhunt.store', 'javascript:alert(1)')).toThrow(/https|http/i);
    expect(() => buildClawHuntSsoBridgeUrl('https://clawhunt.store', 'http://evil.example/')).toThrow(/https/i);
  });

  it('rejects a bridge base that carries credentials', () => {
    expect(() => buildClawHuntSsoBridgeUrl('https://user:pass@clawhunt.store', 'https://canvas.example/')).toThrow(
      /credentials/i,
    );
  });
});