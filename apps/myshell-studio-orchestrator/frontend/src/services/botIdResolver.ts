import { fetchBotDetail } from './api';

// Session-scoped slug_id → bot_id cache. Populated lazily on first request
// per slug. A value of `null` means resolution failed (network/API error) and
// we should not retry this session — the tracking event will carry
// `bot_id: null` which is spec-compliant (and distinguishable from "").
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/**
 * Resolve a slug_id to its numeric bot_id via `/dreamy/get-by-slug`.
 * Results are cached in-memory for the session.
 *
 * Returns a numeric string (e.g. "1777396959") on success, or `null` on
 * failure — callers should forward `null` to tracking rather than "".
 */
export function resolveBotIdBySlug(slugId: string): Promise<string | null> {
  if (!slugId) return Promise.resolve(null);
  if (cache.has(slugId)) return Promise.resolve(cache.get(slugId) ?? null);
  const existing = inflight.get(slugId);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await fetchBotDetail(slugId);
      // BotDetailResponse shape: { info: { botId: string, ... } }
      // Proto-JSON camelCase; tolerate snake_case as a safety net.
      const info = res.info as (typeof res.info & { bot_id?: string }) | undefined;
      const raw = info?.botId ?? info?.bot_id ?? '';
      const botId = typeof raw === 'string' ? raw.trim() : String(raw);
      const value = botId ? botId : null;
      cache.set(slugId, value);
      return value;
    } catch {
      cache.set(slugId, null);
      return null;
    } finally {
      inflight.delete(slugId);
    }
  })();

  inflight.set(slugId, p);
  return p;
}

/** Test/debug hook; not used in prod code paths. */
export function _clearBotIdCache() {
  cache.clear();
  inflight.clear();
}
