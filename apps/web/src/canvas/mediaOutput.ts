// What an image or video node produced. The server keeps each generated file as an artifact and
// answers the run with a small record naming them; this reads that record strictly, so any other
// text, however similar, stays ordinary text.

export type MediaOutputKind = 'image' | 'video' | 'model3d';

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
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TYPES: Record<MediaOutputKind, ReadonlySet<string>> = {
  image: IMAGE_TYPES,
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
  // A 3D node stores its model and the provider's rendered preview picture.
  model3d: new Set(['model/gltf-binary', ...IMAGE_TYPES]),
};

export function parseMediaOutput(text: unknown): MediaOutput | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('{') || !trimmed.includes(MEDIA_OUTPUT_TYPE)) return null;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== MEDIA_OUTPUT_TYPE || record.version !== 1 || (record.kind !== 'image' && record.kind !== 'video' && record.kind !== 'model3d')
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


const KIND_WORDS: Record<MediaOutputKind, string> = { image: '图片', video: '视频', model3d: '3D 模型' };

/**
 * How a media node's delivery reads in a downstream node's input: the files it stored, by the path a page can name them
 * with (`<node id>/<file name>`, which AwwO's previews resolve), never the raw record. The same text the API builds for
 * a canvas run (mediaDeliveryText in graph_media.go); any other text is returned as it is.
 */
export function mediaDeliveryText(node: { id: string; title?: string }, text: string): string {
  const media = parseMediaOutput(text);
  if (!media) return text;
  const title = node.title?.trim() || node.id;
  return [
    `「${title}」生成的${KIND_WORDS[media.kind]}文件（存放在这张画布的成果里，这里只列文件，不含内容）：`,
    ...media.items.map(item => `- ${node.id}/${item.name}（${item.contentType}，${item.size} 字节）`),
    '网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。',
  ].join('\n');
}
