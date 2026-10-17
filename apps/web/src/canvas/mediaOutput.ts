// What an image or video node produced. The server keeps each generated file as an artifact and
// answers the run with a small record naming them; this reads that record strictly, so any other
// text, however similar, stays ordinary text.

export type MediaOutputKind = 'image' | 'video' | 'model3d';

export interface MediaOutputItem {
  artifactId: string;
  name: string;
  contentType: string;
  size: number;
  /** A GLB's animation clips by name, as the API read them from the file (a rigged and animated 3D model). */
  animations?: string[];
  /** A GLB with clips and no mesh: clips for the skeleton of the record's first model. */
  clipsOnly?: boolean;
}

export interface MediaOutput {
  kind: MediaOutputKind;
  model: string;
  items: MediaOutputItem[];
}

export const MEDIA_OUTPUT_TYPE = 'awwo.media';
// Server artifact ids are "a" + base64url; anything else never becomes part of a URL.
const ARTIFACT_ID = /^a[A-Za-z0-9_-]{8,128}$/;
// A clip name as the API lists it (media_glb.go): short plain text, no spaces, at most 32 of them for one file.
const CLIP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,63}$/;
const MAX_CLIPS = 32;
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
    const read: MediaOutputItem = { artifactId: item.artifactId, name: item.name, contentType: item.contentType, size: item.size };
    // Only a GLB says what clips it carries.
    const glb = item.contentType === 'model/gltf-binary';
    if (item.animations !== undefined) {
      if (!glb || !Array.isArray(item.animations) || !item.animations.length || item.animations.length > MAX_CLIPS
        || !item.animations.every(name => typeof name === 'string' && CLIP_NAME.test(name))) return null;
      read.animations = [...item.animations as string[]];
    }
    if (item.clipsOnly !== undefined) {
      if (!glb || item.clipsOnly !== true) return null;
      read.clipsOnly = true;
    }
    items.push(read);
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
  // A rigged model's GLBs name their clips; one with clips only is for the skeleton of the first model.
  const first = media.items.find(item => item.contentType === 'model/gltf-binary' && !item.clipsOnly);
  const model = first ? `${node.id}/${first.name}` : '';
  const animated = media.items.some(item => item.animations?.length);
  const clipsOnly = media.items.some(item => item.clipsOnly);
  const extra = (item: MediaOutputItem) => item.contentType !== 'model/gltf-binary' ? ''
    : `${item.clipsOnly ? `；只有动画，没有模型${model ? `，骨骼与 ${model} 相同` : ''}` : ''}${item.animations?.length ? `；动画：${item.animations.join(' ')}` : ''}`;
  const lines = [
    `「${title}」生成的${KIND_WORDS[media.kind]}文件（存放在这张画布的成果里，这里只列文件，不含内容）：`,
    ...media.items.map(item => `- ${node.id}/${item.name}（${item.contentType}，${item.size} 字节${extra(item)}）`),
    '网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。',
  ];
  if (animated) {
    lines.push(`带动画的 GLB 用 THREE.AnimationMixer 按上面的动画名播放它的动画（gltf.animations）。${clipsOnly && model
      ? `只有动画的文件和 ${model} 是同一副骨骼：加载它只取动画，按骨骼名用到 ${model} 的场景上。` : ''}`);
  }
  return lines.join('\n');
}


/**
 * What a downstream input reads from a media node that made no file this time (it failed, was refused or cancelled, or
 * never ran): the node goes on without it, told that no path exists. The same text the API builds (mediaMissingText in
 * graph_media.go).
 */
export function mediaMissingText(node: { id: string; title?: string; agentKind?: string }): string {
  const title = node.title?.trim() || node.id;
  const kind = node.agentKind === 'image' || node.agentKind === 'video' || node.agentKind === 'model3d' ? KIND_WORDS[node.agentKind] : '媒体';
  return `「${title}」这次没有生成出${kind}文件，没有可以引用的路径：网页里不要引用它的任何文件，也不要编造文件名，用不依赖它的设计完成。`;
}

/** A media node's delivery as a downstream input reads it: the files it stored, or the note that it made none. */
export function mediaInputText(node: { id: string; title?: string; agentKind?: string }, text: string | null | undefined): string {
  return parseMediaOutput(text) ? mediaDeliveryText(node, text!) : mediaMissingText(node);
}
