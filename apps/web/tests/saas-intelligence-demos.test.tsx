import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { KnowledgeDemo, OperationsDemo, TrainingDemo } from '../src/saas/examples/IntelligenceDemos';
import { advanceTraining, createTrainingData, evaluateModel, initialTrainingState, logisticProbability, searchKnowledge, tokenizeKnowledge } from '../src/saas/examples/intelligenceMath';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('local knowledge retrieval', () => {
  it('tokenizes Chinese and Latin text and rejects empty or unmatched queries', () => {
    expect(tokenizeKnowledge('画布验收 Canvas 42')).toEqual(['画布', '布验', '验收', 'canvas', '42']);
    const documents = [{ id: 'a', title: '交付指南', content: '交付需要验收记录。' }];
    expect(searchKnowledge(documents, '验收')[0].document.id).toBe('a');
    expect(searchKnowledge(documents, '火星地质')).toEqual([]);
    expect(searchKnowledge(documents, '!!!')).toEqual([]);
    expect(searchKnowledge([], '验收')).toEqual([]);
  });

  it('reorders by weighted query terms, reports matching terms and applies the threshold', () => {
    const documents = [{ id: 'a', title: 'Fruit', content: 'apple' }, { id: 'b', title: 'Fruit', content: 'banana' }];
    const plain = searchKnowledge(documents, 'apple banana');
    const emphasized = searchKnowledge(documents, 'apple banana', { emphasis: 'banana', emphasisWeight: 5 });
    expect(plain[0].document.id).toBe('a');
    expect(emphasized[0].document.id).toBe('b');
    expect(emphasized[0].matchedTerms).toEqual(['banana']);
    expect(emphasized.every(hit => hit.score > 0 && hit.score <= 1)).toBe(true);
    expect(searchKnowledge(documents, 'apple banana', { threshold: 1 })).toEqual([]);
  });

  it('adds and saves a source, finds it with a citation, shows no-match, and resets', () => {
    render(<KnowledgeDemo locale="zh" />);
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByLabelText('文档标题'), { target: { value: '火星任务说明' } });
    fireEvent.change(screen.getByLabelText('正文 · 可直接编辑'), { target: { value: '火星任务需要在周五完成地质采样。' } });
    fireEvent.click(screen.getByRole('button', { name: /保存并更新索引/ }));
    fireEvent.change(screen.getByLabelText('搜索你的知识库'), { target: { value: '地质采样' } });
    fireEvent.click(screen.getByRole('button', { name: '检索' }));
    expect(screen.getByRole('button', { name: '[1] 火星任务说明' })).toBeInTheDocument();
    expect(within(screen.getByRole('article')).getByText('火星任务需要在周五完成地质采样。')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('正文 · 可直接编辑'), { target: { value: '更新后的内容仅包括设备维护。' } });
    fireEvent.click(screen.getByRole('button', { name: /保存并更新索引/ }));
    fireEvent.click(screen.getByRole('button', { name: /保存并更新索引/ }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '选择文档' })).getAllByRole('button')).toHaveLength(5);
    fireEvent.change(screen.getByLabelText('搜索你的知识库'), { target: { value: 'unmatchedxyz' } });
    fireEvent.click(screen.getByRole('button', { name: '检索' }));
    expect(screen.getByText('没有匹配来源')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(screen.queryByRole('button', { name: /火星任务说明/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('文档标题')).toHaveValue('交付与验收指南');
  });

  it('loads the matching sample corpus when the interface language changes', () => {
    const view = render(<KnowledgeDemo locale="zh" />);
    expect(screen.getByLabelText('文档标题')).toHaveValue('交付与验收指南');
    view.rerender(<KnowledgeDemo locale="en" />);
    expect(screen.getByLabelText('Document title')).toHaveValue('Delivery and acceptance');
    expect(screen.getByRole('button', { name: '[1] Delivery and acceptance' })).toBeInTheDocument();
  });
});

describe('real local model training', () => {
  it('has reproducible, disjoint splits and learns a low-noise decision boundary', () => {
    const data = createTrainingData(0);
    expect(data).toEqual(createTrainingData(0));
    expect(data.train).toHaveLength(180);
    expect(data.validation).toHaveLength(60);
    expect(data.train.some(point => data.validation.includes(point))).toBe(false);
    const initial = initialTrainingState(data);
    const trained = advanceTraining(initial, data, 0.5, 250);
    expect(initial.epoch).toBe(0);
    expect(trained.epoch).toBe(250);
    expect(trained.history).toHaveLength(251);
    expect(trained.history.at(-1)!.train.loss).toBeLessThan(initial.history[0].train.loss / 2);
    expect(trained.history.at(-1)!.validation.accuracy).toBeGreaterThan(0.9);
    expect(trained.history.every(sample => Number.isFinite(sample.train.loss) && Number.isFinite(sample.validation.loss))).toBe(true);
    expect(logisticProbability(trained.weights, 0.9, 0.9)).toBeGreaterThan(0.9);
    expect(logisticProbability(trained.weights, -0.9, -0.9)).toBeLessThan(0.1);
  });

  it('never uses held-out labels for gradient updates and supports reproducible incremental steps', () => {
    const data = createTrainingData(0.1);
    const flipped = { ...data, validation: data.validation.map(point => ({ ...point, label: (point.label ? 0 : 1) as 0 | 1 })) };
    const trained = advanceTraining(initialTrainingState(data), data, 0.2, 80);
    const other = advanceTraining(initialTrainingState(flipped), flipped, 0.2, 80);
    expect(other.weights).toEqual(trained.weights);
    expect(other.history.at(-1)!.validation.accuracy).not.toEqual(trained.history.at(-1)!.validation.accuracy);
    const chunked = advanceTraining(advanceTraining(initialTrainingState(data), data, 0.2, 30), data, 0.2, 50);
    expect(chunked).toEqual(trained);
  });

  it('keeps extreme logits numerically stable and label noise changes learning results', () => {
    expect(logisticProbability([1000, 1000, 1000], 1, 1)).toBe(1);
    expect(logisticProbability([1000, 1000, -1000], -1, -1)).toBe(0);
    const extreme = evaluateModel([1000, 1000, 1000], [{ x: 1, y: 1, label: 0 }]);
    expect(extreme.loss).toBe(3000);
    const noisy = createTrainingData(0.35);
    const trained = advanceTraining(initialTrainingState(noisy), noisy, 1, 300);
    expect(trained.history.at(-1)!.train.accuracy).toBeLessThan(0.85);
    expect(trained.history.at(-1)!.train.loss).toBeGreaterThan(0);
  });

  it('runs actual epochs in the component, changes predictions and resets all results', () => {
    vi.useFakeTimers();
    const view = render(<TrainingDemo locale="en" />);
    expect(screen.getByTestId('training-loss')).toHaveTextContent('0.6931');
    fireEvent.click(screen.getByRole('button', { name: 'Start training' }));
    expect(screen.getByRole('slider', { name: /Learning rate/ })).toBeDisabled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('status')).toHaveTextContent('Training complete · 120/120');
    expect(Number(screen.getByTestId('training-loss').textContent)).toBeLessThan(0.5);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '120');
    fireEvent.change(screen.getByRole('slider', { name: /CPU/ }), { target: { value: '100' } });
    fireEvent.change(screen.getByRole('slider', { name: /Queue depth/ }), { target: { value: '100' } });
    expect(screen.getByText('Class: high load')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByTestId('training-loss')).toHaveTextContent('0.6931');
    expect(screen.getByRole('status')).toHaveTextContent('Ready to train · 0/120');
    fireEvent.click(screen.getByRole('button', { name: 'Start training' }));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops updates immediately and clears trained results when the dataset changes', () => {
    vi.useFakeTimers();
    render(<TrainingDemo locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start training' }));
    act(() => { vi.advanceTimersByTime(180); });
    fireEvent.click(screen.getByRole('button', { name: 'Stop training' }));
    const stoppedLoss = screen.getByTestId('training-loss').textContent;
    expect(screen.getByRole('status')).toHaveTextContent('Training stopped · 24/120');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('training-loss')).toHaveTextContent(stoppedLoss!);
    fireEvent.change(screen.getByRole('slider', { name: /Label noise/ }), { target: { value: '0.35' } });
    expect(screen.getByTestId('training-loss')).toHaveTextContent('0.6931');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('operations state transitions', () => {
  it('approves then completes a request, updates aggregates, prevents repeated actions and resets', () => {
    render(<OperationsDemo locale="en" />);
    expect(screen.getByTestId('operations-pending-count')).toHaveTextContent('03');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByTestId('operations-pending-count')).toHaveTextContent('02');
    expect(screen.getByText('¥8,800')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark delivery complete' }));
    expect(screen.getByText('OP-1042 · Complete')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark delivery complete' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset data' }));
    expect(screen.getByTestId('operations-pending-count')).toHaveTextContent('03');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('requires rejection reasons and retains an audit event', () => {
    render(<OperationsDemo locale="zh" />);
    fireEvent.click(screen.getByRole('button', { name: '驳回', exact: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('请填写驳回原因');
    expect(screen.getByTestId('operations-pending-count')).toHaveTextContent('03');
    fireEvent.change(screen.getByLabelText('审批备注 · 驳回时必填'), { target: { value: '请补充交付时间' } });
    fireEvent.click(screen.getByRole('button', { name: '驳回', exact: true }));
    expect(screen.getByText('OP-1042 · 已驳回 · 请补充交付时间')).toBeInTheDocument();
    expect(screen.getByTestId('operations-pending-count')).toHaveTextContent('02');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('combines status and search filters and renders an empty result', () => {
    render(<OperationsDemo locale="en" />);
    const filters = screen.getByRole('group', { name: 'Filter request status' });
    fireEvent.click(within(filters).getByRole('button', { name: /Pending/ }));
    expect(screen.getAllByRole('row')).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Search requests'), { target: { value: 'Mia' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Knowledge library refresh/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search requests'), { target: { value: 'missing-request' } });
    expect(screen.getByText('No matching requests')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 / 6 requests');
  });
});
