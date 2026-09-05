import { useEffect, useRef } from 'react';
import { trackEvent } from '../services/tracking';
import { resolveBotIdBySlug } from '../services/botIdResolver';

const DWELL_MS = 500;

// Module-level dedupe set keyed by `${listContext}:${slugId}` — once fired
// within a webview session, never fire again. Cleared naturally on reload.
const firedKeys = new Set<string>();

interface Params {
  slugId: string;
  /**
   * Optional bot_id. If the list API already provides a non-empty numeric
   * bot_id per card, pass it here and we'll skip the lazy resolve round-trip.
   * When omitted/empty, the hook lazily calls `/dreamy/get-by-slug` to map
   * slug_id → bot_id (cached for the session).
   */
  botId?: string;
  position: number;
  listContext: string;
  /** Enable the observer (e.g., only after the card has a non-empty slug). */
  enabled?: boolean;
}

/**
 * Attach an IntersectionObserver to a ref'd element; fires
 * `miniapp_bot_card_impression` once per (list_context, slug_id) pair
 * when the element stays ≥50% in viewport for ≥500ms.
 *
 * Silently no-ops when IntersectionObserver is unsupported.
 */
export function useCardImpression({ slugId, botId, position, listContext, enabled = true }: Params) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled || !slugId || typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;

    const key = `${listContext}:${slugId}`;
    if (firedKeys.has(key)) return;

    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const fire = async () => {
      // If caller already has a bot_id, use it verbatim. Otherwise lazily
      // resolve via /dreamy/get-by-slug (session-cached). On failure send
      // null rather than "" so downstream can distinguish "unresolved" from
      // a bug/empty string.
      let resolvedBotId: string | null;
      if (botId && botId.length > 0) {
        resolvedBotId = botId;
      } else {
        resolvedBotId = await resolveBotIdBySlug(slugId);
      }
      if (cancelled) return;
      if (firedKeys.has(key)) return;
      firedKeys.add(key);
      try {
        trackEvent('miniapp_bot_card_impression', {
          slug_id: slugId,
          bot_id: resolvedBotId,
          position,
          list_context: listContext,
        });
      } catch { /* noop */ }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (dwellTimer == null && !firedKeys.has(key)) {
              dwellTimer = setTimeout(() => {
                void fire();
                observer.disconnect();
              }, DWELL_MS);
            }
          } else if (dwellTimer != null) {
            clearTimeout(dwellTimer);
            dwellTimer = null;
          }
        });
      },
      { threshold: [0, 0.5, 1] },
    );

    observer.observe(el);
    return () => {
      cancelled = true;
      if (dwellTimer != null) clearTimeout(dwellTimer);
      observer.disconnect();
    };
  }, [slugId, botId, position, listContext, enabled]);

  return ref;
}
