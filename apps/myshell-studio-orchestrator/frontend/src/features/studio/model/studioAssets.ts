import presetCharacterGif from '../../../assets/dreamy-preset-character.gif';
import presetCinematicGif from '../../../assets/dreamy-preset-cinematic.gif';
import exampleGood from '../../../assets/example-good.png';
import exampleMultiple from '../../../assets/example-multiple.png';
import exampleSmall from '../../../assets/example-small.png';
import { resolveStudioAssetUrl } from '../api';
import type { StudioSegment } from '../api';

export function resolveStudioDisplayAssetUrl(url?: string): string {
  if (!url) return '';
  if (url.startsWith('/gallery/video')) return exampleMultiple;
  if (url.startsWith('/gallery/style')) return exampleSmall;
  if (url.startsWith('/gallery/')) return exampleGood;
  if (url.startsWith('/assets/') || url.startsWith('/src/')) return url;
  return resolveStudioAssetUrl(url);
}

export function getSegmentMedia(segment?: StudioSegment | null): string {
  if (!segment) return '';
  return resolveStudioDisplayAssetUrl(segment.type === 'video' ? segment.posterUrl || segment.url : segment.url || segment.posterUrl);
}

export const FAILED_DISPLAY_SEGMENT_STATUSES = new Set(['error', 'auth_missing', 'timeout', 'cancelled']);

export function isFailedDisplaySegment(segment?: StudioSegment | null): boolean {
  return Boolean(segment?.status && FAILED_DISPLAY_SEGMENT_STATUSES.has(segment.status));
}

export function getTimelineDisplaySegments(segments: StudioSegment[] = []): StudioSegment[] {
  return segments.filter((segment) => !isFailedDisplaySegment(segment));
}

export function fallbackVisualForDreamyBot(botSlug?: string, botName?: string): string {
  const value = `${botSlug || ''} ${botName || ''}`.toLowerCase();
  return value.includes('futa') ? presetCharacterGif : presetCinematicGif;
}
