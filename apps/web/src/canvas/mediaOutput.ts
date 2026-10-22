// What an image or video node produced. The server keeps each generated file as an artifact and
// answers the run with a small record naming them; this reads that record strictly, so any other
// text, however similar, stays ordinary text.

export type MediaOutputKind = 'image' | 'video' | 'model3d' | 'audio';

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
  /** A backup model made it, after the node's own model's service failed it (the API's media_fallback.go). */
  backup?: true;
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
  // An audio node stores MP3 or WAV.
  audio: new Set(['audio/mpeg', 'audio/wav']),
};
const OUTPUT_KINDS: ReadonlySet<unknown> = new Set<MediaOutputKind>(['image', 'video', 'model3d', 'audio']);

export function parseMediaOutput(text: unknown): MediaOutput | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed.startsWith('{') || !trimmed.includes(MEDIA_OUTPUT_TYPE)) return null;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== MEDIA_OUTPUT_TYPE || record.version !== 1 || !OUTPUT_KINDS.has(record.kind)
    || typeof record.model !== 'string' || !Array.isArray(record.items) || !record.items.length || record.items.length > 8) return null;
  const kind = record.kind as MediaOutputKind;
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
  if (record.backup !== undefined && record.backup !== true) return null;
  return { kind, model: record.model.slice(0, 80), items, ...(record.backup ? { backup: true as const } : {}) };
}


/** A file an edit node made beside its film (edit_outputs.go editRecord): its subtitles, its report or one of its stills. */
export interface EditFile {
  artifactId: string;
  name: string;
  contentType: string;
  size: number;
  role: 'subtitles' | 'report' | 'still';
}

/** What an edit node's record says of its film, beside the film item itself. */
export interface EditFacts {
  seconds: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** The film's measured loudness; null when the worker's report had none. */
  loudness: { integratedLUFS?: number; truePeakDb?: number; rangeLU?: number } | null;
  /** The worker's codes for what it adjusted (audio_cut_at_end:m1, subtitle_past_end:3, …). */
  warnings: string[];
  files: EditFile[];
}

/** Each role's one type, as the API keeps it (edit_worker.go editOutputRules). */
const EDIT_ROLE_TYPES: Record<EditFile['role'], string> = { subtitles: 'application/x-subrip', report: 'application/json', still: 'image/jpeg' };
// A code, sometimes with what it is about: audio_cut_at_end:m1, level_unmeasured:<node id>/audio-1.mp3.
const EDIT_WARNING = /^[^\u0000-\u001f\u007f]{1,240}$/;
const LOUDNESS_KEYS = ['integratedLUFS', 'truePeakDb', 'rangeLU'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function editFile(raw: unknown): EditFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as Record<string, unknown>;
  const role = file.role as EditFile['role'];
  if (!Object.hasOwn(EDIT_ROLE_TYPES, role) || file.contentType !== EDIT_ROLE_TYPES[role] || typeof file.artifactId !== 'string'
    || !ARTIFACT_ID.test(file.artifactId) || typeof file.name !== 'string' || !file.name || file.name.length > 200
    || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) return null;
  return { artifactId: file.artifactId, name: file.name, contentType: EDIT_ROLE_TYPES[role], size: file.size, role };
}

/**
 * The facts and other files of an edit node's delivery: a video record (parseMediaOutput) carrying an `edit` block.
 * Read as strictly as the record: anything malformed in the block, and the extras are not shown at all (the film still is).
 */
export function parseEditFacts(text: unknown): EditFacts | null {
  if (parseMediaOutput(text)?.kind !== 'video') return null;
  const edit = (JSON.parse((text as string).trim()) as Record<string, unknown>).edit;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return null;
  const block = edit as Record<string, unknown>;
  const numbers = [block.seconds, block.frames, block.fps, block.width, block.height];
  if (!numbers.every(value => finite(value) && value >= 0) || !Array.isArray(block.warnings) || !Array.isArray(block.files)
    || block.warnings.length > 40 || block.files.length > 160) return null;
  if (!block.warnings.every(code => typeof code === 'string' && EDIT_WARNING.test(code))) return null;
  const files = block.files.map(editFile);
  if (files.some(file => !file)) return null;
  const raw = block.loudness;
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) return null;
  const loudness = raw ? Object.fromEntries(LOUDNESS_KEYS.filter(key => finite((raw as Record<string, unknown>)[key]))
    .map(key => [key, (raw as Record<string, number>)[key]])) : null;
  const [seconds, frames, fps, width, height] = numbers as number[];
  return { seconds, frames, fps, width, height, loudness, warnings: [...block.warnings as string[]], files: files as EditFile[] };
}

const KIND_WORDS: Record<MediaOutputKind, string> = { image: '图片', video: '视频', model3d: '3D 模型', audio: '音频' };
/** An edit's other files as a downstream prompt names them (editRoleShown in graph_media.go). */
const EDIT_ROLE_WORDS: Record<EditFile['role'], string> = { subtitles: '字幕（SRT）', report: '剪辑报告（JSON：时长、响度、各轨数量、警告）', still: '成片抽帧' };

/** How a page plays the audio files listed above it; the same line the API writes (mediaAudioPageRule in graph_media.go). */
export const MEDIA_AUDIO_PAGE_RULE = '音频文件用 <audio> 元素播放（src 写上面的相对路径），或在脚本里用 new Audio(路径) 播放；浏览器只在用户点击等操作之后才允许出声，所以播放要由用户的操作触发。';

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
  // An edit node's film comes with its subtitles, report and stills.
  const edit = parseEditFacts(text);
  const lines = [
    `「${title}」生成的${KIND_WORDS[media.kind]}文件（存放在这张画布的成果里，这里只列文件，不含内容）：`,
    ...media.items.map(item => `- ${node.id}/${item.name}（${item.contentType}，${item.size} 字节${extra(item)}）`),
    ...(edit ? [`这是剪辑好的成片（${edit.seconds.toFixed(1)} 秒）。剪辑还留下了这些文件：`,
      ...edit.files.map(file => `- ${node.id}/${file.name}（${file.contentType}，${file.size} 字节；${EDIT_ROLE_WORDS[file.role]}）`)] : []),
    '网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。',
  ];
  if (animated) {
    lines.push(`带动画的 GLB 用 THREE.AnimationMixer 按上面的动画名播放它的动画（gltf.animations）。${clipsOnly && model
      ? `只有动画的文件和 ${model} 是同一副骨骼：加载它只取动画，按骨骼名用到 ${model} 的场景上。` : ''}`);
  }
  if (media.items.some(item => item.contentType.startsWith('audio/'))) lines.push(MEDIA_AUDIO_PAGE_RULE);
  return lines.join('\n');
}


/** What a node delivering an awwo.media record makes: an image, video, 3D or audio node its own kind, an edit node a film (a video). */
export function mediaSourceKind(node: { agentKind?: string; kind?: string }): MediaOutputKind | null {
  if (node.kind === 'edit') return 'video';
  return node.agentKind === 'image' || node.agentKind === 'video' || node.agentKind === 'model3d' || node.agentKind === 'audio' ? node.agentKind : null;
}

/**
 * What a downstream input reads from a media node that made no file this time (it failed, was refused or cancelled, or
 * never ran): the node goes on without it, told that no path exists. The same text the API builds (mediaMissingText in
 * graph_media.go).
 */
export function mediaMissingText(node: { id: string; title?: string; agentKind?: string; kind?: string }): string {
  const title = node.title?.trim() || node.id;
  const kind = mediaSourceKind(node);
  return `「${title}」这次没有生成出${kind ? KIND_WORDS[kind] : '媒体'}文件，没有可以引用的路径：网页里不要引用它的任何文件，也不要编造文件名，用不依赖它的设计完成。`;
}

/** A media node's delivery as a downstream input reads it: the files it stored, or the note that it made none. */
export function mediaInputText(node: { id: string; title?: string; agentKind?: string; kind?: string }, text: string | null | undefined): string {
  return parseMediaOutput(text) ? mediaDeliveryText(node, text!) : mediaMissingText(node);
}
