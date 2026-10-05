import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { opensApart } from '../canvas/DeliverableMarkdown';

// The delivery reader's rules (canvas/DeliverableMarkdown.tsx): Markdown stays inert, image URLs never
// trigger a request, only an explicit click opens an http(s) or mailto link, in a new tab, and a link
// without a scheme keeps its text. A local path gets no copy control here.
const components: Components = {
  img: ({ alt }) => <span>{alt || '🖼'}</span>,
  a: ({ node: _node, href, children, ...props }) => opensApart(href)
    ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span title={href || undefined}>{children}</span>,
};
export const renderInertMarkdown = (source: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>;
