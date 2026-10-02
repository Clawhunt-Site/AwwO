import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AdvancedIntelligenceDemo } from '../src/saas/examples/advanced/AdvancedIntelligenceDemos';
import { accessibleDocuments, bestCostThreshold, classificationMetrics, CONTRACT_DOCUMENTS, contractFindings, createMLDataset, evaluateResearch, extractObligations, fitML, initialMastery, LESSONS, lineDiff, masteryScore, planLearning, populationStability, predictML, RESEARCH_DOCUMENTS, researchConflicts, rocCurve, searchResearch, updateMastery, validISODate } from '../src/saas/examples/advanced/intelligenceEngine';
import { INTELLIGENCE_CASES } from '../src/saas/examples/advanced/intelligenceCatalog';
afterEach(cleanup);

describe('research evidence engine', () => {
  it('filters access before latest revisions and never retrieves hidden safety evidence', () => {
    const reader = accessibleDocuments(RESEARCH_DOCUMENTS, 'reader');
    expect(reader.map(document => `${document.id}@${document.version}`)).toEqual(['BAT-01@2', 'GOV-06@1']);
    expect(searchResearch(reader, 'safety', 'en')).toEqual([]);
    expect(accessibleDocuments(RESEARCH_DOCUMENTS, 'lead')).toHaveLength(6);
    expect(accessibleDocuments(RESEARCH_DOCUMENTS, 'lead', true)).toHaveLength(8);
    expect(evaluateResearch(reader, 'en', 2, 1.2).find(row => row.query.en === 'safety')?.unavailable).toBe(true);
  });
  it('computes deterministic scored passages and explicit claim differences', () => {
    const documents = accessibleDocuments(RESEARCH_DOCUMENTS, 'lead');
    const results = searchResearch(documents, 'lead time', 'en');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(hit => Number.isFinite(hit.score) && hit.score > 0 && hit.key.includes('#'))).toBe(true);
    expect(results).toEqual(searchResearch(documents, 'lead time', 'en'));
    expect(searchResearch(documents, '', 'en')).toEqual([]);
    expect(researchConflicts(documents, 'en').map(group => group.key)).toEqual(expect.arrayContaining(['cycle-life', 'lead-time']));
    expect(researchConflicts([documents[0]], 'en')).toEqual([]);
  });
  it('creates a new revision from edited text and preserves the original', () => {
    render(<AdvancedIntelligenceDemo id="research-atlas" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Versions', exact: true }));
    const editor = screen.getByLabelText('Edit current-language text · save a new revision');
    fireEvent.change(editor, { target: { value: 'A new quasarprotocol evidence.\n\n[claim:cycle-life=750 cycles]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create revision and reindex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create revision and reindex' }));
    expect(screen.getByRole('status')).toHaveTextContent('Empty or unchanged');
    fireEvent.click(screen.getByRole('button', { name: 'Search', exact: true }));
    fireEvent.change(screen.getByLabelText('Search research evidence'), { target: { value: 'quasarprotocol' } });
    expect(screen.getByRole('button', { name: 'BAT-01@3#1' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Access view'), { target: { value: 'reader' } });
    expect(screen.queryByText('SAF-03')).not.toBeInTheDocument();
  });
});

describe('MLOps mathematics and isolation', () => {
  it('uses reproducible disjoint three-way data splits', () => {
    const data = createMLDataset('v1');
    expect(data).toEqual(createMLDataset('v1'));
    expect([data.train.length, data.validation.length, data.test.length]).toEqual([216, 72, 72]);
    expect(new Set([...data.train, ...data.validation, ...data.test].map(point => point.id)).size).toBe(360);
    expect(createMLDataset('v2').train).not.toEqual(data.train);
  });
  it('actually fits both algorithms and updates no held-out data', () => {
    const data = createMLDataset('v1', 0);
    const config = { algorithm: 'logistic' as const, rate: 0.5, epochs: 220, regularization: 0 };
    const model = fitML(data.train, config);
    expect(model.history.at(-1)!).toBeLessThan(model.history[0] / 2);
    expect(classificationMetrics(data.validation.map(point => predictML(model, point)), data.validation.map(point => point.label)).accuracy).toBeGreaterThan(0.9);
    const before = model.weights;
    data.validation.forEach(point => { point.label = point.label ? 0 : 1; });
    data.test.forEach(point => { point.label = point.label ? 0 : 1; });
    expect(fitML(data.train, config).weights).toEqual(before);
    const stump = fitML(data.train, { ...config, algorithm: 'stump' });
    expect(stump.history).toHaveLength(2);
    expect(stump.history[1]).toBeLessThan(stump.history[0]);
    expect(stump.stump.left).not.toBe(stump.stump.right);
  });
  it('matches known ROC, confusion and cost cases including single-class AUC', () => {
    const probabilities = [0.1, 0.4, 0.35, 0.8], labels = [0, 0, 1, 1];
    expect(rocCurve(probabilities, labels).auc).toBeCloseTo(0.75);
    expect(rocCurve([0.2, 0.9], [1, 1]).auc).toBeNull();
    expect(classificationMetrics(probabilities, labels)).toMatchObject({ tp: 1, tn: 2, fp: 0, fn: 1, count: 4 });
    const chosen = bestCostThreshold(probabilities, labels, 1, 10);
    expect(chosen.cost).toBe(1);
    expect(chosen.metrics.fn).toBe(0);
    expect(classificationMetrics([0, 1], [1, 0]).loss).toBeGreaterThan(20);
    expect(Number.isFinite(classificationMetrics([0, 1], [1, 0]).loss)).toBe(true);
  });
  it('fits a smoothed prior when a stump has no valid feature split', () => {
    const model = fitML([{ id: 'one', x: 0, y: 0, label: 1 }], { algorithm: 'stump', rate: 0.2, epochs: 40, regularization: 0 });
    expect(predictML(model, { x: 0, y: 0 })).toBeCloseTo(0.75);
    expect(model.history.at(-1)!).toBeLessThan(model.history[0]);
    expect(model.stump.left).toBe(model.stump.right);
  });
  it('computes drift from observed distributions rather than preset metrics', () => {
    const baseline = [-0.8, -0.3, 0, 0.4, 0.9];
    expect(populationStability(baseline, baseline)).toBe(0);
    expect(populationStability(baseline, baseline.map(value => value + 1))).toBeGreaterThan(0.2);
    expect(populationStability([], baseline)).toBe(0);
  });
  it('runs six configurations, gates test metrics, invalidates testing after threshold changes and registers', () => {
    render(<AdvancedIntelligenceDemo id="model-foundry" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sweep six configurations' }));
    expect(screen.getAllByRole('row')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluation / cost' }));
    expect(screen.getByText('Test metrics have not been computed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate isolated test split' }));
    expect(screen.getByRole('status')).toHaveTextContent('Isolated test · 72 samples');
    fireEvent.change(screen.getByRole('slider', { name: /Classification threshold/ }), { target: { value: '0.3' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Register current model card' }));
    expect(screen.getByText('MODEL-v1')).toBeInTheDocument();
    expect(screen.getByText('Validation only')).toBeInTheDocument();
  });
});

describe('adaptive learning prerequisites and resources', () => {
  it('updates mastery correctly and enumerates only feasible topological plans', () => {
    const initial = initialMastery();
    expect(masteryScore(updateMastery(initial, 'python', true), 'python')).toBeCloseTo(2 / 3);
    expect(masteryScore(updateMastery(initial, 'python', false), 'python')).toBeCloseTo(1 / 3);
    const plan = planLearning(LESSONS, ['basics'], 'capstone', 180, 0, initial);
    expect(plan.minutes).toBeLessThanOrEqual(180); expect(plan.mentorSlots).toBe(0); expect(plan.reachesGoal).toBe(false);
    const resolved = new Set(['basics']);
    for (const lesson of plan.lessons) { expect(lesson.after.every(id => resolved.has(id))).toBe(true); resolved.add(lesson.id); }
    expect(planLearning(LESSONS, ['basics'], 'capstone', 420, 2, initial).reachesGoal).toBe(true);
    expect(planLearning(LESSONS, ['basics'], 'capstone', 0, 0, initial).lessons).toEqual([]);
  });
  it('rejects unknown and cyclic prerequisites', () => {
    expect(() => planLearning(LESSONS, [], 'unknown', 100, 1, initialMastery())).toThrow('Unknown lesson');
    const cycle = [{ ...LESSONS[0], after: ['python'] }, { ...LESSONS[1], after: ['basics'] }];
    expect(() => planLearning(cycle, [], 'python', 100, 1, initialMastery())).toThrow('Cyclic');
  });
  it('blocks locked courses, submits only once per attempt and unlocks after actual answers', () => {
    render(<AdvancedIntelligenceDemo id="learning-campus" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Capstone project', exact: true }));
    expect(screen.getByText(/Complete first:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit answer' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Python and tables50/ }));
    fireEvent.click(screen.getByRole('button', { name: /Inspect causes and proportions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(screen.getByRole('button', { name: 'Submit answer' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Lesson complete');
    fireEvent.click(screen.getByRole('button', { name: 'Learning records' }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });
});

describe('contract versions, dates and evidence', () => {
  it('validates calendar dates and extracts precise evidence lines', () => {
    expect(validISODate('2026-02-30')).toBe(false);
    expect(validISODate('2028-02-29')).toBe(true);
    const current = CONTRACT_DOCUMENTS[1];
    const obligations = extractObligations(current);
    expect(obligations).toHaveLength(5);
    expect(obligations.find(item => item.id === 'D3')).toMatchObject({ line: 4, owner: '' });
    expect(contractFindings(current, '2026-10-01', new Set()).some(item => item.code === 'missing-owner')).toBe(true);
  });
  it('clears only deadline findings for current-version evidence and detects invalid amounts', () => {
    const document = { ...CONTRACT_DOCUMENTS[1], body: 'PAY|P1|2026-02-30||oops|CNY\nOBL|D1|2026-10-01|Owner|Delivery' };
    const initial = contractFindings(document, '2026-10-02', new Set());
    expect(initial.map(item => item.code)).toEqual(expect.arrayContaining(['invalid-date', 'missing-owner', 'invalid-amount', 'overdue']));
    const obligation = extractObligations(document)[1];
    expect(contractFindings(document, '2026-10-02', new Set([obligation.key])).some(item => item.code === 'overdue')).toBe(false);
    expect(contractFindings({ ...document, version: 3 }, '2026-10-02', new Set([obligation.key])).some(item => item.code === 'overdue')).toBe(true);
    expect(contractFindings(document, '2026-09-24', new Set()).some(item => item.code === 'due-soon')).toBe(true);
    expect(contractFindings(document, '2026-09-23', new Set()).some(item => item.code === 'due-soon')).toBe(false);
  });
  it('diffs line replacements without losing either version', () => {
    const before = 'A\nB\nC', after = 'A\nD\nC\nE'; const diff = lineDiff(before, after);
    expect(diff.filter(item => item.kind !== 'added').map(item => item.text).join('\n')).toBe(before);
    expect(diff.filter(item => item.kind !== 'removed').map(item => item.text).join('\n')).toBe(after);
    expect(lineDiff(before, before).every(item => item.kind === 'same')).toBe(true);
  });
  it('navigates exact evidence lines and saves review snapshots scoped to a revision', () => {
    render(<AdvancedIntelligenceDemo id="contract-desk" locale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Rule findings', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'CT-201@2:L4' }));
    expect(screen.getByText('OBL|D3|2026-10-23||Accessibility review / 无障碍复核').closest('div')).toHaveClass('adv-intel-highlight');
    fireEvent.click(screen.getByRole('button', { name: 'Review / export' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save revision review snapshot' }));
    expect(within(screen.getByRole('table')).getByText('CT-201@2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset system' }));
    expect(screen.queryByRole('button', { name: 'Save revision review snapshot' })).not.toBeInTheDocument();
  });
});

it('gives every flagship a topological industry workflow with specific outputs and invariants', () => {
  expect(INTELLIGENCE_CASES).toHaveLength(4);
  for (const item of INTELLIGENCE_CASES) {
    expect(item.capabilities.length).toBeGreaterThanOrEqual(6);
    expect(item.steps.length).toBe(12);
    const seen = new Set<string>();
    for (const step of item.steps) { expect(step.after.every(id => seen.has(id))).toBe(true); seen.add(step.id); expect(step.output.zh).not.toContain('产物与验证记录'); expect(step.acceptance[0].zh.length).toBeGreaterThan(15); }
    expect(item.steps.find(step => step.id === 'handoff')!.after).toContain('retest');
    expect(item.steps.filter(step => step.outputType === 'html')).toHaveLength(2);
  }
});
