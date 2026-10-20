import { Check, CircleSlash, TriangleAlert } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ProductionNodeStatus } from './productionRuns';

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
