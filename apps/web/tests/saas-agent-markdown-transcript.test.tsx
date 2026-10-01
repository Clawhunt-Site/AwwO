import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import type { Turn } from '../src/canvas/sessions';

afterEach(cleanup);

function show(text: string, extra: Partial<Turn> = {}) {
  const turn = Object.freeze({ id: 1, role: 'agent' as const, text, ...extra });
  const result = render(<TileTranscript turns={[turn]} history="loaded" streaming={extra.presentation?.outputState === 'streaming'} limit={Infinity} />);
  return { ...result, turn };
}

describe('ordinary agent Markdown', () => {
  it('renders readable headings, emphasis, lists and tables from a restored reply without changing it', () => {
    const source = '## 短版文案\n\n**AwwO**，让工作可编排。\n\n- 拆解目标\n- 分配执行\n\n| 步骤 | 状态 |\n| --- | --- |\n| 交付 | 完成 |';
    const { container, turn } = show(source);
    expect(screen.getByRole('heading', { name: '短版文案' })).toBeTruthy();
    expect(screen.getByText('AwwO').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.querySelector('.canvas-transcript-table')).toBeTruthy();
    expect(turn.text).toBe(source);
  });

  it('renders streaming prose through the same safe surface without inventing completion', () => {
    show('**正在整理**执行结果', { presentation: { outputState: 'streaming' } });
    expect(screen.getByText('正在整理').tagName).toBe('STRONG');
    expect(screen.queryByText('运行完成')).toBeNull();
  });

  it('keeps ordinary user text verbatim', () => {
    const source = '## 不要改写\n请保留 **这些标记**。';
    const { container } = show(source, { role: 'user' });
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toBe(source);
    expect(container.querySelector('h2, strong')).toBeNull();
  });

  it.each(['error', 'warn'] as const)('keeps %s evidence verbatim', tone => {
    const source = '## 上游未完成\n**保留错误原文**';
    const { container } = show(source, { tone });
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toBe(source);
    expect(container.querySelector('h2, strong')).toBeNull();
  });

  it('keeps an explicitly failed reply verbatim without requiring a tone', () => {
    const source = '**部分结果**';
    const { container } = show(source, { presentation: { outputState: 'failed' } });
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toBe(source);
    expect(container.querySelector('strong')).toBeNull();
  });

  it('retains the validation notice and exact invalid output', () => {
    const source = '## Not the requested number\n**invalid**';
    const { container } = show(source, { presentation: { outputState: 'final', outputContract: { version: 1, inputs: [], outputs: [
      { id: 'count', label: '数量', type: 'number', required: true, value: '' },
    ] } } });
    expect(screen.getByRole('status')).toHaveTextContent('结果格式需要修复');
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toContain(source);
    expect(container.querySelector('h2, strong')).toBeNull();
  });

  it.each(['{"result":"**原始封装**"}', '["**原始封装**"]', '[1, 2.5, -3]', '["**原始封装**", 1, null, {"ok":true}]', '```json\n{"result":"**原始封装**"}\n```'])('keeps an unprojected raw envelope intact: %s', source => {
    const { container } = show(source);
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toBe(source);
    expect(container.querySelector('strong')).toBeNull();
  });

  it('turns remote images into explicit links without passive image requests', () => {
    const { container } = show('![交付截图](https://assets.example.test/pixel?private=1)');
    expect(container.querySelector('img, source, iframe, link[rel="preload"]')).toBeNull();
    const link = screen.getByRole('link', { name: '交付截图' });
    expect(link).toHaveAttribute('href', 'https://assets.example.test/pixel?private=1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not confuse a leading Markdown link with a JSON array', () => {
    show('[文档](https://example.test/docs)');
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('href', 'https://example.test/docs');
  });

  it('escapes HTML, refuses unsafe URLs and keeps safe links usable', () => {
    const source = '<script>alert(1)</script>\n\n[文档](https://example.test/docs) [危险](javascript:alert%281%29)\n\n![危险图片](data:image/svg+xml;base64,PHN2Zy8+)';
    const { container, turn } = show(source);
    expect(container.querySelector('script, img, svg')).toBeNull();
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('href', 'https://example.test/docs');
    expect(screen.getByText('危险').getAttribute('href')).not.toMatch(/^javascript:/i);
    expect(screen.getByText('危险图片').getAttribute('href')).toBeNull();
    expect(turn.text).toBe(source);
  });
});
