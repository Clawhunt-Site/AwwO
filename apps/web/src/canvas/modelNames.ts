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
 *  `us.`, `anthropic.`), Bedrock's one vendor with a digit in its name and its one region with a hyphen (`ai21.`,
 *  `us-gov.`: a worker profile with no name of its own publishes its Bedrock id, `ai21.jamba-1-5-mini-v1:0`), or the
 *  name of a service AwwO reaches models through before a hyphen or an underscore too (a single Bedrock profile's
 *  `bedrock-kimi`, docs/awwo-bedrock.md). A model's own name has a digit or a hyphen before any dot of its own (Qwen3.8,
 *  GPT-5.6). */
const ROUTE = /^(?:[a-z]+\.|ai21\.|us-gov\.|(?:bedrock|llmgate)[-_])/i;

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

/** The vendors whose model ids a gateway's path or a Bedrock id puts in front of the model (`anthropic/…`, `anthropic.…`). */
const VENDOR = '(?:anthropic|openai|google|meta(?:-llama)?|mistral(?:ai)?|deepseek(?:-ai)?|qwen|moonshot(?:ai)?|zhipu(?:ai)?|z-?ai|x-?ai'
  + '|amazon|cohere|ai21|nvidia|minimax(?:ai)?|microsoft|ibm|writer|stability|luma|twelvelabs)';
/** The name of a service AwwO reaches models through, anywhere in a text, in any case and however it is written: in a
 *  selector (`bedrock.…`, `review-kimi.bedrock`, `kimi-bedrock2`, `llmgate-…`, `llm-gate`) or in words (`Claude · Bedrock`,
 *  `LLM Gate`, with anything but letters and digits between its words: `LLM  Gate`, `LLM‑Gate`, `LLM・Gate`, `LLM / Gate`),
 *  as a word of its own, a version after it or not; a brand that only starts with its letters (`bedrockish-model-1`) is
 *  another word. AwwO never says which service runs a model (owner decisions 2026-10-11), so a name holding one is never
 *  shown, whoever wrote it. */
const SERVICE_NAME = /(?:^|[^a-z])(?:bedrock|llm[^\p{L}\p{N}]*gate)(?:v?[0-9]|(?![a-z]))/iu;
/** A team connection's selector or a media model's id with a letter after its dot anywhere in a text, in any case
 *  (`xt.seedream…`, `RH.Seedance…`). */
const SHOWN_SERVICE = /byok_|(?:^|[^a-z0-9])(?:rh|xt|jm|tripo)[.][a-z]/i;
/** A Bedrock inference profile (`us.anthropic.…`), a vendor's model id (`anthropic/claude-opus-5-5`,
 *  `deepseek/deepseek-flash`) or a media model's id with a digit after its dot (`xt.123`, mediaModelIds.ts) anywhere in a
 *  text, as a word of its own, written as selectors are, in lower case: an operator's published `Anthropic/Claude-Sonnet-5`
 *  stays as published, and so do `GPTqwen/2` and `Llama XT.2`. */
const SHOWN_ID = new RegExp(`(?:^|[^A-Za-z0-9])(?:global|us|us-gov|eu|apac|jp|au|ca)[.]${VENDOR}[.]|(?:^|[^A-Za-z0-9])${VENDOR}[./][a-z0-9._:-]*[0-9-]`
  + '|(?:^|[^A-Za-z0-9])(?:rh|tripo|xt|jm)[.][0-9]');

/** Whether a text still shows a selector or a service anywhere in it (SERVICE_NAME, SHOWN_SERVICE, SHOWN_ID), however it
 *  is written around it (in brackets, after a space, as a published name or a plan's own words may hold one), and read
 *  as it shows: full-width letters as the letters they are, and with no mark or invisible character (an accent, a
 *  combining joiner, a zero-width space, a soft hyphen) inside a word. A name that does is never shown: it goes as one
 *  no name can be read for. This catches names written in good faith; one disguised on purpose (letters of another
 *  script, letters spaced apart) is for the catalogue's own check of the names it publishes to refuse. */
export function showsSelector(text: string): boolean {
  const seen = text.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '');
  return SERVICE_NAME.test(seen) || SHOWN_SERVICE.test(seen) || SHOWN_ID.test(seen);
}

/** A free workspace's plan tag at the end of a model's label, as runtimeCatalog.ts withPlanTag writes it (` · Pro`): a
 *  hint for choosing the model, not a part of its name. */
export const PLAN_TAG = /\s+·\s+Pro$/;

/** A name's first part, the model's own name, read as a selector where it is one (selectorModelName): the model's own
 *  selector, where the catalogue has no other name for it, one with its route, region or vendor in front, as a connection
 *  names its models by the ids its service gives them (AwwO 云端's are AwwO's own selectors, `bedrock.claude-opus-5-5`),
 *  or one that holds no name (nameless): '' then, and '' too where it still shows a selector (showsSelector). */
const namePart = (part: string, model: string): string => {
  const read = part === model || providerPrefixed(part) || nameless(part) ? selectorModelName(part) : part;
  return showsSelector(read) ? '' : read;
};

/** A model id after a Bedrock profile's region and vendor: it has a version, a digit somewhere (`claude-opus-5-5-v1:0`). */
const VERSIONED = '([A-Za-z0-9._:-]*[0-9][A-Za-z0-9._:-]*)';
/** A model id after a vendor: a version or words joined as ids are (`claude-opus-5-5`, `o3`, `deepseek-flash`), as a
 *  domain's or a word's last part (`google.com`, `moonshot.ai`) is not. A connection's own name, a person's words, is
 *  never read (labelModelName keeps it as written). */
const MODEL_ID = '((?=[A-Za-z0-9._:-]*[0-9-])[A-Za-z0-9][A-Za-z0-9._:-]*)';
/** A service AwwO reaches models through, in front of a model or alone (`bedrock.…`, `bedrock/…`, a profile's `bedrock-…`,
 *  `llmgate…`). */
const SERVICE_PART = /^(?:bedrock|llmgate)[._/-]\S*$/i;
/** A Bedrock inference profile: its region, then a vendor, then the model (`us.anthropic.claude-opus-5-5-v1:0`). */
const PROFILE_PART = new RegExp(`^(?:global|us|us-gov|eu|apac|jp|au|ca)[.]${VENDOR}[.]${VERSIONED}$`, 'i');
/** A vendor's id for its model (`anthropic/claude-opus-5-5`, `anthropic.claude-opus-5-5`, `deepseek/deepseek-flash`). */
const VENDOR_PART = new RegExp(`^${VENDOR}[./]${MODEL_ID}$`, 'i');

/** A later part of a published name or a hosted model's label (a plan tag, a name's own part), read as a selector only
 *  where it is written as one of a service AwwO reaches models through, a Bedrock inference profile or a vendor's model
 *  id (named by its model part then), or one that holds no name ('' then); other words (`team.v1`, `us.team.prod`,
 *  `dev/research`) stay as written, but never one that still shows a selector (showsSelector: '' then). */
function laterPart(part: string): string {
  const model = SERVICE_PART.test(part) || nameless(part) ? part : PROFILE_PART.exec(part)?.[1] ?? VENDOR_PART.exec(part)?.[1];
  const read = model ? selectorModelName(model) : part;
  return showsSelector(read) ? '' : read;
}

/** A name read part by part, between its middle dots (whatever the spaces around them): its first part that is not
 *  empty by `first`, each later one by laterPart. A part read to nothing, or to the first part's name again, is left
 *  out with the dot before it, and the dots kept stay as written, so that a name never grows (a node's title is held
 *  to 200 bytes when it is set up). '' when the first part reads to nothing, and '' too when the name the parts make
 *  still shows a selector or a service across them (`Claude · LLM · Gate`, or `Claude · LLM · bedrock · Gate` once its
 *  `bedrock` is left out: showsSelector). */
function readParts(name: string, first: (part: string) => string): string {
  const pieces = name.trim().split(/(\s*·\s*)/);
  let head = '', shown = '', kept = -1;
  for (let at = 0; at < pieces.length; at += 2) {
    const part = pieces[at].trim();
    if (!part) continue;
    if (!head) {
      head = first(part);
      if (!head) return '';
      shown = head; kept = at;
      continue;
    }
    // A kept part follows the dot that came after the part kept before it.
    const read = laterPart(part);
    if (read && read !== head) { shown += pieces[kept + 1] + read; kept = at; }
  }
  return showsSelector(shown) ? '' : shown;
}

/** A chat model's name as a list of its choices gives it (a catalogue entry, a node's model picker's choice): its first
 *  part read as a selector where it is one (namePart), each later part where it is written as one (laterPart; a name
 *  may join parts with ` · `, a published one may and a connection's label always does), so that no part of it is
 *  shown as a selector. '' for a name whose first part, the model's own, holds no name. */
export function choiceModelName(name: string, model: string): string {
  return readParts(name, part => namePart(part, model));
}

/** The name a list of choices shows a chat model by (the node's model picker, and the task card, which names its model
 *  as the picker's chip does): its name read as a selector where it is one (choiceModelName), else a name read from
 *  its selector, else unnamed (unnamedModelText); never a selector. */
export function listedModelName(name: string, model: string, locale: UiLocale): string {
  return choiceModelName(name, model) || selectorModelName(model) || unnamedModelText(model, true, locale);
}

/** A catalogue label as a list of choices shows it (a team member's model picker, an account's default model), where
 *  the label is what the list is given: its model's name, a connection's label (connections.go: the model's id at the
 *  connection's service, then the connection's name, its service and the end of its id, so that two connections'
 *  models can be told apart), and a free workspace's plan tag (withPlanTag) after it. The part before the first ` · `
 *  names the model: read as a selector where it is one, else unnamed (listedModelName: a connection to AwwO 云端 gives
 *  its models AwwO's own selectors, and a model with no label of its own is listed by its selector). A connection's
 *  label (a team connection's model, `byok_…`) is the model's name and, after its first ` · `, the connection's own name
 *  and the service its key is for (connections.go; an AwwO 云端 name holding ` · ` is refused, cloud_connections.go
 *  cloudModelName): that part is a person's words, kept as written, and the model's name before it is read whole, its
 *  own dots too. In any other label each later part is read as a selector where it is written as one (laterPart), and
 *  the plan tag at its end (PLAN_TAG) stays as written: it is no part of the name, so it never goes as one that repeats
 *  the name (a model published as Pro is listed Pro · Pro on a free workspace, Codex review). */
export function labelModelName(label: string, model: string, locale: UiLocale): string {
  const shown = label.trim();
  const cut = /^byok_/i.test(model) ? shown.indexOf(' · ') : -1;
  const at = cut >= 0 ? cut : shown.length - (PLAN_TAG.exec(shown)?.[0].length ?? 0);
  const named = readParts(shown.slice(0, at), part => listedModelName(part, model, locale)) || listedModelName('', model, locale);
  return named + shown.slice(at);
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
 *  no name: a media model's id, a team connection's selector (byok_…), a value with characters no selector has, or one
 *  whose words would still show a selector or name a service (showsSelector: `review-kimi.bedrock`, `review-llm-gate-x`). */
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
  const shown = name.length > SELECTOR_NAME_MAX ? `${name.slice(0, SELECTOR_NAME_MAX - 1).trimEnd()}…` : name;
  // A selector holding another inside it (`review-bedrock.claude-opus-5-5`), or a service's name anywhere, reads to no
  // name either (Codex review), judged on the whole name, not the shortened one.
  return showsSelector(name) ? '' : shown;
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
