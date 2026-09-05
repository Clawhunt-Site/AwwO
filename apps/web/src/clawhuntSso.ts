import { gatewayApiBase } from './chatAutomations';

export const CLAWHUNT_SSO_STORAGE_KEY = 'superclaw.clawhunt.sso_token';

const CALLBACK_TOKEN_KEY = 'clawhunt_sso_token';
const CALLBACK_ERROR_KEY = 'clawhunt_sso_error';
const MAX_TOKEN_LENGTH = 16_384;

type SsoStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ClawHuntSsoIdentity = {
  id: number | string;
  username: string;
  email?: string;
  avatar_url?: string;
  is_admin?: boolean;
  access_status?: string;
  tier?: string;
  superclaw_plan?: string;
};

export type ClawHuntSsoCallback = {
  token: string | null;
  error: string | null;
  cleanedUrl: string | null;
};

function validToken(value: string | null): value is string {
  return Boolean(value && value.length <= MAX_TOKEN_LENGTH && !/\s/.test(value));
}

export function readClawHuntSsoToken(storage: SsoStorage): string | null {
  const token = storage.getItem(CLAWHUNT_SSO_STORAGE_KEY);
  if (validToken(token)) return token;
  if (token !== null) storage.removeItem(CLAWHUNT_SSO_STORAGE_KEY);
  return null;
}

export function clearClawHuntSsoToken(storage: SsoStorage): void {
  storage.removeItem(CLAWHUNT_SSO_STORAGE_KEY);
}

export function storeClawHuntSsoToken(storage: SsoStorage, token: string): void {
  if (!validToken(token)) {
    clearClawHuntSsoToken(storage);
    throw new Error('Invalid ClawHunt SSO token');
  }
  storage.setItem(CLAWHUNT_SSO_STORAGE_KEY, token);
}

export function buildClawHuntSsoBridgeUrl(baseUrl: string, returnUrl: string): string {
  const bridgeBase = new URL(baseUrl);
  const localHttp =
    bridgeBase.protocol === 'http:' &&
    (bridgeBase.hostname === 'localhost' || bridgeBase.hostname === '127.0.0.1');
  if (bridgeBase.protocol !== 'https:' && !localHttp) {
    throw new Error('ClawHunt SSO bridge must use https');
  }
  if (bridgeBase.username || bridgeBase.password) {
    throw new Error('ClawHunt SSO bridge URL must not contain credentials');
  }
  const target = new URL(returnUrl);
  const localReturn =
    target.protocol === 'http:' && (target.hostname === 'localhost' || target.hostname === '127.0.0.1');
  // The token is delivered to this origin in a URL fragment, so it must be a trustworthy target:
  // https-only (except loopback for dev) and never carry userinfo credentials. Defense-in-depth —
  // the remote bridge also allow-lists origins, but this reusable helper must not depend on that.
  if (target.protocol !== 'https:' && !localReturn) {
    throw new Error('ClawHunt SSO return URL must use https');
  }
  if (target.username || target.password) {
    throw new Error('ClawHunt SSO return URL must not contain credentials');
  }
  const bridge = new URL('/cn-auth-bridge.html', bridgeBase.origin);
  bridge.searchParams.set('return_to', target.toString());
  return bridge.toString();
}

export function captureClawHuntSsoCallback(
  currentUrl: string,
  storage: SsoStorage,
): ClawHuntSsoCallback {
  const url = new URL(currentUrl);
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  const rawToken = params.get(CALLBACK_TOKEN_KEY);
  const error = params.get(CALLBACK_ERROR_KEY);
  if (rawToken === null && error === null) {
    return { token: readClawHuntSsoToken(storage), error: null, cleanedUrl: null };
  }

  let token: string | null = null;
  if (validToken(rawToken)) {
    token = rawToken;
  } else if (rawToken !== null) {
    clearClawHuntSsoToken(storage);
  }
  if (error !== null && rawToken === null) {
    clearClawHuntSsoToken(storage);
  }

  params.delete(CALLBACK_TOKEN_KEY);
  params.delete(CALLBACK_ERROR_KEY);
  const remainingHash = params.toString();
  url.hash = remainingHash ? `#${remainingHash}` : '';
  return {
    token,
    error: error || (rawToken !== null && !token ? 'invalid_token' : null),
    cleanedUrl: url.toString(),
  };
}

function parseIdentity(payload: unknown): ClawHuntSsoIdentity {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('ClawHunt returned an invalid identity');
  }
  const value = payload as Record<string, unknown>;
  const id = value.id;
  if (
    !((typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.trim())) ||
    typeof value.username !== 'string' ||
    !value.username.trim()
  ) {
    throw new Error('ClawHunt returned an invalid identity');
  }
  const identity: ClawHuntSsoIdentity = { id, username: value.username };
  for (const field of [
    'email',
    'avatar_url',
    'access_status',
    'tier',
    'superclaw_plan',
  ] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue === 'string') identity[field] = fieldValue;
  }
  if (typeof value.is_admin === 'boolean') identity.is_admin = value.is_admin;
  return identity;
}

export async function verifyClawHuntSsoToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClawHuntSsoIdentity> {
  if (!validToken(token)) throw new Error('Invalid ClawHunt SSO token');
  const response = await fetchImpl(`${gatewayApiBase()}/auth/me`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 401 ? 'ClawHunt session expired' : 'ClawHunt identity verification failed',
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return parseIdentity(await response.json());
}
