// The name a node's model goes by where a run is reported (the execution timeline, the 成果 view's run receipt), in an
// opened node's task card, and in a node's model chip when its model is not among the workspace's choices.
//
// A chat model goes by the catalogue's published name for it, as the node's model picker shows it (its entry on the
// node's runtime first), else by a name read from its selector (shownChatModelName), never by the selector itself:
// `bedrock.claude-opus-5-5` names the service AwwO reaches the model through, and AwwO never says which service runs a
// model (owner decisions 2026-10-11). The picker lists a model by the same names (NodeModelPicker). Nor by the catalogue's
// label, which the picker does not show either: it carries a free workspace's plan tag (` · Pro`, a hint for choosing a model,
// not part of its name) and, for a connection's model, the connection's service and the model's id at that service
// (connections.go), which for an AwwO 云端 connection is AwwO's own selector. A team connection's selector (byok_…) holds
// no name: where the catalogue does not list it, the model is said to be missing, with just enough of it to tell two
// apart.
// A media model (image, video, 3D) is only ever named generically, in the reader's language: by the media catalogue's
// name for it (图片 · 高清 / Image · HD), else by its kind (图片 / Image). Never by its id: `xt.seedream-5-pro` names the
// service and the model family that produce it, and users see neither (owner decisions 2026-10-11, mediaCatalog.ts).
//
// Where a view has only a model's selector and none of a node's other fields (多人同屏's running AwwO Agents), a chat
// model goes by the same name (shownChatModelName), and a media model or an unlisted connection's model by none.
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

/** The name a node's model is reported by; '' when the node has no model. A chat model goes by the catalogue's name for
 *  it on the node's own runtime, since workers configured apart may give one id to different models, else by the name
 *  the picker shows it by (the picker offers each model once), read as a selector where it is one, else by a name read
 *  from the selector (shownChatModelName). One no name can be read from (a team connection's selector, a value no
 *  selector looks like) is said to be unnamed or missing from the catalogue (unnamedModelText); never shown as it is. */
export function nodeModelName(node: ModelNamed, sources: ModelNameSources, locale: UiLocale): string {
  const model = modelOf(node);
  if (!model) return '';
  if (runsOnMediaModel(node)) return mediaModelName(mediaKindOf(node.agentKind ?? ''), model, sources.media, locale);
  const own = sources.models?.find(item => item.runtime === node.runtime && item.model === model);
  return shownChatModelName(model, own ? { ...sources, models: [own] } : sources)
    || unnamedModelText(model, Boolean(sources.models?.some(item => item.model === model)), locale);
}

/** What a chat model is called when no name can be read for it: one the catalogue lists by nothing but a selector that
 *  holds no name is unnamed, one it does not list is missing from it; a team connection's either way with just enough of
 *  its selector to tell two apart. Never the selector itself. */
export function unnamedModelText(model: string, listed: boolean, locale: UiLocale): string {
  const text = listed ? (locale === 'zh' ? '未命名的模型' : 'Unnamed model') : (locale === 'zh' ? '当前目录未包含该模型' : 'Model not in current catalogue');
  return /^byok_[a-zA-Z0-9_-]+$/.test(model) ? `${text} · ${model.slice(-8)}` : text;
}

/** What a node's model chip shows when its model is not among the workspace's choices (a model it no longer offers): a
 *  media model by its kind, since the catalogue that would name it does not list it; a chat model as a run report names
 *  it (nodeModelName): by the catalogue's name where the catalogue lists it for the node's runtime only (a computer of
 *  its own), else by a name read from its selector, never by the selector. */
export function unlistedModelLabel(node: ModelNamed, locale: UiLocale, models?: readonly ModelPaletteSelection[]): string | undefined {
  return nodeModelName(node, { models }, locale) || undefined;
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

/** Whether a name is a selector that holds no name in any case: a team connection's (`byok_…`) or a media model's id
 *  (`RH.Seedance-Pro`), as a catalogue relayed from another AwwO may name a connection's model by its own selector. */
const nameless = (name: string): boolean => /^byok_/i.test(name) || isMediaModelId(name.toLowerCase());

/** A chat model's name as a list of its choices gives it (a catalogue entry, a node's model picker's choice), read as a
 *  selector where it is one (selectorModelName): the model's own selector, where the catalogue has no other name for it,
 *  one with its route, region or vendor in front, as a connection names its models by the ids its service gives them
 *  (AwwO 云端's are AwwO's own selectors, `bedrock.claude-opus-5-5`), or one that holds no name (nameless). '' for a
 *  name that holds no name. */
export function choiceModelName(name: string, model: string): string {
  const shown = name.trim();
  return shown === model || providerPrefixed(shown) || nameless(shown) ? selectorModelName(shown) : shown;
}

/** The name a list of choices shows a chat model by (the node's model picker, and the task card, which names its model
 *  as the picker's chip does): its name read as a selector where it is one (choiceModelName), else a name read from
 *  its selector, else unnamed (unnamedModelText); never a selector. */
export function listedModelName(name: string, model: string, locale: UiLocale): string {
  return choiceModelName(name, model) || selectorModelName(model) || unnamedModelText(model, true, locale);
}

/** The name the node's model picker shows a chat model by (CanvasSurface's chat model choices: the catalogue's published
 *  name, else its label), from the entry the picker lists it by, else from any of the catalogue's entries for it, read
 *  as a selector where it is one (choiceModelName). '' when the catalogue has none. */
export function pickerModelName(model: string, models: readonly ModelPaletteSelection[] | undefined): string {
  if (!model || !models?.length) return '';
  const entry = automaticEntries(models).find(item => item.model === model) ?? models.find(item => item.model === model);
  return choiceModelName(entry?.displayName || entry?.label || '', model);
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

/** A chat model's name from its selector (多人同屏's running AwwO Agents, and a node's chat model wherever nodeModelName
 *  names it): the name the node's model picker shows it by, else one read from the selector; never a selector with its
 *  route, region or vendor, which names the service AwwO reaches the model through. '' for no model, a media model (its
 *  id names the service that makes it, and even a generic name says nothing a person needs in one line) and a team
 *  connection's selector the catalogue does not name. */
export function shownChatModelName(model: unknown, sources: ModelNameSources): string {
  if (typeof model !== 'string' || !model.trim() || isMediaModelId(model.trim().toLowerCase())) return '';
  return pickerModelName(model, sources.models) || selectorModelName(model);
}
