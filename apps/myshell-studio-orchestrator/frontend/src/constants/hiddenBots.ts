// Bots that are hard-coded to be hidden from Explore, Search, and Library
// bot-chip links. Matched by slug (last segment of gotoLink / slugId).
export const HIDDEN_BOT_SLUGS = new Set<string>(['ai-porn-generator']);

export function isHiddenBotSlug(slug: string | undefined | null): boolean {
  if (!slug) return false;
  return HIDDEN_BOT_SLUGS.has(slug);
}

export function isHiddenBotLink(gotoLink: string | undefined | null): boolean {
  if (!gotoLink) return false;
  const slug = gotoLink.substring(gotoLink.lastIndexOf('/') + 1);
  return HIDDEN_BOT_SLUGS.has(slug);
}
