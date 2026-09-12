import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { createAgentTemplate, getAgentTemplateForNode } from '../src/canvas/agentTemplates';
import type { ContractField } from '../src/canvas/nodeContracts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const field = (over: Partial<ContractField> = {}): ContractField => ({
  id: 'summary', label: '交付说明', type: 'markdown', required: true, value: '尚未发布的草稿', ...over,
});
const node = (over: Partial<SessionNode> = {}): SessionNode => ({
  ...createSessionNode('coding', { x: 0, y: 0 }),
  id: 'frontend', title: '前端',
  contract: { version: 1, inputs: [], outputs: [field()] },
  ...over,
});

describe('node deliverables', () => {
  const html = '<!doctype html><html><head><title>页面</title></head><body><script>window.__unsafe = true</script><img src="https://example.com/private.png"><h1>交付页面</h1></body></html>';

  it('defaults to an isolated HTML preview while keeping exact source available', () => {
    const { container } = render(<NodeDeliverables node={node({
      contract: { version: 1, inputs: [], outputs: [field({ type: 'html', value: '' })] },
      lastOutput: { text: html, at: 1, source: 'run' },
    })} readOnly />);
    const preview = screen.getByTitle('交付说明 · HTML 预览');
    expect(preview).toHaveAttribute('sandbox', '');
    expect(preview.getAttribute('srcdoc')).toContain('<h1>交付页面</h1>');
    expect(preview.getAttribute('srcdoc')).not.toContain('window.__unsafe');
    expect(container.querySelector('script, img')).toBeNull();
    expect(screen.getByRole('button', { name: '下载 .html' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '交付页面' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '源码', exact: true }));
    expect(screen.getByLabelText('HTML 源码')).toHaveTextContent(html);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it.each(['html', 'markdown'] as const)('downloads exactly the published %s source with matching file type', async type => {
    const source = type === 'html' ? html : '# 文档\n\n源文本 **不改变**。';
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:awwo-delivery'; });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let savedName = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { savedName = this.download; });
    try {
      render(<NodeDeliverables node={node({
        contract: { version: 1, inputs: [], outputs: [field({ type, label: 'report', value: '' })] },
        lastOutput: { text: type === 'html' ? `\u0060\u0060\u0060html\n${source}\n\u0060\u0060\u0060` : source, at: 1, source: 'run' },
      })} readOnly />);
      fireEvent.click(screen.getByRole('button', { name: `下载 .${type === 'html' ? 'html' : 'md'}` }));
      expect(savedName).toBe(type === 'html' ? 'report.html' : 'report.md');
      expect(blobs).toHaveLength(1);
      const downloaded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blobs[0]);
      });
      expect(downloaded).toBe(source);
      expect(blobs[0].type).toContain(type === 'html' ? 'text/html' : 'text/markdown');
      expect(document.querySelector('a[download]')).toBeNull();
    } finally { click.mockRestore(); }
  });

  it('does not publish or offer an HTML download for a file path or malformed source', () => {
    const update = vi.fn();
    render(<NodeDeliverables node={node({
      contract: { version: 1, inputs: [], outputs: [field({ type: 'html', value: '/tmp/report.html' })] },
      lastOutput: { text: '/tmp/report.html', at: 1, source: 'run' },
    })} readOnly={false} onUpdateNode={update} />);
    expect(screen.queryByRole('button', { name: '下载 .html' })).toBeNull();
    fireEvent.click(screen.getByText('编辑输出表单'));
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('完整 HTML'))).toBe(true);
  });

  it.each(['frontend', 'data'] as const)('shows the %s role title and truthful empty state without creating a delivery', role => {
    const current = createAgentTemplate(role, { x: 0, y: 0 });
    const title = getAgentTemplateForNode(current)!.deliverableTitle;
    const update = vi.fn();
    const { container } = render(<NodeDeliverables node={current} readOnly={false} onUpdateNode={update} />);
    expect(screen.getByRole('heading', { name: title, exact: true })).toBeTruthy();
    expect(screen.getByText(`还没有${title}`)).toBeTruthy();
    expect(container.querySelector('.awwo-deliverable')).toBeNull();
    expect(current.lastOutput).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('shows an honest empty state and keeps output forms collapsed by default', () => {
    const { container } = render(<NodeDeliverables node={node()} readOnly={false} onUpdateNode={vi.fn()} />);
    expect(screen.getByText('还没有交付物')).toBeTruthy();
    expect(container.querySelector('.awwo-deliverable')).toBeNull();
    expect(screen.getByText('编辑输出表单').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('lists the expected delivery fields as pending without inventing an output result', () => {
    const current = node({ contract: { version: 1, inputs: [], outputs: [
      field({ label: '实现说明' }), field({ id: 'preview', label: '界面预览', type: 'file', value: '' }),
    ] } });
    const { container } = render(<NodeDeliverables node={current} readOnly />);
    const expected = within(screen.getByRole('list', { name: '待交付内容' }));
    expect(expected.getByText('实现说明')).toBeTruthy();
    expect(expected.getByText('界面预览')).toBeTruthy();
    expect(expected.getAllByText('待交付')).toHaveLength(2);
    expect(expected.queryByText('尚未发布的草稿')).toBeNull();
    expect(screen.queryByTestId('canvas-tile-output-frontend')).toBeNull();
    expect(container.querySelector('.awwo-deliverable')).toBeNull();
  });

  it('renders published fields as formatted content rather than output-form drafts', () => {
    const { container } = render(<NodeDeliverables node={node({
      lastOutput: { text: JSON.stringify({ summary: '## 登录页\n\n**键盘可用**，支持错误提示。', hidden: '未声明字段' }), at: 1, source: 'manual' },
    })} readOnly />);
    const artifact = container.querySelector('.awwo-deliverable') as HTMLElement;
    expect(within(artifact).getByText('交付说明')).toBeTruthy();
    expect(within(artifact).getByRole('heading', { name: '登录页' })).toBeTruthy();
    expect(within(artifact).getByText('键盘可用').tagName).toBe('STRONG');
    expect(artifact.textContent).not.toContain('尚未发布的草稿');
    expect(artifact.textContent).not.toContain('未声明字段');
    expect(screen.getByText('手动采用')).toBeTruthy();
  });

  it('shows the selected Session history without publishing it downstream', () => {
    const update = vi.fn();
    const selected = node({
      lastOutput: null,
      threads: [{
        id: 'default', title: 'Session 1', issueId: 'original-issue', preview: '', draft: '', createdAt: 1,
        lastOutput: { text: JSON.stringify({ summary: '## 历史登录页\n\n已保留的旧交付。' }), at: 1, source: 'manual' },
      }],
    });
    const { rerender } = render(<NodeDeliverables node={selected} readOnly={false} onUpdateNode={update} />);
    expect(screen.getByText('历史交付 · 未传递给下游')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '历史登录页' })).toBeTruthy();
    expect(screen.queryByText('还没有交付物')).toBeNull();
    expect(selected.lastOutput).toBeNull();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('编辑输出表单'));
    expect(screen.getByRole('button', { name: '发布输出' })).not.toBeDisabled();
    rerender(<NodeDeliverables node={{ ...selected, lastOutput: { text: '## 本次交付', at: 2 } }} readOnly={false} onUpdateNode={update} />);
    expect(screen.getByRole('heading', { name: '本次交付' })).toBeTruthy();
    expect(screen.queryByText('历史交付 · 未传递给下游')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('labels partial results and preserves malformed output as evidence', () => {
    render(<NodeDeliverables node={node({
      contract: { version: 1, inputs: [], outputs: [field({ type: 'number' })] },
      lastOutput: { text: '执行中断：仅完成迁移', at: 1, partial: true },
    })} readOnly />);
    expect(screen.getByText('部分结果 · 未完成')).toBeTruthy();
    expect(screen.getByText('执行中断：仅完成迁移')).toBeTruthy();
    expect(screen.getByText('输出未通过表单校验')).toBeTruthy();
    expect(screen.queryByText('运行完成')).toBeNull();
  });

  it('displays file references without inventing downloads or uploaded files', () => {
    render(<NodeDeliverables node={node({
      contract: { version: 1, inputs: [], outputs: [field({ id: 'asset', label: '素材位置', type: 'file' })] },
      lastOutput: { text: JSON.stringify({ asset: '/workspace/assets/logo.svg' }), at: 1 },
    })} readOnly />);
    expect(screen.getByText('/workspace/assets/logo.svg')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('rejects invalid manual output and publishes only validated values', () => {
    const updates = vi.fn();
    function Editor() {
      const [current, setCurrent] = useState(node({
        contract: { version: 1, inputs: [], outputs: [field({ id: 'count', label: '数量', type: 'number', value: '' })] },
      }));
      return <NodeDeliverables node={current} readOnly={false} onUpdateNode={next => { updates(next); setCurrent(next); }} />;
    }
    render(<Editor />);
    fireEvent.click(screen.getByText('编辑输出表单'));
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    expect(updates).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('数量的值'), { target: { value: '3' } });
    expect(updates.mock.lastCall?.[0].lastOutput).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    expect(updates.mock.lastCall?.[0].lastOutput).toEqual({ text: '{"count":3}', at: expect.any(Number), source: 'manual' });
    expect(screen.getByText('手动采用')).toBeTruthy();
  });

  it('never publishes output guidance as a result or lets it satisfy a required field', () => {
    const update = vi.fn();
    const current = node({ contract: { version: 1, inputs: [], outputs: [field({
      value: '', help: '描述本次实际完成的交付。', placeholder: '例如：界面已实现、检查通过',
    })] } });
    const { rerender } = render(<NodeDeliverables node={current} readOnly={false} onUpdateNode={update} />);
    fireEvent.click(screen.getByText('编辑输出表单'));
    expect(screen.getByLabelText('交付说明的值')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('还没有交付物')).toBeTruthy();
    const filled = { ...current, contract: { ...current.contract!, outputs: [{ ...current.contract!.outputs[0], value: '已验证的交付内容' }] } };
    rerender(<NodeDeliverables node={filled} readOnly={false} onUpdateNode={update} />);
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    expect(update.mock.lastCall?.[0].lastOutput.text).toBe('{"summary":"已验证的交付内容"}');
    expect(update.mock.lastCall?.[0].lastOutput.text).not.toContain('例如');
    expect(update.mock.lastCall?.[0].lastOutput.text).not.toContain('描述本次');
  });

  it('does not allow publication or form changes while locked', () => {
    const update = vi.fn();
    render(<NodeDeliverables node={node()} readOnly onUpdateNode={update} />);
    fireEvent.click(screen.getByText('编辑输出表单'));
    expect(screen.getByRole('button', { name: '发布输出' })).toBeDisabled();
    expect(screen.getByLabelText('交付说明的值')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '发布输出' }));
    expect(update).not.toHaveBeenCalled();
  });
});

describe('local delivery file references', () => {
  function publishedMarkdown(text: string, raw = false) {
    return node({
      contract: { version: 1, inputs: [], outputs: raw ? [] : [field()] },
      lastOutput: { text: raw ? text : JSON.stringify({ summary: text }), at: 1, source: 'run' },
    });
  }

  it.each([false, true])('renders the actual Windows report link as a copyable path (raw=%s)', async (raw) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const current = publishedMarkdown('[验收报告](/C:/tmp/awwo/acceptance-report.md)', raw);
    const before = structuredClone(current);
    const update = vi.fn();
    render(<NodeDeliverables node={current} readOnly onUpdateNode={update} />);
    expect(screen.getByText('验收报告')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '验收报告' })).toBeNull();
    expect(screen.getByText('C:/tmp/awwo/acceptance-report.md').tagName).toBe('CODE');
    fireEvent.click(screen.getByRole('button', { name: /复制路径/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制'));
    expect(writeText).toHaveBeenCalledWith('C:/tmp/awwo/acceptance-report.md');
    expect(current).toEqual(before);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['C:/tmp/report.md', 'C:/tmp/report.md'],
    ['C:\\tmp\\report.md', 'C:\\tmp\\report.md'],
    ['/C:/tmp/release%20notes.md', 'C:/tmp/release notes.md'],
    ['file:///C:/tmp/release%20notes.md', 'C:/tmp/release notes.md'],
    ['file:///tmp/report.md', '/tmp/report.md'],
  ])('keeps the full local path for %s without a navigable href', (href, path) => {
    render(<NodeDeliverables node={publishedMarkdown(`[报告](<${href}>)`)} readOnly />);
    expect(screen.queryByRole('link', { name: '报告' })).toBeNull();
    expect(screen.getByText(path).tagName).toBe('CODE');
    expect(screen.getByRole('button', { name: /复制路径/ })).toBeTruthy();
  });

  it.each(['C:\\tmp\\report.md', '/workspace/reports/report.md'])('also copies a plain file output %s', async (path) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<NodeDeliverables node={node({
      contract: { version: 1, inputs: [], outputs: [field({ id: 'report', type: 'file' })] },
      lastOutput: { text: JSON.stringify({ report: path }), at: 1, source: 'run' },
    })} readOnly />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(path).tagName).toBe('CODE');
    fireEvent.click(screen.getByRole('button', { name: /复制路径/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
  });

  it.each(['denied', 'unavailable'])('keeps the path selectable and reports a %s clipboard', async (kind) => {
    vi.stubGlobal('navigator', kind === 'denied'
      ? { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) } }
      : {});
    render(<NodeDeliverables node={publishedMarkdown('[报告](/C:/tmp/report.md)')} readOnly />);
    fireEvent.click(screen.getByRole('button', { name: /复制路径/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('复制失败，请选择路径手动复制'));
    expect(screen.getByText('C:/tmp/report.md').tagName).toBe('CODE');
    expect(screen.queryByText('已复制')).toBeNull();
  });

  it('keeps normal HTTPS links and does not turn a web URL containing a drive path into a file', () => {
    render(<NodeDeliverables node={publishedMarkdown('[网站](https://example.com/C:/tmp/report.md)')} readOnly />);
    expect(screen.getByRole('link', { name: '网站' })).toHaveAttribute('href', 'https://example.com/C:/tmp/report.md');
    expect(screen.queryByRole('button', { name: /复制路径/ })).toBeNull();
  });

  it.each(['javascript:alert%281%29', 'data:text/html,example', 'vbscript:example'])('retains default sanitization for %s', href => {
    render(<NodeDeliverables node={publishedMarkdown(`[不安全](<${href}>)`)} readOnly />);
    const label = screen.getByText('不安全');
    expect(label.closest('a')?.getAttribute('href') || '').toBe('');
    expect(screen.queryByRole('button', { name: /复制路径/ })).toBeNull();
  });
});
