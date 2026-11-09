// The web pages a message names, read for the conversation before the message is handled (owner 2026-11-09: 「需要能
// 在对话框里爬取任何网页的内容」). The canvas finds the addresses in what the reader wrote and shows what came of each;
// the host reads them. In the hosted app (saas/messagePageReader.ts) the server's web reader reads each public page into
// the workspace's knowledge, cut to what a task can carry, and the canvas cites it, so the plans, the direct tasks and
// the components that run after it get the page's text as quoted, untrusted evidence. Only addresses a person typed or
// pasted into the box are read (TypedWords): no model and no page picks an address, so none can have one read.
import { splitAttachments } from './attachments';

/** What became of one address a message named: read (its title, and whether it was cut to fit the task), or `error`,
 *  why not, in words for the reader. */
export interface MessagePage { url: string; host: string; title?: string; truncated?: boolean; error?: string }
/** The page being read now, the `index`-th of `total`. */
export interface MessagePagesStep { host: string; index: number; total: number }
/** `hold`: an address was not read, so the message stays in its box with the reason; sent again unchanged it goes
 *  without that page. */
export interface MessagePagesOutcome { pages: MessagePage[]; hold: boolean }
/** `scope` keeps one box's held message and the pages it added apart from another's: the assistant, or a node by its id.
 *  `typed`: the pages (pageKey) whose addresses the person typed or pasted into the box (typedPages); the message's
 *  other addresses are not read. Absent, every address in the message is the person's (the home's request). */
export type ReadMessagePages = (request: { text: string; scope: string; typed?: ReadonlySet<string> }, signal: AbortSignal,
  step: (step: MessagePagesStep) => void) => Promise<MessagePagesOutcome>;

/** At most this many pages are read for one message; more addresses are listed, not read. */
export const MAX_MESSAGE_PAGES = 3;
const MAX_ADDRESS_LENGTH = 2000;
// A page's address as read (pageKey: percent-encoded, so it can run longer than the address written), as long as the
// server reads (webread.ValidateURL).
const MAX_PAGE_URL_LENGTH = 2048;

// An address runs until white space, a quote (curly ones too), an angle bracket, CJK punctuation, an ellipsis or a dash.
const ADDRESS = /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」『』〈〉｛｝“”‘’…—]+/giu;
// Chinese, Japanese and Korean letters: written straight after an address they are the sentence's
// (「总结https://example.com/a的内容」), except where they belong to a part of the address itself: one that begins with
// them, after the address's / = ? & or # (a decoded link: https://zh.wikipedia.org/wiki/北京, ?q=北京天气), or that holds
// them already (/item/北京A座). An address in quotes or brackets is the whole quoted text (「https://zh.wikipedia.org/wiki/C语言」).
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PART_START = '/=?&#';
// The quotes and brackets that end an address (ADDRESS), each with the one that closes it.
const ENCLOSING: Readonly<Record<string, string>> = { '<': '>', '"': '"', "'": "'", '`': '`', '(': ')', '[': ']', '（': '）', '【': '】', '《': '》',
  '「': '」', '『': '』', '〈': '〉', '｛': '｝', '“': '”', '‘': '’' };

/** Where the address in a match ends once the words written straight after it are left out (see CJK). */
function cutAtWords(raw: string): string {
  const chars = [...raw];
  // The host: from the scheme's // (all ASCII before it, so its index counts characters too) to the first / ? or #
  // after it. There such letters straight after a dot are a label of the host (https://example.com.中国/), never the
  // sentence's words.
  const hostStart = raw.indexOf('//') + 2;
  let hostEnd = chars.findIndex((char, i) => i >= hostStart && '/?#'.includes(char));
  if (hostEnd < 0) hostEnd = chars.length;
  // Whether the address's current part (since its last / = ? & or #) holds a Chinese, Japanese or Korean letter.
  let partHasCJK = false;
  for (let i = 0; i < chars.length; i++) {
    if (PART_START.includes(chars[i])) { partHasCJK = false; continue; }
    if (!CJK.test(chars[i])) continue;
    // A full-width or half-width ideographic full stop separates the host's labels too (the URL parser maps it to a dot).
    const hostLabel = i >= hostStart && i < hostEnd && '.．｡'.includes(chars[i - 1]);
    if (partHasCJK || (i > 0 && PART_START.includes(chars[i - 1])) || hostLabel) { partHasCJK = true; continue; }
    return chars.slice(0, i).join('');
  }
  return raw;
}
// Query keys that carry a credential or a one-time code (a sign-in, reset or unsubscribe link, a signed download): such
// an address is not read, so its token is neither spent nor kept in a page's provenance.
const ONE_TIME_KEYS = /^(?:access_?token|refresh_?token|id_?token|token|auth|authorization|code|otp|sig|signature|x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential|key|api_?key|secret|client_?secret|password|passwd|pwd|session|session_?id|sid|magic|ticket|jwt)$/i;
// Inside quotes or brackets an apostrophe is the address's (<https://en.wikipedia.org/wiki/King's_College>): an enclosed
// address runs to its closing mark where nothing else that ends an address (ADDRESS) comes between.
const ENCLOSED = /^https?:\/\/[^\s<>"`，。；：！？、（）【】《》「」『』〈〉｛｝“”‘’…—]+$/iu;
// After a cut inside a host (moreHost): Chinese, Japanese or Korean words straight after it; the marks such writing puts
// after words, which end the words there; and an ideographic full stop that ends the sentence, before such words or
// marks or at the end (请看https://example.com。然后告诉我). Anything else after 。 may be a label (。cn, 。ｃｎ, 。ⓒⓝ).
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u;
const PROSE_MARK = /[，、；：！？“”‘’「」『』（）【】《》〈〉｛｝)\]}"'。]/u;
const SENTENCE_END = /。(?=$|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，、；：！？“”‘’「」『』（）【】《》〈〉｛｝)\]}"'])/u;
// Where the URL parser takes no host from the words as written, more of the host after the cut: a dot (ASCII, full-width
// or half-width) before anything but white space or another dot, or an ideographic full stop that does not end the
// sentence.
// A host the URL parser writes out as numbers: four (IPv4, short forms too) or a bracketed IPv6 address.
const NUMERIC_HOST = /^(?:\d+\.){3}\d+$|^\[/;
const HOST_LABEL_AFTER = /[.．｡][^\s.．｡。]|。(?![\s.．｡。\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，、；：！？“”‘’「」『』（）【】《》〈〉｛｝)\]}"'])./u;
// Punctuation that ends a sentence rather than the address.
const TRAILING = '.,;:!?\'"*_~)]}>';

const count = (text: string, char: string) => text.split(char).length - 1;

/** The address without the punctuation after it; a closing bracket the address itself opened stays (Wikipedia's
 *  Foo_(bar)), one that closes the sentence's goes. */
function trimAddress(raw: string): string {
  let address = raw;
  while (address) {
    const last = address[address.length - 1];
    if ((last === ')' && count(address, '(') >= count(address, ')')) || (last === ']' && count(address, '[') >= count(address, ']'))
      || !TRAILING.includes(last)) return address;
    address = address.slice(0, -1);
  }
  return address;
}

/** Where the mark that closes an enclosure (`opening` just before `from`) is, or -1: the first `closing` from `from` on;
 *  for an ASCII parenthesis or square bracket, the one that balances it (an address can hold them: Foo_(bar)). */
function closingMark(body: string, from: number, opening: string, closing: string): number {
  if (opening !== '(' && opening !== '[') return body.indexOf(closing, from);
  // A Markdown link's destination, ](…): it ends at white space too, before the link's title ([a](url "title")).
  const destination = opening === '(' && body[from - 2] === ']';
  let depth = 0;
  for (let i = from; i < body.length; i++) {
    if (/\s/u.test(body[i])) return destination ? i : -1;
    if (body[i] === opening) depth++;
    else if (body[i] === closing && depth-- === 0) return i;
  }
  return -1;
}

/** Whether the host as written (`written`: from the scheme's // to white space or the first / ? # : or \) names more of
 *  a host than the address read from it (`address`, cut `cut` characters into `written`), so that reading the address
 *  would read another host. Words straight after the cut are the sentence's only where a mark of the sentence or the
 *  end follows them (example.com的内容, not example.co中m). Then the host as written ends where the sentence does, and
 *  the browser's own URL parser, which maps every character a host may hold (full-width and circled letters, the
 *  ideographic full stop) and writes a numeric host out as four numbers, must find the address's host in it but for
 *  the last label, which the sentence's words may lengthen: as many labels, all but the last the same; a numeric host
 *  only as a whole (8.0。1 is 8.0.0.1, 8.0 is 8.0.0.0). Labels with a
 *  letter or a digit count, so a closing bracket after a final dot (see https://example.com.) is the sentence's. Where
 *  the parser takes no host from the words at all, the marks after the cut are read (HOST_LABEL_AFTER). */
function moreHost(written: string, cut: number, address: string): boolean {
  const rest = written.slice(cut);
  const words = CJK_RUN.exec(rest);
  if (words && words[0].length < rest.length && !PROSE_MARK.test(rest[words[0].length])) return true;
  const end = rest.search(SENTENCE_END);
  const host = end < 0 ? written : written.slice(0, cut + end);
  const labels = (name: string) => name.split('.').filter(label => /[\p{L}\p{N}]/u.test(label));
  try {
    const wholeName = new URL(`http://${host}`).hostname;
    const readName = new URL(address).hostname;
    if (NUMERIC_HOST.test(wholeName) || NUMERIC_HOST.test(readName)) return wholeName !== readName;
    const whole = labels(wholeName);
    const read = labels(readName);
    // 1.1。cn is 1.1.cn and 1.1 is 1.0.0.1; example.com的内容 lengthens example.com's last label only.
    return whole.length !== read.length || read.slice(0, -1).some((label, i) => label !== whole[i]);
  } catch { return HOST_LABEL_AFTER.test(rest); }
}

/** Every web address (http and https) in a box's words, where it is written: `start` and `end` index the words. */
function findLinks(body: string): Array<{ address: string; start: number; end: number }> {
  const found: Array<{ address: string; start: number; end: number }> = [];
  const pattern = new RegExp(ADDRESS.source, ADDRESS.flags);
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    // Quoted or bracketed whole, the address is all of it, as written: no punctuation in it is the sentence's.
    const closing = match.index > 0 ? ENCLOSING[body[match.index - 1]] : undefined;
    let enclosed = closing !== undefined && body[match.index + match[0].length] === closing;
    let raw = match[0];
    if (!enclosed && closing !== undefined && closing !== "'") {
      const close = closingMark(body, match.index, body[match.index - 1], closing);
      const span = close > 0 ? body.slice(match.index, close) : '';
      // In angle brackets the address is all of it, whatever marks it holds (<https://example.org/a—b>), as Markdown and
      // mail take it; in other quotes or brackets, one glued to marks an address cannot hold before the closing one is
      // ambiguous (「https://a.example/x，以及其他」): none is read there, rather than its first part.
      if (span && (ENCLOSED.test(span) || (closing === '>' && !/[\s<]/u.test(span)))) { raw = span; enclosed = true; }
      else if (span && !/\s/u.test(span)) { pattern.lastIndex = close; continue; }
    }
    // The next address is looked for after this one's closing mark: a match inside an enclosed address is part of it,
    // and one the match ran on into after it (two Markdown links side by side) is an address of its own.
    if (enclosed) pattern.lastIndex = match.index + raw.length;
    const address = enclosed ? raw : trimAddress(cutAtWords(raw));
    if (!enclosed) {
      // The host as written runs from the scheme's // to white space or the first / ? # : or \ (which the URL parser
      // takes for /). An address cut inside it would read another host where the address goes on past the host (a path,
      // a query, a fragment, or a port before one: 中国/guide) or the words after the cut may be more of the host
      // (moreHost: 中国.org, —docs.org, 。cn, 。ⓒⓝ, co中m): it is ambiguous there, and not read. Only the sentence after
      // the cut (的内容, a full stop, 。然后) reads the host.
      const hostFrom = match.index + raw.indexOf('//') + 2;
      let hostTo = hostFrom;
      while (hostTo < body.length && !/[\s/?#:\\]/u.test(body[hostTo])) hostTo++;
      const kept = match.index + address.length;
      const port = /^:\d+(?=[/?#\\\s]|$)/u.exec(body.slice(hostTo));
      const goesOn = Boolean(port) || (hostTo < body.length && '/?#\\'.includes(body[hostTo]));
      if (kept < hostTo && (goesOn || moreHost(body.slice(hostFrom, hostTo), Math.max(0, kept - hostFrom), address))) continue;
      // An @ in the authority as written (to white space or the first / ? #) puts user information before another host
      // (https://example.com中国:pass@evil.org/guide): an address cut inside it is not read.
      let authorityTo = hostFrom;
      while (authorityTo < body.length && !/[\s/?#\\]/u.test(body[authorityTo])) authorityTo++;
      if (kept < authorityTo && body.slice(hostFrom, authorityTo).includes('@')) continue;
    }
    if (address.length > MAX_ADDRESS_LENGTH) continue;
    let parsed: URL;
    try { parsed = new URL(address); } catch { continue; }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) continue;
    found.push({ address, start: match.index, end: match.index + address.length });
  }
  return found;
}

/** The web addresses (http and https) a message's own words name, each page once (an address differing only by its
 *  #fragment is the same page), in the order written; an attached file's line is not the reader's words. */
export function messageLinks(text: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const { address } of findLinks(splitAttachments(text).body)) {
    const key = pageKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(address);
  }
  return links;
}

/** A box's words and which of them the person typed or pasted (`typed`: sorted, separate [start, end) spans), as against
 *  words the canvas wrote in: a task's draft, a node's fix lead, a starter prompt, a restored draft. Only an address the
 *  person typed or pasted whole is read, so no text a model or a page wrote can have an address read. */
export interface TypedWords { text: string; typed: ReadonlyArray<readonly [number, number]> }

/** Where an edit of a box's words was, when the box knows it: it replaced [start, end) of the words before it with
 *  `text` (`length` characters). A paste's (pasteEdit) carries its text; one that does not fit the words counts for
 *  nothing. `selection`: read from the box's selection as the browser began the edit (selectionEdit); one that does not
 *  fit the words is set aside and the change read from the words alone. */
export interface TypedEdit { start: number; end: number; length: number; text?: string; selection?: boolean }

/** The words become `next`. The changed span is `edit` where it is known and fits the two texts, else the span between
 *  what both share at the start and at the end; it is `typed` or not, and the rest keep what they were, moved with the
 *  change. A change that is not the person's joins nothing of theirs into one address: the words it touches on either
 *  side, up to white space, are not theirs either. A change of the person's whose place the words leave open (the
 *  characters it took repeat beside it) leaves a character theirs only if it is theirs wherever the change was: words
 *  of theirs it took never lend their marks to words it left. */
function rewrite(words: TypedWords, next: string, typed: boolean, edit?: TypedEdit): TypedWords {
  const before = words.text;
  let start: number;
  let removedEnd: number;
  let insertedEnd: number;
  // Read from the words alone: where else the change may begin (`open`, at or before `start`), and from where on a
  // character may be one of the words' last ones, kept (`kept`).
  let open: number;
  let kept: number;
  if (edit && editFits(before, next, edit)) {
    start = edit.start;
    removedEnd = edit.end;
    insertedEnd = edit.start + edit.length;
    open = start;
    kept = insertedEnd;
  } else {
    if (before === next) return words;
    const shared = Math.min(before.length, next.length);
    start = 0;
    while (start < shared && before[start] === next[start]) start++;
    let end = 0;
    while (end < shared - start && before[before.length - 1 - end] === next[next.length - 1 - end]) end++;
    removedEnd = before.length - end;
    insertedEnd = next.length - end;
    // The same change read from the end first: the most the two share at the end, then at the start.
    let tail = end;
    while (tail < shared && before[before.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    open = 0;
    while (open < shared - tail && before[open] === next[open]) open++;
    kept = next.length - tail;
  }
  const shift = insertedEnd - removedEnd;
  const parts: Array<[number, number]> = [];
  for (const [from, to] of words.typed) {
    parts.push([from, Math.min(to, start)]);
    parts.push([Math.max(from, removedEnd) + shift, to + shift]);
  }
  if (typed) parts.push([start, insertedEnd]);
  let spans: Array<[number, number]> = [];
  for (const [from, to] of parts.filter(([from, to]) => from < to).sort((a, b) => a[0] - b[0])) {
    const last = spans[spans.length - 1];
    if (last && last[1] >= from) last[1] = Math.max(last[1], to); else spans.push([from, to]);
  }
  if (typed && open < start) {
    // The person's change may have begun anywhere from `open` on (deleting words that begin as the words after them
    // do, say): up to where it ends, a character is theirs only if it is whichever character it was before, the one at
    // its place (left before the change) or the one `delta` back (left after it, from `kept` on); one the change put in
    // is theirs.
    const own = (i: number) => words.typed.some(([from, to]) => from <= i && i < to);
    const delta = next.length - before.length;
    const zone: Array<[number, number]> = [];
    for (let i = open; i < insertedEnd; i++) {
      if ((i >= start || own(i)) && (i < kept || own(i - delta))) {
        const last = zone[zone.length - 1];
        if (last && last[1] === i) last[1] = i + 1; else zone.push([i, i + 1]);
      }
    }
    const outside = spans.flatMap(([a, b]): Array<[number, number]> => [[a, Math.min(b, open)], [Math.max(a, insertedEnd), b]]).filter(([a, b]) => a < b);
    spans = [];
    for (const [from, to] of [...outside, ...zone].sort((a, b) => a[0] - b[0])) {
      const last = spans[spans.length - 1];
      if (last && last[1] >= from) last[1] = Math.max(last[1], to); else spans.push([from, to]);
    }
  }
  if (!typed) {
    // A word beside the change is changed by it unless white space parts the two, in the words before and after it.
    const solid = (text: string, i: number) => i >= 0 && i < text.length && !/\s/u.test(text[i]);
    let from = start;
    let to = insertedEnd;
    if (solid(next, start - 1) && (solid(before, start) || solid(next, start))) while (solid(next, from - 1)) from--;
    if (solid(next, insertedEnd) && (solid(before, removedEnd - 1) || solid(next, insertedEnd - 1))) while (solid(next, to)) to++;
    spans = spans.flatMap(([a, b]): Array<[number, number]> => [[a, Math.min(b, from)], [Math.max(a, to), b]]).filter(([a, b]) => a < b);
  }
  return { text: next, typed: spans };
}

/** A box's words after the person's own edit from `previous` (what the box showed) to `next`: whatever changed before
 *  it without an edit of theirs (the canvas wrote it) is not theirs; what their edit put in (typing, a paste, a drop) is,
 *  unless `typed` is false (an undo or a redo, which can put back words the canvas wrote: byHand). `edit`: where the
 *  edit was, when the box knows it (a paste over a selection, also of the same words). */
export function typeWords(words: TypedWords | undefined, previous: string, next: string, typed = true, edit?: TypedEdit): TypedWords {
  const base = rewrite(words ?? { text: '', typed: [] }, previous, false);
  // A paste the box did not take as it was (cut short by the box's limit, or changed): none of it is counted. A
  // selection that does not fit the change (an input method's, say) is set aside: the words alone say where it was.
  if (edit && !editFits(base.text, next, edit)) return edit.selection ? rewrite(base, next, typed) : rewrite(base, next, false);
  return rewrite(base, next, typed, edit);
}

/** Whether a known edit (a paste) is what turned `before` into `next`. */
function editFits(before: string, next: string, edit: TypedEdit): boolean {
  return edit.start >= 0 && edit.start <= edit.end && edit.end <= before.length
    && next.length === before.length - (edit.end - edit.start) + edit.length
    && next.slice(0, edit.start) === before.slice(0, edit.start) && next.slice(edit.start + edit.length) === before.slice(edit.end)
    && (edit.text === undefined || next.slice(edit.start, edit.start + edit.length) === edit.text);
}

/** The input events that put in words of the person's own: typing (an input method's composition too), a new line, a
 *  paste (checked by its own record: pasteEdit) and every deletion. Anything else is not counted: an undo or a redo,
 *  which restore earlier words whoever wrote them; a drop, which the box may take cut short (its limit) with nothing to
 *  check it by; a spelling correction, a yank, a transposition, an autofill. */
const BY_HAND = new Set(['insertText', 'insertCompositionText', 'insertLineBreak', 'insertParagraph', 'insertFromPaste']);

/** Whether a box's input event put in words of the person's own (BY_HAND). An event that names no input type is a
 *  script's (a browser's own input events always name one), and is read as its words say: the change is checked
 *  against the box's words before and after, as every change is. */
export function byHand(event: Event): boolean {
  const kind = (event as InputEvent).inputType;
  if (!kind) return true;
  return BY_HAND.has(kind) || kind.startsWith('delete');
}

/** What a paste into a box puts in, and over which of its words (the selection), from the paste event, before the box
 *  changes: typeWords' edit. Undefined when the clipboard holds no text, or the paste puts none in (the event was
 *  cancelled: a file pasted, which the box attaches instead). */
export function pasteEdit(box: HTMLTextAreaElement, event: { clipboardData: DataTransfer | null; defaultPrevented: boolean }): TypedEdit | undefined {
  if (event.defaultPrevented) return undefined;
  const text = event.clipboardData?.getData('text/plain').replace(/\r\n?/g, '\n') ?? '';
  return text ? { start: box.selectionStart, end: box.selectionEnd, length: text.length, text } : undefined;
}

/** Whether a box's input event is the paste a recorded paste edit is for. */
export function pasteInput(event: Event): boolean {
  return (event as InputEvent).inputType === 'insertFromPaste';
}

/** A box's words and selection as the browser began an edit (its beforeinput event, which React does not report), and
 *  the edit's input type: selectionEdit reads the edit that follows from it. */
export interface SelectionBefore { previous: string; start: number; end: number; kind: string }

/** The box's words and selection now, for the beforeinput event that begins an edit. */
export function selectionBefore(box: HTMLTextAreaElement, event: Event): SelectionBefore {
  return { previous: box.value, start: box.selectionStart, end: box.selectionEnd, kind: (event as InputEvent).inputType ?? '' };
}

/** The edit that turned `shown` into `next`, from the selection recorded as the browser began it (selectionBefore):
 *  typing or a new line puts its characters in place of the selection; a deletion takes the selection, or as many
 *  characters as the words lost beside the caret, on the side its input type names. Undefined for any other edit (an
 *  input method's composition, whose range is not the selection; a paste, which pasteEdit records with its text) and
 *  for a record of another edit. typeWords sets aside one that does not fit the words. */
export function selectionEdit(before: SelectionBefore | null, shown: string, next: string, input: Event): TypedEdit | undefined {
  const kind = (input as InputEvent).inputType;
  if (!before || !kind || before.kind !== kind || before.previous !== shown) return undefined;
  const { start, end } = before;
  if (kind === 'insertText' || kind === 'insertLineBreak' || kind === 'insertParagraph') {
    const length = next.length - shown.length + (end - start);
    return length >= 0 ? { start, end, length, selection: true } : undefined;
  }
  if (!kind.startsWith('delete')) return undefined;
  if (start < end) return { start, end, length: 0, selection: true };
  const lost = shown.length - next.length;
  if (lost <= 0) return undefined;
  if (kind.endsWith('Backward')) return start >= lost ? { start: start - lost, end: start, length: 0, selection: true } : undefined;
  if (kind.endsWith('Forward')) return { start, end: start + lost, length: 0, selection: true };
  return undefined;
}

/** The words as a message sent from the box: trimmed, they keep their marks where they are in the box; any other change
 *  since the person's last edit was not theirs. */
function sentWords(words: TypedWords, body: string): TypedWords {
  if (words.text === body) return words;
  const at = body && words.text.trim() === body.trim() ? words.text.indexOf(body) : -1;
  if (at < 0) return rewrite(words, body, false);
  const typed = words.typed.map(([from, to]) => [Math.max(from, at) - at, Math.min(to, at + body.length) - at] as const)
    .filter(([from, to]) => from < to);
  return { text: body, typed };
}

/** The pages (pageKey) of the addresses in a message the person typed or pasted whole into its box (`words`). */
export function typedPages(words: TypedWords | undefined, text: string): Set<string> {
  const body = splitAttachments(text).body;
  const now = sentWords(words ?? { text: '', typed: [] }, body);
  const pages = new Set<string>();
  for (const link of findLinks(body)) {
    if (now.typed.some(([from, to]) => from <= link.start && link.end <= to)) pages.add(pageKey(link.address));
  }
  return pages;
}

/** Whether an address carries a credential or a one-time code in its query (ONE_TIME_KEYS), or a user name and password. */
export function oneTimeLink(address: string): boolean {
  try {
    const parsed = new URL(address);
    return Boolean(parsed.username || parsed.password) || [...parsed.searchParams.keys()].some(key => ONE_TIME_KEYS.test(key));
  } catch { return false; }
}

/** The page an address names, without its #fragment: two addresses that differ only there are one page. */
export function pageKey(address: string): string {
  try { const parsed = new URL(address); parsed.hash = ''; return parsed.href; } catch { return address; }
}

/** The host an address names, for its chip; the address itself when it does not parse. */
export function linkHost(address: string): string {
  try { return new URL(address).host; } catch { return address; }
}

/** Whether an address is a web page's (http or https), the only kind a page's chip links to. */
export function webAddress(address: string): boolean {
  try { const { protocol } = new URL(address); return protocol === 'http:' || protocol === 'https:'; } catch { return false; }
}

/** Whether a stored conversation turn's pages are well formed (canvasPlanning.ts loadPlanningConversation). */
export function validMessagePages(value: unknown): value is MessagePage[] {
  const text = (item: unknown, max: number) => typeof item === 'string' && item.length <= max;
  return Array.isArray(value) && value.length <= 12 && value.every(page => {
    if (!page || typeof page !== 'object') return false;
    const { url, host, title, truncated, error } = page as MessagePage;
    return text(url, MAX_PAGE_URL_LENGTH) && webAddress(url) && text(host, 300) && (title === undefined || text(title, 300))
      && (truncated === undefined || typeof truncated === 'boolean') && (error === undefined || text(error, 600));
  });
}
