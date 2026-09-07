import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { LocaleProvider } from '../src/canvas/i18n';
import type { NodeContract } from '../src/canvas/nodeContracts';
import type { Turn } from '../src/canvas/sessions';

afterEach(cleanup);

const contract: NodeContract = { version: 1, inputs: [], outputs: [
  { id: 'result', label: '本次结果', type: 'markdown', required: true, value: '不可显示的表单草稿' },
  { id: 'count', label: '检查数量', type: 'number', required: false, value: '' },
  { id: 'passed', label: '检查通过', type: 'boolean', required: false, value: '' },
  { id: 'file', label: '文件位置', type: 'file', required: false, value: '' },
] };

function finalTurn(text: string, over: Partial<Turn> = {}): Turn {
  return { id: 1, role: 'agent', text, presentation: { outputState: 'final', outputContract: contract }, ...over };
}

function transcript(turns: Turn[], streaming = false) {
  return render(<TileTranscript turns={turns} history="loaded" streaming={streaming} limit={Infinity} />);
}

describe('readable node transcript', () => {
  it.each([false, true])('renders a validated final JSON reply as fields and keeps the exact raw reply (fenced=%s)', fenced => {
    const json = JSON.stringify({ result: '## 会员页面\n\n**已完成**页面和键盘交互。', count: 3, passed: true, file: '/workspace/member.tsx', extra: '未声明内容' });
    const text = fenced ? `\`\`\`json\n${json}\n\`\`\`` : json;
    const { container } = transcript([finalTurn(text)]);
    expect(screen.getByRole('heading', { name: '本次结果' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '会员页面' })).toBeTruthy();
    expect(screen.getByText('已完成').tagName).toBe('STRONG');
    const fields = container.querySelector('.canvas-transcript-fields')!;
    expect(fields.textContent).toContain('检查数量3');
    expect(fields.textContent).toContain('检查通过true');
    expect(fields.textContent).not.toContain('未声明内容');
    expect(fields.textContent).not.toContain('不可显示的表单草稿');
    expect(screen.getByText('/workspace/member.tsx').tagName).toBe('CODE');
    expect(screen.queryByRole('link')).toBeNull();
    const details = screen.getByText('查看原始回复').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe(text);
    details.open = true;
    expect(details).toHaveAttribute('open');
    expect(screen.queryByText('运行完成')).toBeNull();
  });

  it.each(['streaming', 'failed'] as const)('does not project a %s reply even when the entire JSON already arrived', outputState => {
    const text = '{"result":"## 未确认结果"}';
    transcript([finalTurn(text, { presentation: { outputState, outputContract: contract } })], outputState === 'streaming');
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText('查看原始回复')).toBeNull();
    expect(screen.queryByText(/结果格式需要修复/)).toBeNull();
  });

  it.each(['error', 'warn'] as const)('keeps a %s reply unprojected even with conflicting final metadata', tone => {
    const text = '{"result":"## 错误证据"}';
    transcript([finalTurn(text, { tone })]);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('keeps previous confirmed output readable while another turn is streaming', () => {
    transcript([
      finalTurn('{"result":"## 上次结果"}'),
      finalTurn('{"result":', { id: 2, presentation: { outputState: 'streaming', outputContract: contract } }),
    ], true);
    expect(screen.getByRole('heading', { name: '上次结果' })).toBeTruthy();
    expect(screen.getByText('{"result":')).toBeTruthy();
  });

  it.each(['{"count":3}', '{"result":42}', '{"result":"有效文字","count":"three"}', '尚未输出 JSON'])('preserves invalid final output without manufacturing fields: %s', text => {
    const { container } = transcript([finalTurn(text)]);
    expect(container.querySelector('.canvas-transcript-fields')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('结果格式需要修复');
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toContain(text);
    expect(screen.queryByText('查看原始回复')).toBeNull();
  });

  it.each([
    undefined,
    { outputState: 'final' as const },
    { outputState: 'final' as const, outputContract: { version: 1 as const, inputs: [], outputs: [] } },
  ])('does not infer a schema or completion from unknown legacy JSON', presentation => {
    const text = '{"result":"## 旧消息标题"}';
    transcript([finalTurn(text, { presentation })]);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('preserves plain text allowed by a single-field contract without inventing a format error', () => {
    const outputContract: NodeContract = { ...contract, outputs: [contract.outputs[0]] };
    const text = '## 合法纯文本\n这段不需要 JSON 包装。';
    const { container } = transcript([finalTurn(text, { presentation: { outputState: 'final', outputContract } })]);
    expect(container.querySelector('.canvas-transcript-turn')!.textContent).toBe(text);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the exact manual request and discloses its complete execution input', () => {
    const text = '【工作流节点】前端\n【输出要求】JSON\n【用户消息】把会员详情改成抽屉';
    transcript([{ id: 1, role: 'user', text, presentation: { inputKind: 'manual', displayText: '把会员详情改成抽屉' } }]);
    expect(screen.getByText('把会员详情改成抽屉', { exact: true })).toBeTruthy();
    const details = screen.getByText('本轮输入与执行详情').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe(text);
  });

  it.each([
    ['zh', '会话背景'],
    ['en', 'Conversation context'],
  ] as const)('folds explicit issue context in %s while preserving the real request as its own turn', (locale, label) => {
    const text = `【工作流节点】前端\n${'完整输入与输出约束。'.repeat(70)}`;
    const turns: Turn[] = [
      { id: 1, role: 'user', text, nativeSource: 'issue_description' },
      { id: 2, role: 'user', text, nativeCommentId: 'comment-1',
        presentation: { inputKind: 'manual', displayText: '把会员详情改成抽屉' } },
    ];
    const { container } = render(<LocaleProvider locale={locale}><TileTranscript turns={turns} history="loaded" streaming={false} limit={Infinity} /></LocaleProvider>);
    const context = screen.getByText(label).closest('details')!;
    expect(context).not.toHaveAttribute('open');
    expect(context.querySelector('pre')!.textContent).toBe(text);
    context.open = true;
    expect(context).toHaveAttribute('open');
    expect(screen.getByText('把会员详情改成抽屉', { exact: true })).toBeInTheDocument();
    const visibleTurns = container.querySelectorAll('.canvas-transcript-turn--user');
    expect(visibleTurns).toHaveLength(2);
    expect(visibleTurns[1].querySelector('pre')!.textContent).toBe(text);
  });

  it('identifies workflow execution separately from a human request', () => {
    const text = '完整工作流输入，保留真实原文。';
    transcript([{ id: 1, role: 'user', text, presentation: { inputKind: 'workflow' } }]);
    expect(screen.getByText('工作流执行请求')).toBeTruthy();
    expect(screen.getByText('本轮输入与执行详情').closest('details')!.querySelector('pre')!.textContent).toBe(text);
  });

  it('never strips unknown user text resembling an execution envelope', () => {
    const text = '我想讨论【工作流节点】和【用户消息】这些字面文字，不要删除。';
    const { container } = transcript([{ id: 1, role: 'user', text }]);
    expect(screen.getByText(text)).toBeTruthy();
    expect(container.querySelector('details')).toBeNull();
  });

  it('folds a long unknown historical message whole without labeling it as a workflow', () => {
    const text = `这是用户自己的长文章，${'必须逐字保留。'.repeat(200)}`;
    transcript([{ id: 1, role: 'user', text }]);
    const details = screen.getByText('历史消息').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe(text);
    expect(screen.queryByText('工作流执行请求')).toBeNull();
  });

  it('keeps explicitly known legacy execution input available', () => {
    const text = '可信恢复标注的历史执行消息';
    transcript([{ id: 1, role: 'user', text, presentation: { inputKind: 'legacy-execution' } }]);
    const details = screen.getByText('历史执行消息').closest('details')!;
    expect(details.querySelector('pre')!.textContent).toBe(text);
  });

  it('renders tables and sanitizes active HTML and unsafe Markdown links', () => {
    const result = '| 项目 | 结论 |\n| --- | --- |\n| 登录 | 通过 |\n\n<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)';
    const { container } = transcript([finalTurn(JSON.stringify({ result }))]);
    const fields = container.querySelector('.canvas-transcript-fields') as HTMLElement;
    expect(within(fields).getByRole('table')).toBeTruthy();
    expect(fields.querySelector('script')).toBeNull();
    expect(fields.querySelector('a')?.getAttribute('href')).not.toMatch(/^javascript:/i);
    expect(container.querySelector('details pre')!.textContent).toBe(JSON.stringify({ result }));
  });

  it('keeps remote images as explicit links without creating passive image requests', () => {
    const result = '![页面预览](https://attacker.example/pixel?project=private "示例图片")';
    const { container } = transcript([finalTurn(JSON.stringify({ result }))]);
    expect(container.querySelector('img, source, link[rel="preload"]')).toBeNull();
    const reference = screen.getByRole('link', { name: '页面预览' });
    expect(reference).toHaveAttribute('href', 'https://attacker.example/pixel?project=private');
    expect(reference).toHaveAttribute('title', '示例图片');
    expect(reference).toHaveAttribute('target', '_blank');
    expect(reference).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('details pre')!.textContent).toBe(JSON.stringify({ result }));
  });

  it('uses the safe image URL as the reference label when the Markdown alt is empty', () => {
    const result = '![](https://example.test/screenshot.png)';
    const { container } = transcript([finalTurn(JSON.stringify({ result }))]);
    expect(screen.getByRole('link', { name: 'https://example.test/screenshot.png' })).toHaveAttribute('href', 'https://example.test/screenshot.png');
    expect(container.querySelector('img')).toBeNull();
  });

  it.each(['javascript:alert%281%29', 'data:image/svg+xml;base64,PHN2Zy8+', 'file:///private/screenshot.png'])(
    'preserves the alt while refusing an unsafe image reference URL: %s', src => {
      const result = `![原始图片说明](${src})`;
      const { container } = transcript([finalTurn(JSON.stringify({ result }))]);
      const fields = container.querySelector('.canvas-transcript-fields') as HTMLElement;
      expect(within(fields).getByText('原始图片说明')).toBeTruthy();
      expect(within(fields).queryByRole('link')).toBeNull();
      expect(container.querySelector('img, source, link[rel="preload"]')).toBeNull();
      expect(container.querySelector('details pre')!.textContent).toBe(JSON.stringify({ result }));
    },
  );

  it('translates disclosure actions in English', () => {
    render(<LocaleProvider locale="en"><TileTranscript turns={[finalTurn('{"result":"Ready"}')]} history="loaded" streaming={false} limit={Infinity} /></LocaleProvider>);
    expect(screen.getByText('View original response')).toBeTruthy();
    expect(screen.queryByText('查看原始回复')).toBeNull();
  });
});
