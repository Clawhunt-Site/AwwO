import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArtifactPreview, StoredArtifactPreview } from '../canvas/ArtifactPreview';
import { normalizeContract, parseContractOutput } from '../canvas/nodeContracts';
import { readableOutput, type ReadableOutput } from '../canvas/readableTranscript';
import type { GraphNodeResult, GraphRunSnapshot } from './graphRuns';
import { useSaaSPreferences } from './preferences';
import { fileSafeDisplaySource } from '../canvas/fileDeliveryPresentation';
import { PendingFileDelivery } from '../canvas/PendingFileDelivery';

// Match the delivery reader: Markdown stays inert, image URLs never trigger a request,
// and only an explicit link click can navigate to an external reference.
const markdownComponents: Components = {
  img: ({ alt }) => <span>{alt || '🖼'}</span>,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};
const renderMarkdown = (source: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{source}</ReactMarkdown>;

/** Plain prose is valid only under an explicit historical single-field text contract. */
function plainHistoricalFields(source: string, historicalContract: unknown): ReadableOutput['fields'] {
  const contract = normalizeContract(historicalContract);
  if (!contract || contract.outputs.length !== 1) return [];
  const field = contract.outputs[0];
  if (field.type !== 'text' && field.type !== 'markdown') return [];
  const trimmed = source.trim();
  // Keep unknown/malformed envelopes and JSON scalars verbatim, including JSON fences.
  if (/^(?:[\[{]|```json(?:\s|$)|```\s*[\[{])/i.test(trimmed)) return [];
  try { JSON.parse(trimmed); return []; } catch { /* Only ordinary prose reaches the contract. */ }
  const parsed = parseContractOutput(contract, source);
  return !parsed.errors.length && parsed.values[field.id] === source ? [{ field, value: source }] : [];
}

/** A reading projection of one historical graph result; it never republishes output. */
export function GraphNodeOutput({ graph, node }: { graph: GraphRunSnapshot; node: GraphNodeResult }) {
  const { t } = useSaaSPreferences();
  if (!node.output) return null;
  const final = node.state === 'done' && !node.partial
    && (!graph.collaboration || (graph.status === 'completed' && node.nodeId === graph.collaboration.synthesizerNodeId));
  const interrupted = node.state === 'failed' || node.state === 'blocked' || node.state === 'cancelled';
  const label = interrupted ? t('节点未完成结果', 'Incomplete node result')
    : node.state === 'cached' ? t('沿用的节点结果', 'Cached node result')
    : final ? t('节点最终结果', 'Node result') : t('节点候选结果', 'Node candidate result');
  // graph.document is the immutable document captured at admission, not today's canvas.
  // Missing or ambiguous historical identity cannot supply a trustworthy field contract.
  const historicalNodes = Array.isArray(graph.document?.nodes) ? graph.document.nodes.filter(item => item.id === node.nodeId) : [];
  const snapshot = historicalNodes.length === 1 ? historicalNodes[0] : undefined;
  const historicalContract = snapshot?.kind === 'session' ? snapshot.contract : undefined;
  const output = readableOutput({ id: 0, role: 'agent', text: node.output,
    presentation: { outputState: final ? 'final' : 'failed', outputContract: historicalContract } });
  const fields = output.fields.length || !final || output.invalid ? output.fields : plainHistoricalFields(node.output, historicalContract);
  const displaySource = fileSafeDisplaySource(node.output);
  return <details className="saas-graph-node-output" open>
    <summary>{label}</summary>
    {output.invalid && <p className="saas-graph-output-notice" role="status">{t('输出未通过历史交付格式校验，保留原始响应。', 'Output does not match the historical delivery format. The original response is preserved.')}</p>}
    {fields.length ? <>
      <div className="saas-graph-output-fields">
        {fields.map(({ field, value, pendingFile }) => <section className="saas-graph-output-field" key={field.id} aria-label={field.label || field.id}>
          <h3>{field.label || field.id}</h3>
          {pendingFile ? <PendingFileDelivery file={pendingFile} /> : field.type === 'html' || field.type === 'markdown'
            ? <ArtifactPreview source={value} type={field.type} title={field.label || field.id} renderMarkdown={renderMarkdown} />
            : field.type === 'file' ? <StoredArtifactPreview reference={value} title={field.label || field.id}
                identity={`${graph.id}:${node.nodeId}:${field.id}`} renderMarkdown={renderMarkdown} />
              : <div className="saas-graph-output-value">{value}</div>}
        </section>)}
      </div>
      <details className="saas-graph-output-raw"><summary>{displaySource === node.output ? t('原始响应', 'Original response')
        : t('回复内容（文件内容已隐藏）', 'Response (attachment content omitted)')}</summary><pre>{displaySource}</pre></details>
    </> : <pre>{displaySource}</pre>}
  </details>;
}
