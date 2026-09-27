import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionNode, emptyDocument, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canonicalCanvasDocumentJSON } from '../src/saas/canvasDraft';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { LocaleProvider } from '../src/canvas/i18n';
import { cleanTaskFrame, taskFrameError } from '../src/canvas/taskFrame';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';

const frame = (patch = {}) => ({ version: 1, source: 'manual', constraints: ['  保留原文\n第二行  '], acceptanceCriteria: ['人工检查结果'], ...patch });
afterEach(cleanup);

describe('manual task frame persistence', () => {
  it('preserves manual text and unknown fields through normalize/export/import and copied documents', () => {
    for (const taskFrame of [frame({ extra: { future: true } }), { version: 8, source: 'future', future: ['keep this'] }]) {
      const doc = { ...emptyDocument(), nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), taskFrame }] };
      const exported = canonicalCanvasDocumentJSON(doc);
      const copied = sanitizeDocument(JSON.parse(exported));
      expect((copied.nodes[0] as SessionNode).taskFrame).toEqual(taskFrame);
      expect(JSON.parse(canonicalCanvasDocumentJSON(copied)).nodes[0].taskFrame).toEqual(taskFrame);
    }
  });

  it('does not add task requirements to a legacy session', () => {
    const doc = sanitizeDocument({ ...emptyDocument(), nodes: [createSessionNode('llm', { x: 0, y: 0 })] });
    expect(doc.nodes[0]).not.toHaveProperty('taskFrame');
  });

  it('changes recovery identity when requirements change while ignoring JSON object key order', () => {
    const node = createSessionNode('llm', { x: 0, y: 0 });
    const doc = { ...emptyDocument(), nodes: [node] };
    const withFrame = { ...doc, nodes: [{ ...node, taskFrame: frame() }] };
    expect(runInputFingerprint(doc, [node.id])).not.toBe(runInputFingerprint(withFrame, [node.id]));
    const reversedKeys = Object.fromEntries(Object.entries(frame()).reverse());
    expect(runInputFingerprint(withFrame, [node.id])).toBe(runInputFingerprint({ ...doc, nodes: [{ ...node, taskFrame: reversedKeys }] }, [node.id]));
  });

  it('ignores empty entries without trimming manual content or deleting a cleared frame', () => {
    expect(cleanTaskFrame(frame({ constraints: ['  原文  ', ' \n\t', 'second\nline'], acceptanceCriteria: [''] })))
      .toEqual(frame({ constraints: ['  原文  ', 'second\nline'], acceptanceCriteria: [] }));
    expect(cleanTaskFrame(frame({ constraints: [''], acceptanceCriteria: ['  '] })))
      .toEqual(frame({ constraints: [], acceptanceCriteria: [] }));
    expect(cleanTaskFrame(frame({ constraints: ['\u0085', '\ufeff'], acceptanceCriteria: [] })))
      .toEqual(frame({ constraints: ['\ufeff'], acceptanceCriteria: [] }));
  });

  it('counts Unicode characters and rejects each count/length/total boundary', () => {
    expect(taskFrameError(frame({ constraints: ['😀'.repeat(2000)], acceptanceCriteria: [] }))).toBeNull();
    expect(taskFrameError(frame({ constraints: ['😀'.repeat(2001)] }))).toBe('entryLength');
    expect(taskFrameError(frame({ constraints: Array(21).fill('rule') }))).toBe('entries');
    expect(taskFrameError(frame({ constraints: Array(20).fill('rule'), acceptanceCriteria: Array(20).fill('accept') }))).toBeNull();
    expect(taskFrameError(frame({ constraints: Array(6).fill('x'.repeat(2000)), acceptanceCriteria: [] }))).toBeNull();
    expect(taskFrameError(frame({ constraints: Array(6).fill('x'.repeat(2000)), acceptanceCriteria: ['x'] }))).toBe('totalLength');
  });
});

function inspector(node: SessionNode, onSave = vi.fn(), readOnly = false) {
  return { onSave, element: <LocaleProvider locale="zh"><InspectorPanel node={node} apiBase="/api" liveCompanies={[]}
    onSave={onSave} onClose={vi.fn()} readOnly={readOnly} /></LocaleProvider> };
}

describe('manual task frame inspector', () => {
  it('saves human-authored constraints and acceptance criteria through the existing save callback', () => {
    const props = inspector(createSessionNode('llm', { x: 0, y: 0 })); render(props.element);
    fireEvent.click(screen.getByRole('button', { name: '添加约束' }));
    fireEvent.change(screen.getByLabelText('约束 1'), { target: { value: '  保留原文\n第二行  ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加验收标准' }));
    fireEvent.change(screen.getByLabelText('验收标准 1'), { target: { value: '人工检查结果' } });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ taskFrame: frame() }));
  });

  it('blocks over-limit edits and preserves the draft for correction', () => {
    const props = inspector({ ...createSessionNode('llm', { x: 0, y: 0 }), taskFrame: frame() }); render(props.element);
    const raw = '😀'.repeat(2001);
    fireEvent.change(screen.getByLabelText('约束 1'), { target: { value: raw } });
    expect(screen.getByRole('alert')).toHaveTextContent('每条最多 2000 个字符');
    expect(screen.getByLabelText('约束 1')).toHaveValue(raw);
    expect(screen.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('respects read-only permission for all task frame controls', () => {
    const props = inspector({ ...createSessionNode('llm', { x: 0, y: 0 }), taskFrame: frame() }, vi.fn(), true); render(props.element);
    expect(screen.getByLabelText('约束 1')).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加约束' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it.each([{ version: 8, source: 'future', future: ['keep this'] }, frame({ extra: 'preserve' })])('shows unsupported saved shapes without editable replacement controls: %j', taskFrame => {
    const props = inspector({ ...createSessionNode('llm', { x: 0, y: 0 }), taskFrame }); render(props.element);
    expect(screen.getByText(/此任务要求版本暂不支持编辑/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '添加约束' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    expect(props.onSave).not.toHaveBeenCalled();
  });
});
