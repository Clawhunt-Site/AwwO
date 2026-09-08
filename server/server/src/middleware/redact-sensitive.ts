// Redaction for HTTP log payloads.
//
// `customProps` in logger.ts copies `req.body` / `req.params` / `req.query`
// verbatim into the 4xx/5xx log lines so operators can diagnose. That means
// Better Auth's `POST /api/auth/sign-in/email` body (which has the user's
// plaintext password) and similar payloads (sign-up, reset-password, API
// keys via Authorization header equivalents) end up on disk.
//
// This walker returns a shallow copy of the input with values for sensitive
// keys replaced with the literal string "[REDACTED]". Recurses into nested
// objects/arrays. Caps depth so a hostile or accidental cycle can't pin
// the logger.

const SENSITIVE_KEYS = new Set<string>([
  "password",
  "currentpassword",
  "newpassword",
  "passwordconfirmation",
  "password_confirmation",
  "passwordconfirm",
  "password_confirm",
  "confirmpassword",
  "confirm_password",
  "secret",
  "client_secret",
  "clientsecret",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "authtoken",
  "session_token",
  "sessiontoken",
  "private_key",
  "privatekey",
  "cookie",
  "set-cookie",
]);

const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";
const INVITE_PATH_SEGMENT = /(\/(?:api\/invites|invite)\/)([^/?#]+)/gi;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_DEPTH) return undefined;
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSensitive(entry, depth + 1);
  }
  return out;
}

export function sanitizeUrlForLog(value: string): string {
  const tokens = inviteTokensFromUrl(value);
  let sanitized = value.replace(INVITE_PATH_SEGMENT, `$1${REDACTED}`);
  for (const token of tokens) {
    sanitized = sanitized.split(token).join(REDACTED);
  }
  return sanitized;
}

function inviteTokensFromUrl(requestUrl: string): string[] {
  const tokens = new Set<string>();
  for (const match of requestUrl.matchAll(new RegExp(INVITE_PATH_SEGMENT.source, INVITE_PATH_SEGMENT.flags))) {
    const raw = match[2];
    if (!raw || raw === REDACTED) continue;
    tokens.add(raw);
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded && decoded !== REDACTED) {
        tokens.add(decoded);
        tokens.add(encodeURIComponent(decoded));
      }
    } catch {
      // A malformed path segment is still covered by its raw representation.
    }
  }
  return [...tokens].sort((left, right) => right.length - left.length);
}

function sanitizeStringForUrl(value: string, requestUrl: string, tokens: string[]): string {
  let sanitized = sanitizeUrlForLog(value);
  for (const token of tokens) {
    sanitized = sanitized.split(token).join(REDACTED);
  }
  return sanitized;
}

export function sanitizeLogValueForUrl(value: unknown, requestUrl: string): unknown {
  const tokens = inviteTokensFromUrl(requestUrl);
  const seen = new WeakSet<object>();

  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return undefined;
    if (typeof entry === "string") return sanitizeStringForUrl(entry, requestUrl, tokens);
    if (entry === null || typeof entry !== "object") return entry;
    if (seen.has(entry)) return undefined;
    seen.add(entry);

    try {
      if (entry instanceof Error) {
        const out: Record<string, unknown> = {
          name: entry.name,
          message: sanitizeStringForUrl(entry.message, requestUrl, tokens),
          stack: entry.stack ? sanitizeStringForUrl(entry.stack, requestUrl, tokens) : undefined,
        };
        for (const [key, nested] of Object.entries(entry)) {
          if (key === "name" || key === "message" || key === "stack") continue;
          out[key] = isSensitiveKey(key) ? REDACTED : visit(nested, depth + 1);
        }
        return out;
      }
      if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));

      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
        if (isSensitiveKey(key)) {
          out[key] = REDACTED;
          continue;
        }
        out[key] = visit(nested, depth + 1);
      }
      return out;
    } finally {
      seen.delete(entry);
    }
  };

  return visit(value, 0);
}
