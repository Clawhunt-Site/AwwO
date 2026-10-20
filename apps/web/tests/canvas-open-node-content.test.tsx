// An opened node shows what it was asked, what it made and how its last run ended, at a size its content can use
// (owner request 2026-10-15: opened components did not show their context in full, in either mode).
import type { ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTile } from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
import { looksLikeCode } from '../src/canvas/codeLike';
import { DeliverableMarkdown } from '../src/canvas/DeliverableMarkdown';
import { FOCUSED_SESSION_MIN_SIZE, openContentOf, openFrameFor, presentationNodes } from '../src/canvas/nodePresentation';
import { appendTurn, resetAllSessions, setStreaming } from '../src/canvas/sessions';
import type { RunNodeStatus } from '../src/canvas/runGraph';
import { NodeFailure } from '../src/canvas/NodeBrief';
import { SHORT_COLUMN_PX } from '../src/canvas/useShortColumn';

beforeEach(() => { cleanup(); resetAllSessions(); });

const agent = (extra: Partial<SessionNode> = {}): SessionNode => ({ ...createAgentTemplate('general', { x: 0, y: 0 }, 'zh'), id: 'n', title: '关卡设计', ...extra });
const simple = (ui: ReactElement) => render(<CanvasUiModeProvider mode="simple">{ui}</CanvasUiModeProvider>);
/** A stylesheet without its comments, every run of white space one space. */
const flat = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
/** The declarations of the stylesheet rule whose selector is exactly `selector` (comments dropped, spaces collapsed). */
function declarations(css: string, selector: string): Record<string, string> {
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const [head, body] = block.split('{');
    if (body === undefined || head.trim() !== selector) continue;
    return Object.fromEntries(body.split(';').map(part => part.trim()).filter(Boolean)
      .map(part => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim().replace(/\s+/g, ' ')]));
  }
  throw new Error(`no rule for ${selector}`);
}
/** The text of the first stylesheet block whose head is exactly `head`, its nested blocks included (comments dropped,
 *  spaces collapsed). */
function block(css: string, head: string): string {
  const text = flat(css);
  const at = text.indexOf(`${head} {`);
  if (at < 0) throw new Error(`no block for ${head}`);
  for (let i = at + head.length + 1, depth = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1);
  }
  throw new Error(`unclosed block for ${head}`);
}

describe('a delivery that is code reads as code', () => {
  it.each([
    ['a constant', 'const LEVEL = [\n  "....L....",\n  "####=####",\n];\nexport default LEVEL;'],
    ['a function', 'function createSequencer(ctx, onStep) {\n  let bpm = 120;\n  return { start() { tick(); } };\n}'],
    ['a module', "import { tick } from './clock';\nexport const start = () => tick(0);\n"],
    ['JSON', '{"palette": {"0": "#1e1430", "1": "#3b2a4f"}, "sprites": [], "size": 16}'],
    ['a literal with comments', '{\n  // 24 colours, warm highlights\n  palette: {\n    "0": "#1e1430", // outline\n    "1": "#3b2a4f", // shadow\n  },\n  size: 16,\n}'],
    ['a page', '<!doctype html><html><body><canvas id="game"></canvas><script>start()</script></body></html>'],
    ['a stylesheet', 'body { margin: 0; color: #222; }\n.stage { display: grid; place-items: center; }'],
    ['a stylesheet of words', '.hero-title {\n  font-family: Inter, system-ui, sans-serif;\n  letter-spacing: 0.02em;\n  text-transform: uppercase;\n  color: midnightblue;\n}'],
    ['Python', 'def plant_layout(rows):\n    return [row.split(",") for row in rows]\n'],
    // Seen by the second review round: a module that opens with a comment and uses a template literal, and a tile map
    // whose water rows look like a fence.
    ['a module after its header comment', '// Level 1 sequencer\nlet bpm = 120;\nexport function start(el) {\n  el.textContent = `${bpm} bpm`;\n  return setInterval(() => tick(el), 60000 / bpm);\n}'],
    ['a tile map with tilde rows', 'export const LEVEL_1 = `\n~~~~~~~~~~~~~~~~\n~~~~......~~~~~~\n################\n`;'],
    ['an interface', 'interface Level {\n  tiles: string[];\n  checkpoints: Array<{ x: number; y: number }>;\n}'],
    ['copy written as a constant under a comment', "// Copy for the title screen\nexport const TITLE = 'Fox Courier: deliver three letters across the rooftops before the lanterns go out at dusk';"],
    ['a call with a template literal', 'setup({\n  title: `Fox ${level}`,\n  lives: 3,\n});\nstart();'],
  ])('%s', (_name, text) => {
    expect(looksLikeCode(text)).toBe(true);
    const { container } = render(<DeliverableMarkdown>{text}</DeliverableMarkdown>);
    const code = container.querySelector('pre.awwo-deliverable-code > code');
    expect(code?.textContent).toBe(text);
  });

  it.each([
    ['prose', 'The fox runs across rooftops and floating stalls, collects three letters and reaches the mailbox at the end.'],
    ['Chinese prose', '狐狸在屋顶和浮空摊位之间奔跑，收集三封信，最后到达终点的邮箱。整个关卡分为三段，难度逐渐上升。'],
    ['a heading and a list', '## 关卡规格\n- 三段：屋顶街、浮空摊位、灯笼桥\n- 每段一个检查点'],
    ['a link', '[设计稿](https://example.com/design) 是这一版的参考，请按它实现页面的布局与配色。'],
    ['a list of links', '[第一关](https://example.com/1)\n[第二关](https://example.com/2)\n[第三关](https://example.com/3)'],
    ['a table', '| Constant | Value |\n| --- | --- |\n| TILE | 16 |\n| GRAVITY | 0.35 |'],
    ['fenced code', '```js\nconst LEVEL = ["....", "####"];\n```\nThe level as an array of rows.'],
    ['a fence of dense code', '```js\nfunction tick(){if(t>0){t--;}else{t=60;}}\nconst a=[1,2,3];\n```'],
    ['an answer that fences its code after a line', '以下是实现：\n\n```js\nfunction tick(dt) {\n  if (state.t > 0) { state.t -= dt; }\n  draw(ctx, state);\n}\n```\n\n调用 `tick(16)` 每帧更新。'],
    ['inline code and bold', '**输入**：`level: Level`（关卡对象）\n**输出**：`{ tiles: Tile[]; size: number }`，每个瓦片都有类型和坐标。'],
    ['a sentence with settings in braces', 'Use these settings for the boss fight {speed: 3, gravity: 0.35, lives: 2} and keep the rest of the level as it is.'],
    ['markup followed by a sentence', '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg> 关卡图标已更新，换成了新的狐狸剪影。'],
    ['a short line', 'const a = 1;'],
    ['a review quoting code', 'The `step()` function never resets the timer when the level restarts, so the fox keeps its old speed; reset it in `restart()`.'],
  ])('leaves %s to Markdown', (_name, text) => {
    expect(looksLikeCode(text)).toBe(false);
    const { container } = render(<DeliverableMarkdown>{text}</DeliverableMarkdown>);
    expect(container.querySelector('pre.awwo-deliverable-code')).toBeNull();
  });
});

describe('the room an opened node takes', () => {
  it('sizes by what the node mostly shows, within the stage', () => {
    const stage = { w: 1800, h: 1000 };
    expect(openContentOf(agent())).toBe('chat');
    expect(openFrameFor(agent(), stage)).toEqual({ w: 1100, h: 1000 });
    const delivered = agent({ lastOutput: { text: '## 规格', source: 'run', at: 1 } });
    expect(openContentOf(delivered)).toBe('delivery');
    expect(openFrameFor(delivered, stage)).toEqual({ w: 1440, h: 1000 });
    const page = agent({ contract: { version: 1, inputs: [], outputs: [{ id: 'page', label: '页面', type: 'html', required: true, value: '' }] } });
    expect(openContentOf(page)).toBe('page');
    expect(openFrameFor(page, stage)).toEqual({ w: 1680, h: 1000 });
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img' };
    expect(openContentOf(image)).toBe('media');
    expect(openFrameFor(image, stage)).toEqual({ w: 1200, h: 1000 });
    // Never taller than 1100, never below the opened minimum, and none on a stage too small for one.
    expect(openFrameFor(page, { w: 4000, h: 3000 })).toEqual({ w: 1680, h: 1100 });
    expect(openFrameFor(page, { w: 600, h: 300 })).toEqual({ w: 600, h: FOCUSED_SESSION_MIN_SIZE.h });
    expect(openFrameFor(page, { w: 400, h: 900 })).toBeUndefined();
  });

  it('opens only the focused node at its frame, keeps a node resized larger by hand, and leaves the saved sizes alone', () => {
    const a = agent({ id: 'a', w: 300, h: 200 });
    const b = agent({ id: 'b', w: 1600, h: 1200 });
    const frame = { w: 1100, h: 900 };
    const [openA, closedB] = presentationNodes([a, b], 'a', undefined, undefined, frame);
    expect([openA.w, openA.h]).toEqual([1100, 900]);
    expect([closedB.w, closedB.h]).toEqual([260, 128]);
    const [, openB] = presentationNodes([a, b], 'b', undefined, undefined, frame);
    expect([openB.w, openB.h]).toEqual([1600, 1200]);
    // On a narrow stage the opened node fills it its own way; the frame does not apply.
    const [narrowA] = presentationNodes([a, b], 'a', 644, undefined, frame);
    expect(narrowA.w).toBeLessThanOrEqual(644);
    expect([a.w, a.h, b.w, b.h]).toEqual([300, 200, 1600, 1200]);
  });
});

describe('an opened node says what it was asked', () => {
  const brief = agent({
    persona: '设计三段关卡：屋顶街、浮空摊位、灯笼桥，每段一个检查点。',
    model: 'bedrock.claude-opus-5-5', runtime: 'openai-agents',
    taskFrame: { version: 1, source: 'manual', constraints: ['不联网', '只用 16 像素瓦片'], acceptanceCriteria: ['能从起点走到邮箱', '正好 3 封信', '正好 2 个检查点'] },
  });
  const choices = [{ key: 'opus', label: 'Claude Opus 5.5', available: true, model: 'bedrock.claude-opus-5-5' }];

  it('shows its task, model and checks, and the rest on request', () => {
    const ask = vi.fn();
    simple(<SessionTile node={brief} scale={1} focused modelChoices={choices} onAskAssistant={ask} />);
    const card = within(screen.getByRole('region', { name: '「关卡设计」的任务' }));
    expect(card.getByText('设计三段关卡：屋顶街、浮空摊位、灯笼桥，每段一个检查点。')).toBeVisible();
    expect(card.getByText('使用 Claude Opus 5.5')).toBeVisible();
    expect(card.getByText('验收标准')).toBeVisible();
    expect(card.getAllByRole('listitem').map(item => item.textContent)).toEqual(['能从起点走到邮箱', '正好 3 封信', '正好 2 个检查点']);
    expect(card.getByText('需要遵守 2 条约束')).toBeVisible();
    // The constraints themselves appear once the card is expanded.
    expect(card.queryByText('不联网')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: '展开' }));
    expect(card.getByText('不联网')).toBeVisible();
    expect(card.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(card.getByRole('button', { name: '让助手修改' }));
    expect(ask).toHaveBeenCalledWith('n', 'edit');
  });

  it('takes one line beside the opened inputs and counts its checks, all of them a press away', () => {
    simple(<SessionTile node={brief} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    const region = screen.getByRole('region', { name: '「关卡设计」的任务' });
    expect(region).toHaveClass('is-compact');
    const card = within(region);
    expect(card.queryAllByRole('listitem')).toHaveLength(0);
    expect(card.getByText('3 条验收标准 · 需要遵守 2 条约束')).toBeVisible();
    fireEvent.click(card.getByRole('button', { name: '展开' }));
    expect(region).not.toHaveClass('is-compact');
    expect(card.getAllByRole('listitem').map(item => item.textContent)).toEqual(['能从起点走到邮箱', '正好 3 封信', '正好 2 个检查点', '不联网', '只用 16 像素瓦片']);
    // Closing the inputs gives the card its full form again.
    fireEvent.click(card.getByRole('button', { name: '收起' }));
    fireEvent.click(screen.getByRole('button', { name: '收起输入' }));
    expect(region).not.toHaveClass('is-compact');
    expect(card.getAllByRole('listitem')).toHaveLength(3);
  });

  // Customer report 2026-10-18: at 1280 × 720 with the assistant open the full card and the message box left a reply
  // 26 px. Above a conversation the card is one line, and the conversation panel says it holds replies to keep room for.
  it('takes one line above a conversation, which keeps the column, and its whole form again when expanded', () => {
    const { rerender } = simple(<SessionTile node={brief} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} />);
    const region = screen.getByRole('region', { name: '「关卡设计」的任务' });
    expect(region).not.toHaveClass('is-compact');
    expect(document.querySelector('.awwo-node-panel--conversation')).not.toHaveClass('has-turns');
    act(() => { appendTurn(brief.id, { role: 'user', text: '把关卡写成表格' }); appendTurn(brief.id, { role: 'agent', text: '| 段 | 检查点 |\n| --- | --- |\n| 屋顶街 | 1 |' }); });
    rerender(<CanvasUiModeProvider mode="simple"><SessionTile node={brief} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} /></CanvasUiModeProvider>);
    expect(region).toHaveClass('is-compact');
    expect(within(region).getByText('3 条验收标准 · 需要遵守 2 条约束')).toBeVisible();
    expect(within(region).queryAllByRole('listitem')).toHaveLength(0);
    expect(document.querySelector('.awwo-node-panel--conversation')).toHaveClass('has-turns');
    fireEvent.click(within(region).getByRole('button', { name: '展开' }));
    expect(region).not.toHaveClass('is-compact');
    expect(within(region).getAllByRole('listitem')).toHaveLength(5);
  });

  // Customer report 2026-10-18, follow-up: on a laptop's window the conversation still kept a line or two. A chat column
  // under SHORT_COLUMN_PX draws its message box and task card compact (awwo-node.css `.is-short`).
  it('marks a chat column too short to read in, and only an opened node’s', () => {
    // jsdom lays nothing out (every clientHeight is 0): the chat column is given a height, everything else keeps 0.
    let column = 408;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('awwo-node-chat') ? column : 0; } });
    try {
      const { unmount } = simple(<SessionTile node={brief} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} />);
      expect(document.querySelector('.awwo-node-chat')).toHaveClass('is-short');
      unmount();
      column = SHORT_COLUMN_PX;
      simple(<SessionTile node={brief} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} />);
      expect(document.querySelector('.awwo-node-chat')).not.toHaveClass('is-short');
    } finally {
      // Element.prototype's own getter is found again once the override is gone.
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  // Seen 2026-10-19 in Chrome at 1366 × 657 and 1280 × 720, in every look: in a short column with no conversation yet, a
  // draft of three lines or more pushed the model and 用户须知, then the box, out of the node. The conversation kept its
  // share of the column and the empty conversation its 56 px. jsdom lays nothing out, so the rules found in Chrome are
  // read from the stylesheet, and the node's own markup is matched against their selectors.
  it('keeps a short column’s composer in the node with no conversation yet: the empty conversation gives way, then the task card', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/canvas/awwo-node.css'), 'utf8');
    const conversation = '.canvas-root .awwo-node-chat.is-short .awwo-node-panel--conversation:has(> .awwo-node-empty)';
    const empty = '.canvas-root .awwo-node .awwo-node-chat.is-short .awwo-node-panel--conversation > .awwo-node-empty';
    const note = '.canvas-root .awwo-node-chat.is-short .awwo-node-panel--conversation:has(> .awwo-node-empty) > .awwo-rework-note';
    // Never shorter than its content, so the task card above gives way before the composer does. It grows as before:
    // no flex-grow here, so beside the opened inputs it keeps their 0.
    expect(declarations(css, conversation)).toEqual({ 'flex-basis': 'auto', 'flex-shrink': '0' });
    // The empty conversation's content counts for nothing in that, and it gives way down to its padding.
    expect(declarations(css, empty)).toEqual({ 'min-height': '0', container: 'awwo-node-empty / size' });
    // Where less than 20 px of it would show (the old 56 px left 20), its content is not drawn: no sliver, and nothing
    // that overflows, so it is no scroller for Tab to stop on (visibility: hidden would leave both). A starter prompt
    // with the keyboard's focus stays.
    expect(flat(css)).toContain('@container awwo-node-empty (height < 20px) { .canvas-root .awwo-node-chat.is-short .awwo-node-empty:not(:has(:focus-visible)) > * { display: none; } }');
    // A rework note above the empty conversation keeps its toggle (32 px and its border), open or closed.
    expect(declarations(css, note)).toEqual({ 'min-height': '34px' });

    let column = 408;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('awwo-node-chat') ? column : 0; } });
    try {
      const tile = (node: SessionNode) => <CanvasUiModeProvider mode="simple"><div className="canvas-root">
        <SessionTile node={node} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} /></div></CanvasUiModeProvider>;
      const panel = () => document.querySelector('.awwo-node-panel--conversation')!;
      const { rerender, unmount } = render(tile(brief));
      expect(panel().matches(conversation)).toBe(true);
      expect(document.querySelector('.awwo-node-empty')!.matches(empty)).toBe(true);
      // With a conversation the replies give way instead, as before: neither rule applies.
      act(() => { appendTurn(brief.id, { role: 'user', text: '把关卡写成表格' }); });
      rerender(tile(brief));
      expect(document.querySelector('.awwo-node-empty')).toBeNull();
      expect(panel().matches(conversation)).toBe(false);
      unmount();
      resetAllSessions();
      // A rework note counts with its one line, open (it counts with its toggle then, see the next test) or closed. The
      // empty conversation gives way either way, and the note keeps its toggle; beside replies it gives way as before.
      const reworkedNode = agent({ taskFrame: { version: 1, source: 'manual', constraints: ['【验收返工·交付验收】交付结果没有列出检查过的文件。'], acceptanceCriteria: [] } });
      const reworked = render(tile(reworkedNode));
      const findings = screen.getByTestId('rework-findings-n');
      expect(findings.matches(note)).toBe(true);
      expect(panel().matches(conversation)).toBe(true);
      fireEvent.click(within(findings).getByRole('button', { expanded: false }));
      expect(findings.querySelector('.awwo-rework-note-body')).toBeTruthy();
      expect(panel().matches(conversation)).toBe(true);
      expect(document.querySelector('.awwo-node-empty')!.matches(empty)).toBe(true);
      expect(findings.matches(note)).toBe(true);
      act(() => { appendTurn(reworkedNode.id, { role: 'agent', text: '已按验收意见补上检查记录。' }); });
      reworked.rerender(tile(reworkedNode));
      expect(screen.getByTestId('rework-findings-n').matches(note)).toBe(false);
      reworked.unmount();
      resetAllSessions();
      // A column tall enough to read in is laid out as before.
      column = SHORT_COLUMN_PX;
      render(tile(brief));
      expect(panel().matches(conversation)).toBe(false);
      expect(document.querySelector('.awwo-node-empty')!.matches(empty)).toBe(false);
    } finally {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  // Seen 2026-10-20 in Chrome at 1366 × 657 and 1280 × 720 (the shortest column an opened node gets, 334 px): with the
  // opened inputs at their floor, a ten-line draft cut the model row by up to 5 px; beside a closed rework note, by up to
  // 11.5 px; an open note counted in full, so its findings got 9 px and the composer was cut at every draft. Any lower
  // floor also moved columns that fit (a node without inputs), so the composer is pinned to the node's bottom instead,
  // only where what it can lie over is the inputs' bottom edge or blank (review 2026-10-20: with a rework note or a
  // failure note beside the inputs it lay over their fields), and an open note counts with its toggle. jsdom lays nothing
  // out: the rules are read from the stylesheets, and the node's own markup is matched against their selectors.
  it('keeps a short column’s composer whole beside the opened inputs or a rework note: pinned to the node’s bottom, an open note counting with its toggle', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/canvas/awwo-node.css'), 'utf8');
    // A file or a notice in the composer makes it taller than what a pin may lie over: such a composer is pinned only
    // where it cannot rise past blank space. These are the composer's own classes (TileComposer, ComposerAttachments).
    const taller = ['awwo-attachment-chip', 'awwo-attachment-notice', 'canvas-composer-notice', 'canvas-composer-blocked'];
    const sources = ['src/canvas/TileComposer.tsx', 'src/canvas/ComposerAttachments.tsx'].map(file => readFileSync(resolve(process.cwd(), file), 'utf8')).join('\n');
    for (const name of taller) expect(sources).toMatch(new RegExp(`className=[{\`"']+${name}[\\s"'\`$]`));
    const plain = `:is(${taller.map(name => `.${name}`).join(', ')})`;
    const besideInputs = ".canvas-root .awwo-node:not([data-content='media']) .awwo-node-chat.has-inputs.is-short:not(:has(> .awwo-node-failure, > .awwo-node-brief.is-open))";
    const pinnedPanel = `${besideInputs} .awwo-input-drawer + .awwo-node-panel--conversation:not(:has(> .awwo-rework-note, > .canvas-composer ${plain}))`;
    const paddedInputs = `${besideInputs} .awwo-input-drawer:has(+ .awwo-node-panel--conversation):not(:has(+ .awwo-node-panel--conversation > .awwo-rework-note, + .awwo-node-panel--conversation > .canvas-composer ${plain}))`;
    const clippedPanel = `.canvas-root .awwo-node:not([data-content='media']) .awwo-node-chat.is-short:not(.has-inputs) .awwo-node-panel--conversation:has(> .awwo-node-empty):not(:has(> .awwo-node-empty :focus-visible)):is(:not(:has(> .awwo-rework-note)), :not(.awwo-node-failure ~ *, :has(> .awwo-rework-note > .awwo-rework-note-body, > .canvas-composer ${plain})))`;
    const pinnedComposer = `${clippedPanel} > .canvas-composer`;
    const openNote = '.canvas-root .awwo-node-chat.is-short:has(> .awwo-node-panel--conversation > .awwo-node-empty) .awwo-node-panel--conversation > .awwo-rework-note:has(> .awwo-rework-note-body)';
    const hiddenEmpty = '.canvas-root .awwo-node-chat.is-short .awwo-node-panel--conversation:has(> .awwo-rework-note > .awwo-rework-note-body) > .awwo-node-empty';
    const bottomComposer = '.canvas-root .awwo-node-chat.is-short:not(.has-inputs) .awwo-node-panel--conversation:has(> .awwo-node-empty):has(> .awwo-rework-note > .awwo-rework-note-body) > .canvas-composer';
    const oneLineBrief = '.canvas-root .awwo-node-chat.is-short:not(.has-inputs):has(> .awwo-node-panel--conversation > .awwo-node-empty):has(> .awwo-node-panel--conversation > .awwo-rework-note > .awwo-rework-note-body) > .awwo-node-brief:not(.is-open)';
    // Pinned: no box moves, so a column that holds its composer lays out as before; one that does not keeps the composer
    // on the node's bottom edge, over the inputs' bottom edge (a focused field scrolls clear of it, its focus ring too) or
    // the empty conversation's blank padding. Beside an empty conversation the panel clips without scrolling, so the pin
    // keeps to the node's body, not the panel.
    expect(declarations(css, pinnedPanel)).toEqual({ position: 'sticky', bottom: '0' });
    expect(declarations(css, paddedInputs)).toEqual({ 'scroll-padding-bottom': '18px' });
    expect(declarations(css, clippedPanel)).toEqual({ overflow: 'clip' });
    expect(declarations(css, pinnedComposer)).toEqual({ position: 'sticky', bottom: '0' });
    // An open note beside an empty conversation counts with its toggle and grows, up to its findings, into what the
    // column leaves; it takes that conversation's place, and the task card keeps only its header row unless expanded.
    expect(declarations(css, openNote)).toEqual({ flex: '1 1 34px', 'min-height': '34px', 'max-height': 'max-content', overflow: 'clip' });
    expect(declarations(css, hiddenEmpty)).toEqual({ display: 'none' });
    expect(declarations(css, bottomComposer)).toEqual({ 'margin-top': 'auto' });
    expect(declarations(css, oneLineBrief)).toEqual({ 'max-height': '44px' });
    // Beside the opened inputs the note waits closed (ReworkFindingsNote): its toggle says so, and is drawn as such.
    expect(declarations(css, ".canvas-root .awwo-rework-note-toggle[aria-disabled='true']")).toEqual({ cursor: 'default' });
    expect(declarations(css, ".canvas-root .awwo-rework-note-toggle[aria-disabled='true'] .awwo-rework-note-chevron")).toEqual({ opacity: '.4' });
    // The hosted look draws its composer see-through; a short column's is the node's own colour, so a pinned one hides
    // what it lies over (every theme paints the node var(--awwo-card)).
    const look = block(readFileSync(resolve(process.cwd(), 'src/saas/design/canvas.css'), 'utf8'), ".canvas-root:is([data-node-style='default'], :not([data-node-style]))");
    expect(look).toContain('& .awwo-node .canvas-composer { gap: 6px; padding: 6px 14px 14px; background: transparent; }');
    expect(look).toContain('& .awwo-node-chat.is-short .canvas-composer { background-color: var(--awwo-card); }');

    let column = 408;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('awwo-node-chat') ? column : 0; } });
    try {
      // The hosted canvas's composer: a free conversation, an unbound node binding on its first message, so the box is not
      // blocked (a node whose required input is empty would block it otherwise).
      type Extra = { run?: RunNodeStatus | null; readOnly?: boolean; sendUnavailableReason?: string };
      const tile = (node: SessionNode, extra: Extra = {}) => <CanvasUiModeProvider mode="simple"><div className="canvas-root">
        <SessionTile node={node} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} freeConversation initializeOnSend onSend={vi.fn()} {...extra} /></div></CanvasUiModeProvider>;
      // A draft that carries a file: the composer shows its chip above the box.
      const fileLine = '[附件] 参考稿.pdf · awwo-file:aTestFile00001';
      const withFile = (node: SessionNode): SessionNode => ({ ...node, threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: `请按参考稿改写\n\n${fileLine}`, createdAt: 1 }] });
      const panel = () => document.querySelector('.awwo-node-panel--conversation')!;
      const drawer = () => document.querySelector('.awwo-input-drawer')!;
      const composer = () => document.querySelector('.canvas-composer')!;
      const card = () => screen.getByRole('region', { name: '「关卡设计」的任务' });
      const openInputs = () => fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
      const closeInputs = () => fireEvent.click(screen.getByRole('button', { name: '收起输入' }));
      const shows = (name: string) => Boolean(composer().querySelector(`.${name}`));
      // An upload's own notice needs an upload: that one is put in the box by hand for one match, taken out before React renders.
      const uploadNotice = (check: () => boolean) => {
        const notice = Object.assign(document.createElement('p'), { className: 'awwo-attachment-notice' });
        composer().querySelector('.canvas-composer-box')!.prepend(notice);
        try { return check(); } finally { notice.remove(); }
      };

      // No conversation yet: the composer is pinned within its panel, and it can rise no higher than the empty
      // conversation's top, so a file, a notice or a blocked box change nothing here; not while a starter prompt has the
      // keyboard's focus (that prompt is drawn in the empty conversation's padding then).
      const first = render(tile(brief));
      expect([panel().matches(clippedPanel), composer().matches(pinnedComposer), panel().matches(pinnedPanel)]).toEqual([true, true, false]);
      first.rerender(tile(brief, { sendUnavailableReason: '这个模型暂不可用' }));
      expect([shows('canvas-composer-notice'), composer().matches(pinnedComposer)]).toEqual([true, true]);
      first.rerender(tile(brief, { readOnly: true }));
      expect([shows('canvas-composer-blocked'), composer().matches(pinnedComposer)]).toEqual([true, true]);
      first.rerender(tile(brief));
      expect(uploadNotice(() => composer().matches(pinnedComposer))).toBe(true);
      const starter = within(document.querySelector<HTMLElement>('.awwo-starter-prompts')!).getAllByRole('button')[0];
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' });
      act(() => { starter.focus(); });
      expect(starter.matches(':focus-visible')).toBe(true);
      expect([panel().matches(clippedPanel), composer().matches(pinnedComposer)]).toEqual([false, false]);
      act(() => { starter.blur(); });
      expect(composer().matches(pinnedComposer)).toBe(true);
      // With the inputs open, the panel beside them is pinned (and the inputs keep room for a focused field), but not
      // while the composer is taller (a notice, a blocked box, an upload's notice), the task card is expanded, or a failure
      // note shares the column: the composer would lie over the inputs' fields.
      openInputs();
      expect(document.querySelector('.awwo-node-chat')).toHaveClass('has-inputs');
      expect([panel().matches(clippedPanel), composer().matches(pinnedComposer), panel().matches(pinnedPanel), drawer().matches(paddedInputs)]).toEqual([false, false, true, true]);
      first.rerender(tile(brief, { sendUnavailableReason: '这个模型暂不可用' }));
      expect([panel().matches(pinnedPanel), drawer().matches(paddedInputs)]).toEqual([false, false]);
      first.rerender(tile(brief, { readOnly: true }));
      expect([shows('canvas-composer-blocked'), panel().matches(pinnedPanel)]).toEqual([true, false]);
      first.rerender(tile(brief));
      expect([uploadNotice(() => panel().matches(pinnedPanel)), panel().matches(pinnedPanel)]).toEqual([false, true]);
      fireEvent.click(within(card()).getByRole('button', { name: '展开' }));
      expect(card()).toHaveClass('is-open');
      expect([panel().matches(pinnedPanel), drawer().matches(paddedInputs)]).toEqual([false, false]);
      fireEvent.click(within(card()).getByRole('button', { name: '收起' }));
      expect(panel().matches(pinnedPanel)).toBe(true);
      first.rerender(tile(brief, { run: { state: 'failed' } }));
      expect(document.querySelector('.awwo-node-failure')).toBeTruthy();
      expect([panel().matches(pinnedPanel), drawer().matches(paddedInputs)]).toEqual([false, false]);
      closeInputs();
      // A failure note above an empty conversation leaves the pin within the panel, which it cannot leave.
      expect(composer().matches(pinnedComposer)).toBe(true);
      first.rerender(tile(brief));
      // With a conversation the replies give way, as before: nothing is pinned until the inputs take the column; a file in
      // an earlier message (its chip in the hidden replies) is not the composer's.
      act(() => { appendTurn(brief.id, { role: 'user', text: `请按参考稿改写\n\n${fileLine}` }); appendTurn(brief.id, { role: 'agent', text: '三段关卡已写好。' }); });
      first.rerender(tile(brief));
      expect(document.querySelector('.canvas-transcript .awwo-attachment-chip')).toBeTruthy();
      expect([panel().matches(clippedPanel), composer().matches(pinnedComposer), panel().matches(pinnedPanel)]).toEqual([false, false, false]);
      openInputs();
      expect([panel().matches(pinnedPanel), drawer().matches(paddedInputs)]).toEqual([true, true]);
      first.unmount();
      resetAllSessions();
      // A draft with a file: beside an empty conversation alone the composer is pinned; beside the inputs it is not.
      const filed = render(tile(withFile(brief)));
      expect([shows('awwo-attachment-chip'), composer().matches(pinnedComposer)]).toEqual([true, true]);
      openInputs();
      expect(panel().matches(pinnedPanel)).toBe(false);
      filed.unmount();
      resetAllSessions();

      // A rework note: closed, it changes nothing beside an empty conversation (its one line counts, the composer is
      // pinned within the panel), unless the composer is taller or a failure note is above, either of which could lift
      // it over the note's toggle; beside the opened inputs nothing is pinned, as the note takes its row from them.
      const reworkedNode = agent({ taskFrame: { ...brief.taskFrame!, constraints: ['【验收返工·交付验收】交付结果没有列出检查过的文件。'] } });
      const reworked = render(tile(reworkedNode));
      const findings = () => screen.getByTestId('rework-findings-n');
      expect([findings().matches(openNote), composer().matches(pinnedComposer)]).toEqual([false, true]);
      reworked.rerender(tile(reworkedNode, { sendUnavailableReason: '这个模型暂不可用' }));
      expect(composer().matches(pinnedComposer)).toBe(false);
      reworked.rerender(tile(reworkedNode, { run: { state: 'failed' } }));
      expect([Boolean(document.querySelector('.awwo-node-failure')), composer().matches(pinnedComposer)]).toEqual([true, false]);
      reworked.rerender(tile(withFile(reworkedNode)));
      expect([shows('awwo-attachment-chip'), composer().matches(pinnedComposer)]).toEqual([true, false]);
      reworked.rerender(tile(reworkedNode));
      expect([uploadNotice(() => composer().matches(pinnedComposer)), composer().matches(pinnedComposer)]).toEqual([false, true]);
      // What the note's toggle says, and whether its findings are drawn.
      const toggle = () => findings().querySelector<HTMLButtonElement>('.awwo-rework-note-toggle')!;
      const noteState = () => [toggle().getAttribute('aria-expanded'), toggle().querySelector('small')!.textContent, Boolean(findings().querySelector('.awwo-rework-note-body'))];
      openInputs();
      expect([panel().matches(pinnedPanel), ...noteState(), toggle().getAttribute('aria-disabled')]).toEqual([false, 'false', '关闭输入后查看', false, 'true']);
      // While the opened inputs take the short column the toggle asks for them to be closed first and does nothing
      // itself (closing them would end an upload in one of their fields); once they close it opens the note.
      fireEvent.click(toggle());
      expect([Boolean(document.querySelector('.awwo-input-drawer')), ...noteState()]).toEqual([true, 'false', '关闭输入后查看', false]);
      closeInputs();
      expect([toggle().getAttribute('aria-disabled'), ...noteState()]).toEqual([null, 'false', '查看', false]);
      fireEvent.click(toggle());
      expect(noteState()).toEqual(['true', '收起', true]);
      // Open, it counts with its toggle and takes the empty conversation's place; the composer sits at the bottom of the
      // panel, unpinned, and the task card keeps only its header row, until it is expanded.
      expect(findings().matches(openNote)).toBe(true);
      expect(document.querySelector('.awwo-node-empty')!.matches(hiddenEmpty)).toBe(true);
      expect([composer().matches(bottomComposer), composer().matches(pinnedComposer), panel().matches(clippedPanel)]).toEqual([true, false, false]);
      expect(card().matches(oneLineBrief)).toBe(true);
      fireEvent.click(within(card()).getByRole('button', { name: '展开' }));
      expect(card().matches(oneLineBrief)).toBe(false);
      fireEvent.click(within(card()).getByRole('button', { name: '收起' }));
      // Beside the opened inputs its findings wait (the inputs take the column): the note says it is closed, and nothing
      // is pinned; the task card's own rules for the inputs apply, not this one. Left open, it shows again once the
      // inputs close.
      openInputs();
      expect([...noteState(), panel().matches(pinnedPanel), card().matches(oneLineBrief), composer().matches(bottomComposer)]).toEqual(['false', '关闭输入后查看', false, false, false, false]);
      closeInputs();
      expect(noteState()).toEqual(['true', '收起', true]);
      // Beside replies the open note gives way with them, as before; its findings wait while the inputs take the column.
      act(() => { appendTurn(reworkedNode.id, { role: 'agent', text: '已按验收意见补上检查记录。' }); });
      reworked.rerender(tile(reworkedNode));
      expect([findings().matches(openNote), ...noteState(), card().matches(oneLineBrief)]).toEqual([false, 'true', '收起', true, false]);
      openInputs();
      expect([findings().matches(openNote), ...noteState(), panel().matches(pinnedPanel)]).toEqual([false, 'false', '关闭输入后查看', false, false]);
      reworked.unmount();
      resetAllSessions();

      // A column tall enough to read in is laid out as before: nothing here applies.
      column = SHORT_COLUMN_PX;
      const tall = render(tile(reworkedNode));
      expect([panel().matches(clippedPanel), composer().matches(pinnedComposer)]).toEqual([false, false]);
      fireEvent.click(within(findings()).getByRole('button', { expanded: false }));
      expect([findings().matches(openNote), document.querySelector('.awwo-node-empty')!.matches(hiddenEmpty), card().matches(oneLineBrief)]).toEqual([false, false, false]);
      openInputs();
      expect([panel().matches(pinnedPanel), drawer().matches(paddedInputs), ...noteState()]).toEqual([false, false, 'true', '收起', true]);
      tall.unmount();
      resetAllSessions();

      // A media node's prompt box can be taller than the column: its composer is not pinned, beside its inputs or an empty
      // conversation, where an agent's is (both in the developer view, which offers inputs a media node does not need).
      column = 408;
      const developer = (node: SessionNode) => render(<div className="canvas-root"><SessionTile node={node} scale={1} focused onUpdateNode={vi.fn()} freeConversation initializeOnSend onSend={vi.fn()} /></div>);
      for (const [node, pinned] of [[{ ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: '海报图' }, false], [agent(), true]] as const) {
        const view = developer(node);
        expect(document.querySelector('.awwo-node')).toHaveAttribute('data-content', pinned ? 'chat' : 'media');
        expect(composer().matches(pinnedComposer)).toBe(pinned);
        openInputs();
        expect(document.querySelector('.awwo-node-chat')).toHaveClass('has-inputs');
        expect([panel().matches(pinnedPanel), drawer().matches(paddedInputs)]).toEqual([pinned, pinned]);
        view.unmount();
        resetAllSessions();
      }
    } finally {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  it('gives its opened inputs the column: the conversation steps aside and its message box stays', () => {
    simple(<SessionTile node={brief} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} />);
    act(() => { appendTurn(brief.id, { role: 'agent', text: '三段关卡已写好。' }); });
    const column = document.querySelector('.awwo-node-chat');
    expect(column).not.toHaveClass('has-inputs');
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    expect(column).toHaveClass('has-inputs');
    expect(screen.getByRole('region', { name: '输入表单' })).toBeTruthy();
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起输入' }));
    expect(column).not.toHaveClass('has-inputs');
  });

  // Review 2026-10-18: what a run or a message brings with the inputs open is read in the conversation, which keeps the
  // column once the work ends, until the inputs are opened again. A lock the canvas holds for all its nodes changes nothing.
  it('gives the conversation the column for a run or a message, and keeps it there once they end', () => {
    const tile = (run: RunNodeStatus | null, locked = false) => <CanvasUiModeProvider mode="simple"><SessionTile node={brief} scale={1} focused modelChoices={choices} onUpdateNode={vi.fn()} run={run} interactionLocked={locked} /></CanvasUiModeProvider>;
    const { rerender } = render(tile(null));
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    const column = document.querySelector('.awwo-node-chat');
    expect(column).toHaveClass('has-inputs');
    rerender(tile(null, true));
    expect(column).toHaveClass('has-inputs');
    rerender(tile({ state: 'running' }));
    expect(column).not.toHaveClass('has-inputs');
    rerender(tile({ state: 'done' }));
    expect(column).not.toHaveClass('has-inputs');
    expect(screen.getByRole('region', { name: '输入表单' })).toBeTruthy();
    // Opened again, the inputs take the column again, until a reply streams in.
    fireEvent.click(screen.getByRole('button', { name: '收起输入' }));
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    expect(column).toHaveClass('has-inputs');
    act(() => { setStreaming(brief.id, true); });
    expect(column).not.toHaveClass('has-inputs');
    act(() => { setStreaming(brief.id, false); });
    expect(column).not.toHaveClass('has-inputs');
    // Opened while a run goes on, the inputs leave the column to what the run brings when it ends, too.
    fireEvent.click(screen.getByRole('button', { name: '收起输入' }));
    rerender(tile({ state: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    expect(column).not.toHaveClass('has-inputs');
    rerender(tile({ state: 'done' }));
    expect(column).not.toHaveClass('has-inputs');
    expect(screen.getByRole('region', { name: '输入表单' })).toBeTruthy();
  });

  it('keeps a failed run’s whole reason in its note’s tooltip, for the one-row note beside the inputs', () => {
    render(<NodeFailure detail="运行超时，请缩小任务范围后重试。" onRerun={vi.fn()} />);
    expect(screen.getByRole('status').querySelector('span')).toHaveAttribute('title', '运行超时，请缩小任务范围后重试。');
  });

  it('offers the rest of a task the clamp hides: more lines than it shows, or text that overflows a narrow column', () => {
    const { unmount } = render(<SessionTile node={agent({ persona: '第一条\n第二条\n第三条\n第四条' })} scale={1} focused />);
    expect(within(screen.getByRole('region', { name: '「关卡设计」的任务' })).getByRole('button', { name: '展开' })).toBeTruthy();
    unmount();
    // A short line laid out wider than its column: the clamped box reports more than it shows.
    const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('awwo-node-brief-task') ? 120 : 0;
    });
    const short = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('awwo-node-brief-task') ? 60 : 0;
    });
    render(<SessionTile node={agent({ persona: '设计三段关卡，每段一个检查点。' })} scale={1} focused />);
    const card = within(screen.getByRole('region', { name: '「关卡设计」的任务' }));
    const toggle = card.getByRole('button', { name: '展开' });
    expect(toggle).toHaveAttribute('aria-controls', document.querySelector('.awwo-node-brief-body')!.id);
    tall.mockRestore(); short.mockRestore();
    cleanup();
    // Nothing clipped and nothing more to show: no control.
    render(<SessionTile node={agent({ persona: '设计三段关卡。' })} scale={1} focused />);
    expect(within(screen.getByRole('region', { name: '「关卡设计」的任务' })).queryByRole('button', { name: '展开' })).toBeNull();
  });

  it('names a model its choices do not list by the canvas catalogue, as on a read-only canvas', () => {
    const models = [{ key: 'opus', label: 'Claude Opus 5.5', providerGroup: 'anthropic' as const, runtime: 'openai-agents' as const, model: 'bedrock.claude-opus-5-5', available: true }];
    render(<SessionTile node={brief} scale={1} focused readOnly modelNames={{ models }} />);
    expect(within(screen.getByRole('region', { name: '「关卡设计」的任务' })).getByText('使用 Claude Opus 5.5')).toBeVisible();
  });

  it('says the workspace default model, offers no assistant on a view-only node, and shows nothing for a node with no task', () => {
    const { unmount } = render(<SessionTile node={{ ...brief, model: '', runtime: '' }} scale={1} focused readOnly onAskAssistant={vi.fn()} />);
    const card = within(screen.getByRole('region', { name: '「关卡设计」的任务' }));
    expect(card.getByText('使用工作区默认模型')).toBeVisible();
    expect(card.queryByRole('button', { name: '让助手修改' })).toBeNull();
    unmount();
    render(<SessionTile node={{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'empty', title: '空节点' }} scale={1} focused />);
    expect(screen.queryByRole('region', { name: '「空节点」的任务' })).toBeNull();
  });

  it('says how the last run failed, with a way to run it again and a way to let the assistant fix it', () => {
    const ask = vi.fn(); const runNode = vi.fn();
    render(<SessionTile node={{ ...brief, binding: { companyId: 'c', agentId: 'a', agentName: '关卡' } }} scale={1} focused
      run={{ state: 'failed', detail: 'the model stopped at its output limit' }} onRunNode={runNode} onAskAssistant={ask} />);
    const note = document.querySelector('.awwo-node-failure') as HTMLElement;
    // Said politely: it is there each time the node opens, so an alert would be announced again and again.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(note).getByRole('status')).toHaveTextContent('上次运行失败：the model stopped at its output limit');
    const failure = within(note);
    expect(failure.getByText('上次运行失败：')).toBeVisible();
    fireEvent.click(failure.getByRole('button', { name: '重新运行' }));
    expect(runNode).toHaveBeenCalledWith('n');
    fireEvent.click(failure.getByRole('button', { name: '让助手调整' }));
    expect(ask).toHaveBeenCalledWith('n', 'fix');
  });
});

describe('an opened node in the simple view', () => {
  it('offers its inputs to fill in, without the field structure, and none on a node that takes no input', () => {
    const { unmount } = simple(<SessionTile node={agent()} scale={1} focused onUpdateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
    const drawer = within(screen.getByRole('region', { name: '输入表单' }));
    expect(drawer.getAllByRole('textbox').length).toBeGreaterThan(0);
    expect(drawer.queryByRole('button', { name: '编辑字段结构' })).toBeNull();
    unmount();
    simple(<SessionTile node={{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'free', title: '自由对话' }} scale={1} focused />);
    expect(screen.queryByRole('button', { name: '输入', exact: true })).toBeNull();
  });

  it('names its conversations in the reader\'s words', () => {
    const threads = [
      { id: 't1', title: 'Session 1', issueId: null, preview: '', draft: '', createdAt: 1 },
      { id: 't2', title: 'Session 2', issueId: null, preview: '', draft: '', createdAt: 2 },
    ];
    const { unmount } = simple(<SessionTile node={agent({ threads, activeThreadId: 't2' })} scale={1} focused />);
    expect(document.querySelector('.awwo-chat-heading > span')?.textContent).toBe('对话 2');
    unmount();
    simple(<SessionTile node={agent({ threads: [{ ...threads[0], title: '关卡第二版' }], activeThreadId: 't1' })} scale={1} focused />);
    expect(document.querySelector('.awwo-chat-heading > span')?.textContent).toBe('关卡第二版');
  });
});

describe('an opened node that has delivered', () => {
  const delivered = (extra: Partial<SessionNode> = {}) => agent({ lastOutput: { text: '{"result":"## 关卡规格"}', source: 'run', at: 1 }, ...extra });

  it('opens with its delivery beside the conversation unless the reader closed it there', () => {
    const { unmount } = render(<SessionTile node={delivered()} scale={1} focused />);
    expect(screen.getByRole('region', { name: '交付物' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '展开交付物' })).toBeNull();
    const tile = screen.getByTestId('canvas-tile-n');
    expect(tile.dataset.content).toBe('delivery');
    expect(tile.style.getPropertyValue('--awwo-drawer-width')).toBe('52%');
    unmount();
    render(<SessionTile node={delivered({ deliverablesOpen: false })} scale={1} focused />);
    expect(screen.queryByRole('region', { name: '交付物' })).toBeNull();
    expect(screen.getByRole('button', { name: '展开交付物' })).toBeTruthy();
  });

  it('keeps its drawer closed by default where it would cover the conversation, and beside a failed run’s partial delivery', () => {
    const { unmount } = render(<SessionTile node={delivered()} scale={1} focused deliveryBeside={false} />);
    expect(screen.queryByRole('region', { name: '交付物' })).toBeNull();
    unmount();
    // The reader's own choice still holds there.
    const { unmount: second } = render(<SessionTile node={delivered({ deliverablesOpen: true })} scale={1} focused deliveryBeside={false} />);
    expect(screen.getByRole('region', { name: '交付物' })).toBeTruthy();
    second();
    render(<SessionTile node={delivered({ lastOutput: { text: '{"result":"## 半"}', source: 'run', at: 1, partial: true } })} scale={1} focused />);
    expect(screen.queryByRole('region', { name: '交付物' })).toBeNull();
  });

  it('gives a page most of its width, and leaves a picture, clip or model where its own view shows it', () => {
    const { unmount } = render(<SessionTile node={delivered({ contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: '页面', type: 'html', required: true, value: '' }] } })} scale={1} focused />);
    const tile = screen.getByTestId('canvas-tile-n');
    expect(tile.dataset.content).toBe('page');
    expect(tile.style.getPropertyValue('--awwo-drawer-width')).toBe('62%');
    unmount();
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: '封面', lastOutput: { text: 'https://example.com/a.png', source: 'run' as const, at: 1 } };
    render(<SessionTile node={image} scale={1} focused />);
    expect(screen.getByTestId('canvas-tile-img').dataset.content).toBe('media');
    expect(screen.queryByRole('region', { name: '交付物' })).toBeNull();
  });
});
