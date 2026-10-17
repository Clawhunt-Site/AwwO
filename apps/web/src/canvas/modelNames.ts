// The name a node's model goes by where a run is reported (the execution timeline, the 成果 view's run receipt) and in
// a node's model chip when its model is not among the workspace's choices.
//
// A chat model is named by the workspace catalogue's label when the catalogue has it, else by its selector, as before.
// A media model (image, video, 3D) is only ever named generically, in the reader's language: by the media catalogue's
// name for it (图片 · 高清 / Image · HD), else by its kind (图片 / Image). Never by its id: `xt.seedream-5-pro` names the
// service and the model family that produce it, and users see neither (owner decisions 2026-10-11, mediaCatalog.ts).
import type { UiLocale } from '../locale';
import { mediaKindOf, mediaModelLabel, type MediaCatalogue, type MediaKind } from './mediaCatalog';
import { isMediaModelId } from './mediaModelIds';
import type { ModelPaletteSelection } from './modelPalette';

/** What a host can name models with: the workspace's chat models and its media catalogue. Either may be missing. */
export interface ModelNameSources {
  models?: readonly ModelPaletteSelection[];
  media?: MediaCatalogue | null;
}

/** The fields of a node, live or as a run recorded it, that say which model it runs on. */
export interface ModelNamed {
  agentKind?: string;
  runtime?: string;
  model?: unknown;
}

const KIND_NAMES: Readonly<Record<MediaKind, readonly [zh: string, en: string]>> = {
  image: ['图片', 'Image'], video: ['视频', 'Video'], model3d: ['3D 模型', '3D model'], audio: ['音频', 'Audio'],
};

const modelOf = (node: ModelNamed): string => typeof node.model === 'string' ? node.model : '';

/** Whether a node runs on a media model: an image, video or 3D node, or any node whose model is a media model's id. */
export function runsOnMediaModel(node: ModelNamed): boolean {
  return Boolean(mediaKindOf(node.agentKind ?? '')) || isMediaModelId(node.model);
}

/** A media model's name: the catalogue's generic name for it, else its kind's. Never its id. */
export function mediaModelName(kind: MediaKind | null, model: string, media: MediaCatalogue | null | undefined, locale: UiLocale): string {
  const entry = model ? media?.models.find(item => item.id === model && (!kind || item.kind === kind)) : undefined;
  if (entry) return mediaModelLabel(entry, locale);
  if (kind) return KIND_NAMES[kind][locale === 'zh' ? 0 : 1];
  return locale === 'zh' ? '媒体模型' : 'Media model';
}

/** The name a node's model is reported by; '' when the node has no model. */
export function nodeModelName(node: ModelNamed, sources: ModelNameSources, locale: UiLocale): string {
  const model = modelOf(node);
  if (!model) return '';
  if (runsOnMediaModel(node)) return mediaModelName(mediaKindOf(node.agentKind ?? ''), model, sources.media, locale);
  const entry = sources.models?.find(item => item.runtime === node.runtime && item.model === model);
  if (entry?.label) return entry.label;
  // A team connection's selector (byok_…) is not a name: say it is missing, with just enough of it to tell two apart.
  if (/^byok_[a-zA-Z0-9_-]+$/.test(model)) return `${locale === 'zh' ? '当前目录未包含该模型' : 'Model not in current catalogue'} · ${model.slice(-8)}`;
  return model;
}

/** What a node's model chip shows when its model is not among the workspace's choices (a model it no longer offers): a
 *  media model by its kind, since the catalogue that would name it does not list it; any other model by its selector. */
export function unlistedModelLabel(node: ModelNamed, locale: UiLocale): string | undefined {
  const model = modelOf(node);
  if (!model) return undefined;
  return runsOnMediaModel(node) ? mediaModelName(mediaKindOf(node.agentKind ?? ''), model, null, locale) : model;
}
