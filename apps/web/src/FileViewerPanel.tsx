import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, FileQuestion, FileText } from 'lucide-react';

/**
 * Reference viewer — file sub-view (presentation only).
 *
 * Renders a single file's contents from a run's trusted checkout. ALL governance
 * (path safety, trust gate, sensitivity, binary metadata-only) lives in the
 * kernel `read_run_file`; this component only renders what the API returns and
 * never reads the filesystem itself. The `load` function is injected so the
 * panel is decoupled from fetch/auth and unit-testable.
 */

export type FileViewResult = {
  path: string;
  mime: string;
  is_text: boolean;
  size_bytes: number;
  truncated: boolean;
  encoding: string;
  content: string | null;
};

export type FileViewLoad =
  | { kind: 'ok'; result: FileViewResult }
  | { kind: 'error'; code: string; message: string };

type FileViewLoader = (runId: string, path: string) => Promise<FileViewLoad>;

export function FileViewerPanel({
  runId,
  path,
  load,
  renderMarkdown,
}: {
  runId: string;
  path: string;
  load: FileViewLoader;
  /** Optional markdown renderer (App injects AssistantMarkdown); falls back to <pre>. */
  renderMarkdown?: (content: string) => ReactNode;
}) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'done'; load: FileViewLoad }>({
    status: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    load(runId, path)
      .then((res) => {
        if (!cancelled) setState({ status: 'done', load: res });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'done', load: { kind: 'error', code: 'request_refused', message: 'request refused' } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, path, load]);

  if (state.status === 'loading') {
    return (
      <div className="file-viewer file-viewer-loading" role="status">
        {`Loading ${path}…`}
      </div>
    );
  }

  const loaded = state.load;
  if (loaded.kind === 'error') {
    return (
      <div className="file-viewer file-viewer-error" role="alert">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <strong className="file-viewer-name">{path}</strong>
          <p data-code={loaded.code}>{loaded.message}</p>
        </div>
      </div>
    );
  }

  const result = loaded.result;
  if (!result.is_text) {
    return (
      <div className="file-viewer file-viewer-binary">
        <FileQuestion size={16} aria-hidden="true" />
        <div>
          <strong className="file-viewer-name">{result.path}</strong>
          <p>{`Binary file — ${result.size_bytes} bytes (${result.mime}). Metadata only, no preview.`}</p>
        </div>
      </div>
    );
  }

  const isMarkdown = result.mime === 'text/markdown';
  const content = result.content ?? '';
  return (
    <div className="file-viewer file-viewer-text">
      <div className="file-viewer-head">
        <FileText size={16} aria-hidden="true" />
        <strong className="file-viewer-name">{result.path}</strong>
        {result.truncated ? <span className="status-pill warn file-viewer-truncated">truncated</span> : null}
      </div>
      {isMarkdown && renderMarkdown ? (
        <div className="file-viewer-md">{renderMarkdown(content)}</div>
      ) : (
        <pre className="file-viewer-pre">{content}</pre>
      )}
    </div>
  );
}

/**
 * Decide whether a markdown link href points at a viewable file in the run
 * checkout (a relative path) rather than an external URL. Conservative: only
 * plain relative paths — no scheme, not protocol-relative, not absolute, not an
 * anchor, no `..` escape, no NUL. The kernel re-checks all of this fail-closed;
 * this is just to avoid hijacking real links.
 */
// Control/NUL + zero-width / BOM / line-separator format chars (NUL-truncation
// and zero-width-prefixed-URL disguises).
const NON_PATH_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/;

export function fileLinkPath(rawHref: string | null | undefined): string | null {
  if (!rawHref) return null;
  // Do NOT trim — surrounding whitespace on a "path" is suspicious, not benign.
  const href = rawHref;
  if (!href) return null;
  if (NON_PATH_CHARS.test(href)) return null;
  if (/\s/.test(href)) return null; // any whitespace
  // Reject anchors, absolute, home-relative, protocol-relative.
  if (href.startsWith('#') || href.startsWith('/') || href.startsWith('~') || href.startsWith('//')) {
    return null;
  }
  // Reject ANY colon — kills every URL scheme (http:, mailto:, data:, javascript:,
  // file:, a Windows drive ``C:``) and scheme disguises, without a fragile regex.
  if (href.includes(':')) return null;
  // Reject parent-escape and the query/hash decorations a real path won't carry.
  if (href.split('/').some((seg) => seg === '..')) return null;
  if (href.includes('?') || href.includes('#')) return null;
  return href;
}
