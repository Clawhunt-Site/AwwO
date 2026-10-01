import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import type { NodeContract } from '../src/canvas/nodeContracts';
import { GraphNodeOutput } from '../src/saas/GraphNodeOutput';
import type { GraphNodeResult, GraphRunSnapshot } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const contract = (type: 'markdown' | 'html' | 'number' = 'markdown'): NodeContract => ({ version: 1, inputs: [], outputs: [
  { id: 'result', label: 'Saved deliverable', type, required: true, value: '' },
] });
const graph = (savedContract: NodeContract | undefined = contract()): GraphRunSnapshot => ({
  id: 'historical-run', operationId: 'historical-operation', canvasId: 'canvas-a', documentVersion: 3,
  status: 'completed', createdAt: '2026-09-28T00:00:00Z', scope: ['a'], nodes: [],
  document: { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', contract: savedContract }] },
});
const result = (patch: Partial<GraphNodeResult> = {}): GraphNodeResult => ({
  nodeId: 'a', state: 'done', output: '{"result":"# Saved result\\n\\nExact **source**."}', ...patch,
});
const view = (snapshot = graph(), node = result()) => <SaaSPreferencesProvider><GraphNodeOutput graph={snapshot} node={node} /></SaaSPreferencesProvider>;
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); });
afterEach(() => { cleanup(); localStorage.clear(); });

it('projects only the historical contract and retains the original response byte for byte', () => {
  const original = '  {"result":"# Saved result\\n\\nExact **source**.","extra":"unmapped evidence"}\n';
  const { rerender } = render(view(graph(), result({ output: original })));
  expect(screen.getByRole('heading', { name: 'Saved result' })).toBeVisible();
  expect(screen.getByText('source').tagName).toBe('STRONG');
  const raw = screen.getByText('Original response').closest('details')!;
  expect(raw).not.toHaveAttribute('open');
  expect(raw.querySelector('pre')!.textContent).toBe(original);
  fireEvent.click(screen.getByRole('button', { name: 'Source', exact: true }));
  expect(screen.getByLabelText('Markdown source').textContent).toBe('# Saved result\n\nExact **source**.');

  // A different run of this same node can declare a different type. It must not make
  // the older response use that newer contract, or leave its rendered fields behind.
  rerender(view({ ...graph(contract('number')), id: 'newer-run', documentVersion: 9 }, result({ output: original })));
  expect(screen.queryByRole('heading', { name: 'Saved result' })).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('historical delivery format');
  expect(screen.getByText(original.trim()).textContent).toBe(original);
  rerender(view(graph(), result({ output: original })));
  expect(screen.getByRole('heading', { name: 'Saved result' })).toBeTruthy();
});

it.each(['missing-document', 'missing-node', 'missing-contract', 'ambiguous-node', 'invalid-contract'] as const)('keeps %s history verbatim without guessing an envelope', scenario => {
  const snapshot = graph();
  if (scenario === 'missing-document') snapshot.document = undefined;
  else if (scenario === 'missing-node') snapshot.document!.nodes = [];
  else if (scenario === 'ambiguous-node') snapshot.document!.nodes.push({ ...snapshot.document!.nodes[0]! });
  else if (scenario === 'missing-contract') delete (snapshot.document!.nodes[0] as ReturnType<typeof createSessionNode>).contract;
  else (snapshot.document!.nodes[0] as ReturnType<typeof createSessionNode>).contract = { ...contract(), version: 99 } as unknown as NodeContract;
  render(view(snapshot));
  expect(screen.queryByRole('heading', { name: 'Saved result' })).toBeNull();
  expect(screen.getByText(result().output!).tagName).toBe('PRE');
  expect(screen.queryByText('Original response')).toBeNull();
});

it.each(['failed', 'blocked', 'cancelled', 'running', 'cached', 'partial', 'candidate'] as const)('keeps %s evidence unprojected and does not label it final', scenario => {
  const snapshot = graph();
  const node = result(scenario === 'partial' ? { partial: true } : scenario === 'candidate' ? {} : { state: scenario });
  if (scenario === 'candidate') snapshot.collaboration = {
    goal: 'Review the solution', rounds: 1, round: 1, phase: 'synthesis', maxModelCalls: 5, synthesizerNodeId: 'b', turns: [],
  };
  render(view(snapshot, node));
  expect(screen.queryByRole('heading', { name: 'Saved result' })).toBeNull();
  expect(screen.getByText(node.output!).tagName).toBe('PRE');
  expect(screen.queryByText('Node result')).toBeNull();
  expect(screen.getByText(['failed', 'blocked', 'cancelled'].includes(scenario) ? 'Incomplete node result'
    : scenario === 'cached' ? 'Cached node result' : 'Node candidate result')).toBeVisible();
});

it('projects only a completed nonpartial synthesis and retains the review evidence elsewhere', () => {
  const snapshot = graph();
  snapshot.collaboration = { goal: 'Review the solution', rounds: 1, round: 1, phase: 'synthesis', maxModelCalls: 5, synthesizerNodeId: 'a', turns: [] };
  const { rerender } = render(view(snapshot));
  expect(screen.getByRole('heading', { name: 'Saved result' })).toBeTruthy();
  rerender(view({ ...snapshot, status: 'failed' }));
  expect(screen.queryByRole('heading', { name: 'Saved result' })).toBeNull();
  expect(screen.getByText('Node candidate result')).toBeVisible();
});

it('preserves invalid keyed values and malformed JSON as unformatted evidence', () => {
  const invalid = '{"result":false}';
  const { rerender } = render(view(graph(), result({ output: invalid })));
  expect(screen.getByRole('status')).toHaveTextContent('historical delivery format');
  expect(screen.getByText(invalid).textContent).toBe(invalid);
  const malformed = '{"result":"not "escaped""}';
  rerender(view(graph(), result({ output: malformed })));
  expect(screen.getByText(malformed).tagName).toBe('PRE');
  expect(screen.queryByRole('heading')).toBeNull();
});

it('uses the existing isolated HTML preview and preserves the unsafe original in source and raw response', () => {
  const html = '<html><head><title>Saved</title></head><body><script>unsafe()</script><img src="/api/private"><h1>Delivered page</h1></body></html>';
  const original = JSON.stringify({ result: html });
  const { container } = render(view(graph(contract('html')), result({ output: original })));
  const frame = screen.getByTitle('Saved deliverable · HTML preview');
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(frame.getAttribute('srcdoc')).toContain('Delivered page');
  expect(frame.getAttribute('srcdoc')).not.toContain('unsafe()');
  expect(frame.getAttribute('srcdoc')).not.toContain('src="/api/private"');
  expect(container.querySelector('script, img')).toBeNull();
  const raw = screen.getByText('Original response').closest('details')!;
  expect(raw.querySelector('pre')!.textContent).toBe(original);
  fireEvent.click(screen.getByRole('button', { name: 'Source', exact: true }));
  expect(screen.getByLabelText('HTML source').textContent).toBe(html);
});

it('renders Markdown without fetching images or executing raw HTML and unsafe URLs', () => {
  const source = '# Visible title\n\n![Private image](/api/private)\n\n<script>unsafe()</script>\n\n[Unsafe link](javascript:unsafe)\n\n[Documentation](https://example.com/docs)';
  const { container } = render(view(graph(), result({ output: JSON.stringify({ result: source }) })));
  expect(screen.getByRole('heading', { name: 'Visible title' })).toBeVisible();
  expect(screen.getByText('Private image')).toBeVisible();
  expect(container.querySelector('img, script')).toBeNull();
  const field = within(screen.getByRole('region', { name: 'Saved deliverable' }));
  expect(field.getByText('Unsafe link')).not.toHaveAttribute('href', 'javascript:unsafe');
  expect(field.getByRole('link', { name: 'Documentation' })).toHaveAttribute('rel', 'noopener noreferrer');
});

it('reads plain Markdown accepted by the historical single field and preserves every original byte', () => {
  const source = '\n# Plain result\n\n**Readable emphasis**\n\n![Private image](/api/private)\n';
  const { container, rerender } = render(view(graph(), result({ output: source })));
  expect(screen.getByRole('heading', { name: 'Plain result' })).toBeVisible();
  expect(screen.getByText('Readable emphasis').tagName).toBe('STRONG');
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('Original response').closest('details')!.querySelector('pre')!.textContent).toBe(source);
  rerender(view(graph(), result({ output: source, partial: true })));
  expect(screen.queryByRole('heading', { name: 'Plain result' })).toBeNull();
  expect(container.querySelector('pre')!.textContent).toBe(source);
  rerender(view({ ...graph(), document: undefined }, result({ output: source })));
  expect(screen.queryByRole('heading', { name: 'Plain result' })).toBeNull();
  expect(container.querySelector('pre')!.textContent).toBe(source);
});

it.each(['["untyped","array"]', '{"unknown":"not the historical field"}', '{"result":"not "escaped""}', '```json\n{broken}\n```', '"JSON scalar"'])('keeps untyped or malformed envelope %s out of the plain-prose fallback', source => {
  const { container } = render(view(graph(), result({ output: source })));
  expect(container.querySelector('.saas-graph-output-fields')).toBeNull();
  expect(container.querySelector('pre')!.textContent).toBe(source);
  expect(screen.queryByText('Original response')).toBeNull();
});
