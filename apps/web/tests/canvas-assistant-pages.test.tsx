// The web pages a message names (canvas/messagePages.ts), on the canvas: the canvas assistant reads them before the
// server routes the message and shows them under the turn; a page that was not read keeps the message in the box with
// why, and the same message sent again goes without it; stop reaches a read; the home's request reads its pages before
// it is planned; a node's chat reads them before its run starts. The host's reader is a fake here (the hosted one is
// tests/saas-message-page-reader.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface, type InitialPlanRequest } from '../src/canvas/CanvasSurface';
import { MessagePageList } from '../src/canvas/CanvasAssistant';
import { TileComposer } from '../src/canvas/TileComposer';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import type { AssistantExecutionHost, AssistantRouteDecision, AssistantRouteRequest } from '../src/canvas/assistantRouting';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, saveDocument, type SessionNode } from '../src/canvas/canvasDoc';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import { loadPlanningConversation, savePlanningConversation, type requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { byHand, messageLinks, oneTimeLink, pasteEdit, selectionEdit, typedPages, typeWords, validMessagePages, type MessagePage, type MessagePagesOutcome, type ReadMessagePages, type TypedWords } from '../src/canvas/messagePages';
import { readComposerDraft } from '../src/canvas/composerDrafts';
import { activeNodeThread, createNodeThread, selectNodeThread } from '../src/canvas/nodeThreads';
import { LocaleProvider } from '../src/canvas/i18n';
import { resetAllSessions } from '../src/canvas/sessions';

const plan: CanvasPlan = { version: 1, summary: '已添加一个节点。', operations: [{ type: 'add_node', ref: 'a', templateId: 'general', title: '新节点' }] };
const seedNode = () => saveDocument({ ...emptyDocument(), nodes: [{ ...createAgentTemplate('general', { x: 80, y: 60 }), id: 'node-a', title: '已有节点' }], view: { x: 0, y: 0, scale: 1 } });
const toggle = () => within(document.querySelector('.awwo-canvas-bar') as HTMLElement).queryByRole('button', { name: '画布助手', exact: true });
const sidebar = () => document.querySelector('.awwo-planner-sidebar') as HTMLElement;
const panel = () => within(sidebar());
const box = () => panel().getByRole('textbox', { name: '画布需求' });
const send = (text?: string) => {
  if (text !== undefined) fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(panel().getByRole('button', { name: '发送' }));
};
const ROBOTS = '这个网站的 robots.txt 不允许读取该页面，已遵守其规则。';
// In the box's notice the reason sits in brackets, without its own full stop.
const ROBOTS_IN = ROBOTS.replace(/。$/, '');
const pageA: MessagePage = { url: 'https://a.example/one', host: 'a.example', title: 'Page A' };
const unreadB: MessagePage = { url: 'https://b.example/two', host: 'b.example', error: ROBOTS };

function fakeHost(): AssistantExecutionHost {
  return {
    readOnly: false, ready: true, activate: vi.fn(), setVisible: vi.fn(), stop: vi.fn(async () => {}), finished: () => false,
    start: vi.fn(async () => 'task-1'), renderTask: id => <p>任务卡片 {id}</p>, renderEarlier: () => null, renderNotices: () => null, settings: null,
  };
}
const routeTo = (route: 'plan' | 'execute') => vi.fn(async (_request: AssistantRouteRequest, _signal: AbortSignal): Promise<AssistantRouteDecision> => ({ route }));
/** A reader that answers each call with the next outcome, saying each page it reads. */
function fakeReader(...outcomes: MessagePagesOutcome[]) {
  return vi.fn<ReadMessagePages>(async (_request, _signal, step) => {
    const outcome = outcomes.length > 1 ? outcomes.shift()! : outcomes[0];
    outcome.pages.forEach((page, index) => step({ host: page.host, index: index + 1, total: outcome.pages.length }));
    return outcome;
  });
}

// A node's run reaches the stub, as on the canvas (tests/canvas-composer-focus.test.tsx).
const execute = vi.fn(async (_node: SessionNode) => ({ ok: true, output: 'The answer' }));
vi.mock('../src/canvas/runTransport', () => ({
  createGatewayExecutor: (options: Parameters<typeof import('../src/canvas/runTransport').createGatewayExecutor>[0]) =>
    async (node: SessionNode) => {
      options.onIssueId?.(node.id, `issue-${node.id}`);
      options.onRunAccepted?.(node.id, { issueId: `issue-${node.id}`, runId: `run-${node.id}` });
      return execute(node);
    },
}));

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); execute.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.classList.contains('canvas-root')
      ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
      : originalRect.call(this);
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the web addresses a message names', () => {
  it('are found in the reader’s own words, each page once, without the sentence’s punctuation', () => {
    expect(messageLinks('看看 https://a.example/one，和 (https://b.example/two). 还有 https://en.wikipedia.org/wiki/Foo_(bar)！')).toEqual([
      'https://a.example/one', 'https://b.example/two', 'https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(messageLinks('[文章](https://a.example/one) 和 https://a.example/one#part-2 是同一页；http://c.example/x?y=1&z=2。')).toEqual([
      'https://a.example/one', 'http://c.example/x?y=1&z=2']);
    expect(messageLinks('不是网址：ftp://a.example/x、mailto:me@example.com、example.com')).toEqual([]);
    // An attached file's line is not the reader's words, whatever its name holds.
    expect(messageLinks('总结一下\n\n[附件] https://a.example/one.pdf · awwo-file:abcdefghij')).toEqual([]);
    // Chinese written straight after an address, a curly quote, an ellipsis or a dash ends it.
    expect(messageLinks('帮我总结https://example.com/article的内容')).toEqual(['https://example.com/article']);
    expect(messageLinks('打开https://example.com然后告诉我')).toEqual(['https://example.com']);
    expect(messageLinks('他说“https://example.com/a”里有答案，见https://example.com/b…或者https://example.com/c—都行')).toEqual([
      'https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    expect(messageLinks('한국어https://example.com/k입니다 と日本語https://example.com/jです')).toEqual(['https://example.com/k', 'https://example.com/j']);
  });

  it('keep a decoded address’s own Chinese, Japanese or Korean parts, and end where the sentence goes on', () => {
    expect(messageLinks('看看 https://zh.wikipedia.org/wiki/北京 的历史')).toEqual(['https://zh.wikipedia.org/wiki/北京']);
    expect(messageLinks('https://baike.baidu.com/item/人工智能/9180 讲了什么')).toEqual(['https://baike.baidu.com/item/人工智能/9180']);
    expect(messageLinks('查一下https://www.example.com/search?q=北京天气&lang=中文')).toEqual(['https://www.example.com/search?q=北京天气&lang=中文']);
    expect(messageLinks('https://ja.wikipedia.org/wiki/東京#歴史 を読んで')).toEqual(['https://ja.wikipedia.org/wiki/東京#歴史']);
    // Words written straight after an address are the sentence's, in any of the three scripts.
    expect(messageLinks('总结https://example.com/a的内容')).toEqual(['https://example.com/a']);
    expect(messageLinks('https://example.com/k입니다')).toEqual(['https://example.com/k']);
    expect(messageLinks('看https://example.jp/a、それから')).toEqual(['https://example.jp/a']);
    // A part that holds Chinese already keeps it after Latin letters; quoted or bracketed, the address is all of it.
    expect(messageLinks('去 https://example.com/item/北京A座 看看')).toEqual(['https://example.com/item/北京A座']);
    expect(messageLinks('读「https://zh.wikipedia.org/wiki/C语言」这一页')).toEqual(['https://zh.wikipedia.org/wiki/C语言']);
    expect(messageLinks('读 <https://zh.wikipedia.org/wiki/IPv6地址> 这一页')).toEqual(['https://zh.wikipedia.org/wiki/IPv6地址']);
    // Quoted or bracketed, as written: punctuation inside it is the address's, not the sentence's.
    expect(messageLinks('读 <https://example.org/item_> 这一页')).toEqual(['https://example.org/item_']);
    expect(messageLinks('读「https://example.org/a.」再说')).toEqual(['https://example.org/a.']);
    expect(messageLinks('see https://example.org/item_.')).toEqual(['https://example.org/item']);
    // An apostrophe inside quotes or brackets is the address's; outside, it ends it. Words beside it in the brackets are not.
    expect(messageLinks("读 <https://en.wikipedia.org/wiki/King's_College> 这一页")).toEqual(["https://en.wikipedia.org/wiki/King's_College"]);
    expect(messageLinks('read "https://en.wikipedia.org/wiki/King\'s_College" now')).toEqual(["https://en.wikipedia.org/wiki/King's_College"]);
    expect(messageLinks("see https://en.wikipedia.org/wiki/King's_College")).toEqual(['https://en.wikipedia.org/wiki/King']);
    // Glued to marks an address cannot hold before the closing bracket, which page is meant is unclear: none is read.
    expect(messageLinks('读「https://a.example/x，以及其他」')).toEqual([]);
    expect(messageLinks('(https://example.org/a—b)')).toEqual([]);
    // In angle brackets the address is all of it, as Markdown and mail take it.
    expect(messageLinks('<https://example.org/a—b>')).toEqual(['https://example.org/a—b']);
    // Words after white space in the brackets are not the address's: it is read as an open one.
    expect(messageLinks('读「https://a.example/x 以及其他」')).toEqual(['https://a.example/x']);
    expect(messageLinks("<https://a.example/x'https://b.example/y>")).toEqual(["https://a.example/x'https://b.example/y"]);
    // ASCII brackets too: a Markdown link's destination, brackets inside the address balanced.
    expect(messageLinks("[page](https://en.wikipedia.org/wiki/King's_College)")).toEqual(["https://en.wikipedia.org/wiki/King's_College"]);
    expect(messageLinks("(https://en.wikipedia.org/wiki/King's_(film))")).toEqual(["https://en.wikipedia.org/wiki/King's_(film)"]);
    expect(messageLinks("[https://a.example/it's]")).toEqual(["https://a.example/it's"]);
    expect(messageLinks('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(messageLinks("(https://a.example/it's not) there")).toEqual(['https://a.example/it']);
    // Two Markdown links side by side are two addresses.
    expect(messageLinks('[a](https://a.example/one)[b](https://b.example/two)')).toEqual(['https://a.example/one', 'https://b.example/two']);
    // A Markdown destination ends before its title, as written.
    expect(messageLinks('[a](https://example.org/item_ "title")')).toEqual(['https://example.org/item_']);
    expect(messageLinks('[a](https://example.org/x "t") and https://b.example/y')).toEqual(['https://example.org/x', 'https://b.example/y']);
    // In the host, Chinese after a dot is a label of it (an internationalized domain); after a letter, the sentence's.
    expect(messageLinks('Read https://example.com.中国/')).toEqual(['https://example.com.中国/']);
    expect(messageLinks('看 https://例子.中国/page 吧')).toEqual(['https://例子.中国/page']);
    expect(messageLinks('总结https://example.com的内容')).toEqual(['https://example.com']);
    expect(messageLinks('Read https://example.com．中国/')).toEqual(['https://example.com．中国/']);
    expect(messageLinks('Read https://example.com｡中国/')).toEqual(['https://example.com｡中国/']);
    // Cut inside the host with more of the host after it, an address would read another host: none is read. With only
    // the sentence after the cut, the host is read as written.
    expect(messageLinks('Read https://example.com中国.org/guide')).toEqual([]);
    expect(messageLinks('Read https://example.com—docs.org/guide')).toEqual([]);
    expect(messageLinks('看https://example.com，然后')).toEqual(['https://example.com']);
    expect(messageLinks('see https://example.com.')).toEqual(['https://example.com']);
    expect(messageLinks('see https://example.com. Then https://b.example/x')).toEqual(['https://example.com', 'https://b.example/x']);
    // Nor where the address goes on past the host, or an ideographic full stop separates a Latin label.
    expect(messageLinks('Read https://example.com。cn/guide')).toEqual([]);
    expect(messageLinks('Read https://example.com。cn')).toEqual([]);
    expect(messageLinks('Read https://example.com。ｃｎ')).toEqual([]);
    // User information before another host: an address cut inside it is not read.
    expect(messageLinks('Read https://example.com中国:pass@evil.org/guide')).toEqual([]);
    // Whatever the URL parser takes for more of the host after the cut is so: circled letters, letters glued to the
    // words straight after it, a backslash (a slash to the parser), or a dot where the parser takes no host at all.
    expect(messageLinks('Read https://example.com。ⓒⓝ')).toEqual([]);
    expect(messageLinks('Read https://example.co中m')).toEqual([]);
    expect(messageLinks('Read https://example.com中\\evil.org')).toEqual([]);
    expect(messageLinks('Read https://example.com—\\evil.org')).toEqual([]);
    expect(messageLinks('Read https://example.com，100%.cn')).toEqual([]);
    expect(messageLinks('总结https://example.com的内容。cn')).toEqual([]);
    // The sentence's marks after its words, a full stop before them or a quote, and a closing bracket after a final dot
    // are not.
    expect(messageLinks('总结https://example.com的内容，然后')).toEqual(['https://example.com']);
    expect(messageLinks('总结https://example.com的内容。然后告诉我')).toEqual(['https://example.com']);
    expect(messageLinks('请看https://example.com。“这一页”')).toEqual(['https://example.com']);
    expect(messageLinks('(see https://example.com.)')).toEqual(['https://example.com']);
    // A numeric host is the same only label for label, as the parser writes it out: 1.1。1 names 1.1.0.1, 1.1 is 1.0.0.1.
    expect(messageLinks('Read https://1.1。1')).toEqual([]);
    expect(messageLinks('Read https://1.1。cn')).toEqual([]);
    expect(messageLinks('Read https://8.0。1')).toEqual([]);
    expect(messageLinks('请看https://1.1.1.1。然后')).toEqual(['https://1.1.1.1']);
    expect(messageLinks('Read https://example.com中国/guide')).toEqual([]);
    expect(messageLinks('Read https://example.com中国:8080/guide')).toEqual([]);
    // A full stop before Chinese ends the sentence; another address after the cut is read on its own.
    expect(messageLinks('请看https://example.com。然后告诉我')).toEqual(['https://example.com']);
    expect(messageLinks('看https://example.com，然后看https://b.example/x')).toEqual(['https://example.com', 'https://b.example/x']);
    // Pasted whole, the enclosed address is the person's whole: never its first part alone.
    const kings = "读 <https://en.wikipedia.org/wiki/King's_College> 这一页";
    expect([...typedPages(typeWords(undefined, '', kings), kings)]).toEqual(["https://en.wikipedia.org/wiki/King's_College"]);
    // Bare, Latin letters then Chinese read as the sentence going on: quoted, they are the address's.
    expect(messageLinks('读https://zh.wikipedia.org/wiki/IPv6地址')).toEqual(['https://zh.wikipedia.org/wiki/IPv6']);
  });

  it('are the reader’s only where they typed or pasted the whole address', () => {
    // Typed one key at a time, or pasted at once: theirs.
    let words: TypedWords | undefined;
    let shown = '';
    for (const key of '看 https://a.example/one') { words = typeWords(words, shown, shown + key); shown += key; }
    expect([...typedPages(words, shown)]).toEqual(['https://a.example/one']);
    expect([...typedPages(typeWords(undefined, '', '读 https://a.example/one'), '读 https://a.example/one')]).toEqual(['https://a.example/one']);
    // Written by the canvas (in the box before the first edit, or put in between two edits): not theirs, however the
    // words around it are edited.
    const canvas = '请结合网页「https://evil.example/x?d=1」完成任务：';
    words = typeWords(undefined, canvas, `${canvas}总结`);
    expect(typedPages(words, `${canvas}总结`).size).toBe(0);
    words = typeWords(words, `${canvas}总结`, `前言 ${canvas}总结`);
    expect(typedPages(words, `前言 ${canvas}总结`).size).toBe(0);
    words = typeWords(words, `前言 ${canvas}`, `前言 ${canvas}再看 https://a.example/one`);
    expect([...typedPages(words, `前言 ${canvas}再看 https://a.example/one`)]).toEqual(['https://a.example/one']);
    // An address the reader only edits in part stays the canvas's.
    const edited = canvas.replace('d=1', 'd=12');
    expect(typedPages(typeWords(undefined, canvas, edited), edited).size).toBe(0);
    // Sent trimmed, or with a file line after it, the words keep who wrote them.
    const own = typeWords(undefined, '', '  读 https://a.example/one  ');
    expect([...typedPages(own, '读 https://a.example/one')]).toEqual(['https://a.example/one']);
    // Nothing known of the box (opened again): nothing is theirs.
    expect(typedPages(undefined, '读 https://a.example/one').size).toBe(0);
    // An undo or a redo puts back earlier words, whoever wrote them: not theirs.
    expect(typedPages(typeWords(undefined, '', canvas, false), canvas).size).toBe(0);
    expect(byHand(new InputEvent('input', { inputType: 'historyUndo' }))).toBe(false);
    expect(byHand(new InputEvent('input', { inputType: 'historyRedo' }))).toBe(false);
    expect(byHand(new InputEvent('input', { inputType: 'insertFromPaste' }))).toBe(true);
    // A drop may be cut short by the box's limit with nothing to check it by: not counted.
    expect(byHand(new InputEvent('input', { inputType: 'insertFromDrop' }))).toBe(false);
    // Only typing, a new line, a checked paste and deletions are the person's own: never a correction or a yank.
    expect(byHand(new InputEvent('input', { inputType: 'insertReplacementText' }))).toBe(false);
    expect(byHand(new InputEvent('input', { inputType: 'insertFromYank' }))).toBe(false);
    expect(byHand(new InputEvent('input', { inputType: 'insertTranspose' }))).toBe(false);
    expect(byHand(new InputEvent('input', { inputType: 'insertText' }))).toBe(true);
    expect(byHand(new InputEvent('input', { inputType: 'insertCompositionText' }))).toBe(true);
    expect(byHand(new InputEvent('input', { inputType: 'insertLineBreak' }))).toBe(true);
    expect(byHand(new InputEvent('input', { inputType: 'deleteContentBackward' }))).toBe(true);
    expect(byHand(new Event('change'))).toBe(true);
  });

  it('never lets the canvas’s words borrow the marks of words the reader typed before', () => {
    // Typed and sent; the canvas then writes words that share their start and end (a node titled by a model).
    const sent = 'Change “https://a.example/safeadmin”:';
    const typed = typeWords(undefined, '', sent);
    const written = 'Change “https://a.example/admin”:';
    expect(typedPages(typed, written).size).toBe(0);
    // Nor once the reader types after them.
    expect(typedPages(typeWords(typed, written, `${written} 改一下`), `${written} 改一下`).size).toBe(0);
    // Words the canvas puts after the reader's, past white space, leave theirs as they were; joined straight on, not.
    const own = typeWords(undefined, '', '读 https://a.example/one');
    expect([...typedPages(own, '读 https://a.example/one\n\n请结合网页「X」完成任务：')]).toEqual(['https://a.example/one']);
    expect(typedPages(own, '读 https://a.example/one/x').size).toBe(0);
    // Sent, the words keep their marks only as the box trims them.
    expect(typedPages(typeWords(undefined, '', '读 https://a.example/onex'), '读 https://a.example/one').size).toBe(0);
  });

  it('never lets the words a deletion took lend their marks to the words it left', () => {
    // Typed; then 加入任务 adds the same request with a page's title (the canvas's words); the typed one is deleted.
    const typed = '请结合网页「https://a.example/delete-preview」完成任务：';
    const written = '请结合网页「https://a.example/delete」完成任务：';
    const both = `${typed}\n\n${written}`;
    const own = typeWords(undefined, '', typed);
    const deleting = new InputEvent('input', { inputType: 'deleteContentBackward' });
    // Where the deletion was not known (an event that says none): a character is theirs only if it is wherever the
    // deletion was, so the canvas's address, which begins as theirs did, is not.
    expect(typedPages(typeWords(own, both, written), written).size).toBe(0);
    // Known from the box's selection: the canvas's words are left as they were, and still not theirs.
    const typedGone = selectionEdit({ previous: both, start: 0, end: typed.length + 2, kind: 'deleteContentBackward' }, both, written, deleting);
    expect(typedGone).toEqual({ start: 0, end: typed.length + 2, length: 0, selection: true });
    expect(typedPages(typeWords(own, both, written, true, typedGone), written).size).toBe(0);
    // The canvas's words deleted instead: the typed address stays theirs, known or not.
    const writtenGone = selectionEdit({ previous: both, start: typed.length, end: both.length, kind: 'deleteContentBackward' }, both, typed, deleting);
    expect([...typedPages(typeWords(own, both, typed, true, writtenGone), typed)]).toEqual(['https://a.example/delete-preview']);
    expect([...typedPages(typeWords(own, both, typed), typed)]).toEqual(['https://a.example/delete-preview']);
    // A typo taken out of their own address, or a letter typed twice, leaves it theirs.
    const typo = typeWords(undefined, '', '读 https://a.examplle/one');
    expect([...typedPages(typeWords(typo, '读 https://a.examplle/one', '读 https://a.example/one'), '读 https://a.example/one')]).toEqual(['https://a.example/one']);
    const twice = typeWords(undefined, '', '读 https://a.example/oe');
    expect([...typedPages(typeWords(twice, '读 https://a.example/oe', '读 https://a.example/ooe'), '读 https://a.example/ooe')]).toEqual(['https://a.example/ooe']);
  });

  it('reads an edit from where the box’s selection was as the browser began it', () => {
    const input = (inputType: string) => new InputEvent('input', { inputType });
    const at = (start: number, end: number, kind: string, previous = 'abcdef') => ({ previous, start, end, kind });
    // Typing over a selection, a new line at the caret; a deletion of the selection, or of what the caret's side lost.
    expect(selectionEdit(at(1, 3, 'insertText'), 'abcdef', 'aXdef', input('insertText'))).toEqual({ start: 1, end: 3, length: 1, selection: true });
    expect(selectionEdit(at(2, 2, 'insertLineBreak'), 'abcdef', 'ab\ncdef', input('insertLineBreak'))).toEqual({ start: 2, end: 2, length: 1, selection: true });
    expect(selectionEdit(at(1, 4, 'deleteByCut'), 'abcdef', 'aef', input('deleteByCut'))).toEqual({ start: 1, end: 4, length: 0, selection: true });
    expect(selectionEdit(at(4, 4, 'deleteWordBackward'), 'abcdef', 'aef', input('deleteWordBackward'))).toEqual({ start: 1, end: 4, length: 0, selection: true });
    expect(selectionEdit(at(1, 1, 'deleteContentForward'), 'abcdef', 'acdef', input('deleteContentForward'))).toEqual({ start: 1, end: 2, length: 0, selection: true });
    // None for an input method's composition or a paste, nor from the record of another edit.
    expect(selectionEdit(at(2, 2, 'insertCompositionText'), 'abcdef', 'abXcdef', input('insertCompositionText'))).toBeUndefined();
    expect(selectionEdit(at(2, 2, 'insertFromPaste'), 'abcdef', 'abXcdef', input('insertFromPaste'))).toBeUndefined();
    expect(selectionEdit(at(2, 2, 'insertText'), 'abcdef', 'abXcdef', input('deleteContentBackward'))).toBeUndefined();
    expect(selectionEdit(at(2, 2, 'insertText', 'abcde'), 'abcdef', 'abXcdef', input('insertText'))).toBeUndefined();
    expect(selectionEdit(null, 'abcdef', 'abXcdef', input('insertText'))).toBeUndefined();
    // Typed over the canvas's address key by key, the first key in the selection's place: the new address is all
    // theirs, though it begins as the old one did.
    const canvas = '读「https://evil.example/x」';
    const start = canvas.indexOf('https://');
    const own = 'https://b.example/two';
    let words: TypedWords | undefined;
    let shown = canvas;
    for (let i = 0; i < own.length; i++) {
      const [from, to] = i === 0 ? [start, start + 'https://evil.example/x'.length] : [start + i, start + i];
      const next = shown.slice(0, from) + own[i] + shown.slice(to);
      words = typeWords(words, shown, next, true, selectionEdit(at(from, to, 'insertText', shown), shown, next, input('insertText')));
      shown = next;
    }
    expect([...typedPages(words, shown)]).toEqual([own]);
    // A selection that does not fit the change (an input method's) is set aside: the words alone say where it was.
    const soFar = typeWords(undefined, '', '读 https://a.example/on');
    expect([...typedPages(typeWords(soFar, '读 https://a.example/on', '读 https://a.example/one', true, { start: 0, end: 0, length: 1, selection: true }), '读 https://a.example/one')])
      .toEqual(['https://a.example/one']);
  });

  it('takes a paste over a selection as the reader’s whole, also over the same words', () => {
    const restored = '看看 https://a.example/one';
    // Pasted over the restored address: all of the new one, though it starts as the old one did.
    const pasted = '看看 https://b.example/two';
    const edit = { start: 3, end: restored.length, length: 'https://b.example/two'.length };
    expect([...typedPages(typeWords(undefined, restored, pasted, true, edit), pasted)]).toEqual(['https://b.example/two']);
    // The same address pasted over itself.
    expect([...typedPages(typeWords(undefined, restored, restored, true, { start: 3, end: restored.length, length: restored.length - 3 }), restored)])
      .toEqual(['https://a.example/one']);
    // An edit that does not fit the two texts is not taken: the change found by comparing them is.
    expect(typedPages(typeWords(undefined, restored, pasted, true, { start: 0, end: 1, length: 1 }), pasted).size).toBe(0);
    // Nor one whose text is not what the box holds there.
    expect(typedPages(typeWords(undefined, restored, pasted, true, { ...edit, text: 'https://c.example/abc' }), pasted).size).toBe(0);
    // A paste the box cut short (its limit) counts for nothing: what it kept names another page.
    const clipped = 'https://example.org/p';
    expect(typedPages(typeWords(undefined, '', clipped, true, { start: 0, end: 0, length: 26, text: 'https://example.org/private' }), clipped).size).toBe(0);
    // A paste's edit comes from the paste event: none where the paste put no words in (cancelled for a file).
    const area = document.createElement('textarea');
    area.value = restored;
    area.setSelectionRange(3, restored.length);
    const clipboard = { getData: () => 'https://b.example/two' } as unknown as DataTransfer;
    expect(pasteEdit(area, { clipboardData: clipboard, defaultPrevented: false })).toEqual({ start: 3, end: restored.length, length: 21, text: 'https://b.example/two' });
    expect(pasteEdit(area, { clipboardData: clipboard, defaultPrevented: true })).toBeUndefined();
  });

  it('are told apart when they carry a credential or a one-time code', () => {
    for (const address of ['https://a.example/reset?token=abc', 'https://a.example/cb?code=1', 'https://a.example/f?X-Amz-Signature=9',
      'https://user:pass@a.example/', 'https://a.example/m?Magic=1']) expect(oneTimeLink(address)).toBe(true);
    for (const address of ['https://a.example/search?q=web', 'https://a.example/list?page=2&sort=new', 'https://a.example/code/main.go']) expect(oneTimeLink(address)).toBe(false);
  });

  it('are kept with the turn only in their own shape', () => {
    expect(validMessagePages([pageA, unreadB, { url: 'https://c.example', host: 'c.example', title: 'C', truncated: true }])).toBe(true);
    expect(validMessagePages([{ url: 'https://c.example' }])).toBe(false);
    expect(validMessagePages([{ ...pageA, truncated: 'yes' }])).toBe(false);
    // Only a web page's address is ever kept: no other scheme can become a link.
    expect(validMessagePages([{ ...pageA, url: 'javascript:alert(1)' }])).toBe(false);
    expect(validMessagePages([{ ...pageA, url: 'data:text/html,<p>x</p>' }])).toBe(false);
    // A page's address as read is percent-encoded and may run longer than the one written, up to what the server reads.
    const longest = `https://a.example/${'a'.repeat(2048 - 'https://a.example/'.length)}`;
    expect(validMessagePages([{ ...pageA, url: longest }])).toBe(true);
    expect(validMessagePages([{ ...pageA, url: `${longest}a` }])).toBe(false);
    savePlanningConversation({ draft: '', messages: [
      { id: 'turn-1-user', role: 'user', content: '总结 https://a.example/one', pages: [pageA] },
      { id: 'turn-2-user', role: 'user', content: 'x', pages: 'broken' as unknown as MessagePage[] }] });
    expect(loadPlanningConversation().messages.map(message => message.id)).toEqual(['turn-1-user']);
  });

  it('are listed under the message: a page read opens in a new tab, one cut says so, one not read says why', () => {
    render(<LocaleProvider locale="zh"><MessagePageList pages={[pageA, { ...pageA, url: 'https://c.example/long', host: 'c.example', title: 'Long', truncated: true }, unreadB]} /></LocaleProvider>);
    const list = screen.getByRole('list', { name: '这条消息里的网页' });
    const link = within(list).getByRole('link', { name: 'Page A' });
    expect(link).toHaveAttribute('href', 'https://a.example/one');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(list).getByText('正文较长，已截取到任务放得下的长度')).toBeVisible();
    expect(within(list).getByText(`未读取：${ROBOTS}`)).toBeVisible();
    expect(within(list).queryByRole('link', { name: 'b.example' })).toBeNull();
  });

  it('never draws an address that is not a web page’s as a link', () => {
    render(<LocaleProvider locale="zh"><MessagePageList pages={[{ url: 'javascript:alert(1)', host: 'x', title: 'Looks like a page' }]} /></LocaleProvider>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Looks like a page')).toBeVisible();
  });
});

describe('the canvas assistant reading the pages a message names', () => {
  it('reads them before the server routes the message, and lists them under the turn', async () => {
    seedNode();
    const host = fakeHost();
    const router = routeTo('execute');
    const reader = fakeReader({ hold: false, pages: [pageA] });
    render(<CanvasSurface assistantExecution={host} routeAssistant={router} readMessagePages={reader} planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} />);
    fireEvent.click(toggle()!);
    send('总结 https://a.example/one');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    expect(reader).toHaveBeenCalledExactlyOnceWith({ text: '总结 https://a.example/one', scope: 'assistant', typed: new Set(['https://a.example/one']) },
      expect.any(AbortSignal), expect.any(Function));
    expect(reader.mock.invocationCallOrder[0]).toBeLessThan(router.mock.invocationCallOrder[0]);
    expect(panel().getByRole('link', { name: 'Page A' })).toHaveAttribute('href', 'https://a.example/one');
    await waitFor(() => expect(loadPlanningConversation().messages[0]).toMatchObject({ role: 'user', content: '总结 https://a.example/one', route: 'execute', pages: [pageA] }));
  });

  it('lists them under a planned turn too', async () => {
    seedNode();
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('plan')} readMessagePages={fakeReader({ hold: false, pages: [pageA] })} planRequest={planRequest} />);
    fireEvent.click(toggle()!);
    send('参考 https://a.example/one 加一个节点');
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    await waitFor(() => expect(loadPlanningConversation().messages[0]).toMatchObject({ route: 'plan', pages: [pageA] }));
  });

  it('says which page it is reading, and stop keeps the message in the box', async () => {
    seedNode();
    const router = routeTo('execute');
    let stopped = false;
    const reader = vi.fn<ReadMessagePages>((_request, signal, step) => new Promise((_resolve, reject) => {
      step({ host: 'a.example', index: 1, total: 2 });
      signal.addEventListener('abort', () => { stopped = true; reject(new Error('stopped')); });
    }));
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    send('比较 https://a.example/one 和 https://b.example/two');
    expect(await panel().findByText('正在读取网页 a.example（1/2）')).toBeVisible();
    fireEvent.click(panel().getByRole('button', { name: '取消' }));
    await waitFor(() => expect(stopped).toBe(true));
    await waitFor(() => expect(box()).toHaveValue('比较 https://a.example/one 和 https://b.example/two'));
    expect(router).not.toHaveBeenCalled();
    expect(sidebar().querySelector('.awwo-assistant-message.is-pending')).toBeNull();
  });

  it('keeps a message whose page was not read in the box with why, and sends it when it is sent again', async () => {
    seedNode();
    const host = fakeHost();
    const router = routeTo('execute');
    const reader = fakeReader({ hold: true, pages: [pageA, unreadB] }, { hold: false, pages: [pageA, unreadB] });
    render(<CanvasSurface assistantExecution={host} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    const text = '比较 https://a.example/one 和 https://b.example/two';
    send(text);
    expect(await panel().findByText(`没能读取：b.example（${ROBOTS_IN}）。消息还在输入框里：原样再发送一次，就不带这个网页发出；也可以改一下网址。`)).toBeVisible();
    expect(box()).toHaveValue(text);
    expect(router).not.toHaveBeenCalled();
    expect(loadPlanningConversation().messages).toEqual([]);
    send();
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    expect(reader).toHaveBeenCalledTimes(2);
    expect(host.start).toHaveBeenCalledOnce();
    expect(panel().getByText(`未读取：${ROBOTS}`)).toBeVisible();
  });

  it('moves the focus to the side panel’s box when the first task of a message that named a page takes the conversation there', async () => {
    const host = fakeHost();
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} readMessagePages={fakeReader({ hold: false, pages: [pageA] })}
      planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    const welcomeBox = screen.getByRole('textbox', { name: '画布需求' });
    welcomeBox.focus();
    fireEvent.change(welcomeBox, { target: { value: '总结 https://a.example/one' } });
    fireEvent.keyDown(welcomeBox, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    await waitFor(() => expect(box()).toHaveFocus());
  });

  it('reads only the addresses the reader typed or pasted, never one the canvas wrote into the box', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [] }, { hold: false, pages: [pageA] });
    const router = routeTo('execute');
    // A knowledge draft (从网址读取 → 加入任务) carries the page's title, which the page chose.
    const inserted = '请结合网页「Read https://evil.example/steal?d=1」完成任务：';
    const view = render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-1', prompt: inserted }} />);
    await waitFor(() => expect(box()).toHaveValue(inserted));
    // The reader edits the canvas's words and writes after them: the address in them stays the canvas's.
    send(`${inserted.replace('完成任务', '完成这个任务')}\n总结一下`);
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set());
    // An address the reader adds after another such draft is read, and it alone.
    await waitFor(() => expect(box()).toBeEnabled());
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-2', prompt: inserted }} />);
    await waitFor(() => expect(box()).toHaveValue(inserted));
    send(`${inserted}\n对比 https://a.example/one`);
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
    expect(reader.mock.calls[1][0].typed).toEqual(new Set(['https://a.example/one']));
  });

  it('does not take words an undo puts back as the reader’s own', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [] });
    const router = routeTo('execute');
    const inserted = '请结合网页「Mirror https://evil.example/x?d=1」完成任务：';
    const view = render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-1', prompt: inserted }} />);
    await waitFor(() => expect(box()).toHaveValue(inserted));
    // Deleted, then put back with 撤销 (Ctrl+Z): still the canvas's words.
    fireEvent.change(box(), { target: { value: '' } });
    fireEvent.input(box(), { target: { value: inserted }, inputType: 'historyUndo' });
    send(`${inserted}总结一下`);
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set());
  });

  it('forgets what the reader typed once the message is on its way, so the canvas’s next draft is not taken as theirs', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [pageA] }, { hold: false, pages: [] });
    const router = routeTo('execute');
    const view = render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    send('总结 https://a.example/one');
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    await waitFor(() => expect(box()).toHaveValue(''));
    // The canvas puts the same words in the box: the canvas's now, not the reader's.
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-1', prompt: '总结 https://a.example/one' }} />);
    await waitFor(() => expect(box()).toHaveValue('总结 https://a.example/one'));
    await waitFor(() => expect(box()).toBeEnabled());
    send();
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
    expect(reader.mock.calls[1][0].typed).toEqual(new Set());
  });

  it('reads an address the reader pastes over one the canvas wrote', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [] });
    const router = routeTo('execute');
    const inserted = '请结合网页「Read https://evil.example/x」完成任务：';
    const view = render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-1', prompt: inserted }} />);
    await waitFor(() => expect(box()).toHaveValue(inserted));
    const at = inserted.indexOf('https://');
    const old = 'https://evil.example/x';
    const replaced = inserted.replace(old, 'https://example.org/page');
    (box() as HTMLTextAreaElement).setSelectionRange(at, at + old.length);
    fireEvent.paste(box(), { clipboardData: { getData: () => 'https://example.org/page', files: [], items: [], types: ['text/plain'] } });
    fireEvent.input(box(), { target: { value: replaced }, inputType: 'insertFromPaste' });
    send();
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set(['https://example.org/page']));
  });

  it('reads an address typed over the canvas’s, where the box’s selection says each key went', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [] });
    const router = routeTo('execute');
    const inserted = '请结合网页「Read https://evil.example/x」完成任务：';
    const view = render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-1', prompt: inserted }} />);
    await waitFor(() => expect(box()).toHaveValue(inserted));
    // The canvas's address selected and typed over key by key: the first key takes the selection's place, so the new
    // address is the reader's, though it begins as the old one did.
    const area = box() as HTMLTextAreaElement;
    const at = inserted.indexOf('https://');
    const old = 'https://evil.example/x';
    const own = 'https://example.org/page';
    for (let i = 0; i < own.length; i++) {
      const shown = area.value;
      const [from, to] = i === 0 ? [at, at + old.length] : [at + i, at + i];
      area.setSelectionRange(from, to);
      fireEvent(area, new InputEvent('beforeinput', { inputType: 'insertText', data: own[i], bubbles: true, cancelable: true }));
      fireEvent.input(area, { target: { value: shown.slice(0, from) + own[i] + shown.slice(to) }, inputType: 'insertText', data: own[i] });
    }
    expect(box()).toHaveValue(inserted.replace(old, own));
    send();
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set([own]));
  });

  it('takes no change that leaves the box at its limit as the reader’s, as the browser may have cut it to fit', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [] });
    const router = routeTo('execute');
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    const typed = `${'x'.repeat(7979)} `;
    fireEvent.change(box(), { target: { value: typed } });
    // An input method's composition of https://example.org/private, which the browser lets run past the box's limit
    // and cuts to it once committed: the address left names another page, and it is not the reader's.
    fireEvent.input(box(), { target: { value: `${typed}https://example.org/` }, inputType: 'insertCompositionText', data: 'https://example.org/private' });
    send();
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set());
  });

  it('takes nothing from a paste that put no words in (a file, attached instead)', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [] });
    const router = routeTo('execute');
    const inserted = '请结合网页「Read https://evil.example/1」完成任务：';
    const view = render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-1', prompt: inserted }} />);
    await waitFor(() => expect(box()).toHaveValue(inserted));
    const at = inserted.indexOf('https://');
    (box() as HTMLTextAreaElement).setSelectionRange(at, at + 'https://evil.example/1'.length);
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(box(), { clipboardData: { getData: () => 'https://safe.example/2', files: [file], items: [], types: ['Files', 'text/plain'] } });
    // Then one character of the canvas's address is changed by hand: the address is still not the reader's.
    const changed = inserted.replace('https://evil.example/1', 'https://evil.example/3');
    fireEvent.input(box(), { target: { value: changed }, inputType: 'insertText', data: '3' });
    send();
    await waitFor(() => expect(router).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set());
  });

  it('keeps the message in the box and says so when its pages could not be read at all', async () => {
    seedNode();
    const router = routeTo('execute');
    const reader = vi.fn<ReadMessagePages>(async () => { throw new Error('reader broke'); });
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    send('总结 https://a.example/one');
    expect(await panel().findByText('没能读取这条消息里的网页，消息还在输入框里，可以再发送一次。')).toBeVisible();
    expect(box()).toHaveValue('总结 https://a.example/one');
    expect(router).not.toHaveBeenCalled();
  });

  it('gives a message without an address straight to the router', async () => {
    seedNode();
    const reader = fakeReader({ hold: false, pages: [] });
    const router = routeTo('execute');
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(toggle()!);
    send('写一封邮件');
    await waitFor(() => expect(panel().getByText('任务卡片 task-1')).toBeVisible());
    expect(reader).not.toHaveBeenCalled();
    await waitFor(() => expect(loadPlanningConversation().messages[0]?.role).toBe('user'));
    expect(loadPlanningConversation().messages[0].pages).toBeUndefined();
  });

  it('reads no address of a home request from the old box’s draft as the reader’s, and still plans it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) } : { ok: false, status: 503, json: async () => ({}) }));
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const reader = fakeReader({ hold: false, pages: [] });
    const carried: InitialPlanRequest = { prompt: '总结 https://a.example/one', start: true, interrupted: false, claim: () => true, done: vi.fn(), untrusted: true };
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('plan')} readMessagePages={reader} planRequest={planRequest} initialPlan={carried} />);
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(reader).toHaveBeenCalledExactlyOnceWith({ text: carried.prompt, scope: 'assistant', typed: new Set() }, expect.any(AbortSignal), expect.any(Function));
  });

  it('reads the pages the home’s request names before it is planned', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) } : { ok: false, status: 503, json: async () => ({}) }));
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const reader = fakeReader({ hold: false, pages: [pageA] });
    const done = vi.fn();
    const carried: InitialPlanRequest = { prompt: '照着 https://a.example/one 做一个落地页', start: true, interrupted: false, claim: () => true, done };
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('plan')} readMessagePages={reader} planRequest={planRequest} initialPlan={carried} />);
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    expect(reader).toHaveBeenCalledExactlyOnceWith({ text: carried.prompt, scope: 'assistant' }, expect.any(AbortSignal), expect.any(Function));
    expect(reader.mock.invocationCallOrder[0]).toBeLessThan(planRequest.mock.invocationCallOrder[0]);
    await waitFor(() => expect(done).toHaveBeenCalled());
    await waitFor(() => expect(loadPlanningConversation().messages[0]).toMatchObject({ content: carried.prompt, pages: [pageA] }));
  });

  it('leaves the home’s request in the box with why when its page was not read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) } : { ok: false, status: 503, json: async () => ({}) }));
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    const done = vi.fn();
    const carried: InitialPlanRequest = { prompt: '照着 https://b.example/two 做一个落地页', start: true, interrupted: false, claim: () => true, done };
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('plan')} readMessagePages={fakeReader({ hold: true, pages: [unreadB] })}
      planRequest={planRequest} initialPlan={carried} />);
    expect(await screen.findByText(`没能读取：b.example（${ROBOTS_IN}）。消息还在输入框里：原样再发送一次，就不带这个网页发出；也可以改一下网址。`)).toBeVisible();
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue(carried.prompt);
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('leaves the home’s request to the reader once they send it from the box', async () => {
    let plannerKnown!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: unknown) => String(input).endsWith('/canvas/planner')
      ? new Promise(resolve => { plannerKnown = () => resolve({ ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) }); })
      : Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
    const host = fakeHost();
    const reader = fakeReader({ hold: false, pages: [pageA] });
    const done = vi.fn();
    const carried: InitialPlanRequest = { prompt: '照着 https://a.example/one 做一个落地页', start: true, interrupted: false, claim: () => true, done };
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan);
    render(<CanvasSurface assistantExecution={host} routeAssistant={routeTo('execute')} readMessagePages={reader} planRequest={planRequest} initialPlan={carried} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue(carried.prompt));
    // The hand-over waits for the planner's status; the reader sends the request meanwhile.
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(host.start).toHaveBeenCalledOnce());
    expect(done).toHaveBeenCalled();
    plannerKnown();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(reader).toHaveBeenCalledOnce();
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('counts the home’s request as the reader’s own words when a reload put it back in the box', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) } : { ok: false, status: 503, json: async () => ({}) }));
    const prompt = '照着 https://b.example/two 做一个落地页';
    savePlanningConversation({ draft: prompt, messages: [] });
    const reader = fakeReader({ hold: false, pages: [unreadB] });
    const done = vi.fn();
    // The page was closed while the request was handled: the next page says so and leaves it in the box.
    const carried: InitialPlanRequest = { prompt, start: false, interrupted: true, claim: () => true, done };
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('execute')} readMessagePages={reader} initialPlan={carried} />);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue(prompt);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(reader).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set(['https://b.example/two']));
  });

  it('counts no address of a home request from the old box’s draft as the reader’s when a reload put it back in the box', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) } : { ok: false, status: 503, json: async () => ({}) }));
    const prompt = '照着 https://b.example/two 做一个落地页';
    savePlanningConversation({ draft: prompt, messages: [] });
    const reader = fakeReader({ hold: false, pages: [] });
    const done = vi.fn();
    const carried: InitialPlanRequest = { prompt, start: false, interrupted: true, claim: () => true, done, untrusted: true };
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('execute')} readMessagePages={reader} initialPlan={carried} />);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: '画布需求' })).toHaveValue(prompt);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(reader).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set());
  });

  it('counts the home’s request as the reader’s own words when a reload put it back beside nodes made meanwhile', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) } : { ok: false, status: 503, json: async () => ({}) }));
    seedNode();
    const prompt = '照着 https://b.example/two 做一个落地页';
    savePlanningConversation({ draft: prompt, messages: [] });
    const reader = fakeReader({ hold: false, pages: [unreadB] });
    const done = vi.fn();
    const carried: InitialPlanRequest = { prompt, start: true, interrupted: false, claim: () => true, done };
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('execute')} readMessagePages={reader} initialPlan={carried} />);
    // Nodes are on the canvas: the hand-over plans nothing and leaves the request in the box, the reader's.
    await waitFor(() => expect(done).toHaveBeenCalled());
    fireEvent.click(toggle()!);
    await waitFor(() => expect(box()).toHaveValue(prompt));
    send();
    await waitFor(() => expect(reader).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set(['https://b.example/two']));
  });

  it('counts the home’s request as the reader’s own words once it waits in the box', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/canvas/planner')
      ? { ok: true, status: 200, json: async () => ({ available: true, provider: 'AI' }) } : { ok: false, status: 503, json: async () => ({}) }));
    const reader = fakeReader({ hold: true, pages: [unreadB] });
    const done = vi.fn();
    const carried: InitialPlanRequest = { prompt: '照着 https://b.example/two 做一个落地页', start: true, interrupted: false, claim: () => true, done };
    render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={routeTo('plan')} readMessagePages={reader}
      planRequest={vi.fn<typeof requestCanvasPlan>().mockResolvedValue(plan)} initialPlan={carried} />);
    await waitFor(() => expect(done).toHaveBeenCalled());
    // Sent again from the box, its address is still the reader's.
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
    expect(reader.mock.calls[1][0].typed).toEqual(new Set(['https://b.example/two']));
  });
});

describe('a node’s chat reading the pages a message names', () => {
  beforeEach(() => {
    const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'manual', title: 'Manual', runtime: 'pi',
      binding: { companyId: 'company', agentId: 'agent-manual', agentName: 'Manual' } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node] }));
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => new Response(JSON.stringify(
      String(input).endsWith('/settle') && init?.method === 'POST'
        ? { confirmed: true, status: 'succeeded', holdId: `hold-${JSON.parse(String(init.body)).runId}` }
        : String(input).endsWith('/companies') ? [{ id: 'company', name: 'Test workspace' }] : {},
    ), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });
  const nodeBox = () => screen.getByTestId('composer-input');
  const nodeSend = (text?: string) => {
    if (text !== undefined) fireEvent.change(nodeBox(), { target: { value: text } });
    fireEvent.click(screen.getByTestId('composer-send'));
  };

  it('reads them before the node’s run starts', async () => {
    const reader = fakeReader({ hold: false, pages: [pageA] });
    render(<CanvasSurface readMessagePages={reader} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    nodeSend('总结 https://a.example/one');
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(reader).toHaveBeenCalledExactlyOnceWith({ text: '总结 https://a.example/one', scope: 'node:manual', typed: new Set(['https://a.example/one']) },
      expect.any(AbortSignal), expect.any(Function));
  });

  it('says under the box which pages went unread with a message it sends', async () => {
    const oneTime: MessagePage = { url: 'https://login.example/magic?token=abc', host: 'login.example', error: '这个网址带有令牌或一次性验证参数，为免用掉它或存下它，没有读取。' };
    render(<CanvasSurface readMessagePages={fakeReader({ hold: false, pages: [pageA, oneTime] })} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    nodeSend('看看 https://a.example/one 和 https://login.example/magic?token=abc');
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(screen.getByText('未读取：login.example（这个网址带有令牌或一次性验证参数，为免用掉它或存下它，没有读取）')).toBeVisible();
  });

  it('sends nothing when the node’s conversation changed while its pages were read', async () => {
    const first: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'manual', title: 'Manual', runtime: 'pi',
      binding: { companyId: 'company', agentId: 'agent-manual', agentName: 'Manual' } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [selectNodeThread(createNodeThread(first), 'default')] }));
    let answer!: (outcome: MessagePagesOutcome) => void;
    const reader = vi.fn<ReadMessagePages>(() => new Promise(resolve => { answer = resolve; }));
    render(<CanvasSurface readMessagePages={reader} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    nodeSend('总结 https://a.example/one');
    await waitFor(() => expect(reader).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '打开 对话 2', exact: true }));
    answer({ hold: false, pages: [pageA] });
    expect(await screen.findByRole('alert')).toHaveTextContent('读取网页期间这个节点换了对话或智能体，消息没有发送，还留在它的输入框里。');
    expect(execute).not.toHaveBeenCalled();
    expect(readComposerDraft('manual', 'default')).toBe('总结 https://a.example/one');
  });

  it('stops a node’s page read when the surface goes, so it cites nothing and reads no later address', async () => {
    let signal!: AbortSignal;
    const reader = vi.fn<ReadMessagePages>((_request, given) => { signal = given; return new Promise(() => {}); });
    const view = render(<CanvasSurface readMessagePages={reader} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    nodeSend('总结 https://a.example/one 和 https://b.example/two');
    await waitFor(() => expect(reader).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(false);
    // A draft's recovery takes the surface's place while the canvas stays open.
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never reads an image node’s prompt for pages: such a node takes no knowledge', async () => {
    const image: SessionNode = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'picture', title: 'Picture',
      binding: { companyId: 'company', agentId: 'agent-picture', agentName: 'Picture' } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [image] }));
    const reader = fakeReader({ hold: false, pages: [pageA] });
    render(<CanvasSurface readMessagePages={reader} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Picture', exact: true }));
    nodeSend('照着 https://a.example/one 画一张海报');
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(reader).not.toHaveBeenCalled();
  });

  it('lets no marks of a message the canvas answered itself pass to words it writes in the box later', async () => {
    const reader = fakeReader({ hold: false, pages: [] });
    const router = routeTo('execute');
    // The node's run fails, so a message about that failure is answered by the canvas itself (a local repair).
    execute.mockResolvedValueOnce({ ok: false, output: '', detail: 'boom' } as never);
    const view = render(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    nodeSend('hello');
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    fireEvent.click(toggle()!);
    await waitFor(() => expect(box()).toBeEnabled());
    send('it failed https://a.example/x');
    await waitFor(() => expect(box()).toHaveValue(''));
    expect(reader).not.toHaveBeenCalled();
    // The canvas then writes words that end as the typed ones did: the address in them is not the reader's.
    view.rerender(<CanvasSurface assistantExecution={fakeHost()} routeAssistant={router} readMessagePages={reader} taskDraft={{ id: 'draft-1', prompt: 'Change https://a.example/x' }} />);
    await waitFor(() => expect(box()).toHaveValue('Change https://a.example/x'));
    send();
    await waitFor(() => expect(reader).toHaveBeenCalledOnce());
    expect(reader.mock.calls[0][0].typed).toEqual(new Set());
  });

  it('keeps a message whose page was not read in the box with why, and runs it when it is sent again', async () => {
    const reader = fakeReader({ hold: true, pages: [unreadB] }, { hold: false, pages: [unreadB] });
    render(<CanvasSurface readMessagePages={reader} />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    nodeSend('总结 https://b.example/two');
    expect(await screen.findByRole('alert')).toHaveTextContent(`没能读取：b.example（${ROBOTS_IN}）`);
    expect(nodeBox()).toHaveValue('总结 https://b.example/two');
    expect(execute).not.toHaveBeenCalled();
    nodeSend();
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
  });
});

describe('the node composer’s line for a message', () => {
  it('says what is being read, waiting meanwhile, or why the box kept the message, which it sends again', () => {
    const sent = vi.fn();
    const view = render(<TileComposer streaming={false} onSend={sent} status={{ text: '正在读取网页 a.example（1/1）', tone: 'reading' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取网页 a.example（1/1）');
    // Nothing is typed into a box whose message waits for its pages, nor sent from it.
    expect(screen.getByTestId('composer-input')).toBeDisabled();
    view.rerender(<TileComposer streaming={false} onSend={sent} status={{ text: '没能读取：b.example', tone: 'held' }} />);
    expect(screen.getByTestId('composer-input')).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('没能读取：b.example');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'again' } });
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(sent).toHaveBeenCalledWith('again');
  });

  it('tells the canvas where a key or a deletion went, from the box’s selection as the browser began it', () => {
    const typed = vi.fn();
    render(<TileComposer streaming={false} onSend={vi.fn()} onTyped={typed} />);
    const area = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'abcdef' } });
    area.setSelectionRange(1, 3);
    fireEvent(area, new InputEvent('beforeinput', { inputType: 'insertText', data: 'X', bubbles: true, cancelable: true }));
    fireEvent.input(area, { target: { value: 'aXdef' }, inputType: 'insertText', data: 'X' });
    expect(typed).toHaveBeenLastCalledWith('abcdef', 'aXdef', true, { start: 1, end: 3, length: 1, selection: true });
    area.setSelectionRange(2, 2);
    fireEvent(area, new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    fireEvent.input(area, { target: { value: 'adef' }, inputType: 'deleteContentBackward' });
    expect(typed).toHaveBeenLastCalledWith('aXdef', 'adef', true, { start: 1, end: 2, length: 0, selection: true });
    // An edit whose beginning the box did not see says nothing of where it was.
    fireEvent.change(area, { target: { value: 'adefg' } });
    expect(typed).toHaveBeenLastCalledWith('adef', 'adefg', true, undefined);
  });
});

