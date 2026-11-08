// The name a node's model goes by where a run is reported (the execution timeline, the 成果 view's run receipt) and in
// a node's model chip when its model is not among the workspace's choices.
//
// A chat model is named by the workspace catalogue's label when the catalogue has it, else by its selector, as before.
// A media model (image, video, 3D) is only ever named generically, in the reader's language: by the media catalogue's
// name for it (图片 · 高清 / Image · HD), else by its kind (图片 / Image). Never by its id: `xt.seedream-5-pro` names the
// service and the model family that produce it, and users see neither (owner decisions 2026-10-11, mediaCatalog.ts).
//
// Where a view has only a model's selector and none of a node's other fields (多人同屏's running AwwO Agents), a chat
// model goes by the name the node's model picker shows it by, else by a name read from the selector (shownChatModelName),
// never by the selector itself: `bedrock.claude-opus-5-5` names the service AwwO reaches the model through.
import type { UiLocale } from '../locale';
import { mediaKindOf, mediaModelLabel, type MediaCatalogue, type MediaKind } from './mediaCatalog';
import { isMediaModelId } from './mediaModelIds';
import type { ModelPaletteSelection } from './modelPalette';
import { automaticEntries } from './nodeRuntime';

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

/** A selector's route, region or vendor in front of the model: a leading word of letters alone before a dot (`bedrock.`,
 *  `us.`, `anthropic.`), or the name of a service AwwO reaches models through before a hyphen or an underscore too (a
 *  single Bedrock profile's `bedrock-kimi`, docs/awwo-bedrock.md). A model's own name has a digit or a hyphen before any
 *  dot of its own (Qwen3.8, GPT-5.6). */
const ROUTE = /^(?:[a-z]+\.|(?:bedrock|llmgate)[-_])/i;

/** Whether a catalogue's name for a model is a selector with its route, region or vendor in front (ROUTE) or a path
 *  (`anthropic/`): only when it is written as selectors are, in lower case with no space. A published name is anything
 *  up to 80 characters (apps/openai-agents-worker/config.mjs validProfileName), so one such as "GPT-5.6/Team" or
 *  "Dr. Model 2" stays as published. A name of one word that starts with the name of a service AwwO reaches models
 *  through is a selector in any case (a profile id may be `Bedrock-Kimi`). */
const providerPrefixed = (name: string): boolean => /^(?:bedrock|llmgate)[._-]\S*$/i.test(name)
  || (/^[a-z0-9][a-z0-9._:/-]*$/.test(name) && (ROUTE.test(name) || name.includes('/')));

/** The name the node's model picker shows a chat model by (CanvasSurface's chat model choices: the catalogue's published
 *  name, else its label), from the entry the picker lists it by, else from any of the catalogue's entries for it. A name
 *  that is a selector is read as one (selectorModelName): the model's own selector, where the catalogue has no other
 *  name for it, or one with its route, region or vendor in front, as a connection names its models by the ids its
 *  service gives them (AwwO 云端's are AwwO's own selectors, `bedrock.claude-opus-5-5`). '' when the catalogue has none. */
export function pickerModelName(model: string, models: readonly ModelPaletteSelection[] | undefined): string {
  if (!model || !models?.length) return '';
  const entry = automaticEntries(models).find(item => item.model === model) ?? models.find(item => item.model === model);
  const name = (entry?.displayName || entry?.label || '').trim();
  return name === model || providerPrefixed(name) ? selectorModelName(name) : name;
}

/** The longest name read from a selector (the catalogue's own names are at most 80 characters). */
const SELECTOR_NAME_MAX = 64;
/** A selector's words that a model's name writes otherwise than with a capital first letter. */
const WORD_CASE: Readonly<Record<string, string>> = { gpt: 'GPT', glm: 'GLM', oss: 'OSS', vl: 'VL', deepseek: 'DeepSeek', minimax: 'MiniMax' };

/** A chat model's name read from its selector alone, for a model no catalogue at hand names (one the workspace no longer
 *  lists, or before its catalogue arrives). The route or vendor the selector starts with goes, since AwwO never says
 *  which service runs a model (owner decisions 2026-10-11): `bedrock.` (or a profile's `bedrock-`), a cross-region
 *  profile's `us.anthropic.`, a path's `anthropic/` (ROUTE). The rest is written as words with its version joined up:
 *  `bedrock.claude-opus-5-5` is "Claude Opus 5.5", `bedrock.llama-3-3-70b` "Llama 3.3 70B". '' where the selector holds
 *  no name: a media model's id, a team connection's selector (byok_…), or a value with characters no selector has. */
export function selectorModelName(model: unknown): string {
  if (typeof model !== 'string') return '';
  const selector = model.trim();
  if (!/^[A-Za-z0-9._:/-]+$/.test(selector) || /^byok_/i.test(selector) || isMediaModelId(selector.toLowerCase())) return '';
  let rest = selector.slice(selector.lastIndexOf('/') + 1).replace(/:\d+$/, '');
  while (ROUTE.test(rest)) rest = rest.replace(ROUTE, '');
  const words: string[] = [];
  for (const part of rest.split(/[-_]+/)) {
    if (!part) continue;
    const last = words.length - 1;
    // A version spelt with hyphens: 5-5 is 5.5, k2-5 is K2.5.
    if (last >= 0 && /\d$/.test(words[last]) && /^\d{1,2}$/.test(part)) { words[last] = `${words[last]}.${part}`; continue; }
    words.push(WORD_CASE[part.toLowerCase()] ?? (/^\d+[bkmt]$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)));
  }
  const name = words.join(' ');
  return name.length > SELECTOR_NAME_MAX ? `${name.slice(0, SELECTOR_NAME_MAX - 1).trimEnd()}…` : name;
}

/** A chat model's name for a view that has only its selector (多人同屏's running AwwO Agents): the name the node's model
 *  picker shows it by, else one read from the selector; never a selector with its route, region or vendor, which names
 *  the service AwwO reaches the model through. '' for no model, a media model (its id names the service that makes it,
 *  and even a generic name says nothing a person needs in one line) and a team connection's selector the catalogue does
 *  not name. */
export function shownChatModelName(model: unknown, sources: ModelNameSources): string {
  if (typeof model !== 'string' || !model.trim() || isMediaModelId(model.trim().toLowerCase())) return '';
  return pickerModelName(model, sources.models) || selectorModelName(model);
}
