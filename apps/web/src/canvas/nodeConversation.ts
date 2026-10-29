import type { CanvasEdge, CanvasNode, SessionNode } from './canvasDoc';
import { mediaDeliveryText, mediaMissingText, mediaSourceKind, parseMediaOutput, type MediaOutputKind } from './mediaOutput';
import { parseContractOutput, type ContractField } from './nodeContracts';
import { canFeed, isMediaSourceNode, isSoftMediaFeed, portsFor } from './ports';
import { buildNodeMessage, isMarketSource, validateNodeOutput, type UpstreamInput } from './runGraph';

export interface NodeConversationContext {
  messagePrefix: string;
  error?: string;
  /** The values the node's inputs take, copied from the contract and overlaid with connected outputs, once every
   *  connected upstream has a usable output (or, wired as a soft media feed, has made no file: `mediaMissing`); with
   *  `error` set, some value does not fit its field. */
  inputs?: ContractField[];
  /** Connected field ids mapped to upstream titles (or its saved id if the node was removed or has no title). */
  sources?: Record<string, string>;
  /** Connected field ids whose value is an upstream node's case recording, not a run of this workspace. */
  recorded?: Record<string, true>;
  /** Connected field ids whose upstream image, video, 3D or audio node (or edit) has made no file, with the kind it makes:
   *  the value is the note the agent reads (mediaMissingText), which the inputs form does not show as a value. */
  mediaMissing?: Record<string, MediaOutputKind>;
}

export function prepareNodeConversation(
  node: SessionNode,
  nodes: ReadonlyArray<CanvasNode> = [node],
  edges: ReadonlyArray<CanvasEdge> = [],
): NodeConversationContext {
  // Legacy sessions intentionally retain their free-form conversation behavior.
  if (!node.contract) return { messagePrefix: '' };
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  byId.set(node.id, node);
  const incoming = edges.filter((candidate) => candidate.toNode === node.id);
  const sources: Record<string, string> = Object.create(null);
  // Collect provenance first, including fields after an unavailable source. Error rendering
  // should still be able to explain every connection without exposing unvalidated values.
  for (const edge of incoming) {
    const field = node.contract.inputs.find((candidate) => `in:${candidate.id}` === edge.toPort);
    if (field) sources[field.id] = byId.get(edge.fromNode)?.title || edge.fromNode;
  }
  // Two wires into one input (an older or imported document; a run refuses it) give it no one value to show.
  const doubled = node.contract.inputs.find((field) => incoming.filter((edge) => edge.toPort === `in:${field.id}`).length > 1);
  if (doubled) return { messagePrefix: '', sources, error: `输入「${doubled.label || doubled.id}」只能连接一个来源。` };
  const upstream: UpstreamInput[] = [];
  const recorded: Record<string, true> = Object.create(null);
  const mediaMissing: Record<string, MediaOutputKind> = Object.create(null);
  for (const edge of incoming) {
    const source = byId.get(edge.fromNode);
    const input = portsFor(node).find((port) => port.side === 'input' && port.id === edge.toPort);
    const output = source && portsFor(source).find((port) => port.side === 'output' && port.id === edge.fromPort);
    if (!source || source.id === node.id || !input || !output || !canFeed(source, output, input)) {
      return { messagePrefix: '', sources, error: `输入「${input?.label || edge.toPort}」的上游连线已失效，请检查连接。` };
    }
    if ((!source.lastOutput || !source.lastOutput.text.trim() || source.lastOutput.partial || !parseMediaOutput(source.lastOutput.text))
      && isSoftMediaFeed(source, node, edge)) {
      // A picture, clip or model that was not made: the input says so and the node goes on without it. That note is the
      // agent's; the form says it in the page's language (a soft feed's source is a media node or an edit: it has a kind).
      upstream.push({ fromTitle: source.title, toPort: edge.toPort, output: mediaMissingText(source) });
      const kind = mediaSourceKind(source);
      if (kind) mediaMissing[edge.toPort.slice('in:'.length)] = kind;
      continue;
    }
    if (!source.lastOutput || !source.lastOutput.text.trim() || source.lastOutput.partial) {
      return { messagePrefix: '', sources, error: `上游「${source.title}」还没有可用的完整产出。` };
    }
    const errors = validateNodeOutput(source, source.lastOutput.text);
    if (errors.length) {
      return { messagePrefix: '', sources, error: `上游「${source.title}」产出不符合输出格式：${errors.join(' ')}` };
    }
    const text = source.kind === 'session' && source.contract
      ? parseContractOutput(source.contract, source.lastOutput.text).values[edge.fromPort.slice('out:'.length)] ?? ''
      : isMediaSourceNode(source) ? mediaDeliveryText(source, source.lastOutput.text) : source.lastOutput.text;
    upstream.push({ fromTitle: source.title, toPort: edge.toPort, output: text, market: isMarketSource(source) });
    if (source.lastOutput.source === 'case') recorded[edge.toPort.slice('in:'.length)] = true;
  }
  const inputs = node.contract.inputs.map((field) => {
    const connected = upstream.find((input) => input.toPort === `in:${field.id}`);
    return { ...field, value: connected ? connected.output : field.value };
  });
  try {
    return { messagePrefix: buildNodeMessage(node, upstream), inputs, sources, recorded, mediaMissing };
  } catch (error) {
    // Every upstream delivered, but a value does not fit its field (a field left out, a type the wire allows but the
    // value does not meet, a local value missing): the form shows what arrived and says what does not fit.
    return { messagePrefix: '', inputs, sources, recorded, mediaMissing, error: error instanceof Error ? error.message : '节点输入尚未就绪。' };
  }
}
