/**
 * Share a generated task to Telegram using the native shareMessage API.
 *
 * Backend flow:
 *  - POST /share/create → returns { share_token, share_link, prepared_message_id }
 *  - Backend has already called Bot API `savePreparedInlineMessage` to stage
 *    a photo + caption + "Open" button message.
 *
 * Frontend flow:
 *  - If `prepared_message_id` is available, call `webApp.shareMessage(id)`.
 *    TG opens the native recipient picker; after pick, the bot auto-sends
 *    the pre-staged photo + caption + deep-link button.
 *  - Fallback: open `t.me/share/url` in TG (text-only, no image).
 */
import { reportShare } from '../services/api';
import { getTg } from '../hooks/useTelegram';

// Fallback bot username + app shortname when backend call fails entirely
const FALLBACK_BOT_USERNAME = 'dreamy_porn_bot';
const FALLBACK_APP_SHORTNAME = 'app';

function buildClientShareLink(taskId: string, userId: string | number): string {
  return `https://t.me/${FALLBACK_BOT_USERNAME}/${FALLBACK_APP_SHORTNAME}?startapp=share_${taskId}_${userId}`;
}

export async function shareTaskToTelegram(taskId: string, userId: string | number): Promise<void> {
  if (!taskId) return;

  // 1. Ask backend to prepare the share (returns token + link + prepared_message_id)
  let shareLink = buildClientShareLink(taskId, userId);
  let preparedMessageId = '';
  try {
    const res = await reportShare(taskId);
    if (res.share_link) shareLink = res.share_link;
    // Field may be snake or camel depending on JSON casing
    preparedMessageId =
      (res as unknown as { prepared_message_id?: string }).prepared_message_id ||
      (res as unknown as { preparedMessageId?: string }).preparedMessageId ||
      '';
  } catch {
    // swallow; we'll use fallbacks
  }

  const webApp = window.Telegram?.WebApp as Record<string, unknown> | undefined;

  // 2. PRIMARY: native shareMessage with image + caption + button
  if (preparedMessageId && typeof webApp?.shareMessage === 'function') {
    (webApp.shareMessage as (id: string, cb?: (sent: boolean) => void) => void)(
      preparedMessageId,
    );
    return;
  }

  // 3. FALLBACK: text-only TG share sheet (no image)
  const tg = getTg();
  const shareText = `🔥 See the full version on Dreamy AI Studio`;
  const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(shareText)}`;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(tgShareUrl);
    return;
  }

  // 4. LAST RESORT: non-TG environment
  window.open(tgShareUrl, '_blank');
}
