// The publish form's own state: what it starts from (a canvas node, an existing draft, or nothing), what the server
// would refuse (the contract's limits, checked here first so the author sees which field is over), and the request it
// sends. The server checks every one of these again.
import { SaaSApiError, saasErrorMessage } from '../api';
import type { SessionNode } from '../../canvas/canvasDoc';
import { SANDBOX_RUNTIME } from '../../canvas/nodeRuntime';
import { MARKET_LIMITS, type MarketAgentKind, type MarketCategory, type MarketDraft, type MarketDraftInput, type MarketExample, type MarketModel } from '../marketApi';
import type { MarketT } from './marketText';

export interface PublishSkill { tenantId: string; ref: string; title: string }
export interface PublishForm {
  name: string; tagline: string; description: string; category: MarketCategory; kind: MarketAgentKind;
  instructions: string; instructionsPublic: boolean; skills: PublishSkill[]; model: MarketModel;
  /** Kept as typed, so a half-written number can be corrected rather than replaced. */
  price: string; examples: MarketExample[]; authorName: string;
}
export type PublishField = 'name' | 'tagline' | 'description' | 'category' | 'kind' | 'instructions' | 'skills' | 'model' | 'price' | 'examples' | 'authorName';
export type PublishErrors = Partial<Record<PublishField, string>>;

/** The workspace a skill reference is frozen from: its own for a workspace skill, none for a built-in one. */
export const skillTenant = (ref: string, tenantId: string) => ref.startsWith('builtin:') ? '' : tenantId;

/** A node's persona, skills and model as an Agent of the market; its title is the Agent's name. A market Agent is a text
 *  Agent, so a coding node's becomes one, and a sandbox node's model is suggested on its text runtime. */
export function formFromNode(node: SessionNode, tenantId: string): PublishForm {
  return { name: [...node.title.trim()].slice(0, MARKET_LIMITS.name).join(''), tagline: '', description: '', category: 'other',
    kind: 'llm', instructions: node.persona, instructionsPublic: false,
    skills: (node.skills ?? []).map(ref => ({ tenantId: skillTenant(ref, tenantId), ref, title: '' })),
    model: { runtime: node.runtime === SANDBOX_RUNTIME ? '' : node.runtime, id: node.model, effort: node.effort, locked: false }, price: '0', examples: [], authorName: '' };
}
export function formFromDraft(draft: MarketDraft): PublishForm {
  return { name: draft.name, tagline: draft.tagline, description: draft.description, category: draft.category, kind: 'llm',
    instructions: draft.instructions, instructionsPublic: draft.instructionsPublic,
    skills: draft.skills.map(skill => ({ tenantId: skill.tenantId, ref: skill.ref, title: skill.title || skill.name })),
    model: draft.model, price: String(draft.price), examples: draft.examples, authorName: draft.authorName };
}
export const emptyForm = (): PublishForm => ({ name: '', tagline: '', description: '', category: 'other', kind: 'llm', instructions: '', instructionsPublic: false,
  skills: [], model: { runtime: '', id: '', effort: '', locked: false }, price: '0', examples: [], authorName: '' });

export function inputOf(form: PublishForm): MarketDraftInput {
  return { name: form.name.trim(), tagline: form.tagline.trim(), description: form.description.trim(), category: form.category, kind: 'llm',
    instructions: form.instructions, instructionsPublic: form.instructionsPublic, skills: form.skills.map(({ tenantId, ref }) => ({ tenantId, ref })),
    // A model the Agent does not name can neither be locked nor carry an effort.
    model: { ...form.model, effort: form.model.id ? form.model.effort : '', locked: form.model.locked && Boolean(form.model.id) }, price: Number(form.price.trim()),
    examples: form.examples.map(example => ({ prompt: example.prompt.trim(), result: example.result.trim() })).filter(example => example.prompt || example.result),
    authorName: form.authorName.trim() };
}

// The characters the server refuses in a market text (market.go marketHiddenText): every control but a newline and a
// tab (C1 included), every format character (soft hyphens, zero-width and text-direction controls, the byte order mark,
// tag characters), private-use characters, the line and paragraph separators, noncharacters, the Hangul fillers that show
// as blanks, and variation selectors but a single U+FE0E or U+FE0F after a character.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\u2028\u2029\u115f\u1160\u3164\uffa0\ufdd0-\ufdef]/u;
const isSelector = (code: number) => (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x180b && code <= 0x180d) || code === 0x180f || (code >= 0xe0100 && code <= 0xe01ef);
export function hasHiddenText(value: string): boolean {
  let prev = -1;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch !== '\n' && ch !== '\t' && (INVISIBLE.test(ch) || (code & 0xfffe) === 0xfffe)) return true;
    if (isSelector(code) && !((code === 0xfe0e || code === 0xfe0f) && prev >= 0 && ![0x0a, 0x09, 0x20].includes(prev) && !isSelector(prev))) return true;
    prev = code;
  }
  return false;
}
// The words no name in the market may hold, an Agent's or its author's (market.go marketReservedNames), read as the
// server reads them (marketNameSkeleton): NFKC-folded, in lower case, the Cyrillic and Greek letters drawn like Latin
// ones and the digits and signs written for letters folded (l, 1 and i together), "vv" and "rn" read as w and m, and
// everything but letters and decimal digits left out (Go's unicode.IsLetter and IsDigit: \p{L} and \p{Nd}).
const RESERVED_NAMES = ['awwo', 'clawhunt', '阿呜', '阿嗚', 'official', '官方'];
const LOOKALIKES: Record<string, string> = {
  '\u0430': 'a', '\u0432': 'b', '\u0441': 'c', '\u0501': 'd', '\u0435': 'e', '\u0451': 'e', '\u04bb': 'h', '\u043d': 'h', '\u0456': 'i', '\u04cf': 'i',
  '\u0458': 'j', '\u043a': 'k', '\u043c': 'm', '\u043e': 'o', '\u0440': 'p', '\u051b': 'q', '\u0455': 's', '\u0442': 't', '\u0443': 'y', '\u04af': 'y',
  '\u0445': 'x', '\u051d': 'w', '\u03b1': 'a', '\u03b2': 'b', '\u03b5': 'e', '\u03b7': 'h', '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'm', '\u03bd': 'n',
  '\u03bf': 'o', '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'y', '\u03c7': 'x', '\u03c9': 'w', '\u03b6': 'z', '\u03f2': 'c',
  '0': 'o', '1': 'i', 'l': 'i', '3': 'e', '5': 's', '$': 's', '@': 'a',
};
const skeleton = (value: string) => [...value.normalize('NFKC').toLowerCase()].map(ch => LOOKALIKES[ch] ?? ch).join('')
  .replace(/vv/g, 'w').replace(/rn/g, 'm').replace(/[^\p{L}\p{Nd}]/gu, '');
export const reservedName = (value: string) => {
  const folded = skeleton(value);
  return RESERVED_NAMES.some(word => folded.includes(skeleton(word)));
};

const characters = (value: string) => [...value].length;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** What the server would refuse, field by field; nothing when the form can be sent. */
export function validatePublish(form: PublishForm, maxPrice: number, t: MarketT): PublishErrors {
  const errors: PublishErrors = {};
  const over = (limit: number) => t(`最多 ${limit} 个字符。`, `At most ${limit} characters.`);
  const oneLine = t('只能写一行。', 'Keep it to one line.');
  const name = form.name.trim();
  if (!name) errors.name = t('请填写名称。', 'Enter a name.');
  else if (characters(name) > MARKET_LIMITS.name) errors.name = over(MARKET_LIMITS.name);
  else if (/[\n\t]/.test(name)) errors.name = oneLine;
  const tagline = form.tagline.trim();
  if (!tagline) errors.tagline = t('请写一句话简介，市场的卡片上会显示它。', 'Write a tagline; the market’s cards show it.');
  else if (characters(tagline) > MARKET_LIMITS.tagline) errors.tagline = over(MARKET_LIMITS.tagline);
  else if (/[\n\t]/.test(tagline)) errors.tagline = oneLine;
  if (characters(form.description.trim()) > MARKET_LIMITS.description) errors.description = over(MARKET_LIMITS.description);
  if (!form.instructions.trim()) errors.instructions = t('请写下这个 Agent 的指令。', 'Write the Agent’s instructions.');
  else if (bytes(form.instructions) > MARKET_LIMITS.instructionsBytes) errors.instructions = t(`指令最多 ${MARKET_LIMITS.instructionsBytes} 字节（现在 ${bytes(form.instructions)}）。`,
    `The instructions take at most ${MARKET_LIMITS.instructionsBytes} bytes (now ${bytes(form.instructions)}).`);
  if (form.skills.length > MARKET_LIMITS.skills) errors.skills = t(`最多 ${MARKET_LIMITS.skills} 个技能。`, `At most ${MARKET_LIMITS.skills} skills.`);
  else if (form.skills.some(skill => !skill.ref)) errors.skills = t('有技能读不出它的来源，请移除后重新添加。', 'A skill’s source could not be read; remove it and add it again.');
  const price = form.price.trim();
  if (!/^\d+$/.test(price) || Number(price) > maxPrice) errors.price = t(`价格是 0 到 ${maxPrice} 的整数点数（0 表示免费）。`, `The price is a whole number of credits from 0 to ${maxPrice} (0 is free).`);
  if (form.examples.length > MARKET_LIMITS.examples) errors.examples = t(`最多 ${MARKET_LIMITS.examples} 个示例。`, `At most ${MARKET_LIMITS.examples} examples.`);
  else if (form.examples.some(example => characters(example.prompt.trim()) > MARKET_LIMITS.examplePrompt || characters(example.result.trim()) > MARKET_LIMITS.exampleResult)) {
    errors.examples = t(`示例的请求最多 ${MARKET_LIMITS.examplePrompt} 个字符，结果最多 ${MARKET_LIMITS.exampleResult} 个。`,
      `An example’s request takes at most ${MARKET_LIMITS.examplePrompt} characters and its result ${MARKET_LIMITS.exampleResult}.`);
  } else if (form.examples.some(example => !example.prompt.trim() && example.result.trim())) {
    errors.examples = t('每个示例都要写上请求。', 'Each example needs its request.');
  }
  if (characters(form.authorName.trim()) > MARKET_LIMITS.authorName) errors.authorName = over(MARKET_LIMITS.authorName);
  else if (/[\n\t]/.test(form.authorName.trim())) errors.authorName = oneLine;
  else if (reservedName(form.authorName)) errors.authorName = t('署名不能用 AwwO、ClawHunt、阿呜的名字，也不能自称官方。', 'An author name may not use the name of AwwO, ClawHunt or 阿呜, or claim to be official.');
  if (!errors.name && reservedName(name)) errors.name = t('名称不能用 AwwO、ClawHunt、阿呜的名字，也不能自称官方。', 'A name may not use the name of AwwO, ClawHunt or 阿呜, or claim to be official.');
  const hidden: Array<[PublishField, string]> = [['name', form.name], ['tagline', form.tagline], ['description', form.description], ['instructions', form.instructions],
    ['authorName', form.authorName], ['examples', form.examples.map(example => example.prompt + example.result).join('')]];
  for (const [field, value] of hidden) if (!errors[field] && hasHiddenText(value)) errors[field] = t('含有看不见的格式字符，请删掉它们。', 'This holds invisible formatting characters; remove them.');
  return errors;
}

const FIELDS: readonly PublishField[] = ['name', 'tagline', 'description', 'category', 'kind', 'instructions', 'skills', 'model', 'price', 'examples', 'authorName'];
// The server names the field a draft refusal is about at the start of its message (market.go marketText, validate):
// "tagline is required", "The instructions may not contain …", "Only a named model can be locked".
const MESSAGE_FIELDS: ReadonlyArray<[RegExp, PublishField]> = [[/^name\b/, 'name'], [/^tagline\b/, 'tagline'], [/^description\b/, 'description'],
  [/^authorName\b|^give an author name/i, 'authorName'], [/^(the )?instructions\b/i, 'instructions'], [/^example\b|examples\b/i, 'examples'], [/^unknown category/i, 'category'],
  [/^(a market agent|an agent) is a text/i, 'kind'], [/model/i, 'model'], [/skills?\b/i, 'skills']];
/** The field a refusal of the draft is about, when the server says (in its details, its message, or its code). */
export function refusedField(error: unknown): PublishField | null {
  if (!(error instanceof SaaSApiError)) return null;
  const named = error.details.field;
  if (typeof named === 'string' && (FIELDS as readonly string[]).includes(named)) return named as PublishField;
  if (error.code === 'market_price_invalid') return 'price';
  if (error.code === 'market_name_reserved') return /^the author name/i.test(error.message) ? 'authorName' : 'name';
  if (error.code === 'market_skill_unavailable' || error.code === 'market_skill_license' || error.code === 'skill_context_limit') return 'skills';
  if (error.code === 'market_draft_invalid' || error.code === 'market_hidden_text') return MESSAGE_FIELDS.find(([pattern]) => pattern.test(error.message))?.[1] ?? null;
  return null;
}

/** What the form says of a refusal: the code's copy, but the skills' size in the form's own words (the copy of
 *  skill_context_limit speaks of a node). */
export function refusalText(error: unknown, locale: 'zh' | 'en', t: MarketT): string {
  if (error instanceof SaaSApiError && error.code === 'skill_context_limit') {
    return t('这些技能合计太长（超过 20 KiB），一次调用放不下，请移除一个技能。', 'These skills are too long together (over 20 KiB) for one call. Remove one.');
  }
  return saasErrorMessage(error, locale);
}
