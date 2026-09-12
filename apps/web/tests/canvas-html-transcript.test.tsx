import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { LocaleProvider } from '../src/canvas/i18n';
import type { NodeContract } from '../src/canvas/nodeContracts';
import type { Turn } from '../src/canvas/sessions';

afterEach(cleanup);

const html = '<!doctype html>\n<html><head><style>body { color: green; }</style></head><body><h1>Exact page</h1><script>window.untrusted = true</script></body></html>';
const contract: NodeContract = { version: 1, inputs: [], outputs: [
  { id: 'page', label: 'Page', type: 'html', required: true, value: '' },
] };
const ready = 'HTML 文档已生成，可在右侧交付物预览。';
const unconfirmed = 'HTML 文档已返回，尚未确认为最终交付物。';

function transcript(turn: Turn, locale: 'zh' | 'en' = 'zh') {
  return render(<LocaleProvider locale={locale}><TileTranscript turns={[turn]} history="loaded"
    streaming={turn.presentation?.outputState === 'streaming'} limit={Infinity} /></LocaleProvider>);
}

function reply(text = html, overrides: Partial<Turn> = {}): Turn {
  return { id: 1, role: 'agent', text, presentation: { outputState: 'final', outputContract: contract }, ...overrides };
}

describe('HTML in the conversation', () => {
  it.each([
    ['zh', false, ready, '查看 HTML 源码'],
    ['zh', true, ready, '查看 HTML 源码'],
    ['en', false, 'HTML document generated. Preview it in the deliverables panel on the right.', 'View HTML source'],
    ['en', true, 'HTML document generated. Preview it in the deliverables panel on the right.', 'View HTML source'],
  ] as const)('summarizes complete %s HTML, retaining the exact source (fenced=%s)', (locale, fenced, summary, disclosure) => {
    const text = fenced ? `\`\`\`html\n${html}\n\`\`\`` : html;
    const { container } = transcript(reply(text), locale);
    expect(screen.getByText(summary)).toBeInTheDocument();
    const details = screen.getByText(disclosure).closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe(text);
    expect(container.querySelector('script, style, iframe, h1')).toBeNull();
    details.open = true;
    expect(details).toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe(text);
  });

  it.each(['streaming', 'failed', undefined] as const)('does not call a complete document final when its state is %s', outputState => {
    transcript(reply(html, { presentation: outputState ? { outputState, outputContract: contract } : undefined }));
    expect(screen.getByText(unconfirmed)).toBeInTheDocument();
    expect(screen.queryByText(ready)).toBeNull();
    expect(screen.getByText('查看 HTML 源码').closest('details')!.querySelector('pre')!.textContent).toBe(html);
  });

  it.each(['proposal', 'review'] as const)('keeps a successful %s document a candidate', phase => {
    transcript(reply(html, { runId: 'run-1', collaboration: {
      nodeId: 'node-1', sessionId: 'session-1', runId: 'run-1', round: 1, phase, goal: 'Build a page',
    } }));
    expect(screen.getByText(unconfirmed)).toBeInTheDocument();
    expect(screen.queryByText(ready)).toBeNull();
  });

  it('preserves a format failure and never claims that the HTML is a valid delivery', () => {
    const outputContract: NodeContract = { ...contract, outputs: [...contract.outputs,
      { id: 'notes', label: 'Notes', type: 'markdown', required: true, value: '' },
    ] };
    transcript(reply(html, { presentation: { outputState: 'final', outputContract } }));
    expect(screen.getByRole('status')).toHaveTextContent('结果格式需要修复');
    expect(screen.getByText(unconfirmed)).toBeInTheDocument();
  });

  it('folds an HTML field while preserving Markdown rendering and the complete original envelope', () => {
    const outputContract: NodeContract = { ...contract, outputs: [...contract.outputs,
      { id: 'notes', label: 'Notes', type: 'markdown', required: true, value: '' },
    ] };
    const text = JSON.stringify({ page: html, notes: '## Report\n\n**Readable** notes' });
    const { container } = transcript(reply(text, { presentation: { outputState: 'final', outputContract } }));
    expect(screen.getByText(ready)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByText('Readable').tagName).toBe('STRONG');
    expect(container.querySelector('.canvas-transcript-fields')!.textContent).not.toContain('<html>');
    const details = screen.getByText('查看原始回复').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe(text);
  });

  it.each([
    '<html><head></head><body>Still streaming',
    '<h1>An HTML fragment</h1>',
    '## Plain Markdown\n\nUse **bold** here.',
    'Discuss the literal <html> tag here.',
  ])('leaves ordinary text, Markdown and incomplete HTML unchanged: %s', text => {
    const { container } = transcript(reply(text, { presentation: undefined }));
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toBe(text);
    expect(container.querySelector('details')).toBeNull();
  });

  it('leaves a user-authored complete HTML message unchanged', () => {
    const { container } = transcript({ id: 1, role: 'user', text: html });
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toBe(html);
    expect(container.querySelector('details, script, h1')).toBeNull();
  });
});
