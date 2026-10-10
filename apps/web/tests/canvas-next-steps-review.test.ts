import { describe, expect, it } from 'vitest';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createSessionNode, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import type { ContractField } from '../src/canvas/nodeContracts';
import { isNextStepsQuestion, isOutcomeQuestion, nextSteps, type NextStepsInput } from '../src/canvas/nextSteps';
import { reviewedProducers, reviewVerdict, reworkRequirements } from '../src/canvas/reviewVerdict';

// The report a real user's acceptance node delivered (2026-10-10): every node succeeded, the review did not pass.
const USER_REPORT = '结论：不通过。前端实现与后端接口契约存在重大不一致（路径、资源模型、响应字段均不匹配），若按当前实现联调将大面积 404。需修复后方可进入下一轮验收。\n'
  + '验收范围：\n- 18 个前端页面与后端 API 契约的接口一致性\n已验证事实：\n- 前端 18 个页面覆盖了 PRD 五大模块';
const ISSUES = '问题：线索列表调用 /leads，契约为 /api/v1/leads\n修复建议：按接口契约统一路径与响应字段';
const delivered = (text: string) => ({ text, at: 1, source: 'run' as const });
function review(report: string, patch: Partial<SessionNode> = {}): SessionNode {
  const node = { ...createAgentTemplate('review', { x: 0, y: 0 }), id: 'review', title: '小程序产品交付验收' } as SessionNode;
  return { ...node, lastOutput: delivered(JSON.stringify({ report, issues: ISSUES, verification: '检查项：18 个页面' })), ...patch };
}
const frontend = (): SessionNode => ({ ...createAgentTemplate('frontend', { x: 0, y: 0 }), id: 'frontend', title: '心理咨询小程序前端开发',
  lastOutput: delivered('{}') }) as SessionNode;
const backend = (): SessionNode => ({ ...createAgentTemplate('backend', { x: 0, y: 0 }), id: 'backend', title: '心理咨询小程序后端服务',
  lastOutput: delivered('{}') }) as SessionNode;
const wire = (from: string, fromField: string, to: string, toField: string): CanvasEdge =>
  ({ id: `${from}.${fromField}->${to}.${toField}`, fromNode: from, fromPort: `out:${fromField}`, toNode: to, toPort: `in:${toField}`, dataType: 'text' });

describe('a review node’s verdict', () => {
  it('reads the user’s rejected acceptance: the verdict, why, and the findings to hand over', () => {
    const verdict = reviewVerdict(review(USER_REPORT))!;
    expect(verdict).toMatchObject({ approved: false, verdict: '不通过',
      reason: '前端实现与后端接口契约存在重大不一致（路径、资源模型、响应字段均不匹配），若按当前实现联调将大面积 404。' });
    expect(verdict.findings).toContain('### 验收报告\n结论：不通过。');
    expect(verdict.findings).toContain(`### 问题与返工清单\n${ISSUES}`);
  });

  it.each([
    ['**验收结论**：需修复（3 项阻断）', false, '需修复', '（3 项阻断）'],
    ['## 结论\n不通过，登录接口返回 500。', false, '不通过', '登录接口返回 500。'],
    ['结论：存在 3 个阻断问题，因此不通过。', false, '不通过', '存在 3 个阻断问题'],
    ['结论：有条件通过：上线前需补齐隐私协议。', false, '有条件通过', '上线前需补齐隐私协议。'],
    ['结论：通过，未发现阻断问题。', true, '通过', '未发现阻断问题。'],
    ['Conclusion: Fail. The client calls /leads but the contract has /api/v1/leads.', false, 'Fail', 'The client calls /leads but the contract has /api/v1/leads.'],
    ['Conclusion: Pass — no failing checks.', true, 'Pass', 'no failing checks.'],
  ])('reads %j', (report, approved, verdict, reason) => {
    expect(reviewVerdict(review(report))).toMatchObject({ approved, verdict, reason });
  });

  it('says nothing for an output that is not a review, not complete, or not a verdict', () => {
    const plain = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'data', title: '数据分析', lastOutput: delivered('结论：样本不合格。') };
    expect(reviewVerdict(plain)).toBeNull();
    expect(reviewVerdict(review(USER_REPORT, { lastOutput: { ...delivered(JSON.stringify({ report: USER_REPORT })), partial: true } }))).toBeNull();
    expect(reviewVerdict(review('结论：见下方检查记录。'))).toBeNull();
    expect(reviewVerdict(review(USER_REPORT, { lastOutput: null }))).toBeNull();
  });

  it('takes a yes/no approval field as the verdict', () => {
    const field = (id: string, label: string, type: ContractField['type']): ContractField => ({ id, label, type, required: true, value: '' });
    const reviewer: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'partner', title: 'Reviewer',
      contract: { version: 1, inputs: [], outputs: [field('approved', '是否通过', 'boolean'), field('feedback', '评审意见', 'markdown')] },
      lastOutput: delivered(JSON.stringify({ approved: false, feedback: '缺少错误态处理' })) };
    expect(reviewVerdict(reviewer)).toEqual({ approved: false, verdict: '', reason: '', findings: '### 评审意见\n缺少错误态处理' });
  });

  it('names the Agent whose delivery it checked, before the others wired into it', () => {
    const agents = [backend(), frontend(), review(USER_REPORT)];
    const wired = [wire('backend', 'api', 'review', 'api'), wire('frontend', 'delivery', 'review', 'delivery')];
    expect(reviewedProducers(agents[2], agents, wired).map(node => node.id)).toEqual(['frontend']);
    expect(reviewedProducers(agents[2], agents, wired.slice(0, 1)).map(node => node.id)).toEqual(['backend']);
  });
});

describe('the rework requirement', () => {
  const marker = '【验收返工·小程序产品交付验收】';
  const header = '上次验收结论：不通过。请按下面的验收意见修改交付。';

  it('adds the findings as one requirement, replacing an earlier rework from the same review', () => {
    expect(reworkRequirements(undefined, marker, header, ISSUES)).toEqual({ version: 1, source: 'manual',
      constraints: [`${marker}${header}\n${ISSUES}`], acceptanceCriteria: [] });
    const earlier = { version: 1, source: 'manual', constraints: ['原始需求：心理咨询师小程序', `${marker}旧的意见`], acceptanceCriteria: ['可以登录'] };
    expect(reworkRequirements(earlier, marker, header, ISSUES)).toEqual({ ...earlier, constraints: ['原始需求：心理咨询师小程序', `${marker}${header}\n${ISSUES}`] });
  });

  it('shortens long findings to what one requirement holds, and declines when there is no room or the version is unknown', () => {
    const long = reworkRequirements(undefined, marker, header, '问题：'.repeat(3000))!;
    expect(Array.from(long.constraints[0]).length).toBeLessThanOrEqual(2000);
    expect(long.constraints[0].endsWith('…')).toBe(true);
    const full = { version: 1, source: 'manual', constraints: Array.from({ length: 6 }, () => '要'.repeat(1990)), acceptanceCriteria: [] };
    expect(reworkRequirements(full, marker, header, ISSUES)).toBeNull();
    expect(reworkRequirements({ version: 2, source: 'manual', constraints: [], acceptanceCriteria: [] }, marker, header, ISSUES)).toBeNull();
  });
});

describe('next steps after a review that did not pass', () => {
  const nodes = () => [backend(), frontend(), review(USER_REPORT)];
  const edges = [wire('backend', 'api', 'frontend', 'api'), wire('backend', 'api', 'review', 'api'), wire('frontend', 'delivery', 'review', 'delivery')];
  const input = (patch: Partial<NextStepsInput> = {}): NextStepsInput => ({ nodes: nodes(), edges, runs: {}, running: false, canRun: true,
    resultsAvailable: true, upgradeAvailable: true, reworkAvailable: true, isPremiumRefusal: () => false, ...patch });

  it('says what the review found and offers to rework the delivery it checked, then review it again', () => {
    expect(nextSteps(input())).toEqual({
      situation: { kind: 'rejected', nodeTitle: '小程序产品交付验收', verdict: '不通过',
        reason: '前端实现与后端接口契约存在重大不一致（路径、资源模型、响应字段均不匹配），若按当前实现联调将大面积 404。' },
      // The rework reruns the frontend and the review it feeds: two calls at the least.
      steps: [{ kind: 'rework', nodeId: 'frontend', reviewerId: 'review', calls: 2 }, { kind: 'open-review', nodeId: 'review' }] });
  });

  it('still points at the review where the rework cannot run, and lets a failure come first', () => {
    for (const patch of [{ canRun: false }, { reworkAvailable: false }]) {
      expect(nextSteps(input(patch))!.steps).toEqual([{ kind: 'open-review', nodeId: 'review' }]);
    }
    expect(nextSteps(input({ runs: { backend: { state: 'failed', detail: 'x' } } }))!.situation.kind).toBe('failed');
  });

  it('names the review that passed a finished canvas', () => {
    // Nothing left for the reader to fill in, so the canvas is simply finished.
    const ready = (node: SessionNode): SessionNode => ({ ...node, contract: { ...node.contract!, inputs: node.contract!.inputs.map(field => ({ ...field, required: false })) } });
    const passed = [backend(), frontend(), review('结论：通过。18 个页面与契约一致。')].map(ready);
    expect(nextSteps(input({ nodes: passed }))).toEqual({ situation: { kind: 'complete', approvedBy: '小程序产品交付验收' }, steps: [{ kind: 'results' }] });
  });
});

describe('questions about how the run came out', () => {
  it.each(['我看到运行后验收不通过，我该怎么办？', '验收没通过怎么办', '运行失败了，怎么处理？', '报错了咋办', '评审不通过要怎么改',
    'The review failed, what should I do?', 'it failed. how do I fix it?'])('takes %s as a question about the outcome', question => {
    expect(isOutcomeQuestion(question)).toBe(true);
  });

  it.each(['验收不通过的话把前端改成 React', '验收要做什么', '帮我把登录页的错误提示改成红色', '怎么办', '把验收标准改严格一点怎么样',
    'write a review of this product'])('leaves %s to the assistant', request => {
    expect(isOutcomeQuestion(request)).toBe(false);
  });

  it('keeps the general questions as they were', () => {
    expect(isNextStepsQuestion('我看到运行后验收不通过，我该怎么办？')).toBe(false);
    expect(isNextStepsQuestion('下一步该做什么')).toBe(true);
  });
});
