import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { FileViewerPanel, fileLinkPath, type FileViewLoad } from '../src/FileViewerPanel';

afterEach(cleanup);

const okText = (over: Partial<FileViewLoad extends { kind: 'ok' } ? object : never> = {}): FileViewLoad => ({
  kind: 'ok',
  result: {
    path: 'README.md',
    mime: 'text/markdown',
    is_text: true,
    size_bytes: 12,
    truncated: false,
    encoding: 'utf-8',
    content: '# Hello',
    ...over,
  },
});

describe('FileViewerPanel', () => {
  it('renders markdown via the injected renderer', async () => {
    const load = vi.fn().mockResolvedValue(okText());
    render(
      <FileViewerPanel
        runId="run_1"
        path="README.md"
        load={load}
        renderMarkdown={(c) => <div data-testid="md">{c}</div>}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('md')).toHaveTextContent('# Hello'));
    expect(load).toHaveBeenCalledWith('run_1', 'README.md');
  });

  it('renders plain text in <pre> when not markdown', async () => {
    const load = vi.fn().mockResolvedValue({
      kind: 'ok',
      result: { path: 'a.txt', mime: 'text/plain', is_text: true, size_bytes: 3, truncated: true, encoding: 'utf-8', content: 'abc' },
    } as FileViewLoad);
    render(<FileViewerPanel runId="r" path="a.txt" load={load} />);
    await waitFor(() => expect(screen.getByText('abc')).toBeInTheDocument());
    expect(screen.getByText('truncated')).toBeInTheDocument();
  });

  it('shows binary files as metadata only, no content', async () => {
    const load = vi.fn().mockResolvedValue({
      kind: 'ok',
      result: { path: 'blob.bin', mime: 'application/octet-stream', is_text: false, size_bytes: 9, truncated: false, encoding: 'binary', content: null },
    } as FileViewLoad);
    render(<FileViewerPanel runId="r" path="blob.bin" load={load} />);
    await waitFor(() => expect(screen.getByText(/Binary file/)).toBeInTheDocument());
    expect(screen.getByText(/Metadata only, no preview/)).toBeInTheDocument();
  });

  it('renders the error code/message for a refusal', async () => {
    const load = vi.fn().mockResolvedValue({ kind: 'error', code: 'sensitive_denied', message: 'file is sensitive and cannot be viewed' } as FileViewLoad);
    render(<FileViewerPanel runId="r" path=".env" load={load} />);
    const msg = await screen.findByText('file is sensitive and cannot be viewed');
    expect(msg).toHaveAttribute('data-code', 'sensitive_denied');
  });

  it('falls back to a safe error if the loader throws', async () => {
    const load = vi.fn().mockRejectedValue(new Error('network'));
    render(<FileViewerPanel runId="r" path="x" load={load} />);
    const msg = await screen.findByText('request refused');
    expect(msg).toHaveAttribute('data-code', 'request_refused');
  });
});

describe('fileLinkPath', () => {
  it('accepts plain relative paths', () => {
    expect(fileLinkPath('README.md')).toBe('README.md');
    expect(fileLinkPath('src/app/main.py')).toBe('src/app/main.py');
    expect(fileLinkPath('docs/plan.md')).toBe('docs/plan.md');
  });

  it('rejects URLs, schemes, absolute, anchors, escapes, decorations, whitespace, and disguises', () => {
    for (const bad of [
      'http://x.com',
      'https://x.com/a',
      'mailto:a@b.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'C:\\Windows',
      'a:b', // any colon -> scheme-like, rejected
      '/etc/passwd',
      '~/secret',
      '#section',
      '//evil.com',
      '../escape.txt',
      'a/../b',
      'a path with spaces',
      '  docs/plan.md  ', // surrounding whitespace is suspicious, not trimmed away
      'a.md?x=1',
      'a.md#frag',
      String.fromCharCode(0x200b) + 'http://google.com', // zero-width-prefixed URL disguise
      'mal' + String.fromCharCode(0) + '.txt', // NUL truncation
      'a\tb', // tab
      '',
      null,
      undefined,
    ]) {
      expect(fileLinkPath(bad as string)).toBeNull();
    }
  });
});
