import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GraphSettings } from '../src/canvas/GraphSettings';
import { addReviewPartner } from '../src/canvas/reviewPartner';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import type { CanvasDocument } from '../src/canvas/canvasDoc';
import { preflightReviewGraphIssue } from '../src/canvas/reviewGraph';
import { LocaleProvider } from '../src/canvas/i18n';
afterEach(cleanup);
function seed(): CanvasDocument {
  const node = createAgentTemplate('general', { x: 0, y: 0 });
  node.contract!.inputs[0].value = 'Produce a concise Markdown comparison.';
  node.binding = { companyId: 'company', agentId: 'producer', agentName: 'Producer' };
  return { version: 2, updatedAt: 1, nodes: [node], edges: [], waypoints: [] };
}
describe('review graph setup', () => {
  it.each(['zh', 'en'] as const)('distinguishes connection selection from its role in %s', locale => {
    const original = seed();
    const doc = addReviewPartner(original, original.nodes[0].id, locale).doc;
    render(<LocaleProvider locale={locale}><GraphSettings doc={doc} selectedEdgeId={doc.edges[0].id}
      disabled={false} onChange={vi.fn()} onAddPartner={vi.fn()} /></LocaleProvider>);
    expect(screen.getByRole('combobox', { name: locale === 'zh' ? '节点连线' : 'Connection' })).toBeTruthy();
    expect(screen.getByText(locale === 'zh' ? '连线用途' : 'Connection role')).toBeTruthy();
    expect(screen.getByLabelText(locale === 'zh' ? '选择连接' : 'Select connection')).toHaveValue('data');
  });

  it('adds an unbound independent Session and valid typed feedback without changing the producer session', () => {
    const doc = seed();
    const original = structuredClone(doc);
    const result = addReviewPartner(doc, doc.nodes[0].id, 'zh');
    expect(doc).toEqual(original);
    expect(result.doc.nodes).toHaveLength(2);
    const reviewer = result.doc.nodes[1];
    expect(reviewer.kind === 'session' && reviewer.binding).toBeNull();
    expect(result.doc.nodes[0]).toMatchObject({ binding: { agentId: 'producer' }, issueId: null });
    expect(result.doc.edges.map(edge => edge.kind ?? 'data')).toEqual(['data', 'feedback']);
    if (reviewer.kind === 'session') reviewer.binding = { companyId: 'company', agentId: 'reviewer', agentName: 'Reviewer' };
    expect(preflightReviewGraphIssue(result.doc.nodes, result.doc.edges, result.doc.execution!)).toBeNull();
  });
  it('keeps draft review mode explicit and permits returning to workflow without deleting feedback', () => {
    const doc = seed(); const onChange = vi.fn();
    const props = { doc, selectedEdgeId: null, disabled: false, onChange, onAddPartner: vi.fn() };
    const view = render(<GraphSettings {...props} />);
    fireEvent.change(screen.getByLabelText('协作模式'), { target: { value: 'review' } });
    expect(onChange.mock.calls[0][0].execution).toEqual({ mode: 'review', maxRounds: 3, reviewerNodeId: '', verdictFieldId: '' });
    const paired = addReviewPartner(doc, doc.nodes[0].id, 'zh').doc;
    view.rerender(<GraphSettings {...props} doc={paired} />);
    fireEvent.change(screen.getByLabelText('协作模式'), { target: { value: 'workflow' } });
    expect(onChange.mock.lastCall![0]).toMatchObject({ execution: undefined, edges: paired.edges });
  });
  it('opens selected connection settings and allows switching to a different edge from the list', () => {
    const original = seed();
    const doc = addReviewPartner(original, original.nodes[0].id, 'zh').doc;
    const onChange = vi.fn();
    render(<GraphSettings doc={doc} selectedEdgeId={doc.edges[0].id} disabled={false} onChange={onChange} onAddPartner={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: '节点连线' }), { target: { value: doc.edges[1].id } });
    expect(screen.getByLabelText('选择连接')).toHaveValue('feedback');
    fireEvent.change(screen.getByLabelText('选择连接'), { target: { value: 'data' } });
    expect(onChange.mock.lastCall![0].edges[1].kind).toBe('data');
  });
  it('locks all graph mutations while running but permits inspection', () => {
    const doc = seed(); const onChange = vi.fn();
    render(<GraphSettings doc={doc} selectedNodeId={doc.nodes[0].id} selectedEdgeId={null} disabled onChange={onChange} onAddPartner={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '协作设置' }));
    expect(screen.getByLabelText('协作模式')).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加互审搭档' })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
