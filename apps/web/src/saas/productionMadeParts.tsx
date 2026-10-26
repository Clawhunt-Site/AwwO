import { Check, CircleSlash, TriangleAlert } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ProductionNodeStatus, ProductionRunNode } from './productionRuns';

/** Shared by the case dialogs (ProductionShowcase.tsx, ProductionFilm.tsx), which read in English in both interface
 * languages, as the cases do (owner 2026-10-14). */
const STATUS: Readonly<Record<ProductionNodeStatus, string>> = {
  done: 'Done', failed: 'Failed', blocked: 'Blocked', cancelled: 'Stopped', cached: 'Reused',
};
export function StatusChip({ status }: { status: ProductionNodeStatus }) {
  return <em className={`production-made-status is-${status}`}>{status === 'done' ? <Check size={11} aria-hidden="true" /> : status === 'failed' ? <TriangleAlert size={11} aria-hidden="true" /> : <CircleSlash size={11} aria-hidden="true" />}{STATUS[status]}</em>;
}

// Inert like the delivery reader (canvas/DeliverableMarkdown.tsx), but stricter: only http(s) links are
// links, and a path on the machine the run used (kept only as artifacts/<name>) is plain text.
const external = (href?: string) => /^https?:\/\//i.test(href || '');
const RECORD_MARKDOWN: Components = {
  img: ({ alt }) => <span>{alt || '🖼'}</span>,
  a: ({ node: _node, href, children, ...props }) => external(href) ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span title={href}>{children}</span>,
};
export const renderRecordMarkdown = (source: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} components={RECORD_MARKDOWN}>{source}</ReactMarkdown>;

/** What a node delivered: an assembly's file, an agent's report beside its result, a page's source, or its Markdown. */
export function NodeOutput({ node }: { node: ProductionRunNode }) {
  if (node.status !== 'done') return node.detail ? <p className="production-made-detail">{node.detail}</p> : null;
  if (node.kind === 'assemble' && node.fromTemplate) return <p className="production-made-file">{node.file
    ? `${node.file.name}, ${Math.round(node.file.bytes / 1024).toLocaleString()} KB: written from its template, byte for byte, with no model.`
    : 'Written from its template, byte for byte, with no model.'}</p>;
  if (node.kind === 'assemble') return <p className="production-made-file">{node.file
    ? `${node.file.name}, ${Math.round(node.file.bytes / 1024).toLocaleString()} KB: the modules pasted into its template, byte for byte, with no model.`
    : 'The modules pasted into its template, byte for byte, with no model.'}</p>;
  const report = node.report ? <div className="production-made-markdown">{renderRecordMarkdown(node.report)}</div> : null;
  // A recorded canvas's agent may deliver more text fields than its result (a director's sheet), each shown as it is.
  const extras = (node.extras ?? []).map(extra => <details className="production-made-source" key={extra.label}>
    <summary>{`${extra.label} (${extra.text.length.toLocaleString('en')} characters)`}</summary><pre><code>{extra.text}</code></pre></details>);
  if (node.outputType === 'html') return <>{report}<details className="production-made-source"><summary>{`View the page source (${(node.output || '').length.toLocaleString()} characters)`}</summary><pre><code>{node.output}</code></pre></details>{extras}</>;
  // Code or data (a module, a sheet, a timeline) is text, not Markdown: shown verbatim, folded, after the report.
  if (node.outputType === 'text') return <>{report}<details className="production-made-source"><summary>{`View what it delivered (${(node.output || '').length.toLocaleString('en')} characters)`}</summary><pre><code>{node.output}</code></pre></details>{extras}</>;
  // Markdown is shown as Markdown, its report (if it gave one apart) after it.
  return <><div className="production-made-markdown">{renderRecordMarkdown(node.output || '')}</div>{report}{extras}</>;
}

/** Where a node worked: the sandbox computer's files, commands and checks, and how many model calls that took. */
export function NodeWork({ node }: { node: ProductionRunNode }) {
  if (node.kind === 'assemble') return <p className="production-made-work">{node.fromTemplate ? 'Written with no model' : 'Assembled with no model'}</p>;
  if (!node.sandbox) return null;
  return <p className="production-made-work">{`Worked in its own sandbox computer${node.calls ? ` · ${node.calls} model calls` : ''}${node.tokens?.output ? ` · ${node.tokens.output.toLocaleString()} output tokens` : ''}`}</p>;
}
