import { Router } from "express";

export interface ClawHuntAuthRouterDeps {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

type IdentityRecord = Record<string, unknown>;

const MAX_BEARER_LENGTH = 16_384;
const IDENTITY_FIELDS = [
  "id",
  "username",
  "email",
  "avatar_url",
  "is_admin",
  "access_status",
  "tier",
  "superclaw_plan",
] as const;

function bearerToken(header: string | undefined): string | null {
  if (!header || header.length > MAX_BEARER_LENGTH + 7) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

function identityOnly(payload: unknown): IdentityRecord | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as IdentityRecord;
  const id = source.id;
  if (
    !((typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && id.trim())) ||
    typeof source.username !== "string" ||
    !source.username.trim()
  ) {
    return null;
  }

  const identity: IdentityRecord = {};
  for (const field of IDENTITY_FIELDS) {
    const value = source[field];
    if (value !== undefined && value !== null) identity[field] = value;
  }
  return identity;
}

function authMeUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/auth/me`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function createClawHuntAuthRouter(deps: ClawHuntAuthRouterDeps): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? fetch;

  router.get("/auth/me", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");

    const token = bearerToken(req.get("authorization"));
    if (!token) {
      res.status(401).json({ detail: "ClawHunt bearer token required" });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const upstream = await fetchImpl(authMeUrl(deps.baseUrl), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        redirect: "manual",
        signal: controller.signal,
      });

      if (upstream.status === 401 || upstream.status === 403) {
        res.status(401).json({ detail: "ClawHunt session is invalid" });
        return;
      }
      if (upstream.status === 429) {
        res.status(503).json({ detail: "ClawHunt identity service is busy" });
        return;
      }
      if (!upstream.ok) {
        res.status(502).json({ detail: "ClawHunt identity service failed" });
        return;
      }

      let payload: unknown;
      try {
        payload = await upstream.json();
      } catch {
        res.status(502).json({ detail: "ClawHunt returned an invalid identity" });
        return;
      }
      const identity = identityOnly(payload);
      if (!identity) {
        res.status(502).json({ detail: "ClawHunt returned an invalid identity" });
        return;
      }
      res.json(identity);
    } catch (error) {
      // undici aborts reject with a DOMException named "AbortError", which is NOT `instanceof
      // Error` in Node — so detect the abort via the signal (authoritative) or the name, never the
      // instanceof guard, or a genuine timeout would be mis-reported as a 502.
      const timedOut = controller.signal.aborted || (error as { name?: string } | null)?.name === "AbortError";
      res
        .status(timedOut ? 504 : 502)
        .json({ detail: timedOut ? "ClawHunt identity request timed out" : "ClawHunt identity service unavailable" });
    } finally {
      clearTimeout(timeout);
    }
  });

  return router;
}
