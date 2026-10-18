// A long reply, or one with a table, can be read at full size and at a chosen text size (customer report 2026-10-18:
// 「这里面的文字根本看不全，也没办法放大」).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { READER_TEXT_SIZE_KEY, readerWorthy } from '../src/canvas/ReplyReader';
import { LocaleProvider } from '../src/canvas/i18n';
import type { Turn } from '../src/canvas/sessions';

beforeEach(() => localStorage.removeItem(READER_TEXT_SIZE_KEY));
afterEach(cleanup);

const table = '## 评分表\n\n| 维度 | 分值 | 标准 |\n| --- | --- | --- |\n| 卡点精度 | 20 | 100% 的场景切换落在重拍上，偏差不超过 1 帧 |';
const agent = (id: number, text: string, extra: Partial<Turn> = {}): Turn => Object.freeze({ id, role: 'agent' as const, text, ...extra });
const transcript = (turns: Turn[]) => <TileTranscript turns={turns} history="loaded" streaming={false} limit={Infinity} />;
const show = (text: string, extra: Partial<Turn> = {}) => render(transcript([agent(1, text, extra)]));
const dialog = () => document.querySelector('dialog.awwo-artifact-dialog') as HTMLElement | null;
const anyReader = /^放大阅读/;
const delivered = (outputs: Array<{ id: string; label: string; type: string }>, values: Record<string, string>) => ({
  presentation: { outputState: 'final', outputContract: { version: 1, inputs: [], outputs: outputs.map(output => ({ ...output, required: false, value: '' })) } },
  text: JSON.stringify(values),
});

describe('the full-size reader of a reply', () => {
  it('is offered for a reply with a table or a long one, not for a short line, a user message or failure evidence', () => {
    expect(readerWorthy(table)).toBe(true);
    expect(readerWorthy('好的，已经改好了。')).toBe(false);
    expect(readerWorthy('长'.repeat(600))).toBe(true);
    show(table);
    // The button names the reply it opens, so two long replies' buttons are told apart.
    expect(screen.getByRole('button', { name: '放大阅读：评分表' })).toBeTruthy();
    cleanup();
    show('好的，已经改好了。');
    expect(screen.queryByRole('button', { name: anyReader })).toBeNull();
    cleanup();
    show(table, { role: 'user' });
    expect(screen.queryByRole('button', { name: anyReader })).toBeNull();
    cleanup();
    show(table, { tone: 'error' });
    expect(screen.queryByRole('button', { name: anyReader })).toBeNull();
  });

  it('opens the same reply, its table whole, at a text size it keeps for the next reading', () => {
    show(table);
    expect(dialog()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '放大阅读：评分表' }));
    const reader = within(dialog()!);
    expect(reader.getByRole('heading', { name: '回复全文 · 评分表' })).toBeTruthy();
    expect(reader.getByRole('heading', { name: '评分表' })).toBeTruthy();
    expect(reader.getByRole('table')).toBeTruthy();
    expect(reader.getByText('100% 的场景切换落在重拍上，偏差不超过 1 帧')).toBeTruthy();
    const body = reader.getByTestId('reply-reader-body');
    expect(body.style.fontSize).toBe('16px');
    fireEvent.click(reader.getByRole('button', { name: '放大文字' }));
    fireEvent.click(reader.getByRole('button', { name: '放大文字' }));
    expect(body.style.fontSize).toBe('20px');
    expect(localStorage.getItem(READER_TEXT_SIZE_KEY)).toBe('20');
    fireEvent.click(reader.getByRole('button', { name: '缩小文字' }));
    expect(body.style.fontSize).toBe('18px');
    // The largest and smallest sizes stop there; the button at its end stays focusable and does nothing.
    for (let i = 0; i < 9; i++) fireEvent.click(reader.getByRole('button', { name: '缩小文字' }));
    expect(body.style.fontSize).toBe('13px');
    const smaller = reader.getByRole('button', { name: '缩小文字' });
    expect(smaller).toHaveAttribute('aria-disabled', 'true');
    expect(smaller).not.toBeDisabled();
    expect(reader.getByRole('button', { name: '放大文字' })).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(smaller);
    expect(body.style.fontSize).toBe('13px');
    expect(localStorage.getItem(READER_TEXT_SIZE_KEY)).toBe('13');
    fireEvent.click(reader.getByRole('button', { name: '关闭回复全文' }));
    expect(dialog()).toBeNull();
    // The next reading starts at the size last chosen.
    fireEvent.click(screen.getByRole('button', { name: '放大阅读：评分表' }));
    expect(within(dialog()!).getByTestId('reply-reader-body').style.fontSize).toBe('13px');
  });

  it('reads a reply delivered as fields as the conversation shows them: each under its label, a text field as typed', () => {
    const reply = delivered([{ id: 'result', label: '交付结果', type: 'markdown' }, { id: 'followUp', label: '后续事项', type: 'text' }],
      { result: `${table}\n\n${'说明'.repeat(320)}`, followUp: '确认评分表\n* 再发给我' });
    render(transcript([agent(1, reply.text, { presentation: reply.presentation } as unknown as Partial<Turn>)]));
    expect(screen.getByRole('heading', { name: '交付结果' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '放大阅读：评分表' }));
    const open = dialog()!;
    const reader = within(open);
    expect(reader.getByRole('heading', { name: '交付结果' })).toBeTruthy();
    expect(reader.getByRole('heading', { name: '后续事项' })).toBeTruthy();
    expect(reader.getByRole('table')).toBeTruthy();
    // The text field is not read as Markdown: its lines and its star come as typed, no list made of them.
    const typed = Array.from(open.querySelectorAll('.canvas-transcript-field-value')).map(element => element.textContent);
    expect(typed).toEqual(['确认评分表\n* 再发给我']);
    expect(open.querySelector('.canvas-transcript-field-value ul, .canvas-transcript-field-value li')).toBeNull();
  });

  it('is not offered for what a person does not read there: a delivered page opens in its own preview', () => {
    const page = `<!DOCTYPE html><html><head><title>方案</title></head><body>${'<p>方案页面的正文。</p>'.repeat(60)}</body></html>`;
    expect(page.length).toBeGreaterThan(600);
    const reply = delivered([{ id: 'page', label: '页面', type: 'html' }, { id: 'note', label: '说明', type: 'text' }], { page, note: '页面已生成。' });
    render(transcript([agent(1, reply.text, { presentation: reply.presentation } as unknown as Partial<Turn>)]));
    expect(screen.getByRole('heading', { name: '页面' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: anyReader })).toBeNull();
  });

  it('names a reply by its words in either language, not by a code fence’s language', () => {
    const code = `\`\`\`python\nimport numpy as np\n${'frames = []\n'.repeat(60)}\`\`\``;
    render(transcript([agent(1, code)]));
    expect(screen.getByRole('button', { name: '放大阅读：import numpy as np' })).toBeTruthy();
    cleanup();
    render(<LocaleProvider locale="en">{transcript([agent(1, table)])}</LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Read full size: 评分表' }));
    expect(within(dialog()!).getByRole('heading', { name: 'Full reply · 评分表' })).toBeTruthy();
  });

  it('opens each long reply on its own', () => {
    render(transcript([agent(1, `# 第一份方案\n\n${'内容'.repeat(400)}`), agent(2, `# 第二份方案\n\n${'细节'.repeat(400)}`)]));
    expect(screen.getAllByRole('button', { name: anyReader })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '放大阅读：第二份方案' }));
    const reader = within(dialog()!);
    expect(reader.getByRole('heading', { name: '回复全文 · 第二份方案' })).toBeTruthy();
    expect(reader.getByRole('heading', { name: '第二份方案' })).toBeTruthy();
    expect(reader.queryByRole('heading', { name: '第一份方案' })).toBeNull();
  });

  it('keeps a double-click in the reader there: it does not reach the canvas behind it', () => {
    // The canvas opens and zooms a node on a double-click; the reader is portalled out of the node but React still
    // bubbles its events through the node, so selecting a word in the reader must not count as one on the canvas.
    const canvasDoubleClick = vi.fn();
    render(<div onDoubleClick={canvasDoubleClick}>{transcript([agent(1, table)])}</div>);
    fireEvent.doubleClick(screen.getByText('100% 的场景切换落在重拍上，偏差不超过 1 帧'));
    expect(canvasDoubleClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '放大阅读：评分表' }));
    fireEvent.doubleClick(within(dialog()!).getByText('100% 的场景切换落在重拍上，偏差不超过 1 帧'));
    expect(canvasDoubleClick).toHaveBeenCalledTimes(1);
  });
});
