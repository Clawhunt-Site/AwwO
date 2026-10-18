// An opened node shows what it was asked, what it made and how its last run ended, at a size its content can use
// (owner request 2026-10-15: opened components did not show their context in full, in either mode).
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTile } from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
import { looksLikeCode } from '../src/canvas/codeLike';
import { DeliverableMarkdown } from '../src/canvas/DeliverableMarkdown';
import { FOCUSED_SESSION_MIN_SIZE, openContentOf, openFrameFor, presentationNodes } from '../src/canvas/nodePresentation';
import { appendTurn, resetAllSessions } from '../src/canvas/sessions';

beforeEach(() => { cleanup(); resetAllSessions(); });

const agent = (extra: Partial<SessionNode> = {}): SessionNode => ({ ...createAgentTemplate('general', { x: 0, y: 0 }, 'zh'), id: 'n', title: '关卡设计', ...extra });
const simple = (ui: ReactElement) => render(<CanvasUiModeProvider mode="simple">{ui}</CanvasUiModeProvider>);

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
