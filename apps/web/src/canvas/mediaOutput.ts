// What an image or video node produced. The server keeps each generated file as an artifact and
// answers the run with a small record naming them; this reads that record strictly, so any other
// text, however similar, stays ordinary text.

export type MediaOutputKind = 'image' | 'video';

export interface MediaOutputItem {
  artifactId: string;
  name: string;
  contentType: string;
  size: number;
}

export interface MediaOutput {
  kind: MediaOutputKind;
  model: string;
  items: MediaOutputItem[];
}

export const MEDIA_OUTPUT_TYPE = 'awwo.media';
// Server artifact ids are "a" + base64url; anything else never becomes part of a URL.
const ARTIFACT_ID = /^a[A-Za-z0-9_-]{8,128}$/;
const TYPES: Record<MediaOutputKind, ReadonlySet<string>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
};

export function parseMediaOutput(text: unknown): MediaOutput | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('{') || !trimmed.includes(MEDIA_OUTPUT_TYPE)) return null;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== MEDIA_OUTPUT_TYPE || record.version !== 1 || (record.kind !== 'image' && record.kind !== 'video')
    || typeof record.model !== 'string' || !Array.isArray(record.items) || !record.items.length || record.items.length > 8) return null;
  const kind = record.kind;
  const items: MediaOutputItem[] = [];
  for (const raw of record.items) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.artifactId !== 'string' || !ARTIFACT_ID.test(item.artifactId) || typeof item.name !== 'string' || !item.name
      || item.name.length > 200 || typeof item.contentType !== 'string' || !TYPES[kind].has(item.contentType)
      || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0) return null;
    items.push({ artifactId: item.artifactId, name: item.name, contentType: item.contentType, size: item.size });
  }
  return { kind, model: record.model.slice(0, 80), items };
}
