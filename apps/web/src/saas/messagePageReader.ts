// The hosted app's reader of the web pages a conversation's message names (canvas/messagePages.ts). Each address is
// read by the server's web reader (POST …/knowledge/sources/web: public addresses only, robots.txt honoured, a bot check
// reported and never worked around, the workspace's daily allowance) into the workspace's knowledge, cut to its share of
// what one task can quote beside the knowledge the canvas already cites (`fit`), and then cited by the canvas
// (canvasBridge.ts), as the canvas bar's 从网址读取 → 加入任务 does: the assistant's plans, its direct tasks and the
// components that run quote it until the reader clears the references or leaves the canvas.
//
// Only an address the person typed or pasted into the box is read; one the canvas wrote there is listed as not read. A
// page still cited is not read again. To make room, a box lets go of the pages only its own messages added or named,
// oldest first, never one the message itself names, never one the reader chose to cite and never one another box's
// message added or named too (that message may still be on its way with it). An address with a credential or a
// one-time code in it is not read. One reader serves one open canvas while the canvas holds it (attach): a read that
// outlives that (the reader opened another canvas, or the same one again) cites nothing, here or there.
// Whether the server reads the web, and cuts a page to fit a task, is asked once, at the first message with an address:
// a server older than this page (no `fit`) reads none of a message's pages, which goes as it did before.
import { SaaSApiError, saasErrorMessage } from './api';
import { canvasKnowledgeRevisionIds, configureCanvasKnowledge, currentSaaSCanvas, subscribeCanvasKnowledge } from './canvasBridge';
import { readCapabilities } from './capabilitiesApi';
import { importKnowledgeFromWeb, KNOWLEDGE_CONTEXT_ITEMS, readKnowledgeRevisionContext } from './knowledgeApi';
import { linkHost, MAX_MESSAGE_PAGES, messageLinks, oneTimeLink, pageKey, type MessagePage, type MessagePagesOutcome, type ReadMessagePages } from '../canvas/messagePages';
import type { UiLocale } from '../locale';

/** The reader, and how its canvas holds it: attach() while the canvas is open (an effect's setup, which may run again,
 *  as React's development checks do), and the function it returns once the canvas lets go of it (the cleanup). */
export type MessagePageReader = ReadMessagePages & { attach(): () => void };

/** How long the server is given to say whether it reads the web. */
export const WEB_READER_CHECK_TIMEOUT_MS = 15_000;

const words = (locale: UiLocale, zh: string, en: string) => locale === 'zh' ? zh : en;
// A turn keeps its pages within what canvasPlanning.ts loads back (validMessagePages).
const clip = (text: string, max: number) => [...text].slice(0, max).join('');
const closed = () => new DOMException('The canvas was closed', 'AbortError');
const sameRevisions = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(id => b.includes(id));

/** The promise, or the signal's stop, whichever comes first; the promise itself goes on. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', stop); reject(error); });
  });
}

export function createMessagePageReader(tenantId: string, canvasId: string, locale: () => UiLocale): MessagePageReader {
  // The pages this reader read, by page (pageKey): their revision and what their chip says.
  const read = new Map<string, { revisionId: string; page: MessagePage }>();
  // The revisions this reader added to the canvas's citations, oldest first, each with the boxes (`scope`) whose messages
  // added or named it; never one the reader had cited already.
  let added: Array<{ revision: string; scopes: Set<string> }> = [];
  // A message held because a page was not read, with those pages, for each box: sent again unchanged from that box, it
  // goes without them.
  const held = new Map<string, { text: string; failed: Map<string, MessagePage> }>();
  // Whether the server reads the web ('reads'), does not ('off'), or is older than reading a message's pages ('old': it
  // cannot cut a page to fit a task), asked once (asked again after a failed answer).
  let readsTheWeb: Promise<'reads' | 'off' | 'old'> | null = null;
  const webReader = () => readsTheWeb ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_READER_CHECK_TIMEOUT_MS);
    try {
      const { webReader: reader } = await readCapabilities(tenantId, controller.signal);
      return !reader.enabled ? 'off' as const : reader.fit === true ? 'reads' as const : 'old' as const;
    } finally { clearTimeout(timer); }
  })().catch((error: unknown) => { readsTheWeb = null; throw error; });

  // The citations are the open canvas's; this reader's canvas is the one it may change, while the canvas holds it (a read
  // that outlives that, also once the same canvas is opened again, cites nothing).
  let attached = true;
  const here = () => { const open = currentSaaSCanvas(); return attached && open?.tenant.id === tenantId && open.canvasId === canvasId; };
  const cited = () => here() ? canvasKnowledgeRevisionIds() : [];
  // A change of the citations the reader did not make itself (the member cleared a reference, or picked one) takes back
  // what it had added and is no longer cited: picked again, such a page is the member's own.
  let citing = false;
  let watched: object | null = null;
  let unwatch: (() => void) | null = null;
  const watch = () => {
    const open = currentSaaSCanvas();
    if (!open || !attached) return;
    // A canvas opened again starts with no citations (canvasBridge.ts): what this reader added before is gone.
    if (open !== watched) { unwatch?.(); unwatch = null; watched = open; added = []; read.clear(); }
    unwatch ??= subscribeCanvasKnowledge(() => {
      if (citing) return;
      const now = new Set(cited());
      added = added.filter(entry => now.has(entry.revision));
      for (const [key, entry] of read) if (!now.has(entry.revisionId)) read.delete(key);
    });
  };
  const cite = (revisionIds: string[]) => {
    if (!here()) throw closed();
    citing = true;
    try { configureCanvasKnowledge(revisionIds); } finally { citing = false; }
  };
  const stillCited = (address: string) => {
    const entry = read.get(pageKey(address));
    return entry && cited().includes(entry.revisionId) ? entry : undefined;
  };
  /** Makes a page this reader added, still cited, the box `scope`'s too. */
  const share = (address: string, scope: string) => {
    const known = stillCited(address);
    if (known) added.find(entry => entry.revision === known.revisionId)?.scopes.add(scope);
  };
  /** The pages this box would let go of to make room for `count` more: the oldest pages only the box `scope` added or
   *  named that are still cited and not in `keep`, those of `base` (set aside before) first, and `extra` beyond what
   *  the eight and `base` take (the server found the room too small). Nothing is let go of here; null when there are
   *  not that many. */
  const roomPlan = (count: number, keep: ReadonlySet<string>, scope: string, extra = 0, base: ReadonlySet<string> = new Set()): Set<string> | null => {
    const now = cited();
    const free = (entry: { revision: string; scopes: Set<string> }) => entry.scopes.size === 1 && entry.scopes.has(scope)
      && now.includes(entry.revision) && !keep.has(entry.revision);
    const spare = new Set(added.filter(entry => base.has(entry.revision) && free(entry)).map(entry => entry.revision));
    const wanted = Math.max(now.length + count - KNOWLEDGE_CONTEXT_ITEMS, spare.size) + extra;
    for (const entry of added) {
      if (spare.size >= wanted) break;
      if (free(entry)) spare.add(entry.revision);
    }
    return spare.size >= wanted ? spare : null;
  };
  /** Forgets the pages let go of (`spare`, no longer cited once the citations that leave them out are set). */
  const forget = (spare: ReadonlySet<string>) => {
    added = added.filter(entry => !spare.has(entry.revision));
    for (const [key, entry] of read) if (spare.has(entry.revisionId)) read.delete(key);
  };

  // One message's pages at a time across the canvas (the assistant and the nodes' chats): each read measures its room
  // from the citations the one before it left. A message stopped while it waits goes at once; its turn passes untouched.
  let turn: Promise<unknown> = Promise.resolve();
  const reader = (request: Parameters<ReadMessagePages>[0], signal: AbortSignal, step: Parameters<ReadMessagePages>[2]) => {
    // The pages it names that are still cited are this box's too from now on, so no message ahead of it lets go of them.
    if (here()) for (const address of messageLinks(request.text)) share(address, request.scope);
    const mine = turn.then(() => { signal.throwIfAborted(); return readMessage(request, signal, step); });
    turn = mine.catch(() => undefined);
    return abortable(mine, signal);
  };
  return Object.assign(reader, { attach: () => {
    attached = true;
    return () => { attached = false; unwatch?.(); unwatch = null; };
  } });

  async function readMessage({ text, scope, typed }: Parameters<ReadMessagePages>[0], signal: AbortSignal,
    step: Parameters<ReadMessagePages>[2]): Promise<MessagePagesOutcome> {
    const links = messageLinks(text).filter(address => {
      // An AwwO page (a canvas's own address) is not a web page the reader could use.
      try { return new URL(address).origin !== window.location.origin; } catch { return false; }
    });
    if (!links.length) return { pages: [], hold: false };
    if (!here()) throw closed();
    // Whether the server reads them. 'unknown': it did not say (a failed or a late answer), so a message with an address
    // to read is held with why.
    let server: 'reads' | 'off' | 'old' | 'unknown';
    try { server = await abortable(webReader(), signal); } catch (error) { if (signal.aborted) throw error; server = 'unknown'; }
    if (!here()) throw closed();
    if (server === 'old') return { pages: [], hold: false };
    watch();
    const heldHere = held.get(scope);
    const failedBefore = heldHere?.text === text ? heldHere.failed : new Map<string, MessagePage>();
    // The person's addresses: typed or pasted into the box, or a page they read before that is still cited.
    const theirs = typed ? links.filter(address => typed.has(pageKey(address)) || stillCited(address)) : links;
    const others = links.filter(address => !theirs.includes(address));
    const named = theirs.slice(0, MAX_MESSAGE_PAGES);
    const toRead = (address: string) => !stillCited(address) && !failedBefore.has(pageKey(address)) && !oneTimeLink(address);
    // What this message names stays cited while its other pages are read; a page another box added is this box's too
    // from now on, so neither lets go of it while the other's message may still be on its way with it.
    const keep = new Set<string>();
    for (const address of named) {
      const known = stillCited(address);
      if (!known) continue;
      keep.add(known.revisionId);
      share(address, scope);
    }
    const pages: MessagePage[] = [];
    const failed = new Map<string, MessagePage>();
    let done = 0;
    for (const [index, address] of named.entries()) {
      const host = linkHost(address);
      const known = stillCited(address);
      if (known) { pages.push(known.page); continue; }
      const unread = failedBefore.get(pageKey(address));
      if (unread) { pages.push(unread); continue; }
      if (oneTimeLink(address)) {
        pages.push({ url: address, host, error: words(locale(), '这个网址带有令牌或一次性验证参数，为免用掉它或存下它，没有读取。',
          'This address carries a token or a one-time code, so it was not read: reading would spend it or keep it.') });
        continue;
      }
      if (server === 'off') {
        pages.push({ url: address, host, error: words(locale(), '这个工作区的服务器没有开启网页读取。', 'This workspace’s server does not read web pages.') });
        continue;
      }
      if (server === 'unknown') {
        const page = { url: address, host, error: words(locale(), '没能确认服务器能否读取网页。', 'The server did not say whether it reads web pages.') };
        pages.push(page);
        failed.set(pageKey(address), page);
        continue;
      }
      signal.throwIfAborted();
      // The pages still to read, this one included, share the room; counted now, as references may have changed.
      const share = named.slice(index).filter(toRead).length || 1;
      step({ host, index: done + 1, total: done + share });
      const page = await readOne(address, host, share, keep, scope, signal);
      done += 1;
      pages.push(page);
      if (page.error) failed.set(pageKey(address), page);
      else keep.add(read.get(pageKey(address))!.revisionId);
    }
    if (theirs.length > named.length) {
      const rest = theirs.length - named.length;
      pages.push({ url: theirs[named.length], host: linkHost(theirs[named.length]), error: words(locale(),
        `一条消息最多读取 ${MAX_MESSAGE_PAGES} 个网页，从这个网址起的 ${rest} 个没有读取。`,
        `A message reads at most ${MAX_MESSAGE_PAGES} pages: the ${rest} from this address on were not read.`) });
    }
    if (others.length) {
      pages.push({ url: others[0], host: linkHost(others[0]), error: others.length === 1
        ? words(locale(), '这个网址不是你在这里输入或粘贴的（可能由画布写入，或页面重新打开过），没有读取；要读取，请重新粘贴它。',
          'This address was not typed or pasted here (the canvas may have written it, or the page was reopened), so it was not read. Paste it again to read it.')
        : words(locale(), `这个网址和另外 ${others.length - 1} 个不是你在这里输入或粘贴的（可能由画布写入，或页面重新打开过），没有读取；要读取，请重新粘贴它们。`,
          `This address and ${others.length - 1} more were not typed or pasted here (the canvas may have written them, or the page was reopened), so they were not read. Paste them again to read them.`) });
    }
    // Settled only now: a read that was stopped leaves the box's held message as it was.
    if (failed.size) held.set(scope, { text, failed }); else held.delete(scope);
    return { pages: pages.map(page => ({ ...page, host: clip(page.host, 300), ...(page.title ? { title: clip(page.title, 300) } : {}),
      ...(page.error ? { error: clip(page.error, 600) } : {}) })), hold: failed.size > 0 };
  }

  async function readOne(address: string, host: string, share: number, keep: ReadonlySet<string>, scope: string,
    signal: AbortSignal): Promise<MessagePage> {
    const refusal = (error: string): MessagePage => ({ url: address, host, error });
    const full = () => refusal(words(locale(), `这次任务已引用 ${cited().length} 份知识，放不下更多网页；可以先清除画布栏里的引用。`,
      `The task already cites ${cited().length} knowledge items, with no room for another page. Clear the references in the canvas bar first.`));
    // A task cites at most eight revisions. The box's earlier pages that make room stay cited until this page is cited in
    // their place, in one change of the citations: a page refused (by robots.txt, its size, the server) lets go of none.
    let revision = '';
    let page: MessagePage | null = null;
    let extra = 0;
    let aside: ReadonlySet<string> = new Set();
    while (!page) {
      // Room for this page and the ones after it, as the server is to measure it.
      const spare = roomPlan(share, keep, scope, extra);
      if (!spare) return full();
      if (!here()) throw closed();
      aside = spare;
      const revisionIds = cited().filter(id => !spare.has(id));
      try {
        // The page as the browser reads the address (pageKey): a spelling of it written elsewhere in the message
        // (dot segments, another case) carries nothing the person's own address does not name.
        const document = await importKnowledgeFromWeb(tenantId, { url: pageKey(address), operationId: `knowledge-${crypto.randomUUID()}`,
          fit: { revisionIds, share } }, signal);
        revision = document.currentRevisionId;
        page = { url: pageKey(address), host, title: document.title, ...(document.provenance.truncated === true ? { truncated: true } : {}) };
      } catch (error) {
        // Stopped, or the reader opened another canvas meanwhile: nothing more is read or cited.
        if (signal.aborted || !here()) throw error;
        // No room beside what is cited, refused before the page was read (nothing counted): ask again with one more
        // earlier page set aside. A page refused after its read (web_page_no_room) is not read again.
        if (error instanceof SaaSApiError && error.code === 'knowledge_context_limit' && roomPlan(share, keep, scope, extra + 1)) { extra += 1; continue; }
        return refusal(saasErrorMessage(error, locale()));
      }
    }
    const kept = new Set([...keep, revision]);
    // The page was cut for the room the pages set aside leave: they make way for it, and more if the server says so.
    extra = 0;
    for (;;) {
      // An answer that comes after a stop, or after the reader opened another canvas, is not cited.
      signal.throwIfAborted();
      if (!here()) throw closed();
      if (cited().includes(revision)) {
        // Cited already: the reader's own (before or meanwhile), never let go of, or a page another address read before,
        // this box's too from now on.
        read.set(pageKey(address), { revisionId: revision, page });
        added.find(entry => entry.revision === revision)?.scopes.add(scope);
        return page;
      }
      const spare = roomPlan(1, kept, scope, extra, aside);
      if (!spare) return full();
      // The task's whole quoted knowledge, measured by the server as a run will: the same text saved before, or
      // references added while the page was read, can leave less room than the page was cut for.
      const before = cited().filter(id => !spare.has(id));
      try {
        await readKnowledgeRevisionContext(tenantId, [...before, revision], signal);
      } catch (error) {
        if (signal.aborted || !here()) throw error;
        if (error instanceof SaaSApiError && error.code === 'knowledge_context_limit' && roomPlan(1, kept, scope, extra + 1, aside)) { extra += 1; continue; }
        return refusal(saasErrorMessage(error, locale()));
      }
      signal.throwIfAborted();
      if (!here()) throw closed();
      // References changed while the server measured, or a page set aside is no longer this box's alone: measured
      // again as they are now.
      const now = roomPlan(1, kept, scope, extra, aside);
      if (!now || !sameRevisions(cited().filter(id => !now.has(id)), before)) continue;
      cite([...before, revision]);
      forget(now);
      added.push({ revision, scopes: new Set([scope]) });
      read.set(pageKey(address), { revisionId: revision, page });
      return page;
    }
  }
}
